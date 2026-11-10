// Spec types: every spec has a type that decides its starting structure (template) and tells agents what kind of
// specification they are reading. Built-in types live here (shared by browser and server); teams add their own.
import { formTemplate } from './specForm.js';

export const DEFAULT_TYPE = 'feature';

export const BUILTIN_TYPES = [
  {
    key: 'feature', label: 'Feature spec', short: 'Feature',
    description: 'What a feature must do and when it counts as done: goal, requirements, acceptance criteria.',
    template: '## GOAL\n\n## USER STORIES\n\n## REQUIREMENTS\n\n## ACCEPTANCE CRITERIA\n\n## OUT OF SCOPE\n',
  },
  {
    key: 'api', label: 'API spec', short: 'API',
    description: 'An interface contract: one endpoint block per operation (method, path, description, request, responses), plus authentication and errors.',
    template: '## OVERVIEW\n\n## AUTHENTICATION\n\n## ENDPOINTS\n\n```endpoint GET /resources/{id}\nReturns one resource.\n\nResponses:\n200 The resource\n404 Unknown id\n```\n\n## DATA TYPES\n\n```json\n{}\n```\n\n## ERRORS\n\n## REQUIREMENTS\n\n## ACCEPTANCE CRITERIA\n',
  },
  {
    key: 'ui', label: 'UI spec / design rule', short: 'UI',
    description: 'How something looks and behaves: components, states, design rules, accessibility, copy.',
    template: '## PURPOSE\n\n## COMPONENTS AND STATES\n\n## DESIGN RULES\n\n## ACCESSIBILITY\n\n## COPY AND CONTENT\n\n## ACCEPTANCE CRITERIA\n',
  },
  {
    key: 'data', label: 'Data model', short: 'Data',
    description: 'Entities, relations and invariants, with a diagram and the rules for migrating existing data.',
    template: '## OVERVIEW\n\n## ENTITIES\n\n```mermaid\nerDiagram\n  CUSTOMER ||--o{ INVOICE : has\n```\n\n## INVARIANTS\n\n## MIGRATION\n',
  },
  {
    key: 'nfr', label: 'Non-functional requirement', short: 'NFR',
    description: 'A quality attribute with measurable targets: performance, security, availability, cost …',
    template: '## QUALITY ATTRIBUTE\n\n## TARGETS\n\n## MEASUREMENT\n\n## TRADE-OFFS\n',
  },
  {
    key: 'integration', label: 'Integration', short: 'Integration',
    description: 'How we talk to another system: flows, contract, failure handling and ownership.',
    template: '## PARTNER SYSTEM\n\n## FLOWS\n\n```mermaid\nsequenceDiagram\n  participant A as Us\n  participant B as Partner\n  A->>B: request\n  B-->>A: response\n```\n\n## CONTRACT\n\n## FAILURE HANDLING\n',
  },
];

const F = (key, label, kind, extra = {}) => ({ key, label, kind, ...extra });
const FORMS = {
  feature: { view: 'editor', fields: [F('goal', 'GOAL', 'longtext'), F('stories', 'USER STORIES', 'list'), F('requirements', 'REQUIREMENTS', 'requirements'), F('acceptance', 'ACCEPTANCE CRITERIA', 'checklist'), F('outOfScope', 'OUT OF SCOPE', 'list')] },
  api: {
    view: 'form', tabs: [{ key: 'overview', label: 'Overview' }, { key: 'endpoints', label: 'Endpoints' }, { key: 'contract', label: 'Contract' }, { key: 'quality', label: 'Quality' }],
    fields: [
      F('overview', 'OVERVIEW', 'longtext', { tab: 'overview', help: 'What this API is for and who calls it.' }),
      F('authentication', 'AUTHENTICATION', 'select', { tab: 'overview', options: ['None', 'API key', 'Bearer token', 'OAuth 2', 'mTLS', 'Other'] }),
      F('endpoints', 'ENDPOINTS', 'endpoints', { tab: 'endpoints', help: 'One block per operation.' }),
      F('dataTypes', 'DATA TYPES', 'code', { tab: 'contract', lang: 'json', help: 'Shared schemas (JSON Schema, TypeScript, …).' }),
      F('errors', 'ERRORS', 'list', { tab: 'contract', help: 'e.g. “409 – idempotency key reused with a different body”.' }),
      F('requirements', 'REQUIREMENTS', 'requirements', { tab: 'quality' }),
      F('acceptance', 'ACCEPTANCE CRITERIA', 'checklist', { tab: 'quality' }),
    ],
  },
  ui: {
    view: 'form', tabs: [{ key: 'what', label: 'What' }, { key: 'rules', label: 'Rules' }, { key: 'done', label: 'Done' }],
    fields: [
      F('purpose', 'PURPOSE', 'longtext', { tab: 'what' }), F('components', 'COMPONENTS AND STATES', 'list', { tab: 'what', help: 'Component – states (empty, loading, error …).' }),
      F('rules', 'DESIGN RULES', 'list', { tab: 'rules' }), F('a11y', 'ACCESSIBILITY', 'list', { tab: 'rules' }), F('copy', 'COPY AND CONTENT', 'longtext', { tab: 'rules' }),
      F('acceptance', 'ACCEPTANCE CRITERIA', 'checklist', { tab: 'done' }),
    ],
  },
  data: { view: 'editor', fields: [F('overview', 'OVERVIEW', 'longtext'), F('entities', 'ENTITIES', 'diagram'), F('invariants', 'INVARIANTS', 'list'), F('migration', 'MIGRATION', 'longtext')] },
  nfr: {
    view: 'form',
    fields: [
      F('attribute', 'QUALITY ATTRIBUTE', 'select', { options: ['Performance', 'Availability', 'Reliability', 'Security', 'Scalability', 'Cost', 'Usability', 'Compliance', 'Other'] }),
      F('targets', 'TARGETS', 'list', { help: 'Measurable, e.g. “p95 latency < 300 ms at 200 rps”.' }), F('measurement', 'MEASUREMENT', 'longtext'), F('tradeoffs', 'TRADE-OFFS', 'longtext'),
    ],
  },
  integration: { view: 'editor', fields: [F('partner', 'PARTNER SYSTEM', 'text'), F('flows', 'FLOWS', 'diagram'), F('contract', 'CONTRACT', 'longtext'), F('failures', 'FAILURE HANDLING', 'list')] },
};
for (const t of BUILTIN_TYPES) {
  const { view, ...form } = FORMS[t.key];
  t.form = form;
  t.view = view;
  if (view === 'form') t.template = formTemplate(form); // form types start from their (empty) sections
}

export const builtinKeys = new Set(BUILTIN_TYPES.map((t) => t.key));
export const typeFrom = (types, key) => (types ?? BUILTIN_TYPES).find((t) => t.key === key) ?? { key, label: key, short: key, description: '', template: '', missing: true };
