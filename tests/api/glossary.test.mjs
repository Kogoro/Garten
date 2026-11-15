// Glossary: aliases and references, the global glossary, file import (CSV / JSON / Markdown), migration of the old single glossary.md.
//   node --test tests/api/glossary.test.mjs
import assert from 'node:assert/strict';
import { before, after, describe } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { useServer, makeUser, chain, startServer, mcpClient, call, sleep, scratch, git, missing, Client } from '../helpers.mjs';
import { parseGlossaryFile } from '../../shared/glossaryImport.js';
import { formatTermFile } from '../../shared/glossaryFiles.js';

describe('glossary', () => {
  const ctx = useServer({ FOUNDATION_DEBOUNCE_MS: '150' });
  const mcp = (token) => mcpClient(ctx.base, token);
  const ctxTool = async (token) => { const cl = await mcp(token); const out = await call(cl, 'get_team_context'); await cl.close(); return out.text; };
  let admin, T1, viewer, tokA;
  before(async () => {
    ({ admin, T1 } = ctx);
    viewer = await makeUser(ctx, 'viewer');
    tokA = (await admin.post('/api/me/tokens', { name: 'ctx', scopes: ['mcp:read'], teamId: T1 })).data.token;
  });

  describe('aliases, references, global glossary', () => {
    const step = chain();
    let gl1;
    step('get_glossary finds terms by alias and returns synonyms and related terms (explicit + [[references]])', async () => {
      await admin.push([{ id: 'glossary/retry-horizon.md', kind: 'doc', baseRev: 0, fields: { title: 'x', body: formatTermFile({ term: 'Retry horizon', body: 'How long a retry stays idempotent. See [[Idempotency key]] and [[Ledger|the ledger]].', aliases: ['horizon', 'retry cut-off'], see: ['Ledger entry'] }) } }]);
      await sleep(700);
      const cg = await mcp(tokA);
      const viaAlias = JSON.parse((await call(cg, 'get_glossary', { term: 'cut-off' })).text);
      await cg.close();
      assert.equal(viaAlias.length, 1); assert.equal(viaAlias[0].term, 'Retry horizon'); assert.deepEqual(viaAlias[0].aliases, ['horizon', 'retry cut-off']);
      assert.deepEqual(viaAlias[0].see_also.sort(), ['Idempotency key', 'Ledger', 'Ledger entry']); assert.equal(viaAlias[0].from_global_glossary, false);
    });
    step('get_team_context lists aliases and related terms', async () => {
      const ctxText = await ctxTool(tokA);
      assert.match(ctxText, /\*\*Retry horizon\*\* \(also: horizon, retry cut-off\): How long a retry stays idempotent/); assert.match(ctxText, /see also: Ledger entry, Idempotency key, Ledger/);
    });
    step('GLOSSARY.md in Git carries aliases and related terms', async () => { assert.match(readFileSync(`${ctx.srv.dir}/repos/${T1}/specs/GLOSSARY.md`, 'utf8'), /Also known as: horizon, retry cut-off · See also: Ledger entry, Idempotency key, Ledger/); });

    step('instance admin adds a global glossary term', async () => {
      gl1 = await admin.post('/api/glossary/global', { term: 'Reconciliation', definition: 'Matching our ledger with the bank statement.', aliases: 'matching, recon', see: ['Chargeback'] });
      assert.equal(gl1.status, 200); assert.equal(gl1.data.term.rev, 1); assert.deepEqual(gl1.data.term.aliases, ['matching', 'recon']);
    });
    step('everybody can read the global glossary, only instance admins change it', async () => { assert.equal((await viewer.c.post('/api/glossary/global', { term: 'X', definition: 'y' })).status, 403); assert.ok((await viewer.c.get('/api/glossary/global')).data.terms.some((t) => t.term === 'Reconciliation')); });
    step('global terms are validated (unique, no brackets, definition required)', async () => { assert.equal((await admin.post('/api/glossary/global', { term: 'reconciliation', definition: 'dup' })).status, 409); assert.equal((await admin.post('/api/glossary/global', { term: 'Bad [term]', definition: 'x' })).status, 400); assert.equal((await admin.post('/api/glossary/global', { term: 'Ok', definition: '' })).status, 400); });
    step('editing a global term bumps its revision', async () => {
      const glEdit = await admin.patch(`/api/glossary/global/${gl1.data.term.id}`, { definition: 'Funds move from the processor to our bank.' });
      assert.equal(glEdit.data.term.rev, 2); assert.equal(glEdit.data.term.aliases.length, 2);
    });
    step('global terms can be deleted', async () => { assert.equal((await admin.del(`/api/glossary/global/${gl1.data.term.id}`)).data.terms.some((t) => t.term === 'Reconciliation'), false); });
  });

  describe('global glossary: file import (CSV / JSON / Markdown)', () => {
    const step = chain();
    const gUrl = '/api/glossary/global/import';
    let csv;
    step('CSV parser: delimiter detection (;), quoted cells, header aliases (German), multiple aliases, row errors', () => {
      csv = parseGlossaryFile('terms.csv', 'Term;Definition;Synonyme;Siehe auch\n"Idempotenz";"Mehrfaches Ausführen, gleiches Ergebnis; siehe [[Retry]]";"Wiederholsicherheit|Idempotency";Retry\nRetry;Ein erneuter Versuch;;\n;nur Definition;;\n');
      assert.equal(csv.terms.length, 2); assert.deepEqual(csv.terms[0].aliases, ['Wiederholsicherheit', 'Idempotency']); assert.equal(csv.terms[0].definition, 'Mehrfaches Ausführen, gleiches Ergebnis; siehe [[Retry]]'); assert.equal(csv.errors.length, 1);
    });
    step('CSV parser: escaped quotes', () => { assert.deepEqual(parseGlossaryFile('x.csv', 'term,definition\nA,"say ""hi"""\n').terms[0].definition, 'say "hi"'); });
    step('JSON parser: array, {terms:[]}, {term: definition} map, field-name variants, invalid input', () => {
      assert.equal(parseGlossaryFile('t.json', JSON.stringify([{ term: 'A', definition: 'a', aliases: 'x, y' }, { name: 'B', description: 'b', synonyms: ['z'] }])).terms.length, 2);
      assert.deepEqual(parseGlossaryFile('t.json', JSON.stringify({ terms: [{ term: 'A', definition: 'a', see: ['B'] }] })).terms[0].see, ['B']);
      assert.equal(parseGlossaryFile('t.json', JSON.stringify({ Alpha: 'first', Beta: 'second' })).terms.length, 2); assert.ok(parseGlossaryFile('t.json', '{nope').errors[0].startsWith('Invalid JSON'));
    });
    step('Markdown parser: definition lists with aliases', () => {
      const mdImport = parseGlossaryFile('g.md', 'Alpha\n: First. See [[Beta]].\n: Aliases: a1, a2\n\nBeta\n: Second.\n');
      assert.equal(mdImport.terms.length, 2); assert.deepEqual(mdImport.terms[0].aliases, ['a1', 'a2']); assert.equal(parseGlossaryFile('x.txt', 'nothing here').errors.length, 1);
    });
    step('duplicate terms inside one file are reported and the first wins', () => { assert.equal(parseGlossaryFile('d.csv', 'term,definition\nA,one\na,two\n').terms.length, 1); });

    step('only instance admins import into the global glossary', async () => { assert.equal((await viewer.c.post(gUrl, { terms: [] })).status, 403); });
    step('bulk import creates valid terms and reports invalid ones', async () => {
      const imp1 = await admin.post(gUrl, { mode: 'skip', terms: [...csv.terms, { term: 'Bad [x]', definition: 'x' }, { term: 'NoDef', definition: '' }] });
      assert.deepEqual([imp1.data.result.created, imp1.data.result.skipped, imp1.data.result.errors.length], [2, 0, 2]); assert.ok(imp1.data.terms.some((t) => t.term === 'Idempotenz' && t.aliases.length === 2));
    });
    step('mode "skip" keeps existing terms (case-insensitive match)', async () => {
      const skipRun = await admin.post(gUrl, { mode: 'skip', terms: [{ term: 'idempotenz', definition: 'changed' }] });
      assert.equal(skipRun.data.result.skipped, 1); assert.equal(skipRun.data.terms.find((t) => t.term === 'Idempotenz').definition.startsWith('Mehrfaches'), true);
    });
    step('mode "update" overwrites changed terms (revision +1) and leaves identical ones alone', async () => {
      const upd = await admin.post(gUrl, { mode: 'update', terms: [{ term: 'Idempotenz', definition: 'changed', aliases: ['x'] }, { term: 'Retry', definition: 'Ein erneuter Versuch' }] });
      assert.equal(upd.data.result.updated, 1); assert.equal(upd.data.result.unchanged, 1); assert.equal(upd.data.terms.find((t) => t.term === 'Idempotenz').rev, 2);
    });
    step('bulk import is bounded and validated', async () => { assert.equal((await admin.post(gUrl, { terms: Array.from({ length: 2001 }, (_, i) => ({ term: `T${i}`, definition: 'x' })) })).status, 400); assert.equal((await admin.post(gUrl, { terms: 'nope' })).status, 400); });
  });

  // migration: the single glossary.md of older versions becomes a folder of term files on the next start
  describe('migration of glossary.md', { skip: missing('git') }, () => {
    const step = chain();
    const dataDir = scratch('specs-migrate-');
    const env = { DATA_DIR: dataDir, SEED_DEMO: '0', FOUNDATION_DEBOUNCE_MS: '100' };
    let a, b, ca, items, repo;
    after(() => Promise.all([a?.kill(), b?.kill()]));
    step('migration: every definition of glossary.md becomes a term file, headings become (nested) folders, agent drafts become proposals', async () => {
      a = await startServer(env);
      ca = new Client(a.base); await ca.login('admin@localhost', 'adminpass1');
      const old = '# Glossary\n\nLedger\n: The book of record.\n\n## Payments & Billing\n\nSettlement\n: Funds move to our bank.\n: Aliases: payout\n\n### Cards\n\nChargeback\n: A forced reversal. See [[Settlement]].\n';
      await ca.push([{ id: 'glossary.md', kind: 'doc', baseRev: 0, fields: { title: 'glossary.md', body: old, pinned: true } }, { id: 'glossary/from-notes.md', kind: 'doc', baseRev: 0, fields: { title: 'x', body: '# Terms derived from notes.md\n\nRefund window\n: How long a refund stays possible.\n' } }]);
      await sleep(800);
      repo = path.join(dataDir, 'repos', ca.tid, 'specs');
      assert.ok(existsSync(path.join(repo, 'docs', 'glossary.md')));
      a.stop(); await sleep(600);
      b = await startServer(env);
      const cb = new Client(b.base); await cb.login('admin@localhost', 'adminpass1');
      items = (await cb.sync()).data.items;
      const live = items.filter((i) => !i.deleted && i.kind === 'doc').map((i) => i.id).sort();
      assert.deepEqual(live.filter((x) => x.startsWith('glossary/')), ['glossary/Payments-Billing/Cards/chargeback.md', 'glossary/Payments-Billing/settlement.md', 'glossary/_proposed/refund-window.md', 'glossary/ledger.md']);
      assert.ok(items.some((i) => i.id === 'glossary.md' && i.deleted)); assert.ok(items.some((i) => i.id === 'glossary/Payments-Billing' && i.kind === 'folder' && !i.deleted));
      const st = items.find((i) => i.id === 'glossary/Payments-Billing/settlement.md');
      assert.match(st.body, /^---\nterm: "Settlement"\naliases: \["payout"\]\n---\n\nFunds move to our bank\.\n$/); assert.equal(st.pinned, true); assert.equal(st.status, 'approved');
    });
    step('migration: the released glossary is released again in one commit and glossary.md leaves the repository', () => {
      assert.ok(existsSync(path.join(repo, 'docs', 'glossary', 'Payments-Billing', 'Cards', 'chargeback.md'))); assert.ok(!existsSync(path.join(repo, 'docs', 'glossary.md')));
      assert.match(git(path.join(dataDir, 'repos', ca.tid), 'log', '-1', '--format=%s'), /Glossary: one file per term \(3 terms\)/);
    });
    step('migration: proposals are never live', () => { assert.ok(!items.find((i) => i.id === 'glossary/_proposed/refund-window.md').pinned); });
  });
});
