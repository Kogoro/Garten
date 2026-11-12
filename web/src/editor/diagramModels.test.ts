import { describe, expect, it } from 'vitest';
import { parseSequence, serializeSequence, parseState, serializeState, parseEr, serializeEr, parseClass, serializeClass, parsePie, serializePie, emptySequence, emptyState, emptyEr, emptyClass, emptyPie } from './diagramModels';
import { KINDS, CODE_KINDS, kindOf, codeKindOf } from './diagramKinds';

const roundTrip = <M,>(parse: (s: string) => M | null, ser: (m: M) => string, empty: () => M) => {
  const text = ser(empty());
  const m = parse(text);
  expect(m).toEqual(empty());
  expect(ser(m!)).toBe(text);
};

describe('diagram models', () => {
  it('round-trip their own examples', () => {
    roundTrip(parseSequence, serializeSequence, emptySequence);
    roundTrip(parseState, serializeState, emptyState);
    roundTrip(parseEr, serializeEr, emptyEr);
    roundTrip(parseClass, serializeClass, emptyClass);
    roundTrip(parsePie, serializePie, emptyPie);
  });

  it('sequence: participants, arrows, notes, implicit participants', () => {
    const m = parseSequence('sequenceDiagram\n  autonumber\n  actor U as User\n  U->>API: login\n  API--xDB: write\n  Note over U,API: both\n  Note right of DB: stored')!;
    expect(m.autonumber).toBe(true);
    expect(m.participants.map((p) => [p.id, p.label, p.actor])).toEqual([['U', 'User', true], ['API', 'API', false], ['DB', 'DB', false]]);
    expect(m.items[1]).toMatchObject({ type: 'msg', arrow: '-x' });
    expect(m.items[2]).toMatchObject({ type: 'note', pos: 'over', a: 'U', b: 'API' });
    expect(parseSequence(serializeSequence(m))).toEqual(m);
  });

  it('state: start/end, labels and declared states', () => {
    const m = parseState('stateDiagram-v2\n  direction LR\n  state "Waiting for input" as W\n  [*] --> W\n  W --> [*] : cancel')!;
    expect(m.dir).toBe('LR'); expect(m.states).toEqual([{ id: 'W', label: 'Waiting for input' }]);
    expect(m.transitions[1]).toEqual({ from: 'W', to: '[*]', label: 'cancel' });
    expect(parseState(serializeState(m))).toEqual(m);
  });

  it('er: attributes with keys and quoted labels', () => {
    const m = parseEr('erDiagram\n  A ||--o{ B : "has many"\n  A {\n    int id PK\n    string name\n  }')!;
    expect(m.relations[0]).toMatchObject({ a: 'A', left: '||', right: 'o{', b: 'B', label: 'has many' });
    expect(m.entities.find((e) => e.name === 'A')!.attrs).toEqual([{ type: 'int', name: 'id', key: 'PK' }, { type: 'string', name: 'name', key: '' }]);
    expect(parseEr(serializeEr(m))).toEqual(m);
  });

  it('class: members, shorthand members and relations', () => {
    const m = parseClass('classDiagram\n  class A {\n    +int x\n  }\n  A <|-- B : extends\n  B : +run() void')!;
    expect(m.classes.map((c) => [c.name, c.members])).toEqual([['A', ['+int x']], ['B', ['+run() void']]]);
    expect(m.relations[0]).toEqual({ a: 'A', arrow: '<|--', b: 'B', label: 'extends' });
    expect(parseClass(serializeClass(m))).toEqual(m);
  });

  it('pie: title, showData and numeric values only', () => {
    const m = parsePie('pie showData title Pets\n  "Dogs" : 386\n  "Cats" : 85.5')!;
    expect(m).toEqual({ title: 'Pets', showData: true, slices: [{ label: 'Dogs', value: '386' }, { label: 'Cats', value: '85.5' }] });
    expect(serializePie({ ...m, slices: [{ label: 'x', value: '' }] })).toContain('"x" : 0');
  });

  it('refuse what they cannot write back', () => {
    expect(parseSequence('sequenceDiagram\n  loop every day\n  A->>B: x\n  end')).toBeNull();
    expect(parseState('stateDiagram-v2\n  state Big {\n    [*] --> X\n  }')).toBeNull();
    expect(parseEr('erDiagram\n  A {\n    string name "comment text"\n  }')).toBeNull();
    expect(parseClass('classDiagram\n  class A~T~')).toBeNull();
    expect(parsePie('pie\n  "x" : abc')).toBeNull();
  });

  it('registry finds the type of a diagram', () => {
    expect(kindOf('%% hi\nsequenceDiagram\n A->>B: x')?.key).toBe('sequence');
    expect(kindOf('graph LR\nA-->B')?.key).toBe('flowchart');
    expect(kindOf('stateDiagram\n')?.key).toBe('state');
    expect(codeKindOf('gantt\n title x')?.key).toBe('gantt');
    for (const k of KINDS) expect(kindOf(k.template)?.key).toBe(k.key);
    for (const k of CODE_KINDS) expect(codeKindOf(k.template)?.key).toBe(k.key);
  });
});
