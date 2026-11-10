import { useEffect, useState } from 'react';
import { FormError, Sheet } from './dialogs';
import { Icon, ago, toast, useStore } from './ui';

export const KINDS: [string, string][] = [['concern', 'Concern'], ['conflict', 'Conflict'], ['question', 'Question'], ['suggestion', 'Suggestion'], ['gap', 'Missing info']];
const kindLabel = Object.fromEntries(KINDS);
const STATUS: Record<string, string> = { open: 'Open', accepted: 'Accepted', dismissed: 'Dismissed', done: 'Done', withdrawn: 'Withdrawn by agent' };

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

/** Feedback on one spec: what agents (or people) found, and what the team decided about it. */
export function FeedbackSheet({ specId, version, onClose }: { specId: string; version: number; onClose: () => void }) {
  const S = useStore();
  const [list, setList] = useState<any[] | null>(null);
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const can = S.can('write');
  const load = async () => { try { setList((await S.teamApi('GET', `/feedback?spec=${encodeURIComponent(specId)}`)).feedback); } catch (e: any) { setErr(e.message); setList([]); } };
  useEffect(() => { load(); }, [specId]); // eslint-disable-line react-hooks/exhaustive-deps
  async function setStatus(f: any, status: string, reply?: string, note = false) {
    try {
      if (note) { const it = S.get(specId); if (it) S.edit(specId, { body: addReviewNote(it.body, f) }); } await S.teamApi('PATCH', `/feedback/${f.id}`, { status, ...(reply !== undefined ? { reply } : {}) }); await load(); S.sync(); } catch (e: any) { toast(e.message); }
  }
  async function add(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    try { await S.teamApi('POST', '/feedback', { specId, kind: f.get('kind'), section: f.get('section'), text: f.get('text') }); setAdding(false); await load(); S.sync(); toast('Feedback added'); } catch (x: any) { setErr(x.message); }
  }
  const shown = (list ?? []).filter((f) => filter === 'all' || f.status === 'open');
  const nOpen = (list ?? []).filter((f) => f.status === 'open').length;
  return (
    <Sheet onClose={onClose}>
      <h2>Feedback on {specId}</h2>
      <p>Findings from agents and colleagues. They never change the spec – people read them, decide and reply.</p>
      <div className="filters" role="group" aria-label="Feedback filter">
        <button className="filter" type="button" aria-pressed={filter === 'open'} onClick={() => setFilter('open')}>Open {nOpen}</button>
        <button className="filter" type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All {list?.length ?? 0}</button>
        {can && <button className="btn small" type="button" data-act="feedback-add" onClick={() => setAdding(!adding)} style={{ marginLeft: 'auto' }}><Icon name="plus" size={14} /> Add</button>}
      </div>
      {adding && <form className="form" id="feedbackForm" onSubmit={add}>
        <div className="grid2"><label className="sr" htmlFor="fb-kind">Kind</label><select className="field" id="fb-kind" name="kind" defaultValue="question">{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <label className="sr" htmlFor="fb-sec">Section</label><input className="field" id="fb-sec" name="section" placeholder="Section (optional), e.g. ## DECISION" maxLength={80} /></div>
        <label className="sr" htmlFor="fb-text">Feedback</label><textarea className="field" id="fb-text" name="text" style={{ height: 90, padding: 12 }} placeholder="What did you notice?" required />
        <button className="btn primary" type="submit">Save feedback</button></form>}
      <FormError msg={err} />
      {list === null && <p className="muted">Loading…</p>}
      {list !== null && !shown.length && <p className="muted" style={{ padding: '12px 0' }}>{filter === 'open' ? 'No open feedback.' : 'No feedback yet.'}</p>}
      <div className="fb-list">
        {shown.map((f) => (
          <article className={`fb-item st-${f.status}`} key={f.id} data-kind={f.kind}>
            <div className="fb-head"><span className={`chip ${f.kind === 'conflict' || f.kind === 'concern' ? 'warn' : ''}`}>{kindLabel[f.kind] ?? f.kind}</span>{f.section && <span className="mono fb-sec">{f.section}</span>}
              <span className="muted fb-meta">{f.via ?? f.author} · {ago(Date.parse(f.createdAt))}{f.specVersion !== version ? ` · on v${f.specVersion || 0}` : ''}</span><span className={`chip ${f.status === 'open' ? '' : 'ok'}`}>{STATUS[f.status]}</span></div>
            <p className="fb-text">{f.text}</p>
            {f.evidence && <p className="fb-evidence mono">{f.evidence}</p>}
            {f.reply && <p className="fb-reply"><b>{f.resolvedBy}:</b> {f.reply}</p>}
            {can && f.status !== 'withdrawn' && <FeedbackActions f={f} setStatus={setStatus} />}
          </article>
        ))}
      </div>
    </Sheet>
  );
}

function FeedbackActions({ f, setStatus }: { f: any; setStatus: (f: any, s: string, reply?: string, note?: boolean) => void }) {
  const [reply, setReply] = useState(f.reply ?? '');
  return (
    <div className="fb-acts">
      <label className="sr" htmlFor={`rp-${f.id}`}>Reply</label>
      <input id={`rp-${f.id}`} className="field" placeholder="Reply (optional)" value={reply} maxLength={2000} onChange={(e) => setReply(e.target.value)} />
      <div className="btns">
        {f.status === 'open'
          ? <><button className="btn small" data-act="fb-accept" onClick={() => setStatus(f, 'accepted', reply)}>Accept</button><button className="btn small" data-act="fb-accept-note" title="Accept and add it to the spec as a checklist item under REVIEW NOTES" onClick={() => setStatus(f, 'accepted', reply, true)}>Accept &amp; add to spec</button><button className="btn small" data-act="fb-dismiss" onClick={() => setStatus(f, 'dismissed', reply)}>Dismiss</button></>
          : <><button className="btn small" data-act="fb-reopen" onClick={() => setStatus(f, 'open', reply)}>Reopen</button>{f.status === 'accepted' && <button className="btn small" data-act="fb-done" onClick={() => setStatus(f, 'done', reply)}>Mark done</button>}</>}
      </div>
    </div>
  );
}
