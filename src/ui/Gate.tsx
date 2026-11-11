import { useState, type FormEvent } from 'react';
import { passwordStrength } from '../core/crypto';
import { importBackup, saveSettings, setupVault, unlock, getSnapshot } from '../core/store';
import { Field, Icon } from './common';

export function Strength({ pw }: { pw: string }) {
  const s = passwordStrength(pw);
  return (
    <div>
      <div className={'meter s' + s.score}>{[1, 2, 3, 4].map((i) => <i key={i} className={i <= s.score ? 'on' : ''} />)}</div>
      <small className="muted">{pw ? s.label : 'Use at least 10 characters with letters and numbers.'}</small>
    </div>
  );
}

const Brand = () => (
  <div className="logo"><span className="logo-mark"><Icon name="bolt" /></span>Marketing Studio</div>
);

/** First run: create the master password. `onDone` fires after the recovery key was saved. */
export function Setup({ onDone }: { onDone: () => void }) {
  const [business, setBusiness] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [recovery, setRecovery] = useState('');
  const [saved, setSaved] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!passwordStrength(pw).ok) return setErr('Please choose a stronger password (10+ characters, letters and numbers).');
    if (pw !== pw2) return setErr('The two passwords do not match.');
    setBusy(true);
    setErr('');
    try {
      const key = await setupVault(pw);
      const s = getSnapshot().settings;
      await saveSettings({ ...s, business: { ...s.business, name: business.trim() } });
      setRecovery(key);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
    setBusy(false);
  }

  async function restore(file?: File) {
    if (!file) return;
    const msg = await importBackup(file);
    if (msg) setErr(msg);
  }

  if (recovery) {
    return (
      <div className="gate">
        <div className="card stack">
          <Brand />
          <h2>Save your recovery key</h2>
          <p>If you ever forget your password, this key is the <b>only</b> way back in. Write it down and keep it somewhere safe. It is shown only once.</p>
          <div className="recovery" data-testid="recovery">{recovery}</div>
          <label className="check"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I have written down my recovery key</label>
          <button className="btn primary" disabled={!saved} onClick={onDone}>Open Marketing Studio</button>
        </div>
      </div>
    );
  }
  return (
    <div className="gate">
      <form className="card stack" onSubmit={submit}>
        <Brand />
        <h2>Welcome — let's set up your private workspace</h2>
        <p className="muted">Everything stays on this device, encrypted with a password only you know.</p>
        <Field label="Business name"><input value={business} onChange={(e) => setBusiness(e.target.value)} placeholder="e.g. Varma Naturals" autoFocus /></Field>
        <Field label="Create master password"><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></Field>
        <Strength pw={pw} />
        <Field label="Repeat password"><input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" /></Field>
        {err && <div className="notice bad" role="alert">{err}</div>}
        <button className="btn primary" disabled={busy}>{busy ? 'Securing…' : 'Create secure workspace'}</button>
        <label className="btn ghost small">
          Restore from a backup file
          <input type="file" accept=".json,.msbackup,application/json" hidden onChange={(e) => restore(e.target.files?.[0])} />
        </label>
      </form>
    </div>
  );
}

export function Lock() {
  const [pw, setPw] = useState('');
  const [mode, setMode] = useState<'password' | 'recovery'>('password');
  const [rk, setRk] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (mode === 'recovery' && !passwordStrength(pw).ok) return setErr('Please choose a stronger new password.');
    setBusy(true);
    const msg = await unlock(mode === 'password' ? { password: pw } : { recoveryKey: rk, newPassword: pw });
    setBusy(false);
    setErr(msg ?? '');
    if (msg) setPw('');
  }
  return (
    <div className="gate">
      <form className="card stack" onSubmit={submit}>
        <Brand />
        <h2>{mode === 'password' ? 'Enter your password' : 'Reset password with recovery key'}</h2>
        {mode === 'recovery' && (
          <Field label="Recovery key"><input value={rk} onChange={(e) => setRk(e.target.value)} placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" autoCapitalize="characters" /></Field>
        )}
        <Field label={mode === 'password' ? 'Master password' : 'New master password'}>
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus autoComplete={mode === 'password' ? 'current-password' : 'new-password'} />
        </Field>
        {mode === 'recovery' && <Strength pw={pw} />}
        {err && <div className="notice bad" role="alert">{err}</div>}
        <button className="btn primary" disabled={busy || !pw}><Icon name="lock" /> {busy ? 'Checking…' : 'Unlock'}</button>
        <button type="button" className="btn ghost small" onClick={() => { setMode(mode === 'password' ? 'recovery' : 'password'); setErr(''); }}>
          {mode === 'password' ? 'Forgot password? Use recovery key' : 'Back to password'}
        </button>
      </form>
    </div>
  );
}
