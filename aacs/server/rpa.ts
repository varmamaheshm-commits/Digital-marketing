// RPA runner: executes a bot's visual flow. Web steps drive a headless Chromium through Playwright
// when it is installed; API, email, condition, loop and variable steps need nothing extra.
import { createRequire } from 'node:module';
import { notify, type Resource } from './db.ts';
import { compare, tpl } from './engine.ts';
import { assertPublicUrl, safeFetch } from './sec.ts';
import { withSecrets } from './agent.ts';

export interface BotStep { id: string; type: string; name?: string; config: Record<string, any> }
export interface BotResult { vars: Record<string, any>; log: { type: string; name: string; status: string; detail: string; ms: number }[]; screenshot?: string; error?: string }
const WEB = new Set(['goto', 'click', 'type', 'read', 'wait', 'screenshot', 'press']);

export function playwrightAvailable(): boolean {
  try { createRequire(import.meta.url).resolve('playwright'); return true; } catch { return false; }
}

/** Expand "loop" steps (repeat the next `span` steps `times` times) into a flat plan. */
function expand(steps: BotStep[]): BotStep[] {
  const out: BotStep[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.type !== 'loop') { out.push(s); continue; }
    const span = Math.max(1, Math.min(+s.config.span || 1, steps.length - i - 1));
    const body = steps.slice(i + 1, i + 1 + span);
    for (let n = 1; n <= Math.max(1, Math.min(+s.config.times || 1, 50)); n++) {
      out.push({ id: `${s.id}_${n}`, type: 'set', name: `Loop pass ${n}`, config: { name: 'index', value: n } });
      out.push(...expand(body));
    }
    i += span;
  }
  if (out.length > 500) throw new Error('Bot expands to more than 500 steps');
  return out;
}

export async function runBot(orgId: string, bot: Resource, input: any = {}): Promise<BotResult> {
  const result: BotResult = { vars: { ...(input && typeof input === 'object' ? input : {}) }, log: [] };
  let browser: any, page: any;
  const deadline = Date.now() + 120000;
  try {
    const plan = expand((bot.data.steps ?? []) as BotStep[]);
    if (plan.some((s) => WEB.has(s.type))) {
      if (!playwrightAvailable()) throw new Error('Web steps need Playwright on the server (npm install playwright && npx playwright install chromium)');
      const { chromium } = createRequire(import.meta.url)('playwright');
      browser = await chromium.launch(process.env.AACS_CHROMIUM ? { executablePath: process.env.AACS_CHROMIUM } : {});
      page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
      page.setDefaultTimeout(15000);
      const verdicts = new Map<string, boolean>();
      await page.route('**/*', async (route: any) => { // every request the page makes passes the outbound guard
        const url: string = route.request().url();
        if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')) return route.continue();
        let host = '';
        try { host = new URL(url).host; } catch { return route.abort(); }
        if (!verdicts.has(host)) verdicts.set(host, await assertPublicUrl(url).then(() => true, () => false));
        return verdicts.get(host) ? route.continue() : route.abort();
      });
    }
    for (let i = 0; i < plan.length; i++) {
      if (Date.now() > deadline) throw new Error('Bot exceeded the 2 minute limit');
      const s = plan[i];
      const c = tpl(s.config ?? {}, { vars: result.vars, trigger: input, steps: {} });
      const t = Date.now();
      let detail = '';
      try {
        switch (s.type) {
          case 'goto': await assertPublicUrl(String(c.url)); await page.goto(String(c.url), { waitUntil: 'domcontentloaded' }); detail = `Opened ${c.url}`; break;
          case 'click': await page.click(String(c.selector)); detail = `Clicked ${c.selector}`; break;
          case 'type': await page.fill(String(c.selector), withSecrets(orgId, String(c.text ?? ''))); detail = `Typed into ${c.selector}`; break;
          case 'press': await page.keyboard.press(String(c.key || 'Enter')); detail = `Pressed ${c.key || 'Enter'}`; break;
          case 'read': {
            const loc = page.locator(String(c.selector)).first();
            const v = c.attribute ? await loc.getAttribute(String(c.attribute)) : await loc.innerText();
            result.vars[String(c.var || 'value')] = (v ?? '').trim().slice(0, 5000);
            detail = `${c.var || 'value'} = ${String(v ?? '').trim().slice(0, 200)}`;
            break;
          }
          case 'wait': if (c.selector) await page.waitForSelector(String(c.selector)); else await new Promise((r) => setTimeout(r, Math.min(+c.ms || 1000, 15000))); detail = c.selector ? `Saw ${c.selector}` : `Waited ${Math.min(+c.ms || 1000, 15000)} ms`; break;
          case 'screenshot': result.screenshot = 'data:image/jpeg;base64,' + (await page.screenshot({ type: 'jpeg', quality: 45 })).toString('base64'); detail = 'Captured the page'; break;
          case 'api': {
            const method = String(c.method || 'GET').toUpperCase();
            const res = await safeFetch(String(c.url), { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' || c.body == null || c.body === '' ? undefined : typeof c.body === 'string' ? c.body : JSON.stringify(c.body) });
            const text = (await res.text()).slice(0, 5000);
            result.vars[String(c.var || 'response')] = text;
            detail = `${method} ${c.url} -> HTTP ${res.status}`;
            break;
          }
          case 'email': notify(orgId, 'email', String(c.to ?? ''), String(c.subject ?? ''), String(c.body ?? '')); detail = `Email to ${c.to} queued`; break;
          case 'set': result.vars[String(c.name)] = c.value; detail = `${c.name} = ${JSON.stringify(c.value)}`; break;
          case 'condition': {
            const ok = compare(c.left, c.op, c.right);
            detail = `Condition ${ok ? 'true' : 'false'}`;
            if (!ok) { if (c.onFalse === 'stop') { result.log.push({ type: s.type, name: s.name || s.type, status: 'done', detail: detail + ' - stopped', ms: Date.now() - t }); return result; } i += Math.max(1, +c.skip || 1); }
            break;
          }
          default: throw new Error(`Unknown step type "${s.type}"`);
        }
        result.log.push({ type: s.type, name: s.name || s.type, status: 'done', detail, ms: Date.now() - t });
      } catch (e: any) {
        result.log.push({ type: s.type, name: s.name || s.type, status: 'failed', detail: String(e?.message ?? e).split('\n')[0].slice(0, 500), ms: Date.now() - t });
        throw e;
      }
    }
  } catch (e: any) {
    result.error = String(e?.message ?? e).split('\n')[0].slice(0, 500);
  } finally {
    await browser?.close().catch(() => {});
  }
  return result;
}
