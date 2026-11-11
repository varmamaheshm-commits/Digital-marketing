import { useEffect, useRef, useState } from 'react';
import { pendingCounts, runAutopilot } from '../core/actions';
import { lock, useStore } from '../core/store';
import { isRendering, pumpQueue, recoverInterrupted } from '../video/queue';
import { Approvals } from './Approvals';
import { Campaigns } from './Campaigns';
import { Icon, ToastHost } from './common';
import { Content } from './Content';
import { Dashboard } from './Dashboard';
import { Lock, Setup } from './Gate';
import { Leads } from './Leads';
import { Products } from './Products';
import { SettingsPage } from './Settings';
import { Videos } from './Videos';

export type Page = 'home' | 'approvals' | 'products' | 'videos' | 'content' | 'leads' | 'campaigns' | 'settings';
const NAV: { id: Page; label: string; icon: string }[] = [
  { id: 'home', label: 'Dashboard', icon: 'home' },
  { id: 'approvals', label: 'Approvals', icon: 'check' },
  { id: 'products', label: 'Products', icon: 'box' },
  { id: 'videos', label: 'Videos', icon: 'video' },
  { id: 'content', label: 'Content', icon: 'calendar' },
  { id: 'leads', label: 'Leads', icon: 'users' },
  { id: 'campaigns', label: 'Campaigns', icon: 'target' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

export function App() {
  const snap = useStore();
  const [page, setPage] = useState<Page>('home');
  const [showRecovery, setShowRecovery] = useState(false);
  const lastActive = useRef(Date.now());

  // Keep the one-time recovery-key screen visible after the vault has been created.
  useEffect(() => {
    if (snap.status === 'new') setShowRecovery(true);
    if (snap.status === 'locked') setShowRecovery(false);
  }, [snap.status]);
  const unlocked = snap.status === 'unlocked' && !showRecovery;

  // Start background work once unlocked; re-check every 10 minutes.
  useEffect(() => {
    if (!unlocked) return;
    void recoverInterrupted().then(() => runAutopilot()).then(() => pumpQueue());
    const t = setInterval(() => void runAutopilot(), 10 * 60_000);
    return () => clearInterval(t);
  }, [unlocked]);

  // Auto-lock after inactivity (never in the middle of rendering a video).
  const minutes = snap.settings.security.autoLockMinutes;
  useEffect(() => {
    if (snap.status !== 'unlocked' || !minutes) return;
    const touch = () => (lastActive.current = Date.now());
    touch();
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    events.forEach((e) => window.addEventListener(e, touch, { passive: true }));
    const t = setInterval(() => {
      if (isRendering()) return touch();
      if (Date.now() - lastActive.current > minutes * 60_000) lock();
    }, 5000);
    return () => {
      events.forEach((e) => window.removeEventListener(e, touch));
      clearInterval(t);
    };
  }, [snap.status, minutes]);

  if (snap.status === 'loading') return <div className="gate" />;
  if (snap.status === 'new' || (showRecovery && snap.status === 'unlocked')) {
    return <Setup onDone={() => setShowRecovery(false)} key="setup" />;
  }
  if (snap.status === 'locked') return <Lock />;

  const counts = pendingCounts();
  const working = snap.data.videos.filter((v) => v.status === 'queued' || v.status === 'rendering');
  const current = working.find((v) => v.status === 'rendering');
  return (
    <div className="shell">
      <nav className="side" aria-label="Main">
        <div className="logo"><span className="logo-mark"><Icon name="bolt" /></span>Marketing Studio</div>
        {NAV.map((n) => (
          <button key={n.id} className={'nav' + (page === n.id ? ' on' : '')} onClick={() => setPage(n.id)} aria-current={page === n.id ? 'page' : undefined}>
            <Icon name={n.icon} />
            <span>{n.label}</span>
            {n.id === 'approvals' && counts.total > 0 && <span className="count">{counts.total}</span>}
          </button>
        ))}
        <div className="spacer" />
        {working.length > 0 && (
          <div className="rq">
            Creating {working.length} video{working.length > 1 ? 's' : ''}…
            <div className="bar" style={{ marginTop: 6 }}><i style={{ width: `${Math.round((current?.progress ?? 0) * 100)}%` }} /></div>
          </div>
        )}
        <button className="nav" onClick={() => lock()}><Icon name="lock" /><span>Lock</span></button>
      </nav>
      <main className="main">
        <div className="page">
          {page === 'home' && <Dashboard go={setPage} />}
          {page === 'approvals' && <Approvals />}
          {page === 'products' && <Products />}
          {page === 'videos' && <Videos />}
          {page === 'content' && <Content />}
          {page === 'leads' && <Leads />}
          {page === 'campaigns' && <Campaigns />}
          {page === 'settings' && <SettingsPage />}
        </div>
      </main>
      <ToastHost />
    </div>
  );
}
