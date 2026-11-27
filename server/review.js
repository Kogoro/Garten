// The second gate: a person reviews what an agent reported as implemented. "Accept" confirms the build of that spec version;
// "Send back" returns it to the agents with a note (and the criteria it is about) – it is back on their work list as "sent_back".
// A new report starts a new review: the verdict belongs to the report it was given on.
import { sql } from './db.js';
import * as store from './store.js';
import { ApiError, events } from './store.js';
import { bumpGarden } from './feedback.js';
import { listReports } from './reports.js';

export const VERDICTS = ['accepted', 'returned'];

const clip = (s, n) =>
  String(s ?? '')
    .trim()
    .slice(0, n);

/**
 * Review the newest report of a released spec. Only an "implemented" report for the current version can be reviewed.
 * reportId (optional) guards against a newer report that arrived while the person was reading: then nothing is changed.
 */
export function reviewReport(team, specId, { verdict, note, criteria, reportId }, user) {
  const spec = store.getItem(team.id, specId);
  if (!spec || spec.kind !== 'spec') throw new ApiError(`No spec "${specId}".`, 404);
  if (!VERDICTS.includes(verdict)) throw new ApiError(`verdict must be one of: ${VERDICTS.join(', ')}`);
  const [latest] = listReports(team.id, { specId, limit: 1 });
  if (!latest) throw new ApiError(`No agent has reported on ${specId} yet – there is nothing to review.`);
  if (reportId && reportId !== latest.id)
    throw new ApiError('A newer report arrived in the meantime. Read it first, then review again.', 409);
  if (latest.status !== 'implemented')
    throw new ApiError(`The newest report on ${specId} is "${latest.status}", not "implemented" – review it once the agent is done.`);
  if (latest.specVersion !== spec.version)
    throw new ApiError(`The newest report on ${specId} is about v${latest.specVersion}; v${spec.version} is in bloom since.`);
  const text = clip(note, 2000);
  if (verdict === 'returned' && !text) throw new ApiError('Say what has to change – the agent reads your note.');
  if (criteria !== undefined && !Array.isArray(criteria)) throw new ApiError('criteria must be a list of criterion ids.');
  const ids = [...new Set((criteria ?? []).map((c) => clip(c, 10).toUpperCase()).filter(Boolean))];
  const known = new Set(latest.criteria.map((c) => c.id).filter(Boolean));
  for (const id of ids) if (!known.has(id)) throw new ApiError(`${specId} v${latest.specVersion} has no criterion "${id}".`);
  const at = new Date().toISOString();
  sql('UPDATE reports SET review=?, review_note=?, review_criteria=?, reviewed_by=?, reviewed_at=? WHERE id=?').run(
    verdict,
    text,
    JSON.stringify(ids),
    user?.name ?? null,
    at,
    latest.id,
  );
  bumpGarden(team.id);
  const [out] = listReports(team.id, { specId, limit: 1 });
  events.emit('reviewed', { teamId: team.id, specId, version: out.specVersion, review: out.review, title: spec.title });
  return out;
}
