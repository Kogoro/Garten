import { useMemo, type ComponentType, type ReactNode } from 'react';
import { FlowEditor } from './FlowEditor';
import { freeId, serializeFlowchart } from './flowchart';
import {
  CLASS_ARROWS, ER_KEYS, ER_LEFT, ER_RIGHT, NOTE_POS, SEQ_ARROWS, START_END, emptyClass, emptyEr, emptyPie, emptySequence, emptyState, freeName,
  parseClass, parseEr, parsePie, parseSequence, parseState, serializeClass, serializeEr, serializePie, serializeSequence, serializeState,
  type ClassChart, type ErChart, type Pie, type Sequence, type SeqItem, type StateChart,
} from './diagramModels';

export interface FormProps { text: string; onChange: (next: string) => void; readOnly?: boolean }
export interface DiagramKind { key: string; label: string; match: RegExp; template: string; Form: ComponentType<FormProps> }

// ---------------------------------------------------------------- small building blocks
const Txt = ({ value, onChange, label, ro, placeholder, wide }: { value: string; onChange: (v: string) => void; label: string; ro: boolean; placeholder?: string; wide?: boolean }) => <input className={`field${wide ? '' : ' fe-narrow'}`} aria-label={label} placeholder={placeholder} disabled={ro} value={value} maxLength={160} onChange={(e) => onChange(e.target.value)} />;
const Sel = ({ value, onChange, label, ro, options, narrow }: { value: string; onChange: (v: string) => void; label: string; ro: boolean; options: readonly (readonly [string, string])[]; narrow?: boolean }) => <select className={`field${narrow ? ' fe-narrow' : ''}`} aria-label={label} disabled={ro} value={value} onChange={(e) => onChange(e.target.value)}>{options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>;
const Del = ({ onClick, label }: { onClick: () => void; label: string }) => <button type="button" className="btn small" aria-label={label} title={label} onClick={onClick}>✕</button>;
const Add = ({ onClick, children, act }: { onClick: () => void; children: ReactNode; act?: string }) => <button type="button" className="btn small" data-act={act} onClick={onClick}>+ {children}</button>;
const Head = ({ children }: { children: ReactNode }) => <h4>{children}</h4>;
const Row = ({ children, attr }: { children: ReactNode; attr?: Record<string, string | number> }) => <div className="fe-row" {...attr}>{children}</div>;
const ident = (s: string, extra = '') => s.replace(new RegExp(`[^A-Za-z0-9_${extra}]`, 'g'), '');
const move = <T,>(arr: T[], i: number, d: number) => { const j = i + d; if (j < 0 || j >= arr.length) return arr; const c = [...arr]; [c[i], c[j]] = [c[j], c[i]]; return c; };
const upd = <T,>(arr: T[], i: number, p: Partial<T>) => arr.map((x, j) => (j === i ? { ...x, ...p } : x));
const drop = <T,>(arr: T[], i: number) => arr.filter((_, j) => j !== i);

/** Wraps a model: parse the text, render the body, write the model back as text. Unsupported code gets a note instead of a form. */
function modelForm<M>(parse: (s: string) => M | null, serialize: (m: M) => string, empty: () => M, Body: ComponentType<{ m: M; set: (m: M) => void; ro: boolean }>): ComponentType<FormProps> {
  return function Form({ text, onChange, readOnly }: FormProps) {
    const m = useMemo(() => parse(text), [text]);
    if (!m) {
      return (
        <div className="fe fe-unsupported" role="note">
          <p>This diagram uses syntax the form cannot write back (groups, styles, notes, generics …), so it is edited as code. The form never changes what it does not understand.</p>
          {!readOnly && <button type="button" className="btn small" data-act="fe-reset" onClick={() => confirm('Replace this diagram with a new example? The current code is lost.') && onChange(serialize(empty()))}>Start from an example</button>}
        </div>
      );
    }
    return <div className="fe"><Body m={m} set={(n) => onChange(serialize(n))} ro={!!readOnly} /></div>;
  };
}

// ---------------------------------------------------------------- sequence diagram
const SequenceForm = modelForm<Sequence>(parseSequence, serializeSequence, emptySequence, ({ m, set, ro }) => {
  const ids = m.participants.map((p) => p.id);
  const opts = m.participants.map((p) => [p.id, p.label || p.id] as const);
  const setItem = (i: number, p: Partial<SeqItem>) => set({ ...m, items: upd(m.items, i, p as never) });
  return (<>
    <label className="check"><input type="checkbox" disabled={ro} checked={m.autonumber} onChange={(e) => set({ ...m, autonumber: e.target.checked })} /> Number the messages</label>
    <Head>Participants</Head>
    {m.participants.map((p, i) => (
      <Row key={p.id} attr={{ 'data-participant': p.id }}>
        <span className="chip mono" title="Id in the code">{p.id}</span>
        <Txt wide label={`Name of ${p.id}`} ro={ro} value={p.label} onChange={(v) => set({ ...m, participants: upd(m.participants, i, { label: v }) })} />
        <label className="check"><input type="checkbox" disabled={ro} checked={p.actor} onChange={(e) => set({ ...m, participants: upd(m.participants, i, { actor: e.target.checked }) })} /> Person</label>
        {!ro && <Del label={`Remove ${p.id} and its messages`} onClick={() => set({ ...m, participants: drop(m.participants, i), items: m.items.filter((x) => (x.type === 'msg' ? x.from !== p.id && x.to !== p.id : x.a !== p.id && x.b !== p.id)) })} />}
      </Row>
    ))}
    {!ro && <Add act="fe-add-participant" onClick={() => set({ ...m, participants: [...m.participants, { id: freeId(ids), label: 'New participant', actor: false }] })}>Add participant</Add>}
    <Head>Messages and notes (top to bottom)</Head>
    {m.items.map((x, i) => (
      <Row key={i} attr={{ 'data-item': i }}>
        {x.type === 'msg' ? (<>
          <Sel label={`Message ${i + 1} from`} ro={ro} value={x.from} options={opts} onChange={(v) => setItem(i, { from: v })} />
          <Sel narrow label={`Message ${i + 1} arrow`} ro={ro} value={x.arrow} options={SEQ_ARROWS} onChange={(v) => setItem(i, { arrow: v as never })} />
          <Sel label={`Message ${i + 1} to`} ro={ro} value={x.to} options={opts} onChange={(v) => setItem(i, { to: v })} />
        </>) : (<>
          <Sel narrow label={`Note ${i + 1} position`} ro={ro} value={x.pos} options={NOTE_POS} onChange={(v) => setItem(i, { pos: v as never })} />
          <Sel label={`Note ${i + 1} participant`} ro={ro} value={x.a} options={opts} onChange={(v) => setItem(i, { a: v })} />
          {x.pos === 'over' && <Sel label={`Note ${i + 1} second participant`} ro={ro} value={x.b} options={[['', '(only one)'], ...opts]} onChange={(v) => setItem(i, { b: v })} />}
        </>)}
        <Txt wide label={`${x.type === 'msg' ? 'Message' : 'Note'} ${i + 1} text`} placeholder="Text" ro={ro} value={x.text} onChange={(v) => setItem(i, { text: v })} />
        {!ro && <><button type="button" className="btn small" aria-label={`Move ${i + 1} up`} disabled={i === 0} onClick={() => set({ ...m, items: move(m.items, i, -1) })}>↑</button>
          <button type="button" className="btn small" aria-label={`Move ${i + 1} down`} disabled={i === m.items.length - 1} onClick={() => set({ ...m, items: move(m.items, i, 1) })}>↓</button>
          <Del label={`Remove ${i + 1}`} onClick={() => set({ ...m, items: drop(m.items, i) })} /></>}
      </Row>
    ))}
    {!ro && ids.length > 0 && <div className="fe-row">
      <Add act="fe-add-msg" onClick={() => set({ ...m, items: [...m.items, { type: 'msg', from: ids[0], to: ids[ids.length - 1], arrow: '->>', text: 'Message' }] })}>Add message</Add>
      <Add onClick={() => set({ ...m, items: [...m.items, { type: 'note', pos: 'right of', a: ids[ids.length - 1], b: '', text: 'Note' }] })}>Add note</Add>
    </div>}
  </>);
});

// ---------------------------------------------------------------- state diagram
const StateForm = modelForm<StateChart>(parseState, serializeState, emptyState, ({ m, set, ro }) => {
  const opts: [string, string][] = [[START_END, '● Start / end'], ...m.states.map((s) => [s.id, s.label || s.id] as [string, string])];
  return (<>
    <Row><span>Direction</span><Sel label="Direction" ro={ro} value={m.dir} options={[['', 'Automatic'], ['TB', 'Top → bottom'], ['LR', 'Left → right']]} onChange={(v) => set({ ...m, dir: v as never })} /></Row>
    <Head>States</Head>
    {m.states.map((s, i) => (
      <Row key={s.id} attr={{ 'data-state': s.id }}>
        <Txt wide label={`Name of state ${s.id}`} ro={ro} value={s.label} onChange={(v) => set({ ...m, states: upd(m.states, i, { label: v }) })} />
        {!ro && <Del label={`Remove state ${s.id} and its transitions`} onClick={() => set({ ...m, states: drop(m.states, i), transitions: m.transitions.filter((t) => t.from !== s.id && t.to !== s.id) })} />}
      </Row>
    ))}
    {!ro && <Add act="fe-add-state" onClick={() => { const id = freeName('State', m.states.map((s) => s.id)); set({ ...m, states: [...m.states, { id, label: id }] }); }}>Add state</Add>}
    <Head>Transitions</Head>
    {m.transitions.map((t, i) => (
      <Row key={i} attr={{ 'data-transition': i }}>
        <Sel label={`Transition ${i + 1} from`} ro={ro} value={t.from} options={opts} onChange={(v) => set({ ...m, transitions: upd(m.transitions, i, { from: v }) })} />
        <span aria-hidden>→</span>
        <Sel label={`Transition ${i + 1} to`} ro={ro} value={t.to} options={opts} onChange={(v) => set({ ...m, transitions: upd(m.transitions, i, { to: v }) })} />
        <Txt wide label={`Transition ${i + 1} label`} placeholder="Event (optional)" ro={ro} value={t.label} onChange={(v) => set({ ...m, transitions: upd(m.transitions, i, { label: v }) })} />
        {!ro && <Del label={`Remove transition ${i + 1}`} onClick={() => set({ ...m, transitions: drop(m.transitions, i) })} />}
      </Row>
    ))}
    {!ro && <Add act="fe-add-transition" onClick={() => set({ ...m, transitions: [...m.transitions, { from: m.states[0]?.id ?? START_END, to: m.states[m.states.length - 1]?.id ?? START_END, label: '' }] })}>Add transition</Add>}
  </>);
});

// ---------------------------------------------------------------- ER diagram
const ErForm = modelForm<ErChart>(parseEr, serializeEr, emptyEr, ({ m, set, ro }) => {
  const opts = m.entities.map((e) => [e.name, e.name] as const);
  const rename = (i: number, raw: string) => {
    const name = ident(raw, '-'); const old = m.entities[i].name;
    if (!name || !/^[A-Za-z_]/.test(name) || (name !== old && m.entities.some((e) => e.name === name))) return;
    set({ entities: upd(m.entities, i, { name }), relations: m.relations.map((r) => ({ ...r, a: r.a === old ? name : r.a, b: r.b === old ? name : r.b })) });
  };
  return (<>
    <Head>Entities</Head>
    {m.entities.map((e, i) => (
      <fieldset className="fe-card" key={e.name} data-entity={e.name}>
        <Row>
          <Txt wide label={`Entity ${i + 1} name`} ro={ro} value={e.name} onChange={(v) => rename(i, v)} />
          {!ro && <Del label={`Remove ${e.name} and its relations`} onClick={() => set({ entities: drop(m.entities, i), relations: m.relations.filter((r) => r.a !== e.name && r.b !== e.name) })} />}
        </Row>
        {e.attrs.map((a, j) => (
          <Row key={j}>
            <Txt label={`${e.name} attribute ${j + 1} type`} placeholder="type" ro={ro} value={a.type} onChange={(v) => set({ ...m, entities: upd(m.entities, i, { attrs: upd(e.attrs, j, { type: ident(v, '()') }) }) })} />
            <Txt wide label={`${e.name} attribute ${j + 1} name`} placeholder="name" ro={ro} value={a.name} onChange={(v) => { const n = ident(v); if (n) set({ ...m, entities: upd(m.entities, i, { attrs: upd(e.attrs, j, { name: n }) }) }); }} />
            <Sel narrow label={`${e.name} attribute ${j + 1} key`} ro={ro} value={a.key} options={ER_KEYS.map((k) => [k, k || 'No key'] as const)} onChange={(v) => set({ ...m, entities: upd(m.entities, i, { attrs: upd(e.attrs, j, { key: v as never }) }) })} />
            {!ro && <Del label={`Remove attribute ${j + 1}`} onClick={() => set({ ...m, entities: upd(m.entities, i, { attrs: drop(e.attrs, j) }) })} />}
          </Row>
        ))}
        {!ro && <Add onClick={() => set({ ...m, entities: upd(m.entities, i, { attrs: [...e.attrs, { type: 'string', name: freeName('field', e.attrs.map((a) => a.name)), key: '' }] }) })}>Add attribute</Add>}
      </fieldset>
    ))}
    {!ro && <Add act="fe-add-entity" onClick={() => set({ ...m, entities: [...m.entities, { name: freeName('ENTITY', m.entities.map((e) => e.name)), attrs: [] }] })}>Add entity</Add>}
    <Head>Relations</Head>
    {m.relations.map((r, i) => (
      <Row key={i} attr={{ 'data-relation': i }}>
        <Sel label={`Relation ${i + 1} from`} ro={ro} value={r.a} options={opts} onChange={(v) => set({ ...m, relations: upd(m.relations, i, { a: v }) })} />
        <Sel narrow label={`Relation ${i + 1} left cardinality`} ro={ro} value={r.left} options={ER_LEFT} onChange={(v) => set({ ...m, relations: upd(m.relations, i, { left: v }) })} />
        <Sel narrow label={`Relation ${i + 1} line`} ro={ro} value={r.line} options={[['--', 'Identifying'], ['..', 'Non-identifying']]} onChange={(v) => set({ ...m, relations: upd(m.relations, i, { line: v as never }) })} />
        <Sel narrow label={`Relation ${i + 1} right cardinality`} ro={ro} value={r.right} options={ER_RIGHT} onChange={(v) => set({ ...m, relations: upd(m.relations, i, { right: v }) })} />
        <Sel label={`Relation ${i + 1} to`} ro={ro} value={r.b} options={opts} onChange={(v) => set({ ...m, relations: upd(m.relations, i, { b: v }) })} />
        <Txt wide label={`Relation ${i + 1} label`} placeholder="Verb, e.g. places" ro={ro} value={r.label} onChange={(v) => set({ ...m, relations: upd(m.relations, i, { label: v }) })} />
        {!ro && <Del label={`Remove relation ${i + 1}`} onClick={() => set({ ...m, relations: drop(m.relations, i) })} />}
      </Row>
    ))}
    {!ro && m.entities.length > 0 && <Add act="fe-add-relation" onClick={() => set({ ...m, relations: [...m.relations, { a: m.entities[0].name, left: '||', line: '--', right: 'o{', b: m.entities[m.entities.length - 1].name, label: 'has' }] })}>Add relation</Add>}
  </>);
});

// ---------------------------------------------------------------- class diagram
const ClassForm = modelForm<ClassChart>(parseClass, serializeClass, emptyClass, ({ m, set, ro }) => {
  const opts = m.classes.map((c) => [c.name, c.name] as const);
  const rename = (i: number, raw: string) => {
    const name = ident(raw); const old = m.classes[i].name;
    if (!name || !/^[A-Za-z_]/.test(name) || (name !== old && m.classes.some((c) => c.name === name))) return;
    set({ classes: upd(m.classes, i, { name }), relations: m.relations.map((r) => ({ ...r, a: r.a === old ? name : r.a, b: r.b === old ? name : r.b })) });
  };
  return (<>
    <Head>Classes</Head>
    {m.classes.map((c, i) => (
      <fieldset className="fe-card" key={c.name} data-class={c.name}>
        <Row>
          <Txt wide label={`Class ${i + 1} name`} ro={ro} value={c.name} onChange={(v) => rename(i, v)} />
          {!ro && <Del label={`Remove ${c.name} and its relations`} onClick={() => set({ classes: drop(m.classes, i), relations: m.relations.filter((r) => r.a !== c.name && r.b !== c.name) })} />}
        </Row>
        {c.members.map((x, j) => (
          <Row key={j}>
            <Txt wide label={`${c.name} member ${j + 1}`} placeholder="+String name   or   +save() bool" ro={ro} value={x} onChange={(v) => set({ ...m, classes: upd(m.classes, i, { members: upd(c.members, j, v as never) as never }) })} />
            {!ro && <Del label={`Remove member ${j + 1}`} onClick={() => set({ ...m, classes: upd(m.classes, i, { members: drop(c.members, j) }) })} />}
          </Row>
        ))}
        {!ro && <Add onClick={() => set({ ...m, classes: upd(m.classes, i, { members: [...c.members, '+member'] }) })}>Add member</Add>}
      </fieldset>
    ))}
    {!ro && <Add act="fe-add-class" onClick={() => set({ ...m, classes: [...m.classes, { name: freeName('Class', m.classes.map((c) => c.name)), members: [] }] })}>Add class</Add>}
    <Head>Relations</Head>
    {m.relations.map((r, i) => (
      <Row key={i} attr={{ 'data-relation': i }}>
        <Sel label={`Relation ${i + 1} from`} ro={ro} value={r.a} options={opts} onChange={(v) => set({ ...m, relations: upd(m.relations, i, { a: v }) })} />
        <Sel narrow label={`Relation ${i + 1} kind`} ro={ro} value={r.arrow} options={CLASS_ARROWS} onChange={(v) => set({ ...m, relations: upd(m.relations, i, { arrow: v }) })} />
        <Sel label={`Relation ${i + 1} to`} ro={ro} value={r.b} options={opts} onChange={(v) => set({ ...m, relations: upd(m.relations, i, { b: v }) })} />
        <Txt wide label={`Relation ${i + 1} label`} placeholder="Label (optional)" ro={ro} value={r.label} onChange={(v) => set({ ...m, relations: upd(m.relations, i, { label: v }) })} />
        {!ro && <Del label={`Remove relation ${i + 1}`} onClick={() => set({ ...m, relations: drop(m.relations, i) })} />}
      </Row>
    ))}
    {!ro && m.classes.length > 0 && <Add act="fe-add-relation" onClick={() => set({ ...m, relations: [...m.relations, { a: m.classes[0].name, arrow: '-->', b: m.classes[m.classes.length - 1].name, label: '' }] })}>Add relation</Add>}
  </>);
});

// ---------------------------------------------------------------- pie chart
const PieForm = modelForm<Pie>(parsePie, serializePie, emptyPie, ({ m, set, ro }) => (<>
  <Row><Txt wide label="Title" placeholder="Title" ro={ro} value={m.title} onChange={(v) => set({ ...m, title: v })} /></Row>
  <label className="check"><input type="checkbox" disabled={ro} checked={m.showData} onChange={(e) => set({ ...m, showData: e.target.checked })} /> Show the values</label>
  <Head>Slices</Head>
  {m.slices.map((s, i) => (
    <Row key={i} attr={{ 'data-slice': i }}>
      <Txt wide label={`Slice ${i + 1} label`} ro={ro} value={s.label} onChange={(v) => set({ ...m, slices: upd(m.slices, i, { label: v }) })} />
      <input className="field fe-narrow" type="number" min={0} step="any" aria-label={`Slice ${i + 1} value`} disabled={ro} value={s.value} onChange={(e) => set({ ...m, slices: upd(m.slices, i, { value: e.target.value }) })} />
      {!ro && <Del label={`Remove slice ${i + 1}`} onClick={() => set({ ...m, slices: drop(m.slices, i) })} />}
    </Row>
  ))}
  {!ro && <Add act="fe-add-slice" onClick={() => set({ ...m, slices: [...m.slices, { label: 'New', value: '10' }] })}>Add slice</Add>}
</>));

// ---------------------------------------------------------------- registry
const SAMPLE_FLOW = serializeFlowchart({ dir: 'TD', nodes: [{ id: 'A', label: 'Start', shape: 'round' }, { id: 'B', label: 'Check', shape: 'diamond' }, { id: 'C', label: 'Done', shape: 'rect' }], edges: [{ from: 'A', to: 'B', kind: 'arrow', label: '' }, { from: 'B', to: 'C', kind: 'arrow', label: 'ok' }] });

/** Diagram types with a form. */
export const KINDS: DiagramKind[] = [
  { key: 'flowchart', label: 'Flowchart', match: /^(flowchart|graph)\b/, template: SAMPLE_FLOW, Form: FlowEditor },
  { key: 'sequence', label: 'Sequence diagram', match: /^sequenceDiagram\b/, template: serializeSequence(emptySequence()), Form: SequenceForm },
  { key: 'state', label: 'State diagram', match: /^stateDiagram/, template: serializeState(emptyState()), Form: StateForm },
  { key: 'er', label: 'Entity-relationship diagram', match: /^erDiagram\b/, template: serializeEr(emptyEr()), Form: ErForm },
  { key: 'class', label: 'Class diagram', match: /^classDiagram\b/, template: serializeClass(emptyClass()), Form: ClassForm },
  { key: 'pie', label: 'Pie chart', match: /^pie\b/, template: serializePie(emptyPie()), Form: PieForm },
];

/** Diagram types that are edited as code (with a starting example). */
export const CODE_KINDS: { key: string; label: string; match: RegExp; template: string }[] = [
  { key: 'gantt', label: 'Gantt chart', match: /^gantt\b/, template: 'gantt\n  title Plan\n  dateFormat YYYY-MM-DD\n  section Build\n    Design :a1, 2026-01-05, 7d\n    Implement :after a1, 14d' },
  { key: 'mindmap', label: 'Mind map', match: /^mindmap\b/, template: 'mindmap\n  root((Topic))\n    Branch A\n      Detail\n    Branch B' },
  { key: 'timeline', label: 'Timeline', match: /^timeline\b/, template: 'timeline\n  title History\n  2025 : Idea\n  2026 : Release' },
  { key: 'journey', label: 'User journey', match: /^journey\b/, template: 'journey\n  title Checkout\n  section Cart\n    Add item: 5: Customer\n    Pay: 3: Customer' },
  { key: 'git', label: 'Git graph', match: /^gitGraph\b/, template: 'gitGraph\n  commit\n  branch feature\n  commit\n  checkout main\n  merge feature' },
  { key: 'quadrant', label: 'Quadrant chart', match: /^quadrantChart\b/, template: 'quadrantChart\n  title Priorities\n  x-axis Low effort --> High effort\n  y-axis Low value --> High value\n  Idea A: [0.3, 0.7]' },
];

const firstLine = (src: string) => src.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('%%')) ?? '';
export const kindOf = (src: string) => KINDS.find((k) => k.match.test(firstLine(src)));
export const codeKindOf = (src: string) => CODE_KINDS.find((k) => k.match.test(firstLine(src)));
