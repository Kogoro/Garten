import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { db } from './db.js';
import { ADMIN_EMAIL, ADMIN_PASSWORD, SECURE_COOKIES, DEFAULT_TEAM_NAME, DEFAULT_TEAM_KEY } from './config.js';
import { getTeam, getTeamByKey, listTeams, createTeam } from './teams.js';

const scryptAsync = promisify(scrypt);
export const sha = (s) => createHash('sha256').update(s).digest('hex');
const now = () => Math.floor(Date.now() / 1000);
const iso = () => new Date().toISOString();

// ------------------------------------------------------------------ roles & rights
// Roles are per team. `admin` (team admin) manages members and the Git connection of that team.
// Instance admins (users.admin) manage users and teams and count as team admin everywhere.
export const ROLE_PERMS = {
  viewer: ['read'],
  editor: ['read', 'write', 'drafts'],
  approver: ['read', 'write', 'drafts', 'approve'],
  admin: ['read', 'write', 'drafts', 'approve', 'admin'],
};
export const ROLES = Object.keys(ROLE_PERMS);
export const perms = (role) => ROLE_PERMS[role] ?? [];

export const MCP_SCOPES = ['mcp:read', 'mcp:drafts', 'mcp:write'];
/** MCP scopes a role may hold: released specs for everyone, drafts only with the `drafts` right. */
export const allowedScopes = (role) => MCP_SCOPES.filter((s) => (s === 'mcp:drafts' ? perms(role).includes('drafts') : s === 'mcp:write' ? perms(role).includes('write') : true));

export function roleIn(user, teamId) {
  if (!user || !getTeam(teamId)) return null;
  if (user.admin) return 'admin';
  return db.prepare('SELECT role FROM memberships WHERE team_id=? AND user_id=?').get(teamId, user.id)?.role ?? null;
}
export const can = (user, teamId, perm) => perms(roleIn(user, teamId)).includes(perm);
export function teamsFor(user) {
  const mine = user.admin
    ? listTeams().map((t) => ({ team: t, role: 'admin' }))
    : db.prepare('SELECT team_id, role FROM memberships WHERE user_id=?').all(user.id).map((m) => ({ team: getTeam(m.team_id), role: m.role }));
  return mine.filter((m) => m.team).sort((a, b) => a.team.name.localeCompare(b.team.name));
}
export const meSummary = (u) => ({
  id: u.id, name: u.name, email: u.email, admin: u.admin,
  teams: teamsFor(u).map(({ team, role }) => ({ id: team.id, key: team.key, name: team.name, role, foundationAuto: !!team.row.foundation_auto, perms: perms(role), mcpScopes: allowedScopes(role) })),
});

