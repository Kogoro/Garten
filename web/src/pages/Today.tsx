import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { parseTermFile } from '@shared/glossaryFiles.js';
import { parseRuleFile } from '@shared/guardrailFiles.js';
import { DecisionCard, FbItem, useFbAct } from '../feedback';
import { Bar, Shell } from '../Shell';
import { Fab } from '../Fab';
import { NewSpecSheet } from '../sheets';
import { GrowthIcon, STAGE_NAME, STAGE_TIP, stageOf, type Stage } from '../growth';
import { awaitsApproval } from '../lib';
import { useTeamInfo } from '../hooks';
import { Icon, ago, touched, useStore } from '../ui';
import { ApproveButton } from './ItemEditor';
import type { Item } from '../store/types';

/** The name of an agent, from a report or question (via), a claim (by) or the server's agent list (name). */
const who = (x: any) => String(x?.via ?? x?.by ?? x?.name ?? x?.author ?? 'An agent').replace(/^(token|agent):\s*/i, '');
const BED = 5;

type Card = { key: string; kind: 'decision' | 'feedback' | 'approve' | 'term' | 'rule'; agent: boolean; node: ReactNode };

/** Everything that waits for a person, most urgent first: decisions (blocking first), feedback, sprouts to let bloom, proposals. */
function useCards(): Card[] {
  const S = useStore();
  const act = useFbAct();
  const approver = S.can('approve');
  const cards: Card[] = [];
  S.openDecisions().forEach((f) =>
    cards.push({ key: `d:${f.id}`, kind: 'decision', agent: true, node: <DecisionCard f={f} showSpec act={act} /> }),
  );
  S.openFeedback().forEach((f) =>
    cards.push({ key: `f:${f.id}`, kind: 'feedback', agent: true, node: <FbItem f={f} showSpec act={act} /> }),
  );
  if (approver) {
    S.all('spec')
      .filter((x) => awaitsApproval(S, x) && !x.approve)
      .sort((a, b) => touched(b) - touched(a))
      .forEach((x) => cards.push({ key: `a:${x.id}`, kind: 'approve', agent: false, node: <ApproveCard i={x} /> }));
    S.proposedItems().forEach((d) => cards.push({ key: `t:${d.id}`, kind: 'term', agent: true, node: <ProposalCard d={d} kind="term" /> }));
    S.proposedRuleItems().forEach((d) =>
      cards.push({ key: `r:${d.id}`, kind: 'rule', agent: true, node: <ProposalCard d={d} kind="rule" /> }),
    );
  }
  return cards;
}

function ApproveCard({ i }: { i: Item }) {
  const S = useStore();
  return (
    <article className="tcard" data-spec={i.id}>
      <div className="tc-from">
        {i.updatedBy && <span className="who">{i.updatedBy.trim()[0]?.toUpperCase()}</span>}
        <span>
          {i.updatedBy ? `${i.updatedBy} · ` : ''}
          <span className="mono">{i.id}</span> · {ago(touched(i))}
        </span>
      </div>
      <h2 className="tc-title">{i.title} is ready to bloom</h2>
      <p className="muted">
        {i.status === 'approved' ? `Edited since v${i.version}.` : 'A seed with a title.'} Once it blooms, agents can read it.
      </p>
      <div className="tc-acts">
        <Link className="btn" to={`/spec/${encodeURIComponent(i.id)}`}>
          Read
        </Link>
        <ApproveButton i={i} S={S} />
      </div>
    </article>
  );
}

