import { describe, expect, it } from 'vitest';
import { parse, serialize } from '@shared/blocksModel.js';
import { bnToMd, mdToBn } from './convert';
import { inlineToMd, mdToInline } from './inline';

const DOC = [
  '## GOAL', '', 'Plain text with **bold**, *italic*, `code` and a [link](https://example.com). See [[Settlement]].', '',
  '- [ ] open task', '- [x] done task', '', '- bullet', '', 'R1 Works offline', 'R2 Never double-bills', '',
  '> quoted', '', '---', '', '```mermaid', 'flowchart LR', '  A --> B', '```', '',
  '```endpoint POST /orders', 'Creates an order.', '', 'Request:', '{ "sku": "x" }', '', 'Responses:', '201 Created', '```', '',
  '```yaml', 'a: 1', '```', '', 'Attempt window', ': A time bucket.', ': Aliases: retry window', ': See also: Ledger entry', '',
].join('\n');

describe('Markdown <-> BlockNote round trip', () => {
  it('keeps the stored Markdown format stable', () => {
    expect(bnToMd(mdToBn(DOC))).toBe(serialize(parse(DOC)));
  });
  it('renumbers requirements in document order', () => {
    const bn = mdToBn('R1 a\nR2 b\nR3 c\n');
    bn.splice(1, 1); // user deleted the middle one
    expect(bnToMd(bn)).toBe('R1 a\nR2 c\n');
  });
  it('is idempotent', () => { const once = bnToMd(mdToBn(DOC)); expect(bnToMd(mdToBn(once))).toBe(once); });
});

describe('inline marks', () => {
  it.each(['**b**', '*i*', '~~s~~', '`c`', '[t](https://x.y)', 'a **b *c*** d', 'plain [[Ref]] text'])('round trips %s', (s) => {
    expect(inlineToMd(mdToInline(s))).toBe(s);
  });
});
