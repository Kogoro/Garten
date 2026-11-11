import { describe, expect, it } from 'vitest';
import { addRule } from './guardrailsLib';

const TEMPLATE = '# Guardrails\n\n<!-- hint -->\n\n## Always\n\n## Never\n';
describe('addRule', () => {
  it('adds numbered rules under the right heading', () => {
    let md = addRule(TEMPLATE, 'Verify signatures.', 'Always');
    md = addRule(md, 'Log secrets.\nEver.', 'Never');
    md = addRule(md, 'Pin dependencies.', 'Always');
    expect(md).toBe('# Guardrails\n\n<!-- hint -->\n\n## Always\n- G1: Verify signatures.\n- G3: Pin dependencies.\n\n## Never\n- G2: Log secrets. Ever.\n');
  });
  it('creates a missing section', () => {
    expect(addRule('# Guardrails\n', 'Be kind.', 'Never')).toBe('# Guardrails\n\n## Never\n\n- G1: Be kind.\n');
  });
});
