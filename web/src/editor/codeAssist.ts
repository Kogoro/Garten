// Editing helpers of the small Mermaid code editor: completion per diagram type, indentation, comments, bracket pairs.
// Everything here is pure (text in, edit out) so it can be tested without a browser.

export interface Suggestion { label: string; insert: string; detail?: string } // `$0` in insert marks where the caret goes
export interface Edit { from: number; to: number; insert: string; selStart: number; selEnd: number }
export interface Suggestions { from: number; items: Suggestion[] }

const S = (label: string, detail?: string, insert = label): Suggestion => ({ label, detail, insert });

const HEADERS: Suggestion[] = [
  S('flowchart TD', 'Flowchart, top → bottom'), S('flowchart LR', 'Flowchart, left → right'), S('graph TD', 'Flowchart (old keyword)'),
  S('sequenceDiagram', 'Sequence diagram'), S('stateDiagram-v2', 'State diagram'), S('erDiagram', 'Entity-relationship diagram'),
  S('classDiagram', 'Class diagram'), S('pie title $0', 'Pie chart', 'pie title $0'), S('gantt', 'Gantt chart'), S('mindmap', 'Mind map'),
  S('timeline', 'Timeline'), S('journey', 'User journey'), S('gitGraph', 'Git graph'), S('quadrantChart', 'Quadrant chart'),
];

const COMMON: Suggestion[] = [S('%%', 'Comment', '%% $0')];
const DIRECTIONS: Suggestion[] = ['TB', 'TD', 'BT', 'RL', 'LR'].map((d) => S(d, 'Direction'));

const FLOW: Suggestion[] = [
  S('subgraph', 'Group of nodes', 'subgraph $0\n  \nend'), S('end', 'Close a group'), S('direction', 'Direction inside a group', 'direction '),
  S('style', 'Style a node', 'style $0 fill:#f9f,stroke:#333'), S('classDef', 'Define a style class', 'classDef $0 fill:#f9f'), S('class', 'Apply a style class', 'class $0 name'),
  S('click', 'Make a node a link', 'click $0 href "https://"'), S('linkStyle', 'Style a connection', 'linkStyle $0 stroke:#f00'),
  S('A[Text]', 'Box', 'A[$0]'), S('A(Text)', 'Rounded box', 'A($0)'), S('A([Text])', 'Pill', 'A([$0])'), S('A{Text}', 'Decision', 'A{$0}'), S('A((Text))', 'Circle', 'A(($0))'), S('A[(Text)]', 'Database', 'A[($0)]'),
];
const FLOW_ARROWS: Suggestion[] = [S('-->', 'Arrow'), S('---', 'Line'), S('-.->', 'Dotted arrow'), S('==>', 'Thick arrow'), S('-->|text|', 'Arrow with label', '-->|$0|'), S('--o', 'Circle end'), S('--x', 'Cross end'), S('<-->', 'Both directions')];

const SEQ: Suggestion[] = [
  S('participant', 'Declare a participant', 'participant '), S('actor', 'Declare a person', 'actor '), S('autonumber', 'Number the messages'), S('title', 'Title', 'title '),
  S('Note right of', 'Note', 'Note right of $0: '), S('Note left of', 'Note', 'Note left of $0: '), S('Note over', 'Note over one or two participants', 'Note over $0: '),
  S('loop', 'Repeat', 'loop $0\n  \nend'), S('alt', 'Alternatives', 'alt $0\n  \nelse \n  \nend'), S('opt', 'Optional', 'opt $0\n  \nend'), S('par', 'In parallel', 'par $0\n  \nand \n  \nend'),
  S('critical', 'Critical region', 'critical $0\n  \nend'), S('break', 'Break', 'break $0\n  \nend'), S('rect', 'Highlight area', 'rect rgb(240, 240, 255)\n  $0\nend'),
  S('else', 'Else branch', 'else '), S('and', 'Parallel branch', 'and '), S('end', 'Close a block'), S('activate', 'Activate', 'activate '), S('deactivate', 'Deactivate', 'deactivate '),
];
const SEQ_ARROWS: Suggestion[] = [S('->>', 'Request'), S('-->>', 'Reply (dashed)'), S('->', 'Line'), S('-->', 'Dashed line'), S('-x', 'Lost message'), S('-)', 'Async message'), S('->>+', 'Request and activate'), S('-->>-', 'Reply and deactivate')];

