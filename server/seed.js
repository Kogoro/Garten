import * as store from './store.js';
import { createGlobalTerm, listGlobalTerms } from './globalGlossary.js';

/** Demo content mirroring the design mockup. Only runs on an empty team (after ensureFoundation). */
export async function seedDemo(team) {
  const t = team.id;
  if (!listGlobalTerms().length) { // shared vocabulary every team can import from Glossary → Import
    createGlobalTerm({ term: 'Chargeback', definition: 'A forced reversal of a card payment initiated by the cardholder’s bank. See [[Settlement]].', aliases: ['dispute'], see: ['Settlement'] });
    createGlobalTerm({ term: 'Settlement', definition: 'The transfer of funds from the payment processor to our bank account.', aliases: ['clearing', 'payout run'] });
  }
  const doc = (id, body) => store.saveItem(t, { id, kind: 'doc', title: id, body, links: [] }, 0);
  const fill = (id, body) => store.saveItem(t, { id, kind: 'doc', body }, store.getItem(t, id).rev);

  fill('vision.md', '# Vision\n\n## Where are we heading?\nInvoices that settle themselves: customers are billed exactly once, on time, with no manual follow-up.\n\n## Why does it matter?\nBilling errors are our most expensive support topic and the fastest way to lose trust.\n');
  fill('strategy.md', '# Strategy\n\n## Goals\n- Zero double charges\n- Every billing event is explainable from the ledger\n\n## Principles and trade-offs\n- Correctness over speed: retries must be safe before they are fast\n\n## Out of scope\n- Tax filing\n');
  fill('glossary.md', '# Glossary\n\nAttempt window\n: The time bucket in which retries of one invoice run count as the same attempt.\n\nIdempotency key\n: A client-chosen token that makes a charge request safe to repeat.\n');
  for (const id of ['vision.md', 'strategy.md', 'glossary.md']) await store.releaseDoc(team, id);

  store.saveItem(t, { id: 'adr', kind: 'folder' }, 0);
  store.saveItem(t, { id: 'schemas', kind: 'folder' }, 0);
  doc('adr/ADR-007.md', '# ADR-007: Idempotency key retention\n\nKeys are kept for 24 hours (the retry window), then purged.\n');
  doc('schemas/billing.yaml', 'service: billing\nretry:\n  window: 24h\n  max_attempts: 5\n');
  doc('adr/webhook-keys.md', '# Webhook signing keys\n\nTwo keys are valid during rotation: `current` and `previous`.\n');

  store.saveItem(t, {
    id: 'SPEC-012', kind: 'spec', specType: 'api', title: 'Webhook signature rotation', links: ['adr/webhook-keys.md'],
    body: '## OVERVIEW\n\nRotate webhook signing keys without dropping events.\n\n## AUTHENTICATION\n\nBearer token\n\n## ENDPOINTS\n\n```endpoint POST /webhooks/keys/rotate\nStarts a rotation: a new signing key becomes `current`, the old one stays valid as `previous` for the rotation window.\n\nRequest:\n{ "window_hours": 24 }\n\nResponses:\n202 Rotation started\n409 A rotation is already running\n```\n\n## DATA TYPES\n\n## ERRORS\n\n- 409 – a rotation is already running\n\n## REQUIREMENTS\n\nR1 Accept signatures from `current` and `previous` keys during rotation.\nR2 Rotation window is configurable, default 24h.\n\n## ACCEPTANCE CRITERIA\n\n- [ ] Events signed with the previous key are accepted\n- [ ] Events signed with a revoked key are rejected\n',
  }, 0);
  await store.releaseSpec(team, 'SPEC-012');

  store.saveItem(t, {
    id: 'SPEC-014', kind: 'spec', title: 'Idempotent invoice retries', links: ['adr/ADR-007.md', 'schemas/billing.yaml'],
    body: '## GOAL\nRetrying a failed invoice run must never bill a customer twice.\n\n## REQUIREMENTS\nR1 Every charge request carries an idempotency key built from invoice ID and attempt window.\nR2 A repeated key returns the first result and creates no new ledger entry.\nR3 Keys expire after the retry window in @adr/ADR-007.md\n\n## ACCEPTANCE CRITERIA\n- [x] Double submit yields one charge\n- [ ] Retry after timeout reuses the key\n- [ ] Expired key is rejected with 409\n',
  }, 0);
}
