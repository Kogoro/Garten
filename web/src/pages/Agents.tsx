import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { ImplChip, ReportSheet, SteerChips, implState } from '../reports';
import { Bar, Shell } from '../Shell';
import { Icon, ago, toast, useStore } from '../ui';
import { Hint } from '../Hint';
import { useTeamInfo } from '../hooks';
import { GrowthIcon } from '../growth';

const dur = (h: number | null | undefined) =>
  h == null ? '–' : h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`;
/** How the process runs, from data the app already has: nothing is collected or sent anywhere. */
function Health() {
  const S = useStore();
  const [m, setM] = useState<any | null>(null);
  useEffect(() => {
    let on = true;
    if (S.state.online)
      S.teamApi('GET', '/metrics')
        .then((d: any) => on && setM(d.metrics))
        .catch(() => {
          /* offline or no access: no card */
        });
    return () => {
      on = false;
    };
  }, [S.state.teamId, S.state.online]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!m) return null;
  const i = m.implementation;
  const parts: ReactNode[] = [
    <span key="r">
      <b>{m.releasedInPeriod}</b> bloomed
    </span>,
  ];
  if (m.medianHoursDraftToRelease != null)
    parts.push(
      <span key="d">
        seed to bloom <b>{dur(m.medianHoursDraftToRelease)}</b> median
      </span>,
    );
  if (m.medianHoursToAnswer != null)
    parts.push(
      <span key="a">
        agents answered in <b>{dur(m.medianHoursToAnswer)}</b> median
      </span>,
    );
  if (m.claimsVerified)
    parts.push(
      <span key="c">
        <b>
          {m.claimsVerified.verified} of {m.claimsVerified.met}
        </b>{' '}
        claims proven by checks
      </span>,
    );
  if (i.blocked)
    parts.push(
      <span key="b">
        <b>{i.blocked}</b> blocked
      </span>,
    );
  return (
    <>
      <p className="gd-health" id="gd-health">
        Last {m.days} days:{' '}
        {parts.map((x, k) => (
          <span key={k}>
            {k ? ' · ' : ''}
            {x}
          </span>
        ))}
      </p>
      <Quality q={m.quality} />
    </>
  );
}

const pct = (x: number | null) => (x == null ? null : `${Math.round(x * 100)} %`);
/** Which kinds of specs work for agents: per type, how often they asked or objected, deviated, reported again – and the specs they struggled with. */
function Quality({ q }: { q?: { types: any[]; unclear: any[] } }) {
  if (!q?.types?.some((t) => t.questionsPerSpec || t.feedbackPerSpec || t.reportsPerSpec)) return null;
  return (
    <details className="gd-quality" id="gd-quality">
      <summary>Spec quality by type</summary>
      <p className="note">
        Over every spec in bloom. Many questions or much feedback per spec mean the type leaves too much open – sharpen its template or its
        acceptance criteria.
      </p>
      <div className="list-card">
        {q.types.map((t) => (
          <div className="gd-row static" key={t.type} data-type={t.type}>
            <span className="grow">
              <b>
                {t.label}{' '}
                <small className="muted">
                  {t.specs} spec{t.specs === 1 ? '' : 's'}
                </small>
              </b>
              <span>
                {[
                  `${t.questionsPerSpec} questions / spec`,
                  `${t.feedbackPerSpec} feedback / spec`,
                  pct(t.deviationRate) && `${pct(t.deviationRate)} deviate`,
                  t.reportsPerSpec != null && `${t.reportsPerSpec} reports / spec`,
                  t.medianHoursToImplemented != null && `${dur(t.medianHoursToImplemented)} bloom to built`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </span>
          </div>
        ))}
      </div>
      {q.unclear.length > 0 && (
        <>
          <div className="sect-title" style={{ marginTop: 12 }}>
            <span>Specs agents struggled with</span>
          </div>
          <div className="list-card">
            {q.unclear.map((x) => (
              <Link className="gd-row" key={x.id} to={`/spec/${encodeURIComponent(x.id)}`}>
                <span className="grow">
                  <b>
                    <span className="mono">{x.id}</span> {x.title}
                  </b>
                  <span>
                    {x.questions} question{x.questions === 1 ? '' : 's'} · {x.feedback} feedback
                  </span>
                </span>
                <Icon name="chevron" size={14} />
              </Link>
            ))}
          </div>
        </>
      )}
    </details>
  );
}

const STATUS_TEXT: Record<string, string> = {
  implemented: 'implemented',
  partial: 'partly built',
  blocked: 'blocked',
  in_progress: 'in progress',
};
/** The name of an agent, from a report or question (via), a claim (by) or the server's agent list (name). */
const who = (x: any) => String(x?.via ?? x?.by ?? x?.name ?? x?.author ?? 'An agent').replace(/^(token|agent):\s*/i, '');

const IMPL_ORDER: [string, string][] = [
  ['blocked', 'Blocked'],
  ['in_progress', 'In progress'],
  ['none', 'Not started'],
  ['implemented', 'Implemented'],
];
/** How the process ran: the key numbers (30 days), specs that bloomed per week, the implementation of every spec in bloom, the latest blooms. */
function HistoryView({ rows, onOpen }: { rows: { s: any; st: { key: string } }[]; onOpen: (id: string) => void }) {
  const weeks = 12;
  const now = Date.now();
  const bins = Array.from({ length: weeks }, (_, i) => {
    const end = now - (weeks - 1 - i) * 7 * 86400_000;
    return { end, n: 0, label: new Date(end).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) };
  });
  for (const { s } of rows) {
    const t = s.releasedAt ? Date.parse(s.releasedAt) : NaN;
    if (!Number.isFinite(t) || t < now - weeks * 7 * 86400_000) continue;
    const i = Math.min(weeks - 1, Math.floor((t - (now - weeks * 7 * 86400_000)) / (7 * 86400_000)));
    bins[i].n += 1;
  }
  const top = Math.max(2, ...bins.map((b) => b.n));
  const key = (k: string) => (k === 'partial' || k === 'in_progress' ? 'in_progress' : k === 'outdated' ? 'in_progress' : k);
  const counts = IMPL_ORDER.map(([k, l]) => [k, l, rows.filter((x) => key(x.st.key) === k).length] as const);
  const releases = [...rows].filter((x) => x.s.releasedAt).sort((a, b) => Date.parse(b.s.releasedAt) - Date.parse(a.s.releasedAt));
  const [hover, setHover] = useState<number | null>(null);
  return (
    <>
      <Health />
      <section id="gd-history-chart" aria-labelledby="hist-h">
        <h2 id="hist-h" className="h-sec">
          Specs that bloomed per week
        </h2>
        <p className="note">The latest version of each spec in bloom, last {weeks} weeks.</p>
        <div className="hchart" role="img" aria-label={bins.map((b) => `week of ${b.label}: ${b.n}`).join(', ')}>
          {bins.map((b, i) => (
            <div
              key={i}
              className={`hbar ${hover === i ? 'on' : ''}`}
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover(null)}
              title={`Week of ${b.label}: ${b.n} spec${b.n === 1 ? '' : 's'}`}
            >
              <span className="hfill" style={{ height: `${(b.n / top) * 100}%` }} />
              {(i % 3 === 2 || i === weeks - 1) && <span className="hlabel">{b.label}</span>}
              {hover === i && (
                <span className="htip">
                  <b>{b.n}</b> spec{b.n === 1 ? '' : 's'} · week of {b.label}
                </span>
              )}
            </div>
          ))}
        </div>
      </section>
      <section id="gd-history-impl" aria-labelledby="impl-h">
        <h2 id="impl-h" className="h-sec">
          Implementation
        </h2>
        {rows.length ? (
          <>
            <div className="implbar" aria-hidden="true">
              {counts
                .filter(([, , n]) => n)
                .map(([k, , n]) => (
                  <span key={k} className={`impl-${k}`} style={{ flexGrow: n }} />
                ))}
            </div>
            <div className="legend">
              {counts.map(([k, l, n]) => (
                <span key={k}>
                  <i className={`impl-${k}`} aria-hidden="true" />
                  {l} <b>{n}</b>
                </span>
              ))}
            </div>
          </>
        ) : (
          <p className="quiet">Nothing in bloom yet.</p>
        )}
      </section>
      {releases.length > 0 && (
        <section id="gd-releases" aria-labelledby="rel-h">
          <h2 id="rel-h" className="h-sec">
            Latest blooms
          </h2>
          <div className="list-card">
            {releases.slice(0, 8).map(({ s }) => (
              <button type="button" className="gd-row" key={s.id} onClick={() => onOpen(s.id)}>
                <GrowthIcon stage="bloom" size={16} />
                <span className="grow">
                  <b>
                    <span className="mono">
                      {s.id}/v{s.version}
                    </span>{' '}
                    {s.title}
                  </b>
                  <span>
                    {s.releasedBy ?? 'Someone'} · {ago(Date.parse(s.releasedAt))}
                  </span>
                </span>
                <Icon name="chevron" size={14} />
              </button>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

/** The command centre: what needs a person, what the agents are doing, where it hangs. Works offline. */
export function AgentsPage() {
  const S = useStore();
  const history = useLocation().pathname === '/history';
  const { info, reload } = useTeamInfo();
  const [report, setReport] = useState<string | null>(null);
  const decisions = S.openDecisions(),
    feedback = S.openFeedback(),
    answered = S.answeredDecisions().slice(0, 10);
  const rows = S.all('spec')
    .filter((s) => s.status === 'approved')
    .map((s) => ({ s, r: S.latestReport(s.id), st: implState(s, S.latestReport(s.id)), checks: S.specChecks(s.id) as any[] }))
    .sort((a, b) => a.st.rank - b.st.rank || a.s.id.localeCompare(b.s.id));
  const done = rows.filter((x) => x.st.key === 'implemented').length;
  const needs = decisions.length + feedback.length;
  const blocking = decisions.filter((d) => d.blocking).length;
  const paused = !!S.team()?.agentPaused;
  const git = info?.git,
    gitFailed = !!git?.url && git.lastOk === false;
  async function setPaused(on: boolean) {
    try {
      await S.teamApi('PATCH', '', { agentPaused: on });
      await S.refreshMe();
      toast(on ? 'Agents paused' : 'Agents resumed');
    } catch (e: any) {
      toast(e instanceof TypeError ? 'Pausing needs a connection to the server.' : e.message);
    }
  }
  async function pushNow() {
    toast('Pushing…');
    try {
      await S.teamApi('POST', '/git/push');
      toast('Pushed');
    } catch {
      toast('Push failed');
    }
    await reload();
  }
  async function testTrigger() {
    try {
      const r: any = await S.teamApi('POST', '/hook/test');
      toast(r?.ok === false ? `Trigger test failed${r.info ? `: ${String(r.info).slice(0, 80)}` : ''}` : 'Trigger test sent');
    } catch (e: any) {
      toast(e instanceof TypeError ? 'Testing needs a connection to the server.' : e.message);
    }
    await reload();
  }
  const [colSel, setColSel] = useState<string | null>(null);
  const synced = !!S.state.garden[S.state.teamId] && S.state.garden[S.state.teamId].rev >= 0;

  // agents: what the server saw (last MCP call, claims), plus names that only appear in reports and questions
  const seen = S.gardenAgents();
  const names = new Set<string>([...(seen ?? []).map(who), ...rows.filter((x) => x.r).map((x) => who(x.r)), ...decisions.map(who)]);
  const agents = [...names].map((name) => {
    const srv = seen?.find((a) => who(a) === name);
    const mine = rows.filter((x) => x.r && who(x.r) === name).sort((a, b) => Date.parse(b.r.createdAt) - Date.parse(a.r.createdAt));
    const latest = mine[0];
    const stuck = decisions.some((d) => who(d) === name && d.blocking);
    // with claims, "building" is what the agent claimed and still renews; without them (older server), its last in-progress report
    const claim = srv?.claims?.find((c: any) => Date.parse(c.until) > Date.now());
    const building: { id: string; note?: string; until?: string; at?: string } | null = seen
      ? claim
        ? { id: claim.specId, note: claim.note, until: claim.until }
        : null
      : (() => {
          const x = mine.find((r) => r.st.key === 'in_progress');
          return x ? { id: x.s.id, at: x.r.createdAt } : null;
        })();
    const connected = !!srv && Date.now() - Date.parse(srv.lastAt) < 15 * 60_000;
    const expires = srv?.tokenExpiresAt ? Date.parse(srv.tokenExpiresAt) : null;
    return {
      name,
      latest,
      stuck,
      building,
      connected,
      lastAt: srv?.lastAt as string | undefined,
      lastTool: srv?.lastTool as string | undefined,
      expires,
      state: stuck ? 'blocked' : building ? 'running' : connected ? 'connected' : 'idle',
    };
  });
  const expiring = agents.filter(
    (a) => a.expires && a.expires - Date.now() < 7 * 86400_000 && a.lastAt && Date.now() - Date.parse(a.lastAt) < 30 * 86400_000,
  );
  const lastAgentCall = Math.max(0, ...agents.map((a) => (a.lastAt ? Date.parse(a.lastAt) : 0)));
  const hookAt = info?.hook?.lastAt ? Date.parse(info.hook.lastAt) : 0;
  // the trigger fired (and was accepted), but no agent has called since: the routine cannot reach this server, or its token stopped working
  const silent =
    !!seen && !paused && !!hookAt && info?.hook?.lastOk !== false && Date.now() - hookAt > 15 * 60_000 && lastAgentCall < hookAt;
  const inDays = (t: number) => {
    const d = Math.ceil((t - Date.now()) / 86400_000);
    return d <= 0 ? 'has expired' : d === 1 ? 'expires tomorrow' : `expires in ${d} days`;
  };
  const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const running = agents.filter((a) => a.state === 'running').length;
  const lastReport = rows
    .filter((x) => x.r)
    .map((x) => Date.parse(x.r.createdAt))
    .sort((a, b) => b - a)[0];

  // pipeline: released specs from new to implemented; a failing or stale check or an outdated report needs attention
  const stalled = (x: (typeof rows)[number]) =>
    !!seen && x.st.key === 'in_progress' && !S.specClaim(x.s.id) && Date.now() - Date.parse(x.r.createdAt) > 2 * 3600_000;
  const bad = (x: (typeof rows)[number]) =>
    S.specDrift(x.s.id).length > 0 ||
    stalled(x) ||
    x.st.key === 'blocked' ||
    x.st.key === 'outdated' ||
    x.checks.some((c) => c.state === 'failing' || c.state === 'stale');
  const cols = [
    { key: 'new', title: 'New', items: rows.filter((x) => x.st.key === 'none') },
    { key: 'progress', title: 'In progress', items: rows.filter((x) => (x.st.key === 'in_progress' || x.st.key === 'partial') && !bad(x)) },
    { key: 'attention', title: 'Needs attention', items: rows.filter((x) => x.st.key !== 'none' && bad(x)), hot: true },
    { key: 'done', title: 'Implemented', items: rows.filter((x) => x.st.key === 'implemented' && !bad(x)) },
  ].filter((c) => c.items.length);
  const activeCol =
    cols.find((c) => c.key === colSel)?.key ?? ['attention', 'progress', 'new', 'done'].find((k) => cols.some((c) => c.key === k)); // phones show one stage: the most urgent one first
  const row = (x: (typeof rows)[number]) => {
    const { s, r } = x;
    return (
      <button type="button" className="gd-row" key={s.id} data-spec={s.id} onClick={() => setReport(s.id)}>
        <span className="grow">
          <b>
            <span className="mono">{s.id}</span> {s.title}
          </b>
          <span>
            {S.specDrift(s.id).length && x.st.key === 'implemented'
              ? `Guardrails changed since the report (${S.specDrift(s.id).join(', ')}) – the agent checks the code again`
              : S.specClaim(s.id)
                ? `${who(S.specClaim(s.id))} is building it · claim until ${clock(S.specClaim(s.id).until)}${r ? ` · ${String(r.summary).split('\n')[0].slice(0, 100)}` : ''}`
                : stalled(x)
                  ? `No agent has worked on it since ${ago(Date.parse(r.createdAt))} – the next run picks it up again`
                  : r
                    ? `${who(r)} · ${ago(Date.parse(r.createdAt))} · ${String(r.summary).split('\n')[0].slice(0, 140)}`
                    : `v${s.version} bloomed${s.releasedAt ? ` ${ago(Date.parse(s.releasedAt))}` : ''} – no report yet`}
          </span>
        </span>
        <SteerChips specId={s.id} />
        <ImplChip spec={s} always />
        <Icon name="chevron" size={14} />
      </button>
    );
  };

  // checks that need a look, and a short feed of what happened
  const allChecks = rows.flatMap((x) => x.checks.map((c) => ({ ...c, spec: x.s })));
  const checkAlerts = allChecks
    .filter((c) => c.state === 'failing' || c.state === 'stale')
    .sort((a, b) => (a.state === 'failing' ? 0 : 1) - (b.state === 'failing' ? 0 : 1));
  const passing = allChecks.filter((c) => c.state === 'passing').length;
  const feed: { t: number; text: string }[] = [
    ...rows
      .filter((x) => x.r)
      .map((x) => ({ t: Date.parse(x.r.createdAt), text: `${who(x.r)} reported on ${x.s.id}: ${STATUS_TEXT[x.r.status] ?? x.r.status}` })),
    ...rows
      .filter((x) => x.s.releasedAt)
      .map((x) => ({ t: Date.parse(x.s.releasedAt!), text: `${x.s.releasedBy ?? 'Someone'} let ${x.s.id} v${x.s.version} bloom` })),
    ...answered
      .filter((d) => d.resolvedAt)
      .map((d) => ({
        t: Date.parse(d.resolvedAt),
        text: `${d.resolvedBy ?? 'Someone'} answered a decision${d.specId ? ` on ${d.specId}` : ''}`,
      })),
  ]
    .filter((e) => Number.isFinite(e.t))
    .sort((a, b) => b.t - a.t)
    .slice(0, 6);

  return (
    <Shell
      single
      master={
        <>
          <Bar title={history ? 'History' : 'Agents'} />
          <div className="scroll">
            <div className="page garden gd-center">
              <div className="viewbar">
                <Link className="btn subtle back-link" to="/">
                  <Icon name="back" size={16} /> Today
                </Link>
                <nav className="seg" aria-label="Agents views">
                  <NavLink to="/activity" className="filter" aria-current={history ? undefined : 'page'}>
                    Activity
                  </NavLink>
                  <NavLink to="/history" className="filter" aria-current={history ? 'page' : undefined}>
                    History
                  </NavLink>
                </nav>
              </div>
              {history ? (
                <HistoryView rows={rows} onOpen={setReport} />
              ) : (
                <>
                  <section className="gd-sum">
                    <div className="gd-top">
                      <div className="gd-stats">
                        <div className={needs ? 'hot' : ''}>
                          <b id="gd-needs">{needs}</b>
                          <span>
                            {needs === 1 ? 'waits for you' : 'wait for you'}
                            {blocking ? ` · ${blocking} block${blocking === 1 ? 's' : ''} an agent` : ''}
                          </span>
                        </div>
                        <div>
                          <b id="gd-done">
                            {done}
                            <small> / {rows.length}</small>
                          </b>
                          <span>specs in bloom implemented</span>
                        </div>
                      </div>
                      <div className="gd-agents" id="gd-agents-status">
                        <span className="st">
                          {paused ? (
                            <>
                              <i className="dot-w" aria-hidden="true" />
                              Agents paused
                            </>
                          ) : (
                            <>
                              <i className={running ? 'dot-ok' : ''} aria-hidden="true" />
                              <b>{running ? `${running} agent${running === 1 ? '' : 's'} running` : 'No agent at work'}</b>
                            </>
                          )}
                        </span>
                        {lastReport && <span className="muted">last report {ago(lastReport)}</span>}
                        {S.can('admin') &&
                          (paused ? (
                            <button type="button" className="btn small" data-act="agent-resume" onClick={() => setPaused(false)}>
                              Resume agents
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="btn small"
                              data-act="agent-pause"
                              onClick={() => {
                                if (confirm('Pause the agents? They get no new work and no webhook calls until you resume.'))
                                  setPaused(true);
                              }}
                            >
                              <Icon name="pause" size={14} /> Pause agents
                            </button>
                          ))}
                      </div>
                    </div>
                    {!synced && <p className="note">Nothing loaded from the server yet – open the app once while online.</p>}
                  </section>
                  {paused && (
                    <section className="card warn" id="gd-paused" role="status">
                      <span style={{ color: 'var(--amber)' }}>
                        <Icon name="warn" size={18} />
                      </span>
                      <div className="grow">
                        <b>Agents are paused</b>
                        <span>
                          They get an empty work list and no webhook calls. Answers and reports are still accepted. When you resume, they
                          pick up everything that is open on their next run.
                        </span>
                      </div>
                    </section>
                  )}
                  {silent && (
                    <section className="card warn" id="gd-silent" role="status">
                      <span style={{ color: 'var(--amber)' }}>
                        <Icon name="warn" size={18} />
                      </span>
                      <div className="grow">
                        <b>No agent came after the trigger</b>
                        <span>
                          The agent trigger was called {ago(hookAt)}, but no agent has connected to this server since. Check that the
                          routine can reach this server and that its token still works.
                        </span>
                      </div>
                      {S.can('admin') && (
                        <Link className="btn small" style={{ flex: 'none' }} to="/team">
                          Agent setup
                        </Link>
                      )}
                    </section>
                  )}
                  {expiring.length > 0 && (
                    <section className="card warn" id="gd-expiring" role="status">
                      <span style={{ color: 'var(--amber)' }}>
                        <Icon name="warn" size={18} />
                      </span>
                      <div className="grow">
                        <b>{expiring.length === 1 ? 'An agent token runs out' : `${expiring.length} agent tokens run out`}</b>
                        <span>
                          {expiring.map((a) => `${a.name}: ${inDays(a.expires!)}`).join(' · ')}. Create a new token under Account → Agent
                          access and put it into the agent's settings, or the agent stops working.
                        </span>
                      </div>
                      <Link className="btn small" style={{ flex: 'none' }} to="/account">
                        Agent access
                      </Link>
                    </section>
                  )}
                  {gitFailed && (
                    <section className="card bad" id="gd-git" role="status">
                      <span style={{ color: 'var(--red)' }}>
                        <Icon name="warn" size={18} />
                      </span>
                      <div className="grow">
                        <b>The last Git push failed</b>
                        <span>
                          {String(git.lastError ?? 'The team repository could not be pushed.')
                            .split('\n')[0]
                            .slice(0, 160)}{' '}
                          Specs in bloom do not reach the remote until it works.
                        </span>
                      </div>
                      {S.can('approve') && (
                        <button type="button" className="btn small" style={{ flex: 'none' }} data-act="git-push" onClick={pushNow}>
                          Push now
                        </button>
                      )}
                      <Link className="btn small" style={{ flex: 'none' }} to="/release">
                        Git and agent connection
                      </Link>
                    </section>
                  )}

                  <div className="gd-grid">
                    <aside className="gd-side" aria-label="Agents">
                      {(agents.length > 0 || info?.hook) && (
                        <section id="gd-agents">
                          <div className="sect-title">
                            <span>Agents</span>
                            <small>{agents.length}</small>
                          </div>
                          <div className="list-card">
                            {agents.map((a) => (
                              <div className="gd-row static" key={a.name}>
                                <span className="grow">
                                  <b>{a.name}</b>
                                  <span>
                                    {a.state === 'blocked'
                                      ? 'Waiting for a decision'
                                      : a.building
                                        ? `Building ${a.building.id}${a.building.note ? ` – ${a.building.note}` : ''}${a.building.until ? ` · claim until ${clock(a.building.until)}` : a.building.at ? ` · ${ago(Date.parse(a.building.at))}` : ''}`
                                        : a.connected
                                          ? `Connected · last call ${ago(Date.parse(a.lastAt!))}${a.lastTool ? ` (${a.lastTool})` : ''}`
                                          : a.lastAt
                                            ? `Last seen ${ago(Date.parse(a.lastAt))}${a.latest ? ` · last report on ${a.latest.s.id}` : ''}`
                                            : a.latest
                                              ? `Last report ${ago(Date.parse(a.latest.r.createdAt))} on ${a.latest.s.id}`
                                              : 'Asked a question'}
                                    {a.expires && a.expires - Date.now() < 7 * 86400_000 ? ` · token ${inDays(a.expires)}` : ''}
                                  </span>
                                </span>
                                <span className={`st ${a.state === 'blocked' ? 'warn' : ''}`} data-agent-state={a.state}>
                                  <i
                                    className={
                                      a.state === 'running' || a.state === 'connected' ? 'dot-ok' : a.state === 'blocked' ? 'dot-w' : ''
                                    }
                                    aria-hidden="true"
                                  />
                                  {a.state === 'blocked'
                                    ? 'Blocked'
                                    : a.state === 'running'
                                      ? 'Building'
                                      : a.state === 'connected'
                                        ? 'Connected'
                                        : 'Idle'}
                                </span>
                              </div>
                            ))}
                            {info?.hook && (
                              <div className="gd-row static">
                                <span className="grow">
                                  <b>Agent trigger</b>
                                  <span>
                                    {info.hook.lastAt
                                      ? `Last call ${ago(Date.parse(info.hook.lastAt))}${info.hook.lastInfo ? ` · ${String(info.hook.lastInfo).slice(0, 60)}` : ''}`
                                      : 'Not called yet'}
                                  </span>
                                </span>
                                {S.can('admin') && (
                                  <button type="button" className="btn small ghost" data-act="hook-test" onClick={testTrigger}>
                                    Send test
                                  </button>
                                )}
                                <span className={`st ${info.hook.lastOk === false ? 'bad' : ''}`}>
                                  {info.hook.lastOk === false ? (
                                    <>
                                      <i className="dot-b" aria-hidden="true" />
                                      Failed
                                    </>
                                  ) : info.hook.lastOk ? (
                                    <>
                                      <Icon name="check" size={14} />
                                      OK
                                    </>
                                  ) : null}
                                </span>
                              </div>
                            )}
                          </div>
                        </section>
                      )}
                    </aside>
                  </div>

                  <section id="gd-impl">
                    <div className="sect-title">
                      <span>Pipeline</span>
                      <small>
                        {done} of {rows.length} specs in bloom implemented
                      </small>
                    </div>
                    {!rows.length && <p className="quiet">Nothing in bloom yet. Agents start when a spec blooms.</p>}
                    {cols.length > 1 && (
                      <div className="seg seg-fill gd-seg" role="group" aria-label="Pipeline stage">
                        {cols.map((c) => (
                          <button
                            key={c.key}
                            type="button"
                            className="filter"
                            aria-pressed={activeCol === c.key}
                            onClick={() => setColSel(c.key)}
                          >
                            {c.title} {c.items.length}
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="gd-pipe">
                      {cols.map((c) => (
                        <div className="gd-col" key={c.key} data-col={c.key} data-active={activeCol === c.key}>
                          <div className="sect-title">
                            <span>{c.title}</span>
                            <small style={c.hot ? { color: 'var(--red)' } : undefined}>{c.items.length}</small>
                          </div>
                          <div className="list-card">{c.items.map(row)}</div>
                        </div>
                      ))}
                    </div>
                  </section>

                  {(checkAlerts.length > 0 || feed.length > 0) && (
                    <div className="gd-two">
                      {checkAlerts.length > 0 && (
                        <section id="gd-checks">
                          <div className="sect-title">
                            <span>Checks</span>
                            <small>{passing} passing</small>
                          </div>
                          <div className="list-card">
                            {checkAlerts.slice(0, 6).map((c) => (
                              <button
                                type="button"
                                className="gd-row"
                                key={`${c.spec.id}:${c.name}`}
                                data-state={c.state}
                                onClick={() => setReport(c.spec.id)}
                              >
                                <span className="grow">
                                  <b>{c.name}</b>
                                  <span>
                                    <span className="mono">{c.spec.id}</span> · {c.kind}
                                    {c.last ? ` · ${ago(Date.parse(c.last.at))}` : ' · never ran'}
                                  </span>
                                </span>
                                <span className={`chip ${c.state === 'failing' ? 'bad' : 'warn'}`}>
                                  {c.state === 'failing' ? 'Failing' : 'Stale'}
                                </span>
                              </button>
                            ))}
                          </div>
                        </section>
                      )}
                      {feed.length > 0 && (
                        <section id="gd-activity">
                          <div className="sect-title">
                            <span>Activity</span>
                          </div>
                          <div className="list-card">
                            {feed.map((e, i) => (
                              <div className="gd-ev" key={i}>
                                <time>{ago(e.t)}</time>
                                <span>{e.text}</span>
                              </div>
                            ))}
                          </div>
                        </section>
                      )}
                    </div>
                  )}

                  <Hint id="garden-intro">
                    Agents build what is in bloom. They ask on Today when a spec leaves a choice open, and report here what they built.
                  </Hint>
                  {S.can('admin') && (
                    <p className="note gd-foot">
                      Agents are connected under <Link to="/team">Members &amp; Git</Link>: the trigger that starts them when a spec blooms,
                      and the prompt they work with.
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
          {report && <ReportSheet specId={report} link onClose={() => setReport(null)} />}
        </>
      }
    />
  );
}
