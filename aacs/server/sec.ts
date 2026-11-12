// Security primitives: password hashing, sessions, AES-256-GCM vault, TOTP (MFA),
// RBAC, the prompt firewall / PII detector, and the outbound-request (SSRF) guard.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { DATA_DIR, get, run } from './db.ts';

// ---------- passwords & tokens ----------
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${scryptSync(pw, salt, 64).toString('base64')}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [, salt, hash] = stored.split('$');
  if (!salt || !hash) return false;
  const a = scryptSync(pw, Buffer.from(salt, 'base64'), 64);
  const b = Buffer.from(hash, 'base64');
  return a.length === b.length && timingSafeEqual(a, b);
}
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

// ---------- encryption at rest (AES-256-GCM) ----------
function masterKey(): Buffer {
  const env = process.env.AACS_MASTER_KEY;
  if (env) {
    const k = Buffer.from(env, 'hex');
    if (k.length !== 32) throw new Error('AACS_MASTER_KEY must be 64 hex characters (32 bytes)');
    return k;
  }
  const file = path.join(DATA_DIR, 'master.key');
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
}
const KEY = masterKey();
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
export function decrypt(blob: string): string {
  const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = createDecipheriv('aes-256-gcm', KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
export function getSecret(orgId: string, name: string): string | undefined {
  const r = get('SELECT value_enc FROM secrets WHERE org_id = ? AND name = ?', orgId, name);
  return r ? decrypt(r.value_enc) : undefined;
}
export function setSecret(orgId: string, userId: string | null, name: string, value: string) {
  run('INSERT INTO secrets (id, org_id, name, value_enc, created_by, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(org_id, name) DO UPDATE SET value_enc = excluded.value_enc',
    'sec_' + randomBytes(8).toString('hex'), orgId, name, encrypt(value), userId, new Date().toISOString());
}

// ---------- TOTP (RFC 6238, SHA-1, 30 s, 6 digits) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function newTotpSecret(): string {
  return [...randomBytes(20)].map((b) => B32[b % 32]).join('');
}
function b32decode(s: string): Buffer {
  let bits = '';
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const v = B32.indexOf(ch);
    if (v >= 0) bits += v.toString(2).padStart(5, '0');
  }
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
export function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const h = createHmac('sha1', b32decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
export function verifyTotp(secret: string, code: string): boolean {
  const c = String(code || '').replace(/\s/g, '');
  return [-1, 0, 1].some((w) => totp(secret, Date.now() + w * 30000) === c);
}

// ---------- RBAC ----------
export const ROLES = ['admin', 'developer', 'business_user', 'tester', 'agent_owner'] as const;
export type Role = (typeof ROLES)[number];
const BUILD: Record<string, Role[]> = {
  app: ['developer', 'business_user'], table: ['developer', 'business_user'], workflow: ['developer', 'business_user'],
  bot: ['developer'], connector: ['developer'], model: [],
  agent: ['developer', 'agent_owner'], crew: ['developer', 'agent_owner'], kb: ['developer', 'agent_owner'], prompt: ['developer', 'agent_owner', 'business_user'],
  testsuite: ['developer', 'tester', 'agent_owner'],
};
export const KINDS = Object.keys(BUILD);
export function can(role: string, action: string, kind = ''): boolean {
  if (role === 'admin') return true;
  switch (action) {
    case 'read': case 'run': case 'records': return true;
    case 'write': return (BUILD[kind] ?? []).includes(role as Role);
    case 'approve': return role === 'agent_owner';
    case 'deploy': return role === 'developer'; // production still needs an approval
    default: return false; // users, security, secrets, org, models
  }
}

// ---------- prompt firewall, PII, moderation ----------
const INJECTION: [RegExp, string][] = [
  [/\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|your)\b[^.\n]{0,30}\b(instructions?|rules?|prompts?|guidelines?)/i, 'instruction override'],
  [/\b(reveal|show|print|repeat|output|leak)\b[^.\n]{0,40}\b(system prompt|hidden instructions?|your instructions|initial prompt)/i, 'system prompt extraction'],
  [/\byou are now\b|\bact as (dan|an? unrestricted|an? unfiltered)|\bdeveloper mode\b|\bjailbreak\b|\bdo anything now\b/i, 'jailbreak persona'],
  [/\b(without|no|bypass|disable)\b[^.\n]{0,20}\b(restrictions?|filters?|safety|guardrails?|limitations?)/i, 'safety bypass'],
  [/<\/?(system|instructions?)>|\[\/?(system|inst)\]|###\s*(system|instruction)/i, 'role-tag injection'],
  [/\b(send|post|upload|exfiltrate|forward)\b[^.\n]{0,40}\b(api keys?|passwords?|secrets?|credentials|tokens?)\b/i, 'credential exfiltration'],
];
export function detectInjection(text: string): string[] {
  return INJECTION.filter(([re]) => re.test(text)).map(([, label]) => label);
}

function luhn(d: string): boolean {
  let sum = 0;
  for (let i = d.length - 1, alt = false; i >= 0; i--, alt = !alt) {
    let n = +d[i];
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}
const PII: { type: string; re: RegExp; ok?: (m: string) => boolean }[] = [
  { type: 'EMAIL', re: /\b[\w.+-]+@[\w-]+(\.[\w-]+)+\b/g },
  { type: 'CARD', re: /\b(?:\d[ -]?){13,19}\b/g, ok: (m) => { const d = m.replace(/\D/g, ''); return d.length >= 13 && d.length <= 19 && luhn(d); } },
  { type: 'AADHAAR', re: /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g },
  { type: 'PAN', re: /\b[A-Z]{5}\d{4}[A-Z]\b/g },
  { type: 'SSN', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { type: 'PHONE', re: /(?<![\w.])\+?\d{1,3}[ -]?\(?\d{2,5}\)?[ -]?\d{3,5}[ -]?\d{3,5}(?![\w.])/g, ok: (m) => m.replace(/\D/g, '').length >= 10 },
  { type: 'API_KEY', re: /\b(sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g },
  { type: 'IP', re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
];
export function detectPII(text: string, types?: string[]): { type: string; value: string }[] {
  const found: { type: string; value: string }[] = [];
  let rest = text;
  for (const p of PII) {
    if (types && !types.includes(p.type)) continue;
    rest = rest.replace(p.re, (m) => {
      if (p.ok && !p.ok(m)) return m;
      found.push({ type: p.type, value: m });
      return ' '.repeat(m.length);
    });
  }
  return found;
}
export function maskPII(text: string, types?: string[]): string {
  let out = text;
  for (const p of PII) {
    if (types && !types.includes(p.type)) continue;
    out = out.replace(p.re, (m) => (p.ok && !p.ok(m) ? m : `[${p.type}]`));
  }
  return out;
}
const TOXIC = /\b(idiot|stupid|moron|dumbass|shut up|hate you|kill yourself|worthless|loser|scum|bastard|bitch|asshole|f+u+c+k\w*|shit\w*)\b/gi;
export const detectToxicity = (text: string): string[] => [...new Set((text.match(TOXIC) ?? []).map((s) => s.toLowerCase()))];

export interface GuardVerdict { blocked: boolean; injection: string[]; pii: { type: string; value: string }[]; toxicity: string[]; text: string }
/** Screen text entering a model. `policy` comes from orgSettings(). */
export function guardInput(text: string, policy: { firewall?: string; maskInput?: boolean; piiTypes?: string[] }): GuardVerdict {
  const injection = policy.firewall === 'off' ? [] : detectInjection(text);
  const pii = detectPII(text, policy.piiTypes);
  return { blocked: policy.firewall === 'block' && injection.length > 0, injection, pii, toxicity: detectToxicity(text), text: policy.maskInput ? maskPII(text, policy.piiTypes) : text };
}
/** Screen text leaving a model. */
export function guardOutput(text: string, policy: { maskOutput?: boolean; moderation?: boolean; piiTypes?: string[] }): GuardVerdict {
  const pii = detectPII(text, policy.piiTypes);
  const toxicity = detectToxicity(text);
  let out = policy.maskOutput ? maskPII(text, policy.piiTypes) : text;
  if (policy.moderation && toxicity.length) out = out.replace(TOXIC, '***');
  return { blocked: false, injection: [], pii, toxicity, text: out };
}

// ---------- outbound request guard ----------
function isPrivate(ip: string): boolean {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l.startsWith('::ffff:')) return isPrivate(l.slice(7));
    return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
/** Workflows, bots, tests and agent tools may only call public http(s) hosts unless AACS_ALLOW_PRIVATE_HTTP=1. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`Invalid URL: ${raw}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http(s) URLs are allowed');
  if (process.env.AACS_ALLOW_PRIVATE_HTTP === '1') return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => { throw new Error(`Cannot resolve ${host}`); });
  if (addrs.some((a) => isPrivate(a.address))) throw new Error(`Requests to private or loopback addresses are blocked (${host})`);
  return u;
}
export async function safeFetch(url: string, init: RequestInit = {}, timeoutMs = 20000): Promise<Response> {
  await assertPublicUrl(url);
  return fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
}
