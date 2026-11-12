// Spec types: every spec has a type that decides its starting structure (template) and tells agents what kind of
// specification they are reading. Built-in types live here (shared by browser and server); teams add their own.
import { formTemplate } from './specForm.js';

export const DEFAULT_TYPE = 'feature';

export const BUILTIN_TYPES = [
  {
    key: 'feature', group: 'Define', label: 'Feature spec', short: 'Feature',
    description: 'What a feature must do and when it counts as done: goal, requirements, acceptance criteria.',
    template: '## GOAL\n\n## USER STORIES\n\n## REQUIREMENTS\n\n## ACCEPTANCE CRITERIA\n\n## OUT OF SCOPE\n',
  },
  {
    key: 'api', group: 'Define', label: 'API spec', short: 'API',
    description: 'An interface contract: one endpoint block per operation (method, path, description, request, responses), plus authentication and errors.',
    template: '## OVERVIEW\n\n## AUTHENTICATION\n\n## ENDPOINTS\n\n```endpoint GET /resources/{id}\nReturns one resource.\n\nResponses:\n200 The resource\n404 Unknown id\n```\n\n## DATA TYPES\n\n```json\n{}\n```\n\n## ERRORS\n\n## REQUIREMENTS\n\n## ACCEPTANCE CRITERIA\n',
  },
  {
    key: 'ui', group: 'Define', label: 'UI spec / design rule', short: 'UI',
    description: 'How something looks and behaves: components, states, design rules, accessibility, copy.',
    template: '## PURPOSE\n\n## COMPONENTS AND STATES\n\n## DESIGN RULES\n\n## ACCESSIBILITY\n\n## COPY AND CONTENT\n\n## ACCEPTANCE CRITERIA\n',
  },
  {
    key: 'data', group: 'Define', label: 'Data model', short: 'Data',
    description: 'Entities, relations and invariants, with a diagram and the rules for migrating existing data.',
    template: '## OVERVIEW\n\n## ENTITIES\n\n```mermaid\nerDiagram\n  CUSTOMER ||--o{ INVOICE : has\n```\n\n## INVARIANTS\n\n## MIGRATION\n',
  },
  {
    key: 'nfr', group: 'Decide and protect', label: 'Non-functional requirement', short: 'NFR',
    description: 'A quality attribute with measurable targets: performance, security, availability, cost …',
    template: '## QUALITY ATTRIBUTE\n\n## TARGETS\n\n## MEASUREMENT\n\n## TRADE-OFFS\n',
  },
  {
    key: 'integration', group: 'Define', label: 'Integration', short: 'Integration',
    description: 'How we talk to another system: flows, contract, failure handling and ownership.',
    template: '## PARTNER SYSTEM\n\n## FLOWS\n\n```mermaid\nsequenceDiagram\n  participant A as Us\n  participant B as Partner\n  A->>B: request\n  B-->>A: response\n```\n\n## CONTRACT\n\n## FAILURE HANDLING\n',
  },
  {
    key: 'adr', group: 'Decide and protect', label: 'ADR (decision record)', short: 'ADR',
    description: 'One architecture decision in the classic record format: status, context, options, decision and consequences.',
    template: '',
  },
  {
    key: 'architecture', group: 'Decide and protect', label: 'Architecture spec', short: 'Architecture',
    description: 'A design decision or system structure: context, drivers, decision, components, alternatives, consequences and risks.',
    template: '',
  },
  {
    key: 'mcp', group: 'Define', label: 'Agent tool / MCP contract', short: 'MCP',
    description: 'The tools an agent may call: scope or role, input, output, errors, rate limit and side effects (e.g. “stays a draft”).',
    template: '',
  },
  {
    key: 'permissions', group: 'Decide and protect', label: 'Permission model', short: 'Permissions',
    description: 'Roles, actions and the matrix between them, how the server enforces it, and the exceptions.',
    template: '',
  },
  {
    key: 'security', group: 'Decide and protect', label: 'Security control', short: 'Security',
    description: 'One asset, its threat, the measure that counters it, the residual risk and how the measure is checked.',
    template: '',
  },
  {
    key: 'config', group: 'Operate', label: 'Configuration', short: 'Config',
    description: 'Environment variables and settings: default, effect, security relevance and the specs they affect.',
    template: '',
  },
  {
    key: 'lifecycle', group: 'Operate', label: 'State machine / lifecycle', short: 'Lifecycle',
    description: 'States, transitions and their triggers, with a Mermaid state diagram.',
    template: '',
  },
  {
    key: 'runbook', group: 'Operate', label: 'Runbook / operations', short: 'Runbook',
    description: 'A procedure, not a feature: prerequisites, steps, verification and rollback (install, update, backup, release …).',
    template: '',
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
  adr: {
    view: 'form',
    fields: [
      F('status', 'STATUS', 'select', { options: ['Proposed', 'Accepted', 'Deprecated', 'Superseded', 'Rejected'] }),
      F('deciders', 'DECIDERS', 'text', { help: 'Who made or must approve the decision.' }),
      F('context', 'CONTEXT', 'longtext', { help: 'The forces at play and the problem to solve.' }),
      F('drivers', 'DECISION DRIVERS', 'list'),
      F('options', 'CONSIDERED OPTIONS', 'list', { help: 'Option – short pros and cons.' }),
      F('decision', 'DECISION', 'longtext', { help: 'The chosen option and why.' }),
      F('positive', 'POSITIVE CONSEQUENCES', 'list'), F('negative', 'NEGATIVE CONSEQUENCES', 'list'),
      F('links', 'LINKS', 'list', { help: 'Related ADRs, specs, tickets (e.g. “Supersedes ADR-004”).' }),
    ],
  },
  architecture: {
    view: 'form', tabs: [{ key: 'context', label: 'Context' }, { key: 'design', label: 'Design' }, { key: 'consequences', label: 'Consequences' }],
    fields: [
      F('status', 'STATUS', 'select', { tab: 'context', options: ['Proposed', 'Accepted', 'Superseded', 'Rejected'] }),
      F('context', 'CONTEXT', 'longtext', { tab: 'context', help: 'The situation and the problem this design answers.' }),
      F('drivers', 'QUALITY DRIVERS AND CONSTRAINTS', 'list', { tab: 'context', help: 'What matters most (latency, cost, team skills, compliance …) and what is fixed.' }),
      F('decision', 'DECISION', 'longtext', { tab: 'design', help: 'What we decided, in one or two paragraphs.' }),
      F('overview', 'OVERVIEW DIAGRAM', 'diagram', { tab: 'design' }),
      F('components', 'COMPONENTS AND RESPONSIBILITIES', 'list', { tab: 'design', help: 'Component – what it owns, what it talks to.' }),
      F('alternatives', 'ALTERNATIVES CONSIDERED', 'list', { tab: 'design', help: 'Option – why not.' }),
      F('consequences', 'CONSEQUENCES', 'list', { tab: 'consequences', help: 'Good and bad results of the decision.' }),
      F('risks', 'RISKS', 'list', { tab: 'consequences' }),
      F('questions', 'OPEN QUESTIONS', 'list', { tab: 'consequences' }),
      F('requirements', 'REQUIREMENTS', 'requirements', { tab: 'consequences', help: 'Testable rules that follow from the design.' }),
    ],
  },
  mcp: {
    view: 'form', tabs: [{ key: 'tools', label: 'Tools' }, { key: 'contract', label: 'Contract' }, { key: 'safety', label: 'Safety' }],
    fields: [
      F('overview', 'OVERVIEW', 'longtext', { tab: 'tools', help: 'Which agent or client uses these tools, and how they connect (transport, endpoint).' }),
      F('tools', 'TOOLS', 'list', { tab: 'tools', help: 'One line per tool: name – what it does. Keep one tool per line, not one block for all.' }),
      F('scope', 'SCOPE AND ROLE', 'longtext', { tab: 'tools', help: 'Token scope or role each tool needs, e.g. “create_spec – editor”.' }),
      F('input', 'INPUT', 'code', { tab: 'contract', lang: 'json', help: 'Input schema per tool (JSON Schema).' }),
      F('output', 'OUTPUT', 'code', { tab: 'contract', lang: 'json', help: 'Result shape per tool.' }),
      F('errors', 'ERRORS', 'list', { tab: 'contract', help: 'e.g. “forbidden – the token lacks the editor role”.' }),
      F('rateLimit', 'RATE LIMIT', 'text', { tab: 'safety', help: 'e.g. “60 calls per minute per token”.' }),
      F('sideEffects', 'SIDE EFFECTS', 'list', { tab: 'safety', help: 'What changes besides the result, e.g. “the new spec stays a draft until a person approves it”.' }),
      F('requirements', 'REQUIREMENTS', 'requirements', { tab: 'safety' }),
      F('acceptance', 'ACCEPTANCE CRITERIA', 'checklist', { tab: 'safety' }),
    ],
  },
  permissions: {
    view: 'form', tabs: [{ key: 'model', label: 'Model' }, { key: 'enforcement', label: 'Enforcement' }],
    fields: [
      F('roles', 'ROLES', 'list', { tab: 'model', help: 'Role – who has it and what it is meant for.' }),
      F('actions', 'ACTIONS', 'list', { tab: 'model', help: 'Everything a person or agent can do that needs a check.' }),
      F('matrix', 'MATRIX', 'longtext', { tab: 'model', help: 'A Markdown table: Action | viewer | editor | approver | admin, with ✓ or –.' }),
      F('enforcement', 'SERVER ENFORCEMENT', 'longtext', { tab: 'enforcement', help: 'Where the check happens (never only in the UI) and what is returned when it fails.' }),
      F('exceptions', 'EXCEPTIONS', 'list', { tab: 'enforcement', help: 'Cases that deviate from the matrix, e.g. “authors cannot approve their own spec”.' }),
      F('requirements', 'REQUIREMENTS', 'requirements', { tab: 'enforcement' }),
      F('acceptance', 'ACCEPTANCE CRITERIA', 'checklist', { tab: 'enforcement' }),
    ],
  },
  security: {
    view: 'form', tabs: [{ key: 'risk', label: 'Risk' }, { key: 'control', label: 'Control' }],
    fields: [
      F('asset', 'ASSET', 'longtext', { tab: 'risk', help: 'What is protected, e.g. “internal network behind the lookup feature”.' }),
      F('threat', 'THREAT', 'list', { tab: 'risk', help: 'How the asset can be attacked or misused, e.g. “SSRF through a user-supplied URL”.' }),
      F('control', 'CONTROL', 'list', { tab: 'control', help: 'The measure that counters each threat.' }),
      F('residual', 'RESIDUAL RISK', 'longtext', { tab: 'control', help: 'What remains after the measure, and why it is accepted.' }),
      F('rating', 'RESIDUAL RATING', 'select', { tab: 'control', options: ['Low', 'Medium', 'High', 'Critical'] }),
      F('verification', 'VERIFICATION', 'checklist', { tab: 'control', help: 'How to check that the measure works: a test, a review or a scan.' }),
    ],
  },
  config: {
    view: 'form',
    fields: [
      F('overview', 'OVERVIEW', 'longtext', { help: 'Where these settings are read from and when a change takes effect.' }),
      F('variables', 'VARIABLES', 'longtext', { help: 'A Markdown table: Variable | Default | Effect | Security-relevant | Spec.' }),
      F('security', 'SECURITY-RELEVANT SETTINGS', 'list', { help: 'Settings that open a door when set wrongly, and the safe value.' }),
      F('affected', 'AFFECTED SPECS', 'list', { help: 'Spec ids that depend on these settings.' }),
      F('acceptance', 'ACCEPTANCE CRITERIA', 'checklist'),
    ],
  },
  lifecycle: {
    view: 'form',
    fields: [
      F('overview', 'OVERVIEW', 'longtext', { help: 'What object goes through these states.' }),
      F('states', 'STATES', 'list', { help: 'State – what it means.' }),
      F('transitions', 'TRANSITIONS', 'list', { help: 'From → To – trigger and who may cause it.' }),
      F('diagram', 'STATE DIAGRAM', 'diagram', { help: 'Mermaid: stateDiagram-v2' }),
      F('invariants', 'INVARIANTS', 'list', { help: 'What always holds, e.g. “a revoked invitation never becomes open again”.' }),
      F('requirements', 'REQUIREMENTS', 'requirements'),
    ],
  },
  runbook: {
    view: 'form',
    fields: [
      F('purpose', 'PURPOSE', 'longtext', { help: 'What this procedure achieves and when to run it.' }),
      F('prerequisites', 'PREREQUISITES', 'list', { help: 'Access, tools, backups and versions needed before the first step.' }),
      F('steps', 'STEPS', 'list', { help: 'One action per line, in order.' }),
      F('verification', 'VERIFICATION', 'checklist', { help: 'How to know it worked.' }),
      F('rollback', 'ROLLBACK', 'list', { help: 'How to get back to the previous state if a step fails.' }),
      F('notes', 'NOTES', 'longtext'),
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
