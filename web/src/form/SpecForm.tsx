import { useEffect, useRef, useState, type ReactNode } from 'react';
import { emptyValue, parseForm, serializeForm } from '@shared/specForm.js';
import { METHODS, MermaidView } from '../editor/schema';
import type { FormField, FormSchema } from '../store/types';
import { FlowEditor } from '../editor/FlowEditor';
import { Icon } from '../ui';

type State = { values: Record<string, any>; rest: Record<string, string>; preface: string; extra: string };
interface Ep { method: string; path: string; text: string; req: string; res: string }

/** Mermaid field: code and rendered diagram, optionally with the visual flowchart editor. */
function DiagramField({ label, value, ro, onChange }: { label: string; value: string; ro: boolean; onChange: (v: string) => void }) {
  const [visual, setVisual] = useState(false);
  return (
    <div className="ff-diagram">
      {visual ? <FlowEditor text={value} readOnly={ro} onChange={onChange} />
        : <Area label={`${label} (Mermaid)`} mono ro={ro} value={value} rows={5} placeholder={'flowchart LR\n  A --> B'} onChange={onChange} />}
      {!ro && <button type="button" className="btn small" data-act="ff-visual" aria-pressed={visual} style={{ alignSelf: 'flex-start' }} onClick={() => setVisual(!visual)}>{visual ? 'Edit as code' : 'Edit visually'}</button>}
      {value.trim() && <MermaidView text={value} />}
    </div>
  );
}

const grow = (el: HTMLTextAreaElement | null) => { if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight + 2}px`; } };
function Area({ value, onChange, ro, placeholder, label, mono, rows = 3 }: { value: string; onChange: (v: string) => void; ro: boolean; placeholder?: string; label: string; mono?: boolean; rows?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => grow(ref.current), [value]);
  return <textarea ref={ref} className={`field ff-area${mono ? ' mono' : ''}`} aria-label={label} placeholder={placeholder} readOnly={ro} rows={rows} value={value} onChange={(e) => onChange(e.target.value)} />;
}

/** One-line-per-item editor: Enter adds a row, Backspace on an empty row removes it, Alt+↑/↓ moves it. */
function Rows({ items, onChange, ro, label, placeholder, prefix, renderPrefix, checklist }: { checklist?: boolean; items: any[]; onChange: (v: any[]) => void; ro: boolean; label: string; placeholder?: string; prefix?: (i: number) => string; renderPrefix?: (i: number) => ReactNode }) {
  const refs = useRef<(HTMLTextAreaElement | null)[]>([]);
  const focus = useRef<number | null>(null);
  useEffect(() => { if (focus.current !== null) { refs.current[focus.current]?.focus(); focus.current = null; } });
  const text = (x: any) => (typeof x === 'string' ? x : x.text);
  const set = (i: number, v: string) => onChange(items.map((x, k) => (k === i ? (typeof x === 'string' ? v : { ...x, text: v }) : x)));
  const blank = () => (checklist ? { text: '', done: false } : '');
  const add = (at: number) => { focus.current = at; onChange([...items.slice(0, at), blank(), ...items.slice(at)]); };
  const move = (i: number, d: number) => { const j = i + d; if (j < 0 || j >= items.length) return; const n = [...items]; [n[i], n[j]] = [n[j], n[i]]; onChange(n); };
  return (
    <div className="ff-rows" role="list" aria-label={label}>
      {items.map((x, i) => (
        <div className="ff-row" role="listitem" key={i}>
          {renderPrefix ? renderPrefix(i) : prefix ? <span className="ff-pre">{prefix(i)}</span> : null}
          <textarea ref={(el) => { refs.current[i] = el; grow(el); }} className="field ff-line" rows={1} aria-label={`${label} ${i + 1}`} placeholder={placeholder} readOnly={ro} value={text(x)}
            onChange={(e) => set(i, e.target.value.replace(/\n/g, ' '))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (text(x).trim()) add(i + 1); }
              else if (e.key === 'Backspace' && !text(x)) { e.preventDefault(); focus.current = Math.max(0, i - 1); onChange(items.filter((_, k) => k !== i)); }
              else if (e.key === 'ArrowUp' && e.altKey) { e.preventDefault(); move(i, -1); } else if (e.key === 'ArrowDown' && e.altKey) { e.preventDefault(); move(i, 1); }
            }} />
          {!ro && <span className="ff-acts"><button type="button" className="icon-btn sm" aria-label={`Move ${label} ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button><button type="button" className="icon-btn sm" aria-label={`Move ${label} ${i + 1} down`} disabled={i === items.length - 1} onClick={() => move(i, 1)}>↓</button><button type="button" className="icon-btn sm" aria-label={`Remove ${label} ${i + 1}`} onClick={() => onChange(items.filter((_, k) => k !== i))}>×</button></span>}
        </div>
      ))}
      {!ro && <button type="button" className="btn small ff-add" onClick={() => add(items.length)}><Icon name="plus" size={14} /> Add</button>}
      {ro && !items.length && <p className="muted ff-empty">Nothing here.</p>}
    </div>
  );
}

