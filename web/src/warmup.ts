// Offline-first without a heavy install: the service worker precaches only what it takes to open and edit specs. The rest of
// the build – Mermaid and its diagram engines, listed in /warmup.json by the build – is fetched here in the background once
// the page is up, one file at a time, through the service worker, whose runtime cache ("assets-on-demand") keeps it. After
// that every kind of diagram renders offline. Runs again on every start and when the device comes back online; files that are
// already cached cost nothing.
const CACHE = 'assets-on-demand';
let running = false;

async function run() {
  if (running || !navigator.onLine || !navigator.serviceWorker?.controller || !('caches' in window)) return;
  running = true;
  try {
    const res = await fetch('/warmup.json', { cache: 'no-cache' });
    if (!res.ok) return;
    const urls: unknown = await res.json();
    if (!Array.isArray(urls)) return;
    const cache = await caches.open(CACHE);
    for (const url of urls) {
      if (typeof url !== 'string' || !url.startsWith('/assets/') || (await cache.match(url))) continue;
      if (!navigator.onLine) return;
      const r = await fetch(url); // answered by the service worker, which stores it
      await r.arrayBuffer();
    }
  } catch { /* offline or interrupted: the next start tries again */ } finally { running = false; }
}

/** Start the background download once the page is idle and the service worker controls it. */
export function warmUp() {
  const idle: (fn: () => void) => void = 'requestIdleCallback' in window ? (fn) => requestIdleCallback(fn, { timeout: 10_000 }) : (fn) => setTimeout(fn, 3000);
  const start = () => idle(() => void run());
  if (navigator.serviceWorker.controller) start();
  navigator.serviceWorker.addEventListener('controllerchange', start); // first visit: the worker takes over a moment later
  window.addEventListener('online', start);
}
