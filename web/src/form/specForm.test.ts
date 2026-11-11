import { describe, expect, it } from 'vitest';
import { BUILTIN_TYPES } from '@shared/spectypes.js';
import { extractTermRefs, termRef } from '@shared/glossary.js';
import { cleanForm, formTemplate, parseForm, serializeForm } from '@shared/specForm.js';

const schema = cleanForm({ fields: [
  { label: 'GOAL', kind: 'longtext' }, { label: 'AUTHENTICATION', kind: 'select', options: ['None', 'OAuth 2'] }, { label: 'ENDPOINTS', kind: 'endpoints' },
  { label: 'DATA TYPES', kind: 'code', lang: 'json' }, { label: 'REQUIREMENTS', kind: 'requirements' }, { label: 'ACCEPTANCE CRITERIA', kind: 'checklist' },
  { label: 'FLOW', kind: 'diagram' }, { label: 'ERRORS', kind: 'list' },
] })!;
const BODY = 'Intro text\n\n## GOAL\n\nDo it.\n\n## AUTHENTICATION\n\nOAuth 2\n\n## ENDPOINTS\n\n```endpoint POST /orders\nCreates.\n\nResponses:\n201\n```\n\nstray note\n\n## DATA TYPES\n\n```json\n{"a": 1}\n```\n\n## REQUIREMENTS\n\nR1 one\nR2 two\n\n## ACCEPTANCE CRITERIA\n\n- [x] done\n- [ ] open\n\n## FLOW\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n## ERRORS\n\n- 400 bad\n- 404 none\n\n## NOTES\n\nunknown section\n';

describe('spec form <-> Markdown', () => {
  it('parses every field kind', () => {
    const { values, rest, preface, extra } = (parseForm(schema, BODY) as any);
    expect(values.goal).toBe('Do it.'); expect(values.authentication).toBe('OAuth 2');
    expect(values.endpoints).toEqual([{ method: 'POST', path: '/orders', text: 'Creates.', req: '', res: '201' }]);
    expect(values.data_types).toBe('{"a": 1}'); expect(values.requirements).toEqual(['one', 'two']);
    expect(values.acceptance_criteria).toEqual([{ text: 'done', done: true }, { text: 'open', done: false }]);
    expect(values.flow).toBe('flowchart LR\n  A --> B'); expect(values.errors).toEqual(['400 bad', '404 none']);
    expect(rest.endpoints).toBe('stray note'); expect(preface).toBe('Intro text'); expect(extra).toBe('## NOTES\n\nunknown section');
  });
  it('keeps everything the form does not know and is idempotent', () => {
    const once = serializeForm(schema, parseForm(schema, BODY));
    expect(once).toContain('stray note'); expect(once).toContain('## NOTES\n\nunknown section'); expect(once.startsWith('Intro text')); 
    expect(serializeForm(schema, parseForm(schema, once))).toBe(once);
  });
  it('numbers requirements across fields and drops empty rows', () => {
    const s = cleanForm({ fields: [{ label: 'A', kind: 'requirements' }, { label: 'B', kind: 'requirements' }] })!;
    expect(serializeForm(s, { values: { a: ['x', '', 'y'], b: ['z'] } })).toBe('## A\n\nR1 x\nR2 y\n\n## B\n\nR3 z\n');
  });
  it('ignores headings inside code fences', () => {
    const s = cleanForm({ fields: [{ label: 'CODE', kind: 'code', lang: 'md' }] })!;
    expect((parseForm(s, '## CODE\n\n```md\n## not a section\n```\n') as any).values.code).toBe('## not a section');
  });
  it('a new form spec starts with all sections, empty', () => { expect(formTemplate(schema)).toMatch(/^## GOAL\n\n## AUTHENTICATION\n\n## ENDPOINTS/); });
  it('built-in form types parse their own template without leftovers', () => {
    for (const t of (BUILTIN_TYPES as any[]).filter((x) => x.form)) { const p = parseForm(t.form, t.template); expect(p.extra, t.key).toBe(''); expect(p.preface, t.key).toBe(''); expect(serializeForm(t.form, p), t.key).toBe(serializeForm(t.form, parseForm(t.form, serializeForm(t.form, p)))); }
  });
});

describe('cleanForm', () => {
  it('rejects broken schemas', () => {
    expect(() => cleanForm({ fields: [] })).toThrow(); expect(() => cleanForm({ fields: [{ label: 'x', kind: 'nope' }] })).toThrow();
    expect(() => cleanForm({ fields: [{ label: 'x', kind: 'select' }] })).toThrow(); expect(() => cleanForm({ fields: [{ label: 'x', kind: 'text' }, { label: 'X', kind: 'text' }] })).toThrow();
  });
  it('derives keys and drops unknown tabs', () => {
    const f = cleanForm({ tabs: [{ key: 'a', label: 'A' }], fields: [{ label: 'Quality target', kind: 'text', tab: 'zzz' }] })!;
    expect(f.fields[0].key).toBe('quality_target'); expect(f.fields[0].tab).toBeUndefined();
  });
});

describe('glossary references in documents (prefix #)', () => {
  it('finds #[Term] and #[Term|label]', () => {
    expect(extractTermRefs('Uses #[Attempt window] and #[Ledger entry|entries] here.')).toEqual(['Attempt window', 'Ledger entry']);
  });
  it('ignores headings, issue numbers, URLs fragments and code', () => {
    expect(extractTermRefs('# Heading\nissue #12, see http://x/#[frag]\n`#[inline]`\n```\n#[fenced]\n```')).toEqual([]);
  });
  it('termRef round-trips', () => { expect(extractTermRefs(termRef('Idempotency key'))).toEqual(['Idempotency key']); });
});
