// Models of further Mermaid diagram types for the visual editor (flowcharts live in flowchart.ts).
// Every parse*() returns null for anything it could not write back, so the editor never drops what a person wrote in the code.

const ID = '[A-Za-z_][A-Za-z0-9_]*';
const lines = (src: string) => src.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
const clean = (s: string) => s.replace(/\n/g, ' ');
const unq = (s: string) => { const t = s.trim(); return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t; };

/** First free name `base`, `base2`, … */
export function freeName(base: string, used: Iterable<string>): string {
  const u = new Set(used);
  if (!u.has(base)) return base;
  for (let n = 2; ; n++) if (!u.has(`${base}${n}`)) return `${base}${n}`;
}

// ---------------------------------------------------------------- sequence diagram
export const SEQ_ARROWS = [['->>', 'Request (solid arrow)'], ['-->>', 'Reply (dashed arrow)'], ['->', 'Line'], ['-->', 'Dashed line'], ['-x', 'Lost (cross)'], ['-)', 'Async (open arrow)']] as const;
export type SeqArrow = (typeof SEQ_ARROWS)[number][0];
export const NOTE_POS = [['right of', 'Right of'], ['left of', 'Left of'], ['over', 'Over']] as const;
export interface SeqParticipant { id: string; label: string; actor: boolean }
export type SeqItem =
  | { type: 'msg'; from: string; to: string; arrow: SeqArrow; text: string }
  | { type: 'note'; pos: 'right of' | 'left of' | 'over'; a: string; b: string; text: string };
export interface Sequence { autonumber: boolean; participants: SeqParticipant[]; items: SeqItem[] }

const SEQ_MSG = new RegExp(`^(${ID})\\s*(-->>|->>|--x|-x|--\\)|-\\)|-->|->)\\s*(${ID})\\s*:\\s*(.*)$`);
const SEQ_NOTE = new RegExp(`^Note\\s+(right of|left of|over)\\s+(${ID})(?:\\s*,\\s*(${ID}))?\\s*:\\s*(.*)$`, 'i');
const SEQ_PART = new RegExp(`^(participant|actor)\\s+(${ID})(?:\\s+as\\s+(.+))?$`);
const normArrow = (a: string): SeqArrow => (a === '--x' ? '-x' : a === '--)' ? '-)' : a) as SeqArrow;

export const emptySequence = (): Sequence => ({ autonumber: false, participants: [{ id: 'A', label: 'Client', actor: false }, { id: 'B', label: 'Server', actor: false }], items: [{ type: 'msg', from: 'A', to: 'B', arrow: '->>', text: 'Request' }, { type: 'msg', from: 'B', to: 'A', arrow: '-->>', text: 'Response' }] });

export function parseSequence(src: string): Sequence | null {
  const ls = lines(src);
  if (ls[0] !== 'sequenceDiagram') return null;
  const m: Sequence = { autonumber: false, participants: [], items: [] };
  const seen = (id: string) => { if (!m.participants.some((p) => p.id === id)) m.participants.push({ id, label: id, actor: false }); };
  for (const l of ls.slice(1)) {
    let x: RegExpExecArray | null;
    if (l === 'autonumber') m.autonumber = true;
    else if ((x = SEQ_PART.exec(l))) { const p = m.participants.find((q) => q.id === x![2]); const np = { id: x[2], label: x[3]?.trim() || x[2], actor: x[1] === 'actor' }; if (p) Object.assign(p, np); else m.participants.push(np); }
    else if ((x = SEQ_MSG.exec(l))) { seen(x[1]); seen(x[3]); m.items.push({ type: 'msg', from: x[1], to: x[3], arrow: normArrow(x[2]), text: x[4].trim() }); }
    else if ((x = SEQ_NOTE.exec(l))) { seen(x[2]); if (x[3]) seen(x[3]); m.items.push({ type: 'note', pos: x[1].toLowerCase() as 'over', a: x[2], b: x[3] ?? '', text: x[4].trim() }); }
    else return null; // loop / alt / activate … : code only
  }
  return m;
}

