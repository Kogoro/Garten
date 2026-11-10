import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { PORT, DATA_DIR, SEED_DEMO, PUBLIC_URL, TRUST_PROXY, OIDC } from './config.js';
import { apiRouter } from './api.js';
import { mcpHandler } from './mcp.js';
import { provider, consentRouter } from './oauth.js';
import { oidcRouter } from './oidc.js';
import { bootstrapAdmin } from './auth.js';
import * as store from './store.js';
import { initAutoPush } from './gitremote.js';
import { seedDemo } from './seed.js';

const defaultTeam = await bootstrapAdmin();
store.ensureFoundation(defaultTeam);
initAutoPush();
if (SEED_DEMO && store.allSpecs(defaultTeam.id).length === 0 && store.allDocs(defaultTeam.id).every((d) => store.isCoreDoc(d.id) && !store.hasContentDoc(d))) {
  await seedDemo(defaultTeam);
  console.log('seeded demo data');
}
await store.startupSweep();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY);
app.use((_req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  next();
});
app.get('/healthz', (_req, res) => res.json({ ok: true }));

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
      if (/(^|\/)(sw\.js|index\.html|workbox-[^/]*\.js)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
    },
  }),
);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

app.listen(PORT, () => {
  console.log(`specs listening on :${PORT}  (data: ${DATA_DIR}, public url: ${PUBLIC_URL}${OIDC ? ', sso: ' + OIDC.name : ''})`);
});
