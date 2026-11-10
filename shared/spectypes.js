// Spec types: every spec has a type that decides its starting structure (template) and tells agents what kind of
// specification they are reading. Built-in types live here (shared by browser and server); teams add their own.
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

export const builtinKeys = new Set(BUILTIN_TYPES.map((t) => t.key));
export const typeFrom = (types, key) => (types ?? BUILTIN_TYPES).find((t) => t.key === key) ?? { key, label: key, short: key, description: '', template: '', missing: true };
