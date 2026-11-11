import { useSyncExternalStore } from 'react';
import {
  changePassword,
  createVault,
  fromB64,
  lockoutDelayMs,
  open,
  openJson,
  seal,
  sealJson,
  toB64,
  unlockWithPassword,
  unlockWithRecoveryKey,
  type Sealed,
  type VaultMeta,
} from './crypto';
import { dbClear, dbDel, dbEntries, dbGet, dbPut } from './db';
import { COLS, DEFAULT_SETTINGS, uid, type Activity, type Col, type Collections, type Settings } from './types';

export type Status = 'loading' | 'new' | 'locked' | 'unlocked';
export type Data = { [K in Col]: Collections[K][] };
export interface Snapshot {
  status: Status;
  data: Data;
  settings: Settings;
}

const emptyData = (): Data => ({
  products: [], videos: [], posts: [], leads: [], messages: [], campaigns: [], activity: [], knowledge: [], settings: [],
});

let meta: VaultMeta | undefined;
let dek: CryptoKey | null = null;
const maps = new Map<Col, Map<string, any>>(COLS.map((c) => [c, new Map()]));
let snap: Snapshot = { status: 'loading', data: emptyData(), settings: DEFAULT_SETTINGS };
const listeners = new Set<() => void>();

function emit(status: Status = snap.status) {
  const data = emptyData();
  for (const c of COLS) (data[c] as any[]) = [...maps.get(c)!.values()];
  data.activity.sort((a, b) => b.at - a.at);
  const saved = maps.get('settings')!.get('main') as Settings | undefined;
  snap = { status, data, settings: mergeSettings(saved) };
  listeners.forEach((l) => l());
}

function mergeSettings(s?: Partial<Settings>): Settings {
  const d = DEFAULT_SETTINGS;
  if (!s) return d;
  return {
    ...d,
    ...s,
    business: { ...d.business, ...s.business },
    brand: { ...d.brand, ...s.brand },
    autopilot: { ...d.autopilot, ...s.autopilot },
    security: { ...d.security, ...s.security },
    ai: { ...d.ai, ...s.ai, agents: { ...d.ai.agents, ...s.ai?.agents } },
  };
}

export const getSnapshot = () => snap;
export const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const useStore = () => useSyncExternalStore(subscribe, getSnapshot);

const key = () => {
  if (!dek) throw new Error('The vault is locked.');
  return dek;
};

// ---------- lifecycle ----------

export async function init() {
  meta = await dbGet<VaultMeta>('meta', 'vault');
  emit(meta ? 'locked' : 'new');
  // Ask the browser not to evict our storage under disk pressure.
  navigator.storage?.persist?.().catch(() => {});
}

export async function setupVault(password: string): Promise<string> {
  const v = await createVault(password);
  await dbClear('records');
  await dbClear('blobs');
  await dbPut('meta', 'vault', v.meta);
  await dbDel('meta', 'lockout');
  meta = v.meta;
  dek = v.dek;
  for (const m of maps.values()) m.clear();
  await put('settings', DEFAULT_SETTINGS);
  await log('security', 'Vault created and protected with your master password.');
  emit('unlocked');
  return v.recoveryKey;
}

interface Lockout { fails: number; until: number }
export const getLockout = async (): Promise<Lockout> => (await dbGet<Lockout>('meta', 'lockout')) ?? { fails: 0, until: 0 };

async function loadAll() {
  for (const m of maps.values()) m.clear();
  for (const [k, sealed] of await dbEntries<Sealed>('records')) {
    const col = k.slice(0, k.indexOf(':')) as Col;
    const value = await openJson<any>(key(), sealed, k);
    maps.get(col)?.set(value.id, value);
  }
}

/** Returns an error message, or null on success. */
export async function unlock(secret: { password: string } | { recoveryKey: string; newPassword: string }): Promise<string | null> {
  if (!meta) return 'No vault found.';
  const lo = await getLockout();
  if (lo.until > Date.now()) {
    return `Too many wrong attempts. Try again in ${Math.ceil((lo.until - Date.now()) / 1000)} seconds.`;
  }
  try {
    if ('password' in secret) {
      dek = await unlockWithPassword(meta, secret.password);
    } else {
      dek = await unlockWithRecoveryKey(meta, secret.recoveryKey);
      meta = await changePassword(meta, { recoveryKey: secret.recoveryKey }, secret.newPassword);
      await dbPut('meta', 'vault', meta);
    }
  } catch {
    const fails = lo.fails + 1;
    const delay = lockoutDelayMs(fails);
    await dbPut('meta', 'lockout', { fails, until: Date.now() + delay });
    return delay
      ? `Wrong ${'password' in secret ? 'password' : 'recovery key'}. Locked for ${Math.round(delay / 1000)} seconds.`
      : `Wrong ${'password' in secret ? 'password' : 'recovery key'}. ${5 - fails} attempt(s) left before a timed lock.`;
  }
  await loadAll();
  if (lo.fails > 0) await log('security', `Unlocked after ${lo.fails} failed attempt(s).`);
  await dbDel('meta', 'lockout');
  if (!('password' in secret)) await log('security', 'Password reset using the recovery key.');
  emit('unlocked');
  return null;
}

export function lock() {
  dek = null;
  for (const m of maps.values()) m.clear();
  emit(meta ? 'locked' : 'new');
}

export async function updatePassword(current: string, next: string): Promise<string | null> {
  if (!meta) return 'No vault found.';
  try {
    meta = await changePassword(meta, { password: current }, next);
  } catch {
    return 'The current password is not correct.';
  }
  await dbPut('meta', 'vault', meta);
  await log('security', 'Master password changed.');
  return null;
}

