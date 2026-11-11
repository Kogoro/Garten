// OpenID Connect (authorization code + PKCE) sign-in for the web app.
// Security properties: `state` is bound to the browser by a cookie (no login CSRF), the ID token is verified (signature, issuer, audience, expiry, nonce),
// the e-mail address must be confirmed by the provider, and an existing local account is only linked when that cannot hand it to someone else.
import express from 'express';
import { randomBytes, createHash, createPublicKey, verify as cryptoVerify, timingSafeEqual } from 'node:crypto';
import { OIDC, PUBLIC_URL, SECURE_COOKIES } from './config.js';
import { getUserBySub, getUserByEmail, createUser, linkOidc, startSession, setMember } from './auth.js';
import { getTeamByKey, listTeams } from './teams.js';
import { adoptInvitesForSso } from './invites.js';
import { isEmail } from './validate.js';
import { audit } from './audit.js';

const REDIRECT = `${PUBLIC_URL}/auth/oidc/callback`;
const STATE_COOKIE = SECURE_COOKIES ? '__Host-specs_oidc' : 'specs_oidc';
const states = new Map(); // state -> { verifier, nonce, next, exp }
let discovery;
let jwks;

const getJson = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${new URL(url).pathname} failed (${r.status})`);
  return r.json();
};
async function meta() {
  discovery ??= getJson(`${OIDC.issuer}/.well-known/openid-configuration`).then((m) => {
    if (String(m.issuer ?? '').replace(/\/$/, '') !== OIDC.issuer) throw new Error('the provider announces a different issuer than OIDC_ISSUER');
    return m;
  });
  try { return await discovery; } catch (e) { discovery = undefined; throw e; }
}
async function keyFor(m, kid, alg, refresh = false) {
  if (!m.jwks_uri) throw new Error('the provider publishes no signing keys (jwks_uri)');
  if (!jwks || refresh) jwks = { at: Date.now(), keys: (await getJson(m.jwks_uri)).keys ?? [] };
  const usable = jwks.keys.filter((k) => (!k.use || k.use === 'sig') && (!k.alg || k.alg === alg));
  const jwk = kid ? usable.find((k) => k.kid === kid) : usable.length === 1 ? usable[0] : undefined;
  if (!jwk && !refresh) return keyFor(m, kid, alg, true); // key rotation: read the list again once
  if (!jwk) throw new Error('signing key not found');
  return createPublicKey({ key: jwk, format: 'jwk' });
}
const b64 = (s) => Buffer.from(s, 'base64url');

/** Verifies an ID token and returns its claims. Only RS256 and ES256 are accepted (never "none" or a symmetric algorithm). */
export async function verifyIdToken(token, m, { nonce }) {
  const [h, p, sig] = String(token ?? '').split('.');
  if (!h || !p || !sig) throw new Error('malformed ID token');
  const head = JSON.parse(b64(h).toString('utf8'));
  if (!['RS256', 'ES256'].includes(head.alg)) throw new Error(`unsupported ID token algorithm ${head.alg}`);
  const key = await keyFor(m, head.kid, head.alg);
  const okSig = cryptoVerify('sha256', Buffer.from(`${h}.${p}`), head.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key, b64(sig));
  if (!okSig) throw new Error('bad ID token signature');
  const c = JSON.parse(b64(p).toString('utf8'));
  const now = Date.now() / 1000;
  if (String(c.iss ?? '').replace(/\/$/, '') !== OIDC.issuer) throw new Error('ID token issuer mismatch');
  const aud = [].concat(c.aud ?? []);
  if (!aud.includes(OIDC.clientId) || (aud.length > 1 && c.azp !== OIDC.clientId)) throw new Error('ID token audience mismatch');
  if (typeof c.exp !== 'number' || c.exp < now - 60) throw new Error('ID token expired');
  if (typeof c.iat === 'number' && c.iat > now + 300) throw new Error('ID token issued in the future');
  const a = Buffer.from(String(c.nonce ?? '')); const b = Buffer.from(nonce);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('ID token nonce mismatch');
  if (!c.sub) throw new Error('ID token has no subject');
  return c;
}

/** Only paths of this very app: parsed like a browser would (so "/\evil.example" and tab tricks do not slip through). */
export function safeNext(n) {
  if (typeof n !== 'string' || !n.startsWith('/') || /[\\\u0000-\u001f]/.test(n)) return '/';
  try {
    const base = new URL(PUBLIC_URL);
    const u = new URL(n, base);
    return u.origin === base.origin ? `${u.pathname}${u.search}${u.hash}` : '/';
  } catch { return '/'; }
}
const fail = (res, msg) => res.redirect(`/?login_error=${encodeURIComponent(msg)}`);
const readCookie = (req, name) => {
  for (const part of (req.headers.cookie ?? '').split(';')) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim(); }
  return null;
};
const confirmed = (v) => v === true || v === 'true';

export function oidcRouter() {
  const r = express.Router();

  r.get('/login', async (req, res) => {
    try {
      const m = await meta();
      const state = randomBytes(18).toString('base64url');
      const verifier = randomBytes(32).toString('base64url');
      const nonce = randomBytes(18).toString('base64url');
      states.set(state, { verifier, nonce, next: safeNext(req.query.next), exp: Date.now() + 10 * 60_000 });
      for (const [k, v] of states) if (v.exp < Date.now()) states.delete(k);
      if (states.size > 5000) states.delete(states.keys().next().value);
      res.cookie(STATE_COOKIE, state, { httpOnly: true, sameSite: 'lax', secure: SECURE_COOKIES, maxAge: 10 * 60_000, path: '/' });
      const u = new URL(m.authorization_endpoint);
      u.search = new URLSearchParams({
        response_type: 'code', client_id: OIDC.clientId, redirect_uri: REDIRECT, scope: 'openid email profile', state, nonce,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      }).toString();
      res.redirect(u.href);
    } catch (e) {
      console.error('oidc login:', e.message);
      fail(res, 'Single sign-on is currently unavailable');
    }
  });

  r.get('/callback', async (req, res) => {
    const stateParam = String(req.query.state ?? '');
    const st = states.get(stateParam);
    states.delete(stateParam);
    res.clearCookie(STATE_COOKIE, { path: '/' });
    if (!st || st.exp < Date.now()) return fail(res, 'Login expired, please try again');
    if (readCookie(req, STATE_COOKIE) !== stateParam) return fail(res, 'Login expired, please try again'); // started in another browser
    if (req.query.error) return fail(res, 'Sign-in was cancelled');
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
      const claims = await verifyIdToken(tok.id_token, m, { nonce: st.nonce });
      // profile and e-mail come from the provider's userinfo endpoint (TLS, fresh access token); it must describe the same person as the ID token
      const info = await (await fetch(m.userinfo_endpoint, { headers: { authorization: `Bearer ${tok.access_token}` }, signal: AbortSignal.timeout(10_000) })).json();
      if (!info.sub || !info.email) throw new Error('provider returned no sub/email');
      if (info.sub !== claims.sub) throw new Error('userinfo and ID token describe different subjects');
      const email = String(info.email).trim().toLowerCase();
      if (!isEmail(email)) throw new Error('provider returned an invalid e-mail address');
      if (!confirmed(info.email_verified) && !OIDC.trustUnverifiedEmail) return fail(res, 'Your e-mail address is not verified at the identity provider');

      let user = getUserBySub(info.sub);
      if (!user) {
        const existing = getUserByEmail(email);
        if (existing) {
          // Never hand an existing account to whoever controls an address at the provider: accounts with a password, instance admins
          // and accounts already tied to another identity stay as they are.
          if (existing.sso || existing.hasPassword || existing.admin) {
            audit(req, 'auth.sso.link.refused', { target: email, actor: existing });
            return fail(res, 'An account with this e-mail address already exists and is not linked to single sign-on. Sign in with your password.');
          }
          linkOidc(existing.id, info.sub); user = existing;
          audit(req, 'auth.sso.link', { target: email, actor: existing });
        }
        else if ((user = await adoptInvitesForSso({ email, name: info.name, oidcSub: info.sub }))) { /* invited: account created, invitations accepted */ }
        else if (OIDC.autoCreate) {
          user = await createUser({ email, name: info.name, oidcSub: info.sub });
          const team = getTeamByKey(OIDC.defaultTeam) ?? listTeams()[0];
          if (team) setMember(team.id, user.id, OIDC.defaultRole);
        }
        else return fail(res, `No account for ${email}. Ask an admin to invite you.`);
      }
      if (user.disabled) return fail(res, 'This account is disabled');
      startSession(res, user, req.get('user-agent'));
      audit(req, 'auth.login.sso', { actor: user });
      res.redirect(st.next);
    } catch (e) {
      console.error('oidc callback:', e.message);
      fail(res, 'Sign-in failed');
    }
  });
  return r;
}
