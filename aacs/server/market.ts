// Marketplace: prebuilt agents, workflows, bots, prompts, connectors and apps.
// A template is a list of resources; "$ref:key" values are replaced by the id of the resource created under that key.
import { createResource } from './db.ts';
import { syncIndexes } from './data.ts';

interface Item { key: string; kind: string; name: string; data: any }
export interface Template { id: string; category: string; name: string; description: string; items: Item[] }

const invoiceTable: Item = { key: 'invoices', kind: 'table', name: 'Invoices', data: { columns: [
  { name: 'invoice_no', label: 'Invoice number', type: 'text', required: true, unique: true },
  { name: 'vendor', label: 'Vendor', type: 'text', required: true, indexed: true },
  { name: 'amount', label: 'Amount', type: 'number', required: true },
  { name: 'due_date', label: 'Due date', type: 'date' },
  { name: 'status', label: 'Status', type: 'choice', options: ['Received', 'Validated', 'Approved', 'Rejected', 'Paid'] },
  { name: 'notes', label: 'Notes', type: 'longtext' },
] } };
const invoiceAgent: Item = { key: 'invoiceAgent', kind: 'agent', name: 'Invoice Agent', data: {
  role: 'Invoice Validation Expert', goal: 'Validate invoices and prepare them for approval.',
  instructions: 'Check that every invoice has a number, a vendor, an amount and a due date. Flag amounts above 100000 for manual approval. Look up existing invoices before accepting a new one so duplicates are caught. Summarise your decision in two sentences.',
  modelId: 'auto', kbIds: [], tools: ['table_query', 'table_insert', 'send_email'], tableIds: ['$ref:invoices'], memory: { shortTerm: 6, conversation: true, longTerm: false }, outputFormat: 'text',
} };
const connector = (id: string, name: string, baseUrl: string, description: string, secret: string): Template => ({
  id, category: 'connector', name, description,
  items: [{ key: 'c', kind: 'connector', name, data: { baseUrl, description, methods: ['GET'], headers: [{ name: 'Authorization', value: `Bearer {{secrets.${secret}}}` }] } }],
});
const prompt = (id: string, name: string, description: string, text: string): Template => ({ id, category: 'prompt', name, description, items: [{ key: 'p', kind: 'prompt', name, data: { text, description } }] });