function ProposalCard({ d, kind }: { d: Item; kind: 'term' | 'rule' }) {
  const t = kind === 'term' ? parseTermFile(d.body) : null;
  const r = kind === 'rule' ? parseRuleFile(d.body) : null;
  const by = (t ?? r)?.proposedBy ?? 'An agent';
  const to = kind === 'term' ? `/glossary/~proposed/${encodeURIComponent(d.id)}` : `/guardrails/${encodeURIComponent(d.id)}`;
  return (
    <article className="tcard" data-proposal={d.id}>
      <div className="tc-from">
        <span className="who agent">
          <Icon name="agent" size={13} />
        </span>
        <span>
          {by}
          {(t ?? r)?.from ? (
            <>
              {' '}
              from <span className="mono">{(t ?? r)!.from}</span>
            </>
          ) : null}
        </span>
      </div>
      <h2 className="tc-title">{kind === 'term' ? `${by} proposes a word: ${t?.term}` : `${by} proposes a guardrail`}</h2>
      <p className="muted">{kind === 'term' ? String(t?.body ?? '').split('\n')[0] : r?.rule}</p>
      <div className="tc-acts">
        <Link className="btn primary" to={to}>
          Review
        </Link>
      </div>
    </article>
  );
}

function headline(cards: Card[]) {
  if (!cards.length)
    return (
      <>
        Nothing waits for you. <em>The garden grows.</em>
      </>
    );
  const q = cards.filter((c) => c.kind === 'decision' || c.kind === 'feedback').length,
    a = cards.filter((c) => c.kind === 'approve').length,
    p = cards.length - q - a;
  const parts = [
    q && `${q} question${q > 1 ? 's' : ''} from agents`,
    a && `${a} approval${a > 1 ? 's' : ''}`,
    p && `${p} proposal${p > 1 ? 's' : ''}`,
  ].filter(Boolean) as string[];
  if (parts.length > 2)
    return (
      <>
        <em>{cards.length} things</em> wait for you.
      </>
    );
  return (
    <>
      <em>{parts.join(' and ')}</em> wait{cards.length > 1 ? '' : 's'} for you.
    </>
  );
}

/** One line on what the agents do: who is at work, what happened last. Opens Agents. */
function AgentLine() {
  const S = useStore();
  const seen = S.gardenAgents() ?? [];
  const working = seen.filter((a: any) => a.claims?.some((c: any) => Date.parse(c.until) > Date.now())).length;
  const needs = S.feedbackTotal();
  const last = S.all('spec')
    .map((s) => ({ s, r: S.latestReport(s.id) }))
    .filter((x) => x.r)
    .sort((a, b) => Date.parse(b.r.createdAt) - Date.parse(a.r.createdAt))[0];
  const paused = !!S.team()?.agentPaused;
  return (
    <Link className="agentline" to="/activity" data-act="agent-line">
      <span className={`adot ${paused ? 'waiting' : working ? 'busy' : ''}`} aria-hidden="true" />
      <span className="txt">
        <b>{paused ? 'Agents paused' : `${working || 'No'} agent${working === 1 ? '' : 's'} working`}</b>
        {' · '}
        <b id="gd-needs">{needs}</b> waiting for you
        {last ? ` · ${who(last.r)} reported on ${last.s.id}, ${ago(Date.parse(last.r.createdAt))}` : ''}
      </span>
      <Icon name="chevron" size={14} />
    </Link>
  );
}

