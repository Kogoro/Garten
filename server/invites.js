// Team invitations: a team admin invites an e-mail address with a role. The invitee either follows the one-time link
// (new accounts are created there) or sees the invitation after signing in (existing accounts) and accepts it.
import { randomBytes, randomUUID } from 'node:crypto';
import { db } from './db.js';
import { INVITE_TTL_DAYS, PUBLIC_URL } from './config.js';
import { sha, ROLES, setMember, getUserByEmail, createUser, AuthError, getUser } from './auth.js';
import { getTeam } from './teams.js';

const now = () => Math.floor(Date.now() / 1000);
const toInvite = (r) => r && {
  id: r.id, teamId: r.team_id, teamName: getTeam(r.team_id)?.name ?? '?', email: r.email, role: r.role,
  invitedBy: r.invited_by, createdAt: r.created_at, expiresAt: r.expires_at * 1000,
};
const pending = 'accepted_at IS NULL AND expires_at > ?';

export const listInvites = (teamId) => db.prepare(`SELECT * FROM invites WHERE team_id=? AND ${pending} ORDER BY created_at DESC`).all(teamId, now()).map(toInvite);
export const invitesForEmail = (email) => db.prepare(`SELECT * FROM invites WHERE email=? AND ${pending} ORDER BY created_at DESC`).all(email, now()).map(toInvite);
export const getInvite = (id) => toInvite(db.prepare('SELECT * FROM invites WHERE id=?').get(id));

export function createInvite({ team, email, role = 'viewer', by }) {
  email = String(email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new AuthError('Enter a valid e-mail address');
  if (!ROLES.includes(role)) throw new AuthError('Unknown role');
  const existing = getUserByEmail(email);
  if (existing && db.prepare('SELECT 1 FROM memberships WHERE team_id=? AND user_id=?').get(team.id, existing.id)) throw new AuthError('This person is already a member of the team', 409);
  db.prepare('DELETE FROM invites WHERE team_id=? AND email=? AND accepted_at IS NULL').run(team.id, email); // a new invitation replaces an older one
  const token = `inv_${randomBytes(24).toString('base64url')}`;
  const id = randomUUID();
  db.prepare('INSERT INTO invites (id,team_id,email,role,token_hash,invited_by,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, team.id, email, role, sha(token), by?.name ?? null, new Date().toISOString(), now() + INVITE_TTL_DAYS * 86400);
  return { invite: getInvite(id), token, link: `${PUBLIC_URL}/#/invite/${token}`, userExists: !!existing };
}
export const revokeInvite = (teamId, id) => db.prepare('DELETE FROM invites WHERE id=? AND team_id=?').run(id, teamId).changes > 0;

/** Public lookup for the invitation page. */
export function inviteByToken(token) {
  const r = db.prepare(`SELECT * FROM invites WHERE token_hash=? AND ${pending}`).get(sha(String(token ?? '')), now());
  if (!r) return null;
  const inv = toInvite(r);
  return { ...inv, userExists: !!getUserByEmail(inv.email), teamKey: getTeam(inv.teamId)?.key };
}

function accept(inviteId, userId) {
  const r = db.prepare(`SELECT * FROM invites WHERE id=? AND ${pending}`).get(inviteId, now());
  if (!r) throw new AuthError('This invitation is no longer valid', 410);
  setMember(r.team_id, userId, r.role);
  db.prepare('UPDATE invites SET accepted_at=? WHERE id=?').run(new Date().toISOString(), r.id);
  return r.team_id;
}

/** New person with an invitation link: creates the account (the link proves control of the e-mail address). */
export async function registerFromInvite(token, { name, password }) {
  const inv = inviteByToken(token);
  if (!inv) throw new AuthError('This invitation is no longer valid', 410);
  if (inv.userExists) throw new AuthError('This e-mail already has an account – sign in to accept the invitation', 409);
  const user = await createUser({ email: inv.email, name, password });
  const teamId = accept(inv.id, user.id);
  return { user, teamId };
}

/** Existing, signed-in user accepts (by link or from the list of pending invitations). */
export function acceptForUser(user, { token, inviteId }) {
  const inv = token ? inviteByToken(token) : invitesForEmail(user.email).find((i) => i.id === inviteId);
  if (!inv || inv.email.toLowerCase() !== user.email.toLowerCase()) throw new AuthError('This invitation is not for your account', 403);
  return accept(inv.id, user.id);
}
export function declineForUser(user, inviteId) {
  return db.prepare('DELETE FROM invites WHERE id=? AND email=? AND accepted_at IS NULL').run(inviteId, user.email).changes > 0;
}

/** SSO sign-in of someone who was invited but has no account yet. */
export async function adoptInvitesForSso({ email, name, oidcSub }) {
  const list = invitesForEmail(String(email).toLowerCase());
  if (!list.length) return null;
  const user = await createUser({ email, name, oidcSub });
  for (const i of list) accept(i.id, user.id);
  return user;
}
export { getUser };
