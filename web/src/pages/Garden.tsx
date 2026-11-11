import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { DecisionCard, FbItem, useFbAct } from '../feedback';
import { ImplChip, ReportSheet, implState } from '../reports';
import { Bar, Shell } from '../Shell';
import { Icon, ago, toast, touched, useStore } from '../ui';
import { Hint } from '../Hint';
import { awaitsApproval } from '../lib';

const dur = (h: number | null | undefined) => (h == null ? '–' : h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`);
/** How the process runs, from data the app already has: nothing is collected or sent anywhere. */
function Health() {
  const S = useStore();
  const [m, setM] = useState<any | null>(null);
  useEffect(() => { let on = true; if (S.state.online) S.teamApi('GET', '/metrics').then((d: any) => on && setM(d.metrics)).catch(() => { /* offline or no access: no card */ }); return () => { on = false; }; }, [S.state.teamId, S.state.online]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!m) return null;
  const i = m.implementation;
  return (
    <details className="card health" id="gd-health">
      <summary><b>Team health</b><small className="muted"> last {m.days} days · computed on this server only</small></summary>
      <dl className="kvgrid">
        <div><dt>Released</dt><dd>{m.releasedInPeriod} of {m.releasedSpecs} specs</dd></div>
        <div><dt>Draft to release</dt><dd>{dur(m.medianHoursDraftToRelease)} <small>median</small></dd></div>
        <div><dt>Answering agents</dt><dd>{dur(m.medianHoursToAnswer)} <small>median, {m.decisionsAnswered} answered</small></dd></div>
        <div><dt>Waiting for you</dt><dd>{m.openDecisions} <small>{m.openDecisions ? `oldest ${dur(m.oldestOpenDecisionHours)}` : ''}</small></dd></div>
        <div><dt>Implemented</dt><dd>{i.implemented} <small>of {m.releasedSpecs}{i.blocked ? ` · ${i.blocked} blocked` : ''}{i.outdated ? ` · ${i.outdated} outdated` : ''}{i.none ? ` · ${i.none} not started` : ''}</small></dd></div>
        {m.claimsVerified && <div><dt>Claims proven by checks</dt><dd>{m.claimsVerified.verified} of {m.claimsVerified.met}</dd></div>}
      </dl>
    </details>
  );
}

/** The gardener's view: what agents ask, what they found, and how far they are with every released spec. Works offline. */
export function GardenPage() {
  const S = useStore();
  const act = useFbAct();
  const [report, setReport] = useState<string | null>(null);
  const decisions = S.openDecisions(), feedback = S.openFeedback(), answered = S.answeredDecisions().slice(0, 10);
  const waiting = S.fbPending();
  const toApprove = S.can('approve') ? S.all('spec').filter((x) => awaitsApproval(S, x)).sort((a, b) => touched(b) - touched(a)) : [];
  const rows = S.all('spec').filter((s) => s.status === 'approved').map((s) => ({ s, r: S.latestReport(s.id), st: implState(s, S.latestReport(s.id)) }))
    .sort((a, b) => a.st.rank - b.st.rank || a.s.id.localeCompare(b.s.id));
  const done = rows.filter((x) => x.st.key === 'implemented').length;
  const needs = decisions.length + feedback.length;
  const blocking = decisions.filter((d) => d.blocking).length;
  const paused = !!S.team()?.agentPaused;
  const working = rows.filter((x) => x.st.key === 'in_progress');
  async function setPaused(on: boolean) {
    try { await S.teamApi('PATCH', '', { agentPaused: on }); await S.refreshMe(); toast(on ? 'Agents paused' : 'Agents resumed'); } catch (e: any) { toast(e instanceof TypeError ? 'Pausing needs a connection to the server.' : e.message); }
  }
  const synced = !!S.state.garden[S.state.teamId] && S.state.garden[S.state.teamId].rev >= 0;
  return (
    <Shell single master={<>
      <Bar title="Garden" />
      <div className="scroll"><div className="page garden">
        <section className="card gd-sum">
          <div className="gd-stats">
            <div className={needs ? 'hot' : ''}><b id="gd-needs">{needs}</b><span>{needs === 1 ? 'waits for you' : 'wait for you'}{blocking ? ` · ${blocking} block${blocking === 1 ? 's' : ''} an agent` : ''}</span></div>
            <div><b id="gd-done">{done}<small> / {rows.length}</small></b><span>released specs implemented</span></div>
          </div>
          <Hint id="garden-intro">Agents build what you release. They ask here when a spec leaves a choice open, and report what they built. You answer and adjust the specs – also offline; answers are sent with the next sync.</Hint>
          {!synced && <p className="note">Nothing loaded from the server yet – open the app once while online.</p>}
        </section>
        {paused && <section className="card warn" id="gd-paused" role="status"><span style={{ color: 'var(--amber)' }}><Icon name="warn" size={18} /></span><div className="grow"><b>Agents are paused</b><span>They get an empty work list and no webhook calls. Answers and reports are still accepted. When you resume, they pick up everything that is open on their next run.</span></div>{S.can('admin') && <button type="button" className="btn small" data-act="agent-resume" onClick={() => setPaused(false)}>Resume agents</button>}</section>}
        {waiting > 0 && <section className="card warn" id="gd-waiting"><span style={{ color: 'var(--amber)' }}><Icon name="up" size={18} /></span><div className="grow"><b>{waiting} answer{waiting === 1 ? '' : 's'} waiting to sync</b><span>Saved on this device. {S.state.online ? 'Sending…' : 'Sent as soon as the server is reachable – the agent continues after that.'}</span></div></section>}
        {S.state.gardenNotice && <section className="card bad" id="gd-notice"><span style={{ color: 'var(--red)' }}><Icon name="warn" size={18} /></span><div className="grow"><b>Not accepted by the server</b><span>{S.state.gardenNotice}</span></div><button className="btn small" style={{ flex: 'none' }} onClick={S.dismissGardenNotice}>OK</button></section>}

        {working.length > 0 && <section id="gd-working">
          <div className="sect-title"><span>Agents at work</span><small>{working.length}</small></div>
          {working.map(({ s, r }) => <button type="button" className="gd-row" key={s.id} data-spec={s.id} onClick={() => setReport(s.id)}><span className="grow"><b><span className="mono">{s.id}</span> {s.title}</b><span>{r ? `${r.via ?? r.author} · started ${ago(Date.parse(r.createdAt))} · ${String(r.summary).split('\n')[0].slice(0, 140)}` : ''}</span></span><ImplChip spec={s} always /></button>)}
        </section>}

        {toApprove.length > 0 && <section id="gd-approve">
          <div className="sect-title"><span>Ready to approve</span><small>{toApprove.length}</small></div>
          {toApprove.slice(0, 8).map((x) => <Link key={x.id} className="gd-row" to={`/spec/${encodeURIComponent(x.id)}`} data-spec={x.id}><span className="grow"><b><span className="mono">{x.id}</span> {x.title}</b><span>{x.status === 'approved' ? `Edited since v${x.version}` : 'Draft'} · {ago(touched(x))}</span></span><span className="chip">{x.status === 'approved' ? `v${x.version + 1}` : 'new'}</span></Link>)}
          {toApprove.length > 8 && <Link className="btn" to="/" onClick={() => { try { localStorage.setItem("specs-pref-specs-filter", "pending"); } catch { /* private mode */ } }}>Show all {toApprove.length} in Specs</Link>}
        </section>}

        <section id="gd-needs-list">
          <div className="sect-title"><span>Needs you</span><small style={{ color: needs ? 'var(--amber)' : undefined }}>{decisions.length} decision{decisions.length === 1 ? '' : 's'} · {feedback.length} feedback</small></div>
          {!needs && <div className="gd-empty"><Icon name="check" size={18} /><span>Nothing waits for you. Agents ask here when a spec leaves a choice open.</span></div>}
          <div className="fb-list">
            {decisions.map((d) => <DecisionCard key={d.id} f={d} showSpec act={act} />)}
            {feedback.map((f) => <FbItem key={f.id} f={f} showSpec act={act} />)}
          </div>
        </section>

        <section id="gd-impl">
          <div className="sect-title"><span>Implementation</span><small>{done} of {rows.length} released specs implemented</small></div>
          {!rows.length && <div className="gd-empty"><span>No released specs yet. Agents start when you approve a spec under <Link to="/release">Release</Link>.</span></div>}
          {rows.map(({ s, r }) => (
            <button type="button" className="gd-row" key={s.id} data-spec={s.id} onClick={() => setReport(s.id)}>
              <span className="grow"><b><span className="mono">{s.id}</span> {s.title}</b><span>{r ? `${r.via ?? r.author} · ${ago(Date.parse(r.createdAt))} · ${String(r.summary).split('\n')[0].slice(0, 140)}` : `v${s.version} released${s.releasedAt ? ` ${ago(Date.parse(s.releasedAt))}` : ''} – no report yet`}</span></span>
              <ImplChip spec={s} always />
            </button>
          ))}
        </section>

        {answered.length > 0 && <section id="gd-answered">
          <div className="sect-title"><span>Recently answered</span><small>{answered.length}</small></div>
          <div className="fb-list">{answered.map((d) => <DecisionCard key={d.id} f={d} showSpec act={act} />)}</div>
        </section>}

        <Health />

        {S.can('admin') && !paused && <div className="btns"><button type="button" className="btn small" data-act="agent-pause" onClick={() => { if (confirm('Pause the agents? They get no new work and no webhook calls until you resume.')) setPaused(true); }}>Pause agents</button></div>}
        {S.can('admin') && <p className="note gd-foot">Agents are connected under <Link to="/team">Members &amp; Git</Link>: the trigger that starts them on a release, and the prompt they work with.</p>}
      </div></div>
      {report && <ReportSheet specId={report} link onClose={() => setReport(null)} />}
    </>} />
  );
}