type EpTab = 'text' | 'req' | 'res';
function Endpoint({ e, onChange, onRemove, ro, n }: { e: Ep; onChange: (e: Ep) => void; onRemove: () => void; ro: boolean; n: number }) {
  const [tab, setTab] = useState<EpTab>('text');
  const tabs: [EpTab, string, string][] = [['text', 'Description', 'What does this endpoint do? Preconditions, side effects, idempotency …'], ['req', 'Request', 'Parameters, headers, body …'], ['res', 'Responses', '200 OK – … · 404 – …']];
  return (
    <div className="endpoint ff-endpoint" data-content-type="endpoint">
      <div className="ep-head">
        <select className={`ep-method m-${e.method}`} aria-label={`HTTP method ${n}`} disabled={ro} value={e.method} onChange={(x) => onChange({ ...e, method: x.target.value })}>{METHODS.map((m) => <option key={m}>{m}</option>)}</select>
        <input className="ep-path" aria-label={`Path ${n}`} placeholder="/resources/{id}" spellCheck={false} autoComplete="off" readOnly={ro} value={e.path} onChange={(x) => onChange({ ...e, path: x.target.value })} />
        {!ro && <button type="button" className="icon-btn sm" aria-label={`Remove endpoint ${n}`} onClick={onRemove}>×</button>}
      </div>
      <div className="tabs" role="tablist" aria-label="Endpoint sections">{tabs.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={`tab${tab === k ? ' on' : ''}`} onClick={() => setTab(k)}>{l}{e[k]?.trim() ? <i className="dot" aria-hidden /> : null}</button>)}</div>
      {tabs.map(([k, l, ph]) => tab === k && <Area key={k} label={`Endpoint ${n} ${l.toLowerCase()}`} mono={k !== 'text'} placeholder={ph} ro={ro} value={e[k] ?? ''} onChange={(v) => onChange({ ...e, [k]: v })} />)}
    </div>
  );
}