/** Notices that need a person now: paused agents, a failed push, work that waits to sync, a rejected change. */
function Notices() {
  const S = useStore();
  const { info } = useTeamInfo();
  const paused = !!S.team()?.agentPaused;
  const git = info?.git;
  const queued = S.all('spec').filter((x) => x.approve);
  const waiting = S.fbPending();
  return (
    <>
      {paused && (
        <section className="card warn" id="gd-paused" role="status">
          <span style={{ color: 'var(--amber)' }}>
            <Icon name="warn" size={18} />
          </span>
          <div className="grow">
            <b>Agents are paused</b>
            <span>They get an empty work list until someone resumes them under Agents.</span>
          </div>
        </section>
      )}
      {!!git?.url && git.lastOk === false && (
        <section className="card bad" id="gd-git" role="status">
          <span style={{ color: 'var(--red)' }}>
            <Icon name="warn" size={18} />
          </span>
          <div className="grow">
            <b>The last Git push failed</b>
            <span>
              {String(git.lastError ?? 'The team repository could not be pushed.')
                .split('\n')[0]
                .slice(0, 160)}
            </span>
          </div>
          <Link className="btn small" style={{ flex: 'none' }} to="/activity">
            Agents
          </Link>
        </section>
      )}
      {queued.length > 0 && (
        <section className="card warn" id="gd-queued">
          <span style={{ color: 'var(--amber)' }}>
            <Icon name="up" size={18} />
          </span>
          <div className="grow">
            <b>
              {queued.length} spec{queued.length === 1 ? '' : 's'} bloom{queued.length === 1 ? 's' : ''} after sync
            </b>
            <span>{queued.map((x) => x.id).join(', ')}</span>
          </div>
        </section>
      )}
      {waiting > 0 && (
        <section className="card warn" id="gd-waiting">
          <span style={{ color: 'var(--amber)' }}>
            <Icon name="up" size={18} />
          </span>
          <div className="grow">
            <b>
              {waiting} answer{waiting === 1 ? '' : 's'} waiting to sync
            </b>
            <span>{S.state.online ? 'Sending…' : 'Sent as soon as the server is reachable.'}</span>
          </div>
        </section>
      )}
      {S.state.gardenNotice && (
        <section className="card bad" id="gd-notice">
          <span style={{ color: 'var(--red)' }}>
            <Icon name="warn" size={18} />
          </span>
          <div className="grow">
            <b>Not accepted by the server</b>
            <span>{S.state.gardenNotice}</span>
          </div>
          <button className="btn small" style={{ flex: 'none' }} onClick={S.dismissGardenNotice}>
            OK
          </button>
        </section>
      )}
    </>
  );
}

/** The stack: one card at a time; "Later" puts it at the back; answered cards leave and the next one rises. */
function Deck({ cards }: { cards: Card[] }) {
  const [later, setLater] = useState<string[]>([]);
  const order = useMemo(() => {
    const rank = (k: string) => later.indexOf(k);
    return [...cards].sort((a, b) => rank(a.key) - rank(b.key));
  }, [cards, later]);
  if (!order.length) return null;
  const top = order[0];
  return (
    <div className="deck" id="gd-needs-list" data-left={Math.min(order.length - 1, 2)}>
      <div className="deck-card" key={top.key} data-kind={top.kind}>
        <div className="deck-pos">
          {order.length > 1 ? (
            <Link to="/queue" className="ref">
              1 of {order.length} · See all
            </Link>
          ) : (
            <span>1 of 1</span>
          )}
          {order.length > 1 && (
            <button
              type="button"
              className="skip-later"
              data-act="later"
              onClick={() => setLater((l) => [...l.filter((k) => k !== top.key), top.key])}
            >
              Later
            </button>
          )}
        </div>
        {top.node}
      </div>
    </div>
  );
}

/** The decisions answered on this device or lately: an answer can still be changed or written into the spec. */
function Answered() {
  const S = useStore();
  const act = useFbAct();
  const recent = S.answeredDecisions()
    .filter((d) => !d.resolvedAt || Date.now() - Date.parse(d.resolvedAt) < 7 * 86400_000)
    .slice(0, 3);
  if (!recent.length) return null;
  return (
    <details
      className="answered"
      id="gd-answered"
      open={S.fbPending() > 0 || recent.some((d) => !d.resolvedAt || Date.now() - Date.parse(d.resolvedAt) < 86400_000)}
    >
      <summary>Recently answered · {recent.length}</summary>
      <div className="fb-list">
        {recent.map((d) => (
          <DecisionCard key={d.id} f={d} showSpec act={act} />
        ))}
      </div>
    </details>
  );
}

