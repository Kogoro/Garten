import { useState } from 'react';
import { Link } from 'react-router-dom';
import { DecisionCard, FbItem, useFbAct } from '../feedback';
import { ImplChip, ReportSheet, implState } from '../reports';
import { Bar, Shell } from '../Shell';
import { Icon, ago, useStore } from '../ui';

/** The gardener's view: what agents ask, what they found, and how far they are with every released spec. Works offline. */
export function GardenPage() {
  const S = useStore();
  const act = useFbAct();
  const [report, setReport] = useState<string | null>(null);
  const decisions = S.openDecisions(), feedback = S.openFeedback(), answered = S.answeredDecisions().slice(0, 10);
  const waiting = S.fbPending();
  const rows = S.all('spec').filter((s) => s.status === 'approved').map((s) => ({ s, r: S.latestReport(s.id), st: implState(s, S.latestReport(s.id)) }))
    .sort((a, b) => a.st.rank - b.st.rank || a.s.id.localeCompare(b.s.id));
  const done = rows.filter((x) => x.st.key === 'implemented').length;
  const needs = decisions.length + feedback.length;
  const blocking = decisions.filter((d) => d.blocking).length;
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
          <p className="note">Agents build what you release. They ask here when a spec leaves a choice open, and report what they built. You answer and adjust the specs – also offline; answers are sent with the next sync.</p>
          {!synced && <p className="note">Nothing loaded from the server yet – open the app once while online.</p>}
        </section>
        {waiting > 0 && <section className="card warn" id="gd-waiting"><span style={{ color: 'var(--amber)' }}><Icon name="up" size={18} /></span><div className="grow"><b>{waiting} answer{waiting === 1 ? '' : 's'} waiting to sync</b><span>Saved on this device. {S.state.online ? 'Sending…' : 'Sent as soon as the server is reachable – the agent continues after that.'}</span></div></section>}
        {S.state.gardenNotice && <section className="card bad" id="gd-notice"><span style={{ color: 'var(--red)' }}><Icon name="warn" size={18} /></span><div className="grow"><b>Not accepted by the server</b><span>{S.state.gardenNotice}</span></div><button className="btn small" style={{ flex: 'none' }} onClick={S.dismissGardenNotice}>OK</button></section>}

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

        {S.can('admin') && <p className="note gd-foot">Agents are connected under <Link to="/team">Members &amp; Git</Link>: the trigger that starts them on a release, and the prompt they work with.</p>}
      </div></div>
      {report && <ReportSheet specId={report} link onClose={() => setReport(null)} />}
    </>} />
  );
}
