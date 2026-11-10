// Backend integration test: sessions, teams + roles, folders, glossary, personal MCP tokens, OAuth 2.1 for MCP, Git per team.
//   node tests/api.test.mjs            (starts its own server)
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer, Client, startSmtpSink } from './helpers.mjs';
import { parseGlossaryFile } from '../shared/glossaryImport.js';

const tmp = mkdtempSync(path.join(process.env.TEST_TMP || tmpdir(), 'specs-remote-'));
const smtp = await startSmtpSink();
const srv = await startServer({ GIT_ALLOW_LOCAL: '1', FOUNDATION_DEBOUNCE_MS: '150', MAX_TEAMS_PER_USER: '2', SMTP_URL: `smtp://127.0.0.1:${smtp.port}`, SMTP_FROM: 'Specs <specs@example.test>' });
const BASE = srv.base;
const uniq = Date.now().toString(36);
let n = 0;
const ok = (m) => console.log(`ok ${++n} - ${m}`);
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });

const mcp = async (token) => {
  const c = new McpClient({ name: 'test', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return c;
};
const call = async (c, name, args = {}) => { const r = await c.callTool({ name, arguments: args }); return { text: r.content[0].text, isError: !!r.isError }; };
const toolNames = async (c) => (await c.listTools()).tools.map((t) => t.name).sort();
const hasParam = async (c, tool, p) => !!(await c.listTools()).tools.find((t) => t.name === tool).inputSchema.properties?.[p];

try {
  // ---------------------------------------------------------------- authentication
  const anon = new Client(BASE);
  assert.equal((await anon.get('/api/me')).status, 401); ok('api requires a session');
  assert.equal((await anon.post('/api/auth/login', { email: 'admin@localhost', password: 'wrong-password' })).status, 401); ok('wrong password rejected');
  assert.equal((await anon.req('POST', '/api/auth/login', { email: 'admin@localhost', password: 'adminpass1' }, { 'x-specs': '0' })).status, 403); ok('login without CSRF header rejected');
  const admin = new Client(BASE);
  const me = await admin.login('admin@localhost', 'adminpass1');
  assert.equal(me.admin, true); assert.equal(me.teams.length, 1); assert.equal(me.teams[0].role, 'admin'); ok('instance admin signs in and sees the default team');
  const T1 = admin.tid;

  // ---------------------------------------------------------------- users + per-team roles
  const mk = async (role, tag = '', team = T1) => {
    const email = `${role}${tag}-${uniq}@example.com`;
    const r = await admin.post('/api/users', { email, name: `${role} user`, password: 'password-' + role, teamId: team, role });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const c = new Client(BASE); await c.login(email, 'password-' + role);
    return { c, id: r.data.user.id, email };
  };
  const viewer = await mk('viewer'); const editor = await mk('editor'); const approver = await mk('approver');
  assert.equal((await editor.c.get('/api/users')).status, 403); ok('only instance admins manage users');
  assert.equal((await admin.post('/api/users', { email: `viewer-${uniq}@example.com`, password: 'password-x' })).status, 409); ok('duplicate e-mail rejected');

  const id = `T${uniq.toUpperCase()}`; const doc = `adr/${id}-adr.md`;
  const bodyMd = '## GOAL\nx\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nIdempotency key\n: A token that makes a request safe to repeat.\n';
  const newSpec = { id, kind: 'spec', baseRev: 0, fields: { title: 'Role test', body: bodyMd, links: [doc] } };
  const newDoc = { id: doc, kind: 'doc', baseRev: 0, fields: { title: doc, body: '# Decision\nUse keys.\n\nAttempt window\n: The time bucket of a retry.\n' } };

  let r = await viewer.c.push([newDoc]);
  assert.equal(r[0].status, 'error'); assert.equal(r[0].forbidden, true); ok('viewer cannot write');
  assert.ok((await viewer.c.sync()).data.items.some((i) => i.id === 'SPEC-012')); ok('viewer can read');
  r = await editor.c.push([newDoc, newSpec]);
  assert.deepEqual(r.map((x) => x.status), ['applied', 'applied']); ok('editor can write drafts (document in a folder)');
  r = await editor.c.push([{ id, kind: 'spec', baseRev: r[1].item.rev, approve: true, fields: {} }]);
  assert.equal(r[0].forbidden, true); ok('editor cannot approve');
  const rev = (await approver.c.sync()).data.items.find((i) => i.id === id).rev;
  r = await approver.c.push([{ id, kind: 'spec', baseRev: rev, approve: true, fields: {} }]);
  assert.equal(r[0].item.status, 'approved'); assert.equal(r[0].item.releasedBy, 'approver user'); ok('approver can release');

  // ---------------------------------------------------------------- team isolation
  const t2 = (await admin.post('/api/teams', { name: 'Payments', key: 'PAY' })).data.team;
  const own = await editor.c.post('/api/teams', { name: 'Editor Lab' });
  assert.equal(own.status, 200); assert.match(own.data.team.key, /^[A-Z0-9]{2,8}$/); assert.equal(own.data.team.role, 'admin'); ok('any user can create their own team (key derived from the name) and becomes its team admin');
  assert.equal((await admin.post('/api/teams', { name: 'Dup', key: 'pay' })).status, 409); ok('team keys are unique');
  assert.equal((await editor.c.sync([], 0, t2.id)).status, 404); ok('non-members cannot see another team');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await admin.push([{ id: 'PAY-001', kind: 'spec', baseRev: 0, fields: { title: 'Payments only', body: 'secret' } }], t2.id);
  assert.ok(!(await editor.c.sync()).data.items.some((i) => i.id === 'PAY-001')); ok('items are scoped to their team');
  const inv0 = (await admin.post(`/api/teams/${t2.id}/invites`, { email: `editor-${uniq}@example.com`, role: 'viewer' })).data;
  assert.ok(inv0.userExists); assert.equal((await editor.c.get('/api/me')).data.me.invites.length, 1); ok('inviting an existing user shows the invitation in their account');
  assert.equal((await editor.c.post(`/api/me/invites/${inv0.invite.id}/accept`)).status, 200);
  assert.equal((await editor.c.push([{ id: 'PAY-002', kind: 'spec', baseRev: 0, fields: { title: 'x' } }], t2.id))[0].forbidden, true); ok('roles are per team (editor in team 1, viewer in team 2)');
  assert.equal((await editor.c.get(`/api/teams/${T1}/members`)).status, 200);
  assert.equal((await editor.c.post(`/api/teams/${T1}/invites`, { email: 'a@b.c', role: 'viewer' })).status, 403); ok('only team admins invite members');

  // ---------------------------------------------------------------- folders, move/delete rules, glossary
  await editor.c.push([{ id: '../evil.md', kind: 'doc', baseRev: 0, fields: { body: 'x' } }, { id: 'a/../../x.md', kind: 'doc', baseRev: 0, fields: { body: 'x' } }, { id: '/abs.md', kind: 'doc', baseRev: 0, fields: { body: 'x' } }])
    .then((rs) => assert.deepEqual(rs.map((x) => x.status), ['error', 'error', 'error'])); ok('path traversal in document paths rejected');
  const items = (await approver.c.sync()).data.items;
  const dRev = items.find((i) => i.id === doc).rev;
  r = await editor.c.push([{ id: doc, kind: 'doc', baseRev: dRev, delete: true }]);
  assert.equal(r[0].status, 'error'); assert.match(r[0].message, /still used by released spec/); ok('a document used by a released spec cannot be deleted');
  const sRev = (await approver.c.sync()).data.items.find((i) => i.id === id).rev;
  assert.match((await editor.c.push([{ id, kind: 'spec', baseRev: sRev, delete: true }]))[0].message, /revoke it before deleting/); ok('a released spec cannot be deleted');

  // move = create at new path + relink + delete old; released snapshot is tidied on the next release
  const moved = 'decisions/records/' + id + '-adr.md';
  r = await editor.c.push([
    { id: doc, kind: 'doc', baseRev: dRev, delete: true },
    { id, kind: 'spec', baseRev: sRev, fields: { links: [moved] } },
    { id: moved, kind: 'doc', baseRev: 0, fields: { title: moved, body: '# Decision\nUse keys.\n\nAttempt window\n: The time bucket of a retry.\n' } },
  ]);
  assert.deepEqual(r.map((x) => x.status), ['applied', 'applied', 'applied']); ok('moving a document (create + relink + delete) works in one batch');
  const pulled = (await approver.c.sync()).data.items;
  assert.ok(pulled.some((i) => i.id === doc && i.deleted)); ok('deleted items arrive as tombstones');
  const rev2 = pulled.find((i) => i.id === id).rev;
  r = await approver.c.push([{ id, kind: 'spec', baseRev: rev2, approve: true, fields: {} }]);
  assert.equal(r[0].item.version, 2);
  const repoDir = `${srv.dir}/repos/${T1}`;
  assert.ok(existsSync(`${repoDir}/specs/docs/${moved}`)); assert.ok(!existsSync(`${repoDir}/specs/docs/${doc}`)); ok('re-release writes the new folder path and removes the orphaned old file');
  const gl = readFileSync(`${repoDir}/specs/GLOSSARY.md`, 'utf8');
  assert.match(gl, /## Idempotency key/); assert.match(gl, /## Attempt window/); assert.match(gl, /_Source: [^_]*_/); ok('GLOSSARY.md is generated from definition blocks of released files');

  // ---------------------------------------------------------------- personal MCP tokens (bound to a team)
  assert.equal((await viewer.c.post('/api/me/tokens', { name: 'x', scopes: ['mcp:drafts'], teamId: T1 })).status, 403); ok('viewer may not create a drafts token');
  assert.equal((await viewer.c.post('/api/me/tokens', { name: 'x', scopes: ['mcp:read'], teamId: t2.id })).status, 403); ok('tokens can only be created for teams you belong to');
  const readTok = (await viewer.c.post('/api/me/tokens', { name: 'laptop', scopes: ['mcp:read'], teamId: T1 })).data;
  assert.match(readTok.token, /^spc_/); assert.equal(readTok.pat.teamName, 'specs');
  const list0 = (await viewer.c.get('/api/me/tokens')).data;
  assert.ok(!JSON.stringify(list0).includes(readTok.token)); ok('token is shown once, only its prefix is listed afterwards');
  const draftTok = (await editor.c.post('/api/me/tokens', { name: 'drafts', scopes: ['mcp:read', 'mcp:drafts'], teamId: T1 })).data;

  let c0; let c = await mcp(readTok.token);
  assert.deepEqual(await toolNames(c), ['get_document', 'get_glossary', 'get_spec', 'get_team_context', 'list_documents', 'list_spec_types', 'list_specs']);
  assert.equal(await hasParam(c, 'list_specs', 'include_drafts'), false); ok('read token: no draft parameters exposed');
  assert.ok(JSON.parse((await call(c, 'list_specs')).text).find((s) => s.id === id && s.approved_by === 'approver user'));
  assert.match((await call(c, 'get_spec', { id })).text, /```mermaid\nflowchart LR/); ok('agent receives released spec incl. mermaid block');
  assert.match((await call(c, 'get_document', { name: moved })).text, /Use keys/); ok('get_document works with folder paths');
  const docsList = JSON.parse((await call(c, 'list_documents', { folder: 'decisions' })).text);
  assert.deepEqual(docsList, [{ path: moved, always: false }]); ok('list_documents can filter by folder and flags foundation documents');
  const glossary = JSON.parse((await call(c, 'get_glossary')).text);
  assert.ok(glossary.find((g) => g.term === 'Attempt window' && g.definition.startsWith('The time bucket')));
  assert.equal(JSON.parse((await call(c, 'get_glossary', { term: 'idempot' })).text).length >= 1, true); ok('get_glossary returns terms with sources');
  assert.ok(!JSON.stringify(JSON.parse((await call(c, 'list_specs')).text)).includes('PAY-001')); ok('MCP is scoped to the token’s team');

  const cur = (await editor.c.sync()).data.items.find((i) => i.id === id);
  await editor.c.push([{ id, kind: 'spec', baseRev: cur.rev, fields: { title: 'Role test', body: 'WORKING COPY' } }]);
  assert.doesNotMatch((await call(c, 'get_spec', { id })).text, /WORKING COPY/); await c.close(); ok('read token sees only the released version');
  c = await mcp(draftTok.token);
  assert.match((await call(c, 'get_spec', { id, draft: true })).text, /WORKING COPY/); await c.close(); ok('drafts token can read the working copy');

  assert.equal((await admin.patch(`/api/teams/${T1}/members/${editor.id}`, { role: 'viewer' })).status, 200);
  c = await mcp(draftTok.token);
  assert.equal(await hasParam(c, 'get_spec', 'draft'), false); await c.close(); ok('downgrading a role in the team downgrades its tokens immediately');
  assert.equal((await admin.del(`/api/teams/${T1}/members/${editor.id}`)).status, 200);
  await assert.rejects(async () => (await mcp(draftTok.token)).listTools()); ok('removing a member kills that member’s tokens for the team');
  const reinv = (await admin.post(`/api/teams/${T1}/invites`, { email: editor.email, role: 'editor' })).data;
  await editor.c.post(`/api/me/invites/${reinv.invite.id}/accept`);

  const theirs = (await admin.get(`/api/users/${viewer.id}/tokens`)).data.tokens;
  assert.equal((await admin.del(`/api/users/${viewer.id}/tokens/${theirs[0].id}`)).data.ok, true);
  await assert.rejects(async () => (await mcp(readTok.token)).listTools()); ok('admin can revoke another user’s token');
  assert.equal((await admin.patch(`/api/users/${approver.id}`, { disabled: true })).status, 200);
  assert.equal((await approver.c.get('/api/me')).status, 401); ok('disabled user loses session');
  assert.equal((await admin.patch(`/api/users/${me.id}`, { admin: false })).status, 400); ok('last instance admin cannot be demoted');
  const onlyAdminTeam = (await admin.patch(`/api/teams/${t2.id}/members/${me.id}`, { role: 'viewer' }));
  assert.equal(onlyAdminTeam.status, 400); ok('a team keeps at least one team admin');

  // ---------------------------------------------------------------- foundation documents: vision, strategy, glossary
  const ctxTool = async (token) => { const cl = await mcp(token); const out = await call(cl, 'get_team_context'); await cl.close(); return out.text; };
  const tokA = (await admin.post('/api/me/tokens', { name: 'ctx', scopes: ['mcp:read'], teamId: T1 })).data.token;
  const own2 = (await editor.c.get('/api/teams')).data.teams.find((x) => x.name === 'Editor Lab');
  const lab = new Client(BASE); lab.cookie = editor.c.cookie; lab.tid = own2.id;
  const labDocs = (await lab.sync()).data.items.filter((i) => i.kind === 'doc');
  assert.deepEqual(labDocs.map((d) => d.id).sort(), ['glossary.md', 'strategy.md', 'vision.md']); assert.ok(labDocs.every((d) => d.pinned && d.core)); ok('every new team starts with vision, strategy and glossary');
  const labTok = (await editor.c.post('/api/me/tokens', { name: 'lab', scopes: ['mcp:read'], teamId: own2.id })).data.token;
  assert.match(await ctxTool(labTok), /Nothing has been written down yet/); ok('empty foundation documents are not served (template-only = empty)');
  const vis = labDocs.find((d) => d.id === 'vision.md');
  r = await lab.push([{ id: 'vision.md', kind: 'doc', baseRev: vis.rev, fields: { body: '# Vision\n\n## Where are we heading?\nBe the calmest billing system there is.\n' } }]);
  assert.equal(r[0].status, 'applied');
  await sleep(700);
  const ctx1 = await ctxTool(labTok);
  assert.match(ctx1, /calmest billing system/); ok('a foundation document goes live automatically after the edit – no spec, no link, no approval');
  const gl2 = labDocs.find((d) => d.id === 'glossary.md');
  await lab.push([{ id: 'glossary.md', kind: 'doc', baseRev: gl2.rev, fields: { body: '# Glossary\n\nDunning\n: Reminding customers about unpaid invoices.\n' } }]);
  await sleep(700);
  const cl2 = await mcp(labTok);
  const lg = JSON.parse((await call(cl2, 'get_glossary')).text);
  assert.deepEqual(lg.map((g) => g.term), ['Dunning']); assert.match(await ctxTool(labTok), /\*\*Dunning\*\*: Reminding customers/);
  const lst = JSON.parse((await call(cl2, 'list_documents')).text);
  assert.ok(lst.find((d) => d.path === 'vision.md' && d.always === true)); ok('the glossary is queryable via MCP without being linked to any spec; foundation docs are flagged "always"');
  await cl2.close();
  assert.equal((await lab.push([{ id: 'vision.md', kind: 'doc', baseRev: (await lab.sync()).data.items.find((i) => i.id === 'vision.md').rev, delete: true }]))[0].status, 'error'); ok('foundation documents cannot be deleted');
  // custom foundation doc via pin; unpin withdraws it
  await lab.push([{ id: 'principles.md', kind: 'doc', baseRev: 0, fields: { title: 'p', body: '# Principles\nPrefer boring technology.\n', pinned: true } }]);
  await sleep(700);
  assert.match(await ctxTool(labTok), /Prefer boring technology/); ok('any document can be pinned as a foundation document');
  const pr = (await lab.sync()).data.items.find((i) => i.id === 'principles.md');
  await lab.push([{ id: 'principles.md', kind: 'doc', baseRev: pr.rev, fields: { pinned: false } }]);
  assert.doesNotMatch(await ctxTool(labTok), /Prefer boring technology/); ok('unpinning withdraws it from the agent context');
  // team admin can switch auto release off -> only explicit approval publishes
  assert.equal((await editor.c.req('PATCH', `/api/teams/${own2.id}`, { foundationAuto: false })).status, 200);
  const st0 = (await lab.sync()).data.items.find((i) => i.id === 'strategy.md');
  await lab.push([{ id: 'strategy.md', kind: 'doc', baseRev: st0.rev, fields: { body: '# Strategy\n\n## Goals\nZero double charges.\n' } }]);
  await sleep(700);
  assert.doesNotMatch(await ctxTool(labTok), /Zero double charges/);
  const st1 = (await lab.sync()).data.items.find((i) => i.id === 'strategy.md');
  assert.equal((await lab.push([{ id: 'strategy.md', kind: 'doc', baseRev: st1.rev, approve: true, fields: {} }]))[0].item.status, 'approved');
  assert.match(await ctxTool(labTok), /Zero double charges/); ok('with auto-release off a foundation document needs an explicit approval');

  // ---------------------------------------------------------------- glossary: aliases, references, global glossary
  const glDoc = (await admin.sync()).data.items.find((i) => i.id === 'glossary.md');
  await admin.push([{ id: 'glossary.md', kind: 'doc', baseRev: glDoc.rev, fields: { body: `${glDoc.body}\nRetry horizon\n: How long a retry stays idempotent. See [[Idempotency key]] and [[Ledger|the ledger]].\n: Aliases: horizon, retry cut-off\n: See also: Ledger entry\n` } }]);
  await sleep(700);
  const cg = await mcp(tokA);
  const viaAlias = JSON.parse((await call(cg, 'get_glossary', { term: 'cut-off' })).text);
  assert.equal(viaAlias.length, 1); assert.equal(viaAlias[0].term, 'Retry horizon'); assert.deepEqual(viaAlias[0].aliases, ['horizon', 'retry cut-off']);
  assert.deepEqual(viaAlias[0].see_also.sort(), ['Idempotency key', 'Ledger', 'Ledger entry']); assert.equal(viaAlias[0].from_global_glossary, false); ok('get_glossary finds terms by alias and returns synonyms and related terms (explicit + [[references]])');
  const ctxText = await ctxTool(tokA);
  assert.match(ctxText, /\*\*Retry horizon\*\* \(also: horizon, retry cut-off\): How long a retry stays idempotent/); assert.match(ctxText, /see also: Ledger entry, Idempotency key, Ledger/); ok('get_team_context lists aliases and related terms');
  assert.match(readFileSync(`${srv.dir}/repos/${T1}/specs/GLOSSARY.md`, 'utf8'), /Also known as: horizon, retry cut-off · See also: Ledger entry, Idempotency key, Ledger/); ok('GLOSSARY.md in Git carries aliases and related terms');
  await cg.close();

  const gl1 = await admin.post('/api/glossary/global', { term: 'Reconciliation', definition: 'Matching our ledger with the bank statement.', aliases: 'matching, recon', see: ['Chargeback'] });
  assert.equal(gl1.status, 200); assert.equal(gl1.data.term.rev, 1); assert.deepEqual(gl1.data.term.aliases, ['matching', 'recon']); ok('instance admin adds a global glossary term');
  assert.equal((await viewer.c.post('/api/glossary/global', { term: 'X', definition: 'y' })).status, 403); assert.ok((await viewer.c.get('/api/glossary/global')).data.terms.some((t) => t.term === 'Reconciliation')); ok('everybody can read the global glossary, only instance admins change it');
  assert.equal((await admin.post('/api/glossary/global', { term: 'reconciliation', definition: 'dup' })).status, 409); assert.equal((await admin.post('/api/glossary/global', { term: 'Bad [term]', definition: 'x' })).status, 400); assert.equal((await admin.post('/api/glossary/global', { term: 'Ok', definition: '' })).status, 400); ok('global terms are validated (unique, no brackets, definition required)');
  const glEdit = await admin.patch(`/api/glossary/global/${gl1.data.term.id}`, { definition: 'Funds move from the processor to our bank.' });
  assert.equal(glEdit.data.term.rev, 2); assert.equal(glEdit.data.term.aliases.length, 2); ok('editing a global term bumps its revision');
  assert.equal((await admin.del(`/api/glossary/global/${gl1.data.term.id}`)).data.terms.some((t) => t.term === 'Reconciliation'), false); ok('global terms can be deleted');

  // ---------------------------------------------------------------- global glossary: file import (CSV / JSON / Markdown)
  const csv = parseGlossaryFile('terms.csv', 'Term;Definition;Synonyme;Siehe auch\n"Idempotenz";"Mehrfaches Ausführen, gleiches Ergebnis; siehe [[Retry]]";"Wiederholsicherheit|Idempotency";Retry\nRetry;Ein erneuter Versuch;;\n;nur Definition;;\n');
  assert.equal(csv.terms.length, 2); assert.deepEqual(csv.terms[0].aliases, ['Wiederholsicherheit', 'Idempotency']); assert.equal(csv.terms[0].definition, 'Mehrfaches Ausführen, gleiches Ergebnis; siehe [[Retry]]'); assert.equal(csv.errors.length, 1); ok('CSV parser: delimiter detection (;), quoted cells, header aliases (German), multiple aliases, row errors');
  assert.deepEqual(parseGlossaryFile('x.csv', 'term,definition\nA,"say ""hi"""\n').terms[0].definition, 'say "hi"'); ok('CSV parser: escaped quotes');
  assert.equal(parseGlossaryFile('t.json', JSON.stringify([{ term: 'A', definition: 'a', aliases: 'x, y' }, { name: 'B', description: 'b', synonyms: ['z'] }])).terms.length, 2);
  assert.deepEqual(parseGlossaryFile('t.json', JSON.stringify({ terms: [{ term: 'A', definition: 'a', see: ['B'] }] })).terms[0].see, ['B']);
  assert.equal(parseGlossaryFile('t.json', JSON.stringify({ Alpha: 'first', Beta: 'second' })).terms.length, 2); assert.ok(parseGlossaryFile('t.json', '{nope').errors[0].startsWith('Invalid JSON')); ok('JSON parser: array, {terms:[]}, {term: definition} map, field-name variants, invalid input');
  const mdImport = parseGlossaryFile('g.md', 'Alpha\n: First. See [[Beta]].\n: Aliases: a1, a2\n\nBeta\n: Second.\n');
  assert.equal(mdImport.terms.length, 2); assert.deepEqual(mdImport.terms[0].aliases, ['a1', 'a2']); assert.equal(parseGlossaryFile('x.txt', 'nothing here').errors.length, 1); ok('Markdown parser: definition lists with aliases');
  assert.equal(parseGlossaryFile('d.csv', 'term,definition\nA,one\na,two\n').terms.length, 1); ok('duplicate terms inside one file are reported and the first wins');

  const gUrl = '/api/glossary/global/import';
  assert.equal((await viewer.c.post(gUrl, { terms: [] })).status, 403); ok('only instance admins import into the global glossary');
  const imp1 = await admin.post(gUrl, { mode: 'skip', terms: [...csv.terms, { term: 'Bad [x]', definition: 'x' }, { term: 'NoDef', definition: '' }] });
  assert.deepEqual([imp1.data.result.created, imp1.data.result.skipped, imp1.data.result.errors.length], [2, 0, 2]); assert.ok(imp1.data.terms.some((t) => t.term === 'Idempotenz' && t.aliases.length === 2)); ok('bulk import creates valid terms and reports invalid ones');
  const skipRun = await admin.post(gUrl, { mode: 'skip', terms: [{ term: 'idempotenz', definition: 'changed' }] });
  assert.equal(skipRun.data.result.skipped, 1); assert.equal(skipRun.data.terms.find((t) => t.term === 'Idempotenz').definition.startsWith('Mehrfaches'), true); ok('mode "skip" keeps existing terms (case-insensitive match)');
  const upd = await admin.post(gUrl, { mode: 'update', terms: [{ term: 'Idempotenz', definition: 'changed', aliases: ['x'] }, { term: 'Retry', definition: 'Ein erneuter Versuch' }] });
  assert.equal(upd.data.result.updated, 1); assert.equal(upd.data.result.unchanged, 1); assert.equal(upd.data.terms.find((t) => t.term === 'Idempotenz').rev, 2); ok('mode "update" overwrites changed terms (revision +1) and leaves identical ones alone');
  assert.equal((await admin.post(gUrl, { terms: Array.from({ length: 2001 }, (_, i) => ({ term: `T${i}`, definition: 'x' })) })).status, 400); assert.equal((await admin.post(gUrl, { terms: 'nope' })).status, 400); ok('bulk import is bounded and validated');

  // ---------------------------------------------------------------- spec types: API spec, UI spec / design rule, feature spec, custom types
  const stUrl = `/api/teams/${T1}/spec-types`;
  const types0 = (await admin.get(stUrl)).data.types;
  assert.deepEqual(types0.filter((t) => t.builtin).map((t) => t.key), ['feature', 'api', 'ui', 'data', 'nfr', 'integration', 'adr', 'architecture']);
  assert.match(types0.find((t) => t.key === 'api').template, /## ENDPOINTS/); assert.match(types0.find((t) => t.key === 'ui').label, /design rule/i); ok('every team has the built-in spec types, each with a starting template');
  assert.equal((await viewer.c.post(stUrl, { label: 'Runbook', template: '## STEPS\n' })).status, 403); ok('only team admins define spec types');
  const rb = await admin.post(stUrl, { label: 'Runbook', description: 'Operational procedure', template: '## TRIGGER\n\n## STEPS\n' });
  assert.equal(rb.status, 200); assert.equal(rb.data.type.key, 'runbook'); assert.equal(rb.data.type.builtin, false); ok('a team defines its own spec type (key derived from the name)');
  assert.equal((await admin.post(stUrl, { label: 'Runbook' })).status, 409); assert.equal((await admin.post(stUrl, { label: 'API', key: 'api' })).status, 409); assert.equal((await admin.post(stUrl, { label: '' })).status, 400); assert.equal((await admin.post(stUrl, { label: 'Big', template: 'x'.repeat(20001) })).status, 400); ok('spec types are validated (unique, not shadowing built-ins, bounded)');
  assert.equal((await admin.patch(`${stUrl}/api`, { label: 'Hacked' })).status, 403); assert.equal((await admin.patch(`${stUrl}/runbook`, { description: 'Ops procedure' })).data.type.description, 'Ops procedure'); ok('built-in types are read-only, custom ones editable');
  assert.equal((await new Client(BASE).get(stUrl)).status, 401);
  const tid = `TY${uniq.toUpperCase()}`;
  r = await admin.push([{ id: `${tid}A`, kind: 'spec', baseRev: 0, fields: { title: 'Orders API', body: types0.find((t) => t.key === 'api').template, specType: 'api' } }, { id: `${tid}B`, kind: 'spec', baseRev: 0, fields: { title: 'Plain', body: 'x' } }, { id: `${tid}C`, kind: 'spec', baseRev: 0, fields: { title: 'Bad', body: 'x', specType: 'nope' } }, { id: `${tid}D`, kind: 'spec', baseRev: 0, fields: { title: 'Ops', body: 'x', specType: 'runbook' } }]);
  assert.equal(r[0].item.specType, 'api'); assert.equal(r[1].item.specType, 'feature'); assert.equal(r[2].status, 'error'); assert.match(r[2].message, /unknown spec type/); assert.equal(r[3].item.specType, 'runbook'); ok('specs carry a type (default feature); unknown types are rejected; custom types work');
  r = await admin.push([{ id: `${tid}A`, kind: 'spec', baseRev: r[0].item.rev, approve: true, fields: {} }]);
  assert.equal(r[0].item.status, 'approved');
  const cs = await mcp(tokA);
  const all = JSON.parse((await call(cs, 'list_specs')).text);
  const apiRow = all.find((x) => x.id === `${tid}A`);
  assert.equal(apiRow.type, 'api'); assert.equal(apiRow.type_label, 'API spec'); ok('list_specs reports the type of every spec');
  assert.deepEqual(JSON.parse((await call(cs, 'list_specs', { type: 'api' })).text).map((x) => x.id).filter((x) => x.startsWith(tid)), [`${tid}A`]);
  assert.equal(JSON.parse((await call(cs, 'list_specs', { type: 'ui' })).text).filter((x) => x.id.startsWith(tid)).length, 0); ok('list_specs can filter by type');
  assert.match((await call(cs, 'get_spec', { id: `${tid}A` })).text, /^---\nid: TY\w+A\ntype: api\n/); ok('the released spec carries its type in the front matter');
  await cs.close();
  const dItem = (await admin.sync()).data.items.find((i) => i.id === `${tid}D`);
  assert.equal((await admin.del(`${stUrl}/runbook`)).status, 409); ok('a spec type that is in use cannot be deleted');
  await admin.push([{ id: `${tid}D`, kind: 'spec', baseRev: dItem.rev, fields: { specType: 'ui' } }]);
  assert.equal((await admin.del(`${stUrl}/runbook`)).data.types.some((t) => t.key === 'runbook'), false); ok('after changing the specs’ type the custom type can be deleted');
  assert.ok((await admin.sync()).data.items.find((i) => i.id === `${tid}D`).specType === 'ui');
  const syncTypes = (await admin.sync()).data.specTypes; assert.ok(syncTypes.some((t) => t.key === 'api')); ok('the sync response carries the team’s spec types (offline use)');

  // ---------------------------------------------------------------- folders are first-class objects
  r = await lab.push([{ id: 'adr', kind: 'folder', baseRev: 0, fields: {} }, { id: 'adr/2026', kind: 'folder', baseRev: 0, fields: {} }]);
  assert.deepEqual(r.map((x) => x.status), ['applied', 'applied']); ok('empty folders can be created');
  assert.equal((await lab.push([{ id: '../x', kind: 'folder', baseRev: 0, fields: {} }]))[0].status, 'error'); ok('folder path traversal rejected');
  const fold = (await lab.sync()).data.items.find((i) => i.id === 'adr');
  assert.match((await lab.push([{ id: 'adr', kind: 'folder', baseRev: fold.rev, delete: true }]))[0].message, /not empty/); ok('a folder with content cannot be deleted');
  const f2 = (await lab.sync()).data.items.find((i) => i.id === 'adr/2026');
  r = await lab.push([{ id: 'adr/2026', kind: 'folder', baseRev: f2.rev, delete: true }, { id: 'adr', kind: 'folder', baseRev: fold.rev, delete: true }]);
  assert.deepEqual(r.map((x) => x.status), ['applied', 'applied']); ok('empty folders can be deleted (children first)');

  // ---------------------------------------------------------------- invitations for new people, teams, user management
  const inv = (await editor.c.post(`/api/teams/${own2.id}/invites`, { email: `newbie-${uniq}@example.com`, role: 'editor' })).data;
  assert.equal(inv.userExists, false); assert.match(inv.link, /#\/invite\/inv_/);
  const token = inv.link.split('/invite/')[1];
  const pub = new Client(BASE);
  const info = await pub.get(`/api/invites/${token}`);
  assert.equal(info.status, 200); assert.equal(info.data.invite.teamName, 'Editor Lab'); assert.equal(info.data.invite.userExists, false); ok('invitation link shows team and role before any sign-in');
  assert.equal((await pub.post(`/api/invites/${token}/accept`, { name: 'Newbie', password: 'short' })).status, 400); ok('registering through an invitation enforces a password');
  const reg1 = await pub.post(`/api/invites/${token}/accept`, { name: 'Newbie', password: 'newbie-pass-1' });
  assert.equal(reg1.status, 200); assert.equal(reg1.data.me.teams[0].role, 'editor'); assert.equal(reg1.data.me.teams[0].name, 'Editor Lab'); ok('a new person creates their account from the invitation and joins with the invited role');
  assert.equal((await new Client(BASE).get(`/api/invites/${token}`)).status, 404); ok('an invitation link works only once');
  assert.equal((await pub.get('/api/me')).status, 200);
  assert.equal(reg1.data.me.admin, false); assert.equal((await pub.get('/api/users')).status, 403);
  const pending = (await editor.c.get(`/api/teams/${own2.id}/members`)).data;
  assert.equal(pending.invites.length, 0); assert.ok(pending.members.some((m) => m.email === `newbie-${uniq}@example.com`)); ok('team admins see members and pending invitations');
  const inv2 = (await editor.c.post(`/api/teams/${own2.id}/invites`, { email: `x-${uniq}@example.com`, role: 'viewer' })).data;
  assert.equal((await editor.c.del(`/api/teams/${own2.id}/invites/${inv2.invite.id}`)).data.invites.length, 0); assert.equal((await new Client(BASE).get(`/api/invites/${inv2.link.split('/invite/')[1]}`)).status, 404); ok('pending invitations can be revoked');
  assert.equal((await editor.c.post(`/api/teams/${own2.id}/invites`, { email: `newbie-${uniq}@example.com`, role: 'viewer' })).status, 409); ok('members cannot be invited twice');
  // decline + wrong person
  const inv3 = (await editor.c.post(`/api/teams/${own2.id}/invites`, { email: viewer.email, role: 'viewer' })).data;
  assert.equal((await editor.c.post(`/api/me/invites/${inv3.invite.id}/accept`)).status, 403); ok('only the invited person can accept');
  assert.equal((await viewer.c.post(`/api/me/invites/${inv3.invite.id}/decline`)).data.ok, true); assert.equal((await viewer.c.get('/api/me')).data.me.invites.length, 0); ok('invitations can be declined');
  // team limit + leave
  assert.equal((await editor.c.post('/api/teams', { name: 'Second' })).status, 200);
  assert.equal((await editor.c.post('/api/teams', { name: 'Third' })).status, 403); ok('team creation per user is limited');
  assert.equal((await pub.post(`/api/teams/${own2.id}/leave`)).status, 200); assert.equal((await pub.get('/api/me')).data.me.teams.length, 0); ok('members can leave a team');
  assert.equal((await editor.c.post(`/api/teams/${own2.id}/leave`)).status, 400); ok('the last team admin cannot leave');
  // instance admin: teams overview, delete user / team
  const adm = (await admin.get('/api/admin/teams')).data.teams;
  assert.ok(adm.find((x) => x.name === 'Editor Lab' && x.members >= 1)); ok('instance admin sees all teams');
  const editorUser = (await admin.get('/api/users')).data.users.find((x) => x.email === editor.email);
  assert.equal((await admin.del(`/api/users/${editorUser.id}`)).status, 409); ok('a user who is the only team admin cannot be deleted');
  assert.equal((await admin.req('DELETE', `/api/teams/${own2.id}`, { confirmKey: 'nope' })).status, 400);
  assert.equal((await editor.c.req('DELETE', `/api/teams/${own2.id}`, { confirmKey: own2.key })).status, 403); ok('only instance admins delete teams, with key confirmation');
  assert.equal((await admin.req('DELETE', `/api/teams/${own2.id}`, { confirmKey: own2.key })).status, 200);
  assert.equal((await admin.get('/api/admin/teams')).data.teams.some((x) => x.id === own2.id), false); ok('deleting a team removes it');
  await assert.rejects(async () => (await mcp(labTok)).listTools()); ok('deleting a team kills its MCP tokens');
  const t3 = (await editor.c.get('/api/teams')).data.teams.find((x) => x.name === 'Second');
  await admin.req('DELETE', `/api/teams/${t3.id}`, { confirmKey: t3.key });
  assert.equal((await admin.del(`/api/users/${editorUser.id}`)).status, 200); assert.equal((await editor.c.get('/api/me')).status, 401); ok('instance admin can delete a user (their sessions end)');

  // ---------------------------------------------------------------- e-mail delivery of invitations
  const mailTo = `mailtest-${uniq}@example.com`;
  const sent = await admin.post(`/api/teams/${T1}/invites`, { email: mailTo, role: 'editor' });
  assert.equal(sent.status, 200); assert.equal(sent.data.mailEnabled, true); assert.equal(sent.data.emailed, true); assert.ok(sent.data.link); ok('invitation is e-mailed when a mail server is configured (link still returned)');
  const got = smtp.mails.find((m) => m.to.includes(mailTo));
  assert.ok(got, 'mail arrived at the sink'); assert.match(got.subject, /invited you to specs/); assert.match(got.from, /specs@example\.test/);
  assert.ok(got.text.includes(sent.data.link), 'mail contains the one-time link'); assert.match(got.text, /as editor/); assert.match(got.text, /expires in 7 days/); ok('the mail names team, inviter and role, contains the one-time link and its expiry');
  const tokenFromMail = /#\/invite\/(inv_[\w-]+)/.exec(got.text)[1];
  assert.equal((await new Client(BASE).get(`/api/invites/${tokenFromMail}`)).status, 200); ok('the link from the e-mail is valid');
  const again = await admin.post(`/api/teams/${T1}/invites`, { email: mailTo, role: 'viewer' });
  assert.equal(again.data.emailed, true); assert.equal((await new Client(BASE).get(`/api/invites/${tokenFromMail}`)).status, 404); assert.equal(smtp.mails.filter((m) => m.to.includes(mailTo)).length, 2); ok('re-sending replaces the old link (the old one stops working)');
  await admin.req('PATCH', `/api/teams/${t2.id}`, { name: 'Pay <script>alert(1)</script>' });
  await admin.post(`/api/teams/${t2.id}/invites`, { email: `html-${uniq}@example.com`, role: 'viewer' });
  const htmlMail = smtp.mails.at(-1);
  assert.ok(!htmlMail.text.includes('<script>alert(1)</script>') || !/<a [^>]*>.*<script>/.test(htmlMail.text)); assert.match(htmlMail.text, /&lt;script&gt;/); ok('team and user names are HTML-escaped in the mail');
  await admin.req('PATCH', `/api/teams/${t2.id}`, { name: 'Payments' });
  // a broken mail server must not block the invitation and must not leak credentials
  const brokenMail = await startServer({ SMTP_URL: 'smtp://mailuser:topsecretpw@127.0.0.1:1', MAX_TEAMS_PER_USER: '2' });
  try {
    const ba = new Client(brokenMail.base); await ba.login('admin@localhost', 'adminpass1');
    const failed = await ba.post(`/api/teams/${ba.tid}/invites`, { email: 'x@example.com', role: 'viewer' });
    assert.equal(failed.status, 200); assert.equal(failed.data.emailed, false); assert.match(failed.data.emailError, /could not be sent/); assert.ok(failed.data.link);
    assert.ok(!JSON.stringify(failed.data).includes('topsecretpw') && !brokenMail.log().includes('topsecretpw')); ok('a failing mail server still yields the link, reports the problem and leaks no credentials');
    const tm = await ba.post('/api/admin/mail/test');
    assert.equal(tm.status, 502); assert.ok(!JSON.stringify(tm.data).includes('topsecretpw')); ok('admin test e-mail reports delivery failures');
  } finally { brokenMail.stop(); }
  const tmOk = await admin.post('/api/admin/mail/test');
  assert.equal(tmOk.status, 200); assert.ok(smtp.mails.some((m) => m.to.includes('admin@localhost') && /test e-mail/.test(m.subject))); ok('admin can send a test e-mail to themselves');
  assert.equal((await viewer.c.post('/api/admin/mail/test')).status, 403); ok('only instance admins can trigger the test e-mail');
  assert.equal((await admin.get('/api/admin/teams')).data.mail.enabled, true);

  // ---------------------------------------------------------------- OAuth 2.1 for MCP (DCR + PKCE + consent with team choice)
  const un = await fetch(`${BASE}/mcp`, { method: 'POST' });
  assert.equal(un.status, 401); assert.match(un.headers.get('www-authenticate'), /resource_metadata="[^"]+oauth-protected-resource/); ok('unauthenticated MCP call points to OAuth metadata');
  const asm = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  assert.ok(asm.registration_endpoint && asm.code_challenge_methods_supported.includes('S256')); ok('discovery metadata is served');
  const redirect = 'http://localhost:9876/callback';
  const reg = await (await fetch(asm.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Test Agent', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) })).json();
  assert.ok(reg.client_id); ok('dynamic client registration');
  const oauthUser = await mk('editor', '2');
  const pkce = () => { const verifier = randomBytes(32).toString('base64url'); return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }; };
  async function authorize(decision, { scope = 'mcp:read mcp:drafts', who = oauthUser.c, team = T1 } = {}) {
    const p = pkce();
    const u = new URL(asm.authorization_endpoint);
    Object.entries({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, code_challenge: p.challenge, code_challenge_method: 'S256', scope, state: 'xyz', resource: `${BASE}/mcp` }).forEach(([k, v]) => u.searchParams.set(k, v));
    const a = await fetch(u, { redirect: 'manual' });
    const consentUrl = new URL(a.headers.get('location'), BASE);
    const page = await who.req('GET', consentUrl.pathname + consentUrl.search);
    assert.match(page.data, /Test Agent/);
    const form = new URLSearchParams({ request: consentUrl.searchParams.get('request'), decision, scope: 'mcp:drafts', team });
    const d = await who.req('POST', '/oauth/consent', form, { 'content-type': 'application/x-www-form-urlencoded' });
    const loc = d.res.headers.get('location');
    return { p, loc: loc ? new URL(loc) : null, status: d.status, page: page.data };
  }
  const denied = await authorize('deny');
  assert.equal(denied.loc.searchParams.get('error'), 'access_denied'); ok('user can deny access');
  const tokenReq = (body) => fetch(asm.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  const g1 = await authorize('allow');
  assert.ok((await tokenReq({ grant_type: 'authorization_code', code: g1.loc.searchParams.get('code'), client_id: reg.client_id, redirect_uri: redirect, code_verifier: randomBytes(32).toString('base64url') })).status >= 400); ok('wrong PKCE verifier rejected');
  const g2 = await authorize('allow');
  const tok = await (await tokenReq({ grant_type: 'authorization_code', code: g2.loc.searchParams.get('code'), client_id: reg.client_id, redirect_uri: redirect, code_verifier: g2.p.verifier })).json();
  assert.ok(tok.access_token && tok.refresh_token); ok('authorization code + PKCE → tokens');
  c = await mcp(tok.access_token);
  assert.equal(await hasParam(c, 'get_spec', 'draft'), true); assert.ok(JSON.parse((await call(c, 'list_specs')).text).length > 0); await c.close(); ok('MCP works with an OAuth access token (team-bound, drafts scope)');
  assert.ok((await oauthUser.c.get('/api/me/tokens')).data.connections.find((x) => x.clientName === 'Test Agent' && x.teamName === 'specs')); ok('OAuth connection is listed with its team');
  const nonMember = await authorize('allow', { team: t2.id });
  assert.equal(nonMember.status, 400); assert.equal(nonMember.loc, null); ok('consent refuses a team the user does not belong to');
  const rt = await (await tokenReq({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: reg.client_id })).json();
  assert.ok(rt.access_token && rt.access_token !== tok.access_token); ok('refresh token rotation');
  const connId = (await oauthUser.c.get('/api/me/tokens')).data.connections[0].id;
  await oauthUser.c.del(`/api/me/connections/${connId}`);
  await assert.rejects(async () => (await mcp(rt.access_token)).listTools()); ok('revoking a connection kills its tokens');

  // ---------------------------------------------------------------- spec types as forms
  const ftUrl = `/api/teams/${T1}/spec-types`;
  const apiType = (await admin.get(ftUrl)).data.types.find((t) => t.key === 'api');
  assert.equal(apiType.view, 'form'); assert.ok(apiType.form.fields.some((f) => f.kind === 'endpoints')); assert.deepEqual(apiType.form.tabs.map((t) => t.label), ['Overview', 'Endpoints', 'Contract', 'Quality']); ok('built-in API / UI / NFR types are forms; the others stay free-form editor types');
  assert.equal((await admin.get(ftUrl)).data.types.find((t) => t.key === 'data').form.fields.length > 0, true);
  const mkForm = (extra) => admin.post(ftUrl, { label: 'Runbook form', description: 'x', view: 'form', form: { tabs: [{ key: 'a', label: 'Prepare' }, { key: 'b', label: 'Run' }], fields: [{ label: 'OWNER', kind: 'text' }, { label: 'PHASE', kind: 'select', options: 'Plan, Run', tab: 'b' }, { label: 'STEPS', kind: 'checklist', tab: 'b' }], ...extra } });
  const ft = await mkForm({});
  assert.equal(ft.status, 200); assert.equal(ft.data.type.view, 'form'); assert.deepEqual(ft.data.type.form.fields.map((f) => f.key), ['owner', 'phase', 'steps']); assert.equal(ft.data.type.form.fields[1].options.length, 2); assert.match(ft.data.type.template, /## OWNER\n\n## PHASE\n\n## STEPS/); ok('a team can define a form type (fields, tabs, default view); its template is derived from the fields');
  assert.equal((await admin.post(ftUrl, { label: 'Bad A', form: { fields: [{ label: 'X', kind: 'nope' }] } })).status, 400);
  assert.equal((await admin.post(ftUrl, { label: 'Bad B', form: { fields: [{ label: 'X', kind: 'text' }, { label: 'x', kind: 'list' }] } })).status, 400);
  assert.equal((await admin.post(ftUrl, { label: 'Bad C', form: { fields: [{ label: 'X', kind: 'select' }] } })).status, 400);
  assert.equal((await admin.post(ftUrl, { label: 'Bad D', form: { fields: [] } })).status, 400); ok('invalid form schemas are rejected (unknown kind, duplicate label, select without choices, no fields)');
  const upT = await admin.patch(`${ftUrl}/${ft.data.type.key}`, { form: null }); assert.equal(upT.data.type.form, null); assert.equal(upT.data.type.view, 'editor'); ok('a form can be removed again (type falls back to the editor)');
  await admin.del(`${ftUrl}/${ft.data.type.key}`);
  { const ftU = await mk('viewer', 'ft'); const ftTok = (await ftU.c.post('/api/me/tokens', { name: 'ft', scopes: ['mcp:read'], teamId: T1 })).data; const tc = await mcp(ftTok.token); const lt = JSON.parse((await call(tc, 'list_spec_types')).text); await tc.close(); assert.ok(lt.find((t) => t.key === 'api').form.some((f) => f.section === '## ENDPOINTS' && f.kind === 'endpoints')); ok('agents can read the form sections of each type (list_spec_types)'); }

  // ---------------------------------------------------------------- agents write DRAFTS, people approve
  assert.equal((await viewer.c.post('/api/me/tokens', { name: 'w', scopes: ['mcp:read', 'mcp:write'], teamId: T1 })).status, 403); ok('viewer may not create a write token');
  const agentEd = await mk('editor', 'ag');
  const rdV = await mk('viewer', 'ag'); const rdTok = (await rdV.c.post('/api/me/tokens', { name: 'r', scopes: ['mcp:read'], teamId: T1 })).data;
  const wTok = (await agentEd.c.post('/api/me/tokens', { name: 'Claude Code', scopes: ['mcp:read', 'mcp:drafts', 'mcp:write'], teamId: T1 })).data;
  let w = await mcp(wTok.token);
  const wTools = await toolNames(w);
  for (const t of ['create_draft_spec', 'update_draft_spec', 'create_draft_document', 'update_draft_document']) assert.ok(wTools.includes(t), t);
  assert.ok(!wTools.some((t) => /approve|release|publish/.test(t)));
  const dTok2 = (await agentEd.c.post('/api/me/tokens', { name: 'd', scopes: ['mcp:read', 'mcp:drafts'], teamId: T1 })).data; const dc = await mcp(dTok2.token); assert.ok(!(await toolNames(dc)).includes('create_draft_spec')); await dc.close(); ok('write tools exist only with the mcp:write scope; there is no approve/release tool');
  const created = JSON.parse((await call(w, 'create_draft_spec', { title: 'Agent made', type: 'api', body: '# Agent made\n\n```endpoint GET /ping\nHealth check\n```\n' })).text);
  assert.match(created.id, /-\d{3}$/); assert.equal(created.status, 'draft');
  const items0 = (await agentEd.c.sync([], 0)).data.items; assert.equal(items0.find((x) => x.id === created.id).updatedVia.includes('Claude Code'), true); ok('agent creates a draft spec (server assigns the id) and attribution is stored');
  assert.equal(JSON.parse((await call(c0 = await mcp(rdTok.token), 'list_specs')).text).some((x) => x.id === created.id), false); await c0.close(); ok('drafts stay invisible to released-only readers');
  assert.equal((await call(w, 'create_draft_spec', { title: 'x', type: 'nope', body: 'b' })).isError, true);
  assert.equal((await call(w, 'create_draft_spec', { title: 'x', body: 'b', documents: ['missing.md'] })).isError, true); ok('unknown spec type / missing documents are refused');
  const updW = JSON.parse((await call(w, 'update_draft_spec', { id: created.id, body: '# v2', base_rev: created.rev })).text);
  assert.equal(updW.rev, created.rev + 1);
  assert.match((await call(w, 'update_draft_spec', { id: created.id, body: 'stale', base_rev: created.rev })).text, /Conflict/); ok('update with a stale base_rev is rejected');
  const dA1 = JSON.parse((await call(w, 'create_draft_document', { path: 'adr/agent-note.md', body: 'Note' })).text); assert.equal(dA1.status, 'draft');
  assert.equal((await call(w, 'update_draft_document', { path: 'vision.md', body: 'hijack' })).isError, true);
  assert.equal((await call(w, 'create_draft_document', { path: 'glossary.md', body: 'x' })).isError, true); ok('agents can write documents but never the foundation documents');
  // human approves the agent's draft
  const agentAp = await mk('approver', 'ag');
  const curA = (await agentEd.c.sync([], 0)).data.items.find((x) => x.id === created.id);
  r = await agentAp.c.push([{ id: created.id, kind: 'spec', baseRev: curA.rev, approve: true, fields: {} }]);
  assert.equal(r[0].item.status, 'approved'); ok('a person releases the agent draft');
  const relA = await mcp(rdTok.token); assert.match((await call(relA, 'get_spec', { id: created.id })).text, /# v2/); await relA.close();
  await call(w, 'update_draft_spec', { id: created.id, body: '# v3 by agent' });
  const rdA = await mcp(rdTok.token); assert.match((await call(rdA, 'get_spec', { id: created.id })).text, /# v2/); await rdA.close(); ok('an agent edit of a relA spec leaves the relA version untouched');
  const curB = (await agentEd.c.sync([], 0)).data.items.find((x) => x.id === created.id);
  r = await agentEd.c.push([{ id: created.id, kind: 'spec', baseRev: curB.rev, fields: { body: '# human edit' } }]);
  assert.equal(r[0].item.updatedVia, null); ok('a human edit clears the agent attribution');
  await w.close();
  // role downgrade kills write instantly
  const wrk = await mk('editor', 'w2'); const wtk = (await wrk.c.post('/api/me/tokens', { name: 'w', scopes: ['mcp:read', 'mcp:drafts', 'mcp:write'], teamId: T1 })).data;
  assert.equal((await admin.req('PATCH', `/api/teams/${T1}/members/${wrk.id}`, { role: 'viewer' })).status, 200);
  const wcl = await mcp(wtk.token); const wnames = await toolNames(wcl); await wcl.close();
  assert.ok(!wnames.includes('create_draft_spec') && !wnames.includes('get_spec') === false); ok('write tools disappear when the role is downgraded');

  // ---------------------------------------------------------------- feedback on specs (agents leave it, people triage it)
  {
    const fbEd = await mk('editor', 'fb'); const fbViewer = await mk('viewer', 'fb');
    const fbTok = (await fbEd.c.post('/api/me/tokens', { name: 'Reviewer agent', scopes: ['mcp:read', 'mcp:drafts', 'mcp:write'], teamId: T1 })).data;
    const roTok = (await fbViewer.c.post('/api/me/tokens', { name: 'ro', scopes: ['mcp:read'], teamId: T1 })).data;
    const ro = await mcp(roTok.token); const roNames = await toolNames(ro); await ro.close();
    assert.ok(!roNames.includes('add_feedback') && !roNames.includes('list_feedback'));
    const fa = await mcp(fbTok.token); assert.ok((await toolNames(fa)).includes('add_feedback')); ok('feedback tools exist only for tokens with write access');
    const sid = 'SPEC-012';
    const revBefore = (await fbEd.c.sync([], 0)).data.items.find((x) => x.id === sid).rev;
    const f1 = JSON.parse((await call(fa, 'add_feedback', { spec_id: sid, kind: 'conflict', section: '## ENDPOINTS', text: 'POST /webhooks/keys/rotate is implemented as PUT in src/hooks.ts', evidence: 'src/hooks.ts:42' })).text);
    assert.equal(f1.status, 'open'); assert.equal(f1.duplicate, false);
    const f1b = JSON.parse((await call(fa, 'add_feedback', { spec_id: sid, kind: 'conflict', section: '## endpoints', text: 'POST /webhooks/keys/rotate  is implemented as PUT in src/hooks.ts' })).text);
    assert.equal(f1b.duplicate, true); assert.equal(f1b.id, f1.id); ok('an agent leaves feedback; the same open feedback is merged instead of repeated');
    assert.equal((await call(fa, 'add_feedback', { spec_id: 'NOPE-1', kind: 'question', text: 'x' })).isError, true);
    assert.equal((await call(fa, 'add_feedback', { spec_id: sid, kind: 'question', text: '   ' })).isError, true);
    await assert.rejects(async () => { const r = await fa.callTool({ name: 'add_feedback', arguments: { spec_id: sid, kind: 'rant', text: 'x' } }); if (r.isError) throw new Error('rejected'); }); ok('unknown spec, empty text and unknown kinds are refused');
    const afterSync = (await fbEd.c.sync([], 0)).data;
    assert.equal(afterSync.feedbackOpen[sid], 1); assert.equal(afterSync.items.find((x) => x.id === sid).rev, revBefore); ok('feedback never changes the spec; open counts travel with the sync');
    const listed = (await fbViewer.c.get(`/api/teams/${T1}/feedback?spec=${sid}`)).data.feedback;
    assert.equal(listed.length, 1); assert.match(listed[0].via, /Reviewer agent/); assert.match(listed[0].author, /editor user/); assert.equal(listed[0].evidence, 'src/hooks.ts:42'); ok('everyone in the team can read feedback');
    assert.equal((await fbViewer.c.req('PATCH', `/api/teams/${T1}/feedback/${f1.id}`, { status: 'accepted' })).status, 403); ok('viewers cannot triage feedback');
    assert.equal((await fbEd.c.req('PATCH', `/api/teams/${T1}/feedback/${f1.id}`, { status: 'bogus' })).status, 400);
    const tri = (await fbEd.c.req('PATCH', `/api/teams/${T1}/feedback/${f1.id}`, { status: 'accepted', reply: 'Right – fixing the spec to PUT.' })).data.feedback;
    assert.equal(tri.status, 'accepted'); assert.match(tri.resolvedBy, /editor user/); ok('a person accepts feedback and replies');
    const again = JSON.parse((await call(fa, 'list_feedback', { spec_id: sid })).text);
    assert.equal(again[0].status, 'accepted'); assert.match(again[0].reply, /fixing the spec/); assert.equal(JSON.parse((await call(fa, 'list_feedback', { status: 'open' })).text).length, 0); ok('the agent sees the decision and the reply (list_feedback)');
    assert.equal(JSON.parse((await call(fa, 'add_feedback', { spec_id: sid, kind: 'conflict', section: '## ENDPOINTS', text: 'POST /webhooks/keys/rotate is implemented as PUT in src/hooks.ts' })).text).duplicate, false); ok('after triage the same finding can be raised again');
    assert.equal((await fbEd.c.sync([], 0)).data.feedbackOpen[sid], 1);
    await fa.close();
  }

  // ---------------------------------------------------------------- Git connection per team
  const remote = path.join(tmp, 'remote.git');
  git(tmp, 'init', '--bare', '-b', 'main', remote);
  // a dev repo with existing history that the remote already contains
  const dev = path.join(tmp, 'dev'); git(tmp, 'clone', remote, dev); git(dev, 'config', 'user.email', 'dev@x'); git(dev, 'config', 'user.name', 'Dev');
  writeFileSync(path.join(dev, 'README.md'), '# the product\n'); git(dev, 'add', '.'); git(dev, 'commit', '-m', 'init'); git(dev, 'push', 'origin', 'HEAD:main');

  const gitUrl = `/api/teams/${T1}/git`;
  assert.equal((await viewer.c.req('PUT', gitUrl, { url: remote })).status, 403); ok('only team admins may edit the git connection');
  const bad = async (url) => (await admin.req('PUT', gitUrl, { url, branch: 'main', root: 'specs', auth: 'none' })).status;
  for (const u of ['--upload-pack=touch /tmp/pwn', 'ext::sh -c id', 'file:///etc', 'http://insecure.example/x.git', 'git@host:org/r.git x']) assert.equal(await bad(u), 400, u);
  ok('dangerous or unsupported remote URLs are rejected');
  assert.equal((await admin.req('PUT', gitUrl, { url: remote, branch: 'main', root: '../x', auth: 'none' })).status, 400); ok('folder path traversal rejected');
  assert.equal((await admin.req('PUT', gitUrl, { url: remote, branch: 'main', root: 'specs', auth: 'token', username: 'x', token: 'tok' })).status, 400); ok('token auth needs an https URL');
  r = await admin.req('PUT', gitUrl, { url: remote, branch: 'main', root: 'specs', auth: 'none', autoPush: false });
  assert.equal(r.status, 200); assert.equal(r.data.git.url, remote); ok('team admin saves the git connection');
  assert.ok(!JSON.stringify((await admin.get(`/api/teams/${T1}`)).data).includes('secret')); 
  assert.equal((await admin.req('PUT', gitUrl, { url: remote, branch: 'main', root: 'other', auth: 'none' })).status, 409); ok('folder is locked once specs were released');
  const test = (await admin.post(`${gitUrl}/test`)).data;
  assert.equal(test.ok, true); assert.equal(test.branchExists, true); ok('test connection reaches the remote');
  assert.equal((await viewer.c.post(`${gitUrl}/push`)).status, 403); ok('push needs the approve right');
  const pushed = await admin.post(`${gitUrl}/push`);
  assert.equal(pushed.status, 200, JSON.stringify(pushed.data));
  git(dev, 'pull', 'origin', 'main');
  assert.ok(existsSync(path.join(dev, 'README.md')) && existsSync(path.join(dev, 'specs', `${id}.md`)) && existsSync(path.join(dev, 'specs', 'GLOSSARY.md')));
  assert.ok(existsSync(path.join(dev, 'specs', 'docs', moved))); ok('push merges into the existing dev repository and keeps its files');
  assert.match(git(remote, 'tag', '-l'), new RegExp(`${id}/v2`)); ok('version tags are pushed too');
  // auto push
  await admin.req('PUT', gitUrl, { url: remote, branch: 'main', root: 'specs', auth: 'none', autoPush: true });
  const s12 = (await admin.sync()).data.items.find((i) => i.id === 'SPEC-012');
  await admin.push([{ id: 'SPEC-012', kind: 'spec', baseRev: s12.rev, fields: { body: s12.body + '\nR3 auto pushed\n' } }]);
  const rv = (await admin.sync()).data.items.find((i) => i.id === 'SPEC-012').rev;
  await admin.push([{ id: 'SPEC-012', kind: 'spec', baseRev: rv, approve: true, fields: {} }]);
  for (let i = 0; i < 30; i++) { git(dev, 'pull', '-q', 'origin', 'main'); if (/auto pushed/.test(readFileSync(path.join(dev, 'specs', 'SPEC-012.md'), 'utf8'))) break; await new Promise((r) => setTimeout(r, 300)); }
  assert.match(readFileSync(path.join(dev, 'specs', 'SPEC-012.md'), 'utf8'), /auto pushed/); ok('approvals are pushed automatically');
  const st = (await admin.get(`/api/teams/${T1}`)).data.team.git;
  assert.equal(st.lastOk, true); assert.ok(st.lastPushAt && st.lastSha); ok('push status is recorded');
  // a second team has its own, independent repository / connection
  assert.equal((await admin.get(`/api/teams/${t2.id}`)).data.team.git.url, ''); ok('teams have independent git connections');
  // failing push is reported without leaking and without crashing
  await admin.req('PUT', gitUrl, { url: path.join(tmp, 'does-not-exist.git'), branch: 'main', root: 'specs', auth: 'none', autoPush: false });
  const failed = await admin.post(`${gitUrl}/push`);
  assert.ok(failed.status >= 400 && failed.data.error); assert.equal((await admin.get(`/api/teams/${T1}`)).data.team.git.lastOk, false); ok('a failing push is reported and recorded');
  // secrets
  assert.equal((await admin.req('PUT', gitUrl, { url: 'https://git.example/org/repo.git', branch: 'main', root: 'specs', auth: 'token', username: 'bot', token: 'ghp_SECRET123' })).status, 200);
  const shown = JSON.stringify((await admin.get(`/api/teams/${T1}`)).data);
  assert.ok(!shown.includes('ghp_SECRET123') && shown.includes('"hasSecret":true')); assert.ok(!readFileSync(`${srv.dir}/specs.db`).includes('ghp_SECRET123')); ok('git tokens are write-only and encrypted at rest');
  const key = await admin.post(`${gitUrl}/ssh-key`);
  assert.equal(key.status, 200); assert.match(key.data.publicKey, /^ssh-ed25519 /); ok('server generates an SSH deploy key per team');
  assert.ok(!JSON.stringify((await admin.get(`/api/teams/${T1}`)).data).includes('PRIVATE'));

  // git authorship
  assert.match(git(`${srv.dir}/repos/${T1}`, 'log', '--format=%an|%s', '--no-merges', '-n', '8'), /approver user\|Release T/); ok('git commit is authored by the approver');

  console.log(`\n${n} checks passed`);
} finally {
  srv.stop();
  smtp.stop();
}
