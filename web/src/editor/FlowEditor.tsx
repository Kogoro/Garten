import { useMemo } from 'react';
import { DIRECTIONS, LINKS, SHAPES, emptyFlowchart, freeId, parseFlowchart, serializeFlowchart, type Direction, type Flowchart, type LinkKind, type Shape } from './flowchart';

/** Visual editor for flowcharts: change steps and connections with fields, the Mermaid code is written for you. */
export function FlowEditor({ text, onChange, readOnly }: { text: string; onChange: (next: string) => void; readOnly?: boolean }) {
  const chart = useMemo(() => parseFlowchart(text), [text]);
  if (!chart) {
    return (
      <div className="fe fe-unsupported" role="note">
        <p>The visual editor handles simple flowcharts (steps and connections). This diagram uses something else – a different diagram type, groups, styles or comments – so edit it as code.</p>
        {!readOnly && <button type="button" className="btn small" data-act="fe-reset" onClick={() => confirm('Replace this diagram with a new flowchart? The current code is lost.') && onChange(serializeFlowchart({ ...emptyFlowchart(), nodes: [{ id: 'A', label: 'Start', shape: 'round' }, { id: 'B', label: 'Next step', shape: 'rect' }], edges: [{ from: 'A', to: 'B', kind: 'arrow', label: '' }] }))}>Start a new flowchart</button>}
      </div>
    );
  }
  const set = (next: Flowchart) => onChange(serializeFlowchart(next));
  const ids = chart.nodes.map((n) => n.id);
  const name = (id: string) => chart.nodes.find((n) => n.id === id)?.label.trim() || id;
  const patchNode = (id: string, p: { label?: string; shape?: Shape }) => set({ ...chart, nodes: chart.nodes.map((n) => (n.id === id ? { ...n, ...p } : n)) });
  const patchEdge = (i: number, p: Partial<Flowchart['edges'][number]>) => set({ ...chart, edges: chart.edges.map((e, j) => (j === i ? { ...e, ...p } : e)) });
  const addNode = () => set({ ...chart, nodes: [...chart.nodes, { id: freeId(ids), label: 'New step', shape: 'rect' }] });
  const addEdge = () => {
    const last = ids[ids.length - 1], first = ids.length > 1 ? ids[ids.length - 2] : ids[0];
    if (!last) return;
    set({ ...chart, edges: [...chart.edges, { from: first, to: last, kind: 'arrow', label: '' }] });
  };
  return (
    <div className="fe">
      <div className="fe-row">
        <label htmlFor="fe-dir">Direction</label>
        <select id="fe-dir" className="field" disabled={readOnly} value={chart.dir} onChange={(e) => set({ ...chart, dir: e.target.value as Direction })}>{DIRECTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      </div>

      <h4>Steps</h4>
      {!chart.nodes.length && <p className="muted">No steps yet.</p>}
      {chart.nodes.map((n) => (
        <div className="fe-row" key={n.id} data-node={n.id}>
          <span className="chip mono" title="Id in the code">{n.id}</span>
          <input className="field" aria-label={`Text of step ${n.id}`} disabled={readOnly} value={n.label} onChange={(e) => patchNode(n.id, { label: e.target.value })} maxLength={120} />
          <select className="field fe-narrow" aria-label={`Shape of step ${n.id}`} disabled={readOnly} value={n.shape} onChange={(e) => patchNode(n.id, { shape: e.target.value as Shape })}>{SHAPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          {!readOnly && <button type="button" className="btn small" aria-label={`Remove step ${n.id}`} title="Remove step and its connections" onClick={() => set({ ...chart, nodes: chart.nodes.filter((x) => x.id !== n.id), edges: chart.edges.filter((e) => e.from !== n.id && e.to !== n.id) })}>✕</button>}
        </div>
      ))}
      {!readOnly && <button type="button" className="btn small" data-act="fe-add-node" onClick={addNode}>+ Add step</button>}

      <h4>Connections</h4>
      {!chart.edges.length && <p className="muted">No connections yet.{ids.length < 2 ? ' Add two steps first.' : ''}</p>}
      {chart.edges.map((e, i) => (
        <div className="fe-row fe-edge" key={i} data-edge={i}>
          <select className="field" aria-label={`Connection ${i + 1} from`} disabled={readOnly} value={e.from} onChange={(ev) => patchEdge(i, { from: ev.target.value })}>{chart.nodes.map((n) => <option key={n.id} value={n.id}>{name(n.id)}</option>)}</select>
          <select className="field fe-narrow" aria-label={`Connection ${i + 1} style`} disabled={readOnly} value={e.kind} onChange={(ev) => patchEdge(i, { kind: ev.target.value as LinkKind })}>{LINKS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <select className="field" aria-label={`Connection ${i + 1} to`} disabled={readOnly} value={e.to} onChange={(ev) => patchEdge(i, { to: ev.target.value })}>{chart.nodes.map((n) => <option key={n.id} value={n.id}>{name(n.id)}</option>)}</select>
          <input className="field" aria-label={`Connection ${i + 1} label`} placeholder="Label (optional)" disabled={readOnly} value={e.label} maxLength={80} onChange={(ev) => patchEdge(i, { label: ev.target.value })} />
          {!readOnly && <button type="button" className="btn small" aria-label={`Remove connection ${i + 1}`} onClick={() => set({ ...chart, edges: chart.edges.filter((_, j) => j !== i) })}>✕</button>}
        </div>
      ))}
      {!readOnly && ids.length > 0 && <button type="button" className="btn small" data-act="fe-add-edge" onClick={addEdge}>+ Add connection</button>}
    </div>
  );
}
