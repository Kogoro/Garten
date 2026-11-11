import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import * as store from './store.js';
import { ApiError } from './store.js';
import { bumpGarden, DECISION } from './feedback.js';

export const REPORT_STATUSES = ['implemented', 'partial', 'blocked', 'in_progress'];
export const CRITERION_STATUSES = ['met', 'deviating', 'open'];
export const EVIDENCE_KINDS = ['commit', 'pr', 'test', 'ci', 'url', 'other'];

const json = (s) => { try { return JSON.parse(s) ?? []; } catch { return []; } };
const view = (r) => ({
  id: r.id, specId: r.spec_id, specVersion: r.spec_version, status: r.status, summary: r.summary, criteria: json(r.criteria), evidence: json(r.evidence),
  deviations: r.deviations, author: r.author, via: r.via, createdAt: r.created_at,
});
const clip = (s, n) => String(s ?? '').trim().slice(0, n);

/** An agent reports what it built for a released spec version: status, each acceptance criterion, evidence, deviations. Reports are append-only. */
export function addReport(team, { specId, version, status, summary, criteria, evidence, deviations }, by) {
  const spec = store.getItem(team.id, specId);
  if (!spec || spec.kind !== 'spec') throw new ApiError(`No spec "${specId}".`, 404);
  if (spec.status !== 'approved') throw new ApiError(`${specId} is not released – there is nothing to report against. Work only from released specs.`);
  const v = version === undefined || version === null ? spec.version : Number(version);
  if (!Number.isInteger(v) || v < 1 || v > spec.version) throw new ApiError(`version must be a released version of ${specId} (1–${spec.version}).`);
  if (!REPORT_STATUSES.includes(status)) throw new ApiError(`status must be one of: ${REPORT_STATUSES.join(', ')}`);
  const sum = clip(summary, 4000);
  if (!sum) throw new ApiError('Write a short summary of what you did.');
  if (criteria !== undefined && !Array.isArray(criteria)) throw new ApiError('criteria must be a list.');
  if (evidence !== undefined && !Array.isArray(evidence)) throw new ApiError('evidence must be a list.');
  if ((criteria ?? []).length > 60) throw new ApiError('At most 60 criteria per report.');
  if ((evidence ?? []).length > 30) throw new ApiError('At most 30 evidence entries per report.');
  const crit = (criteria ?? []).map((c) => {
    const text = clip(c?.text, 400); const st = c?.status ?? 'met';
    if (!text) throw new ApiError('Every criterion needs its text (quote it from the spec).');
    if (!CRITERION_STATUSES.includes(st)) throw new ApiError(`criterion status must be one of: ${CRITERION_STATUSES.join(', ')}`);
    const note = clip(c?.note, 600);
    return { text, status: st, ...(note ? { note } : {}) };
  });
  const evid = (evidence ?? []).map((e) => {
    const ref = clip(e?.ref, 400); const kind = e?.kind ?? 'other';
    if (!ref) throw new ApiError('Every evidence entry needs a ref (commit hash, PR URL, test name …).');
    if (!EVIDENCE_KINDS.includes(kind)) throw new ApiError(`evidence kind must be one of: ${EVIDENCE_KINDS.join(', ')}`);
    const note = clip(e?.note, 400);
    return { kind, ref, ...(note ? { note } : {}) };
  });
  const dev = clip(deviations, 4000);
  if (status === 'implemented' && crit.some((c) => c.status === 'open')) throw new ApiError('A report with open criteria is "partial", not "implemented".');
  const id = randomUUID();
  db.prepare('INSERT INTO reports (id,team_id,spec_id,spec_version,status,summary,criteria,evidence,deviations,author,author_id,via,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, team.id, specId, v, status, sum, JSON.stringify(crit), JSON.stringify(evid), dev, by?.name ?? null, by?.id ?? null, by?.via ?? null, new Date().toISOString());
  bumpGarden(team.id);
  return view(db.prepare('SELECT * FROM reports WHERE id=?').get(id));
}

export function listReports(teamId, { specId, limit = 50 } = {}) {
  const rows = specId
    ? db.prepare('SELECT * FROM reports WHERE team_id=? AND spec_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(teamId, specId, limit)
    : db.prepare('SELECT * FROM reports WHERE team_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(teamId, limit);
  return rows.map(view);
}

/** The newest report of every spec (what the garden view shows, also offline). */
export function latestReports(teamId) {
  const out = {};
  for (const r of db.prepare('SELECT * FROM reports WHERE team_id=? ORDER BY created_at, rowid').all(teamId)) out[r.spec_id] = view(r);
  return out;
}

/** What is left to do, from the agent's point of view: released specs without a current "implemented" report, and decisions. */
export function workList(team) {
  const t = team.id;
  if (team.row.agent_paused) {
    return { team: team.name, paused: true, work: [], note: 'A person has paused the agents of this team. Do not start new work; try again later. Answers to your questions and reports are still accepted.' };
  }
  const latest = latestReports(t);
  const decisions = db.prepare("SELECT * FROM feedback WHERE team_id=? AND kind=? AND status IN ('open','answered') ORDER BY created_at").all(t, DECISION);
  const feedbackOpen = Object.fromEntries(db.prepare("SELECT spec_id, COUNT(*) AS n FROM feedback WHERE team_id=? AND status='open' AND kind<>? GROUP BY spec_id").all(t, DECISION).map((r) => [r.spec_id, r.n]));
  const work = []; let done = 0;
  for (const s of store.approvedSpecs(t)) {
    const rep = latest[s.id];
    const mine = decisions.filter((d) => d.spec_id === s.id);
    const open = mine.filter((d) => d.status === 'open');
    const answered = mine.filter((d) => d.status === 'answered' && (!rep || d.resolved_at > rep.createdAt));
    let state = null;
    if (!rep) state = 'new';
    else if (rep.specVersion < s.version) state = 'changed';
    else if (rep.status !== 'implemented') state = rep.status;
    else if (answered.length) state = 'decision_answered';
    if (!state) { done += 1; if (!open.length) continue; state = 'implemented'; }
    const options = (d) => { try { return JSON.parse(d.options) ?? []; } catch { return []; } };
    work.push({
      spec_id: s.id, title: s.title, type: s.specType, version: s.version, state,
      ...(state === 'changed' ? { changed_from: rep.specVersion, hint: `Call get_spec_changes("${s.id}") to see what changed since v${rep.specVersion}.` } : {}),
      ...(rep ? { last_report: { version: rep.specVersion, status: rep.status, at: rep.createdAt, summary: rep.summary.slice(0, 300) } } : {}),
      ...(open.length ? { waiting_for_decision: open.map((d) => ({ id: d.id, question: d.text, blocking: !!d.blocking })) } : {}),
      ...(answered.length ? { decisions_answered: answered.map((d) => ({ id: d.id, question: d.text, answer: d.answer >= 0 ? options(d)[d.answer]?.label ?? null : null, note: d.reply || undefined, answered_by: d.resolved_by })) } : {}),
      ...(feedbackOpen[s.id] ? { open_feedback: feedbackOpen[s.id] } : {}),
    });
  }
  const rank = { decision_answered: 0, changed: 1, new: 2, in_progress: 3, partial: 4, blocked: 5, implemented: 6 };
  work.sort((a, b) => rank[a.state] - rank[b.state] || a.spec_id.localeCompare(b.spec_id));
  return {
    team: team.name, released_specs: store.approvedSpecs(t).length, up_to_date: done, work,
    states: 'new = never reported · changed = a newer version was released since your last report · decision_answered = a person answered your question · in_progress / partial / blocked = your last report · implemented = done, listed only because a question is still open',
    note: work.length ? 'Entries with a blocking waiting_for_decision must wait for a person; work on the others.' : 'Nothing to do: every released spec has an "implemented" report for its current version.',
  };
}

const sections = (md) => {
  const body = String(md).replace(/^---\n[\s\S]*?\n---\n/, '');
  const out = new Map(); let name = '(intro)'; let buf = [];
  for (const line of body.split('\n')) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) { out.set(name, buf.join('\n').trim()); name = m[1]; buf = []; } else buf.push(line);
  }
  out.set(name, buf.join('\n').trim());
  return out;
};

/** What changed between two released versions of a spec: the sections that differ and a unified diff. */
export async function specChanges(team, id, from, to) {
  const spec = store.getItem(team.id, id);
  if (!spec || spec.kind !== 'spec' || spec.version < 1) throw new ApiError(`No released spec "${id}".`, 404);
  const latest = latestReports(team.id)[id];
  const b = to === undefined || to === null ? spec.version : Number(to);
  const a = from === undefined || from === null ? (latest && latest.specVersion < b ? latest.specVersion : b - 1) : Number(from);
  if (!Number.isInteger(b) || b < 1 || b > spec.version) throw new ApiError(`to must be a released version of ${id} (1–${spec.version}).`);
  if (!Number.isInteger(a) || a < 0 || a >= b) throw new ApiError(`from must be a version before v${b}.`);
  if (a === 0) return { id, from: null, to: b, note: `v${b} is the first version you see – read it completely with get_spec.`, sections_changed: [], diff: '' };
  let before, after, diff;
  try {
    [before, after, diff] = await Promise.all([store.readReleasedSpec(team, id, a), store.readReleasedSpec(team, id, b), store.diffReleasedSpec(team, id, a, b)]);
  } catch { throw new ApiError(`The released files of ${id} v${a}/v${b} were not found in the repository.`, 404); }
  const A = sections(before), B = sections(after);
  const changed = [];
  for (const [k, v] of B) if (!A.has(k)) changed.push({ section: k, change: 'added' }); else if (A.get(k) !== v) changed.push({ section: k, change: 'changed' });
  for (const k of A.keys()) if (!B.has(k)) changed.push({ section: k, change: 'removed' });
  const title = (md) => /^title:\s*(.*)$/m.exec(md)?.[1];
  return {
    id, from: a, to: b, ...(title(before) !== title(after) ? { title_changed: true } : {}),
    sections_changed: changed, diff: diff.length > 60000 ? `${diff.slice(0, 60000)}\n… (diff truncated – read the full spec with get_spec)` : diff,
  };
}
