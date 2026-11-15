// MCP write access: agents write drafts and propose glossary terms, people approve.
//   node --test tests/api/mcp-drafts.test.mjs
import assert from 'node:assert/strict';
import { before, after, describe } from 'node:test';
import { useServer, makeUser, chain, mcpClient, call, toolNames } from '../helpers.mjs';

describe('agents write DRAFTS, people approve', () => {
  const ctx = useServer();
  const step = chain();
  const mcp = (token) => mcpClient(ctx.base, token);
  let admin, T1, viewer, agentEd, rdTok, w, created, dv, r;
  before(async () => {
    ({ admin, T1 } = ctx);
    viewer = await makeUser(ctx, 'viewer');
  });
  after(async () => {
    await w?.close();
  });

  step('viewer may not create a write token', async () => {
    assert.equal((await viewer.c.post('/api/me/tokens', { name: 'w', scopes: ['mcp:read', 'mcp:write'], teamId: T1 })).status, 403);
  });
  step('write tools exist only with the mcp:write scope; there is no approve/release tool', async () => {
    agentEd = await makeUser(ctx, 'editor', 'ag');
    const rdV = await makeUser(ctx, 'viewer', 'ag');
    rdTok = (await rdV.c.post('/api/me/tokens', { name: 'r', scopes: ['mcp:read'], teamId: T1 })).data;
    const wTok = (
      await agentEd.c.post('/api/me/tokens', { name: 'Claude Code', scopes: ['mcp:read', 'mcp:drafts', 'mcp:write'], teamId: T1 })
    ).data;
    w = await mcp(wTok.token);
    const wTools = await toolNames(w);
    for (const t of ['create_draft_spec', 'update_draft_spec', 'create_draft_document', 'update_draft_document'])
      assert.ok(wTools.includes(t), t);
    assert.ok(!wTools.some((t) => /approve|release|publish/.test(t)));
    const dTok2 = (await agentEd.c.post('/api/me/tokens', { name: 'd', scopes: ['mcp:read', 'mcp:drafts'], teamId: T1 })).data;
    const dc = await mcp(dTok2.token);
    assert.ok(!(await toolNames(dc)).includes('create_draft_spec'));
    await dc.close();
  });
  step('agent creates a draft spec (server assigns the id) and attribution is stored', async () => {
    created = JSON.parse(
      (
        await call(w, 'create_draft_spec', {
          title: 'Agent made',
          type: 'api',
          body: '# Agent made\n\n```endpoint GET /ping\nHealth check\n```\n',
        })
      ).text,
    );
    assert.match(created.id, /-\d{3}$/);
    assert.equal(created.status, 'draft');
    const items0 = (await agentEd.c.sync([], 0)).data.items;
    assert.equal(items0.find((x) => x.id === created.id).updatedVia.includes('Claude Code'), true);
  });
  step('drafts stay invisible to released-only readers', async () => {
    let c0;
    assert.equal(
      JSON.parse((await call((c0 = await mcp(rdTok.token)), 'list_specs')).text).some((x) => x.id === created.id),
      false,
    );
    await c0.close();
  });
  step('unknown spec type / missing documents are refused', async () => {
    assert.equal((await call(w, 'create_draft_spec', { title: 'x', type: 'nope', body: 'b' })).isError, true);
    assert.equal((await call(w, 'create_draft_spec', { title: 'x', body: 'b', documents: ['missing.md'] })).isError, true);
  });
  step('update with a stale base_rev is rejected', async () => {
    const updW = JSON.parse((await call(w, 'update_draft_spec', { id: created.id, body: '# v2', base_rev: created.rev })).text);
    assert.equal(updW.rev, created.rev + 1);
    assert.match((await call(w, 'update_draft_spec', { id: created.id, body: 'stale', base_rev: created.rev })).text, /Conflict/);
  });
  step('agents can write documents but never the foundation documents', async () => {
    const dA1 = JSON.parse((await call(w, 'create_draft_document', { path: 'adr/agent-note.md', body: 'Note' })).text);
    assert.equal(dA1.status, 'draft');
    assert.equal((await call(w, 'update_draft_document', { path: 'vision.md', body: 'hijack' })).isError, true);
    assert.equal((await call(w, 'create_draft_document', { path: 'vision.md', body: 'x' })).isError, true);
  });
  step('agents cannot write into the glossary folder: they propose terms', async () => {
    assert.match((await call(w, 'create_draft_document', { path: 'glossary/x.md', body: 'x' })).text, /propose_term/);
  });

  // derive glossary entries and specs from a document
  step('derive_from_document needs the write scope', async () => {
    await call(w, 'create_draft_document', {
      path: 'notes/payments.md',
      body: 'Retries of one run are grouped. Attempt window is a bucket; Settlement run is the nightly batch.',
    });
    assert.ok(!(await toolNames(await mcp(rdTok.token))).includes('derive_from_document'));
  });
  step('a prompt guides the derivation', async () => {
    assert.ok((await w.listPrompts()).prompts.some((p) => p.name === 'derive_glossary_and_specs'));
  });
  step('derive_from_document proposes terms (one file each), skips known terms and creates spec drafts', async () => {
    dv = JSON.parse(
      (
        await call(w, 'derive_from_document', {
          source: 'notes/payments.md',
          glossary: [
            {
              term: 'Settlement run',
              definition: 'The nightly batch that books payments.',
              aliases: ['nightly run'],
              see_also: ['Attempt window'],
            },
            { term: 'Attempt window', definition: 'Dup of a released term.' },
            { term: 'Batch cut-off', definition: 'Latest time a payment joins the run.' },
          ],
          specs: [{ title: 'Nightly settlement', body: 'R1 Payments are booked once per night.\n- [ ] Run is idempotent' }],
        })
      ).text,
    );
    assert.deepEqual(dv.glossary.proposed.sort(), ['glossary/_proposed/batch-cut-off.md', 'glossary/_proposed/settlement-run.md']);
    assert.deepEqual(dv.glossary.added.sort(), ['Batch cut-off', 'Settlement run']);
    assert.equal(dv.glossary.exists[0].term, 'Attempt window');
    assert.match(dv.specs[0].id, /-\d{3}$/);
    assert.deepEqual(dv.specs[0].documents, []);
  });
  step('a proposed term carries who proposed it and its source; specs carry a source section', async () => {
    const dvDoc = (await call(w, 'get_document', { name: 'glossary/_proposed/settlement-run.md', draft: true })).text;
    assert.match(
      dvDoc,
      /^---\nterm: "Settlement run"\naliases: \["nightly run"\]\nsee: \["Attempt window"\]\nproposed_by: "[^"]+"\nfrom: "notes\/payments\.md"\n---\n\nThe nightly batch that books payments\.\n$/,
    );
    assert.match((await call(w, 'get_spec', { id: dv.specs[0].id, draft: true })).text, /## SOURCE\n\nDerived from `notes\/payments\.md`/);
  });
  step('a second call updates the proposal of the same term instead of duplicating it', async () => {
    const dv2 = JSON.parse(
      (
        await call(w, 'derive_from_document', {
          source: 'notes/payments.md',
          glossary: [
            { term: 'Settlement run', definition: 'Better wording.' },
            { term: 'Ledger lock', definition: 'Blocks writes.' },
          ],
        })
      ).text,
    );
    assert.deepEqual(dv2.glossary.updated, ['Settlement run']);
    assert.deepEqual(dv2.glossary.added, ['Ledger lock']);
  });
  step('propose_term adds one proposal and refuses known terms and synonyms', async () => {
    const pt = JSON.parse(
      (
        await call(w, 'propose_term', {
          term: 'Payout batch',
          definition: 'All payouts of one day.\n\n- created at 18:00',
          folder: 'Payments',
        })
      ).text,
    );
    assert.equal(pt.proposed, 'glossary/_proposed/payout-batch.md');
    assert.equal(JSON.parse((await call(w, 'propose_term', { term: 'Retry window', definition: 'x' })).text).refused, 'already defined');
  });
  step('proposed terms never reach agents before an approver accepts them', async () => {
    assert.ok(!JSON.parse((await call(w, 'get_glossary')).text).some((g) => g.term === 'Payout batch'));
  });
  step('unknown source / empty derivation are refused', async () => {
    assert.equal((await call(w, 'derive_from_document', { source: 'nope.md', glossary: [{ term: 'X', definition: 'y' }] })).isError, true);
    assert.equal((await call(w, 'derive_from_document', { source: 'notes/payments.md' })).isError, true);
  });

  // human approves the agent's draft
  step('a person releases the agent draft', async () => {
    const agentAp = await makeUser(ctx, 'approver', 'ag');
    const curA = (await agentEd.c.sync([], 0)).data.items.find((x) => x.id === created.id);
    r = await agentAp.c.push([{ id: created.id, kind: 'spec', baseRev: curA.rev, approve: true, fields: {} }]);
    assert.equal(r[0].item.status, 'approved');
  });
  step('an agent edit of a relA spec leaves the relA version untouched', async () => {
    const relA = await mcp(rdTok.token);
    assert.match((await call(relA, 'get_spec', { id: created.id })).text, /# v2/);
    await relA.close();
    await call(w, 'update_draft_spec', { id: created.id, body: '# v3 by agent' });
    const rdA = await mcp(rdTok.token);
    assert.match((await call(rdA, 'get_spec', { id: created.id })).text, /# v2/);
    await rdA.close();
  });
  step('a human edit clears the agent attribution', async () => {
    const curB = (await agentEd.c.sync([], 0)).data.items.find((x) => x.id === created.id);
    r = await agentEd.c.push([{ id: created.id, kind: 'spec', baseRev: curB.rev, fields: { body: '# human edit' } }]);
    assert.equal(r[0].item.updatedVia, null);
    await w.close();
    w = null;
  });

  // role downgrade kills write instantly
  step('write tools disappear when the role is downgraded', async () => {
    const wrk = await makeUser(ctx, 'editor', 'w2');
    const wtk = (await wrk.c.post('/api/me/tokens', { name: 'w', scopes: ['mcp:read', 'mcp:drafts', 'mcp:write'], teamId: T1 })).data;
    assert.equal((await admin.req('PATCH', `/api/teams/${T1}/members/${wrk.id}`, { role: 'viewer' })).status, 200);
    const wcl = await mcp(wtk.token);
    const wnames = await toolNames(wcl);
    await wcl.close();
    assert.ok(!wnames.includes('create_draft_spec') && !wnames.includes('get_spec') === false);
  });
});
