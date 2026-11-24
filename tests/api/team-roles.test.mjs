// Users and per-team roles, team isolation, folders with move/delete rules, released files in Git, personal MCP tokens, the Git connection per team.
// One ordered suite: every section builds on the spec, documents, users and teams of the sections before it.
//   node --test tests/api/team-roles.test.mjs
import assert from 'node:assert/strict';
import { before, after, describe } from 'node:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { useServer, makeUser, chain, mcpClient, call, toolNames, hasParam, scratch, git, missing } from '../helpers.mjs';

describe('users, roles, releases and the Git connection', () => {
  const ctx = useServer({ GIT_ALLOW_LOCAL: '1', MAX_TEAMS_PER_USER: '2' });
  const step = chain();
  const mcp = (token) => mcpClient(ctx.base, token);
  let admin, me, T1, uniq, viewer, editor, approver, t2, r;
  let id, doc, newSpec, newDoc, moved, readTok, draftTok;

  before(async () => {
    ({ admin, T1, uniq } = ctx);
    me = admin.me;
    viewer = await makeUser(ctx, 'viewer');
    editor = await makeUser(ctx, 'editor');
    approver = await makeUser(ctx, 'approver');
    id = `T${uniq.toUpperCase()}`;
    doc = `adr/${id}-adr.md`;
    const bodyMd =
      '## GOAL\nx\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nIdempotency key\n: A token that makes a request safe to repeat.\n';
    newSpec = { id, kind: 'spec', baseRev: 0, fields: { title: 'Role test', body: bodyMd, links: [doc] } };
    newDoc = {
      id: doc,
      kind: 'doc',
      baseRev: 0,
      fields: { title: doc, body: '# Decision\nUse keys.\n\nAttempt window\n: The time bucket of a retry.\n' },
    };
  });

  describe('users and per-team roles', () => {
    step('only instance admins manage users', async () => {
      assert.equal((await editor.c.get('/api/users')).status, 403);
    });
    step('duplicate e-mail rejected', async () => {
      assert.equal((await admin.post('/api/users', { email: `viewer-${uniq}@example.com`, password: 'password-x' })).status, 409);
    });
    step('viewer cannot write', async () => {
      r = await viewer.c.push([newDoc]);
      assert.equal(r[0].status, 'error');
      assert.equal(r[0].forbidden, true);
    });
    step('viewer can read', async () => {
      assert.ok((await viewer.c.sync()).data.items.some((i) => i.id === 'SPEC-012'));
    });
    step('editor can write drafts (document in a folder)', async () => {
      r = await editor.c.push([newDoc, newSpec]);
      assert.deepEqual(
        r.map((x) => x.status),
        ['applied', 'applied'],
      );
    });
    step('editor cannot approve', async () => {
      r = await editor.c.push([{ id, kind: 'spec', baseRev: r[1].item.rev, approve: true, fields: {} }]);
      assert.equal(r[0].forbidden, true);
    });
    step('approver can release', async () => {
      const rev = (await approver.c.sync()).data.items.find((i) => i.id === id).rev;
      r = await approver.c.push([{ id, kind: 'spec', baseRev: rev, approve: true, fields: {} }]);
      assert.equal(r[0].item.status, 'approved');
      assert.equal(r[0].item.releasedBy, 'approver user');
    });
    step('the released versions of a spec are listed from its Git tags', async () => {
      const v = await approver.c.get(`/api/teams/${T1}/versions?spec=${encodeURIComponent(id)}`);
      assert.equal(v.status, 200);
      assert.equal(v.data.versions.length, 1);
      assert.equal(v.data.versions[0].version, 1);
      assert.equal(v.data.versions[0].tag, `${id}/v1`);
      assert.equal(v.data.versions[0].by, 'approver user');
      assert.equal((await approver.c.get(`/api/teams/${T1}/versions?spec=${encodeURIComponent('*')}`)).status, 400);
    });
  });

  describe('team isolation', () => {
    let inv0;
    step('team keys are unique', async () => {
      t2 = (await admin.post('/api/teams', { name: 'Payments', key: 'PAY' })).data.team;
      assert.equal((await admin.post('/api/teams', { name: 'Dup', key: 'pay' })).status, 409);
    });
    step('non-members cannot see another team', async () => {
      assert.equal((await editor.c.sync([], 0, t2.id)).status, 404);
    });
    step('items are scoped to their team', async () => {
      await admin.push([{ id: 'PAY-001', kind: 'spec', baseRev: 0, fields: { title: 'Payments only', body: 'secret' } }], t2.id);
      assert.ok(!(await editor.c.sync()).data.items.some((i) => i.id === 'PAY-001'));
    });
    step('inviting an existing user shows the invitation in their account', async () => {
      inv0 = (await admin.post(`/api/teams/${t2.id}/invites`, { email: `editor-${uniq}@example.com`, role: 'viewer' })).data;
      assert.ok(inv0.userExists);
      assert.equal((await editor.c.get('/api/me')).data.me.invites.length, 1);
    });
    step('roles are per team (editor in team 1, viewer in team 2)', async () => {
      assert.equal((await editor.c.post(`/api/me/invites/${inv0.invite.id}/accept`)).status, 200);
      assert.equal((await editor.c.push([{ id: 'PAY-002', kind: 'spec', baseRev: 0, fields: { title: 'x' } }], t2.id))[0].forbidden, true);
    });
    step('only team admins invite members', async () => {
      assert.equal((await editor.c.get(`/api/teams/${T1}/members`)).status, 200);
      assert.equal((await editor.c.post(`/api/teams/${T1}/invites`, { email: 'a@b.c', role: 'viewer' })).status, 403);
    });
  });

  describe('folders, move/delete rules, glossary', () => {
    let dRev, sRev, repoDir;
    step('path traversal in document paths rejected', async () => {
      await editor.c
        .push([
          { id: '../evil.md', kind: 'doc', baseRev: 0, fields: { body: 'x' } },
          { id: 'a/../../x.md', kind: 'doc', baseRev: 0, fields: { body: 'x' } },
          { id: '/abs.md', kind: 'doc', baseRev: 0, fields: { body: 'x' } },
        ])
        .then((rs) =>
          assert.deepEqual(
            rs.map((x) => x.status),
            ['error', 'error', 'error'],
          ),
        );
    });
    step('a document used by a released spec cannot be deleted', async () => {
      const items = (await approver.c.sync()).data.items;
      dRev = items.find((i) => i.id === doc).rev;
      r = await editor.c.push([{ id: doc, kind: 'doc', baseRev: dRev, delete: true }]);
      assert.equal(r[0].status, 'error');
      assert.match(r[0].message, /still used by released spec/);
    });
    step('an editor cannot delete a released spec', async () => {
      sRev = (await approver.c.sync()).data.items.find((i) => i.id === id).rev;
      assert.match((await editor.c.push([{ id, kind: 'spec', baseRev: sRev, delete: true }]))[0].message, /revoke it before deleting/);
    });
    step('an approver can delete a released spec (revoked automatically)', async () => {
      const tmp = 'SPEC-899';
      let q = await approver.c.push([{ id: tmp, kind: 'spec', baseRev: 0, fields: { title: 'Temp' }, approve: true }]);
      assert.equal(q[0].item.status, 'approved');
      q = await approver.c.push([{ id: tmp, kind: 'spec', baseRev: q[0].item.rev, delete: true }]);
      assert.equal(q[0].status, 'applied');
      assert.equal(q[0].deleted, true);
    });

    // move = create at new path + relink + delete old; released snapshot is tidied on the next release
    step('moving a document (create + relink + delete) works in one batch', async () => {
      moved = 'decisions/records/' + id + '-adr.md';
      r = await editor.c.push([
        { id: doc, kind: 'doc', baseRev: dRev, delete: true },
        { id, kind: 'spec', baseRev: sRev, fields: { links: [moved] } },
        {
          id: moved,
          kind: 'doc',
          baseRev: 0,
          fields: { title: moved, body: '# Decision\nUse keys.\n\nAttempt window\n: The time bucket of a retry.\n' },
        },
      ]);
      assert.deepEqual(
        r.map((x) => x.status),
        ['applied', 'applied', 'applied'],
      );
    });
    let pulled;
    step('deleted items arrive as tombstones', async () => {
      pulled = (await approver.c.sync()).data.items;
      assert.ok(pulled.some((i) => i.id === doc && i.deleted));
    });
    step('re-release writes the new folder path and removes the orphaned old file', async () => {
      const rev2 = pulled.find((i) => i.id === id).rev;
      r = await approver.c.push([{ id, kind: 'spec', baseRev: rev2, approve: true, fields: {} }]);
      assert.equal(r[0].item.version, 2);
      repoDir = `${ctx.srv.dir}/repos/${T1}`;
      assert.ok(existsSync(`${repoDir}/specs/docs/${moved}`));
      assert.ok(!existsSync(`${repoDir}/specs/docs/${doc}`));
    });
    step('GLOSSARY.md is generated from definition blocks of released files', async () => {
      const gl = readFileSync(`${repoDir}/specs/GLOSSARY.md`, 'utf8');
      assert.match(gl, /## Idempotency key/);
      assert.match(gl, /## Attempt window/);
      assert.match(gl, /_Source: [^_]*_/);
    });
  });

  describe('personal MCP tokens (bound to a team)', () => {
    step('viewer may not create a drafts token', async () => {
      assert.equal((await viewer.c.post('/api/me/tokens', { name: 'x', scopes: ['mcp:drafts'], teamId: T1 })).status, 403);
    });
    step('tokens can only be created for teams you belong to', async () => {
      assert.equal((await viewer.c.post('/api/me/tokens', { name: 'x', scopes: ['mcp:read'], teamId: t2.id })).status, 403);
    });
    step('token is shown once, only its prefix is listed afterwards', async () => {
      readTok = (await viewer.c.post('/api/me/tokens', { name: 'laptop', scopes: ['mcp:read'], teamId: T1 })).data;
      assert.match(readTok.token, /^spc_/);
      assert.equal(readTok.pat.teamName, 'specs');
      const list0 = (await viewer.c.get('/api/me/tokens')).data;
      assert.ok(!JSON.stringify(list0).includes(readTok.token));
      draftTok = (await editor.c.post('/api/me/tokens', { name: 'drafts', scopes: ['mcp:read', 'mcp:drafts'], teamId: T1 })).data;
    });

    let c;
    after(async () => {
      await c?.close();
    });
    step('read token: no draft parameters exposed', async () => {
      c = await mcp(readTok.token);
      assert.deepEqual(await toolNames(c), [
        'get_criteria',
        'get_document',
        'get_glossary',
        'get_guardrails',
        'get_image',
        'get_spec',
        'get_spec_changes',
        'get_team_context',
        'get_work_list',
        'list_checks',
        'list_decisions',
        'list_documents',
        'list_reports',
        'list_spec_types',
        'list_specs',
      ]);
      assert.equal(await hasParam(c, 'list_specs', 'include_drafts'), false);
    });
    step('agent receives released spec incl. mermaid block', async () => {
      assert.ok(JSON.parse((await call(c, 'list_specs')).text).find((s) => s.id === id && s.approved_by === 'approver user'));
      assert.match((await call(c, 'get_spec', { id })).text, /```mermaid\nflowchart LR/);
    });
    step('get_document works with folder paths', async () => {
      assert.match((await call(c, 'get_document', { name: moved })).text, /Use keys/);
    });
    step('list_documents can filter by folder and flags foundation documents', async () => {
      const docsList = JSON.parse((await call(c, 'list_documents', { folder: 'decisions' })).text);
      assert.deepEqual(docsList, [{ path: moved, always: false }]);
    });
    step('get_glossary returns terms with sources', async () => {
      const glossary = JSON.parse((await call(c, 'get_glossary')).text);
      assert.ok(glossary.find((g) => g.term === 'Attempt window' && g.definition.startsWith('The time bucket')));
      assert.equal(JSON.parse((await call(c, 'get_glossary', { term: 'idempot' })).text).length >= 1, true);
    });
    step('MCP is scoped to the token’s team', async () => {
      assert.ok(!JSON.stringify(JSON.parse((await call(c, 'list_specs')).text)).includes('PAY-001'));
    });

    step('read token sees only the released version', async () => {
      const cur = (await editor.c.sync()).data.items.find((i) => i.id === id);
      await editor.c.push([{ id, kind: 'spec', baseRev: cur.rev, fields: { title: 'Role test', body: 'WORKING COPY' } }]);
      assert.doesNotMatch((await call(c, 'get_spec', { id })).text, /WORKING COPY/);
      await c.close();
      c = null;
    });
    step('drafts token can read the working copy', async () => {
      const c = await mcp(draftTok.token);
      assert.match((await call(c, 'get_spec', { id, draft: true })).text, /WORKING COPY/);
      await c.close();
    });

    step('downgrading a role in the team downgrades its tokens immediately', async () => {
      assert.equal((await admin.patch(`/api/teams/${T1}/members/${editor.id}`, { role: 'viewer' })).status, 200);
      const c = await mcp(draftTok.token);
      assert.equal(await hasParam(c, 'get_spec', 'draft'), false);
      await c.close();
    });
    step('removing a member kills that member’s tokens for the team', async () => {
      assert.equal((await admin.del(`/api/teams/${T1}/members/${editor.id}`)).status, 200);
      await assert.rejects(async () => (await mcp(draftTok.token)).listTools());
      const reinv = (await admin.post(`/api/teams/${T1}/invites`, { email: editor.email, role: 'editor' })).data;
      await editor.c.post(`/api/me/invites/${reinv.invite.id}/accept`);
    });

    step('admin can revoke another user’s token', async () => {
      const theirs = (await admin.get(`/api/users/${viewer.id}/tokens`)).data.tokens;
      assert.equal((await admin.del(`/api/users/${viewer.id}/tokens/${theirs[0].id}`)).data.ok, true);
      await assert.rejects(async () => (await mcp(readTok.token)).listTools());
    });
    step('disabled user loses session', async () => {
      assert.equal((await admin.patch(`/api/users/${approver.id}`, { disabled: true })).status, 200);
      assert.equal((await approver.c.get('/api/me')).status, 401);
    });
    step('last instance admin cannot be demoted', async () => {
      assert.equal((await admin.patch(`/api/users/${me.id}`, { admin: false })).status, 400);
    });
    step('a team keeps at least one team admin', async () => {
      const onlyAdminTeam = await admin.patch(`/api/teams/${t2.id}/members/${me.id}`, { role: 'viewer' });
      assert.equal(onlyAdminTeam.status, 400);
    });
  });

  describe('Git connection per team', { skip: missing('git') }, () => {
    let tmp, remote, dev, gitUrl;
    before(() => {
      tmp = scratch('specs-remote-');
      remote = path.join(tmp, 'remote.git');
      git(tmp, 'init', '--bare', '-b', 'main', remote);
      // a dev repo with existing history that the remote already contains
      dev = path.join(tmp, 'dev');
      git(tmp, 'clone', remote, dev);
      git(dev, 'config', 'user.email', 'dev@x');
      git(dev, 'config', 'user.name', 'Dev');
      writeFileSync(path.join(dev, 'README.md'), '# the product\n');
      git(dev, 'add', '.');
      git(dev, 'commit', '-m', 'init');
      git(dev, 'push', 'origin', 'HEAD:main');
      gitUrl = `/api/teams/${T1}/git`;
    });

    step('only team admins may edit the git connection', async () => {
      assert.equal((await viewer.c.req('PUT', gitUrl, { url: remote })).status, 403);
    });
    step('dangerous or unsupported remote URLs are rejected', async () => {
      const bad = async (url) => (await admin.req('PUT', gitUrl, { url, branch: 'main', root: 'specs', auth: 'none' })).status;
      for (const u of [
        '--upload-pack=touch /tmp/pwn',
        'ext::sh -c id',
        'file:///etc',
        'http://insecure.example/x.git',
        'git@host:org/r.git x',
      ])
        assert.equal(await bad(u), 400, u);
    });
    step('folder path traversal rejected', async () => {
      assert.equal((await admin.req('PUT', gitUrl, { url: remote, branch: 'main', root: '../x', auth: 'none' })).status, 400);
    });
    step('token auth needs an https URL', async () => {
      assert.equal(
        (await admin.req('PUT', gitUrl, { url: remote, branch: 'main', root: 'specs', auth: 'token', username: 'x', token: 'tok' })).status,
        400,
      );
    });
    step('team admin saves the git connection', async () => {
      r = await admin.req('PUT', gitUrl, { url: remote, branch: 'main', root: 'specs', auth: 'none', autoPush: false });
      assert.equal(r.status, 200);
      assert.equal(r.data.git.url, remote);
    });
    step('folder is locked once specs were released', async () => {
      assert.ok(!JSON.stringify((await admin.get(`/api/teams/${T1}`)).data).includes('secret'));
      assert.equal((await admin.req('PUT', gitUrl, { url: remote, branch: 'main', root: 'other', auth: 'none' })).status, 409);
    });
    step('test connection reaches the remote', async () => {
      const test = (await admin.post(`${gitUrl}/test`)).data;
      assert.equal(test.ok, true);
      assert.equal(test.branchExists, true);
    });
    step('push needs the approve right', async () => {
      assert.equal((await viewer.c.post(`${gitUrl}/push`)).status, 403);
    });
    step('push merges into the existing dev repository and keeps its files', async () => {
      const pushed = await admin.post(`${gitUrl}/push`);
      assert.equal(pushed.status, 200, JSON.stringify(pushed.data));
      git(dev, 'pull', 'origin', 'main');
      assert.ok(
        existsSync(path.join(dev, 'README.md')) &&
          existsSync(path.join(dev, 'specs', `${id}.md`)) &&
          existsSync(path.join(dev, 'specs', 'GLOSSARY.md')),
      );
      assert.ok(existsSync(path.join(dev, 'specs', 'docs', moved)));
    });
    step('version tags are pushed too', async () => {
      assert.match(git(remote, 'tag', '-l'), new RegExp(`${id}/v2`));
    });
    step('approvals are pushed automatically', async () => {
      await admin.req('PUT', gitUrl, { url: remote, branch: 'main', root: 'specs', auth: 'none', autoPush: true });
      const s12 = (await admin.sync()).data.items.find((i) => i.id === 'SPEC-012');
      await admin.push([{ id: 'SPEC-012', kind: 'spec', baseRev: s12.rev, fields: { body: s12.body + '\nR3 auto pushed\n' } }]);
      const rv = (await admin.sync()).data.items.find((i) => i.id === 'SPEC-012').rev;
      await admin.push([{ id: 'SPEC-012', kind: 'spec', baseRev: rv, approve: true, fields: {} }]);
      for (let i = 0; i < 30; i++) {
        git(dev, 'pull', '-q', 'origin', 'main');
        if (/auto pushed/.test(readFileSync(path.join(dev, 'specs', 'SPEC-012.md'), 'utf8'))) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      assert.match(readFileSync(path.join(dev, 'specs', 'SPEC-012.md'), 'utf8'), /auto pushed/);
    });
    // a colleague edits a released spec straight in the remote: that text was never approved here and must not reach agents
    step('edits made in the remote below the managed folder do not reach agents; other files merge in', async () => {
      git(dev, 'pull', '-q', 'origin', 'main');
      const f12 = path.join(dev, 'specs', 'SPEC-012.md');
      writeFileSync(f12, readFileSync(f12, 'utf8') + '\nREMOTE-ONLY-EDIT\n');
      writeFileSync(path.join(dev, 'NOTES.md'), 'dev notes\n');
      git(dev, 'add', '.');
      git(dev, 'commit', '-m', 'edit in the remote');
      git(dev, 'push', '-q', 'origin', 'HEAD:main');
      const mp = await admin.post(`${gitUrl}/push`);
      assert.equal(mp.status, 200, JSON.stringify(mp.data));
      const teamRepo = `${ctx.srv.dir}/repos/${T1}`;
      assert.ok(!readFileSync(path.join(teamRepo, 'specs', 'SPEC-012.md'), 'utf8').includes('REMOTE-ONLY-EDIT'));
      assert.ok(existsSync(path.join(teamRepo, 'NOTES.md')));
    });
    step('push status is recorded', async () => {
      const st = (await admin.get(`/api/teams/${T1}`)).data.team.git;
      assert.equal(st.lastOk, true);
      assert.ok(st.lastPushAt && st.lastSha);
    });
    // a second team has its own, independent repository / connection
    step('teams have independent git connections', async () => {
      assert.equal((await admin.get(`/api/teams/${t2.id}`)).data.team.git.url, '');
    });
    // failing push is reported without leaking and without crashing
    step('a failing push is reported and recorded', async () => {
      await admin.req('PUT', gitUrl, {
        url: path.join(tmp, 'does-not-exist.git'),
        branch: 'main',
        root: 'specs',
        auth: 'none',
        autoPush: false,
      });
      const failed = await admin.post(`${gitUrl}/push`);
      assert.ok(failed.status >= 400 && failed.data.error);
      assert.equal((await admin.get(`/api/teams/${T1}`)).data.team.git.lastOk, false);
    });
    step('git tokens are write-only and encrypted at rest', async () => {
      assert.equal(
        (
          await admin.req('PUT', gitUrl, {
            url: 'https://git.example/org/repo.git',
            branch: 'main',
            root: 'specs',
            auth: 'token',
            username: 'bot',
            token: 'ghp_SECRET123',
          })
        ).status,
        200,
      );
      const shown = JSON.stringify((await admin.get(`/api/teams/${T1}`)).data);
      assert.ok(!shown.includes('ghp_SECRET123') && shown.includes('"hasSecret":true'));
      assert.ok(!readFileSync(`${ctx.srv.dir}/specs.db`).includes('ghp_SECRET123'));
    });
    step(
      'server generates an SSH deploy key per team',
      async () => {
        const key = await admin.post(`${gitUrl}/ssh-key`);
        assert.equal(key.status, 200);
        assert.match(key.data.publicKey, /^ssh-ed25519 /);
        assert.ok(!JSON.stringify((await admin.get(`/api/teams/${T1}`)).data).includes('PRIVATE'));
      },
      { skip: missing('ssh-keygen') },
    );
    step('git commit is authored by the approver', async () => {
      assert.match(git(`${ctx.srv.dir}/repos/${T1}`, 'log', '--format=%an|%s', '--no-merges', '-n', '8'), /approver user\|Release /);
    });
  });
});
