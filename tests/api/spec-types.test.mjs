// Spec types: built-in and team-defined types, templates, the type of a spec, types as forms.
//   node --test tests/api/spec-types.test.mjs
import assert from 'node:assert/strict';
import { before, after, describe } from 'node:test';
import { useServer, makeUser, chain, mcpClient, call, Client } from '../helpers.mjs';

describe('spec types', () => {
  const ctx = useServer();
  const mcp = (token) => mcpClient(ctx.base, token);
  let admin, T1, uniq, viewer, tokA;
  before(async () => {
    ({ admin, T1, uniq } = ctx);
    viewer = await makeUser(ctx, 'viewer');
    tokA = (await admin.post('/api/me/tokens', { name: 'ctx', scopes: ['mcp:read'], teamId: T1 })).data.token;
  });

  describe('API spec, UI spec / design rule, feature spec, custom types', () => {
    const step = chain();
    let stUrl, types0, tid, r, cs, dItem;
    before(() => { stUrl = `/api/teams/${T1}/spec-types`; tid = `TY${uniq.toUpperCase()}`; });
    after(async () => { await cs?.close(); });
    step('every team has the built-in spec types, each with a starting template', async () => {
      types0 = (await admin.get(stUrl)).data.types;
      assert.deepEqual(types0.filter((t) => t.builtin).map((t) => t.key), ['feature', 'api', 'ui', 'data', 'nfr', 'integration', 'adr', 'architecture', 'mcp', 'permissions', 'security', 'config', 'lifecycle', 'runbook']);
      assert.match(types0.find((t) => t.key === 'api').template, /## ENDPOINTS/); assert.match(types0.find((t) => t.key === 'ui').label, /design rule/i);
    });
    step('only team admins define spec types', async () => { assert.equal((await viewer.c.post(stUrl, { label: 'Playbook', template: '## STEPS\n' })).status, 403); });
    step('a team defines its own spec type (key derived from the name)', async () => {
      const rb = await admin.post(stUrl, { label: 'Playbook', description: 'Operational procedure', template: '## TRIGGER\n\n## STEPS\n' });
      assert.equal(rb.status, 200); assert.equal(rb.data.type.key, 'playbook'); assert.equal(rb.data.type.builtin, false);
    });
    step('spec types are validated (unique, not shadowing built-ins, bounded)', async () => { assert.equal((await admin.post(stUrl, { label: 'Playbook' })).status, 409); assert.equal((await admin.post(stUrl, { label: 'API', key: 'api' })).status, 409); assert.equal((await admin.post(stUrl, { label: '' })).status, 400); assert.equal((await admin.post(stUrl, { label: 'Big', template: 'x'.repeat(20001) })).status, 400); });
    step('built-in types are read-only, custom ones editable', async () => { assert.equal((await admin.patch(`${stUrl}/api`, { label: 'Hacked' })).status, 403); assert.equal((await admin.patch(`${stUrl}/playbook`, { description: 'Ops procedure' })).data.type.description, 'Ops procedure'); });
    step('specs carry a type (default feature); unknown types are rejected; custom types work', async () => {
      assert.equal((await new Client(ctx.base).get(stUrl)).status, 401);
      r = await admin.push([{ id: `${tid}A`, kind: 'spec', baseRev: 0, fields: { title: 'Orders API', body: types0.find((t) => t.key === 'api').template, specType: 'api' } }, { id: `${tid}B`, kind: 'spec', baseRev: 0, fields: { title: 'Plain', body: 'x' } }, { id: `${tid}C`, kind: 'spec', baseRev: 0, fields: { title: 'Bad', body: 'x', specType: 'nope' } }, { id: `${tid}D`, kind: 'spec', baseRev: 0, fields: { title: 'Ops', body: 'x', specType: 'playbook' } }]);
      assert.equal(r[0].item.specType, 'api'); assert.equal(r[1].item.specType, 'feature'); assert.equal(r[2].status, 'error'); assert.match(r[2].message, /unknown spec type/); assert.equal(r[3].item.specType, 'playbook');
    });
    step('list_specs reports the type of every spec', async () => {
      r = await admin.push([{ id: `${tid}A`, kind: 'spec', baseRev: r[0].item.rev, approve: true, fields: {} }]);
      assert.equal(r[0].item.status, 'approved');
      cs = await mcp(tokA);
      const all = JSON.parse((await call(cs, 'list_specs')).text);
      const apiRow = all.find((x) => x.id === `${tid}A`);
      assert.equal(apiRow.type, 'api'); assert.equal(apiRow.type_label, 'API spec');
    });
    step('list_specs can filter by type', async () => {
      assert.deepEqual(JSON.parse((await call(cs, 'list_specs', { type: 'api' })).text).map((x) => x.id).filter((x) => x.startsWith(tid)), [`${tid}A`]);
      assert.equal(JSON.parse((await call(cs, 'list_specs', { type: 'ui' })).text).filter((x) => x.id.startsWith(tid)).length, 0);
    });
    step('the released spec carries its type in the front matter', async () => {
      assert.match((await call(cs, 'get_spec', { id: `${tid}A` })).text, /^---\nid: TY\w+A\ntype: api\n/);
      await cs.close(); cs = null;
    });
    step('a spec type that is in use cannot be deleted', async () => {
      dItem = (await admin.sync()).data.items.find((i) => i.id === `${tid}D`);
      assert.equal((await admin.del(`${stUrl}/playbook`)).status, 409);
    });
    step('after changing the specs’ type the custom type can be deleted', async () => {
      await admin.push([{ id: `${tid}D`, kind: 'spec', baseRev: dItem.rev, fields: { specType: 'ui' } }]);
      assert.equal((await admin.del(`${stUrl}/playbook`)).data.types.some((t) => t.key === 'playbook'), false);
    });
    step('the sync response carries the team’s spec types (offline use)', async () => {
      assert.ok((await admin.sync()).data.items.find((i) => i.id === `${tid}D`).specType === 'ui');
      const syncTypes = (await admin.sync()).data.specTypes; assert.ok(syncTypes.some((t) => t.key === 'api'));
    });
  });

  describe('spec types as forms', () => {
    const step = chain();
    let ftUrl, ft;
    before(() => { ftUrl = `/api/teams/${T1}/spec-types`; });
    step('built-in API / UI / NFR types are forms; the others stay free-form editor types', async () => {
      const apiType = (await admin.get(ftUrl)).data.types.find((t) => t.key === 'api');
      assert.equal(apiType.view, 'form'); assert.ok(apiType.form.fields.some((f) => f.kind === 'endpoints')); assert.deepEqual(apiType.form.tabs.map((t) => t.label), ['Overview', 'Endpoints', 'Contract', 'Quality']);
    });
    step('a team can define a form type (fields, tabs, default view); its template is derived from the fields', async () => {
      assert.equal((await admin.get(ftUrl)).data.types.find((t) => t.key === 'data').form.fields.length > 0, true);
      const mkForm = (extra) => admin.post(ftUrl, { label: 'Playbook form', description: 'x', view: 'form', form: { tabs: [{ key: 'a', label: 'Prepare' }, { key: 'b', label: 'Run' }], fields: [{ label: 'OWNER', kind: 'text' }, { label: 'PHASE', kind: 'select', options: 'Plan, Run', tab: 'b' }, { label: 'STEPS', kind: 'checklist', tab: 'b' }], ...extra } });
      ft = await mkForm({});
      assert.equal(ft.status, 200); assert.equal(ft.data.type.view, 'form'); assert.deepEqual(ft.data.type.form.fields.map((f) => f.key), ['owner', 'phase', 'steps']); assert.equal(ft.data.type.form.fields[1].options.length, 2); assert.match(ft.data.type.template, /## OWNER\n\n## PHASE\n\n## STEPS/);
    });
    step('invalid form schemas are rejected (unknown kind, duplicate label, select without choices, no fields)', async () => {
      assert.equal((await admin.post(ftUrl, { label: 'Bad A', form: { fields: [{ label: 'X', kind: 'nope' }] } })).status, 400);
      assert.equal((await admin.post(ftUrl, { label: 'Bad B', form: { fields: [{ label: 'X', kind: 'text' }, { label: 'x', kind: 'list' }] } })).status, 400);
      assert.equal((await admin.post(ftUrl, { label: 'Bad C', form: { fields: [{ label: 'X', kind: 'select' }] } })).status, 400);
      assert.equal((await admin.post(ftUrl, { label: 'Bad D', form: { fields: [] } })).status, 400);
    });
    step('a form can be removed again (type falls back to the editor)', async () => {
      const upT = await admin.patch(`${ftUrl}/${ft.data.type.key}`, { form: null }); assert.equal(upT.data.type.form, null); assert.equal(upT.data.type.view, 'editor');
      await admin.del(`${ftUrl}/${ft.data.type.key}`);
    });
    step('agents can read the form sections of each type (list_spec_types)', async () => {
      const ftU = await makeUser(ctx, 'viewer', 'ft'); const ftTok = (await ftU.c.post('/api/me/tokens', { name: 'ft', scopes: ['mcp:read'], teamId: T1 })).data; const tc = await mcp(ftTok.token); const lt = JSON.parse((await call(tc, 'list_spec_types')).text); await tc.close(); assert.ok(lt.find((t) => t.key === 'api').form.some((f) => f.section === '## ENDPOINTS' && f.kind === 'endpoints'));
    });
  });
});
