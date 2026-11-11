import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { encrypt } from './secrets.js';
import { GIT_ALLOW_HTTP, GIT_ALLOW_LOCAL, GIT_ALLOW_PRIVATE } from './config.js';
import { gitHost, isPrivateHostLiteral } from './netguard.js';

export class TeamError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const iso = () => new Date().toISOString();
const toTeam = (r) => r && { id: r.id, key: r.key, name: r.name, createdAt: r.created_at, row: r };
export const getTeam = (id) => toTeam(db.prepare('SELECT * FROM teams WHERE id=?').get(id));
export const getTeamByKey = (key) => toTeam(db.prepare('SELECT * FROM teams WHERE key=?').get(String(key ?? '')));
export const listTeams = () => db.prepare('SELECT * FROM teams ORDER BY name').all().map(toTeam);

/** Derives a short unique key (spec id prefix) from a team name: "Payments Platform" -> PAYM, PAYM2 … */
function deriveKey(name) {
  const base = (name.toUpperCase().replace(/[^A-Z0-9 ]/g, '').split(/\s+/).filter(Boolean).map((w, _, a) => (a.length > 1 ? w.slice(0, 3) : w.slice(0, 4))).join('').replace(/^[0-9]+/, '') || 'TEAM').slice(0, 6).padEnd(2, 'X');
  let key = base;
  for (let i = 2; getTeamByKey(key); i++) key = `${base.slice(0, 7 - String(i).length)}${i}`;
  return key;
}

export function createTeam({ name, key, createdBy = null }) {
  name = String(name ?? '').trim().slice(0, 80);
  if (!name) throw new TeamError('Give the team a name');
  key = String(key ?? '').trim().toUpperCase();
  if (!key) key = deriveKey(name);
  if (!/^[A-Z][A-Z0-9]{1,7}$/.test(key)) throw new TeamError('Team key: 2–8 letters/digits, starting with a letter (e.g. BILL)');
  if (getTeamByKey(key)) throw new TeamError('A team with this key already exists', 409);
  const id = randomUUID();
  db.prepare('INSERT INTO teams (id,key,name,created_at,created_by) VALUES (?,?,?,?,?)').run(id, key, name, iso(), createdBy);
  return getTeam(id);
}
export const teamsCreatedBy = (userId) => db.prepare('SELECT COUNT(*) AS n FROM teams WHERE created_by=?').get(userId).n;
export function renameTeam(id, name) {
  name = String(name ?? '').trim().slice(0, 80);
  if (!name) throw new TeamError('Give the team a name');
  db.prepare('UPDATE teams SET name=? WHERE id=?').run(name, id);
  return getTeam(id);
}
export function setFoundationAuto(id, on) {
  db.prepare('UPDATE teams SET foundation_auto=? WHERE id=?').run(on ? 1 : 0, id);
  return getTeam(id);
}
export function setFeedbackMail(id, on) {
  db.prepare('UPDATE teams SET feedback_mail=? WHERE id=?').run(on ? 1 : 0, id);
  return getTeam(id);
}
/** Removes a team and everything that belongs to it (the Git repository directory is removed by the caller). */
export function deleteTeamRows(id) {
  for (const t of ['items', 'feedback', 'reports', 'pats', 'oauth_tokens', 'oauth_codes', 'hook_outbox']) db.prepare(`DELETE FROM ${t} WHERE team_id=?`).run(id);
  db.prepare('DELETE FROM teams WHERE id=?').run(id); // memberships + invites cascade
}

// ------------------------------------------------------------------ git connection (settings only; see gitremote.js for I/O)
const BRANCH = /^(?!.*\.\.)(?!-)[A-Za-z0-9._/-]{1,100}$/;
const ROOT = /^(?!.*\.\.)[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*){0,3}$/;

