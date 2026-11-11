/**
 * Vault cryptography (Web Crypto only, nothing leaves the device).
 *
 *  - A random 256-bit data key (DEK) encrypts every record and file with AES-GCM.
 *  - The DEK is stored only in wrapped form: once under a key derived from the
 *    owner's password (PBKDF2-SHA-256) and once under a random recovery key.
 *  - While unlocked, the DEK lives in memory as a non-extractable CryptoKey.
 */
export const KDF_ITERATIONS = 600_000;

export interface Sealed {
  iv: Uint8Array;
  ct: ArrayBuffer;
}

export interface VaultMeta {
  v: 1;
  iterations: number;
  pwSalt: Uint8Array;
  pwWrap: Sealed;
  rkSalt: Uint8Array;
  rkWrap: Sealed;
  createdAt: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const buf = (u: Uint8Array) => u as unknown as BufferSource;

async function deriveKek(secret: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', buf(enc.encode(secret.normalize('NFKC'))), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: buf(salt), iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

async function wrap(dek: CryptoKey, kek: CryptoKey): Promise<Sealed> {
  const iv = rand(12);
  const ct = await crypto.subtle.wrapKey('raw', dek, kek, { name: 'AES-GCM', iv: buf(iv) });
  return { iv, ct };
}

async function unwrap(sealed: Sealed, kek: CryptoKey, extractable: boolean): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey(
    'raw',
    sealed.ct,
    kek,
    { name: 'AES-GCM', iv: buf(sealed.iv) },
    { name: 'AES-GCM', length: 256 },
    extractable,
    ['encrypt', 'decrypt'],
  );
}

const B32 = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'; // no look-alike characters
export function newRecoveryKey(): string {
  // 30 symbols from a 30-letter alphabet ≈ 147 bits; rejection sampling avoids bias.
  const out: string[] = [];
  while (out.length < 30) {
    for (const b of rand(64)) {
      if (b < 240 && out.length < 30) out.push(B32[b % 30]);
    }
  }
  return out.join('').replace(/(.{5})(?=.)/g, '$1-');
}
export const normalizeRecoveryKey = (k: string) => k.toUpperCase().replace(/[^A-Z0-9]/g, '');

export async function createVault(
  password: string,
  iterations = KDF_ITERATIONS,
): Promise<{ meta: VaultMeta; dek: CryptoKey; recoveryKey: string }> {
  const dekX = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const recoveryKey = newRecoveryKey();
  const pwSalt = rand(16);
  const rkSalt = rand(16);
  const pwWrap = await wrap(dekX, await deriveKek(password, pwSalt, iterations));
  const rkWrap = await wrap(dekX, await deriveKek(normalizeRecoveryKey(recoveryKey), rkSalt, iterations));
  const meta: VaultMeta = { v: 1, iterations, pwSalt, pwWrap, rkSalt, rkWrap, createdAt: Date.now() };
  // Re-import as non-extractable for day-to-day use.
  const dek = await unwrap(pwWrap, await deriveKek(password, pwSalt, iterations), false);
  return { meta, dek, recoveryKey };
}

/** Throws if the password is wrong (AES-GCM authentication fails). */
export async function unlockWithPassword(meta: VaultMeta, password: string): Promise<CryptoKey> {
  return unwrap(meta.pwWrap, await deriveKek(password, meta.pwSalt, meta.iterations), false);
}

export async function unlockWithRecoveryKey(meta: VaultMeta, recoveryKey: string): Promise<CryptoKey> {
  return unwrap(meta.rkWrap, await deriveKek(normalizeRecoveryKey(recoveryKey), meta.rkSalt, meta.iterations), false);
}

/** Set a new password. `proof` is the current password or the recovery key. */
export async function changePassword(
  meta: VaultMeta,
  proof: { password: string } | { recoveryKey: string },
  newPassword: string,
): Promise<VaultMeta> {
  const dekX =
    'password' in proof
      ? await unwrap(meta.pwWrap, await deriveKek(proof.password, meta.pwSalt, meta.iterations), true)
      : await unwrap(
          meta.rkWrap,
          await deriveKek(normalizeRecoveryKey(proof.recoveryKey), meta.rkSalt, meta.iterations),
          true,
        );
  const pwSalt = rand(16);
  const pwWrap = await wrap(dekX, await deriveKek(newPassword, pwSalt, meta.iterations));
  return { ...meta, pwSalt, pwWrap };
}

/** `aad` binds the ciphertext to its storage slot so records cannot be swapped around. */
export async function seal(dek: CryptoKey, data: Uint8Array | ArrayBuffer, aad: string): Promise<Sealed> {
  const iv = rand(12);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: buf(iv), additionalData: buf(enc.encode(aad)) },
    dek,
    data as BufferSource,
  );
  return { iv, ct };
}

export async function open(dek: CryptoKey, sealed: Sealed, aad: string): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: buf(sealed.iv), additionalData: buf(enc.encode(aad)) },
    dek,
    sealed.ct,
  );
}

export const sealJson = (dek: CryptoKey, value: unknown, aad: string) =>
  seal(dek, enc.encode(JSON.stringify(value)), aad);
export const openJson = async <T>(dek: CryptoKey, sealed: Sealed, aad: string): Promise<T> =>
  JSON.parse(dec.decode(await open(dek, sealed, aad))) as T;

export function passwordStrength(pw: string): { score: 0 | 1 | 2 | 3 | 4; label: string; ok: boolean } {
  let classes = 0;
  if (/[a-z]/.test(pw)) classes++;
  if (/[A-Z]/.test(pw)) classes++;
  if (/\d/.test(pw)) classes++;
  if (/[^A-Za-z0-9]/.test(pw)) classes++;
  const repetitive = /^(.)\1+$/.test(pw) || /^(0123456789|1234567890|password|qwerty)/i.test(pw);
  let score = 0;
  if (pw.length >= 8) score = 1;
  if (pw.length >= 10 && classes >= 2) score = 2;
  if (pw.length >= 12 && classes >= 3) score = 3;
  if (pw.length >= 16 && classes >= 3) score = 4;
  if (repetitive) score = Math.min(score, 1);
  const labels = ['Too short', 'Weak', 'Fair', 'Strong', 'Very strong'];
  return { score: score as 0 | 1 | 2 | 3 | 4, label: labels[score], ok: score >= 2 };
}

/** Delay (ms) enforced before the next unlock attempt after `fails` wrong tries. */
export function lockoutDelayMs(fails: number): number {
  if (fails < 5) return 0;
  return Math.min(30_000 * 2 ** (fails - 5), 15 * 60_000);
}

export const toB64 = (bytes: ArrayBuffer | Uint8Array): string => {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
export const fromB64 = (b64: string): Uint8Array => {
  const s = atob(b64);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
};
