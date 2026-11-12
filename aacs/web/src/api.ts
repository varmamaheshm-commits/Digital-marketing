export interface Res { id: string; kind: string; name: string; data: any; version: number; status: string; project_id: string | null; created_at: string; updated_at: string }
export interface Me {
  user: { id: string; email: string; name: string; role: string; mfaEnabled: boolean };
  org: { id: string; name: string; region: string; settings: Record<string, any> };
  roles: string[]; envs: string[]; projects: { id: string; name: string; description: string }[]; capabilities: { browserAutomation: boolean };
}

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch('/api' + url, { method, credentials: 'same-origin', headers: method === 'GET' ? {} : { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/auth/') && url !== '/me') window.dispatchEvent(new Event('aacs:signed-out'));
    throw new Error(json?.error ?? `Request failed (${res.status})`);
  }
  return json as T;
}
export const GET = <T = any,>(u: string) => api<T>('GET', u);
export const POST = <T = any,>(u: string, b?: unknown) => api<T>('POST', u, b);
export const PUT = <T = any,>(u: string, b?: unknown) => api<T>('PUT', u, b);
export const DEL = <T = any,>(u: string) => api<T>('DELETE', u, {});
export const listRes = (kind: string) => GET<Res[]>(`/resources?kind=${kind}`);

const WRITE: Record<string, string[]> = {
  app: ['developer', 'business_user'], table: ['developer', 'business_user'], workflow: ['developer', 'business_user'], bot: ['developer'], connector: ['developer'], model: [],
  agent: ['developer', 'agent_owner'], crew: ['developer', 'agent_owner'], kb: ['developer', 'agent_owner'], prompt: ['developer', 'agent_owner', 'business_user'], testsuite: ['developer', 'tester', 'agent_owner'],
};
/** Mirrors the server's RBAC so the portal hides what a role cannot do (the server still enforces it). */
export const canWrite = (role: string, kind: string) => role === 'admin' || (WRITE[kind] ?? []).includes(role);
export const fmtDate = (s?: string | null) => (s ? new Date(s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
export const fmtCost = (n: number) => (n === 0 ? '$0' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
export const fmtNum = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n * 100) / 100));
export const newId = () => Math.random().toString(36).slice(2, 9);
