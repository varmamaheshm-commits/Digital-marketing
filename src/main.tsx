import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { init } from './core/store';
import './styles.css';

void init();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Offline support when installed from a web address (not needed inside the desktop / Android app).
if ('serviceWorker' in navigator && location.protocol === 'https:' && !(window as any).Capacitor?.isNativePlatform?.()) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
