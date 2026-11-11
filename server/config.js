import { mkdirSync } from 'node:fs';
import path from 'node:path';

// Files created by the server (database, repositories, key file) are private to the service user.
process.umask(0o077);

const env = (k, d = '') => (process.env[k] ?? d) || d;
const flag = (k, d = false) => (process.env[k] === undefined || process.env[k] === '' ? d : !['0', 'false', 'no'].includes(process.env[k].toLowerCase()));

export const PORT = Number(env('PORT', '3000'));
/** Address to listen on. Empty = all interfaces; 127.0.0.1 when a reverse proxy on the same machine is the only way in. */
export const HOST = env('HOST');
export const DATA_DIR = path.resolve(env('DATA_DIR', './data'));
export const PROJECT_NAME = env('PROJECT_NAME', 'specs');
export const SEED_DEMO = flag('SEED_DEMO', false);
/** Externally visible base URL – used for OAuth issuer / redirect URLs. Must be https unless localhost. */
export const PUBLIC_URL = env('PUBLIC_URL', `http://localhost:${PORT}`).replace(/\/$/, '');
export const SECURE_COOKIES = PUBLIC_URL.startsWith('https://');
/**
 * Proxies in front of the server whose X-Forwarded-For is believed. "1"/"true" = exactly one hop (Caddy, a tunnel, a single reverse proxy);
 * a number = that many hops; anything else is passed to Express (e.g. "loopback" or a CIDR list). Never "trust everything".
 */
function parseTrustProxy(v) {
  const x = String(v ?? '').trim();
  if (!x || ['0', 'false', 'no'].includes(x.toLowerCase())) return false;
  if (['1', 'true', 'yes'].includes(x.toLowerCase())) return 1;
  if (/^\d+$/.test(x)) return Number(x);
  return x;
}
export const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY);
/** Sessions that were not used for this many days end (in addition to the absolute 30 days). */
export const SESSION_IDLE_DAYS = Number(env('SESSION_IDLE_DAYS', '14'));
/** How long the audit log is kept. */
export const AUDIT_RETENTION_DAYS = Number(env('AUDIT_RETENTION_DAYS', '180'));

export const ADMIN_EMAIL = env('ADMIN_EMAIL', 'admin@localhost');
export const ADMIN_PASSWORD = env('ADMIN_PASSWORD'); // generated on first start when empty

// Optional OpenID Connect login (Keycloak, Authentik, Google, Microsoft Entra, ...)
export const OIDC = process.env.OIDC_ISSUER
  ? {
      issuer: env('OIDC_ISSUER').replace(/\/$/, ''),
      clientId: env('OIDC_CLIENT_ID'),
      clientSecret: env('OIDC_CLIENT_SECRET'),
      name: env('OIDC_NAME', 'Single sign-on'),
      autoCreate: flag('OIDC_AUTO_CREATE', false),
      defaultRole: env('OIDC_DEFAULT_ROLE', 'viewer'),
      defaultTeam: env('OIDC_DEFAULT_TEAM').toUpperCase(),
      /** Accept identities whose e-mail address the provider does not confirm (email_verified missing or false). Off by default. */
      trustUnverifiedEmail: flag('OIDC_TRUST_UNVERIFIED_EMAIL', false),
    }
  : null;

mkdirSync(DATA_DIR, { recursive: true });

// ---- teams / git
export const DEFAULT_TEAM_NAME = env('DEFAULT_TEAM_NAME', PROJECT_NAME);
export const DEFAULT_TEAM_KEY = env('DEFAULT_TEAM_KEY', 'SPEC').toUpperCase();
/** Allow plain http:// git remotes (e.g. a Gitea in your LAN). Off by default. */
export const GIT_ALLOW_HTTP = flag('GIT_ALLOW_HTTP', false);
/** Allow local filesystem remotes. Development/tests only – never enable on a shared server. */
export const GIT_ALLOW_LOCAL = flag('GIT_ALLOW_LOCAL', false);
/** Allow git remotes on loopback, private and link-local addresses (a Gitea in your LAN). Off by default: otherwise a team admin can probe the internal network. */
export const GIT_ALLOW_PRIVATE = flag('GIT_ALLOW_PRIVATE', false);
export const SECRET_KEY = env('SECRET_KEY'); // 32 bytes hex/base64; generated into the data dir when empty

// ---- v0.4: teams for everyone, invitations, foundation documents
/** Any signed-in user may create teams (they become its team admin). Set to 0 to restrict this to instance admins. */
export const ALLOW_TEAM_CREATION = flag('ALLOW_TEAM_CREATION', true);
export const MAX_TEAMS_PER_USER = Number(env('MAX_TEAMS_PER_USER', '5'));
export const INVITE_TTL_DAYS = Number(env('INVITE_TTL_DAYS', '7'));
/** Foundation documents (vision, strategy, glossary …) go live this long after the last edit when auto-release is on. */
export const FEEDBACK_MAIL_DEBOUNCE_MS = Number(env('FEEDBACK_MAIL_DEBOUNCE_MS', '120000')); // new feedback is mailed to approvers/admins as one digest after this quiet period
/** Releases and answered decisions are collected for this long, then sent to the team's webhook in one call. */
export const HOOK_DEBOUNCE_MS = Number(env('HOOK_DEBOUNCE_MS', '5000'));
/** Allow webhooks to plain http:// and private addresses (tests, an agent runner in your LAN). Off by default. */
export const HOOK_ALLOW_LOCAL = flag('HOOK_ALLOW_LOCAL', false);
export const FOUNDATION_DEBOUNCE_MS = Number(env('FOUNDATION_DEBOUNCE_MS', '15000'));

// ---- e-mail (invitations). Without SMTP_URL nothing is sent and admins copy the invitation link instead.
/** e.g. smtp://user:pass@mail.example.com:587  or  smtps://user:pass@mail.example.com:465 */
export const SMTP_URL = env('SMTP_URL');
export const SMTP_FROM = env('SMTP_FROM', 'Specs <no-reply@localhost>');
/** Refuse to send unless the connection is upgraded to TLS. Default: on for every mail server except one on this machine. */
const smtpLocal = (() => { try { return /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/.test(new URL(SMTP_URL).hostname); } catch { return true; } })();
export const SMTP_REQUIRE_TLS = flag('SMTP_REQUIRE_TLS', !smtpLocal);

/** Online definition lookup for the glossary (Wikipedia, Wiktionary, dictionaryapi.dev). LOOKUP=0 switches it off. */
export const LOOKUP_ENABLED = env('LOOKUP', '1') !== '0';
