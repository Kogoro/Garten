// People steer what agents build next, per spec: priority, hold, and dependencies on other specs.
import { sql } from './db.js';
import * as store from './store.js';
import { ApiError } from './store.js';
import { bumpGarden } from './feedback.js';

export const PRIORITIES = ['high', 'normal', 'low'];
const json = (s) => {
  try {
    return JSON.parse(s) ?? [];
  } catch {
    return [];
  }
};
const view = (r) => ({
  priority: r.priority,
  hold: !!r.hold,
  holdNote: r.hold_note || undefined,
  depends: json(r.depends),
  updatedBy: r.updated_by,
  updatedAt: r.updated_at,
});
const DEFAULT = { priority: 'normal', hold: false, depends: [] };

/** { SPEC-1: { priority, hold, holdNote, depends } } – only specs someone steered. */
export function steeringOf(teamId) {
  return Object.fromEntries(
    sql('SELECT * FROM spec_steering WHERE team_id=?')
      .all(teamId)
      .map((r) => [r.spec_id, view(r)]),
  );
}
export const steeringFor = (teamId, specId) => steeringOf(teamId)[specId] ?? DEFAULT;

/** Fields left out stay as they are. A dependency must be another existing spec and must not close a cycle. */
export function setSteering(teamId, specId, { priority, hold, holdNote, depends }, user) {
  const spec = store.getItem(teamId, specId);
  if (!spec || spec.kind !== 'spec') throw new ApiError(`No spec "${specId}".`, 404);
  const all = steeringOf(teamId);
  const cur = all[specId] ?? DEFAULT;
  const p = priority === undefined ? cur.priority : priority;
  if (!PRIORITIES.includes(p)) throw new ApiError(`priority must be one of: ${PRIORITIES.join(', ')}`);
  const h = hold === undefined ? cur.hold : !!hold;
  const note = h
    ? String(holdNote === undefined ? (cur.holdNote ?? '') : (holdNote ?? ''))
        .trim()
        .slice(0, 300)
    : '';
  let deps = cur.depends;
  if (depends !== undefined) {
    if (!Array.isArray(depends)) throw new ApiError('depends must be a list of spec ids.');
    deps = [...new Set(depends.map((d) => String(d ?? '').trim()).filter(Boolean))];
    if (deps.length > 10) throw new ApiError('At most 10 dependencies.');
    for (const d of deps) {
      if (d === specId) throw new ApiError('A spec cannot depend on itself.');
      const o = store.getItem(teamId, d);
      if (!o || o.kind !== 'spec') throw new ApiError(`No spec "${d}".`);
    }
    // no cycles: walk the dependencies of the new dependencies
    const seen = new Set();
    const stack = [...deps];
    while (stack.length) {
      const x = stack.pop();
      if (x === specId) throw new ApiError(`That would make a cycle: ${specId} already comes before ${deps.join(', ')}.`);
      if (seen.has(x)) continue;
      seen.add(x);
      stack.push(...(all[x]?.depends ?? []));
    }
  }
  sql(`INSERT INTO spec_steering (team_id,spec_id,priority,hold,hold_note,depends,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT (team_id, spec_id) DO UPDATE SET priority=excluded.priority, hold=excluded.hold, hold_note=excluded.hold_note, depends=excluded.depends, updated_by=excluded.updated_by, updated_at=excluded.updated_at`).run(
    teamId,
    specId,
    p,
    h ? 1 : 0,
    note,
    JSON.stringify(deps),
    user?.name ?? null,
    new Date().toISOString(),
  );
  bumpGarden(teamId);
  return steeringFor(teamId, specId);
}
