import { BlockNoteSchema, defaultBlockSpecs } from '@blocknote/core';
import { createReactBlockSpec } from '@blocknote/react';
import { useEffect, useState } from 'react';
import { renderMermaid } from './mermaid';

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const ro = (editor: any) => !editor.isEditable;

/** R1, R2 … (the label is renumbered on every change) */
export const requirement = createReactBlockSpec(
  { type: 'requirement', propSchema: { label: { default: 'R1' } }, content: 'inline' },
  { render: ({ block, contentRef }) => <div className="blk-req" style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}><b className="req-label" contentEditable={false} style={{ color: 'var(--accent)', minWidth: 32 }}>{block.props.label}</b><div ref={contentRef} style={{ flex: 1 }} /></div> },
);

/** Rendered Mermaid (debounced) – used by the diagram block and by form fields. */
export function MermaidView({ text }: { text: string }) {
  const [out, setOut] = useState<{ svg?: string; error?: string }>({});
  useEffect(() => { let live = true; const t = setTimeout(() => renderMermaid(text).then((r) => live && setOut(r)), 250); return () => { live = false; clearTimeout(t); }; }, [text]);
  return <div className={`mm${out.error ? ' err' : ''}`}>{out.error ? <span className="mm-hint">{out.error}</span> : <div dangerouslySetInnerHTML={{ __html: out.svg ?? '' }} />}</div>;
}

function Diagram({ block, editor }: any) {
  const { text, view } = block.props as { text: string; view: 'view' | 'code' | 'split' };
  const set = (p: Record<string, unknown>) => editor.updateBlock(block, { props: p });
  const showCode = view !== 'view';
  const showView = view !== 'code';
  return (
    <div className="diagram" data-view={view} style={{ width: '100%' }}>
      <div className="seg sm" role="group" aria-label="Diagram view">
        {([['view', 'Diagram'], ['code', 'Code'], ['split', 'Split']] as const).map(([k, l]) => <button key={k} type="button" aria-pressed={view === k} onClick={() => set({ view: k })}>{l}</button>)}
      </div>
      <div className="dg-body" style={{ display: 'grid', gridTemplateColumns: showCode && showView ? '1fr 1fr' : '1fr', gap: 8 }}>
        {showCode && <textarea className="blk-in mono" aria-label="Mermaid source" spellCheck={false} readOnly={ro(editor)} value={text} rows={Math.max(4, text.split('\n').length)} onChange={(e) => set({ text: e.target.value })} />}
        {showView && <MermaidView text={text} />}
      </div>
    </div>
  );
}
export const diagram = createReactBlockSpec(
  { type: 'diagram', propSchema: { text: { default: 'flowchart LR\n  A --> B' }, view: { default: 'split', values: ['view', 'code', 'split'] } }, content: 'none' },
  { render: (p) => <Diagram {...p} /> },
);

type Tab = 'text' | 'req' | 'res';
function Endpoint({ block, editor }: any) {
  const p = block.props as Record<string, string>;
  const [tab, setTab] = useState<Tab>('text');
  const set = (patch: Record<string, string>) => editor.updateBlock(block, { props: patch });
  const tabs: [Tab, string, string][] = [['text', 'Description', 'What does this endpoint do? Preconditions, side effects, idempotency …'], ['req', 'Request', 'Parameters, headers, body …'], ['res', 'Responses', '200 OK – … · 404 – …']];
  return (
    <div className="endpoint" style={{ width: '100%' }}>
      <div className="ep-head">
        <select className={`ep-method m-${p.method}`} aria-label="HTTP method" disabled={ro(editor)} value={p.method} onChange={(e) => set({ method: e.target.value })}>{METHODS.map((m) => <option key={m}>{m}</option>)}</select>
        <input className="ep-path" aria-label="Path" placeholder="/resources/{id}" autoComplete="off" spellCheck={false} readOnly={ro(editor)} value={p.path} onChange={(e) => set({ path: e.target.value })} />
      </div>
      <div className="tabs" role="tablist" aria-label="Endpoint sections">
        {tabs.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={`tab${tab === k ? ' on' : ''}`} onClick={() => setTab(k)}>{l}{p[k]?.trim() ? <i className="dot" aria-hidden /> : null}</button>)}
      </div>
      {tabs.map(([k, l, ph]) => tab === k && <textarea key={k} className={`blk-in ${k === 'text' ? 'ep-text' : 'mono'}`} aria-label={`Endpoint ${l.toLowerCase()}`} placeholder={ph} readOnly={ro(editor)} rows={Math.max(3, (p[k] ?? '').split('\n').length)} value={p[k] ?? ''} onChange={(e) => set({ [k]: e.target.value })} />)}
    </div>
  );
}
export const endpoint = createReactBlockSpec(
  { type: 'endpoint', propSchema: { method: { default: 'GET', values: METHODS }, path: { default: '' }, text: { default: '' }, req: { default: '' }, res: { default: '' } }, content: 'none' },
  { render: (p) => <Endpoint {...p} /> },
);

function Definition({ block, editor }: any) {
  const p = block.props as Record<string, string>;
  const set = (patch: Record<string, string>) => editor.updateBlock(block, { props: patch });
  const r = ro(editor);
  return (
    <div className="blk-def-card" style={{ width: '100%' }}>
      <input className="def-term" aria-label="Term" placeholder="Term" readOnly={r} value={p.term} onChange={(e) => set({ term: e.target.value })} />
      <textarea className="blk-in" aria-label="Definition" placeholder="Definition – use [[Term]] to reference other terms" readOnly={r} rows={2} value={p.text} onChange={(e) => set({ text: e.target.value })} />
      <div className="def-meta">
        <input className="def-aliases" aria-label="Also known as" placeholder="Also known as (comma separated)" readOnly={r} value={p.aliases} onChange={(e) => set({ aliases: e.target.value })} />
        <input className="def-see" aria-label="See also" placeholder="See also" readOnly={r} value={p.see} onChange={(e) => set({ see: e.target.value })} />
      </div>
      {p.src ? <small className="muted">Imported from the global glossary</small> : null}
    </div>
  );
}
export const definition = createReactBlockSpec(
  { type: 'definition', propSchema: { term: { default: '' }, text: { default: '' }, aliases: { default: '' }, see: { default: '' }, src: { default: '' } }, content: 'none' },
  { render: (p) => <Definition {...p} /> },
);

export const schema = BlockNoteSchema.create({
  blockSpecs: { ...defaultBlockSpecs, requirement: requirement(), diagram: diagram(), endpoint: endpoint(), definition: definition() },
});
export type SpecSchema = typeof schema;
