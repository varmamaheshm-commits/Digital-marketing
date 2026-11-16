import { useEffect, useState } from 'react';
import { desktopLink } from '../core/events';
import { copyText } from '../core/files';
import { newPairingCode } from '../core/link';
import { log, saveSettings, useStore } from '../core/store';
import type { Settings } from '../core/types';
import { Field, Icon, toast } from './common';

/** Shared with App.tsx, which starts the link; this page only shows where it is reachable. */
export interface LinkState { running: boolean; port: number; addresses: string[]; error: string }

export function LinkPage({ state }: { state: LinkState }) {
  const { settings: s } = useStore();
  const bridge = desktopLink();
  const [hook, setHook] = useState(s.link.webhookUrl);
  const [testing, setTesting] = useState(false);
  useEffect(() => setHook(s.link.webhookUrl), [s.link.webhookUrl]);
  const save = (patch: Partial<Settings['link']>) => saveSettings({ ...s, link: { ...s.link, ...patch } });

  async function toggle(on: boolean) {
    await save({ enabled: on, code: s.link.code || newPairingCode() });
    await log('security', on ? 'Phone link switched on.' : 'Phone link switched off.');
  }
  async function newCode() {
    if (!confirm('Create a new pairing code? Every phone and automation using the old code stops working until you enter the new one.')) return;
    await save({ code: newPairingCode() });
    await log('security', 'Phone link pairing code replaced.');
  }
  async function testHook() {
    if (!bridge) return;
    setTesting(true);
    const res = await bridge.notify(hook.trim(), s.link.code, 'test', { message: 'Hello from Marketing Studio' }).catch(() => ({ ok: false, error: 'Could not send.' }));
    setTesting(false);
    toast(res.ok ? 'Test event delivered' : res.error ?? 'Could not send');
  }

  const address = (ip: string) => `http://${ip}:${state.port}`;
  const local = `http://127.0.0.1:${state.port}`;
  return (
    <>
      <div className="head"><div className="grow"><h1>Phone & automation</h1><p>Approve videos from your phone, and connect automation tools such as n8n. Your PC does the posting.</p></div></div>
      {!bridge && <div className="notice warn" style={{ marginBottom: 14 }}>The phone link is provided by the desktop app on your always-on PC. Open this page there to switch it on.</div>}
      <div className="grid g2">
        <div className="card stack">
          <h2>Phone link</h2>
          <label className="check"><input data-testid="link-enable" type="checkbox" disabled={!bridge} checked={s.link.enabled} onChange={(e) => toggle(e.target.checked)} /> Let my phone and tablet approve videos on this PC</label>
          {s.link.enabled && state.error && <div className="notice bad" role="alert">{state.error}</div>}
          {s.link.enabled && state.running && (
            <>
              <div className="notice ok" data-testid="link-running">The link is running. Keep Marketing Studio open on this PC.</div>
              <b style={{ fontSize: '.86rem' }}>1. On your phone, connected to the same Wi-Fi, open this address in the browser</b>
              {state.addresses.length === 0 && <div className="notice warn">This PC is not connected to a local network right now.</div>}
              {state.addresses.map((ip) => (
                <div className="row" key={ip}>
                  <code data-testid="link-address" style={{ flex: 1, userSelect: 'all', background: 'var(--brand-soft)', padding: '8px 10px', borderRadius: 8 }}>{address(ip)}</code>
                  <button className="btn small" onClick={async () => { await copyText(address(ip)); toast('Address copied'); }}><Icon name="copy" size={15} /> Copy</button>
                </div>
              ))}
              <b style={{ fontSize: '.86rem' }}>2. Enter this pairing code there (once per phone)</b>
              <div className="recovery" data-testid="link-code">{s.link.code}</div>
              <small className="muted">Tip: on the phone, use the browser menu → “Add to Home screen” to keep it like an app.</small>
              <div><button className="btn small" onClick={newCode}><Icon name="refresh" size={15} /> New pairing code</button></div>
            </>
          )}
          <div className="notice">
            The link works only for devices on the same local network, and only with the pairing code. It can show videos waiting for approval, approve or reject them, and add a lead. It cannot read your leads or change settings.
            Use it on a Wi-Fi you trust: the connection inside your network is not encrypted.
          </div>
        </div>

        <div className="card stack">
          <h2>Automation (n8n and similar tools)</h2>
          <p className="muted" style={{ margin: 0 }}>Two directions: your tool can add leads to Marketing Studio, and Marketing Studio can tell your tool when something happens.</p>
          <h3>Events sent to your tool</h3>
          <Field label="Webhook address" hint="In n8n: add a Webhook node (method POST) and paste its Production URL here. Leave empty to send nothing.">
            <input data-testid="link-webhook" value={hook} onChange={(e) => setHook(e.target.value)} onBlur={() => hook !== s.link.webhookUrl && save({ webhookUrl: hook.trim() })} placeholder="http://localhost:5678/webhook/marketing-studio" inputMode="url" spellCheck={false} autoComplete="off" />
          </Field>
          <div className="row">
            <button className="btn small" disabled={!bridge || !hook.trim() || testing || !s.link.code} onClick={testHook}>{testing ? 'Sending…' : 'Send a test event'}</button>
          </div>
          <small className="muted">Events: video.ready, video.approved, video.rejected, video.posted, video.post_failed, lead.created. They carry product names, platforms and links, never a lead’s name, phone or email. Each is signed with your pairing code (header X-Marketing-Studio-Signature).</small>
          <h3>Requests your tool can make</h3>
          <div className="pre" style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '.8rem', background: 'var(--brand-soft)', padding: 10, borderRadius: 8 }}>
{`Header on every request:
  Authorization: Bearer <pairing code>

POST ${local}/api/leads
  { "name": "...", "phone": "...", "email": "...",
    "source": "website form", "product": "...",
    "notes": "...", "consent": true }

GET  ${local}/api/status
GET  ${local}/api/approvals
POST ${local}/api/videos/<id>/approve
POST ${local}/api/videos/<id>/reject`}
          </div>
          <small className="muted">Ready-made n8n workflows are in the <code>n8n/</code> folder of the project (import them in n8n, then enter your pairing code). If n8n runs on another computer in your network, use this PC’s address from the left instead of 127.0.0.1.</small>
        </div>
      </div>
    </>
  );
}