const STATE: Suggestion[] = [
  S('state', 'Declare a state', 'state "$0" as '), S('direction', 'Direction', 'direction '), S('[*]', 'Start / end'), S('note right of', 'Note', 'note right of $0\n  \nend note'), S('note left of', 'Note', 'note left of $0\n  \nend note'),
  S('<<choice>>', 'Choice', '<<choice>>'), S('<<fork>>', 'Fork', '<<fork>>'), S('<<join>>', 'Join', '<<join>>'), S('--', 'Concurrent regions'),
];
const STATE_ARROWS: Suggestion[] = [S('-->', 'Transition')];

const ER: Suggestion[] = [
  S('string', 'Type'), S('int', 'Type'), S('float', 'Type'), S('boolean', 'Type'), S('date', 'Type'), S('datetime', 'Type'), S('text', 'Type'),
  S('PK', 'Primary key'), S('FK', 'Foreign key'), S('UK', 'Unique key'),
];
const ER_ARROWS: Suggestion[] = [S('||--o{', 'One to zero or more'), S('||--|{', 'One to one or more'), S('||--||', 'One to one'), S('}o--o{', 'Many to many'), S('}|--|{', 'One or more to one or more'), S('|o--o{', 'Zero or one to many'), S('||..o{', 'Non-identifying one to many')];

const CLASS: Suggestion[] = [
  S('class', 'Declare a class', 'class $0 {\n  \n}'), S('namespace', 'Group of classes', 'namespace $0 {\n  \n}'), S('direction', 'Direction', 'direction '), S('note', 'Note', 'note "$0"'),
  S('<<interface>>', 'Annotation'), S('<<abstract>>', 'Annotation'), S('<<enumeration>>', 'Annotation'), S('<<service>>', 'Annotation'),
];
const CLASS_ARROWS: Suggestion[] = [S('<|--', 'Inheritance'), S('*--', 'Composition'), S('o--', 'Aggregation'), S('-->', 'Association'), S('--', 'Link'), S('..>', 'Dependency'), S('..|>', 'Realization'), S('..', 'Dashed link')];

const PIE: Suggestion[] = [S('title', 'Title', 'title '), S('showData', 'Show the values')];
const GANTT: Suggestion[] = [
  S('title', 'Title', 'title '), S('dateFormat', 'Date format', 'dateFormat YYYY-MM-DD'), S('axisFormat', 'Axis format', 'axisFormat %d.%m.'), S('section', 'Section', 'section '), S('excludes', 'Excluded days', 'excludes weekends'),
  S('todayMarker', 'Today marker', 'todayMarker off'), S('tickInterval', 'Axis ticks', 'tickInterval 1week'), S('done', 'Task state'), S('active', 'Task state'), S('crit', 'Critical task'), S('milestone', 'Milestone'), S('after', 'Starts after another task', 'after '),
];
const MINDMAP: Suggestion[] = [S('root', 'Root node', 'root(($0))'), S('::icon()', 'Icon', '::icon($0)'), S(':::', 'CSS class', ':::$0')];
const TIMELINE: Suggestion[] = [S('title', 'Title', 'title '), S('section', 'Section', 'section ')];
const JOURNEY: Suggestion[] = [S('title', 'Title', 'title '), S('section', 'Section', 'section ')];
const GIT: Suggestion[] = [S('commit', 'Commit', 'commit'), S('branch', 'New branch', 'branch $0'), S('checkout', 'Switch branch', 'checkout $0'), S('switch', 'Switch branch', 'switch $0'), S('merge', 'Merge a branch', 'merge $0'), S('cherry-pick', 'Cherry-pick', 'cherry-pick id: "$0"'), S('tag:', 'Tag', 'tag: "$0"'), S('id:', 'Commit id', 'id: "$0"'), S('type: HIGHLIGHT', 'Highlight'), S('type: REVERSE', 'Reverse')];
const QUADRANT: Suggestion[] = [S('title', 'Title', 'title '), S('x-axis', 'X axis', 'x-axis Low --> High'), S('y-axis', 'Y axis', 'y-axis Low --> High'), S('quadrant-1', 'Top right', 'quadrant-1 $0'), S('quadrant-2', 'Top left', 'quadrant-2 $0'), S('quadrant-3', 'Bottom left', 'quadrant-3 $0'), S('quadrant-4', 'Bottom right', 'quadrant-4 $0')];

interface Vocab { words: Suggestion[]; arrows: Suggestion[]; ids: boolean }
const VOCAB: Record<string, Vocab> = {
  flowchart: { words: FLOW, arrows: FLOW_ARROWS, ids: true }, sequence: { words: SEQ, arrows: SEQ_ARROWS, ids: true }, state: { words: STATE, arrows: STATE_ARROWS, ids: true },
  er: { words: ER, arrows: ER_ARROWS, ids: true }, class: { words: CLASS, arrows: CLASS_ARROWS, ids: true }, pie: { words: PIE, arrows: [], ids: false },
  gantt: { words: GANTT, arrows: [], ids: false }, mindmap: { words: MINDMAP, arrows: [], ids: false }, timeline: { words: TIMELINE, arrows: [], ids: false },
  journey: { words: JOURNEY, arrows: [], ids: false }, git: { words: GIT, arrows: [], ids: false }, quadrant: { words: QUADRANT, arrows: [], ids: false },
};

