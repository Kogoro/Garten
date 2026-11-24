import { SharedSection, SharedView } from '../sharing';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Bar, Shell } from '../Shell';
import { AgentChip, ItemEditor, ItemSync, NotFound, StatusChip, TypeChip } from './ItemEditor';
import { NewSpecSheet } from '../sheets';
import { ImplChip } from '../reports';
import { Icon, ago, touched, useStore } from '../ui';
import { usePref } from '../prefs';
import { useProgressive } from '../hooks';
import { Fab } from '../Fab';
import { awaitsApproval } from '../lib';
import { Sheet } from '../dialogs';
import { Onboarding } from '../Onboarding';
import { implState } from '../reports';
import type { Item } from '../store/types';

function SpecList({ selected }: { selected?: string }) {
  const S = useStore();
  const [q, setQ] = useState('');
  const [filter, setFilter] = usePref<'all' | 'draft' | 'approved' | 'pending'>('specs-filter', 'all', [
    'all',
    'draft',
    'approved',
    'pending',
  ]);
  const [type, setType] = usePref<string>('specs-type', '');
  // Today's stage headings open the list on that stage: ?stage=seed|sprout|bloom
  const [params] = useSearchParams();
  const stage = params.get('stage');
  useEffect(() => {
    const f = ({ seed: 'draft', sprout: 'pending', bloom: 'approved' } as const)[stage as 'seed'];
    if (f) setFilter(f);
  }, [stage]); // eslint-disable-line react-hooks/exhaustive-deps
  const [sort, setSort] = usePref<'updated' | 'id' | 'title' | 'status' | 'impl'>('specs-sort', 'updated', [
    'updated',
    'id',
    'title',
    'status',
    'impl',
  ]);
  const all = S.all('spec');
  // waiting for an approver: a draft with a title, or a released spec with edits that are not released yet
  const isPending = (s: Item) => awaitsApproval(S, s);
  const [sheet, setSheet] = useState(false);
  const active = (type ? 1 : 0) + (sort !== 'updated' ? 1 : 0);
  const specs = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return all
      .filter(
        (s) =>
          filter === 'all' ||
          (filter === 'pending'
            ? isPending(s)
            : filter === 'approved'
              ? s.status === 'approved'
              : s.status !== 'approved' && !isPending(s)),
      )
      .filter((s) => !type || s.specType === type)
      .filter((s) => !ql || `${s.id} ${s.title} ${s.body}`.toLowerCase().includes(ql))
      .sort((a, b) => {
        if (sort === 'id') return a.id.localeCompare(b.id, undefined, { numeric: true });
        if (sort === 'title') return (a.title || '\uffff').localeCompare(b.title || '\uffff');
        if (sort === 'status') return Number(b.status === 'approved') - Number(a.status === 'approved') || touched(b) - touched(a);
        if (sort === 'impl')
          return implState(a, S.latestReport(a.id)).rank - implState(b, S.latestReport(b.id)).rank || touched(b) - touched(a);
        return touched(b) - touched(a);
      });
  }, [all, q, filter, type, sort, S.getVersion()]); // eslint-disable-line react-hooks/exhaustive-deps
  const n = (f: (s: Item) => boolean) => all.filter(f).length;
  const prog = useProgressive(specs.length, 60, `${q}|${filter}|${type}|${sort}`);
  const [newSpec, setNewSpec] = useState(false);
  const create = () => setNewSpec(true);
  // The first sync has not finished (lastSync is only set when it has): what is on the device may be a part of the team's specs, and the rest would be
  // inserted above it. Show the shape of the list until then, not a partial list and not "No specs yet". Offline, the cache is all there is.
  const firstLoad = !S.state.lastSync && S.state.online && !S.state.error;
  return (
    <>
      <Bar title="Specs">
        {S.can('write') && (
          <button className="btn primary only-desktop" data-act="new-spec" onClick={create}>
            <Icon name="plus" size={14} /> New spec
          </button>
        )}
      </Bar>
      <div className="listtools">
        <div className="toolrow">
          <div className="search">
            <Icon name="search" />
            <label className="sr" htmlFor="search">
              Search specs
            </label>
            <input id="search" type="search" placeholder="Search specs" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <button
            type="button"
            className="icon-btn filterbtn only-mobile"
            data-act="filters"
            aria-label={`Sort and filter${active ? `, ${active} active` : ''}`}
            onClick={() => setSheet(true)}
          >
            <Icon name="filter" />
            {active > 0 && <span className="badge-dot" />}
          </button>
        </div>
        <div className="filters seg seg-fill" role="group" aria-label="Status filter">
          {(
            [
              ['all', 'All', all.length],
              ...(S.can('approve') ? [['pending', 'Sprout', n(isPending)] as const] : []),
              ['draft', 'Seed', n((s) => s.status !== 'approved' && !isPending(s))],
              ['approved', 'Bloom', n((s) => s.status === 'approved')],
            ] as const
          ).map(([k, l, c]) => (
            <button key={k} className="filter" type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>
              {l} {c}
            </button>
          ))}
        </div>
        <div className="sortrow only-desktop">
          <select
            id="sortBy"
            className="filter sel"
            aria-label="Sort by"
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
          >
            <option value="updated">Recently edited</option>
            <option value="id">ID</option>
            <option value="title">Title A–Z</option>
            <option value="status">In bloom first</option>
            <option value="impl">Needs attention first</option>
          </select>
          <select id="typeFilter" className="filter sel" aria-label="Filter by type" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All types</option>
            {S.specTypes().map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
                {all.some((x) => x.specType === t.key) ? '' : ' (none)'}
              </option>
            ))}
          </select>
        </div>
      </div>
      {!q && <Onboarding />}
      <div className="list" id="list">
        {firstLoad && (
          <div className="list-card" aria-busy="true" aria-label="Loading specs">
            {[0, 1, 2].map((i) => (
              <div className="row skel" key={i}>
                <i />
                <i />
              </div>
            ))}
          </div>
        )}
        {!firstLoad && !specs.length && (
          <div className="empty">
            {all.length ? 'No specs match.' : S.can('write') ? 'No specs yet. Create your first one — it works offline.' : 'No specs yet.'}
          </div>
        )}
        {!firstLoad && specs.length > 0 && (
          <>
            <div className="list-card">
              {specs.slice(0, prog.shown).map((s) => (
                <Link key={s.id} className={`row ${selected === s.id ? 'active' : ''}`} to={`/spec/${encodeURIComponent(s.id)}`}>
                  <div className="row-title">{s.title || <span className="muted">Untitled spec</span>}</div>
                  <div className="row-meta">
                    <span className="row-id">{s.id}</span>
                    <TypeChip s={s} S={S} />
                    <StatusChip i={s} S={S} />
                    <AgentChip s={s} S={S} />
                    <ImplChip spec={s} />
                    {S.feedbackCount(s.id) > 0 && (
                      <span className="chip warn" title="Open feedback">
                        {S.feedbackCount(s.id)} feedback
                      </span>
                    )}
                    <ItemSync i={s} S={S} quiet />
                    <span className="row-when">
                      {s.links.length > 0 && (
                        <span className="row-docs">
                          {s.links.length} document{s.links.length === 1 ? '' : 's'}
                        </span>
                      )}
                      <span>
                        {s.fetchedAt && !S.hasUnreleased(s) ? (
                          <>Agent fetched {ago(Date.parse(s.fetchedAt))}</>
                        ) : (
                          <>
                            <span className="row-word">Edited </span>
                            {ago(touched(s))}
                          </>
                        )}
                      </span>
                    </span>
                  </div>
                </Link>
              ))}
            </div>
            {specs.length > prog.shown && (
              <div className="more-rows" ref={prog.ref}>
                <button type="button" className="btn subtle" onClick={prog.more}>
                  {prog.shown} of {specs.length} shown · show more
                </button>
              </div>
            )}
          </>
        )}
        {filter === 'all' && !q && <SharedSection kind="spec" selected={selected} />}
      </div>
      {S.can('write') && <Fab label="New spec" act="new-spec" onClick={create} />}
      {newSpec && <NewSpecSheet onClose={() => setNewSpec(false)} />}
      {sheet && (
        <Sheet onClose={() => setSheet(false)}>
          <h2>Sort and filter</h2>
          <label className="sr" htmlFor="m-sort">
            Sort by
          </label>
          <select id="m-sort" className="field" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="updated">Recently edited</option>
            <option value="id">ID</option>
            <option value="title">Title A–Z</option>
            <option value="status">In bloom first</option>
            <option value="impl">Needs attention first</option>
          </select>
          <label className="sr" htmlFor="m-type">
            Type
          </label>
          <select id="m-type" className="field" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All types</option>
            {S.specTypes().map((t: any) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
          <div className="btns">
            <button
              type="button"
              className="btn"
              onClick={() => {
                setType('');
                setSort('updated');
              }}
            >
              Reset
            </button>
            <button type="button" className="btn primary" onClick={() => setSheet(false)}>
              Show {specs.length}
            </button>
          </div>
        </Sheet>
      )}
    </>
  );
}

function SpecEditorPage({ id }: { id: string }) {
  const S = useStore();
  if (id.startsWith('@')) return <SharedView refId={id} />;
  const item = S.get(id);
  if (!item || item.kind !== 'spec') return <NotFound what="spec" to="/specs" back="Specs" />;
  return <ItemEditor item={item} />;
}

export function SpecsPage() {
  const { id } = useParams();
  const sel = id ? decodeURIComponent(id) : undefined;
  return <Shell master={<SpecList selected={sel} />} detail={sel ? <SpecEditorPage key={sel} id={sel} /> : undefined} />;
}
