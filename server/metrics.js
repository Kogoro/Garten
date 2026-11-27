// What the team can learn about its own process, computed from data the app already holds (nothing is collected or sent anywhere).
import { db } from './db.js';
import * as store from './store.js';
import { latestReports } from './reports.js';
import { listChecks } from './checks.js';
import { DECISION, PROPOSALS } from './feedback.js';
import { typeLabel } from './specTypes.js';

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const hours = (from, to) => (Date.parse(to) - Date.parse(from)) / 3600000;

export function teamMetrics(team, days = 30) {
  const t = team.id;
  const since = Date.now() - days * 86400000;
  const specs = store.approvedSpecs(t);
  const latest = latestReports(t);
  const releasedRecently = specs.filter((s) => s.releasedAt && Date.parse(s.releasedAt) >= since);
  const draftToRelease = releasedRecently.map((s) => hours(s.createdAt ?? s.releasedAt, s.releasedAt)).filter((h) => h >= 0);
  const decisions = db.prepare('SELECT created_at, resolved_at, status FROM feedback WHERE team_id=? AND kind=?').all(t, DECISION);
  const answered = decisions
    .filter((d) => d.status === 'answered' && d.resolved_at && Date.parse(d.resolved_at) >= since)
    .map((d) => hours(d.created_at, d.resolved_at));
  const open = decisions.filter((d) => d.status === 'open');
  const oldestOpen = open.length ? Math.max(...open.map((d) => hours(d.created_at, new Date().toISOString()))) : null;
  const state = { implemented: 0, outdated: 0, blocked: 0, partial: 0, in_progress: 0, none: 0 };
  for (const s of specs) {
    const r = latest[s.id];
    if (!r) state.none += 1;
    else if (r.specVersion < s.version) state.outdated += 1;
    else state[r.status] += 1;
  }
  // the second gate: implemented reports for the current version, as people judged them
  const review = { accepted: 0, waiting: 0, sentBack: 0 };
  for (const s of specs) {
    const r = latest[s.id];
    if (!r || r.status !== 'implemented' || r.specVersion !== s.version) continue;
    if (r.review?.verdict === 'accepted') review.accepted += 1;
    else if (r.review?.verdict === 'returned') review.sentBack += 1;
    else review.waiting += 1;
  }
  // the effect once in use: outcome checks by their state
  const outcomes = { onTarget: 0, offTarget: 0, noRecentMeasurement: 0, notMeasured: 0 };
  const key = { passing: 'onTarget', failing: 'offTarget', stale: 'noRecentMeasurement', unverified: 'notMeasured' };
  for (const c of listChecks(t)) if (c.outcome) outcomes[key[c.state]] += 1;
  const verified = Object.values(latest).reduce(
    (a, r) => ({ met: a.met + (r.verification?.met ?? 0), verified: a.verified + (r.verification?.verified ?? 0) }),
    { met: 0, verified: 0 },
  );
  return {
    days,
    releasedSpecs: specs.length,
    releasedInPeriod: releasedRecently.length,
    medianHoursDraftToRelease: median(draftToRelease),
    decisionsAnswered: answered.length,
    medianHoursToAnswer: median(answered),
    openDecisions: open.length,
    oldestOpenDecisionHours: oldestOpen,
    implementation: state,
    review,
    ...(Object.values(outcomes).some(Boolean) ? { outcomes } : {}),
    ...(verified.met ? { claimsVerified: verified } : {}),
    quality: specQuality(team),
  };
}

const round = (x, n = 2) => (x === null || x === undefined ? null : Math.round(x * 10 ** n) / 10 ** n);
/** How well specs work for agents, per spec type, over every released spec: how often agents had to ask or object,
 * how often they deviated, how many reports a spec needed, and how long from release to an implemented report.
 * A type that asks many questions has a template (or habits) that leave too much open. */
export function specQuality(team) {
  const t = team.id;
  const specs = store.approvedSpecs(t);
  if (!specs.length) return { types: [], unclear: [] };
  const fb = db.prepare('SELECT spec_id, kind FROM feedback WHERE team_id=?').all(t);
  const reports = db
    .prepare(
      'SELECT spec_id, spec_version, status, criteria, deviations, created_at, review FROM reports WHERE team_id=? ORDER BY created_at',
    )
    .all(t);
  const per = new Map(
    specs.map((s) => [s.id, { s, questions: 0, feedback: 0, reports: 0, sentBack: 0, deviating: false, implementedAt: null }]),
  );
  for (const f of fb) {
    const x = per.get(f.spec_id);
    if (!x) continue;
    if (f.kind === DECISION) x.questions += 1;
    else if (!PROPOSALS[f.kind]) x.feedback += 1;
  }
  for (const r of reports) {
    const x = per.get(r.spec_id);
    if (!x) continue;
    x.reports += 1;
    if (r.review === 'returned') x.sentBack += 1;
    let crit = [];
    try {
      crit = JSON.parse(r.criteria) ?? [];
    } catch {
      /* old row */
    }
    if (String(r.deviations ?? '').trim() || crit.some((c) => c.status === 'deviating')) x.deviating = true;
    // the first implemented report for the current version, after it was released
    if (
      !x.implementedAt &&
      r.status === 'implemented' &&
      r.spec_version === x.s.version &&
      (!x.s.releasedAt || r.created_at >= x.s.releasedAt)
    )
      x.implementedAt = r.created_at;
  }
  const groups = new Map();
  for (const x of per.values()) {
    const k = x.s.specType ?? 'feature';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(x);
  }
  const types = [...groups.entries()]
    .map(([key, xs]) => {
      const n = xs.length;
      const reported = xs.filter((x) => x.reports);
      const hrs = xs
        .filter((x) => x.implementedAt && x.s.releasedAt)
        .map((x) => hours(x.s.releasedAt, x.implementedAt))
        .filter((h) => h >= 0);
      return {
        type: key,
        label: typeLabel(t, key),
        specs: n,
        questionsPerSpec: round(xs.reduce((a, x) => a + x.questions, 0) / n),
        feedbackPerSpec: round(xs.reduce((a, x) => a + x.feedback, 0) / n),
        deviationRate: reported.length ? round(reported.filter((x) => x.deviating).length / reported.length) : null,
        reportsPerSpec: reported.length ? round(reported.reduce((a, x) => a + x.reports, 0) / reported.length) : null,
        // how often people sent a build back: many means the acceptance criteria do not say what people expect
        sentBackPerSpec: reported.length ? round(reported.reduce((a, x) => a + x.sentBack, 0) / reported.length) : null,
        medianHoursToImplemented: round(median(hrs), 1),
      };
    })
    .sort((a, b) => b.questionsPerSpec + b.feedbackPerSpec - (a.questionsPerSpec + a.feedbackPerSpec) || a.type.localeCompare(b.type));
  // the specs agents struggled with most: questions and objections together
  const unclear = [...per.values()]
    .filter((x) => x.questions + x.feedback > 0)
    .sort((a, b) => b.questions + b.feedback - (a.questions + a.feedback) || a.s.id.localeCompare(b.s.id))
    .slice(0, 5)
    .map((x) => ({ id: x.s.id, title: x.s.title, type: x.s.specType, questions: x.questions, feedback: x.feedback }));
  return { types, unclear };
}
