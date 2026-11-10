const VERSION = 'specs-shell-v6';
const SHELL = ['/', '/style.css', '/app.js', '/store.js', '/idb.js', '/ui.js', '/views.js', '/blocks.js', '/glossary.js', '/glossaryImport.js', '/spectypes.js', '/manifest.webmanifest', '/icon.svg'];
const OPTIONAL = ['/vendor/mermaid.min.js']; // 2.7 MB diagram library – cached best-effort so diagrams render offline

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then(async (c) => {
      await c.addAll(SHELL);
      await Promise.all(OPTIONAL.map((u) => c.add(u).catch(() => {})));
    }).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  const p = url.pathname;
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (/^\/(api|mcp|oauth|auth|authorize|token|register|revoke|healthz|\.well-known)/.test(p)) return;

  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/')));
    return;
  }
  // stale-while-revalidate for the app shell and the diagram library
  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const hit = await cache.match(req);
      const net = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }),
  );
});
