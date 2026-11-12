import { describe, expect, it } from 'vitest';
import { newDefinitions, specBody, termPrefill, titleOf } from './derive';

describe('deriving specs and terms from text', () => {
  it('titles by heading, then first line, then file name', () => {
    expect(titleOf('intro\n\n## Nightly **settlement**\nx', 'a.md')).toBe('Nightly settlement');
    expect(titleOf('- [ ] Book payments once\nmore', 'a.md')).toBe('Book payments once');
    expect(titleOf('', 'adr/ADR-007.md')).toBe('ADR-007');
    expect(titleOf('x'.repeat(200), 'a.md').length).toBe(80);
  });
  it('adds a source section to spec bodies', () => { expect(specBody('R1 a\n', 'notes/p.md')).toBe('R1 a\n\n## SOURCE\n\nDerived from `notes/p.md`.\n'); });
  it('a short selection is the term, a long one the definition', () => {
    expect(termPrefill('Settlement run', 'a.md', false)).toEqual({ term: 'Settlement run', definition: '' });
    const long = 'The nightly batch that books all payments of the day. It runs at 02:00.';
    expect(termPrefill(long, 'a.md', false)).toEqual({ term: '', definition: long });
  });
  it('a whole document is the term by title and the definition by first paragraph', () => {
    expect(termPrefill('# Attempt window\n\n- a list\n\nA bucket of retries.\nSecond line.\n\nLater.', 'a.md', true)).toEqual({ term: 'Attempt window', definition: 'A bucket of retries. Second line.' });
  });
  it('finds definitions the glossary lacks', () => {
    const md = 'Alpha\n: First.\n\nBeta\n: Second.\n: Aliases: b\n';
    expect(newDefinitions(md, (t) => t === 'Alpha').map((d) => d.term)).toEqual(['Beta']);
  });
});
