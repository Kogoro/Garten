import { describe, expect, it } from 'vitest';
import { parseFlowchart, serializeFlowchart, freeId } from './flowchart';

describe('flowchart model', () => {
  it('reads nodes, shapes and labelled connections', () => {
    const c = parseFlowchart('flowchart LR\n  A([Start]) --> B{Ok?}\n  B -->|yes| C[Done]\n  B -- no --> A')!;
    expect(c.dir).toBe('LR');
    expect(c.nodes.map((n) => [n.id, n.label, n.shape])).toEqual([['A', 'Start', 'stadium'], ['B', 'Ok?', 'diamond'], ['C', 'Done', 'rect']]);
    expect(c.edges.map((e) => [e.from, e.to, e.label, e.kind])).toEqual([['A', 'B', '', 'arrow'], ['B', 'C', 'yes', 'arrow'], ['B', 'A', 'no', 'arrow']]);
  });
  it('reads chains, graph TB and bare ids', () => {
    const c = parseFlowchart('graph TB\nA --> B --> C; C -.-> A')!;
    expect(c.dir).toBe('TD'); expect(c.nodes.map((n) => n.id)).toEqual(['A', 'B', 'C']);
    expect(c.edges.map((e) => e.kind)).toEqual(['arrow', 'arrow', 'dotted']);
  });
  it('round-trips through the serializer', () => {
    const c = parseFlowchart('flowchart TD\n  A(("Hub"))\n  B["Say #quot;hi#quot; (loud)"]\n  A ==>|"x"| B')!;
    expect(c.nodes[1].label).toBe('Say "hi" (loud)');
    expect(parseFlowchart(serializeFlowchart(c))).toEqual(c);
  });
  it('refuses what it could not write back', () => {
    for (const s of ['sequenceDiagram\n  A->>B: hi', 'flowchart TD\n  subgraph x\n  A-->B\n  end', 'flowchart TD\n  A --> B\n  %% note', 'flowchart TD\n  A & B --> C', 'flowchart TD\n  A[[sub]] --> B', 'flowchart TD\n  classDef x fill:#f00']) expect(parseFlowchart(s)).toBeNull();
  });
  it('treats empty text as an empty flowchart and picks free ids', () => {
    expect(parseFlowchart('  ')).toEqual({ dir: 'TD', nodes: [], edges: [] });
    expect(freeId(['A', 'B'])).toBe('C');
    expect(freeId('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''))).toBe('N27');
  });
  it('writes an empty label as a space so Mermaid still renders the box', () => {
    expect(serializeFlowchart({ dir: 'LR', nodes: [{ id: 'A', label: '', shape: 'rect' }], edges: [] })).toBe('flowchart LR\n  A[" "]');
  });
});
