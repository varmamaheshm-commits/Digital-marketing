/**
 * Outgoing automation events. When the owner has set a webhook address (for example an
 * n8n Webhook node), each event is sent there by the desktop app. Kept in its own file so
 * any part of the app can raise an event without import cycles.
 */
import { getSnapshot } from './store';

export type LinkEvent = 'video.ready' | 'video.approved' | 'video.rejected' | 'video.posted' | 'video.post_failed' | 'item.posted' | 'item.post_failed' | 'lead.created' | 'test';

export interface DesktopLink {
  start: (cfg: { code: string; port: number }) => Promise<{ ok: boolean; port?: number; addresses?: string[]; error?: string }>;
  stop: () => Promise<void>;
  onRequest: (handler: (req: { method: string; path: string; body: unknown }) => Promise<unknown>) => void;
  notify: (url: string, signingKey: string, event: string, data: unknown) => Promise<{ ok: boolean; error?: string }>;
}
export const desktopLink = (): DesktopLink | undefined => (globalThis as any).desktop?.link;

/** Fire-and-forget: automation must never slow down or break the app itself. */
export function emitEvent(event: LinkEvent, data: Record<string, unknown>): void {
  const snap = getSnapshot();
  const link = snap.settings.link;
  const bridge = desktopLink();
  if (!bridge || snap.status !== 'unlocked' || !link.webhookUrl.trim()) return;
  void bridge.notify(link.webhookUrl.trim(), link.code, event, data).catch(() => {});
}
