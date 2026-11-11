// OpenID Connect (authorization code + PKCE) sign-in for the web app.
import express from 'express';
import { randomBytes, createHash } from 'node:crypto';
import { OIDC, PUBLIC_URL } from './config.js';
import { getUserBySub, getUserByEmail, createUser, linkOidc, startSession, setMember } from './auth.js';
import { getTeamByKey, listTeams } from './teams.js';
import { adoptInvitesForSso } from './invites.js';

const REDIRECT = `${PUBLIC_URL}/auth/oidc/callback`;
const states = new Map(); // state -> { verifier, next, exp }
let discovery;

async function meta() {
  discovery ??= fetch(`${OIDC.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) }).then((r) => {
    if (!r.ok) throw new Error(`OIDC discovery failed (${r.status})`);
    return r.json();
  });
  try { return await discovery; } catch (e) { discovery = undefined; throw e; }
}
const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/');
const fail = (res, msg) => res.redirect(`/?login_error=${encodeURIComponent(msg)}`);

export function oidcRouter() {
  const r = express.Router();

  r.get('/login', async (req, res) => {
    try {
      const m = await meta();
      const state = randomBytes(18).toString('base64url');
      const verifier = randomBytes(32).toString('base64url');
      states.set(state, { verifier, next: safeNext(req.query.next), exp: Date.now() + 10 * 60_000 });
      for (const [k, v] of states) if (v.exp < Date.now()) states.delete(k);
      const u = new URL(m.authorization_endpoint);
      u.search = new URLSearchParams({
        response_type: 'code', client_id: OIDC.clientId, redirect_uri: REDIRECT, scope: 'openid email profile', state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      }).toString();
      res.redirect(u.href);
    } catch (e) {
      console.error('oidc login:', e.message);
      fail(res, 'Single sign-on is currently unavailable');
    }
  });

  r.get('/callback', async (req, res) => {
    const st = states.get(String(req.query.state));
    states.delete(String(req.query.state));
    if (!st || st.exp < Date.now()) return fail(res, 'Login expired, please try again');
    if (req.query.error) return fail(res, `Sign-in was cancelled (${req.query.error})`);
    try {
      const m = await meta();
      const tokenRes = await fetch(m.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
        body: new URLSearchParams({
          grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: REDIRECT,
          client_id: OIDC.clientId, ...(OIDC.clientSecret ? { client_secret: OIDC.clientSecret } : {}), code_verifier: st.verifier,
        }),
      });
      const tok = await tokenRes.json();
      if (!tokenRes.ok || !tok.access_token) throw new Error(`token exchange failed: ${tok.error ?? tokenRes.status}`);
      // identity comes from the provider's userinfo endpoint (called over TLS with the fresh access token)
      const info = await (await fetch(m.userinfo_endpoint, { headers: { authorization: `Bearer ${tok.access_token}` }, signal: AbortSignal.timeout(10_000) })).json();
      if (!info.sub || !info.email) throw new Error('provider returned no sub/email');
      if (info.email_verified === false) return fail(res, 'Your e-mail address is not verified at the identity provider');

      let user = getUserBySub(info.sub);
      if (!user) {
        const existing = getUserByEmail(String(info.email).toLowerCase());
        if (existing) { linkOidc(existing.id, info.sub); user = existing; }
        else if ((user = await adoptInvitesForSso({ email: info.email, name: info.name, oidcSub: info.sub }))) { /* invited: account created, invitations accepted */ }
        else if (OIDC.autoCreate) {
          user = await createUser({ email: info.email, name: info.name, oidcSub: info.sub });
          const team = getTeamByKey(OIDC.defaultTeam) ?? listTeams()[0];
          if (team) setMember(team.id, user.id, OIDC.defaultRole);
        }
        else return fail(res, `No account for ${info.email}. Ask an admin to invite you.`);
      }
      if (user.disabled) return fail(res, 'This account is disabled');
      startSession(res, user, req.get('user-agent'));
      res.redirect(st.next);
    } catch (e) {
      console.error('oidc callback:', e.message);
      fail(res, 'Sign-in failed');
    }
  });
  return r;
}
