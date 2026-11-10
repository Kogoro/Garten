import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Sheet } from './dialogs';
import type { Item } from './store/types';
import { Icon, ago, useStore } from './ui';

export type Impl = { key: 'none' | 'outdated' | 'implemented' | 'partial' | 'blocked' | 'in_progress'; cls: string; text: string; rank: number };
const met = (r: any) => { const c: any[] = r?.criteria ?? []; return c.length ? ` · ${c.filter((x) => x.status === 'met').length}/${c.length} criteria` : ''; };

/** Where the implementation of a released spec stands, judged from the newest report an agent filed. */
export function implState(spec: Item, r: any | null): Impl {
  if (!r) return { key: 'none', cls: '', text: 'Not started', rank: 4 };
  if (r.specVersion < spec.version) return { key: 'outdated', cls: 'warn', text: `Outdated · built v${r.specVersion}, released v${spec.version}`, rank: 1 };
  if (r.status === 'implemented') return { key: 'implemented', cls: 'ok', text: `Implemented v${r.specVersion}${met(r)}`, rank: 5 };
  if (r.status === 'partial') return { key: 'partial', cls: 'warn', text: `Partly built${met(r)}`, rank: 2 };
  if (r.status === 'blocked') return { key: 'blocked', cls: 'bad', text: 'Blocked', rank: 0 };
  return { key: 'in_progress', cls: 'agent', text: 'In progress', rank: 3 };
}

export function ImplChip({ spec, always }: { spec: Item; always?: boolean }) {
  const S = useStore();
  if (spec.kind !== 'spec' || spec.status !== 'approved') return null;
  const r = S.latestReport(spec.id);
  if (!r && !always) return null;
  const st = implState(spec, r);
  return <span className={`chip impl ${st.cls}`} data-impl={st.key} title="What the agent reported about building this spec">{st.text}</span>;
}

const STATUS: Record<string, string> = { implemented: 'Implemented', partial: 'Partly built', blocked: 'Blocked', in_progress: 'In progress' };
const CRIT: Record<string, [string, string]> = { met: ['ok', 'Met'], deviating: ['warn', 'Deviates'], open: ['', 'Open'] };
const isUrl = (s: string) => /^https?:\/\/\S+$/.test(s);

function Report({ r }: { r: any }) {
  return (
    <div className="rp">
      <p className="rp-sum">{r.summary}</p>
      {r.criteria?.length > 0 && <>
        <div className="sect-title"><span>Acceptance criteria</span><small>{r.criteria.filter((c: any) => c.status === 'met').length} of {r.criteria.length} met</small></div>
        <ul className="rp-crit">{r.criteria.map((c: any, i: number) => (
          <li key={i} data-status={c.status}><span className={`rp-mark ${CRIT[c.status]?.[0] ?? ''}`} title={CRIT[c.status]?.[1]}>{c.status === 'met' ? <Icon name="check" size={12} /> : c.status === 'deviating' ? <Icon name="warn" size={12} /> : null}</span>
            <span className="rp-ctext">{c.text}{c.status !== 'met' && <span className={`chip ${CRIT[c.status]?.[0] ?? ''}`}>{CRIT[c.status]?.[1] ?? c.status}</span>}{c.note && <small>{c.note}</small>}</span></li>
        ))}</ul></>}
      {r.deviations && <><div className="sect-title"><span>Deviations from the spec</span></div><p className="rp-dev">{r.deviations}</p></>}
      {r.evidence?.length > 0 && <>
        <div className="sect-title"><span>Evidence</span><small>{r.evidence.length}</small></div>
        <ul className="rp-ev">{r.evidence.map((e: any, i: number) => (
          <li key={i}><span className="chip">{e.kind}</span><span className="rp-ref">{isUrl(e.ref) ? <a href={e.ref} target="_blank" rel="noreferrer noopener">{e.ref}</a> : <span className="mono">{e.ref}</span>}{e.note && <small>{e.note}</small>}</span></li>
        ))}</ul></>}
    </div>
  );
}

/** What an agent reported about building a spec: status, every acceptance criterion, evidence and deviations. Read-only for people. */
export function ReportSheet({ specId, onClose, link }: { specId: string; onClose: () => void; link?: boolean }) {
  const S = useStore();
  const spec = S.get(specId);
  const latest = S.latestReport(specId);
  const [history, setHistory] = useState<any[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => { let on = true; S.teamApi('GET', `/reports?spec=${encodeURIComponent(specId)}`).then((d: any) => on && setHistory(d.reports)).catch(() => { /* offline: only the newest report is on this device */ }); return () => { on = false; }; }, [specId, latest?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const all: any[] = history ?? (latest ? [latest] : []);
  const r = all.find((x) => x.id === sel) ?? latest ?? all[0] ?? null;
  const st = spec ? implState(spec, latest) : null;
  return (
    <Sheet onClose={onClose}>
      <h2>Implementation of {specId}</h2>
      {spec?.title && <p>{spec.title}</p>}
      {!r ? <p className="muted rp-empty">No agent has reported on this spec yet. {spec?.status === 'approved' ? `v${spec.version} is released – it is on the agent's work list as “new”.` : 'Agents only build released specs.'}</p> : <>
        <div className="rp-head">
          <span className={`chip ${r.id === latest?.id && st ? st.cls : ''}`}>{r.id === latest?.id && st ? st.text : `${STATUS[r.status] ?? r.status} v${r.specVersion}`}</span>
          <span className="muted">{r.via ?? r.author} · {ago(Date.parse(r.createdAt))}</span>
        </div>
        {r.id === latest?.id && st?.key === 'outdated' && <p className="note rp-warn">This report is about v{r.specVersion}. v{spec!.version} was released since – the agent sees the spec as “changed” in its work list.</p>}
        <Report r={r} />
        {all.length > 1 && <><div className="sect-title"><span>History</span><small>{all.length} reports</small></div>
          <div className="rp-hist">{all.map((x) => <button type="button" key={x.id} className="filter" aria-pressed={x.id === r.id} onClick={() => setSel(x.id)}>v{x.specVersion} · {STATUS[x.status] ?? x.status} · {ago(Date.parse(x.createdAt))}</button>)}</div></>}
        {history === null && !S.state.online && <p className="muted fb-offline">Offline – the newest report is stored on this device; older ones load when you are online.</p>}
      </>}
      {link && <div className="btns" style={{ marginTop: 12 }}><Link className="btn small" to={`/spec/${encodeURIComponent(specId)}`} onClick={onClose}>Open spec</Link></div>}
    </Sheet>
  );
}