export function serializeSequence(m: Sequence): string {
  const out = ['sequenceDiagram'];
  if (m.autonumber) out.push('  autonumber');
  for (const p of m.participants) out.push(`  ${p.actor ? 'actor' : 'participant'} ${p.id}${p.label.trim() && p.label !== p.id ? ` as ${clean(p.label)}` : ''}`);
  for (const i of m.items) {
    if (i.type === 'msg') out.push(`  ${i.from}${i.arrow}${i.to}: ${i.text.trim() ? clean(i.text) : ' '}`);
    else out.push(`  Note ${i.pos} ${i.a}${i.pos === 'over' && i.b ? `,${i.b}` : ''}: ${i.text.trim() ? clean(i.text) : ' '}`);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- state diagram
export const START_END = '[*]';
export interface StateNode { id: string; label: string }
export interface Transition { from: string; to: string; label: string }
export interface StateChart { dir: '' | 'TB' | 'LR'; states: StateNode[]; transitions: Transition[] }
const STATE_ID = `(?:\\[\\*\\]|${ID})`;
const ST_TRANS = new RegExp(`^(${STATE_ID})\\s*-->\\s*(${STATE_ID})(?:\\s*:\\s*(.*))?$`);

export const emptyState = (): StateChart => ({ dir: '', states: [{ id: 'Idle', label: 'Idle' }, { id: 'Running', label: 'Running' }], transitions: [{ from: START_END, to: 'Idle', label: '' }, { from: 'Idle', to: 'Running', label: 'start' }, { from: 'Running', to: 'Idle', label: 'stop' }, { from: 'Idle', to: START_END, label: '' }] });

export function parseState(src: string): StateChart | null {
  const ls = lines(src);
  if (!/^stateDiagram(-v2)?$/.test(ls[0] ?? '')) return null;
  const m: StateChart = { dir: '', states: [], transitions: [] };
  const seen = (id: string) => { if (id !== START_END && !m.states.some((s) => s.id === id)) m.states.push({ id, label: id }); };
  for (const l of ls.slice(1)) {
    let x: RegExpExecArray | null;
    if ((x = /^direction\s+(TB|LR)$/.exec(l))) m.dir = x[1] as 'TB';
    else if ((x = new RegExp(`^state\\s+"(.*)"\\s+as\\s+(${ID})$`).exec(l))) { seen(x[2]); m.states.find((s) => s.id === x![2])!.label = x[1]; }
    else if ((x = new RegExp(`^state\\s+(${ID})$`).exec(l))) seen(x[1]);
    else if ((x = ST_TRANS.exec(l))) { seen(x[1]); seen(x[2]); m.transitions.push({ from: x[1], to: x[2], label: (x[3] ?? '').trim() }); }
    else return null; // composite states, notes, forks … : code only
  }
  return m;
}

export function serializeState(m: StateChart): string {
  const out = ['stateDiagram-v2'];
  if (m.dir) out.push(`  direction ${m.dir}`);
  const used = new Set(m.transitions.flatMap((t) => [t.from, t.to]));
  for (const s of m.states) if (s.label.trim() && s.label !== s.id) out.push(`  state "${s.label.replace(/"/g, "'")}" as ${s.id}`); else if (!used.has(s.id)) out.push(`  state ${s.id}`);
  for (const t of m.transitions) out.push(`  ${t.from} --> ${t.to}${t.label.trim() ? ` : ${clean(t.label)}` : ''}`);
  return out.join('\n');
}

// ---------------------------------------------------------------- entity-relationship diagram
export const ER_LEFT = [['||', 'Exactly one'], ['|o', 'Zero or one'], ['}|', 'One or more'], ['}o', 'Zero or more']] as const;
export const ER_RIGHT = [['||', 'Exactly one'], ['o|', 'Zero or one'], ['|{', 'One or more'], ['o{', 'Zero or more']] as const;
export const ER_KEYS = ['', 'PK', 'FK', 'UK'] as const;
export interface ErAttr { type: string; name: string; key: '' | 'PK' | 'FK' | 'UK' }
export interface ErEntity { name: string; attrs: ErAttr[] }
export interface ErRelation { a: string; left: string; line: '--' | '..'; right: string; b: string; label: string }
export interface ErChart { entities: ErEntity[]; relations: ErRelation[] }
const ER_NAME = '[A-Za-z_][A-Za-z0-9_-]*';
const ER_REL = new RegExp(`^(${ER_NAME})\\s+(\\|\\||\\|o|\\}\\||\\}o)(--|\\.\\.)(\\|\\||o\\||\\|\\{|o\\{)\\s+(${ER_NAME})\\s*:\\s*(.+)$`);

export const emptyEr = (): ErChart => ({ entities: [{ name: 'CUSTOMER', attrs: [{ type: 'string', name: 'name', key: '' }, { type: 'int', name: 'id', key: 'PK' }] }, { name: 'ORDER', attrs: [{ type: 'int', name: 'id', key: 'PK' }] }], relations: [{ a: 'CUSTOMER', left: '||', line: '--', right: 'o{', b: 'ORDER', label: 'places' }] });

export function parseEr(src: string): ErChart | null {
  const ls = lines(src);
  if (ls[0] !== 'erDiagram') return null;
  const m: ErChart = { entities: [], relations: [] };
  const ent = (name: string) => { let e = m.entities.find((x) => x.name === name); if (!e) { e = { name, attrs: [] }; m.entities.push(e); } return e; };
  for (let i = 1; i < ls.length; i++) {
    const l = ls[i];
    let x: RegExpExecArray | null;
    if ((x = new RegExp(`^(${ER_NAME})\\s*\\{$`).exec(l))) {
      const e = ent(x[1]);
      for (i++; i < ls.length && ls[i] !== '}'; i++) {
        const a = /^(\S+)\s+([A-Za-z_][\w]*)(?:\s+(PK|FK|UK))?$/.exec(ls[i]);
        if (!a) return null;
        e.attrs.push({ type: a[1], name: a[2], key: (a[3] ?? '') as ErAttr['key'] });
      }
      if (ls[i] !== '}') return null;
    } else if ((x = ER_REL.exec(l))) { ent(x[1]); ent(x[5]); m.relations.push({ a: x[1], left: x[2], line: x[3] as '--', right: x[4], b: x[5], label: unq(x[6]) }); }
    else if (new RegExp(`^${ER_NAME}$`).test(l)) ent(l);
    else return null;
  }
  return m;
}

export function serializeEr(m: ErChart): string {
  const out = ['erDiagram'];
  for (const e of m.entities) {
    if (e.attrs.length) { out.push(`  ${e.name} {`); for (const a of e.attrs) out.push(`    ${a.type.trim() || 'string'} ${a.name.trim() || 'field'}${a.key ? ` ${a.key}` : ''}`); out.push('  }'); }
    else if (!m.relations.some((r) => r.a === e.name || r.b === e.name)) out.push(`  ${e.name}`);
  }
  for (const r of m.relations) out.push(`  ${r.a} ${r.left}${r.line}${r.right} ${r.b} : ${r.label.trim() ? (/^[\w-]+$/.test(r.label) ? r.label : `"${r.label.replace(/"/g, "'")}"`) : '""'}`);
  return out.join('\n');
}

// ---------------------------------------------------------------- class diagram
export const CLASS_ARROWS = [['<|--', 'Inheritance (A is the parent)'], ['*--', 'Composition'], ['o--', 'Aggregation'], ['-->', 'Association'], ['--', 'Link'], ['..>', 'Dependency'], ['..|>', 'Realization'], ['..', 'Dashed link']] as const;
export interface ClassNode { name: string; members: string[] }
export interface ClassRel { a: string; arrow: string; b: string; label: string }
export interface ClassChart { classes: ClassNode[]; relations: ClassRel[] }
const CL_REL = new RegExp(`^(${ID})\\s+(<\\|--|\\*--|o--|-->|--|\\.\\.\\|>|\\.\\.>|\\.\\.)\\s+(${ID})(?:\\s*:\\s*(.*))?$`);

export const emptyClass = (): ClassChart => ({ classes: [{ name: 'Animal', members: ['+String name', '+eat() void'] }, { name: 'Dog', members: ['+bark() void'] }], relations: [{ a: 'Animal', arrow: '<|--', b: 'Dog', label: '' }] });

export function parseClass(src: string): ClassChart | null {
  const ls = lines(src);
  if (ls[0] !== 'classDiagram') return null;
  const m: ClassChart = { classes: [], relations: [] };
  const cls = (name: string) => { let c = m.classes.find((x) => x.name === name); if (!c) { c = { name, members: [] }; m.classes.push(c); } return c; };
  for (let i = 1; i < ls.length; i++) {
    const l = ls[i];
    let x: RegExpExecArray | null;
    if ((x = new RegExp(`^class\\s+(${ID})\\s*\\{$`).exec(l))) {
      const c = cls(x[1]);
      for (i++; i < ls.length && ls[i] !== '}'; i++) { if (/[{}]/.test(ls[i]) || ls[i].startsWith('<<')) return null; c.members.push(ls[i]); }
      if (ls[i] !== '}') return null;
    } else if ((x = new RegExp(`^class\\s+(${ID})$`).exec(l))) cls(x[1]);
    else if ((x = CL_REL.exec(l))) { cls(x[1]); cls(x[3]); m.relations.push({ a: x[1], arrow: x[2], b: x[3], label: (x[4] ?? '').trim() }); }
    else if ((x = new RegExp(`^(${ID})\\s*:\\s*(.+)$`).exec(l))) cls(x[1]).members.push(x[2].trim());
    else return null; // generics, cardinalities, notes, namespaces … : code only
  }
  return m;
}

export function serializeClass(m: ClassChart): string {
  const out = ['classDiagram'];
  for (const c of m.classes) {
    if (c.members.length) { out.push(`  class ${c.name} {`); for (const x of c.members) out.push(`    ${clean(x)}`); out.push('  }'); }
    else if (!m.relations.some((r) => r.a === c.name || r.b === c.name)) out.push(`  class ${c.name}`);
  }
  for (const r of m.relations) out.push(`  ${r.a} ${r.arrow} ${r.b}${r.label.trim() ? ` : ${clean(r.label)}` : ''}`);
  return out.join('\n');
}

// ---------------------------------------------------------------- pie chart
export interface PieSlice { label: string; value: string }
export interface Pie { title: string; showData: boolean; slices: PieSlice[] }
export const emptyPie = (): Pie => ({ title: 'Share', showData: false, slices: [{ label: 'A', value: '60' }, { label: 'B', value: '40' }] });

export function parsePie(src: string): Pie | null {
  const ls = lines(src);
  const head = /^pie(?:\s+(showData))?(?:\s+title\s+(.*))?$/.exec(ls[0] ?? '');
  if (!head) return null;
  const m: Pie = { title: (head[2] ?? '').trim(), showData: !!head[1], slices: [] };
  for (const l of ls.slice(1)) {
    const s = /^"(.*)"\s*:\s*(-?\d+(?:\.\d+)?)$/.exec(l);
    if (!s) return null;
    m.slices.push({ label: s[1], value: s[2] });
  }
  return m;
}

export function serializePie(m: Pie): string {
  const out = [`pie${m.showData ? ' showData' : ''}${m.title.trim() ? ` title ${clean(m.title)}` : ''}`];
  for (const s of m.slices) out.push(`  "${s.label.replace(/"/g, "'")}" : ${Number.isFinite(Number(s.value)) && s.value.trim() !== '' && Number(s.value) >= 0 ? s.value.trim() : '0'}`);
  return out.join('\n');
}
