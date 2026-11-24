// Sharing between teams (docs/SHARED-SPECS.md): the team tree with inherited foundation, foundation versions and required rules,
// sharing documents, folders and specs with named teams, pinned @KEY/…@vN links, implements and the rollup, feedback routed to the
// owner, adopting a copy, ending shares and links.
//   node --test tests/api/sharing.test.mjs
import assert from 'node:assert/strict';
import { before, describe } from 'node:test';
import { useServer, chain, mcpClient, call, sleep, Client } from '../helpers.mjs';
import { formatTermFile } from '../../shared/glossaryFiles.js';
import { formatRuleFile } from '../../shared/guardrailFiles.js';

describe('sharing between teams', () => {
  const ctx = useServer({ FOUNDATION_DEBOUNCE_MS: '100' });
  const step = chain();
  const teams = {};
  const as = (key) => {
    const c = new Client(ctx.base);
    c.cookie = ctx.admin.cookie;
    c.tid = teams[key].id;
    return c;
  };
  const sharingOf = async (key) => (await as(key).get(`/api/teams/${teams[key].id}/sharing`)).data.sharing;
  const token = async (key, scopes = ['mcp:read', 'mcp:drafts', 'mcp:write']) =>
    (await ctx.admin.post('/api/me/tokens', { name: `agent ${key}`, scopes, teamId: teams[key].id })).data.token;
  const tool = async (key, name, args = {}) => {
    const cl = await mcpClient(ctx.base, await token(key));
    const out = await call(cl, name, args);
    await cl.close();
    return out;
  };
  const items = async (key) => (await as(key).sync()).data.items;
  const item = async (key, id) => (await items(key)).find((i) => i.id === id);
  /** waits until the debounced foundation release has run and a new foundation version exists */
  const foundationAt = async (key, version) => {
    for (let i = 0; i < 60; i++) {
      const v = (await sharingOf(key)).foundationVersion;
      if (v >= version) return v;
      await sleep(100);
    }
    throw new Error(`${key} did not reach foundation v${version}`);
  };
  const rule = (rule, kind, extra = {}) => formatRuleFile({ rule, kind, ...extra });

  before(async () => {
    for (const [key, name] of [
      ['ACME', 'Acme company'],
      ['PLAT', 'Platform'],
      ['API', 'Payments API'],
      ['WEB', 'Web shop'],
    ]) {
      const r = await ctx.admin.post('/api/teams', { name, key });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      teams[key] = r.data.team;
    }
  });

  step('a parent team writes its foundation: every release is a foundation version', async () => {
    const acme = as('ACME');
    const vis = await item('ACME', 'vision.md');
    const r = await acme.push([
      { id: 'vision.md', kind: 'doc', baseRev: vis.rev, fields: { body: '# Vision\n\nEvery shop on earth takes payments with us.\n' } },
      {
        id: 'guardrails/cards.md',
        kind: 'doc',
        fields: { title: 'guardrails/cards.md', body: rule('Never store card numbers.', 'never') },
      },
      { id: 'glossary', kind: 'folder' },
      {
        id: 'glossary/customer.md',
        kind: 'doc',
        fields: { title: 'glossary/customer.md', body: formatTermFile({ term: 'Customer', body: 'Someone who pays.', avoid: ['client'] }) },
      },
    ]);
    assert.ok(
      r.every((x) => x.status === 'applied'),
      JSON.stringify(r),
    );
    assert.equal(await foundationAt('ACME', 1), 1);
  });

  step('the parent asks a team to be its child; until the child accepts nothing is inherited', async () => {
    const r = await as('ACME').post(`/api/teams/${teams.ACME.id}/children`, { key: 'PLAT' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.sharing.links.outgoing[0].team.key, 'PLAT');
    const plat = await sharingOf('PLAT');
    assert.equal(plat.links.incoming[0].team.key, 'ACME');
    assert.equal(plat.parent, null);
    assert.deepEqual(plat.inherited, []);
  });

  step('the child accepts: it inherits the parent foundation, pinned to its current version', async () => {
    const r = await as('PLAT').post(`/api/teams/${teams.PLAT.id}/parent/${teams.ACME.id}/accept`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const s = r.data.sharing;
    assert.equal(s.parent.key, 'ACME');
    assert.equal(s.inherited[0].pinned, 1);
    assert.deepEqual(
      s.inherited[0].rules.map((x) => [x.ref, x.text]),
      [['ACME/G1', 'Never store card numbers.']],
    );
    assert.equal(s.inherited[0].terms[0].term, 'Customer');
  });

  step('agents of the child get the layered context: parent vision, ACME/G1 and the parent glossary', async () => {
    const out = (await tool('PLAT', 'get_team_context')).text;
    assert.match(out, /Inherits ACME foundation v1/);
    assert.match(out, /vision\.md of parent team ACME/);
    assert.match(out, /Every shop on earth/);
    assert.match(out, /- ACME\/G1: Never store card numbers\./);
    assert.match(out, /\*\*Customer\*\*.*do not say: client.*from ACME/);
    const g = JSON.parse((await tool('PLAT', 'get_guardrails', { id: 'ACME/G1' })).text);
    assert.equal(g[0].from_parent_team, 'ACME');
  });

  step('a new parent rule waits for the child approver; a rule required by a past date applies right away', async () => {
    await as('ACME').push([
      { id: 'guardrails/logs.md', kind: 'doc', fields: { title: 'guardrails/logs.md', body: rule('All services log in JSON.', 'always') } },
      {
        id: 'guardrails/tls.md',
        kind: 'doc',
        fields: { title: 'guardrails/tls.md', body: rule('Always use TLS 1.3.', 'always', { requiredBy: '2020-01-01' }) },
      },
    ]);
    await foundationAt('ACME', 2);
    const inh = (await sharingOf('PLAT')).inherited[0];
    assert.equal(inh.pinned, 1);
    assert.equal(inh.update.version, 2);
    assert.deepEqual(inh.update.changes.map((c) => [c.id, c.change]).sort(), [
      ['guardrails/logs.md', 'added'],
      ['guardrails/tls.md', 'added'],
    ]);
    const refs = inh.rules.map((x) => x.text);
    assert.ok(refs.includes('Always use TLS 1.3.'), 'the required rule applies');
    assert.ok(!refs.includes('All services log in JSON.'), 'the other one waits');
    assert.deepEqual(inh.forced, ['G3']);
  });

  step('the child approver looks at the diff and accepts the new foundation version', async () => {
    const d = await as('PLAT').get(`/api/teams/${teams.PLAT.id}/foundation/${teams.ACME.id}/diff?from=1&to=2`);
    assert.equal(d.data.changes.length, 2);
    const r = await as('PLAT').post(`/api/teams/${teams.PLAT.id}/foundation/${teams.ACME.id}/accept`, { version: 2 });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const inh = r.data.sharing.inherited[0];
    assert.equal(inh.pinned, 2);
    assert.equal(inh.update, null);
    assert.deepEqual(inh.forced, []);
    assert.equal(inh.rules.length, 3);
  });

  step('a team owns a document and shares its folder with a named team, which accepts once', async () => {
    const api = as('API');
    const r = await api.push([
      { id: 'api', kind: 'folder' },
      {
        id: 'api/payments.yaml',
        kind: 'doc',
        fields: { title: 'api/payments.yaml', body: 'openapi: 3.1.0\ninfo: { title: Payments, version: 1 }\n' },
      },
      {
        id: 'API-001',
        kind: 'spec',
        fields: { title: 'Payments API', body: '## Goal\nTake payments.\n', links: ['api/payments.yaml'] },
        approve: true,
      },
    ]);
    assert.ok(
      r.every((x) => x.status === 'applied'),
      JSON.stringify(r),
    );
    const s = await api.post(`/api/teams/${teams.API.id}/shares`, { itemId: 'api', audience: 'teams', teams: ['WEB'] });
    assert.equal(s.status, 200, JSON.stringify(s.data));
    assert.equal(s.data.share.teams[0].key, 'WEB');
    assert.equal(s.data.share.teams[0].accepted, false);
    let web = await sharingOf('WEB');
    assert.equal(web.sharedWith[0].accepted, false);
    assert.deepEqual(web.sharedWith[0].items, [], 'nothing to read before accepting');
    const a = await as('WEB').post(`/api/teams/${teams.WEB.id}/shared/answer`, { owner: teams.API.id, itemId: 'api', accept: true });
    assert.equal(a.status, 200, JSON.stringify(a.data));
    web = a.data.sharing;
    assert.deepEqual(
      web.sharedWith[0].items.map((i) => [i.id, i.newest]),
      [['api/payments.yaml', 1]],
    );
  });

  step('agents of the receiving team list and read the shared document; feedback is refused for items not shared', async () => {
    const list = JSON.parse((await tool('WEB', 'list_documents')).text);
    assert.ok(list.find((d) => d.path === '@API/api/payments.yaml' && d.shared && d.newest_version === 1));
    assert.match((await tool('WEB', 'get_document', { name: '@API/api/payments.yaml' })).text, /openapi: 3\.1\.0/);
    const no = await tool('PLAT', 'get_document', { name: '@API/api/payments.yaml' });
    assert.ok(no.isError);
    assert.match(no.text, /has not shared/);
  });

  step('a spec links the shared document; approving it pins the newest version', async () => {
    const r = await as('WEB').push([
      {
        id: 'WEB-104',
        kind: 'spec',
        fields: { title: 'Checkout', body: '## Goal\nPay.\n', links: ['@API/api/payments.yaml'] },
        approve: true,
      },
    ]);
    assert.equal(r[0].status, 'applied', JSON.stringify(r));
    assert.deepEqual(r[0].item.links, ['@API/api/payments.yaml@v1']);
    const spec = (await tool('WEB', 'get_spec', { id: 'WEB-104' })).text;
    assert.match(spec, /- "@API\/api\/payments\.yaml@v1"/);
    const mine = (await sharingOf('API')).shares[0];
    assert.deepEqual(
      mine.usedBy.map((u) => [u.team.key, u.specId, u.version]),
      [['WEB', 'WEB-104', 1]],
    );
  });

  step('the owner releases a new version: the receiving team sees it, its link stays on v1', async () => {
    const api = as('API');
    const doc = await item('API', 'api/payments.yaml');
    const spec = await item('API', 'API-001');
    await api.push([
      {
        id: 'api/payments.yaml',
        kind: 'doc',
        baseRev: doc.rev,
        fields: { body: 'openapi: 3.1.0\ninfo: { title: Payments, version: 2 }\n' },
      },
      { id: 'API-001', kind: 'spec', baseRev: spec.rev, fields: { body: '## Goal\nTake payments, v2.\n' }, approve: true },
    ]);
    let web;
    for (let i = 0; i < 30; i++) {
      web = await sharingOf('WEB');
      if (web.sharedWith[0].items[0].newest === 2) break;
      await sleep(100);
    }
    assert.equal(web.sharedWith[0].items[0].newest, 2);
    assert.match((await tool('WEB', 'get_document', { name: '@API/api/payments.yaml' })).text, /version: 1 }/, 'pinned version');
    assert.match((await tool('WEB', 'get_document', { name: '@API/api/payments.yaml', version: 2 })).text, /version: 2 }/);
    const one = await as('WEB').get(`/api/teams/${teams.WEB.id}/shared/item?ref=${encodeURIComponent('@API/api/payments.yaml@v1')}`);
    assert.equal(one.data.item.version, 1);
    assert.equal(one.data.item.newest, 2);
    assert.deepEqual(
      one.data.versions.map((v) => v.version),
      [2, 1],
    );
  });

  step('a spec of another team is shared; a spec that implements it rolls up at the owner', async () => {
    const plat = as('PLAT');
    await plat.push([
      {
        id: 'PLAT-012',
        kind: 'spec',
        fields: { title: 'Checkout v2', body: '## Acceptance criteria\n- Pay in one click\n- Receipt by mail\n' },
        approve: true,
      },
    ]);
    await plat.post(`/api/teams/${teams.PLAT.id}/shares`, { itemId: 'PLAT-012', audience: 'teams', teams: ['WEB'] });
    await as('WEB').post(`/api/teams/${teams.WEB.id}/shared/answer`, { owner: teams.PLAT.id, itemId: 'PLAT-012', accept: true });
    const created = JSON.parse(
      (
        await tool('WEB', 'create_draft_spec', {
          title: 'Checkout in the web shop',
          body: '## Acceptance criteria\n- One-click button (→ @PLAT/PLAT-012#AC1)\n- Mail sent (→ AC2)\n',
          implements: '@PLAT/PLAT-012',
        })
      ).text,
    );
    assert.equal(created.implements, '@PLAT/PLAT-012@v1');
    const wspec = await item('WEB', created.id);
    const r = await as('WEB').push([{ id: created.id, kind: 'spec', baseRev: wspec.rev, approve: true }]);
    assert.equal(r[0].status, 'applied', JSON.stringify(r));
    const rep = await tool('WEB', 'report_implementation', {
      spec_id: created.id,
      status: 'implemented',
      summary: 'Built.',
      criteria: [
        { id: 'AC1', status: 'met' },
        { id: 'AC2', status: 'met' },
      ],
    });
    assert.ok(!rep.isError, rep.text);
    const impl = (await sharingOf('PLAT')).implementedBy['PLAT-012'];
    assert.equal(impl.rows[0].team.key, 'WEB');
    assert.equal(impl.rows[0].report.status, 'implemented');
    assert.deepEqual(
      impl.rows[0].criteria.map((c) => [c.owner, c.own, c.status]),
      [
        ['AC1', 'AC1', 'met'],
        ['AC2', 'AC2', 'met'],
      ],
    );
    assert.equal(impl.done, true);
  });

  step('feedback and questions on a shared spec go to the owner, labelled with the asking team', async () => {
    const f = await tool('WEB', 'add_feedback', { spec_id: '@PLAT/PLAT-012', kind: 'question', text: 'Which mail provider?' });
    assert.ok(!f.isError, f.text);
    const fb = (await as('PLAT').get(`/api/teams/${teams.PLAT.id}/feedback?spec=PLAT-012`)).data.feedback;
    assert.equal(fb[0].fromTeam.key, 'WEB');
    const d = await tool('WEB', 'request_decision', {
      spec_id: '@PLAT/PLAT-012',
      question: 'Card or wallet first?',
      options: ['Card', 'Wallet'],
    });
    assert.ok(!d.isError, d.text);
    const mine = JSON.parse((await tool('WEB', 'list_decisions')).text);
    assert.ok(mine.find((x) => x.spec === '@PLAT/PLAT-012' && x.question === 'Card or wallet first?'));
  });

  step('a team adopts a shared document as its own copy', async () => {
    const r = await as('WEB').post(`/api/teams/${teams.WEB.id}/adopt`, { ref: '@API/api/payments.yaml@v2', as: 'vendor/payments.yaml' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.item.origin, 'API/api/payments.yaml@2');
    assert.match(r.data.item.body, /version: 2 }/);
  });

  step('the owner stops sharing: the pinned version keeps working, newer ones do not', async () => {
    await as('API').post(`/api/teams/${teams.API.id}/shares/remove`, { itemId: 'api' });
    assert.match((await tool('WEB', 'get_document', { name: '@API/api/payments.yaml@v1' })).text, /version: 1 }/);
    const v2 = await tool('WEB', 'get_document', { name: '@API/api/payments.yaml@v2' });
    assert.ok(v2.isError);
  });

  step('ending the parent link: nothing is inherited any more', async () => {
    const r = await as('PLAT').post(`/api/teams/${teams.PLAT.id}/parent/unlink`);
    assert.equal(r.status, 200);
    assert.equal(r.data.sharing.parent, null);
    assert.deepEqual(r.data.sharing.inherited, []);
    assert.doesNotMatch((await tool('PLAT', 'get_team_context')).text, /ACME/);
  });

  step('the tree has no circles and at most four levels', async () => {
    await ctx.admin.post(`/api/admin/teams/${teams.PLAT.id}/parent`, { parentId: teams.ACME.id });
    await ctx.admin.post(`/api/admin/teams/${teams.API.id}/parent`, { parentId: teams.PLAT.id });
    const circle = await ctx.admin.post(`/api/admin/teams/${teams.ACME.id}/parent`, { parentId: teams.API.id });
    assert.equal(circle.status, 400);
    assert.match(circle.data.error, /circle/);
    await ctx.admin.post(`/api/admin/teams/${teams.WEB.id}/parent`, { parentId: teams.API.id });
    const extra = await ctx.admin.post('/api/teams', { name: 'Too deep', key: 'DEEP' });
    const deep = await ctx.admin.post(`/api/admin/teams/${extra.data.team.id}/parent`, { parentId: teams.WEB.id });
    assert.equal(deep.status, 400);
    assert.match(deep.data.error, /4 levels/);
  });

  step('the global glossary moves into the root team, and its children inherit it', async () => {
    await ctx.admin.post('/api/glossary/global', { term: 'Merchant', definition: 'A shop that sells with us.' });
    const r = await ctx.admin.post('/api/admin/global-glossary/to-team', { teamId: teams.ACME.id });
    assert.ok(r.data.terms >= 1, JSON.stringify(r.data));
    for (let i = 0; i < 40; i++) {
      const inh = (await sharingOf('PLAT')).inherited[0];
      if (inh.update) break;
      await sleep(100);
    }
    await as('PLAT').post(`/api/teams/${teams.PLAT.id}/foundation/${teams.ACME.id}/accept`, {});
    const g = JSON.parse((await tool('PLAT', 'get_glossary', { term: 'merchant' })).text);
    assert.equal(g[0].from_parent_team, 'ACME');
  });
});
