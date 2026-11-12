import { describe, expect, it } from 'vitest';
import { expand, onBackspace, onChar, onEnter, onTab, suggest, toggleComment, typeOf } from './codeAssist';

const labels = (src: string, caret = src.length, explicit = false) => suggest(src, caret, explicit)?.items.map((i) => i.label) ?? null;
const run = (t: string, e: { from: number; to: number; insert: string; selStart: number }) => t.slice(0, e.from) + e.insert + t.slice(e.to);

describe('completion', () => {
  it('offers diagram headers on the first line', () => {
    expect(labels('seq')).toEqual(['sequenceDiagram']);
    expect(labels('flow')).toEqual(['flowchart TD', 'flowchart LR']);
    expect(labels('')).toBeNull(); expect(labels('', 0, true)!.length).toBeGreaterThanOrEqual(12);
    expect(labels('sequenceDiagram')).toBeNull(); // already complete
  });
  it('knows the keywords of the diagram type', () => {
    expect(labels('sequenceDiagram\n  pa')).toEqual(['participant', 'par']);
    expect(labels('sequenceDiagram\n  Note')).toEqual(['Note right of', 'Note left of', 'Note over']);
    expect(labels('gantt\n  sec')).toEqual(['section']);
    expect(labels('classDiagram\n  cla')).toEqual(['class']);
    expect(labels('pie\n  ti')).toEqual(['title']);
    expect(labels('gitGraph\n  ch')).toEqual(['checkout', 'cherry-pick']);
  });
  it('offers arrows for the type after typing a dash', () => {
    expect(labels('flowchart LR\n  A -')).toEqual(['-->', '---', '-.->', '-->|text|', '--o', '--x']);
    expect(labels('sequenceDiagram\n  A-')).toContain('->>');
    expect(labels('erDiagram\n  A ||')).toEqual(['||--o{', '||--|{', '||--||', '||..o{']);
    expect(labels('gantt\n  title x -')).toBeNull();
  });
  it('reuses names that already appear in the diagram', () => {
    const r = labels('flowchart LR\n  Server --> Database\n  Serv')!;
    expect(r).toContain('Server');
    expect(labels('flowchart LR\n  Server --> Database\n  Server')).toBeNull();
  });
  it('knows directions, and stays quiet in comments and unknown diagrams', () => {
    expect(labels('flowchart LR\n  direction T')).toEqual(['TB', 'TD']);
    expect(labels('flowchart LR\n  %% sub')).toBeNull();
    expect(labels('whatever\n  sub')).toBeNull();
  });
  it('expands snippets with the caret marker', () => {
    expect(expand({ label: 'a', insert: 'loop $0\n  \nend' })).toEqual({ text: 'loop \n  \nend', caret: 5 });
    expect(expand({ label: 'a', insert: 'end' })).toEqual({ text: 'end', caret: 3 });
  });
  it('detects the diagram type', () => {
    expect([typeOf('%% c\nsequenceDiagram'), typeOf('graph TD'), typeOf('stateDiagram-v2'), typeOf('gitGraph'), typeOf('x')]).toEqual(['sequence', 'flowchart', 'state', 'git', null]);
  });
});

describe('editing helpers', () => {
  it('Enter keeps the indentation and goes deeper after a block opener', () => {
    expect(run('  A --> B', onEnter('  A --> B', 9, 9))).toBe('  A --> B\n  ');
    const t = 'flowchart\n  subgraph x';
    expect(run(t, onEnter(t, t.length, t.length))).toBe(t + '\n    ');
    const c = 'classDiagram\n  class A {}';
    const at = c.length - 1;
    const e = onEnter(c, at, at); expect(run(c, e)).toBe('classDiagram\n  class A {\n    \n  }'); expect(e.selStart).toBe(at + 1 + 4);
  });
  it('Tab inserts spaces up to the next stop and Shift+Tab removes them', () => {
    expect(run('a', onTab('a', 1, 1, false)!)).toBe('a ');
    expect(run(' a', onTab(' a', 2, 2, false)!)).toBe(' a  '.slice(0, 4));
    expect(run('  a', onTab('  a', 3, 3, true)!)).toBe('a');
    expect(onTab('a', 1, 1, true)).toBeNull();
  });
  it('Tab on a selection indents every selected line', () => {
    const t = 'a\nb\nc';
    const e = onTab(t, 0, 3, false)!; expect(run(t, e)).toBe('  a\n  b\nc');
    expect(run('  a\n  b\nc', onTab('  a\n  b\nc', 0, 7, true)!)).toBe('a\nb\nc');
  });
  it('Ctrl+/ comments and uncomments lines', () => {
    const t = 'a\n  b';
    const on = run(t, toggleComment(t, 0, t.length)); expect(on).toBe('%% a\n  %% b');
    expect(run(on, toggleComment(on, 0, on.length))).toBe(t);
  });
  it('brackets pair, wrap a selection, step over and delete together', () => {
    expect(run('A', onChar('A', 1, 1, '[')!)).toBe('A[]');
    expect(run('A', onChar('A', 0, 1, '(')!)).toBe('(A)');
    expect(onChar('A[]', 2, 2, ']')).toMatchObject({ insert: '', selStart: 3 });
    expect(onChar('word', 0, 0, '[')).toBeNull();
    expect(onChar('say', 3, 3, '"')).toBeNull();
    expect(run('A[]', onBackspace('A[]', 2, 2)!)).toBe('A');
    expect(onBackspace('A[b]', 3, 3)).toBeNull();
  });
});
