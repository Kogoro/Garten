import { BlockNoteSchema, defaultBlockSpecs } from '@blocknote/core';
import { createReactBlockSpec } from '@blocknote/react';
import { useEffect, useRef, useState } from 'react';
import { renderMermaid } from './mermaid';
import { FlowEditor } from './FlowEditor';

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const ro = (editor: any) => !editor.isEditable;

/** R1, R2 … (the label is renumbered on every change) */
export const requirement = createReactBlockSpec(
  { type: 'requirement', propSchema: { label: { default: 'R1' } }, content: 'inline' },
  { render: ({ block, contentRef }) => <div className="blk-req" style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}><b className="req-label" contentEditable={false} style={{ color: 'var(--accent)', minWidth: 32 }}>{block.props.label}</b><div ref={contentRef} style={{ flex: 1 }} /></div> },
);

const ZOOM_MIN = 0.1, ZOOM_MAX = 6;
const natural = (svg: string) => { const m = /viewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/.exec(svg); return m ? { w: parseFloat(m[1]), h: parseFloat(m[2]) } : null; };

/** Rendered Mermaid (debounced) with zoom: − / + buttons, Ctrl/⌘ + wheel, pinch-free dragging to pan, "Fit" and 100 %. Used by the diagram block and by form fields. */
export function MermaidView({ text }: { text: string }) {
  const [out, setOut] = useState<{ svg?: string; error?: string }>({});
  const [zoom, setZoom] = useState<number | null>(null); // null = fit: as large as the diagram is, but never wider than the box
  const [boxW, setBoxW] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { let live = true; const t = setTimeout(() => renderMermaid(text).then((r) => live && setOut(r)), 250); return () => { live = false; clearTimeout(t); }; }, [text]);
  useEffect(() => {
    const el = box.current; if (!el) return;
    const measure = () => setBoxW(Math.max(0, el.clientWidth - 30));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
  }, [out.error]);
  const size = out.svg ? natural(out.svg) : null;
  const fit = size && boxW ? Math.min(1, boxW / size.w) : 1;
  const scale = zoom ?? fit;
  const zoomBy = (f: number) => setZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale * f)));
  const zoomRef = useRef(zoomBy); zoomRef.current = zoomBy;
  useEffect(() => { // Ctrl/⌘ + wheel zooms; a plain wheel still scrolls the page
    const el = box.current; if (!el) return;
    const wheel = (e: WheelEvent) => { if (!(e.ctrlKey || e.metaKey)) return; e.preventDefault(); zoomRef.current(e.deltaY < 0 ? 1.15 : 1 / 1.15); };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [out.error]);
  const drag = useRef<{ x: number; y: number; l: number; t: number } | null>(null);
  const down = (e: React.PointerEvent<HTMLDivElement>) => { const el = box.current; if (!el || e.button !== 0 || (el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight)) return; drag.current = { x: e.clientX, y: e.clientY, l: el.scrollLeft, t: el.scrollTop }; el.setPointerCapture(e.pointerId); };
  const move = (e: React.PointerEvent<HTMLDivElement>) => { const d = drag.current, el = box.current; if (d && el) { el.scrollLeft = d.l - (e.clientX - d.x); el.scrollTop = d.t - (e.clientY - d.y); } };
  const up = () => { drag.current = null; };
  const key = (e: React.KeyboardEvent) => { if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomBy(1.25); } else if (e.key === '-') { e.preventDefault(); zoomBy(0.8); } else if (e.key === '0') { e.preventDefault(); setZoom(null); } };
  return (
    <div className="mm-wrap">
      {out.svg && !out.error && <div className="mm-tools" role="group" aria-label="Zoom">
        <button type="button" data-act="mm-out" aria-label="Zoom out" title="Zoom out" disabled={scale <= ZOOM_MIN} onClick={() => zoomBy(0.8)}>−</button>
        <span className="mm-pct" aria-live="polite">{Math.round(scale * 100)}%</span>
        <button type="button" data-act="mm-in" aria-label="Zoom in" title="Zoom in" disabled={scale >= ZOOM_MAX} onClick={() => zoomBy(1.25)}>+</button>
        <button type="button" data-act="mm-fit" title="Fit into the box" aria-pressed={zoom === null} onClick={() => setZoom(null)}>Fit</button>
        <button type="button" data-act="mm-100" title="Actual size" aria-pressed={zoom === 1} onClick={() => setZoom(1)}>100%</button>
      </div>}
      <div ref={box} className={`mm${out.error ? ' err' : ''}`} tabIndex={out.svg && !out.error ? 0 : undefined} aria-label={out.error ? undefined : 'Diagram – use + and − to zoom, 0 to fit'} onKeyDown={key} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        {out.error ? <span className="mm-hint">{out.error}</span>
          : <div className="mm-svg" style={size ? { width: size.w * scale, height: size.h * scale } : undefined} dangerouslySetInnerHTML={{ __html: out.svg ?? '' }} />}
      </div>
    </div>
  );
}

type View = 'view' | 'code' | 'split' | 'edit';
function Diagram({ block, editor }: any) {
  const { text, view } = block.props as { text: string; view: View };
  const set = (p: Record<string, unknown>) => editor.updateBlock(block, { props: p });
  const showCode = view === 'code' || view === 'split';
  const showView = view !== 'code';
  const two = view === 'split' || view === 'edit';
  return (
    <div className="diagram" data-view={view} style={{ width: '100%' }}>
      <div className="seg sm" role="group" aria-label="Diagram view">
        {([['view', 'Diagram'], ['code', 'Code'], ['split', 'Split'], ['edit', 'Visual']] as const).map(([k, l]) => <button key={k} type="button" data-act={`dg-${k}`} aria-pressed={view === k} onClick={() => set({ view: k })}>{l}</button>)}
      </div>
      <div className="dg-body" style={{ display: 'grid', gridTemplateColumns: two ? 'repeat(auto-fit, minmax(280px, 1fr))' : '1fr', gap: 8 }}>
        {showCode && <textarea className="blk-in mono" aria-label="Mermaid source" spellCheck={false} readOnly={ro(editor)} value={text} rows={Math.max(4, text.split('\n').length)} onChange={(e) => set({ text: e.target.value })} />}
        {view === 'edit' && <FlowEditor text={text} readOnly={ro(editor)} onChange={(t) => set({ text: t })} />}
        {showView && <MermaidView text={text} />}
      </div>
    </div>
  );
}
export const diagram = createReactBlockSpec(
  { type: 'diagram', propSchema: { text: { default: 'flowchart LR\n  A --> B' }, view: { default: 'split', values: ['view', 'code', 'split', 'edit'] } }, content: 'none' },
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
