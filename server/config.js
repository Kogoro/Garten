import { mkdirSync } from 'node:fs';
import path from 'node:path';

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
export const TRUST_PROXY = flag('TRUST_PROXY', false);

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
/** Refuse to send unless the connection is upgraded to TLS (recommended for anything but a local relay). */
export const SMTP_REQUIRE_TLS = flag('SMTP_REQUIRE_TLS', false);

/** Online definition lookup for the glossary (Wikipedia, Wiktionary, dictionaryapi.dev). LOOKUP=0 switches it off. */
export const LOOKUP_ENABLED = env('LOOKUP', '1') !== '0';
