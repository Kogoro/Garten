import express from 'express';
import compression from 'compression';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { db } from './db.js';
import { PORT, HOST, DATA_DIR, SEED_DEMO, PUBLIC_URL, TRUST_PROXY, OIDC, SECURE_COOKIES } from './config.js';
import { startJanitor } from './janitor.js';
import { ipLimit } from './ratelimit.js';
import { apiRouter } from './api.js';
import { mcpHandler } from './mcp.js';
import { provider, consentRouter } from './oauth.js';
import { oidcRouter } from './oidc.js';
import { bootstrapAdmin } from './auth.js';
import * as store from './store.js';
import { initAutoPush, catchUpPushes } from './gitremote.js';
import { initHooks, resumeHooks } from './hooks.js';
import { listTeams } from './teams.js';
import { seedDemo } from './seed.js';

const defaultTeam = await bootstrapAdmin();
store.ensureFoundation(defaultTeam);
initAutoPush();
initHooks();
if (SEED_DEMO && store.allSpecs(defaultTeam.id).length === 0 && store.allDocs(defaultTeam.id).every((d) => store.isCoreDoc(d.id) && !store.hasContentDoc(d))) {
  await seedDemo(defaultTeam);
  console.log('seeded demo data');
}
await store.startupSweep();
startJanitor();
resumeHooks();
catchUpPushes(listTeams()).catch((e) => console.error('catch-up:', e.message));

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY);
// Security headers. The CSP allows only this origin's scripts (no inline script, no eval); styles may be inline (Mermaid, the editor).
// /oauth has no form-action: its consent form ends in a redirect to the agent's own callback address.
const CSP_BASE = ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: https:", "font-src 'self' data:", "connect-src 'self'",
  "worker-src 'self' blob:", "manifest-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"];
const CSP_APP = [...CSP_BASE, "form-action 'self'"].join('; ');
const CSP_OAUTH = CSP_BASE.join('; ');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  res.set('X-Frame-Options', 'DENY');
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.set('Content-Security-Policy', req.path.startsWith('/oauth') ? CSP_OAUTH : CSP_APP);
  if (SECURE_COOKIES) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});
app.use(compression({ threshold: 1024, filter: (req, res) => (req.path === '/mcp' ? false : compression.filter(req, res)) }));
app.get('/healthz', (_req, res) => {
  try { db.prepare('SELECT 1').get(); res.json({ ok: true }); } catch (e) { console.error('healthz:', e); res.status(503).json({ ok: false }); }
});

// ---- web app API + browser sign-in
app.use('/api', apiRouter());
app.use('/oauth', consentRouter());
if (OIDC) app.use('/auth/oidc', ipLimit({ windowMs: 60_000, max: 60 }), oidcRouter());

// ---- MCP: OAuth 2.1 authorization server (DCR + PKCE) and the protected /mcp resource
const mcpUrl = new URL(`${PUBLIC_URL}/mcp`);
app.use(
  mcpAuthRouter({
    provider,
    issuerUrl: new URL(PUBLIC_URL),
    resourceServerUrl: mcpUrl,
    scopesSupported: ['mcp:read', 'mcp:drafts', 'mcp:write'],
    resourceName: 'Specs',
  }),
);
const mcpAuth = requireBearerAuth({
  verifier: provider,
  requiredScopes: ['mcp:read'],
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
});
app.post('/mcp', mcpAuth, express.json({ limit: '1mb' }), (req, res, next) => mcpHandler(req, res).catch(next));
app.all('/mcp', (_req, res) =>
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server: use POST)' }, id: null }),
);

// ---- static app: the React build (web/dist, or WEB_DIR)
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDir = [process.env.WEB_DIR, path.join(root, 'web/dist')].filter(Boolean).find((d) => existsSync(path.join(d, 'index.html')));
if (!webDir) console.warn('No web build found – run "npm run build" (web/dist) or set WEB_DIR.');
else app.use(
  express.static(webDir, {
    setHeaders: (res, file) => {
      if (/(^|\/)(sw\.js|index\.html|workbox-[^/]*\.js|manifest\.webmanifest|theme-init\.js)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
      else if (/\/assets\//.test(file)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // file names carry a content hash
      else res.setHeader('Cache-Control', 'public, max-age=86400');
    },
  }),
);

app.use((err, _req, res, _next) => {
  const status = Number(err?.status ?? err?.statusCode);
  if (status >= 400 && status < 500) {          // body-parser: malformed JSON (400), body too large (413) …
    return res.status(status).json({ error: status === 413 ? 'request too large' : status === 400 ? 'bad request' : 'rejected' });
  }
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

const server = app.listen(PORT, ...(HOST ? [HOST] : []), () => {
  console.log(`specs listening on ${HOST || ''}:${PORT}  (data: ${DATA_DIR}, public url: ${PUBLIC_URL}${OIDC ? ', sso: ' + OIDC.name : ''})`);
});

// docker stop / systemctl stop: finish running requests, then leave the database in a clean state.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`${sig}: shutting down`);
    setTimeout(() => process.exit(1), 8000).unref();
    server.close(() => { try { db.close(); } catch { /* already closed */ } process.exit(0); });
    server.closeIdleConnections?.();
  });
}
