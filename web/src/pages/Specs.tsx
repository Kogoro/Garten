import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Bar, Shell } from '../Shell';
import { AgentChip, ItemEditor, ItemSync, StatusChip, TypeChip } from './ItemEditor';
import { NewSpecSheet } from '../sheets';
import { Icon, ago, touched, useStore } from '../ui';
import type { Item } from '../store/types';

function SpecList({ selected }: { selected?: string }) {
  const S = useStore();
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
  const [newSpec, setNewSpec] = useState(false);
  const create = () => setNewSpec(true);
  return (
    <>
      <Bar title="Specs">{S.can('write') && <button className="btn primary only-desktop" data-act="new-spec" onClick={create}><Icon name="plus" size={14} /> New</button>}</Bar>
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
            <div className="row-top"><span className="row-id">{s.id}</span><ItemSync i={s} S={S} /></div>
            <div className="row-title">{s.title || <span className="muted">Untitled spec</span>}</div>
            <div className="row-meta"><TypeChip s={s} S={S} /><StatusChip i={s} S={S} /><AgentChip s={s} S={S} /><span>{s.links.length} document{s.links.length === 1 ? '' : 's'}</span><span>{s.fetchedAt && !S.hasUnreleased(s) ? `Agent fetched ${ago(Date.parse(s.fetchedAt))}` : `Edited ${ago(touched(s))}`}</span></div>
          </Link>
        ))}
      </div>
      {S.can('write') && <button className="fab" data-act="new-spec" onClick={create} aria-label="New spec"><Icon name="plus" />New spec</button>}
      {newSpec && <NewSpecSheet onClose={() => setNewSpec(false)} />}
    </>
  );
}

function SpecEditorPage({ id }: { id: string }) {
  const S = useStore();
  const item = S.get(id);
  if (!item || item.kind !== 'spec') return <div className="placeholder"><p>This spec does not exist (anymore).</p></div>;
  return <ItemEditor item={item} />;
}

export function SpecsPage() {
  const { id } = useParams();
  const sel = id ? decodeURIComponent(id) : undefined;
  return <Shell master={<SpecList selected={sel} />} detail={sel ? <SpecEditorPage key={sel} id={sel} /> : undefined} />;
}