/** Only transports we deliberately support; no leading dashes (option injection), no ext::/file:// tricks. */
export function validateGitUrl(url) {
  url = String(url ?? '').trim();
  if (!url) return '';
  if (/[\s\0]/.test(url) || url.startsWith('-')) throw new TeamError('Invalid repository URL');
  // The server must not be turned into a scanner of its own network: loopback, private and link-local targets are refused
  // (names are resolved again right before every connection, see gitremote.js).
  const publicHost = () => { if (!GIT_ALLOW_PRIVATE && isPrivateHostLiteral(gitHost(url))) throw new TeamError('This address points into a private or local network (set GIT_ALLOW_PRIVATE=1 on the server to allow that)'); return url; };
  if (/^https:\/\/[^/]+\/.+/.test(url)) return publicHost();
  if (/^http:\/\/[^/]+\/.+/.test(url)) { if (GIT_ALLOW_HTTP) return publicHost(); throw new TeamError('Plain http:// remotes are disabled (set GIT_ALLOW_HTTP=1 on the server to allow them)'); }
  if (/^ssh:\/\/[\w.-]+@[\w.-]+(:\d+)?\/.+/.test(url) || /^[\w.-]+@[\w.-]+:[^\s:][^\s]*$/.test(url)) return publicHost();
  if (url.startsWith('/') && GIT_ALLOW_LOCAL) return url;
  throw new TeamError('Use an https:// or SSH (git@host:org/repo.git) repository URL');
}

/** scheme://host:port of a remote – what a stored credential is bound to. */
export function remoteOrigin(url) {
  const u = String(url ?? '').trim();
  try { if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) { const x = new URL(u); return `${x.protocol}//${x.hostname.toLowerCase()}:${x.port || ''}`; } } catch { /* fall through */ }
  const m = /^[\w.-]+@([\w.-]+):/.exec(u);
  return m ? `ssh://${m[1].toLowerCase()}:` : u;
}

export const publicGit = (t) => {
  const r = t.row;
  return {
    url: r.git_url ?? '', branch: r.git_branch, root: r.git_root, auth: r.git_auth, username: r.git_username ?? '',
    hasSecret: !!r.git_secret, sshPublicKey: r.git_ssh_public ?? '', autoPush: !!r.git_auto_push,
    lastPushAt: r.git_last_push_at, lastOk: r.git_last_ok === null ? null : !!r.git_last_ok, lastError: r.git_last_error, lastSha: r.git_last_sha,
  };
};

export function saveGitSettings(teamId, s, { rootLocked }) {
  const t = getTeam(teamId);
  const url = validateGitUrl(s.url);
  const branch = String(s.branch ?? t.row.git_branch).trim();
  const root = String(s.root ?? t.row.git_root).trim().replace(/^\/+|\/+$/g, '');
  const auth = ['none', 'token', 'ssh'].includes(s.auth) ? s.auth : t.row.git_auth;
  if (!BRANCH.test(branch)) throw new TeamError('Invalid branch name');
  if (!ROOT.test(root)) throw new TeamError('Invalid folder (letters, digits, . _ - and / only)');
  if (root !== t.row.git_root && rootLocked) throw new TeamError('The folder cannot be changed after the first release', 409);
  if (auth === 'ssh' && url.startsWith('https://')) throw new TeamError('SSH authentication needs an SSH URL (git@host:org/repo.git)');
  if (auth === 'token' && !/^https?:\/\//.test(url) && url) throw new TeamError('Token authentication needs an https:// URL');
  let secret = t.row.git_secret;
  if (auth === 'token' && s.token) secret = encrypt(s.token);
  // A stored token belongs to the server it was entered for: it is not sent to another one.
  else if (auth === 'token' && url && t.row.git_url && remoteOrigin(url) !== remoteOrigin(t.row.git_url)) secret = null;
  if (auth === 'none') secret = null;
  if (auth === 'ssh' && t.row.git_auth !== 'ssh') secret = null; // a token must never be reused as key
  if (auth === 'token' && t.row.git_auth === 'ssh' && !s.token) secret = null;
  db.prepare(
    'UPDATE teams SET git_url=?, git_branch=?, git_root=?, git_auth=?, git_username=?, git_secret=?, git_auto_push=? WHERE id=?',
  ).run(url || null, branch, root, auth, String(s.username ?? '').trim() || null, secret, s.autoPush === false ? 0 : 1, teamId);
  return getTeam(teamId);
}
export function saveSshKey(teamId, privateKey, publicKey) {
  db.prepare("UPDATE teams SET git_secret=?, git_ssh_public=?, git_auth='ssh' WHERE id=?").run(encrypt(privateKey), publicKey, teamId);
}
export function recordPush(teamId, { ok, error, sha }) {
  db.prepare('UPDATE teams SET git_last_push_at=?, git_last_ok=?, git_last_error=?, git_last_sha=COALESCE(?, git_last_sha) WHERE id=?').run(iso(), ok ? 1 : 0, error ?? null, sha ?? null, teamId);
}
