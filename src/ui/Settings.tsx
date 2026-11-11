import { useState } from 'react';
import { passwordStrength } from '../core/crypto';
import { saveFile } from '../core/files';
import { exportBackup, importBackup, lock, saveSettings, updatePassword, useStore, wipeEverything } from '../core/store';
import type { Lang, Settings, VideoFormat } from '../core/types';
import { FORMAT_INFO, LANG_NAMES } from '../core/types';
import { Field, fmtDateTime, Icon, toast } from './common';
import { Strength } from './Gate';

export function SettingsPage() {
  const { settings: s, data } = useStore();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [withVideos, setWithVideos] = useState(false);
  const save = (patch: Partial<Settings>) => saveSettings({ ...s, ...patch });
  const biz = (k: keyof Settings['business'], v: string) => save({ business: { ...s.business, [k]: v } });
  const auto = (patch: Partial<Settings['autopilot']>) => save({ autopilot: { ...s.autopilot, ...patch } });

  async function changePw() {
    if (!passwordStrength(next).ok) return toast('Choose a stronger new password');
    const msg = await updatePassword(cur, next);
    toast(msg ?? 'Password changed');
    if (!msg) { setCur(''); setNext(''); }
  }
  async function backup() {
    const blob = await exportBackup(withVideos);
    await saveFile(blob, `marketing-studio-backup-${new Date().toISOString().slice(0, 10)}.json`);
  }
  async function restore(file?: File) {
    if (!file || !confirm('Restoring replaces everything on this device with the backup. Continue?')) return;
    const msg = await importBackup(file);
    if (msg) toast(msg);
  }
  async function wipe() {
    if (prompt('This permanently erases all data on this device. Type DELETE to confirm.') === 'DELETE') await wipeEverything();
  }

  return (
    <>
      <div className="head"><div className="grow"><h1>Settings</h1><p>Your business, brand, automation and security.</p></div></div>
      <div className="grid g2">
        <div className="card stack">
          <h2>Business</h2>
          <div className="form">
            <Field label="Business name"><input value={s.business.name} onChange={(e) => biz('name', e.target.value)} /></Field>
            <Field label="Tagline"><input value={s.business.tagline} onChange={(e) => biz('tagline', e.target.value)} /></Field>
            <Field label="Phone / WhatsApp"><input value={s.business.phone} onChange={(e) => biz('phone', e.target.value)} /></Field>
            <Field label="Website"><input value={s.business.website} onChange={(e) => biz('website', e.target.value)} /></Field>
            <Field label="City"><input value={s.business.city} onChange={(e) => biz('city', e.target.value)} /></Field>
            <Field label="Currency symbol"><input value={s.currency} onChange={(e) => save({ currency: e.target.value })} /></Field>
          </div>
        </div>
        <div className="card stack">
          <h2>Brand & voice</h2>
          <div className="form">
            <Field label="Main colour"><input type="color" value={s.brand.primary} onChange={(e) => save({ brand: { ...s.brand, primary: e.target.value } })} /></Field>
            <Field label="Highlight colour"><input type="color" value={s.brand.accent} onChange={(e) => save({ brand: { ...s.brand, accent: e.target.value } })} /></Field>
            <Field label="Writing tone" full>
              <select value={s.tone} onChange={(e) => save({ tone: e.target.value as Settings['tone'] })}>
                <option value="friendly">Friendly</option><option value="professional">Professional</option><option value="energetic">Energetic</option><option value="luxury">Luxury</option>
              </select>
            </Field>
          </div>
        </div>
        <div className="card stack">
          <h2>Autopilot</h2>
          <label className="check"><input type="checkbox" checked={s.autopilot.enabled} onChange={(e) => auto({ enabled: e.target.checked })} /> Prepare videos, posts and follow-ups automatically</label>
          <Field label="What needs your approval">
            <select data-testid="approvals-mode" value={s.approvals} onChange={(e) => save({ approvals: e.target.value as Settings['approvals'] })}>
              <option value="videos">Videos only — posts and lead messages are approved automatically</option>
              <option value="all">Everything — videos, posts and lead messages</option>
            </select>
          </Field>
          <b style={{ fontSize: '.86rem' }}>Video languages</b>
          <div className="row">
            {(Object.keys(LANG_NAMES) as Lang[]).map((l) => (
              <label className="check" key={l}>
                <input type="checkbox" checked={s.autopilot.languages.includes(l)} onChange={(e) => auto({ languages: e.target.checked ? [...s.autopilot.languages, l] : s.autopilot.languages.filter((x) => x !== l) })} /> {LANG_NAMES[l]}
              </label>
            ))}
          </div>
          <b style={{ fontSize: '.86rem' }}>Video shapes to create for each product</b>
          {(Object.keys(FORMAT_INFO) as VideoFormat[]).map((f) => (
            <label className="check" key={f}>
              <input type="checkbox" checked={s.autopilot.videoFormats.includes(f)} onChange={(e) => auto({ videoFormats: e.target.checked ? [...s.autopilot.videoFormats, f] : s.autopilot.videoFormats.filter((x) => x !== f) })} />
              <span>{FORMAT_INFO[f].label} <small className="muted">— {FORMAT_INFO[f].use}</small></span>
            </label>
          ))}
          <div className="form">
            <Field label="Video look">
              <select value={s.autopilot.videoStyle} onChange={(e) => auto({ videoStyle: e.target.value as any })}><option value="auto">Automatic</option><option value="bold">Bold</option><option value="clean">Clean</option><option value="luxe">Luxury</option></select>
            </Field>
            <Field label="Music">
              <select value={s.autopilot.mood} onChange={(e) => auto({ mood: e.target.value as any })}><option value="auto">Automatic</option><option value="upbeat">Upbeat</option><option value="chill">Chill</option><option value="cinematic">Cinematic</option><option value="none">No music</option></select>
            </Field>
            <Field label="New video every (days)"><input type="number" min={1} max={90} value={s.autopilot.videoRefreshDays} onChange={(e) => auto({ videoRefreshDays: Math.max(1, Number(e.target.value) || 14) })} /></Field>
            <Field label="Posts per week"><input type="number" min={0} max={21} value={s.autopilot.postsPerWeek} onChange={(e) => auto({ postsPerWeek: Math.max(0, Math.min(21, Number(e.target.value) || 0)) })} /></Field>
            <Field label="Follow up leads after (days)"><input type="number" min={1} max={30} value={s.autopilot.followUpDays} onChange={(e) => auto({ followUpDays: Math.max(1, Number(e.target.value) || 3) })} /></Field>
          </div>
        </div>
        <div className="card stack">
          <h2><Icon name="shield" /> Security</h2>
          <div className="notice ok">All data is encrypted on this device (AES-256). The app makes no connections to any outside server.</div>
          <Field label="Lock automatically after (minutes without use)">
            <select value={s.security.autoLockMinutes} onChange={(e) => save({ security: { autoLockMinutes: Number(e.target.value) } })}>
              {[2, 5, 10, 30, 60].map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
          <button className="btn" onClick={() => lock()}><Icon name="lock" /> Lock now</button>
          <h3 style={{ marginTop: 8 }}>Change master password</h3>
          <input type="password" placeholder="Current password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" aria-label="Current password" />
          <input type="password" placeholder="New password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" aria-label="New password" />
          {next && <Strength pw={next} />}
          <button className="btn" disabled={!cur || !next} onClick={changePw}>Change password</button>
        </div>
        <div className="card stack">
          <h2>Backup & restore</h2>
          <p className="muted">The backup file stays encrypted — it opens only with your password or recovery key. Use it to move to another device.</p>
          <label className="check"><input type="checkbox" checked={withVideos} onChange={(e) => setWithVideos(e.target.checked)} /> Include finished videos (larger file)</label>
          <div className="row">
            <button className="btn primary" onClick={backup}><Icon name="download" /> Save backup</button>
            <label className="btn">Restore from backup<input type="file" accept=".json,application/json" hidden onChange={(e) => { void restore(e.target.files?.[0]); e.target.value = ''; }} /></label>
          </div>
          <h3 style={{ marginTop: 8 }}>Danger zone</h3>
          <div><button className="btn danger" onClick={wipe}><Icon name="trash" /> Erase all data on this device</button></div>
        </div>
        <div className="card stack">
          <h2>Security & activity log</h2>
          <div className="stack" style={{ maxHeight: 340, overflowY: 'auto' }}>
            {data.activity.slice(0, 60).map((a) => (
              <div className="row" key={a.id}><span className="chip">{a.kind}</span><span style={{ flex: 1 }}>{a.text}</span><small>{fmtDateTime(a.at)}</small></div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
