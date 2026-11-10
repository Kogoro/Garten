import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { ApiError, getItem } from './store.js';

export const KINDS = ['concern', 'conflict', 'question', 'suggestion', 'gap'];
export const STATUSES = ['open', 'accepted', 'dismissed', 'done'];
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
  db.prepare('INSERT INTO feedback (id,team_id,spec_id,spec_version,kind,section,text,evidence,status,author,via,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, teamId, specId, spec.version || 0, kind, section, text, evidence, 'open', by?.name ?? null, by?.via ?? null, new Date().toISOString());
  return view(db.prepare('SELECT * FROM feedback WHERE id=?').get(id));
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
