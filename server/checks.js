// Re-runnable evidence: checks (how to verify a claim again) and their runs. Agents register checks and report results through MCP;
// a CI pipeline can report results with its own token (source "ci", which people trust more than an agent's word).
import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import * as store from './store.js';
import { ApiError } from './store.js';
import { bumpGarden } from './feedback.js';

export const CHECK_KINDS = ['test', 'ci', 'metric', 'command', 'url', 'manual'];
export const RUN_STATUSES = ['pass', 'fail', 'error'];
const clip = (s, n) => String(s ?? '').trim().slice(0, n);
const NAME = /^[\w][\w .:/@#()+-]{0,79}$/;

const checkView = (c, run, specVersion) => {
  let state = 'unverified';
  if (run) {
    const ageDays = (Date.now() - Date.parse(run.at)) / 86400000;
    if (run.status !== 'pass') state = 'failing';
    else if (ageDays > c.max_age_days || (specVersion && run.spec_version < specVersion)) state = 'stale';
    else state = 'passing';
  }
  return {
    id: c.id, specId: c.spec_id, name: c.name, kind: c.kind, how: c.how, expect: c.expect, criterion: c.criterion, maxAgeDays: c.max_age_days, retired: !!c.retired, state,
    last: run ? { status: run.status, value: run.value || undefined, detail: run.detail || undefined, ref: run.ref || undefined, commit: run.commit_sha || undefined, specVersion: run.spec_version, source: run.source, by: run.run_by, at: run.at } : null,
  };
};
const lastRun = (checkId) => db.prepare('SELECT * FROM check_runs WHERE check_id=? ORDER BY at DESC, rowid DESC LIMIT 1').get(checkId);

/** Register a check for a released spec, or update its definition (same name = same check). */
export function registerCheck(team, { specId, name, kind, how, expect, criterion, maxAgeDays }, by) {
  const spec = store.getItem(team.id, specId);
  if (!spec || spec.kind !== 'spec') throw new ApiError(`No spec "${specId}".`, 404);
  name = clip(name, 80);
  if (!NAME.test(name)) throw new ApiError('A check needs a short name (letters, digits and . : / @ # ( ) + - _ and spaces).');
  if (!CHECK_KINDS.includes(kind)) throw new ApiError(`kind must be one of: ${CHECK_KINDS.join(', ')}`);
  how = clip(how, 600);
  if (!how) throw new ApiError('Say how to run the check: the command, the CI job URL, the metric query or the test selector.');
  const age = maxAgeDays === undefined ? 14 : Number(maxAgeDays);
  if (!Number.isInteger(age) || age < 1 || age > 365) throw new ApiError('max_age_days must be between 1 and 365.');
  const now = new Date().toISOString();
  const cur = db.prepare('SELECT * FROM checks WHERE team_id=? AND spec_id=? AND name=?').get(team.id, specId, name);
  if (cur) {
    db.prepare('UPDATE checks SET kind=?, how=?, expect=?, criterion=?, max_age_days=?, retired=0, updated_at=? WHERE id=?')
      .run(kind, how, clip(expect, 300), clip(criterion, 400), age, now, cur.id);
  } else {
    const n = db.prepare('SELECT COUNT(*) AS n FROM checks WHERE team_id=? AND spec_id=? AND retired=0').get(team.id, specId).n;
    if (n >= 40) throw new ApiError('At most 40 checks per spec.');
    db.prepare('INSERT INTO checks (id,team_id,spec_id,name,kind,how,expect,criterion,max_age_days,created_by,via,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(), team.id, specId, name, kind, how, clip(expect, 300), clip(criterion, 400), age, by?.name ?? null, by?.via ?? null, now, now);
  }
  bumpGarden(team.id);
  return getCheck(team.id, specId, name);
}

export function retireCheck(team, specId, name) {
  const r = db.prepare('UPDATE checks SET retired=1, updated_at=? WHERE team_id=? AND spec_id=? AND name=?').run(new Date().toISOString(), team.id, specId, name);
  if (!r.changes) throw new ApiError(`No check "${name}" on ${specId}.`, 404);
  bumpGarden(team.id);
}

export function getCheck(teamId, specId, name) {
  const c = db.prepare('SELECT * FROM checks WHERE team_id=? AND spec_id=? AND name=?').get(teamId, specId, name);
  if (!c) return null;
  return checkView(c, lastRun(c.id), store.getItem(teamId, specId)?.version);
}

/** Record the outcome of running a check. source: "agent" (MCP) or "ci" (pipeline token). */
export function recordRun(team, { specId, name, status, value, detail, ref, commit }, by, source = 'agent') {
  const spec = store.getItem(team.id, specId);
  if (!spec || spec.kind !== 'spec') throw new ApiError(`No spec "${specId}".`, 404);
  if (spec.version < 1) throw new ApiError(`${specId} is not released – checks run against released versions.`);
  const c = db.prepare('SELECT * FROM checks WHERE team_id=? AND spec_id=? AND name=?').get(team.id, specId, clip(name, 80));
  if (!c) throw new ApiError(`${specId} has no check "${name}". Register it first (register_check).`, 404);
  if (!RUN_STATUSES.includes(status)) throw new ApiError(`status must be one of: ${RUN_STATUSES.join(', ')}`);
  if (c.retired) db.prepare('UPDATE checks SET retired=0 WHERE id=?').run(c.id);
  if (ref && !/^[\w+.-]+:\/\/\S+$|^[\w./#@-]{1,200}$/.test(String(ref).trim())) throw new ApiError('ref must be a URL or a short reference (run id, file path).');
  const id = randomUUID();
  db.prepare('INSERT INTO check_runs (id,check_id,team_id,spec_id,spec_version,status,value,detail,ref,commit_sha,source,run_by,at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, c.id, team.id, specId, spec.version, status, clip(value, 200), clip(detail, 2000), clip(ref, 400), clip(commit, 80), source, by?.via ? `${by.via}${by.name ? ` (${by.name})` : ''}` : by?.name ?? null, new Date().toISOString());
  // keep the history bounded: the 50 newest runs per check
  db.prepare('DELETE FROM check_runs WHERE check_id=? AND rowid NOT IN (SELECT rowid FROM check_runs WHERE check_id=? ORDER BY at DESC, rowid DESC LIMIT 50)').run(c.id, c.id);
  bumpGarden(team.id);
  return getCheck(team.id, specId, c.name);
}

export function listChecks(teamId, { specId, includeRetired = false } = {}) {
  const rows = specId
    ? db.prepare('SELECT * FROM checks WHERE team_id=? AND spec_id=? ORDER BY name').all(teamId, specId)
    : db.prepare('SELECT * FROM checks WHERE team_id=? ORDER BY spec_id, name').all(teamId);
  return rows.filter((c) => includeRetired || !c.retired).map((c) => checkView(c, lastRun(c.id), store.getItem(teamId, c.spec_id)?.version));
}

export function runHistory(teamId, specId, name, limit = 20) {
  const c = db.prepare('SELECT id FROM checks WHERE team_id=? AND spec_id=? AND name=?').get(teamId, specId, name);
  if (!c) return [];
  return db.prepare('SELECT * FROM check_runs WHERE check_id=? ORDER BY at DESC, rowid DESC LIMIT ?').all(c.id, limit)
    .map((r) => ({ status: r.status, value: r.value || undefined, detail: r.detail || undefined, ref: r.ref || undefined, commit: r.commit_sha || undefined, specVersion: r.spec_version, source: r.source, by: r.run_by, at: r.at }));
}

/** { SPEC-012: [check…] } for the garden view (also offline). */
export function checksBySpec(teamId) {
  const out = {};
  for (const c of listChecks(teamId)) (out[c.specId] ??= []).push(c);
  return out;
}

/** Summary of the checks of one spec: how many pass, fail, are stale or never ran. */
export function summarize(list) {
  const n = { total: list.length, passing: 0, failing: 0, stale: 0, unverified: 0 };
  for (const c of list) n[c.state] += 1;
  return n;
}
