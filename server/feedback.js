import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { ApiError, getItem, events } from './store.js';
import { members } from './auth.js';
import { getTeam } from './teams.js';
import { mailEnabled, sendMail, feedbackMail } from './mailer.js';
import { FEEDBACK_MAIL_DEBOUNCE_MS, PUBLIC_URL } from './config.js';

export const KINDS = ['concern', 'conflict', 'question', 'suggestion', 'gap'];
export const DECISION = 'decision'; // a question with options that an agent asks a person; stored as feedback
/** An agent asks a person to delete or release a spec. Agents can never do either themselves; accepting the proposal (approvers only) carries it out. */
export const PROPOSALS = { propose_deletion: 'delete', propose_acceptance: 'release' };
export const STATUSES = ['open', 'accepted', 'dismissed', 'done']; // what people can set; agents can additionally withdraw their own open entries
const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const json = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };

const view = (r) => ({
  id: r.id, specId: r.spec_id, specVersion: r.spec_version, kind: r.kind, section: r.section, text: r.text, evidence: r.evidence,
  status: r.status, author: r.author, via: r.via, createdAt: r.created_at, resolvedBy: r.resolved_by, resolvedAt: r.resolved_at, reply: r.reply,
  ...(r.kind === DECISION ? { blocking: !!r.blocking, options: json(r.options, []), recommended: r.recommended, answer: r.answer } : {}),
});
const row = (teamId, id) => db.prepare('SELECT * FROM feedback WHERE team_id=? AND id=?').get(teamId, id);

/** Everything the garden view shows changes with this counter (feedback, decisions, reports). */
export const bumpGarden = (teamId) => db.prepare('UPDATE teams SET garden_rev = garden_rev + 1 WHERE id=?').run(teamId);
export const gardenRev = (teamId) => db.prepare('SELECT garden_rev AS n FROM teams WHERE id=?').get(teamId)?.n ?? 0;

function specFor(teamId, specId) {
  const spec = getItem(teamId, specId);
  if (!spec || spec.kind !== 'spec') throw new ApiError(`No spec "${specId}".`, 404);
  return spec;
}
function insert(teamId, spec, f, by) {
  const open = db.prepare("SELECT COUNT(*) AS n FROM feedback WHERE team_id=? AND spec_id=? AND status='open'").get(teamId, spec.id).n;
  if (open >= 50) throw new ApiError('This spec already has 50 open entries – ask a person to triage them first.', 429);
  const id = randomUUID();
  db.prepare('INSERT INTO feedback (id,team_id,spec_id,spec_version,kind,section,text,evidence,status,author,author_id,via,created_at,blocking,options,recommended) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, teamId, spec.id, spec.version || 0, f.kind, f.section, f.text, f.evidence, 'open', by?.name ?? null, by?.id ?? null, by?.via ?? null, new Date().toISOString(),
      f.blocking ? 1 : 0, f.options ? JSON.stringify(f.options) : null, f.recommended ?? null);
  bumpGarden(teamId);
  const created = view(row(teamId, id));
  queueMail(teamId, created, by?.id);
  return created;
}

/** Agents (or people) leave feedback on a spec. Feedback never changes the spec: humans triage it. Duplicates of an open entry are merged. */
export function addFeedback(teamId, { specId, kind, section, text, evidence }, by) {
  const spec = specFor(teamId, specId);
  text = String(text ?? '').trim();
  if (!text) throw new ApiError('Write what you found.');
  if (text.length > 4000) throw new ApiError('Keep feedback under 4000 characters.');
  if (!KINDS.includes(kind)) throw new ApiError(`kind must be one of: ${KINDS.join(', ')}`);
  section = String(section ?? '').trim().slice(0, 80);
  evidence = String(evidence ?? '').trim().slice(0, 1000);
  const dup = db.prepare("SELECT * FROM feedback WHERE team_id=? AND spec_id=? AND status='open'").all(teamId, specId)
    .find((r) => r.kind !== DECISION && norm(r.section) === norm(section) && norm(r.text) === norm(text));
  if (dup) return { ...view(dup), duplicate: true };
  return insert(teamId, spec, { kind, section, text, evidence }, by);
}

