import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import './styles.css';
import App from './App';
import { ErrorBoundary } from './ErrorBoundary';
import * as S from './store/core';
import { applyTheme } from './ui';
import { applyDensity } from './prefs';

applyTheme();
applyDensity();
if ('serviceWorker' in navigator) {
  // A new version takes over by itself (skipWaiting + clientsClaim). The open page still runs the old code, whose lazy chunks may be
  // gone – so reload once the new worker is in charge, but never while edits are still waiting on this device.
  const hadController = !!navigator.serviceWorker.controller;
  let updated = false;
  const reloadWhenSafe = () => {
    if (!updated) return;
    if (S.queue().length + S.fbPending() === 0 && !S.state.syncing) location.reload();
    else setTimeout(reloadWhenSafe, 15_000);
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) { updated = true; reloadWhenSafe(); } });
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    // a long-lived installed app never navigates, so ask for a new version when it comes back to the foreground
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
  }).catch(() => {});
}
S.init().finally(() => {
  createRoot(document.getElementById('root')!).render(<StrictMode><ErrorBoundary><HashRouter><App /></HashRouter></ErrorBoundary></StrictMode>);
});