export function members(teamId) {
  return db.prepare('SELECT m.role, u.id, u.email, u.name, u.disabled FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.team_id=? ORDER BY u.name').all(teamId)
    .map((r) => ({ id: r.id, email: r.email, name: r.name, role: r.role, disabled: !!r.disabled }));
}
export function setMember(teamId, userId, role) {
  if (!ROLES.includes(role)) throw new AuthError('Unknown role');
  if (!getUser(userId)) throw new AuthError('Unknown user', 404);
  db.prepare('INSERT INTO memberships (team_id,user_id,role) VALUES (?,?,?) ON CONFLICT(team_id,user_id) DO UPDATE SET role=excluded.role').run(teamId, userId, role);
}
export function removeMember(teamId, userId) {
  const cur = db.prepare('SELECT role FROM memberships WHERE team_id=? AND user_id=?').get(teamId, userId);
  if (cur?.role === 'admin' && db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE team_id=? AND role='admin'").get(teamId).n <= 1)
    throw new AuthError('A team needs at least one team admin (promote someone else first)');
  db.prepare('DELETE FROM memberships WHERE team_id=? AND user_id=?').run(teamId, userId);
  // tokens of this user for this team stop working immediately
  db.prepare('UPDATE pats SET revoked=1 WHERE team_id=? AND user_id=?').run(teamId, userId);
  db.prepare('UPDATE oauth_tokens SET revoked=1 WHERE team_id=? AND user_id=?').run(teamId, userId);
}

// ------------------------------------------------------------------ passwords
export async function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = await scryptAsync(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(pw, stored) {
  const [alg, salt, hash] = String(stored ?? '').split('$');
  if (alg !== 'scrypt') return false;
  const key = await scryptAsync(pw, Buffer.from(salt, 'base64'), 64);
  const want = Buffer.from(hash, 'base64');
  return key.length === want.length && timingSafeEqual(key, want);
}

// ------------------------------------------------------------------ users
const toUser = (r) =>
  r && {
    id: r.id, email: r.email, name: r.name, admin: !!r.admin, disabled: !!r.disabled,
    hasPassword: !!r.password_hash, sso: !!r.oidc_sub, createdAt: r.created_at, lastLoginAt: r.last_login_at,
  };
export const getUser = (id) => toUser(db.prepare('SELECT * FROM users WHERE id=?').get(id));
export const getUserByEmail = (email) => toUser(db.prepare('SELECT * FROM users WHERE email=?').get(email));
export const getUserBySub = (sub) => toUser(db.prepare('SELECT * FROM users WHERE oidc_sub=?').get(sub));
export const listUsers = () => db.prepare('SELECT * FROM users ORDER BY created_at').all().map(toUser);
export const countUsers = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
const activeAdmins = () => db.prepare('SELECT COUNT(*) AS n FROM users WHERE admin=1 AND disabled=0').get().n;

export class AuthError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export async function createUser({ email, name, admin = false, password, oidcSub }) {
  email = String(email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new AuthError('Enter a valid e-mail address');
  if (password !== undefined && String(password).length < 8) throw new AuthError('Password must have at least 8 characters');
  if (getUserByEmail(email)) throw new AuthError('A user with this e-mail already exists', 409);
  const id = randomUUID();
  db.prepare('INSERT INTO users (id,email,name,admin,password_hash,oidc_sub,created_at) VALUES (?,?,?,?,?,?,?)').run(
    id, email, (name || email.split('@')[0]).trim(), admin ? 1 : 0, password ? await hashPassword(password) : null, oidcSub ?? null, iso(),
  );
  return getUser(id);
}

export async function updateUser(id, patch, actor) {
  const u = getUser(id);
  if (!u) throw new AuthError('Unknown user', 404);
  const next = { admin: patch.admin ?? u.admin, disabled: patch.disabled ?? u.disabled, name: patch.name ?? u.name };
  const losesAdmin = u.admin && !u.disabled && (!next.admin || next.disabled);
  if (losesAdmin && activeAdmins() <= 1) throw new AuthError('There must be at least one active instance admin');
  if (actor?.id === id && next.disabled) throw new AuthError('You cannot disable yourself');
  db.prepare('UPDATE users SET admin=?, disabled=?, name=? WHERE id=?').run(next.admin ? 1 : 0, next.disabled ? 1 : 0, next.name, id);
  if (patch.password !== undefined) await setPassword(id, patch.password);
  if (next.disabled) revokeAllForUser(id);
  return getUser(id);
}

/** Teams in which this user is the only team admin (deleting them would orphan the team). */
export const soleAdminTeams = (userId) =>
  db.prepare("SELECT t.name FROM memberships m JOIN teams t ON t.id=m.team_id WHERE m.user_id=? AND m.role='admin' AND (SELECT COUNT(*) FROM memberships x WHERE x.team_id=m.team_id AND x.role='admin')=1").all(userId).map((r) => r.name);

export function deleteUser(id, actor) {
  const u = getUser(id);
  if (!u) throw new AuthError('Unknown user', 404);
  if (actor?.id === id) throw new AuthError('You cannot delete yourself');
  if (u.admin && !u.disabled && activeAdmins() <= 1) throw new AuthError('There must be at least one active instance admin');
  const sole = soleAdminTeams(id);
  if (sole.length) throw new AuthError(`Only team admin of: ${sole.join(', ')}. Promote someone else or delete the team first.`, 409);
  db.prepare('DELETE FROM users WHERE id=?').run(id); // memberships, sessions, tokens, OAuth grants cascade / are removed below
  db.prepare('DELETE FROM pats WHERE user_id=?').run(id);
  db.prepare('DELETE FROM oauth_tokens WHERE user_id=?').run(id);
  db.prepare('DELETE FROM oauth_codes WHERE user_id=?').run(id);
}

export async function setPassword(id, password) {
  if (String(password ?? '').length < 8) throw new AuthError('Password must have at least 8 characters');
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await hashPassword(password), id);
}

export function linkOidc(id, sub) { db.prepare('UPDATE users SET oidc_sub=? WHERE id=?').run(sub, id); }

/** Immediately kill every credential of a user (sessions, PATs, OAuth tokens). */
export function revokeAllForUser(id) {
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  db.prepare('UPDATE pats SET revoked=1 WHERE user_id=?').run(id);
  db.prepare('UPDATE oauth_tokens SET revoked=1 WHERE user_id=?').run(id);
}

// simple in-memory throttle against password guessing
const attempts = new Map();
function throttle(key) {
  const t = Date.now();
  const list = (attempts.get(key) ?? []).filter((x) => t - x < 5 * 60_000);
  if (list.length >= 10) throw new AuthError('Too many attempts, try again in a few minutes', 429);
  list.push(t);
  attempts.set(key, list);
}

export async function loginWithPassword(email, password, ip = '') {
  email = String(email ?? '').trim().toLowerCase();
  throttle(`${ip}|${email}`);
  const row = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  const okPw = row?.password_hash ? await verifyPassword(String(password ?? ''), row.password_hash) : (await hashPassword('x'), false);
  if (!row || !okPw || row.disabled) throw new AuthError('Wrong e-mail or password', 401);
  return toUser(row);
}

// ------------------------------------------------------------------ sessions
const COOKIE = 'specs_sid';
const SESSION_DAYS = 30;

export function startSession(res, user, userAgent = '') {
  const raw = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (id,user_id,expires_at,created_at,user_agent) VALUES (?,?,?,?,?)').run(
    sha(raw), user.id, now() + SESSION_DAYS * 86400, iso(), userAgent.slice(0, 200),
  );
  db.prepare('UPDATE users SET last_login_at=? WHERE id=?').run(iso(), user.id);
  res.cookie(COOKIE, raw, { httpOnly: true, sameSite: 'lax', secure: SECURE_COOKIES, maxAge: SESSION_DAYS * 86400_000, path: '/' });
}
export function endSession(req, res) {
  const raw = cookie(req, COOKIE);
  if (raw) db.prepare('DELETE FROM sessions WHERE id=?').run(sha(raw));
  res.clearCookie(COOKIE, { path: '/' });
}
function cookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
export function userFromRequest(req) {
  const raw = cookie(req, COOKIE);
  if (!raw) return null;
  const row = db.prepare('SELECT user_id, expires_at FROM sessions WHERE id=?').get(sha(raw));
  if (!row || row.expires_at < now()) return null;
  const u = getUser(row.user_id);
  return u && !u.disabled ? u : null;
}

/** Express middleware: cookie session + CSRF guard (custom header on mutating requests). */
export function requireUser(req, res, next) {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  if (!['GET', 'HEAD'].includes(req.method) && req.get('x-specs') !== '1') return res.status(403).json({ error: 'missing x-specs header' });
  req.user = user;
  next();
}
export const requireInstanceAdmin = (req, res, next) => (req.user.admin ? next() : res.status(403).json({ error: 'requires an instance admin' }));
/** Resolves :tid to a team the user belongs to; optionally requires a right inside that team. */
export const requireTeam = (perm) => (req, res, next) => {
  const role = roleIn(req.user, req.params.tid);
  if (!role) return res.status(404).json({ error: 'unknown team' });
  if (perm && !perms(role).includes(perm)) return res.status(403).json({ error: `requires the "${perm}" right in this team (your role: ${role})` });
  req.team = getTeam(req.params.tid);
  req.role = role;
  next();
};

// ------------------------------------------------------------------ personal access tokens (MCP)
export function createPat(user, { name, scopes, days = 90, teamId }) {
  name = String(name ?? '').trim().slice(0, 60);
  if (!name) throw new AuthError('Give the token a name');
  const role = roleIn(user, teamId);
  if (!role) throw new AuthError('Choose a team you belong to', 403);
  scopes = scopes?.length ? scopes : ['mcp:read'];
  const allowed = allowedScopes(role);
  if (!scopes.every((s) => allowed.includes(s))) throw new AuthError(`Your role in this team (${role}) may not hold scope: ${scopes.filter((s) => !allowed.includes(s)).join(', ')}`, 403);
  const raw = `spc_${randomBytes(24).toString('base64url')}`;
  const id = randomUUID();
  const expires = now() + Math.min(Math.max(Number(days) || 90, 1), 3650) * 86400;
  db.prepare('INSERT INTO pats (id,user_id,team_id,name,prefix,hash,scopes,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)').run(
    id, user.id, teamId, name, raw.slice(0, 10), sha(raw), scopes.join(' '), iso(), expires,
  );
  return { token: raw, pat: listPats(user.id).find((p) => p.id === id) };
}
const toPat = (r) => ({
  id: r.id, userId: r.user_id, teamId: r.team_id, teamName: getTeam(r.team_id)?.name ?? '?', name: r.name, prefix: r.prefix, scopes: r.scopes.split(' '), createdAt: r.created_at,
  lastUsedAt: r.last_used_at, expiresAt: r.expires_at * 1000, expired: r.expires_at < now(),
});
export const listPats = (userId) => db.prepare('SELECT * FROM pats WHERE user_id=? AND revoked=0 ORDER BY created_at DESC').all(userId).map(toPat);
export function revokePat(userId, id) { return db.prepare('UPDATE pats SET revoked=1 WHERE id=? AND user_id=?').run(id, userId).changes > 0; }
export function verifyPat(raw) {
  const r = db.prepare('SELECT * FROM pats WHERE hash=? AND revoked=0').get(sha(raw));
  if (!r || r.expires_at < now()) return null;
  const user = getUser(r.user_id);
  if (!user || user.disabled) return null;
  db.prepare('UPDATE pats SET last_used_at=? WHERE id=?').run(iso(), r.id);
  // the token acts with the user's *current* role in its team: downgrades apply immediately, removal kills the token
  const role = roleIn(user, r.team_id);
  if (!role) return null;
  const allowed = allowedScopes(role);
  return { user, teamId: r.team_id, role, scopes: r.scopes.split(' ').filter((s) => allowed.includes(s)), expiresAt: r.expires_at, id: r.id, name: r.name };
}

// ------------------------------------------------------------------ bootstrap
export async function bootstrapAdmin() {
  if (countUsers() === 0) {
    const password = ADMIN_PASSWORD || randomBytes(12).toString('base64url');
    const admin = await createUser({ email: ADMIN_EMAIL, name: 'Admin', admin: true, password });
    console.log('Created first admin account:');
    console.log(`  e-mail:   ${ADMIN_EMAIL}`);
    console.log(`  password: ${password}${ADMIN_PASSWORD ? '  (from ADMIN_PASSWORD)' : '  (generated – change it under Account)'}`);
    void admin;
  }
  let team = getTeamByKey(DEFAULT_TEAM_KEY) ?? listTeams()[0];
  if (!team) { team = createTeam({ name: DEFAULT_TEAM_NAME, key: DEFAULT_TEAM_KEY }); console.log(`Created team "${team.name}" (${team.key})`); }
  return team;
}