function Beds() {
  const S = useStore();
  const [newSpec, setNewSpec] = useState(false);
  const specs = S.all('spec').sort((a, b) => touched(b) - touched(a));
  const by = (st: Stage) => specs.filter((s) => stageOf(S, s) === st);
  return (
    <section className="beds-wrap" aria-labelledby="beds-h">
      <div className="sechead">
        <h2 id="beds-h" className="h-sec">
          <Link className="hlink" to="/specs">
            Specs <span className="n">{specs.length}</span>
            <Icon name="chevron" size={14} />
          </Link>
        </h2>
        {S.can('write') && (
          <button type="button" className="btn plant-btn only-desktop" data-act="new-spec" onClick={() => setNewSpec(true)}>
            <GrowthIcon stage="seed" size={16} /> Plant a spec
          </button>
        )}
      </div>
      <div className="beds">
        {(['seed', 'sprout', 'bloom'] as Stage[]).map((st) => {
          const list = by(st);
          return (
            <section className="bed" data-stage={st} key={st}>
              <Link className="bed-head" to={`/specs?stage=${st}`} title={STAGE_TIP[st]}>
                <GrowthIcon stage={st} size={20} />
                <h3>{STAGE_NAME[st]}</h3>
                <span className="n">{list.length}</span>
                <Icon name="chevron" size={14} />
              </Link>
              {list.slice(0, BED).map((s) => (
                <Link key={s.id} className="plant" to={`/spec/${encodeURIComponent(s.id)}`} data-spec={s.id}>
                  <span className="t">{s.title || <span className="muted">Untitled spec</span>}</span>
                  <span className="m">
                    <span className="mono">{s.id}</span> · {st === 'bloom' ? `v${s.version}` : ago(touched(s))}
                  </span>
                </Link>
              ))}
              {!list.length && (
                <p className="quiet">
                  {st === 'seed' ? 'No seeds.' : st === 'sprout' ? 'Nothing waits for approval.' : 'Nothing in bloom yet.'}
                </p>
              )}
            </section>
          );
        })}
      </div>
      {S.can('write') && <Fab label="Plant a spec" act="new-spec" onClick={() => setNewSpec(true)} />}
      {newSpec && <NewSpecSheet onClose={() => setNewSpec(false)} />}
    </section>
  );
}

const today = () => new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

/** Today: the one place to act. What waits for a person, one line about the agents, and every spec by stage. Works offline. */
export function TodayPage() {
  const S = useStore();
  const cards = useCards();
  const synced = !!S.state.garden[S.state.teamId] && S.state.garden[S.state.teamId].rev >= 0;
  return (
    <Shell
      single
      master={
        <>
          <Bar title="Today" quiet />
          <div className="scroll">
            <div className="page today">
              <div className="kicker">{today()}</div>
              <p className="headline" id="headline">
                {headline(cards)}
              </p>
              <AgentLine />
              {!synced && <p className="note">Nothing loaded from the server yet – open the app once while online.</p>}
              <Notices />
              <Deck cards={cards} />
              <Answered />
              <Beds />
            </div>
          </div>
        </>
      }
    />
  );
}

/** Everything that waits for a person, as one list (the stack on Today shows one card at a time). */
export function QueuePage() {
  const cards = useCards();
  const [f, setF] = useState<'all' | 'questions' | 'approvals' | 'proposals'>('all');
  const kindOf = (c: Card) => (c.kind === 'approve' ? 'approvals' : c.kind === 'term' || c.kind === 'rule' ? 'proposals' : 'questions');
  const n = (k: string) => cards.filter((c) => k === 'all' || kindOf(c) === k).length;
  const shown = f !== 'all' && !n(f) ? 'all' : f;
  return (
    <Shell
      single
      active="queue"
      master={
        <>
          <Bar title="Needs you" />
          <div className="scroll">
            <div className="page">
              <Link className="btn subtle back-link" to="/">
                <Icon name="back" size={16} /> Today
              </Link>
              <div className="seg" role="group" aria-label="Show">
                {(['all', 'questions', 'approvals', 'proposals'] as const).map((k) => (
                  <button key={k} type="button" className="filter" aria-pressed={shown === k} onClick={() => setF(k)}>
                    {k[0].toUpperCase() + k.slice(1)} {n(k)}
                  </button>
                ))}
              </div>
              {!cards.length && <p className="quiet">Nothing waits for you.</p>}
              <div className="queue">
                {cards
                  .filter((c) => shown === 'all' || kindOf(c) === shown)
                  .map((c) => (
                    <div className="queue-item" key={c.key} data-kind={c.kind}>
                      {c.node}
                    </div>
                  ))}
              </div>
              <Answered />
            </div>
          </div>
        </>
      }
    />
  );
}
