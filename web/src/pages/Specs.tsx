import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Bar, Shell } from '../Shell';
import { SpecEditor } from '../editor/SpecEditor';
import { Icon, ago, touched, useStore } from '../ui';
import type { Item } from '../store/types';

const TypeChip = ({ s, S }: { s: Item; S: ReturnType<typeof useStore> }) => { const t = S.specType(s.specType); return <span className="chip type" title={t.label}>{t.short ?? t.label}</span>; };
const AgentChip = ({ s, S }: { s: Item; S: ReturnType<typeof useStore> }) => (s.updatedVia && S.hasUnreleased(s) ? <span className="chip agent" title={s.updatedVia}>Agent draft</span> : null);
export const StatusChip = ({ i, S }: { i: Item; S: ReturnType<typeof useStore> }) =>
  i.approve ? <span className="chip warn">Approval queued</span> : i.status === 'approved' ? <span className="chip ok">Approved v{i.version}{S.hasUnreleased(i) ? ' · edited' : ''}</span> : <span className="chip">Draft</span>;

function SpecList({ selected }: { selected?: string }) {
  const S = useStore();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'draft' | 'approved'>('all');
  const [type, setType] = useState('');
  const all = S.all('spec');
  const specs = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return all
      .filter((s) => filter === 'all' || (filter === 'approved') === (s.status === 'approved'))
      .filter((s) => !type || s.specType === type)
      .filter((s) => !ql || `${s.id} ${s.title} ${s.body}`.toLowerCase().includes(ql))
      .sort((a, b) => touched(b) - touched(a));
  }, [all, q, filter, type, S.getVersion()]); // eslint-disable-line react-hooks/exhaustive-deps
  const n = (f: (s: Item) => boolean) => all.filter(f).length;
  const create = () => { const s = S.createSpec('feature'); nav(`/spec/${encodeURIComponent(s.id)}`); };
  return (
    <>
      <Bar title="Specs">{S.can('write') && <button className="btn primary only-desktop" onClick={create}><Icon name="plus" size={14} /> New</button>}</Bar>
      <div className="listtools">
        <div className="search"><Icon name="search" /><label className="sr" htmlFor="search">Search specs</label><input id="search" type="search" placeholder="Search specs" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div className="filters">
          {([['all', 'All', all.length], ['draft', 'Draft', n((s) => s.status !== 'approved')], ['approved', 'Approved', n((s) => s.status === 'approved')]] as const).map(([k, l, c]) => <button key={k} className="filter" type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>{l} {c}</button>)}
          <select id="typeFilter" className="filter sel" aria-label="Filter by type" value={type} onChange={(e) => setType(e.target.value)}><option value="">All types</option>{S.specTypes().map((t) => <option key={t.key} value={t.key}>{t.label}{all.some((x) => x.specType === t.key) ? '' : ' (none)'}</option>)}</select>
        </div>
      </div>
      <div className="list" id="list">
        {!specs.length && <div className="empty">{all.length ? 'No specs match.' : S.can('write') ? 'No specs yet. Create your first one — it works offline.' : 'No specs yet.'}</div>}
        {specs.map((s) => (
          <Link key={s.id} className={`row ${selected === s.id ? 'active' : ''}`} to={`/spec/${encodeURIComponent(s.id)}`}>
            <div className="row-top"><span className="row-id">{s.id}</span></div>
            <div className="row-title">{s.title || <span className="muted">Untitled spec</span>}</div>
            <div className="row-meta"><TypeChip s={s} S={S} /><StatusChip i={s} S={S} /><AgentChip s={s} S={S} /><span>{s.links.length} document{s.links.length === 1 ? '' : 's'}</span><span>{s.fetchedAt && !S.hasUnreleased(s) ? `Agent fetched ${ago(Date.parse(s.fetchedAt))}` : `Edited ${ago(touched(s))}`}</span></div>
          </Link>
        ))}
      </div>
      {S.can('write') && <button className="fab" onClick={create} aria-label="New spec"><Icon name="plus" />New spec</button>}
    </>
  );
}

function ApproveButton({ i, S }: { i: Item; S: ReturnType<typeof useStore> }) {
  if (!S.can('approve')) return <span className="muted hint">{i.status === 'approved' ? `Approved v${i.version}` : 'An approver releases this'}</span>;
  if (i.approve) return <button className="approve queued" onClick={() => S.cancelApprove(i.id)}><Icon name="clock" />Approval queued</button>;
  if (i.status === 'approved' && !S.hasUnreleased(i)) return <button className="approve done" disabled>Approved v{i.version}<Icon name="check" size={16} /></button>;
  return <button className="approve" onClick={() => S.requestApprove(i.id)}>{i.status === 'approved' ? `Approve v${i.version + 1}` : 'Approve'}<Icon name="check" size={16} /></button>;
}

function SpecEditorPage({ id }: { id: string }) {
  const S = useStore();
  const item = S.get(id);
  const [mode, setMode] = useState<'blocks' | 'markdown'>('blocks');
  if (!item || item.kind !== 'spec') return <div className="placeholder"><p>This spec does not exist (anymore).</p></div>;
  const ro = !S.can('write');
  const st = ro ? 'ro' : item.conflict ? 'conflict' : item.syncError ? 'error' : S.isPending(item) ? 'dirty' : 'synced';
  const label = { ro: `View only · your role (${S.team()?.role}) cannot edit`, conflict: 'Conflict with server', error: item.syncError ?? '', dirty: 'Saved on device · not synced', synced: 'Synced' }[st];
  return (
    <div className="editor" data-editor={item.id}>
      <header className="bar ed-bar">
        <Link className="icon-btn back" to="/" aria-label="Back"><Icon name="back" /></Link>
        <label className="sr" htmlFor="title">Title</label>
        <input id="title" className="ed-title" placeholder="Spec title" value={item.title} autoComplete="off" readOnly={ro} onChange={(e) => S.edit(item.id, { title: e.target.value })} />
        <span className="barchips"><TypeChip s={item} S={S} /><StatusChip i={item} S={S} /><AgentChip s={item} S={S} /></span>
        <span className={`save-ind ${st === 'dirty' ? 'dirty' : ''} ${st === 'conflict' || st === 'error' ? 'bad' : ''}`} role="status" title={label}><span className="lbl">{label}</span></span>
        <ApproveButton i={item} S={S} />
        <div className="seg sm" role="group" aria-label="Editor mode">{(['blocks', 'markdown'] as const).map((m) => <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>{m === 'blocks' ? 'Blocks' : 'Markdown'}</button>)}</div>
      </header>
      <div className="ed-scroll">
        {mode === 'blocks'
          ? <SpecEditor docKey={`${item.team}|${item.id}`} value={item.body} readOnly={ro} onChange={(md) => S.edit(item.id, { body: md })} />
          : <textarea id="body" className="ed-body" spellCheck={false} readOnly={ro} value={item.body} onChange={(e) => S.edit(item.id, { body: e.target.value })} />}
      </div>
    </div>
  );
}

export function SpecsPage() {
  const { id } = useParams();
  const sel = id ? decodeURIComponent(id) : undefined;
  return <Shell master={<SpecList selected={sel} />} detail={sel ? <SpecEditorPage key={sel} id={sel} /> : undefined} />;
}
