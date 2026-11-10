import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { ApiError, getItem } from './store.js';
import { members } from './auth.js';
import { getTeam } from './teams.js';
import { mailEnabled, sendMail, feedbackMail } from './mailer.js';
import { FEEDBACK_MAIL_DEBOUNCE_MS, PUBLIC_URL } from './config.js';

export const KINDS = ['concern', 'conflict', 'question', 'suggestion', 'gap'];
export const STATUSES = ['open', 'accepted', 'dismissed', 'done']; // what people can set; agents can additionally withdraw their own open entries
const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

const view = (r) => ({
  id: r.id, specId: r.spec_id, specVersion: r.spec_version, kind: r.kind, section: r.section, text: r.text, evidence: r.evidence,
  status: r.status, author: r.author, via: r.via, createdAt: r.created_at, resolvedBy: r.resolved_by, resolvedAt: r.resolved_at, reply: r.reply,
});

/** Agents (or people) leave feedback on a spec. Feedback never changes the spec: humans triage it. Duplicates of an open entry are merged. */
export function addFeedback(teamId, { specId, kind, section, text, evidence }, by) {
  const spec = getItem(teamId, specId);
  if (!spec || spec.kind !== 'spec') throw new ApiError(`No spec "${specId}".`, 404);
  text = String(text ?? '').trim();
  if (!text) throw new ApiError('Write what you found.');
  if (text.length > 4000) throw new ApiError('Keep feedback under 4000 characters.');
  if (!KINDS.includes(kind)) throw new ApiError(`kind must be one of: ${KINDS.join(', ')}`);
  section = String(section ?? '').trim().slice(0, 80);
  evidence = String(evidence ?? '').trim().slice(0, 1000);
  const dup = db.prepare("SELECT * FROM feedback WHERE team_id=? AND spec_id=? AND status='open'").all(teamId, specId)
    .find((r) => norm(r.section) === norm(section) && norm(r.text) === norm(text));
  if (dup) return { ...view(dup), duplicate: true };
  const open = db.prepare("SELECT COUNT(*) AS n FROM feedback WHERE team_id=? AND spec_id=? AND status='open'").get(teamId, specId).n;
  if (open >= 50) throw new ApiError('This spec already has 50 open feedback entries – ask a person to triage them first.', 429);
  const id = randomUUID();
  db.prepare('INSERT INTO feedback (id,team_id,spec_id,spec_version,kind,section,text,evidence,status,author,author_id,via,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, teamId, specId, spec.version || 0, kind, section, text, evidence, 'open', by?.name ?? null, by?.id ?? null, by?.via ?? null, new Date().toISOString());
  const created = view(db.prepare('SELECT * FROM feedback WHERE id=?').get(id));
  queueMail(teamId, created, by?.id);
  return created;
}

export function listFeedback(teamId, { specId, status } = {}) {
  const rows = db.prepare('SELECT * FROM feedback WHERE team_id=? ORDER BY created_at DESC').all(teamId).map(view);
  return rows.filter((f) => (!specId || f.specId === specId) && (!status || f.status === status));
}

export function setFeedback(teamId, id, { status, reply }, user) {
  const cur = db.prepare('SELECT * FROM feedback WHERE team_id=? AND id=?').get(teamId, id);
  if (!cur) throw new ApiError('Unknown feedback', 404);
  if (status !== undefined && !STATUSES.includes(status)) throw new ApiError(`status must be one of: ${STATUSES.join(', ')}`);
  const st = status ?? cur.status;
  const rp = reply === undefined ? cur.reply : String(reply ?? '').trim().slice(0, 2000);
  const closed = st !== 'open';
  db.prepare('UPDATE feedback SET status=?, reply=?, resolved_by=?, resolved_at=? WHERE id=?').run(st, rp, closed ? user.name : null, closed ? new Date().toISOString() : null, id);
  return view(db.prepare('SELECT * FROM feedback WHERE id=?').get(id));
}

export const openCounts = (teamId) => Object.fromEntries(db.prepare("SELECT spec_id, COUNT(*) AS n FROM feedback WHERE team_id=? AND status='open' GROUP BY spec_id").all(teamId).map((r) => [r.spec_id, r.n]));

/** An agent takes back its own open feedback (e.g. it was wrong). People's decisions are never overridden. */
export function withdrawFeedback(teamId, id, by) {
  const cur = db.prepare('SELECT * FROM feedback WHERE team_id=? AND id=?').get(teamId, id);
  if (!cur) throw new ApiError('Unknown feedback', 404);
  if (cur.author_id !== by?.id || (cur.via ?? null) !== (by?.via ?? null)) throw new ApiError('You can only withdraw feedback you left yourself.', 403);
  if (cur.status !== 'open') throw new ApiError(`This feedback is already ${cur.status} – a person decided about it.`, 409);
  db.prepare("UPDATE feedback SET status='withdrawn', resolved_by=?, resolved_at=? WHERE id=?").run(by.name, new Date().toISOString(), id);
  pending.get(teamId)?.items.delete(id);
  return view(db.prepare('SELECT * FROM feedback WHERE id=?').get(id));
}

// ---- e-mail digest for approvers and admins (new feedback is collected, then sent once after a quiet period)
const pending = new Map();
function queueMail(teamId, fb, authorId) {
  const team = getTeam(teamId);
  if (!mailEnabled || !team?.row.feedback_mail) return;
  const q = pending.get(teamId) ?? { items: new Map(), timer: null, authors: new Set() };
  q.items.set(fb.id, fb);
  if (authorId) q.authors.add(authorId);
  clearTimeout(q.timer);
  q.timer = setTimeout(() => flush(teamId), FEEDBACK_MAIL_DEBOUNCE_MS);
  q.timer.unref?.();
  pending.set(teamId, q);
}
async function flush(teamId) {
  const q = pending.get(teamId);
  pending.delete(teamId);
  const team = getTeam(teamId);
  if (!q || !team || !team.row.feedback_mail) return;
  const items = [...q.items.values()].filter((f) => db.prepare("SELECT status FROM feedback WHERE id=?").get(f.id)?.status === 'open');
  if (!items.length) return;
  const to = members(teamId).filter((m) => !m.disabled && ['approver', 'admin'].includes(m.role) && !(q.authors.size === 1 && q.authors.has(m.id))).map((m) => m.email);
  if (!to.length) return;
  const mail = feedbackMail({ teamName: team.name, items, link: `${PUBLIC_URL}/#/` });
  try { await sendMail({ to, ...mail }); } catch (e) { console.warn('feedback mail failed:', e.message); }
}
export const flushFeedbackMail = flush; // for tests