/** Which diagram type a text is (from its first line), or null. */
export function typeOf(src: string): string | null {
  const first = src.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('%%')) ?? '';
  if (/^(flowchart|graph)\b/.test(first)) return 'flowchart';
  if (/^sequenceDiagram\b/.test(first)) return 'sequence';
  if (/^stateDiagram/.test(first)) return 'state';
  if (/^erDiagram\b/.test(first)) return 'er';
  if (/^classDiagram\b/.test(first)) return 'class';
  if (/^pie\b/.test(first)) return 'pie';
  if (/^gantt\b/.test(first)) return 'gantt';
  if (/^mindmap\b/.test(first)) return 'mindmap';
  if (/^timeline\b/.test(first)) return 'timeline';
  if (/^journey\b/.test(first)) return 'journey';
  if (/^gitGraph\b/.test(first)) return 'git';
  if (/^quadrantChart\b/.test(first)) return 'quadrant';
  return null;
}

const MAX = 8;
const starts = (label: string, prefix: string) => label.toLowerCase().startsWith(prefix.toLowerCase());

/** Completions at the caret. `explicit` (Ctrl+Space) also offers everything when nothing has been typed yet. */
export function suggest(src: string, caret: number, explicit = false): Suggestions | null {
  const lineStart = src.lastIndexOf('\n', caret - 1) + 1;
  const linePrefix = src.slice(lineStart, caret);
  const before = src.slice(0, lineStart);
  const onFirstLine = !before.split('\n').some((l) => l.trim() && !l.trim().startsWith('%%'));
  const word = /[A-Za-z_](?:[\w-]*\w)?$/.exec(linePrefix)?.[0] ?? '';
  if (linePrefix.trim().startsWith('%%') && !linePrefix.includes('{')) return null; // inside a comment
  if (onFirstLine) {
    const text = linePrefix.trimStart();
    if (!text && !explicit) return null;
    const from = caret - text.length;
    const items = HEADERS.filter((h) => starts(h.label, text) && h.label !== text);
    return items.length ? { from, items } : null;
  }
  const type = typeOf(src);
  const v = type ? VOCAB[type] : null;
  if (!v) return null;

  if (/^\s*(direction|flowchart|graph)\s+\w*$/.test(linePrefix) && (type === 'flowchart' || type === 'state' || type === 'class')) {
    const w = /\w*$/.exec(linePrefix)![0];
    const items = DIRECTIONS.filter((d) => starts(d.label, w) && d.label !== w);
    return items.length ? { from: caret - w.length, items } : null;
  }
  const sym = /[-=.<>|*}{)(]{1,6}$/.exec(linePrefix)?.[0] ?? '';
  if (!word && sym && v.arrows.length) {
    const items = v.arrows.filter((a) => a.label.startsWith(sym) && a.label !== sym).slice(0, MAX);
    return items.length ? { from: caret - sym.length, items } : null;
  }
  if (!word && !explicit) return null;
  const items: Suggestion[] = [...v.words, ...COMMON].filter((w) => starts(w.label, word) && w.label !== word);
  if (!word && explicit) items.push(...v.arrows);
  if (v.ids && word) {
    const seen = new Set(items.map((i) => i.label.toLowerCase()));
    const own = new Set<string>();
    for (const m of src.slice(0, lineStart).matchAll(/[A-Za-z_][\w-]{1,}/g)) own.add(m[0]);
    for (const w of own) if (starts(w, word) && w !== word && !seen.has(w.toLowerCase()) && !/^(flowchart|graph|sequenceDiagram|stateDiagram|erDiagram|classDiagram)/.test(w)) { items.push(S(w, 'In this diagram')); seen.add(w.toLowerCase()); }
  }
  return items.length ? { from: caret - word.length, items: items.slice(0, MAX) } : null;
}

/** Where the caret goes after inserting a suggestion, and the text without the `$0` marker. */
export function expand(item: Suggestion): { text: string; caret: number } {
  const i = item.insert.indexOf('$0');
  return i < 0 ? { text: item.insert, caret: item.insert.length } : { text: item.insert.replace('$0', ''), caret: i };
}

