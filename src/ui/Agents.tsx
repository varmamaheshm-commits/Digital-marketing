import { useEffect, useState } from 'react';
import { aiJson, aiModels } from '../core/ai';
import { saveSettings, useStore } from '../core/store';
import type { Settings } from '../core/types';
import { Field, fmtDateTime, Icon, toast } from './common';

type Desktop = { getBackground: () => Promise<{ enabled: boolean; tray: boolean } | null>; setBackground: (on: boolean) => Promise<{ enabled: boolean; tray: boolean } | null> };
const desktop = (): Desktop | undefined => (window as any).desktop;

const AGENTS: { key: keyof Settings['ai']['agents'] | null; name: string; job: string }[] = [
  { key: null, name: 'Planner', job: 'Checks every 10 minutes what is missing — videos, posts, follow-ups — and starts the work.' },
  { key: null, name: 'Video maker', job: 'Renders each video on this device and places it in Approvals.' },
  { key: 'scripts', name: 'Script writer', job: 'Writes the on-screen lines of each video in the chosen language, using your product details and knowledge base.' },
  { key: 'posts', name: 'Post writer', job: 'Writes posts, emails, WhatsApp broadcasts and ad copy.' },
  { key: 'leads', name: 'Lead assistant', job: 'Writes the welcome, follow-up and offer messages for each lead.' },
  { key: 'answers', name: 'Knowledge assistant', job: 'Answers customer questions strictly from your own documents.' },
];

export function Agents() {
  const { settings: s, data } = useStore();
  const [models, setModels] = useState<string[] | null | undefined>(undefined);
  const [bg, setBg] = useState<{ enabled: boolean; tray: boolean } | null>(null);
  const [testing, setTesting] = useState(false);
  const ai = (patch: Partial<Settings['ai']>) => saveSettings({ ...s, ai: { ...s.ai, ...patch } });
  const check = () => { setModels(undefined); void aiModels().then(setModels); };
  useEffect(() => { check(); void desktop()?.getBackground().then(setBg); }, []);
  const model = models?.length ? (models.includes(s.ai.model) ? s.ai.model : models[0]) : '';
  const live = s.ai.enabled && !!model;

  async function test() {
    setTesting(true);
    try {
      const j = await aiJson(model, 'Reply with one JSON object and nothing else.', 'Return JSON: {"line": a five-word greeting for a shop customer}');
      toast('AI engine replied: ' + String(j.line ?? JSON.stringify(j)).slice(0, 80));
    } catch (e: any) { toast(String(e?.message ?? e)); }
    setTesting(false);
  }
  async function background(on: boolean) {
    await saveSettings({ ...s, security: { ...s.security, keepWorking: on } });
    const d = desktop();
    if (d) setBg(await d.setBackground(on));
  }

  return (
    <>
      <div className="head"><div className="grow"><h1>AI agents</h1><p>Your own agents, running on your own computer. Nothing is sent to an outside company.</p></div></div>
      <div className="grid g2">
        <div className="card stack">
          <h2>AI engine on this computer</h2>
          {models === undefined && <div className="notice">Looking for the AI engine…</div>}
          {models === null && (
            <div className="notice warn" data-testid="ai-missing">
              No AI engine is running on this computer, so the agents use the built-in templates.<br />
              To switch them to AI: install the free, open-source <b>Ollama</b> on this PC, download a model once
              (for example <code>ollama pull gemma3:4b</code>; choose a larger model if the PC has a strong graphics card), then press “Check again”.
            </div>
          )}
          {models && models.length === 0 && <div className="notice warn">The AI engine is running but has no model yet. Download one, then check again.</div>}
          {models && models.length > 0 && <div className="notice ok" data-testid="ai-found">AI engine found with {models.length} model(s).</div>}
          <label className="check"><input data-testid="ai-enable" type="checkbox" checked={s.ai.enabled} onChange={(e) => ai({ enabled: e.target.checked })} /> Let the agents write with AI</label>
          {models && models.length > 0 && (
            <Field label="Model"><select value={model} onChange={(e) => ai({ model: e.target.value })}>{models.map((m) => <option key={m}>{m}</option>)}</select></Field>
          )}
          <div className="row">
            <button className="btn" onClick={check}><Icon name="refresh" /> Check again</button>
            <button className="btn" disabled={!model || testing} onClick={test}>{testing ? 'Asking…' : 'Test the engine'}</button>
          </div>
          <small className="muted">Every AI draft is checked for length and format; if the engine is off or gives a bad answer, the built-in text is used instead.</small>
        </div>

        <div className="card stack">
          <h2>Always-on background work</h2>
          <label className="check">
            <input data-testid="keep-working" type="checkbox" checked={s.security.keepWorking} onChange={(e) => background(e.target.checked)} />
            Keep the agents working when the screen is locked{desktop() ? ' or the window is closed' : ''}
          </label>
          {desktop() ? (
            <small className="muted">
              The app stays in the system tray and starts with the computer. After a restart, open it and enter your password once so the agents can resume.
              {bg && bg.enabled && !bg.tray ? ' (This system has no tray, so keep the window open or minimised.)' : ''}
            </small>
          ) : (
            <small className="muted">On this device the agents work while the app stays open. For round-the-clock work, use the desktop app on a PC that is left switched on.</small>
          )}
          <div className="notice">With this on, locking only locks the screen: your data stays unlocked in memory so work can continue. Turn it off for the strictest security.</div>
        </div>

        <div className="card stack" style={{ gridColumn: '1 / -1' }}>
          <h2>Your agents</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Agent</th><th>Job</th><th>Mode</th><th>On</th></tr></thead>
              <tbody>
                {AGENTS.map((a) => (
                  <tr key={a.name}>
                    <td><b>{a.name}</b></td>
                    <td>{a.job}</td>
                    <td><span className={'chip ' + (a.key && live && s.ai.agents[a.key] ? 'active' : '')}>{a.key ? (live && s.ai.agents[a.key] ? 'AI' : 'templates') : 'automatic'}</span></td>
                    <td>{a.key ? <input type="checkbox" aria-label={a.name} checked={s.ai.agents[a.key]} onChange={(e) => ai({ agents: { ...s.ai.agents, [a.key!]: e.target.checked } })} /> : <input type="checkbox" aria-label={a.name} checked={s.autopilot.enabled} onChange={(e) => saveSettings({ ...s, autopilot: { ...s.autopilot, enabled: e.target.checked } })} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card stack" style={{ gridColumn: '1 / -1' }}>
          <h2>What the agents did</h2>
          {data.activity.filter((a) => a.kind === 'auto').slice(0, 12).map((a) => (
            <div className="row" key={a.id}><span style={{ flex: 1 }}>{a.text}</span><small>{fmtDateTime(a.at)}</small></div>
          ))}
        </div>
      </div>
    </>
  );
}
