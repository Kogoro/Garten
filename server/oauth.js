// OAuth 2.1 authorization server for MCP clients (dynamic client registration + PKCE + refresh tokens).
// The SDK's mcpAuthRouter provides /register, /authorize, /token, /revoke and the metadata documents;
// this module supplies the storage/provider and the browser consent screen.
import express from 'express';
import { randomBytes } from 'node:crypto';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { db } from './db.js';
import { PUBLIC_URL, OIDC } from './config.js';
import {
  sha, allowedScopes, getUser, userFromRequest, loginWithPassword, startSession, verifyPat, AuthError, MCP_SCOPES, roleIn, teamsFor,
} from './auth.js';
import { getTeam } from './teams.js';
import { audit } from './audit.js';

const now = () => Math.floor(Date.now() / 1000);
const iso = () => new Date().toISOString();
const rand = (p) => `${p}_${randomBytes(32).toString('base64url')}`;
const ACCESS_TTL = 3600;
const REFRESH_TTL = 30 * 86400;

export const clientsStore = {
  getClient(id) {
    const r = db.prepare('SELECT data FROM oauth_clients WHERE client_id=?').get(id);
    return r ? JSON.parse(r.data) : undefined;
  },
  registerClient(client) {
    client.client_id ??= crypto.randomUUID();
    client.client_id_issued_at ??= now();
    db.prepare('INSERT INTO oauth_clients (client_id,data,created_at) VALUES (?,?,?)').run(client.client_id, JSON.stringify(client), iso());
    return client;
  },
};

export const provider = {
  clientsStore,

  async authorize(client, params, res) {
    const id = randomBytes(18).toString('base64url');
    db.prepare('INSERT INTO oauth_requests (id,client_id,data,expires_at) VALUES (?,?,?,?)').run(
      id, client.client_id,
      JSON.stringify({ state: params.state, scopes: params.scopes ?? [], codeChallenge: params.codeChallenge, redirectUri: params.redirectUri, resource: params.resource?.href }),
      now() + 600,
    );
    res.redirect(`/oauth/consent?request=${id}`);
  },

  async challengeForAuthorizationCode(_client, code) {
    const r = db.prepare('SELECT challenge, expires_at FROM oauth_codes WHERE hash=?').get(sha(code));
    if (!r || r.expires_at < now()) throw new InvalidGrantError('Invalid or expired authorization code');
    return r.challenge;
  },

  async exchangeAuthorizationCode(client, code, _verifier, redirectUri) {
    const r = db.prepare('SELECT * FROM oauth_codes WHERE hash=?').get(sha(code));
    db.prepare('DELETE FROM oauth_codes WHERE hash=?').run(sha(code)); // single use
    if (!r || r.expires_at < now() || r.client_id !== client.client_id) throw new InvalidGrantError('Invalid or expired authorization code');
    if (redirectUri && redirectUri !== r.redirect_uri) throw new InvalidGrantError('redirect_uri mismatch');
    return issue({ clientId: client.client_id, userId: r.user_id, teamId: r.team_id, scopes: r.scopes.split(' '), resource: r.resource });
  },

  async exchangeRefreshToken(client, refreshToken, scopes) {
    const h = sha(refreshToken);
    const r = db.prepare('SELECT * FROM oauth_tokens WHERE refresh_hash=? AND revoked=0').get(h);
    if (!r) {
      // A refresh token that was already exchanged is shown again: it was copied. The whole grant ends, the thief and the owner must sign in again.
      const reused = db.prepare('SELECT id, user_id, team_id FROM oauth_tokens WHERE prev_refresh_hash=? AND client_id=?').get(h, client.client_id);
      if (reused) { db.prepare('UPDATE oauth_tokens SET revoked=1 WHERE id=?').run(reused.id); audit(null, 'oauth.refresh.reuse', { team: reused.team_id, target: reused.user_id }); }
      throw new InvalidGrantError('Invalid refresh token');
    }
    if (r.client_id !== client.client_id || r.refresh_expires_at < now()) throw new InvalidGrantError('Invalid refresh token');
    const user = getUser(r.user_id);
    const role = user && !user.disabled ? roleIn(user, r.team_id) : null;
    if (!role) throw new InvalidGrantError('User is disabled or no longer in this team');
    let granted = r.scopes.split(' ').filter((s) => allowedScopes(role).includes(s));
    if (scopes?.length) {
      if (!scopes.every((s) => granted.includes(s))) throw new InvalidGrantError('Cannot widen scopes on refresh');
      granted = scopes;
    }
    const access = rand('spo');
    const refresh = rand('spr');
    db.prepare('UPDATE oauth_tokens SET access_hash=?, refresh_hash=?, prev_refresh_hash=?, scopes=?, expires_at=?, refresh_expires_at=?, last_used_at=? WHERE id=?')
      .run(sha(access), sha(refresh), h, granted.join(' '), now() + ACCESS_TTL, now() + REFRESH_TTL, iso(), r.id); // rotate in place
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: granted.join(' ') };
  },

  async verifyAccessToken(token) {
    if (token.startsWith('spc_')) {
      const p = verifyPat(token);
      if (!p) throw new InvalidTokenError('Invalid or expired token');
      return { token, clientId: 'personal-token', scopes: p.scopes, expiresAt: p.expiresAt, extra: { userId: p.user.id, teamId: p.teamId, via: 'pat', label: p.name } };
    }
    const r = db.prepare('SELECT * FROM oauth_tokens WHERE access_hash=? AND revoked=0').get(sha(token));
    if (!r || r.expires_at < now()) throw new InvalidTokenError('Invalid or expired token');
    const user = getUser(r.user_id);
    const role = user && !user.disabled ? roleIn(user, r.team_id) : null;
    if (!role) throw new InvalidTokenError('User is disabled or no longer in this team');
    db.prepare('UPDATE oauth_tokens SET last_used_at=? WHERE id=?').run(iso(), r.id);
    const allowed = allowedScopes(role);
    return { token, clientId: r.client_id, scopes: r.scopes.split(' ').filter((s) => allowed.includes(s)), expiresAt: r.expires_at, extra: { userId: r.user_id, teamId: r.team_id, via: 'oauth', label: clientsStore.getClient(r.client_id)?.client_name ?? 'OAuth client' } };
  },

  async revokeToken(client, { token }) {
    const h = sha(token);
    db.prepare('UPDATE oauth_tokens SET revoked=1 WHERE (access_hash=? OR refresh_hash=?) AND client_id=?').run(h, h, client.client_id);
  },
};

