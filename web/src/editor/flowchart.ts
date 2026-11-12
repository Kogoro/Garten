// A small, lossless model of Mermaid flowcharts for the visual editor.
// parseFlowchart() understands the part of the syntax the editor can write back. Anything else (subgraphs, styles, comments, `&` …)
// returns null, so the visual editor never silently drops what a person wrote in the code.

export const DIRECTIONS = [['TD', 'Top → bottom'], ['LR', 'Left → right'], ['BT', 'Bottom → top'], ['RL', 'Right → left']] as const;
export type Direction = (typeof DIRECTIONS)[number][0];
export const SHAPES = [['rect', 'Box'], ['round', 'Rounded'], ['stadium', 'Pill'], ['diamond', 'Decision'], ['circle', 'Circle']] as const;
export type Shape = (typeof SHAPES)[number][0];
export const LINKS = [['arrow', 'Arrow'], ['line', 'Line'], ['dotted', 'Dotted arrow'], ['thick', 'Thick arrow']] as const;
export type LinkKind = (typeof LINKS)[number][0];

export interface FlowNode { id: string; label: string; shape: Shape }
export interface FlowEdge { from: string; to: string; kind: LinkKind; label: string }
export interface Flowchart { dir: Direction; nodes: FlowNode[]; edges: FlowEdge[] }

const OPEN: Record<Shape, [string, string]> = { rect: ['[', ']'], round: ['(', ')'], stadium: ['([', '])'], diamond: ['{', '}'], circle: ['((', '))'] };
const ARROW: Record<LinkKind, string> = { arrow: '-->', line: '---', dotted: '-.->', thick: '==>' };
const LINK_RE = /^(-->|---|-\.->|-\.-|==>|===)(?:\|(.*?)\|)?/;
const LINK_TEXT_RE = /^--\s+(.+?)\s+(-->|---)/;
const KIND_OF: Record<string, LinkKind> = { '-->': 'arrow', '---': 'line', '-.->': 'dotted', '-.-': 'dotted', '==>': 'thick', '===': 'thick' };
const ID_RE = /^[A-Za-z_][A-Za-z0-9_]*/;
const RESERVED = new Set(['end', 'graph', 'flowchart', 'subgraph', 'style', 'class', 'classDef', 'click', 'default', 'linkStyle']);

const unquote = (s: string) => {
  const t = s.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).replace(/#quot;/g, '"') : s;
};
const quote = (s: string) => `"${s.replace(/"/g, '#quot;').replace(/\n/g, ' ')}"`;

/** The first free id: A … Z, then N27, N28 … */
export function freeId(used: Iterable<string>): string {
  const u = new Set(used);
  for (let i = 0; i < 26; i++) { const c = String.fromCharCode(65 + i); if (!u.has(c)) return c; }
  for (let n = 27; ; n++) if (!u.has(`N${n}`)) return `N${n}`;
}

export const emptyFlowchart = (): Flowchart => ({ dir: 'TD', nodes: [], edges: [] });

/** One node reference at the start of `s`: `A`, `A[Label]`, `A("Label")`, `A{Label}` … Returns the rest of the statement. */
function readNode(s: string): { node: FlowNode; explicit: boolean; rest: string } | null {
  const m = ID_RE.exec(s);
  if (!m || RESERVED.has(m[0])) return null;
  const id = m[0];
  let rest = s.slice(id.length);
  for (const shape of ['circle', 'stadium', 'rect', 'round', 'diamond'] as Shape[]) { // longest openers first
    const [o, c] = OPEN[shape];
    if (!rest.startsWith(o)) continue;
    let i = o.length, end = -1;
    if (rest[i] === '"') { const q = rest.indexOf('"', i + 1); if (q < 0) return null; end = rest.startsWith(c, q + 1) ? q + 1 : -1; }
    else end = rest.indexOf(c, i);
    if (end < 0) return null;
    const raw = rest.slice(i, end);
    if (!raw.startsWith('"') && /[[\](){}|"]/.test(raw)) return null; // nested brackets need quoting; refuse rather than guess
    return { node: { id, label: unquote(raw), shape }, explicit: true, rest: rest.slice(end + c.length) };
  }
  if (/^[[({]/.test(rest)) return null; // some other bracket form (`[[…]]`, `[/…/]` …)
  return { node: { id, label: id, shape: 'rect' }, explicit: false, rest };
}

/** Splits a line at `;` – but not inside quotes (`#quot;` is an entity). */
function splitStatements(line: string): string[] {
  const out: string[] = [];
  let cur = '', q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    if (ch === ';' && !q) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** null = this diagram uses something the visual editor cannot write back; edit the code instead. */
export function parseFlowchart(src: string): Flowchart | null {
  const text = src.replace(/\r\n?/g, '\n');
  if (!text.trim()) return emptyFlowchart();
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const head = /^(?:flowchart|graph)(?:\s+(TD|TB|LR|BT|RL))?\s*;?$/.exec(lines[0]);
  if (!head) return null;
  const chart = emptyFlowchart();
  chart.dir = (head[1] === 'TB' || !head[1] ? 'TD' : head[1]) as Direction;
  const byId = new Map<string, FlowNode>();
  const touch = (n: FlowNode, explicit: boolean) => {
    const cur = byId.get(n.id);
    if (!cur) { byId.set(n.id, n); chart.nodes.push(n); }
    else if (explicit) { cur.label = n.label; cur.shape = n.shape; }
  };
  for (const line of lines.slice(1)) {
    for (const stmt of splitStatements(line)) {
      let cur = readNode(stmt);
      if (!cur) return null;
      touch(cur.node, cur.explicit);
      let rest = cur.rest.trim();
      while (rest) {
        let kind: LinkKind, label = '';
        const l1 = LINK_RE.exec(rest), l2 = l1 ? null : LINK_TEXT_RE.exec(rest);
        if (l1) { kind = KIND_OF[l1[1]]; label = unquote(l1[2] ?? ''); rest = rest.slice(l1[0].length).trim(); }
        else if (l2) { kind = KIND_OF[l2[2]]; label = unquote(l2[1]); rest = rest.slice(l2[0].length).trim(); }
        else return null;
        const next = readNode(rest);
        if (!next) return null;
        touch(next.node, next.explicit);
        chart.edges.push({ from: cur.node.id, to: next.node.id, kind, label });
        cur = next;
        rest = next.rest.trim();
      }
    }
  }
  return chart;
}

export function serializeFlowchart(c: Flowchart): string {
  const out = [`flowchart ${c.dir}`];
  for (const n of c.nodes) { const [o, cl] = OPEN[n.shape]; out.push(`  ${n.id}${o}${quote(n.label.trim() ? n.label : ' ')}${cl}`); }
  for (const e of c.edges) out.push(`  ${e.from} ${ARROW[e.kind]}${e.label.trim() ? `|${quote(e.label.replace(/\|/g, '/'))}|` : ''} ${e.to}`);
  return out.join('\n');
}