export const TEMPLATES: Template[] = [
  { id: 'agent-invoice', category: 'agent', name: 'Invoice Agent', description: 'Validates invoices against the Invoices table and flags large amounts for approval.', items: [invoiceTable, invoiceAgent] },
  { id: 'agent-support', category: 'agent', name: 'Customer Support Agent', description: 'Answers customer questions strictly from your knowledge base.', items: [
    { key: 'kb', kind: 'kb', name: 'Support knowledge', data: { description: 'Product FAQs, policies and how-to articles', chunkSize: 900, overlap: 150 } },
    { key: 'a', kind: 'agent', name: 'Customer Support Agent', data: { role: 'Customer Support Specialist', goal: 'Resolve customer questions accurately and politely.', instructions: 'Always search the knowledge base first. If the answer is not there, say so and offer to escalate to a human. Never guess prices or policies.', modelId: 'auto', kbIds: ['$ref:kb'], tools: ['knowledge_search', 'remember'], tableIds: [], memory: { shortTerm: 8, conversation: true, longTerm: true }, outputFormat: 'text' } },
  ] },
  { id: 'agent-hr', category: 'agent', name: 'HR Policy Assistant', description: 'Explains leave, travel and expense policies from uploaded documents.', items: [
    { key: 'kb', kind: 'kb', name: 'HR policies', data: { description: 'Employee handbook and policies', chunkSize: 900, overlap: 150 } },
    { key: 'a', kind: 'agent', name: 'HR Policy Assistant', data: { role: 'HR Policy Advisor', goal: 'Help employees understand company policies.', instructions: 'Quote the policy passage you relied on. Do not give legal advice. Refer personal cases to the HR team.', modelId: 'auto', kbIds: ['$ref:kb'], tools: ['knowledge_search'], tableIds: [], memory: { shortTerm: 6, conversation: true, longTerm: false }, outputFormat: 'markdown' } },
  ] },
  { id: 'crew-delivery', category: 'agent', name: 'Delivery crew: Planner, Developer, Tester, Approver', description: 'Four agents hand work to each other; the tester can send work back, and a person approves the result.', items: [
    { key: 'planner', kind: 'agent', name: 'Planner Agent', data: { role: 'Planner', goal: 'Break a goal into a short, ordered plan.', instructions: 'Produce at most six numbered steps with a clear owner for each.', modelId: 'auto', tools: [], kbIds: [], tableIds: [], memory: { conversation: false }, outputFormat: 'text' } },
    { key: 'dev', kind: 'agent', name: 'Developer Agent', data: { role: 'Developer', goal: 'Carry out the plan and produce the deliverable.', instructions: 'Follow the plan step by step. State any assumption you make.', modelId: 'auto', tools: [], kbIds: [], tableIds: [], memory: { conversation: false }, outputFormat: 'text' } },
    { key: 'tester', kind: 'agent', name: 'Tester Agent', data: { role: 'Tester', goal: 'Review the deliverable against the goal.', instructions: 'List defects. If the work must be redone, start your answer with the word REJECTED and explain why. Otherwise start with APPROVED.', modelId: 'auto', tools: [], kbIds: [], tableIds: [], memory: { conversation: false }, outputFormat: 'text' } },
    { key: 'crew', kind: 'crew', name: 'Delivery crew', data: { humanApproval: true, members: [
      { agentId: '$ref:planner', title: 'Planner', task: 'Plan the work.' },
      { agentId: '$ref:dev', title: 'Developer', task: 'Produce the deliverable from the plan.' },
      { agentId: '$ref:tester', title: 'Tester', task: 'Review the deliverable.', reviewer: true },
    ] } },
  ] },
  { id: 'wf-invoice', category: 'workflow', name: 'Invoice intake and approval', description: 'New invoice arrives by webhook, the agent validates it, large amounts wait for approval, the record is stored and finance is notified.', items: [
    invoiceTable, invoiceAgent,
    { key: 'wf', kind: 'workflow', name: 'Invoice intake and approval', data: { enabled: false, trigger: { type: 'manual' }, steps: [
      { id: 'validate', type: 'agent', name: 'Validate invoice', config: { agentId: '$ref:invoiceAgent', input: 'Validate this invoice: number {{trigger.invoice_no}}, vendor {{trigger.vendor}}, amount {{trigger.amount}}, due {{trigger.due_date}}.' } },
      { id: 'small', type: 'condition', name: 'Amount above 100000?', config: { left: '{{trigger.amount}}', op: 'greater', right: '100000', onFalse: 'skip', skip: 1 } },
      { id: 'approve', type: 'approval', name: 'Manager approval', config: { title: 'Approve invoice {{trigger.invoice_no}} for {{trigger.amount}}', detail: '{{steps.validate.output}}' } },
      { id: 'store', type: 'db_insert', name: 'Store invoice', config: { tableId: '$ref:invoices', values: { invoice_no: '{{trigger.invoice_no}}', vendor: '{{trigger.vendor}}', amount: '{{trigger.amount}}', due_date: '{{trigger.due_date}}', status: 'Validated', notes: '{{steps.validate.output}}' } } },
      { id: 'mail', type: 'email', name: 'Notify finance', config: { to: 'finance@example.com', subject: 'Invoice {{trigger.invoice_no}} validated', body: 'Vendor: {{trigger.vendor}}\nAmount: {{trigger.amount}}\n\n{{steps.validate.output}}' } },
    ] } },
  ] },
  { id: 'wf-digest', category: 'workflow', name: 'Scheduled record digest', description: 'Every day, generates a document and posts an in-app notification. A starting point for scheduled reports.', items: [
    { key: 'wf', kind: 'workflow', name: 'Daily digest', data: { enabled: false, trigger: { type: 'schedule', everyMinutes: 1440 }, steps: [
      { id: 'doc', type: 'document', name: 'Generate digest', config: { title: 'Daily digest', template: 'Digest generated at {{trigger.scheduledAt}}.' } },
      { id: 'note', type: 'notify', name: 'Tell the team', config: { subject: 'Daily digest is ready', body: 'Open Notifications to read it.' } },
    ] } },
  ] },
  { id: 'bot-web-read', category: 'bot', name: 'Read a value from a web page', description: 'Opens a page, reads its heading into a variable and takes a screenshot. Replace the URL and selector with your own.', items: [
    { key: 'b', kind: 'bot', name: 'Read page heading', data: { steps: [
      { id: 's1', type: 'goto', name: 'Open page', config: { url: 'https://example.com' } },
      { id: 's2', type: 'read', name: 'Read heading', config: { selector: 'h1', var: 'heading' } },
      { id: 's3', type: 'screenshot', name: 'Capture', config: {} },
    ] } },
  ] },
  { id: 'app-invoices', category: 'app', name: 'Invoice tracker app', description: 'Entry form, invoice grid and a dashboard with totals by status and vendor.', items: [
    invoiceTable,
    { key: 'app', kind: 'app', name: 'Invoice tracker', data: { pages: [
      { id: 'p1', name: 'New invoice', components: [
        { id: 'c1', type: 'heading', label: 'Register an invoice', width: 12 },
        { id: 'c2', type: 'textbox', label: 'Invoice number', field: 'invoice_no', width: 6 },
        { id: 'c3', type: 'textbox', label: 'Vendor', field: 'vendor', width: 6 },
        { id: 'c4', type: 'number', label: 'Amount', field: 'amount', width: 4 },
        { id: 'c5', type: 'date', label: 'Due date', field: 'due_date', width: 4 },
        { id: 'c6', type: 'dropdown', label: 'Status', field: 'status', options: ['Received', 'Validated', 'Approved', 'Rejected', 'Paid'], width: 4 },
        { id: 'c7', type: 'richtext', label: 'Notes', field: 'notes', width: 12 },
        { id: 'c8', type: 'button', label: 'Save invoice', action: 'submit', tableId: '$ref:invoices', width: 12 },
        { id: 'c9', type: 'grid', label: 'Recent invoices', tableId: '$ref:invoices', width: 12 },
      ] },
      { id: 'p2', name: 'Dashboard', components: [
        { id: 'd1', type: 'metric', label: 'Invoices', tableId: '$ref:invoices', agg: 'count', width: 4 },
        { id: 'd2', type: 'metric', label: 'Total amount', tableId: '$ref:invoices', agg: 'sum', valueField: 'amount', width: 4 },
        { id: 'd3', type: 'metric', label: 'Average amount', tableId: '$ref:invoices', agg: 'avg', valueField: 'amount', width: 4 },
        { id: 'd4', type: 'chart', label: 'Amount by status', tableId: '$ref:invoices', chart: 'bar', groupField: 'status', agg: 'sum', valueField: 'amount', width: 6 },
        { id: 'd5', type: 'chart', label: 'Invoices by vendor', tableId: '$ref:invoices', chart: 'bar', groupField: 'vendor', agg: 'count', width: 6 },
        { id: 'd6', type: 'calendar', label: 'Due dates', tableId: '$ref:invoices', dateField: 'due_date', titleField: 'vendor', width: 12 },
      ] },
    ] } },
  ] },
  prompt('prompt-summary', 'Executive summary', 'Summarise any text for a busy reader.', 'Summarise the text for an executive in at most five bullet points. Lead with the decision or outcome, then the supporting facts. Keep numbers exact.'),
  prompt('prompt-extract', 'Entity extraction', 'Pull names, dates and amounts into JSON.', 'Extract every person, organisation, date and monetary amount from the text. Return JSON with the keys people, organisations, dates, amounts. Use empty arrays when nothing is found.'),
  prompt('prompt-tone', 'Professional rewrite', 'Rewrite a message in a clear, courteous tone.', 'Rewrite the message so it is clear, courteous and direct. Keep every fact and commitment. Do not add new information.'),
  connector('conn-sap', 'SAP S/4HANA OData', 'https://YOUR-TENANT.s4hana.cloud.sap/sap/opu/odata/sap', 'SAP business objects through OData.', 'SAP_TOKEN'),
  connector('conn-salesforce', 'Salesforce REST', 'https://YOUR-DOMAIN.my.salesforce.com/services/data/v60.0', 'Salesforce objects and SOQL queries.', 'SALESFORCE_TOKEN'),
  connector('conn-graph', 'Microsoft Graph', 'https://graph.microsoft.com/v1.0', 'Microsoft 365 mail, calendar, Teams and SharePoint.', 'MS_GRAPH_TOKEN'),
  connector('conn-oracle', 'Oracle Fusion REST', 'https://YOUR-POD.oraclecloud.com/fscmRestApi/resources/latest', 'Oracle Fusion ERP resources.', 'ORACLE_TOKEN'),
  connector('conn-workday', 'Workday REST', 'https://YOUR-HOST.workday.com/ccx/api/v1/YOUR-TENANT', 'Workday workers and organisations.', 'WORKDAY_TOKEN'),
];

export function installItems(orgId: string, userId: string, projectId: string | null, items: Item[]) {
  const refs: Record<string, string> = {};
  const resolve = (v: any): any => typeof v === 'string' && v.startsWith('$ref:') ? refs[v.slice(5)] ?? '' : Array.isArray(v) ? v.map(resolve) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)])) : v;
  const created = [];
  for (const it of items) {
    const r = createResource(orgId, userId, it.kind, it.name, resolve(it.data), projectId);
    if (it.kind === 'table') syncIndexes(r);
    refs[it.key] = r.id;
    created.push({ id: r.id, kind: r.kind, name: r.name });
  }
  return created;
}