// ---------------------------------------------------------------- indentation, comments, pairs
export const INDENT = '  ';
const lineStartOf = (t: string, i: number) => t.lastIndexOf('\n', i - 1) + 1;
const lineEndOf = (t: string, i: number) => { const e = t.indexOf('\n', i); return e < 0 ? t.length : e; };
const BLOCK_OPEN = /^(subgraph|loop|alt|opt|par|critical|break|rect|else|and|option|section)\b/;

/** Enter: keep the indentation of the line, one level deeper after `{` or a block keyword; between `{` and `}` open a block. */
export function onEnter(t: string, s: number, e: number): Edit {
  const ls = lineStartOf(t, s);
  const line = t.slice(ls, s);
  const indent = /^[ \t]*/.exec(line)![0];
  const trimmed = line.trim();
  const deeper = trimmed.endsWith('{') || BLOCK_OPEN.test(trimmed);
  const inner = indent + (deeper ? INDENT : '');
  if (trimmed.endsWith('{') && t[e] === '}') {
    const insert = `\n${inner}\n${indent}`;
    return { from: s, to: e, insert, selStart: s + 1 + inner.length, selEnd: s + 1 + inner.length };
  }
  const insert = `\n${inner}`;
  return { from: s, to: e, insert, selStart: s + insert.length, selEnd: s + insert.length };
}

/** Tab / Shift+Tab. Without a selection Tab inserts spaces up to the next tab stop; a selection over lines indents or outdents them all. */
export function onTab(t: string, s: number, e: number, back: boolean): Edit | null {
  if (!back && s === e) {
    const col = s - lineStartOf(t, s);
    const ins = ' '.repeat(INDENT.length - (col % INDENT.length));
    return { from: s, to: e, insert: ins, selStart: s + ins.length, selEnd: s + ins.length };
  }
  const from = lineStartOf(t, s);
  const to = lineEndOf(t, e > s && t[e - 1] === '\n' ? e - 1 : e);
  const lines = t.slice(from, to).split('\n');
  let first = 0, total = 0;
  const out = lines.map((l, i) => {
    let n: string;
    if (back) { const m = /^( {1,2}|\t)/.exec(l); n = m ? l.slice(m[0].length) : l; } else n = l.trim() ? INDENT + l : l;
    const d = n.length - l.length; if (i === 0) first = d; total += d;
    return n;
  });
  const insert = out.join('\n');
  if (insert === t.slice(from, to)) return null;
  return { from, to, insert, selStart: Math.max(from, s + first), selEnd: Math.max(from, e + total) };
}

/** Ctrl+/ : comment or uncomment the selected lines with `%%`. */
export function toggleComment(t: string, s: number, e: number): Edit {
  const from = lineStartOf(t, s);
  const to = lineEndOf(t, e > s && t[e - 1] === '\n' ? e - 1 : e);
  const lines = t.slice(from, to).split('\n');
  const all = lines.filter((l) => l.trim()).every((l) => l.trim().startsWith('%%'));
  let first = 0, total = 0;
  const out = lines.map((l, i) => {
    let n = l;
    if (l.trim()) n = all ? l.replace(/^(\s*)%% ?/, '$1') : l.replace(/^(\s*)/, '$1%% ');
    const d = n.length - l.length; if (i === 0) first = d; total += d;
    return n;
  });
  return { from, to, insert: out.join('\n'), selStart: Math.max(from, s + first), selEnd: Math.max(from, e + total) };
}

const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '"': '"' };
const CLOSERS = new Set(Object.values(PAIRS));

/** Typing an opening bracket or quote writes the pair (or wraps the selection); typing the closer in front of the same closer steps over it. */
export function onChar(t: string, s: number, e: number, ch: string): Edit | null {
  if (s === e && CLOSERS.has(ch) && t[s] === ch) return { from: s, to: s, insert: '', selStart: s + 1, selEnd: s + 1 }; // step over
  const close = PAIRS[ch];
  if (!close) return null;
  if (s !== e) { const sel = t.slice(s, e); return { from: s, to: e, insert: ch + sel + close, selStart: s + 1, selEnd: s + 1 + sel.length }; }
  if (ch === '"' && /[\w"]/.test(t[s - 1] ?? '')) return null; // a closing quote, or a quote inside a word
  if (ch !== '"' && /[\w]/.test(t[s] ?? '')) return null; // do not pair in front of a word
  return { from: s, to: s, insert: ch + close, selStart: s + 1, selEnd: s + 1 };
}

/** Backspace between an empty pair removes both. */
export function onBackspace(t: string, s: number, e: number): Edit | null {
  if (s !== e || s === 0) return null;
  const a = t[s - 1], b = t[s];
  if (PAIRS[a] && PAIRS[a] === b) return { from: s - 1, to: s + 1, insert: '', selStart: s - 1, selEnd: s - 1 };
  return null;
}
