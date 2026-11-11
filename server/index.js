import express from 'express';
import compression from 'compression';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { db } from './db.js';
import { PORT, HOST, DATA_DIR, SEED_DEMO, PUBLIC_URL, TRUST_PROXY, OIDC } from './config.js';
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
resumeHooks();
catchUpPushes(listTeams()).catch((e) => console.error('catch-up:', e.message));

// The web app: only its own scripts (no inline script), its own data connections, no plug-ins. Styles may be inline (React style props, Mermaid).
const APP_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY);
app.use((_req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  // pages of this server cannot be framed or re-targeted; the web app gets the full policy below
  res.set('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'");
  next();
});
app.use(compression({ threshold: 1024, filter: (req, res) => (req.path === '/mcp' ? false : compression.filter(req, res)) }));
app.get('/healthz', (_req, res) => {
  try { db.prepare('SELECT 1').get(); res.json({ ok: true }); } catch (e) { console.error('healthz:', e); res.status(503).json({ ok: false }); }
});

// ---- web app API + browser sign-in
app.use('/api', apiRouter());
app.use('/oauth', consentRouter());
if (OIDC) app.use('/auth/oidc', oidcRouter());

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
      if (/\.html$/.test(file)) res.setHeader('Content-Security-Policy', APP_CSP);
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
