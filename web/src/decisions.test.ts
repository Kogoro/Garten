import { describe, expect, it } from 'vitest';
import { addDecisionToSpec, decisionLine, hasDecision } from './decisionsLib';

const d = { text: 'Which delimiter\nfor the CSV export?', options: [{ label: 'Comma' }, { label: 'Semicolon' }] };

describe('decisions in the spec', () => {
  it('writes question, answer, note and who decided on one line', () => {
    expect(decisionLine(d, 1, 'German Excel', 'Ann', '2026-11-14T10:00:00Z')).toBe('- Which delimiter for the CSV export? → Semicolon – German Excel (Ann, 2026-11-14)');
    expect(decisionLine(d, -1, 'Tab', null, null)).toBe('- Which delimiter for the CSV export? → Tab');
  });
  it('creates the DECISIONS section, or adds to it before the next section', () => {
    const one = addDecisionToSpec('## GOAL\nExport\n', d, 0, '');
    expect(one).toBe('## GOAL\nExport\n\n## DECISIONS\n\n- Which delimiter for the CSV export? → Comma\n');
    const two = addDecisionToSpec('## DECISIONS\n\n- Old? → Yes\n\n## OUT OF SCOPE\nPrinting\n', d, 1, '');
    expect(two).toBe('## DECISIONS\n\n- Old? → Yes\n- Which delimiter for the CSV export? → Semicolon\n\n## OUT OF SCOPE\nPrinting\n');
    expect(hasDecision(two, d.text)).toBe(true); expect(hasDecision(one, 'Other?')).toBe(false);
  });
  it('replaces the line when the answer changes', () => {
    const once = addDecisionToSpec('## GOAL\nx\n', d, 0, '');
    const changed = addDecisionToSpec(once, d, 1, 'changed my mind');
    expect(changed.match(/Which delimiter/g)).toHaveLength(1);
    expect(changed).toContain('→ Semicolon – changed my mind');
  });
});
