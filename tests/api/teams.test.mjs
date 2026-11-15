// A team of one's own: foundation documents (vision, strategy, guardrails), folders, invitations, team limits, leaving and deleting teams and users.
// One ordered suite: everything happens in the team the editor creates in the first test.
//   node --test tests/api/teams.test.mjs
import assert from 'node:assert/strict';
import { before, after, describe } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { useServer, makeUser, chain, mcpClient, call, sleep, Client } from '../helpers.mjs';
import { formatTermFile } from '../../shared/glossaryFiles.js';

describe('teams of their own, foundation documents and invitations', () => {
  const ctx = useServer({ FOUNDATION_DEBOUNCE_MS: '150', MAX_TEAMS_PER_USER: '2' });
  const step = chain();
  const mcp = (token) => mcpClient(ctx.base, token);
  const ctxTool = async (token) => { const cl = await mcp(token); const out = await call(cl, 'get_team_context'); await cl.close(); return out.text; };
  let admin, uniq, viewer, editor, own, own2, lab, labDocs, labTok, r;
  before(async () => {
    ({ admin, uniq } = ctx);
    viewer = await makeUser(ctx, 'viewer'); editor = await makeUser(ctx, 'editor');
  });

  step('any user can create their own team (key derived from the name) and becomes its team admin', async () => {
    own = await editor.c.post('/api/teams', { name: 'Editor Lab' });
    assert.equal(own.status, 200); assert.match(own.data.team.key, /^[A-Z0-9]{2,8}$/); assert.equal(own.data.team.role, 'admin');
  });

  describe('foundation documents: vision, strategy, glossary', () => {
    step('every new team starts with vision, strategy and guardrails (the glossary is a folder of term files)', async () => {
      own2 = (await editor.c.get('/api/teams')).data.teams.find((x) => x.name === 'Editor Lab');
      lab = new Client(ctx.base); lab.cookie = editor.c.cookie; lab.tid = own2.id;
      labDocs = (await lab.sync()).data.items.filter((i) => i.kind === 'doc');
      assert.deepEqual(labDocs.map((d) => d.id).sort(), ['guardrails.md', 'strategy.md', 'vision.md']); assert.ok(labDocs.every((d) => d.pinned && d.core));
    });
    step('empty foundation documents are not served (template-only = empty)', async () => {
      labTok = (await editor.c.post('/api/me/tokens', { name: 'lab', scopes: ['mcp:read'], teamId: own2.id })).data.token;
      assert.match(await ctxTool(labTok), /Nothing has been written down yet/);
    });
    step('a foundation document goes live automatically after the edit – no spec, no link, no approval', async () => {
      const vis = labDocs.find((d) => d.id === 'vision.md');
      r = await lab.push([{ id: 'vision.md', kind: 'doc', baseRev: vis.rev, fields: { body: '# Vision\n\n## Where are we heading?\nBe the calmest billing system there is.\n' } }]);
      assert.equal(r[0].status, 'applied');
      await sleep(700);
      const ctx1 = await ctxTool(labTok);
      assert.match(ctx1, /calmest billing system/);
    });
    let cl2;
    after(async () => { await cl2?.close(); });
    step('a term file under glossary/ is pinned by the server (a foundation document)', async () => {
      const dun = await lab.push([
        { id: 'glossary/Billing', kind: 'folder', baseRev: 0, fields: {} },
        { id: 'glossary/Billing/dunning.md', kind: 'doc', baseRev: 0, fields: { title: 'dunning', body: formatTermFile({ term: 'Dunning', avoid: ['reminder run'], distinct: ['Retry budget'], body: 'Reminding customers about **unpaid** invoices.\n\n- step 1: e-mail\n- step 2: letter' }) } },
      ]);
      assert.equal(dun[1].item.pinned, true);
    });
    step('get_glossary returns the full Markdown definition, words to avoid, distinctions and the folder', async () => {
      await sleep(700);
      cl2 = await mcp(labTok);
      const lg = JSON.parse((await call(cl2, 'get_glossary')).text);
      assert.deepEqual(lg.map((g) => g.term), ['Dunning']); assert.match(lg[0].definition, /- step 2: letter/); assert.deepEqual(lg[0].avoid, ['reminder run']); assert.deepEqual(lg[0].not_to_be_confused_with, ['Retry budget']); assert.equal(lg[0].folder, 'Billing'); assert.equal(lg[0].source, 'glossary/Billing/dunning.md');
    });
    step('get_team_context lists each term with its first paragraph and the words to avoid', async () => {
      const labCtx = await ctxTool(labTok);
      assert.match(labCtx, /\*\*Dunning\*\*: Reminding customers about unpaid invoices\. — do not say: reminder run/); assert.doesNotMatch(labCtx, /step 2/);
    });
    step('the term file is released to docs/glossary/<folder>/ and GLOSSARY.md carries the full definition', async () => {
      const labRepo = `${ctx.srv.dir}/repos/${own2.id}`;
      assert.ok(existsSync(`${labRepo}/specs/docs/glossary/Billing/dunning.md`)); assert.match(readFileSync(`${labRepo}/specs/GLOSSARY.md`, 'utf8'), /- step 1: e-mail[\s\S]*Avoid: reminder run/);
    });
    step('the history of a term is the Git log of its file', async () => {
      const hist = await lab.get(`/api/teams/${own2.id}/doc-history?path=${encodeURIComponent('glossary/Billing/dunning.md')}`);
      assert.equal(hist.status, 200); assert.equal(hist.data.history.length, 1); assert.match(hist.data.history[0].message, /glossary\/Billing\/dunning\.md/);
    });
    step('the glossary is queryable via MCP without being linked to any spec; foundation docs are flagged "always"', async () => {
      const lst = JSON.parse((await call(cl2, 'list_documents')).text);
      assert.ok(lst.find((d) => d.path === 'vision.md' && d.always === true));
      await cl2.close(); cl2 = null;
    });
    step('foundation documents cannot be deleted', async () => {
      assert.equal((await lab.push([{ id: 'vision.md', kind: 'doc', baseRev: (await lab.sync()).data.items.find((i) => i.id === 'vision.md').rev, delete: true }]))[0].status, 'error');
    });
    // custom foundation doc via pin; unpin withdraws it
    step('any document can be pinned as a foundation document', async () => {
      await lab.push([{ id: 'principles.md', kind: 'doc', baseRev: 0, fields: { title: 'p', body: '# Principles\nPrefer boring technology.\n', pinned: true } }]);
      await sleep(700);
      assert.match(await ctxTool(labTok), /Prefer boring technology/);
    });
    step('unpinning withdraws it from the agent context', async () => {
      const pr = (await lab.sync()).data.items.find((i) => i.id === 'principles.md');
      await lab.push([{ id: 'principles.md', kind: 'doc', baseRev: pr.rev, fields: { pinned: false } }]);
      assert.doesNotMatch(await ctxTool(labTok), /Prefer boring technology/);
    });
    // team admin can switch auto release off -> only explicit approval publishes
    step('with auto-release off a foundation document needs an explicit approval', async () => {
      assert.equal((await editor.c.req('PATCH', `/api/teams/${own2.id}`, { foundationAuto: false })).status, 200);
      const st0 = (await lab.sync()).data.items.find((i) => i.id === 'strategy.md');
      await lab.push([{ id: 'strategy.md', kind: 'doc', baseRev: st0.rev, fields: { body: '# Strategy\n\n## Goals\nZero double charges.\n' } }]);
      await sleep(700);
      assert.doesNotMatch(await ctxTool(labTok), /Zero double charges/);
      const st1 = (await lab.sync()).data.items.find((i) => i.id === 'strategy.md');
      assert.equal((await lab.push([{ id: 'strategy.md', kind: 'doc', baseRev: st1.rev, approve: true, fields: {} }]))[0].item.status, 'approved');
      assert.match(await ctxTool(labTok), /Zero double charges/);
    });
  });

  describe('folders are first-class objects', () => {
    let fold;
    step('empty folders can be created', async () => {
      r = await lab.push([{ id: 'adr', kind: 'folder', baseRev: 0, fields: {} }, { id: 'adr/2026', kind: 'folder', baseRev: 0, fields: {} }]);
      assert.deepEqual(r.map((x) => x.status), ['applied', 'applied']);
    });
    step('folder path traversal rejected', async () => { assert.equal((await lab.push([{ id: '../x', kind: 'folder', baseRev: 0, fields: {} }]))[0].status, 'error'); });
    step('a folder with content cannot be deleted', async () => {
      fold = (await lab.sync()).data.items.find((i) => i.id === 'adr');
      assert.match((await lab.push([{ id: 'adr', kind: 'folder', baseRev: fold.rev, delete: true }]))[0].message, /not empty/);
    });
    step('empty folders can be deleted (children first)', async () => {
      const f2 = (await lab.sync()).data.items.find((i) => i.id === 'adr/2026');
      r = await lab.push([{ id: 'adr/2026', kind: 'folder', baseRev: f2.rev, delete: true }, { id: 'adr', kind: 'folder', baseRev: fold.rev, delete: true }]);
      assert.deepEqual(r.map((x) => x.status), ['applied', 'applied']);
    });
  });

  describe('invitations for new people, teams, user management', () => {
    let token, pub, reg1, inv3, editorUser;
    step('invitation link shows team and role before any sign-in', async () => {
      const inv = (await editor.c.post(`/api/teams/${own2.id}/invites`, { email: `newbie-${uniq}@example.com`, role: 'editor' })).data;
      assert.equal(inv.userExists, false); assert.match(inv.link, /#\/invite\/inv_/);
      token = inv.link.split('/invite/')[1];
      pub = new Client(ctx.base);
      const info = await pub.get(`/api/invites/${token}`);
      assert.equal(info.status, 200); assert.equal(info.data.invite.teamName, 'Editor Lab'); assert.equal(info.data.invite.userExists, false);
    });
    step('registering through an invitation enforces a password', async () => { assert.equal((await pub.post(`/api/invites/${token}/accept`, { name: 'Newbie', password: 'short' })).status, 400); });
    step('a new person creates their account from the invitation and joins with the invited role', async () => {
      reg1 = await pub.post(`/api/invites/${token}/accept`, { name: 'Newbie', password: 'newbie-pass-1' });
      assert.equal(reg1.status, 200); assert.equal(reg1.data.me.teams[0].role, 'editor'); assert.equal(reg1.data.me.teams[0].name, 'Editor Lab');
    });
    step('an invitation link works only once', async () => { assert.equal((await new Client(ctx.base).get(`/api/invites/${token}`)).status, 404); });
    step('team admins see members and pending invitations', async () => {
      assert.equal((await pub.get('/api/me')).status, 200);
      assert.equal(reg1.data.me.admin, false); assert.equal((await pub.get('/api/users')).status, 403);
      const pending = (await editor.c.get(`/api/teams/${own2.id}/members`)).data;
      assert.equal(pending.invites.length, 0); assert.ok(pending.members.some((m) => m.email === `newbie-${uniq}@example.com`));
    });
    step('pending invitations can be revoked', async () => {
      const inv2 = (await editor.c.post(`/api/teams/${own2.id}/invites`, { email: `x-${uniq}@example.com`, role: 'viewer' })).data;
      assert.equal((await editor.c.del(`/api/teams/${own2.id}/invites/${inv2.invite.id}`)).data.invites.length, 0); assert.equal((await new Client(ctx.base).get(`/api/invites/${inv2.link.split('/invite/')[1]}`)).status, 404);
    });
    step('members cannot be invited twice', async () => { assert.equal((await editor.c.post(`/api/teams/${own2.id}/invites`, { email: `newbie-${uniq}@example.com`, role: 'viewer' })).status, 409); });
    // decline + wrong person
    step('only the invited person can accept', async () => {
      inv3 = (await editor.c.post(`/api/teams/${own2.id}/invites`, { email: viewer.email, role: 'viewer' })).data;
      assert.equal((await editor.c.post(`/api/me/invites/${inv3.invite.id}/accept`)).status, 403);
    });
    step('invitations can be declined', async () => { assert.equal((await viewer.c.post(`/api/me/invites/${inv3.invite.id}/decline`)).data.ok, true); assert.equal((await viewer.c.get('/api/me')).data.me.invites.length, 0); });
    // team limit + leave
    step('team creation per user is limited', async () => {
      assert.equal((await editor.c.post('/api/teams', { name: 'Second' })).status, 200);
      assert.equal((await editor.c.post('/api/teams', { name: 'Third' })).status, 403);
    });
    step('members can leave a team', async () => { assert.equal((await pub.post(`/api/teams/${own2.id}/leave`)).status, 200); assert.equal((await pub.get('/api/me')).data.me.teams.length, 0); });
    step('the last team admin cannot leave', async () => { assert.equal((await editor.c.post(`/api/teams/${own2.id}/leave`)).status, 400); });
    // instance admin: teams overview, delete user / team
    step('instance admin sees all teams', async () => {
      const adm = (await admin.get('/api/admin/teams')).data.teams;
      assert.ok(adm.find((x) => x.name === 'Editor Lab' && x.members >= 1));
    });
    step('a user who is the only team admin cannot be deleted', async () => {
      editorUser = (await admin.get('/api/users')).data.users.find((x) => x.email === editor.email);
      assert.equal((await admin.del(`/api/users/${editorUser.id}`)).status, 409);
    });
    step('only instance admins delete teams, with key confirmation', async () => {
      assert.equal((await admin.req('DELETE', `/api/teams/${own2.id}`, { confirmKey: 'nope' })).status, 400);
      assert.equal((await editor.c.req('DELETE', `/api/teams/${own2.id}`, { confirmKey: own2.key })).status, 403);
    });
    step('deleting a team removes it', async () => {
      assert.equal((await admin.req('DELETE', `/api/teams/${own2.id}`, { confirmKey: own2.key })).status, 200);
      assert.equal((await admin.get('/api/admin/teams')).data.teams.some((x) => x.id === own2.id), false);
    });
    step('deleting a team kills its MCP tokens', async () => { await assert.rejects(async () => (await mcp(labTok)).listTools()); });
    step('instance admin can delete a user (their sessions end)', async () => {
      const t3 = (await editor.c.get('/api/teams')).data.teams.find((x) => x.name === 'Second');
      await admin.req('DELETE', `/api/teams/${t3.id}`, { confirmKey: t3.key });
      assert.equal((await admin.del(`/api/users/${editorUser.id}`)).status, 200); assert.equal((await editor.c.get('/api/me')).status, 401);
    });
  });
});