function issue({ clientId, userId, teamId, scopes, resource, reuseId, createdAt }) {
  const access = rand('spo');
  const refresh = rand('spr');
  db.prepare(
    `INSERT INTO oauth_tokens (id,access_hash,refresh_hash,client_id,user_id,team_id,scopes,resource,expires_at,refresh_expires_at,created_at,last_used_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(reuseId ?? crypto.randomUUID(), sha(access), sha(refresh), clientId, userId, teamId, scopes.join(' '), resource ?? null, now() + ACCESS_TTL, now() + REFRESH_TTL, createdAt ?? iso(), iso());
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: scopes.join(' ') };
}

// ------------------------------------------------------------------ connections shown in the UI
export function listConnections(userId) {
  return db
    .prepare('SELECT * FROM oauth_tokens WHERE user_id=? AND revoked=0 AND refresh_expires_at>? ORDER BY created_at DESC')
    .all(userId, now())
    .map((r) => ({
      id: r.id, clientName: clientsStore.getClient(r.client_id)?.client_name ?? r.client_id, scopes: r.scopes.split(' '),
      teamId: r.team_id, teamName: getTeam(r.team_id)?.name ?? '?',
      createdAt: r.created_at, lastUsedAt: r.last_used_at,
    }));
}
export function revokeConnection(userId, id) {
  return db.prepare('UPDATE oauth_tokens SET revoked=1 WHERE id=? AND user_id=?').run(id, userId).changes > 0;
}

// ------------------------------------------------------------------ consent screen (server-rendered)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root{color-scheme:dark}body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#0F1214;color:#E8ECEF;font:15px/1.5 Inter,ui-sans-serif,system-ui,sans-serif;padding:20px}
.c{width:100%;max-width:420px;background:#171B1F;border:1px solid #262C32;border-radius:16px;padding:24px;display:flex;flex-direction:column;gap:14px}
h1{margin:0;font:600 22px "Space Grotesk",system-ui,sans-serif}p{margin:0;color:#9AA4AE;font-size:14px}.m{font-family:ui-monospace,monospace;font-size:13px;color:#C3CBD3;word-break:break-all}
input[type=email],input[type=password]{height:48px;padding:0 14px;border:1px solid #262C32;border-radius:12px;background:#0F1214;color:inherit;font:inherit}
.b{height:48px;border-radius:12px;border:1px solid #3A424A;background:none;color:inherit;font-weight:600;font-size:15px;cursor:pointer;display:flex;align-items:center;justify-content:center;text-decoration:none}
.p{background:#5FD4A0;color:#0F1214;border:0}.row{display:flex;gap:8px}.row .b{flex:1}label.s{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid #262C32;border-radius:12px}
.e{color:#FF9B8A;font-size:13px}b{color:#E8ECEF}
@media (prefers-color-scheme:light){:root{color-scheme:light}body{background:#F4F5F7;color:#14181C}.c{background:#fff;border-color:#E1E5EA}p,.m{color:#58636F}b{color:#14181C}.p{background:#0B7A52;color:#fff}input[type=email],input[type=password],select{background:#fff!important;border-color:#C5CCD4!important;color:#14181C!important}label.s{border-color:#E1E5EA}.e{color:#B3261E}.b{border-color:#C5CCD4}}
</style></head><body><div class="c">${body}</div></body></html>`;

const loadRequest = (id) => {
  const r = db.prepare('SELECT * FROM oauth_requests WHERE id=?').get(String(id ?? ''));
  return r && r.expires_at >= now() ? { id: r.id, clientId: r.client_id, ...JSON.parse(r.data) } : null;
};
/** The form posts come from our own pages: Origin must be this server's public origin; without Origin the browser's Fetch-Metadata must say so. */
const sameOrigin = (req) => {
  const o = req.get('origin');
  if (o) { try { return new URL(o).origin === new URL(PUBLIC_URL).origin; } catch { return false; } }
  const site = req.get('sec-fetch-site');
  return !site || site === 'same-origin' || site === 'none';
};

export function consentRouter() {
  const r = express.Router();
  r.use(express.urlencoded({ extended: false }));
  r.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('X-Frame-Options', 'DENY'); next(); });

  r.get('/consent', (req, res) => {
    const reqd = loadRequest(req.query.request);
    if (!reqd) return res.status(400).send(page('Expired', '<h1>Request expired</h1><p>Go back to your agent and start the connection again.</p>'));
    const client = clientsStore.getClient(reqd.clientId);
    const user = userFromRequest(req);
    const clientName = esc(client?.client_name ?? 'An application');
    if (!user) {
      const next = encodeURIComponent(`/oauth/consent?request=${reqd.id}`);
      return res.send(page('Sign in', `<h1>Sign in to Specs</h1><p><b>${clientName}</b> wants to access your specifications. Sign in to continue.</p>
        ${req.query.error ? `<span class="e">${esc(req.query.error)}</span>` : ''}
        <form method="post" action="/oauth/login" style="display:contents"><input type="hidden" name="request" value="${esc(reqd.id)}">
        <input type="email" name="email" placeholder="E-mail" autocomplete="username" required><input type="password" name="password" placeholder="Password" autocomplete="current-password" required>
        <button class="b p">Sign in</button></form>
        ${OIDC ? `<a class="b" href="/auth/oidc/login?next=${next}">${esc(OIDC.name)}</a>` : ''}`));
    }
    const teams = teamsFor(user);
    if (!teams.length) return res.send(page('No team', `<h1>No team yet</h1><p>You are not a member of any team, so there is nothing to connect. Ask an admin to add you, then try again.</p>`));
    const wanted = (reqd.scopes.length ? reqd.scopes : ['mcp:read']).filter((s) => MCP_SCOPES.includes(s));
    const label = { 'mcp:read': 'Read released (approved) specifications and documents', 'mcp:drafts': 'Also read drafts and unreleased changes (needs the editor role or higher in that team)', 'mcp:write': 'Create and edit DRAFTS for you. It can never approve or publish – you review and approve in the app (needs the editor role or higher)' };
    res.send(page('Authorize', `<h1>Allow access?</h1>
      <p><b>${clientName}</b> wants to connect to Specs as <b>${esc(user.name)}</b>. It gets the same rights you have in the team you choose.</p>
      <form method="post" action="/oauth/consent" style="display:contents"><input type="hidden" name="request" value="${esc(reqd.id)}">
      <label for="team" class="m">Team</label>
      <select id="team" name="team" style="height:48px;border-radius:12px;background:#0F1214;color:inherit;border:1px solid #262C32;padding:0 10px;font:inherit">${teams.map(({ team, role }) => `<option value="${esc(team.id)}">${esc(team.name)} (${esc(role)})</option>`).join('')}</select>
      ${wanted.map((s) => `<label class="s"><input type="checkbox" name="scope" value="${s}" ${s === 'mcp:read' ? 'checked disabled' : s === 'mcp:write' ? '' : 'checked'}><span>${esc(label[s])}<br><span class="m">${s}</span></span></label>`).join('')}
      <p class="m">Redirects to ${esc(new URL(reqd.redirectUri).origin)}</p>
      <div class="row"><button class="b" name="decision" value="deny">Deny</button><button class="b p" name="decision" value="allow">Allow</button></div></form>`));
  });

  r.post('/login', async (req, res) => {
    const reqd = loadRequest(req.body.request);
    if (!reqd || !sameOrigin(req)) return res.status(400).send('Bad request');
    try {
      const user = await loginWithPassword(req.body.email, req.body.password, req.ip);
      startSession(res, user, req.get('user-agent'));
      audit(req, 'auth.login', { actor: user, detail: { via: 'oauth-consent' } });
      res.redirect(`/oauth/consent?request=${reqd.id}`);
    } catch (e) {
      if (!(e instanceof AuthError)) throw e;
      audit(req, 'auth.login.failed', { target: String(req.body.email ?? '').slice(0, 254).toLowerCase(), detail: { via: 'oauth-consent' } });
      res.redirect(`/oauth/consent?request=${reqd.id}&error=${encodeURIComponent(e.message)}`);
    }
  });

  r.post('/consent', (req, res) => {
    const reqd = loadRequest(req.body.request);
    const user = userFromRequest(req);
    if (!reqd || !user || !sameOrigin(req)) return res.status(400).send('Bad request');
    db.prepare('DELETE FROM oauth_requests WHERE id=?').run(reqd.id); // one decision per request
    const target = new URL(reqd.redirectUri);
    if (reqd.state) target.searchParams.set('state', reqd.state);
    if (req.body.decision !== 'allow') {
      target.searchParams.set('error', 'access_denied');
      audit(req, 'oauth.consent.deny', { target: reqd.clientId, actor: user });
      return res.redirect(target.href);
    }
    const role = roleIn(user, String(req.body.team ?? ''));
    if (!role) return res.status(400).send('Choose a team you belong to');
    const allowed = allowedScopes(role);
    const picked = [].concat(req.body.scope ?? []);
    const wanted = (reqd.scopes.length ? reqd.scopes : ['mcp:read']).filter((s) => MCP_SCOPES.includes(s));
    let scopes = ['mcp:read', ...picked].filter((s, i, a) => a.indexOf(s) === i && wanted.includes(s) && allowed.includes(s));
    if (scopes.includes('mcp:write') && !scopes.includes('mcp:drafts') && allowed.includes('mcp:drafts')) scopes = [...scopes, 'mcp:drafts']; // writing implies reading drafts
    const code = rand('spa');
    db.prepare('INSERT INTO oauth_codes (hash,client_id,user_id,team_id,challenge,redirect_uri,scopes,resource,expires_at) VALUES (?,?,?,?,?,?,?,?,?)').run(
      sha(code), reqd.clientId, user.id, String(req.body.team), reqd.codeChallenge, reqd.redirectUri, scopes.join(' '), reqd.resource ?? null, now() + 300,
    );
    target.searchParams.set('code', code);
    audit(req, 'oauth.consent.allow', { team: String(req.body.team), target: clientsStore.getClient(reqd.clientId)?.client_name ?? reqd.clientId, detail: { scopes }, actor: user });
    res.redirect(target.href);
  });
  return r;
}
