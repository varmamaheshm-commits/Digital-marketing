import { useEffect, useState, type ReactNode } from 'react';
import { getBlob } from '../core/store';

const PATHS: Record<string, string> = {
  home: 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  check: 'M9 12l2 2 4-4M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  box: 'M21 8l-9-5-9 5v8l9 5 9-5zM3 8l9 5 9-5M12 13v8',
  video: 'M15 10l6-3v10l-6-3zM3 6h12v12H3z',
  calendar: 'M4 5h16v16H4zM4 10h16M8 3v4M16 3v4',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 12h.01',
  settings: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M16 4v4M10 10v4M18 16v4',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  plus: 'M12 5v14M5 12h14',
  x: 'M6 6l12 12M18 6L6 18',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  download: 'M12 3v12M7 11l5 5 5-5M4 21h16',
  share: 'M4 12v8h16v-8M12 3v13M7 8l5-5 5 5',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
};
export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? ''} />
    </svg>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={'modal' + (wide ? ' wide' : '')} role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button className="btn ghost small" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </header>
        {children}
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

export function Field({ label, hint, children, full }: { label: string; hint?: string; children: ReactNode; full?: boolean }) {
  return (
    <label className={'field' + (full ? ' full' : '')}>
      <span>{label}</span>
      {children}
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

export const Chip = ({ status }: { status: string }) => <span className={'chip ' + status}>{status === 'pending' ? 'needs approval' : status}</span>;

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="card empty">
      <b>{title}</b>
      {children}
    </div>
  );
}

/** Decrypts a stored file on demand and exposes it as a temporary in-memory URL. */
export function useBlobUrl(id: string | undefined, mime: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    setUrl(null);
    if (id) {
      getBlob(id)
        .then((b) => {
          if (!alive || !b) return;
          made = URL.createObjectURL(new Blob([b], { type: mime }));
          setUrl(made);
        })
        .catch(() => {});
    }
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [id, mime]);
  return url;
}

export function Picture({ id, alt, contain }: { id?: string; alt: string; contain?: boolean }) {
  const url = useBlobUrl(id, 'image/jpeg');
  return <div className={'thumb' + (contain ? ' contain' : '')}>{url ? <img src={url} alt={alt} /> : <Icon name="box" size={30} />}</div>;
}

// ---- tiny toast ----
let pushToast: (m: string) => void = () => {};
export const toast = (m: string) => pushToast(m);
export function ToastHost() {
  const [msg, setMsg] = useState('');
  useEffect(() => {
    let timer: any;
    pushToast = (m) => {
      setMsg(m);
      clearTimeout(timer);
      timer = setTimeout(() => setMsg(''), 3200);
    };
    return () => clearTimeout(timer);
  }, []);
  return msg ? <div className="toast" role="status">{msg}</div> : null;
}

export const fmtDate = (t: number) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
export const fmtDateTime = (t: number) => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
export const fmtSize = (b = 0) => (b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB');
export const toLocalInput = (t: number) => {
  const d = new Date(t - new Date(t).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
};