/** An agent asks a person to decide: a question with 2–6 options. The answer comes back through list_decisions. */
export function requestDecision(teamId, { specId, question, options, recommended, section, context, blocking }, by) {
  const spec = specFor(teamId, specId);
  const text = String(question ?? '').trim();
  if (!text) throw new ApiError('Ask a question.');
  if (text.length > 2000) throw new ApiError('Keep the question under 2000 characters (put background into context).');
  if (!Array.isArray(options) || options.length < 2 || options.length > 6) throw new ApiError('Give 2 to 6 options to choose from.');
  const opts = options.map((o) => (typeof o === 'string' ? { label: o } : o)).map((o) => ({ label: String(o?.label ?? '').trim().slice(0, 120), ...(String(o?.detail ?? '').trim() ? { detail: String(o.detail).trim().slice(0, 600) } : {}) }));
  if (opts.some((o) => !o.label)) throw new ApiError('Every option needs a label.');
  if (new Set(opts.map((o) => norm(o.label))).size !== opts.length) throw new ApiError('The options must differ.');
  const rec = recommended === undefined || recommended === null ? null : Number(recommended);
  if (rec !== null && !(Number.isInteger(rec) && rec >= 0 && rec < opts.length)) throw new ApiError(`recommended must be the index (0–${opts.length - 1}) of one of the options.`);
  const dup = db.prepare("SELECT * FROM feedback WHERE team_id=? AND spec_id=? AND kind=? AND status='open'").all(teamId, specId, DECISION).find((r) => norm(r.text) === norm(text));
  if (dup) return { ...view(dup), duplicate: true };
  return insert(teamId, spec, { kind: DECISION, section: String(section ?? '').trim().slice(0, 80), text, evidence: String(context ?? '').trim().slice(0, 2000), blocking: blocking !== false, options: opts, recommended: rec }, by);
}

/** An agent proposes to delete a spec, or to release (approve) it. A person decides; accepting is what makes it happen. */
export function addProposal(teamId, { specId, action, reason }, by) {
  const kind = action === 'delete' ? 'propose_deletion' : 'propose_acceptance';
  const spec = specFor(teamId, specId);
  reason = String(reason ?? '').trim();
  if (!reason) throw new ApiError('Say why – a person decides based on your reason.');
  if (reason.length > 4000) throw new ApiError('Keep the reason under 4000 characters.');
  if (action === 'release' && spec.status === 'approved' && spec.rev === spec.releasedRev) throw new ApiError(`${specId} is already released in its current form – there is nothing to release.`);
  const dup = db.prepare("SELECT * FROM feedback WHERE team_id=? AND spec_id=? AND kind=? AND status='open'").get(teamId, specId, kind);
  if (dup) return { ...view(dup), duplicate: true };
  return insert(teamId, spec, { kind, section: '', text: reason, evidence: '' }, by);
}

export const getFeedback = (teamId, id) => { const r = row(teamId, id); return r ? view(r) : null; };

export function listFeedback(teamId, { specId, status, kind } = {}) {
  const rows = db.prepare('SELECT * FROM feedback WHERE team_id=? ORDER BY created_at DESC').all(teamId).map(view);
  return rows.filter((f) => (!specId || f.specId === specId) && (!status || f.status === status) && (!kind || f.kind === kind));
}