export async function wipeEverything() {
  await dbClear('records');
  await dbClear('blobs');
  await dbClear('meta');
  meta = undefined;
  lock();
}

// ---------- records ----------

export async function put<K extends Col>(col: K, item: Collections[K]) {
  const k = `${col}:${item.id}`;
  maps.get(col)!.set(item.id, item);
  emit();
  await dbPut('records', k, await sealJson(key(), item, k));
}

export async function patch<K extends Col>(col: K, id: string, changes: Partial<Collections[K]>) {
  const cur = maps.get(col)!.get(id);
  if (cur) await put(col, { ...cur, ...changes });
}

/** In-memory only update (e.g. render progress) – not written to disk. */
export function patchVolatile<K extends Col>(col: K, id: string, changes: Partial<Collections[K]>) {
  const cur = maps.get(col)!.get(id);
  if (!cur) return;
  maps.get(col)!.set(id, { ...cur, ...changes });
  emit();
}

export async function remove(col: Col, id: string) {
  maps.get(col)!.delete(id);
  emit();
  await dbDel('records', `${col}:${id}`);
}

export const getOne = <K extends Col>(col: K, id?: string): Collections[K] | undefined =>
  id ? maps.get(col)!.get(id) : undefined;

export async function log(kind: Activity['kind'], text: string) {
  await put('activity', { id: uid(), at: Date.now(), kind, text });
  // Keep the audit trail bounded.
  const all = [...maps.get('activity')!.values()].sort((a, b) => b.at - a.at);
  for (const old of all.slice(400)) await remove('activity', old.id);
}

export const saveSettings = (s: Settings) => put('settings', s);

// ---------- encrypted files (photos, rendered videos) ----------

export async function putBlob(data: ArrayBuffer | Uint8Array, id = uid()): Promise<string> {
  await dbPut('blobs', id, await seal(key(), data, `blob:${id}`));
  return id;
}

export async function getBlob(id: string): Promise<ArrayBuffer | null> {
  const sealed = await dbGet<Sealed>('blobs', id);
  return sealed ? open(key(), sealed, `blob:${id}`) : null;
}

export const delBlob = (id?: string) => (id ? dbDel('blobs', id) : Promise.resolve());

// ---------- encrypted backup ----------

const packSealed = (s: Sealed) => ({ iv: toB64(s.iv), ct: toB64(s.ct) });
const unpackSealed = (s: { iv: string; ct: string }): Sealed => ({ iv: fromB64(s.iv), ct: fromB64(s.ct).buffer as ArrayBuffer });

/** The backup contains only ciphertext; it can be opened only with the password / recovery key. */
export async function exportBackup(includeVideos: boolean): Promise<Blob> {
  if (!meta) throw new Error('No vault.');
  const videoBlobIds = new Set(snap.data.videos.map((v) => v.blobId).filter(Boolean) as string[]);
  const parts: string[] = [];
  parts.push('{"format":"marketing-studio-backup","v":1,"createdAt":' + Date.now() + ',"meta":');
  parts.push(
    JSON.stringify({
      ...meta,
      pwSalt: toB64(meta.pwSalt), rkSalt: toB64(meta.rkSalt),
      pwWrap: packSealed(meta.pwWrap), rkWrap: packSealed(meta.rkWrap),
    }),
  );
  for (const store of ['records', 'blobs'] as const) {
    parts.push(`,"${store}":{`);
    let first = true;
    for (const [k, s] of await dbEntries<Sealed>(store)) {
      if (store === 'blobs' && !includeVideos && videoBlobIds.has(k)) continue;
      parts.push((first ? '' : ',') + JSON.stringify(k) + ':' + JSON.stringify(packSealed(s)));
      first = false;
    }
    parts.push('}');
  }
  parts.push('}');
  await log('security', 'Encrypted backup exported.');
  return new Blob(parts, { type: 'application/json' });
}

/** Replaces everything on this device with the backup, then locks. */
export async function importBackup(file: Blob): Promise<string | null> {
  let j: any;
  try {
    j = JSON.parse(await file.text());
  } catch {
    return 'This file is not a valid backup.';
  }
  if (j?.format !== 'marketing-studio-backup' || j.v !== 1 || !j.meta?.pwWrap) return 'This file is not a Marketing Studio backup.';
  const m: VaultMeta = {
    v: 1,
    iterations: Number(j.meta.iterations),
    createdAt: Number(j.meta.createdAt),
    pwSalt: fromB64(j.meta.pwSalt), rkSalt: fromB64(j.meta.rkSalt),
    pwWrap: unpackSealed(j.meta.pwWrap), rkWrap: unpackSealed(j.meta.rkWrap),
  };
  await dbClear('records');
  await dbClear('blobs');
  for (const [k, s] of Object.entries<any>(j.records ?? {})) await dbPut('records', k, unpackSealed(s));
  for (const [k, s] of Object.entries<any>(j.blobs ?? {})) await dbPut('blobs', k, unpackSealed(s));
  await dbPut('meta', 'vault', m);
  await dbDel('meta', 'lockout');
  meta = m;
  lock();
  return null;
}

/** Re-checks the master password without changing state (used to leave the lead-capture screen). */
export async function verifyPassword(password: string): Promise<boolean> {
  if (!meta) return false;
  try {
    await unlockWithPassword(meta, password);
    return true;
  } catch {
    return false;
  }
}
