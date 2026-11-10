// OIDC sign-in against an in-process mock identity provider (auth code + PKCE).
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { startServer, Client, freePort } from './helpers.mjs';

// ---- mock IdP
const idpPort = await freePort();
const ISSUER = `http://localhost:${idpPort}`;
let nextIdentity = { sub: 'u-1', email: 'sso@example.com', name: 'Sso Person', email_verified: true };
const codes = new Map();
const tokens = new Map();
const idp = http.createServer((req, res) => {
  const u = new URL(req.url, ISSUER);
  const json = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/.well-known/openid-configuration') return json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, userinfo_endpoint: `${ISSUER}/userinfo` });
  if (u.pathname === '/authorize') {
    const code = randomUUID();
    codes.set(code, { challenge: u.searchParams.get('code_challenge'), id: nextIdentity, redirect: u.searchParams.get('redirect_uri') });
    const back = new URL(u.searchParams.get('redirect_uri'));
    back.searchParams.set('code', code); back.searchParams.set('state', u.searchParams.get('state'));
    res.writeHead(302, { location: back.href }); return res.end();
  }
  if (u.pathname === '/token') {
    let body = ''; req.on('data', (d) => (body += d)); req.on('end', () => {
      const p = new URLSearchParams(body); const c = codes.get(p.get('code')); codes.delete(p.get('code'));
      if (!c || createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url') !== c.challenge) return json({ error: 'invalid_grant' }, 400);
      if (p.get('client_secret') !== 'idp-secret') return json({ error: 'invalid_client' }, 401);
      const at = randomUUID(); tokens.set(at, c.id); json({ access_token: at, token_type: 'Bearer' });
    }); return;
  }
  if (u.pathname === '/userinfo') { const id = tokens.get((req.headers.authorization ?? '').slice(7)); return id ? json(id) : json({ error: 'invalid_token' }, 401); }
  res.writeHead(404); res.end();
});
await new Promise((r) => idp.listen(idpPort, r));

let n = 0; const ok = (m) => console.log(`ok ${++n} - ${m}`);
const oidcEnv = { OIDC_ISSUER: ISSUER, OIDC_CLIENT_ID: 'specs', OIDC_CLIENT_SECRET: 'idp-secret', OIDC_NAME: 'Mock SSO' };

async function ssoLogin(base, next = '/') {
  const c = new Client(base);
  let r = await fetch(`${base}/auth/oidc/login?next=${encodeURIComponent(next)}`, { redirect: 'manual' });
  assert.equal(r.status, 302); // -> idp
  r = await fetch(r.headers.get('location'), { redirect: 'manual' }); // idp -> callback
  r = await fetch(r.headers.get('location'), { redirect: 'manual' }); // callback -> app
  const set = r.headers.getSetCookie?.()[0];
  if (set) c.cookie = set.split(';')[0];
  return { c, location: r.headers.get('location') };
}

let srv = await startServer(oidcEnv);
try {
  const cfg = await (await fetch(`${srv.base}/api/auth/config`)).json();
  assert.equal(cfg.oidc.name, 'Mock SSO'); ok('app advertises the SSO provider');

  let { c, location } = await ssoLogin(srv.base);
  assert.match(location, /login_error=.*No%20account|login_error=No/); assert.equal((await c.get('/api/me')).status, 401); ok('unknown identity is refused (no auto-create)');

  const admin = new Client(srv.base); await admin.login('admin@localhost', 'adminpass1');
  assert.equal((await admin.post('/api/users', { email: 'SSO@example.com', name: 'Invited', teamId: admin.tid, role: 'editor' })).status, 200); ok('admin invites a user by e-mail (no password)');
  ({ c, location } = await ssoLogin(srv.base, '/oauth/consent?request=abc'));
  assert.equal(location, '/oauth/consent?request=abc'); ok('invited user signs in via SSO and is redirected to `next`');
  const me = (await c.get('/api/me')).data.me;
  assert.equal(me.teams[0].role, 'editor'); assert.equal(me.email, 'sso@example.com'); ok('SSO session carries the role assigned in the team');
  ({ location } = await ssoLogin(srv.base, 'https://evil.example/'));
  assert.equal(location, '/'); ok('open redirect via next= is blocked');

  nextIdentity = { sub: 'u-2', email: 'unverified@example.com', email_verified: false };
  ({ location } = await ssoLogin(srv.base));
  assert.match(location, /not%20verified/); ok('unverified e-mail is refused');

  assert.equal((await new Client(srv.base).post('/api/auth/login', { email: 'sso@example.com', password: 'anything-123' })).status, 401); ok('SSO-only account has no usable password');

  // without SMTP_URL nothing is sent: admins get the link, the test mail is refused, invitations are rate limited
  const noMail = await admin.post(`/api/teams/${admin.tid}/invites`, { email: 'nomail@example.com', role: 'viewer' });
  assert.equal(noMail.data.mailEnabled, false); assert.equal(noMail.data.emailed, false); assert.ok(noMail.data.link); ok('without a mail server the invitation link is returned for copying');
  assert.equal((await admin.post('/api/admin/mail/test')).status, 400); ok('test e-mail is refused when no mail server is configured');
  const bulkTeam = (await admin.post('/api/teams', { name: 'Bulk' })).data.team;
  let limited = 0; for (let i = 0; i < 32; i++) { const r = await admin.post(`/api/teams/${bulkTeam.id}/invites`, { email: `bulk${i}@example.com`, role: 'viewer' }); if (r.status === 429) limited++; }
  assert.ok(limited >= 1); ok('invitations are rate limited per team');

  // someone invited by a team admin who has no account yet is created on first SSO login and joins the team
  assert.equal((await admin.post(`/api/teams/${admin.tid}/invites`, { email: 'invited-sso@example.com', role: 'approver' })).status, 200);
  nextIdentity = { sub: 'u-9', email: 'invited-sso@example.com', name: 'Invited Sso', email_verified: true };
  ({ c } = await ssoLogin(srv.base));
  const inviteMe = (await c.get('/api/me')).data.me;
  assert.equal(inviteMe.teams[0].role, 'approver'); assert.equal(inviteMe.invites.length, 0); ok('SSO login accepts a pending invitation and creates the account');
} finally { srv.stop(); }

nextIdentity = { sub: 'u-3', email: 'newbie@example.com', name: 'Newbie', email_verified: true };
srv = await startServer({ ...oidcEnv, OIDC_AUTO_CREATE: '1', OIDC_DEFAULT_ROLE: 'viewer' });
try {
  const { c } = await ssoLogin(srv.base);
  assert.equal((await c.get('/api/me')).data.me.teams[0].role, 'viewer'); ok('auto-create provisions new users into the default team with the default role');
  console.log(`\n${n} checks passed`);
} finally { srv.stop(); idp.close(); }