/** People triage feedback (status + reply) and answer decisions (answer = option index, or -1 with the answer written into the reply). */
export function setFeedback(teamId, id, { status, reply, answer }, user, { execute = false } = {}) {
  const cur = row(teamId, id);
  if (!cur) throw new ApiError('Unknown feedback', 404);
  if (cur.status === 'withdrawn') throw new ApiError('The agent withdrew this entry – there is nothing left to decide.', 409);
  const decision = cur.kind === DECISION;
  const rp = reply === undefined ? cur.reply : String(reply ?? '').trim().slice(0, 2000);
  let st = status ?? cur.status;
  let ans = cur.answer;
  if (answer !== undefined && answer !== null) {
    if (!decision) throw new ApiError('Only decision requests can be answered with an option.');
    ans = Number(answer);
    const n = json(cur.options, []).length;
    if (!Number.isInteger(ans) || ans < -1 || ans >= n) throw new ApiError(`answer must be the index of an option (0–${n - 1}), or -1 with your own answer as the reply.`);
    if (ans === -1 && !rp) throw new ApiError('Write your own answer as the reply.');
    st = 'answered';
  } else if (decision) {
    if (st === 'answered' && cur.status !== 'answered') throw new ApiError('Pick an option to answer the decision.');
    if (!['open', 'answered', 'dismissed'].includes(st)) throw new ApiError('A decision is open, answered or dismissed.');
    if (st === 'open') ans = null; // reopened: the earlier answer no longer counts
  } else if (PROPOSALS[cur.kind]) {
    if (!['open', 'accepted', 'dismissed'].includes(st)) throw new ApiError('A proposal is open, accepted or dismissed.');
    if (st === 'accepted' && cur.status !== 'accepted' && !execute) throw new ApiError(`Accepting this proposal carries it out (${PROPOSALS[cur.kind]} the spec) and needs a connection to the server and approval rights.`, 409);
  } else if (!STATUSES.includes(st)) throw new ApiError(`status must be one of: ${STATUSES.join(', ')}`);
  const closed = st !== 'open';
  db.prepare('UPDATE feedback SET status=?, reply=?, answer=?, resolved_by=?, resolved_at=? WHERE id=?').run(st, rp, ans, closed ? user.name : null, closed ? new Date().toISOString() : null, id);
  bumpGarden(teamId);
  const out = view(row(teamId, id));
  if (decision && st === 'answered' && (cur.status !== 'answered' || cur.answer !== ans || cur.reply !== rp)) events.emit('answered', { teamId, decision: out, by: user.name });
  return out;
}

/** Decisions and triage done offline arrive with the next sync. Each op is applied on its own; a refused one does not stop the others. */
export function applyFeedbackOps(teamId, ops, user) {
  return (Array.isArray(ops) ? ops.slice(0, 200) : []).map((op) => {
    try { setFeedback(teamId, String(op?.id), { status: op?.status, reply: op?.reply, answer: op?.answer }, user); return { id: op?.id, ok: true }; }
    catch (e) { if (e instanceof ApiError) return { id: op?.id, ok: false, error: e.message }; throw e; }
  });
}

export const openCounts = (teamId) => Object.fromEntries(db.prepare("SELECT spec_id, COUNT(*) AS n FROM feedback WHERE team_id=? AND status='open' GROUP BY spec_id").all(teamId).map((r) => [r.spec_id, r.n]));

/** What a device keeps for offline use: everything open, plus the decisions answered most recently (so they can be reread or changed). */
export function gardenFeedback(teamId) {
  const open = db.prepare("SELECT * FROM feedback WHERE team_id=? AND status='open' ORDER BY created_at DESC").all(teamId);
  const answered = db.prepare("SELECT * FROM feedback WHERE team_id=? AND kind=? AND status='answered' ORDER BY resolved_at DESC LIMIT 30").all(teamId, DECISION);
  return [...open, ...answered].map(view);
}

/** An agent takes back its own open feedback or decision request (e.g. it was wrong). People's decisions are never overridden. */
export function withdrawFeedback(teamId, id, by) {
  const cur = row(teamId, id);
  if (!cur) throw new ApiError('Unknown feedback', 404);
  if (cur.author_id !== by?.id || (cur.via ?? null) !== (by?.via ?? null)) throw new ApiError('You can only withdraw feedback you left yourself.', 403);
  if (cur.status !== 'open') throw new ApiError(`This entry is already ${cur.status} – a person decided about it.`, 409);
  db.prepare("UPDATE feedback SET status='withdrawn', resolved_by=?, resolved_at=? WHERE id=?").run(by.name, new Date().toISOString(), id);
  bumpGarden(teamId);
  pending.get(teamId)?.items.delete(id);
  return view(row(teamId, id));
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
  const mail = feedbackMail({ teamName: team.name, items, link: `${PUBLIC_URL}/#/garden` });
  try { await sendMail({ to, ...mail }); } catch (e) { console.warn('feedback mail failed:', e.message); }
}
export const flushFeedbackMail = flush; // for tests
