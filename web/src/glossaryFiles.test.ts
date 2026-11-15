import { describe, expect, it } from 'vitest';
import {
  parseTermFile,
  formatTermFile,
  slugify,
  termPath,
  rewriteRefsIn,
  refsIn,
  avoidHits,
  replaceWord,
  linkFirst,
  firstMention,
  splitGlossaryMd,
  termsToCsv,
  firstParagraph,
  definitionsOf,
  isTermPath,
} from '@shared/glossaryFiles.js';
import { parseGlossaryFile } from '@shared/glossaryImport.js';
import { mdToInline, inlineToMd } from './editor/inline';

describe('term files', () => {
  const file = formatTermFile({
    term: 'Attempt window',
    aliases: ['retry window', 'a, b'],
    avoid: ['retry period'],
    see: ['Idempotency key'],
    body: 'The **bucket** of [[Invoice run]].\n\n- one\n- two',
  });
  it('round-trips front matter and a Markdown body', () => {
    const t = parseTermFile(file)!;
    expect(t.term).toBe('Attempt window');
    expect(t.aliases).toEqual(['retry window', 'a, b']);
    expect(t.avoid).toEqual(['retry period']);
    expect(t.body).toBe('The **bucket** of [[Invoice run]].\n\n- one\n- two');
    expect(t.refs).toEqual(['Invoice run']);
    expect(formatTermFile(t)).toBe(file);
  });
  it('accepts hand-written YAML lists and rejects files without a term', () => {
    expect(parseTermFile('---\nterm: Ledger\naliases: [book, journal]\n---\nRecords.')!.aliases).toEqual(['book', 'journal']);
    expect(parseTermFile('# Just a document')).toBeNull();
    expect(parseTermFile('---\ntitle: x\n---\nbody')).toBeNull();
  });
  it('names files after the term and avoids collisions', () => {
    expect(slugify('Größe & Übung')).toBe('grosse-ubung');
    expect(termPath('Billing', 'Attempt window')).toBe('glossary/Billing/attempt-window.md');
    expect(termPath('', 'X', (p) => p === 'glossary/x.md')).toBe('glossary/x-2.md');
    expect(isTermPath('glossary/_proposed/x.md')).toBe(false);
    expect(definitionsOf('glossary/a.md', file)[0]).toMatchObject({ term: 'Attempt window', file: true });
  });
  it('splits the old glossary.md into folders', () => {
    const e = splitGlossaryMd('# Glossary\n\nA\n: one\n\n## Pay ments\n\nB\n: two\n\n### Cards\n\nC\n: three\n');
    expect(e.map((x) => [x.folder, x.term])).toEqual([
      ['', 'A'],
      ['Pay-ments', 'B'],
      ['Pay-ments/Cards', 'C'],
    ]);
  });
});

describe('references', () => {
  it('renames and unlinks [[…]], #[…] and See also lists', () => {
    const t = formatTermFile({ term: 'X', see: ['Invoice run'], body: 'see [[Invoice run|runs]] and #[invoice run]' });
    expect(parseTermFile(rewriteRefsIn('glossary/x.md', t, 'Invoice run', 'Billing run'))).toMatchObject({
      see: ['Billing run'],
      body: 'see [[Billing run|runs]] and #[Billing run]',
    });
    expect(
      rewriteRefsIn(
        'SPEC-1',
        'Uses #[Invoice run|runs] and [[Invoice run]]\n\nFoo\n: bar\n: See also: Invoice run, Y\n',
        'Invoice run',
        null,
      ),
    ).toBe('Uses runs and Invoice run\n\nFoo\n: bar\n: See also: Y\n');
    expect(refsIn('SPEC-1', '#[A] [[a|x]]\n\nB\n: b\n: See also: A', 'A')).toBe(3);
  });
  it('links the first plain mention, never inside code or existing references', () => {
    expect(firstMention('`attempt window` and #[attempt window] then Attempt window', 'attempt window')).toBe('Attempt window');
    expect(linkFirst('the attempt window is', 'attempt window', 'Attempt window')).toBe('the #[Attempt window|attempt window] is');
  });
  it('finds and replaces words to avoid outside code', () => {
    const md = 'R1 The retry period ends.\n`retry period` stays';
    expect(avoidHits(md, [{ term: 'Attempt window', avoid: ['retry period'] }])).toEqual([
      { word: 'retry period', term: 'Attempt window', line: 1, text: 'R1 The retry period ends.' },
    ]);
    expect(replaceWord(md, 'retry period', 'Attempt window')).toBe('R1 The Attempt window ends.\n`retry period` stays');
  });
  it('keeps #[Term] as an inline chip in the editor model', () => {
    const inl = mdToInline('use #[Attempt window|the window] and **#[Ledger]**');
    expect(inl.filter((x) => x.type === 'termref')).toHaveLength(2);
    expect(inlineToMd(inl)).toBe('use #[Attempt window|the window] and #[Ledger]');
  });
});

describe('export and import', () => {
  it('writes CSV that the import reads back', () => {
    const csv = termsToCsv([
      { term: 'A', body: 'x, "y"\n\n- z', aliases: ['q', 'r'], avoid: ['bad'], distinct: ['B'], see: [], folder: 'Billing/Cards' },
    ]);
    const back = parseGlossaryFile('g.csv', csv);
    expect(back.errors).toEqual([]);
    expect(back.terms[0]).toMatchObject({
      term: 'A',
      definition: 'x, "y"\n\n- z',
      aliases: ['q', 'r'],
      avoid: ['bad'],
      distinct: ['B'],
      folder: 'Billing/Cards',
    });
  });
  it('summarises a definition by its first paragraph', () => {
    expect(firstParagraph('## Heading\n\nThe **x** [[Y|y]].\n\nmore')).toBe('The x y.');
  });
});
