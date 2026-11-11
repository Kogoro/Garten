import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FormError, Sheet } from './dialogs';
import type { FbPatch } from './store/core';
import { Icon, ago, toast, useStore } from './ui';

export const KINDS: [string, string][] = [['concern', 'Concern'], ['conflict', 'Conflict'], ['question', 'Question'], ['suggestion', 'Suggestion'], ['gap', 'Missing info']];
const kindLabel: Record<string, string> = { ...Object.fromEntries(KINDS), decision: 'Decision' };
const STATUS: Record<string, string> = { open: 'Open', accepted: 'Accepted', dismissed: 'Dismissed', done: 'Done', answered: 'Answered', withdrawn: 'Withdrawn by agent' };
type Act = (f: any, patch: FbPatch, note?: boolean) => void;

/** Appends the finding as a checklist item to a "## REVIEW NOTES" section (created when missing) – an unreleased edit a person can refine. */
export function addReviewNote(body: string, f: { kind: string; section?: string; text: string }): string {
  const line = `- [ ] ${f.kind}${f.section ? ` (${f.section.replace(/^#+\s*/, '')})` : ''}: ${f.text.replace(/\s*\n\s*/g, ' ').trim()}`;
  if (body.includes(line)) return body;
  const m = /^##\s+REVIEW NOTES\s*$/m.exec(body);
  if (!m) return `${body.replace(/\s+$/, '')}\n\n## REVIEW NOTES\n\n${line}\n`;
  const rest = body.slice(m.index + m[0].length);
  const next = /^##\s/m.exec(rest);
  const end = m.index + m[0].length + (next ? next.index : rest.length);
  return `${body.slice(0, end).replace(/\s+$/, '')}\n${line}\n${next ? `\n${body.slice(end)}` : ''}`;
}

/** Triage and answers go through the store: shown at once, kept on the device, sent with the next sync. */
export function useFbAct(after?: (next: any) => void): Act {
  const S = useStore();
  return (f, patch, note) => {
    if (note) { const it = S.get(f.specId); if (it) S.edit(f.specId, { body: addReviewNote(it.body, f) }); }
    const next = S.fbAct(f, patch); // not inside after?.(…): an optional call skips its arguments when there is no callback
    after?.(next);
    if (patch.status === 'dismissed' || patch.status === 'accepted') {
      toast(patch.status === 'dismissed' ? 'Dismissed' : 'Accepted', { label: 'Undo', run: () => { after?.(S.fbAct(f, { status: 'open' })); } });
    }
  };
}

const Waiting = ({ id }: { id: string }) => { const S = useStore(); return S.fbPending(id) ? <span className="chip warn fb-wait" title="Saved on this device – sent with the next sync"><Icon name="up" size={11} /> Waiting to sync</span> : null; };
const SpecRef = ({ f }: { f: any }) => { const S = useStore(); const s = S.get(f.specId); return <Link className="fb-spec" to={`/spec/${encodeURIComponent(f.specId)}`}><span className="mono">{f.specId}</span>{s?.title ? ` · ${s.title}` : ''}</Link>; };

/** One feedback entry with what the team decided about it. */
export function FbItem({ f, version, showSpec, act }: { f: any; version?: number; showSpec?: boolean; act: Act }) {
  const S = useStore();
  return (
    <article className={`fb-item st-${f.status}`} data-kind={f.kind}>
      {showSpec && <SpecRef f={f} />}
      <div className="fb-head"><span className={`chip ${f.kind === 'conflict' || f.kind === 'concern' ? 'warn' : ''}`}>{kindLabel[f.kind] ?? f.kind}</span>{f.section && <span className="mono fb-sec">{f.section}</span>}
        <span className="muted fb-meta">{f.via ?? f.author} · {ago(Date.parse(f.createdAt))}{version !== undefined && f.specVersion !== version ? ` · on v${f.specVersion || 0}` : ''}</span><span className={`chip ${f.status === 'open' ? '' : 'ok'}`}>{STATUS[f.status] ?? f.status}</span><Waiting id={f.id} /></div>
      <p className="fb-text">{f.text}</p>
      {f.evidence && <p className="fb-evidence mono">{f.evidence}</p>}
      {f.reply && <p className="fb-reply"><b>{f.resolvedBy ?? 'Reply'}:</b> {f.reply}</p>}
      {S.can('write') && f.status !== 'withdrawn' && <FeedbackActions f={f} act={act} />}
    </article>
  );
}

function FeedbackActions({ f, act }: { f: any; act: Act }) {
  const [reply, setReply] = useState(f.reply ?? '');
  return (
    <div className="fb-acts">
      <label className="sr" htmlFor={`rp-${f.id}`}>Reply</label>
      <input id={`rp-${f.id}`} className="field" placeholder="Reply (optional)" value={reply} maxLength={2000} onChange={(e) => setReply(e.target.value)} />
      <div className="btns">
        {f.status === 'open'
          ? <><button className="btn small" data-act="fb-accept" onClick={() => act(f, { status: 'accepted', reply })}>Accept</button><button className="btn small" data-act="fb-accept-note" title="Accept and add it to the spec as a checklist item under REVIEW NOTES" onClick={() => act(f, { status: 'accepted', reply }, true)}>Accept &amp; add to spec</button><button className="btn small" data-act="fb-dismiss" onClick={() => act(f, { status: 'dismissed', reply })}>Dismiss</button></>
          : <><button className="btn small" data-act="fb-reopen" onClick={() => act(f, { status: 'open', reply })}>Reopen</button>{f.status === 'accepted' && <button className="btn small" data-act="fb-done" onClick={() => act(f, { status: 'done', reply })}>Mark done</button>}</>}
      </div>
    </div>
  );
}

/** A question an agent asks a person: pick one of its options (or write your own answer). The agent reads the answer on its next run. */
export function DecisionCard({ f, showSpec, act }: { f: any; showSpec?: boolean; act: Act }) {
  const S = useStore();
  const can = S.can('write');
  const open = f.status === 'open', answered = f.status === 'answered';
  const [editing, setEditing] = useState(false);
  const [pick, setPick] = useState<number | null>(answered ? f.answer : null);
  const [note, setNote] = useState<string>(f.reply ?? '');
  const choosing = can && (open || (answered && editing));
  const options: { label: string; detail?: string }[] = f.options ?? [];
  const ready = pick !== null && (pick !== -1 || note.trim() !== '');
  const send = () => { if (!ready) return; act(f, { answer: pick!, reply: note.trim() }); setEditing(false); toast(S.state.online ? 'Answer sent' : 'Answer saved – it is sent when you are online again'); };
  const chosen = answered ? (f.answer >= 0 ? options[f.answer]?.label : 'Own answer') : null;
  return (
    <article className={`dc-item st-${f.status}${f.blocking && open ? ' blocking' : ''}`} data-decision={f.id}>
      {showSpec && <SpecRef f={f} />}
      <div className="fb-head">
        <span className={`chip ${open ? 'warn' : answered ? 'ok' : ''}`}>{open ? (f.blocking ? 'Blocks the agent' : 'Decision') : STATUS[f.status] ?? f.status}</span>{f.section && <span className="mono fb-sec">{f.section}</span>}
        <span className="muted fb-meta">{f.via ?? f.author} asks · {ago(Date.parse(f.createdAt))}</span><Waiting id={f.id} />
      </div>
      <p className="dc-q">{f.text}</p>
      {f.evidence && <p className="fb-evidence">{f.evidence}</p>}
      {choosing ? <>
        <div className="dc-opts" role="group" aria-label="Options">
          {options.map((o, i) => (
            <button type="button" key={i} className="dc-opt" aria-pressed={pick === i} onClick={() => setPick(i)}>
              <span className="dc-radio" /><span className="dc-body"><b>{o.label}</b>{f.recommended === i && <span className="chip agent dc-rec">Recommended</span>}{o.detail && <small>{o.detail}</small>}</span>
            </button>
          ))}
          <button type="button" className="dc-opt other" aria-pressed={pick === -1} onClick={() => setPick(-1)}><span className="dc-radio" /><span className="dc-body"><b>Other answer…</b><small>None of these – write what the agent should do instead.</small></span></button>
        </div>
        <label className="sr" htmlFor={`dn-${f.id}`}>Note for the agent</label>
        <textarea id={`dn-${f.id}`} className="field dc-note" rows={2} maxLength={2000} placeholder={pick === -1 ? 'Your answer (required)' : 'Note for the agent (optional)'} value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="btns">
          <button className="btn primary small" type="button" data-act="dc-send" disabled={!ready} onClick={send}>{answered ? 'Change answer' : 'Send answer'}</button>
          {answered ? <button className="btn small" type="button" onClick={() => { setEditing(false); setPick(f.answer); setNote(f.reply ?? ''); }}>Cancel</button>
            : <button className="btn small" type="button" data-act="dc-dismiss" title="The question needs no answer" onClick={() => act(f, { status: 'dismissed', reply: note.trim() })}>Dismiss</button>}
        </div>
      </> : <>
        {answered && <p className="dc-answer"><Icon name="check" size={14} /><span><b>{chosen}</b>{f.resolvedBy ? ` · ${f.resolvedBy}` : ''}{f.resolvedAt ? ` · ${ago(Date.parse(f.resolvedAt))}` : ''}</span></p>}
        {f.reply && <p className="fb-reply">{f.reply}</p>}
        {!answered && !open && options.length > 0 && <p className="muted dc-closed">Options were: {options.map((o) => o.label).join(' · ')}</p>}
        {can && f.status !== 'withdrawn' && <div className="btns">
          {answered && <button className="btn small" type="button" data-act="dc-change" onClick={() => setEditing(true)}>Change answer</button>}
          {!open && <button className="btn small" type="button" data-act="dc-reopen" onClick={() => { act(f, { status: 'open' }); setPick(null); }}>Reopen</button>}
        </div>}
        {open && !can && <p className="muted dc-closed">Options: {options.map((o) => o.label).join(' · ')}</p>}
      </>}
    </article>
  );
}

/** Feedback on one spec: what agents (or people) found, what they ask, and what the team decided about it. */
export function FeedbackSheet({ specId, version, onClose }: { specId: string; version: number; onClose: () => void }) {
  const S = useStore();
  const [remote, setRemote] = useState<any[] | null>(null); // the full history, when the server is reachable
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const can = S.can('write');
  const rev = S.state.garden[S.state.teamId]?.rev;
  const load = async () => { try { setRemote((await S.teamApi('GET', `/feedback?spec=${encodeURIComponent(specId)}`)).feedback); } catch { /* offline: the copy on this device is shown */ } };
  useEffect(() => { if (S.fbPending() === 0) load(); }, [specId, rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = useFbAct((next) => setRemote((r) => r && r.map((x) => (x.id === next.id ? next : x))));
  async function add(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    try { await S.teamApi('POST', '/feedback', { specId, kind: f.get('kind'), section: f.get('section'), text: f.get('text') }); setAdding(false); setErr(null); await load(); S.sync(); toast('Feedback added'); } catch (x: any) { setErr(x instanceof TypeError ? 'Adding feedback needs a connection to the server.' : x.message); }
  }
  const list: any[] = remote ?? S.specFeedback(specId);
  const shown = list.filter((f) => filter === 'all' || f.status === 'open');
  const nOpen = list.filter((f) => f.status === 'open').length;
  return (
    <Sheet onClose={onClose}>
      <h2>Feedback on {specId}</h2>
      <p>Findings and questions from agents and colleagues. They never change the spec – people read them, decide and reply.</p>
      <div className="filters" role="group" aria-label="Feedback filter">
        <button className="filter" type="button" aria-pressed={filter === 'open'} onClick={() => setFilter('open')}>Open {nOpen}</button>
        <button className="filter" type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All {list.length}</button>
        {can && <button className="btn small" type="button" data-act="feedback-add" onClick={() => setAdding(!adding)} style={{ marginLeft: 'auto' }}><Icon name="plus" size={14} /> Add</button>}
      </div>
      {adding && <form className="form" id="feedbackForm" onSubmit={add}>
        <div className="grid2"><label className="sr" htmlFor="fb-kind">Kind</label><select className="field" id="fb-kind" name="kind" defaultValue="question">{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <label className="sr" htmlFor="fb-sec">Section</label><input className="field" id="fb-sec" name="section" placeholder="Section (optional), e.g. ## DECISION" maxLength={80} /></div>
        <label className="sr" htmlFor="fb-text">Feedback</label><textarea className="field" id="fb-text" name="text" style={{ height: 90, padding: 12 }} placeholder="What did you notice?" required />
        <button className="btn primary" type="submit">Save feedback</button></form>}
      <FormError msg={err} />
      {remote === null && !S.state.online && <p className="muted fb-offline">Offline – showing what is stored on this device (open entries and recent answers). Your answers are sent with the next sync.</p>}
      {!shown.length && <p className="muted" style={{ padding: '12px 0' }}>{filter === 'open' ? 'No open feedback.' : 'No feedback yet.'}</p>}
      <div className="fb-list">
        {shown.map((f) => (f.kind === 'decision' ? <DecisionCard key={f.id} f={f} act={act} /> : <FbItem key={f.id} f={f} version={version} act={act} />))}
      </div>
    </Sheet>
  );
}