function FieldEditor({ f, v, onChange, ro, reqOffset }: { f: FormField; v: any; onChange: (v: any) => void; ro: boolean; reqOffset: number }) {
  switch (f.kind) {
    case 'text': return <input className="field" aria-label={f.label} readOnly={ro} value={v ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'longtext': return <Area label={f.label} ro={ro} value={v ?? ''} rows={4} onChange={onChange} />;
    case 'select': {
      const opts = f.options ?? [];
      const known = !v || opts.includes(v);
      return <select className="field" aria-label={f.label} disabled={ro} value={v ?? ''} onChange={(e) => onChange(e.target.value)}><option value="">– choose –</option>{!known && <option value={v}>{v}</option>}{opts.map((o) => <option key={o}>{o}</option>)}</select>;
    }
    case 'list': return <Rows items={v ?? []} onChange={onChange} ro={ro} label={f.label} placeholder="Add an item" />;
    case 'checklist': return <Rows checklist items={v ?? []} onChange={onChange} ro={ro} label={f.label} placeholder="Add a criterion" renderPrefix={(i) => <input type="checkbox" className="ff-check" aria-label={`Done ${i + 1}`} disabled={ro} checked={!!v[i]?.done} onChange={(e) => onChange(v.map((x: any, k: number) => (k === i ? { ...x, done: e.target.checked } : x)))} />} />;
    case 'requirements': return <Rows items={v ?? []} onChange={onChange} ro={ro} label={f.label} placeholder="The system must …" prefix={(i) => `R${reqOffset + i + 1}`} />;
    case 'endpoints': {
      const eps: Ep[] = v ?? [];
      return (
        <div className="ff-endpoints">
          {eps.map((e, i) => <Endpoint key={i} n={i + 1} e={e} ro={ro} onChange={(x) => onChange(eps.map((y, k) => (k === i ? x : y)))} onRemove={() => onChange(eps.filter((_, k) => k !== i))} />)}
          {!ro && <button type="button" className="btn small ff-add" onClick={() => onChange([...eps, { method: 'GET', path: '', text: '', req: '', res: '' }])}><Icon name="plus" size={14} /> Add endpoint</button>}
          {ro && !eps.length && <p className="muted ff-empty">No endpoints.</p>}
        </div>
      );
    }
    case 'diagram': return <DiagramField label={f.label} value={v ?? ''} ro={ro} onChange={onChange} />;
    case 'code': return <Area label={`${f.label} (${f.lang || 'code'})`} mono ro={ro} value={v ?? ''} rows={6} onChange={onChange} />;
    default: return null;
  }
}

/** A spec rendered as a form (fields, lists, tabs). The Markdown body stays the source of truth: `value` in, `onChange(md)` out. */
export function SpecForm({ docKey, schema, value, readOnly, onChange }: { docKey: string; schema: FormSchema; value: string; readOnly: boolean; onChange: (md: string) => void }) {
  const [st, setSt] = useState<State>(() => parseForm(schema, value));
  const last = useRef(value);
  const [tab, setTab] = useState<string>(schema.tabs?.[0]?.key ?? '');
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => { setSt(parseForm(schema, value)); last.current = value; setTab(schema.tabs?.[0]?.key ?? ''); }, [docKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (value !== last.current) { last.current = value; setSt(parseForm(schema, value)); } }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = (next: State) => { setSt(next); const md = serializeForm(schema, next); if (md !== last.current) { last.current = md; onChange(md); } };
  const set = (key: string, v: any) => commit({ ...st, values: { ...st.values, [key]: v } });

  const tabs = schema.tabs ?? [];
  const showTabs = tabs.length > 1;
  const inTab = (f: FormField) => !showTabs || (f.tab ?? tabs[0].key) === tab;
  let reqCount = 0;
  const offsets: Record<string, number> = {};
  for (const f of schema.fields) if (f.kind === 'requirements') { offsets[f.key] = reqCount; reqCount += (st.values[f.key] ?? emptyValue(f)).filter((x: string) => x.trim()).length; }
  const filled = (f: FormField) => { const x = st.values[f.key]; return Array.isArray(x) ? x.length > 0 : !!String(x ?? '').trim(); };

  return (
    <div className="specform" data-testid="spec-form" data-ro={readOnly ? '' : undefined}>
      {showTabs && (
        <div className="tabs form-tabs" role="tablist" aria-label="Spec sections">
          {tabs.map((t) => <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={`tab${tab === t.key ? ' on' : ''}`} onClick={() => setTab(t.key)}>{t.label}{schema.fields.some((f) => (f.tab ?? tabs[0].key) === t.key && filled(f)) ? <i className="dot" aria-hidden /> : null}</button>)}
        </div>
      )}
      {schema.fields.filter(inTab).map((f) => (
        <section className="ff" key={f.key} data-field={f.key}>
          <h3 className="ff-label">{f.label}</h3>
          {f.help && <p className="ff-help">{f.help}</p>}
          <FieldEditor f={f} v={st.values[f.key]} ro={readOnly} reqOffset={offsets[f.key] ?? 0} onChange={(v) => set(f.key, v)} />
          {st.rest[f.key] && <p className="ff-help">Also in this section (kept as written): <span className="mono">{st.rest[f.key].slice(0, 80)}{st.rest[f.key].length > 80 ? '…' : ''}</span></p>}
        </section>
      ))}
      {(st.extra || st.preface) && (!showTabs || tab === tabs[tabs.length - 1].key) && (
        <section className="ff ff-extra">
          <button type="button" className="ftoggle" aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}><Icon name="chevron" size={14} /><span>Other content (not part of this form)</span></button>
          {moreOpen && <>
            {st.preface && <Area label="Text before the first section" mono ro={readOnly} value={st.preface} onChange={(v) => commit({ ...st, preface: v })} />}
            {st.extra && <Area label="Other sections" mono ro={readOnly} value={st.extra} onChange={(v) => commit({ ...st, extra: v })} />}
          </>}
        </section>
      )}
    </div>
  );
}
