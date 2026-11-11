// What the team can learn about its own process, computed from data the app already holds (nothing is collected or sent anywhere).
import { db } from './db.js';
import * as store from './store.js';
import { latestReports } from './reports.js';
import { DECISION } from './feedback.js';

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const hours = (from, to) => (Date.parse(to) - Date.parse(from)) / 3600000;

export function teamMetrics(team, days = 30) {
  const t = team.id; const since = Date.now() - days * 86400000;
  const specs = store.approvedSpecs(t);
  const latest = latestReports(t);
  const releasedRecently = specs.filter((s) => s.releasedAt && Date.parse(s.releasedAt) >= since);
  const draftToRelease = releasedRecently.map((s) => hours(s.createdAt ?? s.releasedAt, s.releasedAt)).filter((h) => h >= 0);
  const decisions = db.prepare('SELECT created_at, resolved_at, status FROM feedback WHERE team_id=? AND kind=?').all(t, DECISION);
  const answered = decisions.filter((d) => d.status === 'answered' && d.resolved_at && Date.parse(d.resolved_at) >= since).map((d) => hours(d.created_at, d.resolved_at));
  const open = decisions.filter((d) => d.status === 'open');
  const oldestOpen = open.length ? Math.max(...open.map((d) => hours(d.created_at, new Date().toISOString()))) : null;
  const state = { implemented: 0, outdated: 0, blocked: 0, partial: 0, in_progress: 0, none: 0 };
  for (const s of specs) {
    const r = latest[s.id];
    if (!r) state.none += 1; else if (r.specVersion < s.version) state.outdated += 1; else state[r.status] += 1;
  }
  const verified = Object.values(latest).reduce((a, r) => ({ met: a.met + (r.verification?.met ?? 0), verified: a.verified + (r.verification?.verified ?? 0) }), { met: 0, verified: 0 });
  return {
    days,
    releasedSpecs: specs.length, releasedInPeriod: releasedRecently.length,
    medianHoursDraftToRelease: median(draftToRelease),
    decisionsAnswered: answered.length, medianHoursToAnswer: median(answered), openDecisions: open.length, oldestOpenDecisionHours: oldestOpen,
    implementation: state,
    ...(verified.met ? { claimsVerified: verified } : {}),
  };
}
