# AI Agent Creator Suite (AACS)

A multi-tenant platform for building business apps, AI agents, multi-agent crews, workflows
and RPA bots without code, then testing, releasing, monitoring and securing them.

It runs as one Node.js process with an embedded SQLite database, so it starts with no other
infrastructure. With no model provider connected it uses a built-in offline simulator, so every
screen can be tried immediately.

## Run it

Needs Node.js 22.18 or newer.

```bash
cd aacs
npm install
npm run build      # type-checks and builds the web portal into dist/
npm start          # http://127.0.0.1:8787
```

Open the address, choose "Create an organisation", and install a template from the Marketplace.

| Command | What it does |
| --- | --- |
| `npm run dev` | API on 8787 with reload, portal on 5173 with hot reload |
| `npm test` | 15 API tests against a real server and a throwaway database |
| `npm run test:e2e` | Drives the portal in a headless browser (needs Playwright + Chromium) |

### Configuration (environment variables)

| Variable | Purpose |
| --- | --- |
| `PORT`, `HOST` | Listen address (default `127.0.0.1:8787`) |
| `AACS_DATA_DIR` | Where the database and key file live (default `./data`) |
| `AACS_MASTER_KEY` | 64 hex characters. The AES-256 key for the secrets vault. Set it from your key vault in production; otherwise a key file is created in the data directory |
| `AACS_SECURE_COOKIE=1` | Mark the session cookie `Secure` when not behind a proxy that sets `X-Forwarded-Proto` |
| `AACS_ALLOW_PRIVATE_HTTP=1` | Let workflows, bots, tests and connectors call private/loopback addresses (off by default) |
| `AACS_CHROMIUM` | Path to a Chromium binary for RPA bots, if Playwright's own is not used |

Run it behind an HTTPS reverse proxy; TLS is terminated there.

## What is in the portal

| Area | Screen | What works |
| --- | --- | --- |
| Build | **Apps** | Drag-and-drop page builder on a 12-column grid: textbox, number, dropdown, checkbox, date picker, rich text, button, heading, text, grid, chart, metric, calendar. Multiple pages, phone preview, live preview, a runnable app at `#/run/<id>` |
| | **Data tables** | Tables, typed columns, required/unique rules, relationships, real database indexes, record editor |
| | **Workflows** | Visual flow designer. Triggers: manual, schedule, record added, webhook. Steps: AI agent, RPA bot, add/update record, API call, document, email, SMS, in-app notification, condition, human approval, variable |
| | **RPA bots** | Visual bot designer: open page, click, type, press, read, wait, screenshot, loop, condition, API, email. Runs in headless Chromium on the server |
| AI | **Agents** | Six-step wizard (identity, brain, knowledge, tools, memory, output) and a playground showing model, tools, tokens, cost and guardrail actions |
| | **Agent crews** | Sequential multi-agent runs with hand-offs, reviewer escalation and human approval |
| | **Knowledge** | RAG: upload/paste/fetch, chunking, local embeddings, vector + keyword ranking, retrieval tester |
| | **Prompts** | Versioned prompt library with a try-it panel |
| | **Models** | Claude, OpenAI, Azure OpenAI, Gemini, Mistral, DeepSeek, Llama (Ollama) or any compatible endpoint; routing by priority or cost, fallback chains, benchmark |
| Quality | **Testing** | Agent evaluations (accuracy, grounding, tool use, injection, leakage, PII, toxicity, bias pairs, latency, cost), API tests, UI tests through bots, bounded load tests; quality/performance/security/compliance scorecard and run-over-run history |
| Operate | **Releases** | DEV, TEST, UAT, PROD with a pipeline: commit, build, scan, promotion gate, validate, release. Production waits for approval |
| | **Approvals**, **Monitoring**, **Cost and usage**, **Notifications** | Human-in-the-loop inbox, run traces, spend and tokens by model and source with a monthly budget, outbox and generated documents |
| Platform | **Marketplace** | Built-in templates plus anything your organisation shares |
| | **Connectors** | REST connectors (SAP, Salesforce, Microsoft Graph, Oracle, Workday templates) usable as agent tools |
| | **Security** | Control overview, prompt firewall and DLP policy, compliance readiness, secrets vault, audit log, backup and restore |
| | **Administration** | Users, five roles, organisation and data-residency region, projects, MFA, password |

## Security model

- **Tenancy**: every row carries an organisation id and every query filters on it.
- **Identity**: scrypt password hashes, TOTP MFA, HttpOnly SameSite=Strict session cookies, login throttling. Cross-site requests are refused (JSON content type required).
- **RBAC**: admin, developer, business user, tester, agent owner, enforced on the server for every call.
- **Secrets**: AES-256-GCM vault. Values are write-only; they are referenced as `{{secrets.NAME}}` and resolved on the server at the moment of use.
- **AI guardrails**: prompt firewall on user input and on data returned by tools and knowledge search; PII masking of model input, output and (optionally) ingested documents; output moderation. Detection is pattern based.
- **Outbound requests** from workflows, bots, tests and connectors are limited to public http(s) hosts.
- **Audit log** of sign-ins, changes, runs, releases, approvals and exports. **Retention** purges old history.

## Layout

```
server/   index.ts (HTTP + static)  api.ts (routes, RBAC)  db.ts (schema)  sec.ts (crypto, MFA, guardrails)
          agent.ts (agent runtime, tools)  llm/ (Claude SDK adapter, compatible-API adapter, router)
          rag.ts  engine.ts (workflows, crews, triggers, release pipeline)  rpa.ts  testing.ts  market.ts
web/src/  App.tsx (shell)  ui.tsx (forms, charts, flow designer, versioning)  pages/
tests/    platform.test.ts (API)  e2e.cjs (browser)
```

## Not included in this version

These items from the platform plan need external services or infrastructure and are not built yet:

- **SSO** (Azure AD / SAML / OpenID). Sign-in is email + password + TOTP.
- **Email and SMS delivery**. Messages are queued in the outbox; no gateway is connected.
- **PDF, Word, Excel, image/OCR and SharePoint ingestion**. Knowledge accepts text formats and web pages.
- **RPA recorder and desktop automation**. Bots are designed step by step and drive web pages only.
- **Native email, file-upload, Teams and WhatsApp triggers**. These reach a workflow through its webhook.
- **External vector databases and embedding models**. Embeddings are computed locally.
- **Kubernetes/AKS manifests, OpenTelemetry export, voice agents, digital signatures, UI translation.**
- The compliance screen reports technical controls; it is not a certification.

The storage layer is a single SQLite file. For a large SaaS deployment, plan a move to PostgreSQL and a job queue for long runs.
