// Backend integration test: sessions, teams + roles, folders, glossary, personal MCP tokens, OAuth 2.1 for MCP, Git per team.
//   node tests/api.test.mjs            (starts its own server)
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, symlinkSync, mkdirSync, lstatSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { scryptSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer, Client, startSmtpSink } from './helpers.mjs';
import { parseGlossaryFile } from '../shared/glossaryImport.js';

const tmp = mkdtempSync(path.join(process.env.TEST_TMP || tmpdir(), 'specs-remote-'));
const smtp = await startSmtpSink();
const srv = await startServer({ GIT_ALLOW_LOCAL: '1', FOUNDATION_DEBOUNCE_MS: '150', FEEDBACK_MAIL_DEBOUNCE_MS: '300', HOOK_DEBOUNCE_MS: '250', HOOK_ALLOW_LOCAL: '1', MAX_TEAMS_PER_USER: '2', SMTP_URL: `smtp://127.0.0.1:${smtp.port}`, SMTP_FROM: 'Specs <specs@example.test>' });
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
  assert.deepEqual(await toolNames(c), ['get_document', 'get_glossary', 'get_spec', 'get_spec_changes', 'get_team_context', 'get_work_list', 'list_decisions', 'list_documents', 'list_reports', 'list_spec_types', 'list_specs']);
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
  { // SEC-17: a refresh token that was already exchanged is a stolen one – the whole grant ends
    const g = await authorize('allow');
    const t0 = await (await tokenReq({ grant_type: 'authorization_code', code: g.loc.searchParams.get('code'), client_id: reg.client_id, redirect_uri: redirect, code_verifier: g.p.verifier })).json();
    const t1 = await (await tokenReq({ grant_type: 'refresh_token', refresh_token: t0.refresh_token, client_id: reg.client_id })).json();
    assert.ok(t1.refresh_token && t1.refresh_token !== t0.refresh_token);
    assert.ok((await tokenReq({ grant_type: 'refresh_token', refresh_token: t0.refresh_token, client_id: reg.client_id })).status >= 400);
    assert.ok((await tokenReq({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: reg.client_id })).status >= 400);
    await assert.rejects(async () => (await mcp(t1.access_token)).listTools()); ok('SEC-17: showing an already used refresh token again revokes the whole grant');
    // the consent form only accepts posts from this server's own origin
    const p2 = pkce(); const u2 = new URL(asm.authorization_endpoint);
    Object.entries({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, code_challenge: p2.challenge, code_challenge_method: 'S256', scope: 'mcp:read', state: 'q' }).forEach(([k, v]) => u2.searchParams.set(k, v));
    const a2 = await fetch(u2, { redirect: 'manual' }); const rid = new URL(a2.headers.get('location'), BASE).searchParams.get('request');
    const foreign = await oauthUser.c.req('POST', '/oauth/consent', new URLSearchParams({ request: rid, decision: 'allow', team: T1 }), { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' });
    assert.equal(foreign.status, 400); ok('SEC-17: the consent form refuses a foreign Origin');
  }

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
    // e-mail digest to approvers and admins (not to the author), switchable per team
    const waitMail = async (pred, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const m = smtp.mails.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 100)); } return null; };
    const fbAppr = await mk('approver', 'fbm');
    await call(fa, 'add_feedback', { spec_id: sid, kind: 'gap', text: 'digest probe' });
    const digest = await waitMail((m) => /new feedback/.test(m.subject) && m.to.includes(fbAppr.email) && /digest probe/.test(m.raw)); // (creating a user takes a moment: an earlier digest may already be there)
    assert.ok(digest, 'digest mail'); assert.match(digest.raw, /SPEC-012/); assert.ok(!digest.to.includes(fbEd.email)); ok('new feedback is e-mailed to approvers and admins as one digest');
    await call(fa, 'add_feedback', { spec_id: sid, kind: 'question', text: 'second finding' }); await call(fa, 'add_feedback', { spec_id: sid, kind: 'gap', text: 'third finding' });
    await waitMail((m) => /2 new feedback/.test(m.subject) && m.to.includes(fbAppr.email)); assert.ok(smtp.mails.some((m) => /2 new feedback/.test(m.subject))); ok('several findings in a short time arrive in a single mail');
    assert.equal((await admin.req('PATCH', `/api/teams/${T1}`, { feedbackMail: false })).data.team.feedbackMail, false);
    const nMails = smtp.mails.length;
    const quiet = JSON.parse((await call(fa, 'add_feedback', { spec_id: sid, kind: 'suggestion', text: 'no mail for this one' })).text);
    await new Promise((r) => setTimeout(r, 900)); assert.equal(smtp.mails.length, nMails); ok('team admins can switch the feedback e-mails off');
    await admin.req('PATCH', `/api/teams/${T1}`, { feedbackMail: true });
    // withdrawing: only your own, only while open
    const other = await mk('editor', 'fb2'); const otherTok = (await other.c.post('/api/me/tokens', { name: 'Other agent', scopes: ['mcp:read', 'mcp:drafts', 'mcp:write'], teamId: T1 })).data; const fo = await mcp(otherTok.token);
    assert.equal((await call(fo, 'withdraw_feedback', { id: quiet.id })).isError, true); ok('an agent cannot withdraw feedback of someone else');
    const wd = JSON.parse((await call(fa, 'withdraw_feedback', { id: quiet.id })).text); assert.equal(wd.status, 'withdrawn');
    assert.equal(JSON.parse((await call(fa, 'list_feedback', { status: 'withdrawn' })).text).length, 1);
    const oc = (await fbEd.c.sync([], 0)).data.feedbackOpen[sid]; assert.equal(oc, 4); ok('an agent can withdraw its own open feedback; withdrawn entries do not count as open');
    assert.match((await call(fa, 'withdraw_feedback', { id: f1.id })).text, /already accepted/); ok('feedback a person decided about cannot be withdrawn');
    await fo.close();
    await fa.close();
  }

  // ---------------------------------------------------------------- the gardener loop: work list, decisions, implementation reports, webhook
  {
    const hits = [];
    const sink = createHttpServer((req, res) => {
      let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
        hits.push({ url: req.url, headers: req.headers, body: JSON.parse(b || '{}') });
        if (req.url === '/fail') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"bad token"}'); }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'routine_fire', claude_code_session_id: 'session_1', claude_code_session_url: 'https://claude.ai/code/session_1' }));
      });
    });
    await new Promise((r) => sink.listen(0, '127.0.0.1', r));
    const sinkUrl = `http://127.0.0.1:${sink.address().port}`;
    const waitHits = async (count, ms = 4000) => { const t0 = Date.now(); while (hits.length < count && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50)); return hits.length; };
    const gEd = await mk('editor', 'g'); const gAp = await mk('approver', 'g'); const gView = await mk('viewer', 'g');
    const agTok = (await gEd.c.post('/api/me/tokens', { name: 'Builder agent', scopes: ['mcp:read', 'mcp:drafts', 'mcp:write'], teamId: T1 })).data;
    const roTok2 = (await gView.c.post('/api/me/tokens', { name: 'ro', scopes: ['mcp:read'], teamId: T1 })).data;
    const ag = await mcp(agTok.token); const ro = await mcp(roTok2.token);
    const roNames = await toolNames(ro); const agNames = await toolNames(ag);
    assert.ok(['get_work_list', 'get_spec_changes', 'list_reports', 'list_decisions'].every((x) => roNames.includes(x)) && !roNames.includes('report_implementation') && !roNames.includes('request_decision'));
    assert.ok(agNames.includes('report_implementation') && agNames.includes('request_decision')); ok('everyone reads the work list, reports and decisions; only writers report and ask');
    const syncUrl = `/api/teams/${T1}/sync`;
    const gid = `G${uniq.toUpperCase()}`;
    const release = async (body) => {
      const cur = (await gEd.c.sync([], 0)).data.items.find((x) => x.id === gid);
      const rr = await gAp.c.push([{ id: gid, kind: 'spec', baseRev: cur?.rev ?? 0, approve: true, fields: { title: 'Invoice export', body } }]);
      assert.equal(rr[0].item.status, 'approved', JSON.stringify(rr)); return rr[0].item;
    };
    await release('## GOAL\nExport invoices\n\n## ACCEPTANCE CRITERIA\n- [ ] CSV export\n- [ ] PDF export\n');
    const work = async (c = ro) => JSON.parse((await call(c, 'get_work_list')).text);
    let w = (await work()).work.find((x) => x.spec_id === gid);
    assert.equal(w.state, 'new'); assert.equal(w.version, 1); ok('a released spec without a report is new work');
    const draftId = JSON.parse((await call(ag, 'create_draft_spec', { title: 'Not released', body: '## GOAL\nx' })).text).id;
    assert.match((await call(ag, 'report_implementation', { spec_id: draftId, status: 'implemented', summary: 'x' })).text, /not released/); ok('reports are only accepted for released specs');

    // decisions: an agent asks, a person answers (also offline, through the sync)
    const q = { spec_id: gid, question: 'Which delimiter for the CSV export?', options: [{ label: 'Comma' }, { label: 'Semicolon', detail: 'Opens directly in a German Excel' }], recommended: 1, context: 'src/export.ts has no setting for it', section: '## ACCEPTANCE CRITERIA' };
    const d1 = JSON.parse((await call(ag, 'request_decision', q)).text);
    assert.equal(d1.status, 'open'); assert.equal(d1.blocking, true); assert.equal(d1.duplicate, false);
    assert.equal(JSON.parse((await call(ag, 'request_decision', { ...q, question: 'which delimiter  for the CSV export?' })).text).id, d1.id); ok('an agent asks for a decision; the same open question is not recorded twice');
    const refused = async (args) => { try { return (await ag.callTool({ name: 'request_decision', arguments: args })).isError === true; } catch { return true; } };
    assert.ok(await refused({ ...q, question: 'q2', options: [{ label: 'only one' }] })); assert.ok(await refused({ ...q, question: 'q3', recommended: 5 })); assert.ok(await refused({ ...q, question: 'q4', options: [{ label: 'A' }, { label: 'a ' }] })); ok('a decision needs 2–6 distinct options and a valid recommendation');
    assert.ok(!JSON.parse((await call(ag, 'list_feedback', { spec_id: gid })).text).some((f) => f.id === d1.id));
    let dl = JSON.parse((await call(ro, 'list_decisions', { spec_id: gid })).text);
    assert.equal(dl.length, 1); assert.equal(dl[0].status, 'open'); assert.equal(dl[0].options[1].recommended, true); assert.equal(dl[0].answer, undefined); ok('decisions are listed separately from feedback, with options and the recommendation');
    w = (await work()).work.find((x) => x.spec_id === gid); assert.equal(w.waiting_for_decision[0].id, d1.id); assert.equal(w.waiting_for_decision[0].blocking, true);
    const s1 = (await gEd.c.post(syncUrl, { since: 1e9, changes: [] })).data;
    const gd = s1.garden.feedback.find((f) => f.id === d1.id);
    assert.equal(gd.kind, 'decision'); assert.equal(gd.options.length, 2); assert.equal(gd.recommended, 1); assert.equal(s1.feedbackOpen[gid], 1);
    assert.equal((await gEd.c.post(syncUrl, { since: 1e9, changes: [], gardenRev: s1.garden.rev })).data.garden, undefined); ok('open decisions travel with the sync for offline use, and only when something changed');
    const vr = (await gView.c.post(syncUrl, { since: 1e9, changes: [], feedbackOps: [{ id: d1.id, answer: 0 }] })).data;
    assert.equal(vr.fbResults[0].ok, false); assert.equal((await gView.c.req('PATCH', `/api/teams/${T1}/feedback/${d1.id}`, { answer: 0 })).status, 403); ok('viewers cannot answer decisions');
    assert.equal((await gEd.c.req('PATCH', `/api/teams/${T1}/feedback/${d1.id}`, { answer: 9 })).status, 400);
    assert.equal((await gEd.c.req('PATCH', `/api/teams/${T1}/feedback/${d1.id}`, { answer: -1 })).status, 400);
    assert.equal((await gEd.c.req('PATCH', `/api/teams/${T1}/feedback/${d1.id}`, { status: 'answered' })).status, 400);
    assert.equal((await gEd.c.req('PATCH', `/api/teams/${T1}/feedback/${d1.id}`, { status: 'accepted' })).status, 400); ok('an answer must be one of the options, or an own answer in words');
    const s2 = (await gEd.c.post(syncUrl, { since: 1e9, changes: [], gardenRev: s1.garden.rev, feedbackOps: [{ id: d1.id, answer: 1, reply: 'Our customers use a German Excel.' }, { id: 'nope', status: 'done' }] })).data;
    assert.deepEqual(s2.fbResults.map((x) => x.ok), [true, false]);
    const ga = s2.garden.feedback.find((f) => f.id === d1.id); assert.equal(ga.status, 'answered'); assert.equal(ga.answer, 1); assert.match(ga.resolvedBy, /editor user/); assert.equal(s2.feedbackOpen[gid], undefined); ok('answers given offline arrive with the next sync; a refused one does not block the others');
    dl = JSON.parse((await call(ag, 'list_decisions', { id: d1.id })).text);
    assert.equal(dl[0].status, 'answered'); assert.deepEqual(dl[0].answer, { option: 1, label: 'Semicolon' }); assert.match(dl[0].note, /German Excel/); ok('the agent reads the answer (list_decisions)');
    w = (await work(ag)).work.find((x) => x.spec_id === gid); assert.equal(w.decisions_answered[0].answer, 'Semicolon'); assert.equal(w.waiting_for_decision, undefined);
    assert.match((await call(ag, 'withdraw_feedback', { id: d1.id })).text, /already answered/); ok('an answered decision shows up in the work list and can no longer be withdrawn');
    const d2 = JSON.parse((await call(ag, 'request_decision', { spec_id: gid, question: 'Paper size of the PDF?', options: ['A4', 'Letter'], blocking: false })).text);
    assert.equal(d2.blocking, false);
    const own = (await gEd.c.req('PATCH', `/api/teams/${T1}/feedback/${d2.id}`, { answer: -1, reply: 'Take it from the customer locale.' })).data.feedback;
    assert.equal(own.status, 'answered'); assert.equal(own.answer, -1);
    assert.deepEqual(JSON.parse((await call(ag, 'list_decisions', { id: d2.id })).text)[0].answer, { option: null, label: null });
    const reopened = (await gEd.c.req('PATCH', `/api/teams/${T1}/feedback/${d2.id}`, { status: 'open' })).data.feedback;
    assert.equal(reopened.status, 'open'); assert.equal(reopened.answer, null);
    assert.equal(JSON.parse((await call(ag, 'withdraw_feedback', { id: d2.id })).text).status, 'withdrawn');
    assert.equal((await gEd.c.req('PATCH', `/api/teams/${T1}/feedback/${d2.id}`, { answer: 0 })).status, 409); ok('own answers in words, reopening and withdrawing open questions work; a withdrawn question cannot be answered');

    // implementation reports
    const crit = [{ text: 'CSV export', status: 'met' }, { text: 'PDF export', status: 'open', note: 'needs a PDF library' }];
    assert.match((await call(ag, 'report_implementation', { spec_id: gid, status: 'implemented', summary: 'CSV done', criteria: crit })).text, /partial/); ok('a report with open criteria cannot claim "implemented"');
    assert.equal((await call(ag, 'report_implementation', { spec_id: gid, status: 'partial', summary: 'x', version: 7 })).isError, true);
    const r1 = JSON.parse((await call(ag, 'report_implementation', { spec_id: gid, status: 'partial', summary: 'CSV export works, PDF is open.', criteria: crit, evidence: [{ kind: 'commit', ref: 'abc1234', note: 'export module' }], deviations: 'Dates are ISO, not localized.' })).text);
    assert.equal(r1.status, 'partial'); assert.equal(r1.version, 1);
    const reps = (await gView.c.get(`/api/teams/${T1}/reports?spec=${gid}`)).data.reports;
    assert.equal(reps.length, 1); assert.equal(reps[0].criteria[1].status, 'open'); assert.equal(reps[0].evidence[0].ref, 'abc1234'); assert.match(reps[0].via, /Builder agent/); assert.match(reps[0].deviations, /ISO/); ok('an agent reports criteria, evidence and deviations; everyone in the team can read the report');
    w = (await work()).work.find((x) => x.spec_id === gid); assert.equal(w.state, 'partial'); assert.equal(w.last_report.status, 'partial');
    await call(ag, 'report_implementation', { spec_id: gid, status: 'implemented', summary: 'CSV and PDF export are done.', criteria: crit.map((c) => ({ text: c.text, status: 'met' })), evidence: [{ kind: 'pr', ref: 'https://git.example/pr/7' }] });
    const wl = await work(); assert.equal(wl.work.find((x) => x.spec_id === gid), undefined); assert.ok(wl.up_to_date >= 1);
    const s3 = (await gEd.c.post(syncUrl, { since: 1e9, changes: [] })).data;
    assert.equal(s3.garden.reports[gid].status, 'implemented'); assert.equal(s3.garden.reports[gid].specVersion, 1); ok('a spec with an "implemented" report for its current version leaves the work list; the latest report travels with the sync');
    assert.equal(JSON.parse((await call(ro, 'list_reports', { spec_id: gid })).text).length, 2);
    // a new release makes it work again, and shows what changed
    await release('## GOAL\nExport invoices\n\n## ACCEPTANCE CRITERIA\n- [ ] CSV export\n- [ ] PDF export\n- [ ] XLSX export\n\n## OUT OF SCOPE\nPrinting\n');
    w = (await work()).work.find((x) => x.spec_id === gid); assert.equal(w.state, 'changed'); assert.equal(w.changed_from, 1); assert.equal(w.version, 2);
    const ch = JSON.parse((await call(ro, 'get_spec_changes', { id: gid })).text);
    assert.equal(ch.from, 1); assert.equal(ch.to, 2); assert.deepEqual(ch.sections_changed, [{ section: 'ACCEPTANCE CRITERIA', change: 'changed' }, { section: 'OUT OF SCOPE', change: 'added' }]); assert.match(ch.diff, /\+- \[ \] XLSX export/);
    assert.equal((await call(ro, 'get_spec_changes', { id: gid, from: 2, to: 2 })).isError, true); assert.equal((await call(ro, 'get_spec_changes', { id: 'NOPE-9' })).isError, true); ok('a newer release puts the spec back on the work list as changed, with the changed sections and a diff');

    // webhook: tells an agent runner about releases and answers
    const hookOf = async (c = admin) => (await c.get(`/api/teams/${T1}`)).data.team.hook;
    assert.equal((await gEd.c.req('PATCH', `/api/teams/${T1}`, { hook: { url: `${sinkUrl}/fire` } })).status, 403); assert.equal(await hookOf(gEd.c), undefined); ok('only team admins see and change the webhook');
    assert.equal((await admin.post(`/api/teams/${T1}/hook/test`)).status, 400);
    assert.equal((await admin.req('PATCH', `/api/teams/${T1}`, { hook: { url: `${sinkUrl}/fire`, headers: 'Host: evil' } })).status, 400);
    assert.equal((await admin.req('PATCH', `/api/teams/${T1}`, { hook: { url: `${sinkUrl}/fire`, headers: 'no colon here' } })).status, 400);
    assert.equal((await admin.req('PATCH', `/api/teams/${T1}`, { hook: { url: 'ftp://x.example/y' } })).status, 400);
    assert.equal((await admin.req('PATCH', `/api/teams/${T1}`, { hook: { url: `${sinkUrl}/fire`, format: 'xml' } })).status, 400); ok('invalid webhook settings are refused');
    const saved = (await admin.req('PATCH', `/api/teams/${T1}`, { hook: { url: `${sinkUrl}/fire`, token: 'sk-hook-SECRET42', headers: 'anthropic-beta: experimental-cc-routine-2026-04-01\nanthropic-version: 2023-06-01', format: 'text', events: ['release', 'answer'] } })).data.team.hook;
    assert.equal(saved.hasToken, true); assert.deepEqual(saved.headerNames, ['anthropic-beta', 'anthropic-version']); assert.equal(saved.format, 'text');
    assert.ok(!JSON.stringify((await admin.get(`/api/teams/${T1}`)).data).includes('SECRET42')); assert.ok(!readFileSync(`${srv.dir}/specs.db`).includes('sk-hook-SECRET42')); ok('the webhook token is write-only and encrypted at rest');
    const tst = (await admin.post(`/api/teams/${T1}/hook/test`)).data;
    assert.equal(tst.ok, true); assert.equal(hits.length, 1); assert.equal(hits[0].headers.authorization, 'Bearer sk-hook-SECRET42'); assert.equal(hits[0].headers['anthropic-beta'], 'experimental-cc-routine-2026-04-01');
    assert.deepEqual(Object.keys(hits[0].body), ['text']); assert.equal(tst.hook.lastOk, true); assert.equal(tst.hook.lastUrl, 'https://claude.ai/code/session_1'); ok('the test call sends token, headers and a text-only body (Claude Code routine format) and records the answer');
    await release('## GOAL\nExport invoices\n\n## ACCEPTANCE CRITERIA\n- [ ] CSV export\n- [ ] PDF export\n- [ ] XLSX export\n- [ ] Totals row\n');
    const d3 = JSON.parse((await call(ag, 'request_decision', { spec_id: gid, question: 'Totals per currency?', options: ['Yes', 'No'] })).text);
    await gEd.c.req('PATCH', `/api/teams/${T1}/feedback/${d3.id}`, { answer: 0 });
    assert.equal(await waitHits(2), 2); await new Promise((r) => setTimeout(r, 500)); assert.equal(hits.length, 2);
    assert.match(hits[1].body.text, new RegExp(`${gid} v3: Invoice export`)); assert.match(hits[1].body.text, /Totals per currency\?" → Yes/); assert.match(hits[1].body.text, /get_work_list/); ok('a release and an answer shortly after each other reach the webhook as one call');
    await admin.req('PATCH', `/api/teams/${T1}`, { hook: { format: 'full', events: ['answer'] } });
    assert.equal((await hookOf()).hasToken, true);
    await release('## GOAL\nExport invoices\n\n## ACCEPTANCE CRITERIA\n- [ ] CSV export\n');
    await gEd.c.req('PATCH', `/api/teams/${T1}/feedback/${d3.id}`, { answer: 1, reply: 'changed my mind' });
    assert.equal(await waitHits(3), 3);
    assert.equal(hits[2].body.event, 'answer'); assert.equal(hits[2].body.released.length, 0); assert.equal(hits[2].body.answered[0].answer, 'No'); assert.equal(hits[2].body.team.key, 'SPEC'); assert.match(hits[2].body.mcpUrl, /\/mcp$/); ok('the full format carries structured data; events can be limited; a changed answer is sent again');
    await admin.req('PATCH', `/api/teams/${T1}`, { hook: { url: `${sinkUrl}/fail` } });
    const bad = (await admin.post(`/api/teams/${T1}/hook/test`)).data; assert.equal(bad.ok, false); assert.match(bad.hook.lastInfo, /HTTP 401/); assert.equal(bad.hook.lastOk, false); ok('a failing webhook is reported and recorded');
    const off = (await admin.req('PATCH', `/api/teams/${T1}`, { hook: { url: '' } })).data.team.hook;
    assert.equal(off.url, ''); assert.equal(off.hasToken, false); assert.deepEqual(off.headerNames, []); ok('removing the webhook URL also removes token and headers');
    await ag.close(); await ro.close(); sink.close();

    // by default a webhook never points into the server's own network
    const strict = await startServer({});
    try {
      const sa = new Client(strict.base); await sa.login('admin@localhost', 'adminpass1');
      for (const u of ['http://example.com/hook', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.1.2.3/x', 'https://192.168.1.10:8443/x', 'https://[::1]/x', 'https://169.254.169.254/latest', 'https://printer.local/x', 'https://user:pw@example.com/x'])
        assert.equal((await sa.req('PATCH', `/api/teams/${sa.tid}`, { hook: { url: u } })).status, 400, u);
      assert.equal((await sa.req('PATCH', `/api/teams/${sa.tid}`, { hook: { url: 'https://hooks.example.com/x' } })).status, 200); ok('webhooks must be https and must not target local or private addresses');
    } finally { strict.stop(); }
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
  // a colleague edits a released spec straight in the remote: that text was never approved here and must not reach agents
  git(dev, 'pull', '-q', 'origin', 'main');
  const f12 = path.join(dev, 'specs', 'SPEC-012.md'); writeFileSync(f12, readFileSync(f12, 'utf8') + '\nREMOTE-ONLY-EDIT\n');
  writeFileSync(path.join(dev, 'NOTES.md'), 'dev notes\n'); git(dev, 'add', '.'); git(dev, 'commit', '-m', 'edit in the remote'); git(dev, 'push', '-q', 'origin', 'HEAD:main');
  const mp = await admin.post(`${gitUrl}/push`); assert.equal(mp.status, 200, JSON.stringify(mp.data));
  const teamRepo = `${srv.dir}/repos/${T1}`;
  assert.ok(!readFileSync(path.join(teamRepo, 'specs', 'SPEC-012.md'), 'utf8').includes('REMOTE-ONLY-EDIT')); assert.ok(existsSync(path.join(teamRepo, 'NOTES.md')));
  ok('edits made in the remote below the managed folder do not reach agents; other files merge in');
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
  assert.match(git(`${srv.dir}/repos/${T1}`, 'log', '--format=%an|%s', '--no-merges', '-n', '8'), /approver user\|Release /); ok('git commit is authored by the approver');

  // review fixes: retries after a lost response, a re-created spec keeps counting versions
  {
    const ch = { id: 'SPEC-880', kind: 'spec', baseRev: 0, fields: { title: 'Retry me', body: 'one' } };
    let r = await admin.push([ch]); assert.equal(r[0].status, 'applied');
    r = await admin.push([ch]); assert.equal(r[0].status, 'applied'); assert.equal(r[0].item.title, 'Retry me'); ok('sync: the same change sent twice is applied once, not reported as a conflict');
    r = await admin.push([{ id: 'SPEC-880', kind: 'spec', baseRev: r[0].item.rev, approve: true, fields: { body: 'one' } }]); assert.equal(r[0].item.version, 1);
    r = await admin.push([{ id: 'SPEC-880', kind: 'spec', baseRev: r[0].item.rev, revoke: true }]);
    r = await admin.push([{ id: 'SPEC-880', kind: 'spec', baseRev: r[0].item.rev, delete: true }]); assert.equal(r[0].deleted, true);
    r = await admin.push([{ id: 'SPEC-880', kind: 'spec', baseRev: 0, fields: { title: 'Again', body: 'two' } }]);
    assert.equal(r[0].status, 'applied');
    r = await admin.push([{ id: 'SPEC-880', kind: 'spec', baseRev: r[0].item.rev, approve: true, fields: { body: 'two' } }]);
    assert.equal(r[0].item.version, 2); ok('a spec id that is used again continues its version numbers');
  }

  // webhook outbox: an event that could not be delivered survives a restart and is delivered afterwards
  {
    const dataDir = mkdtempSync(path.join(process.env.TEST_TMP || tmpdir(), 'specs-outbox-'));
    const probe = createHttpServer(); await new Promise((r) => probe.listen(0, '127.0.0.1', r)); const hookPort = probe.address().port; await new Promise((r) => probe.close(r));
    const env = { DATA_DIR: dataDir, HOOK_ALLOW_LOCAL: '1', HOOK_DEBOUNCE_MS: '100', SEED_DEMO: '0' };
    const a = await startServer(env);
    const ca = new Client(a.base); await ca.login('admin@localhost', 'adminpass1');
    assert.equal((await ca.req('PATCH', `/api/teams/${ca.tid}`, { hook: { url: `http://127.0.0.1:${hookPort}/fire`, format: 'full' } })).status, 200);
    const ra = await ca.push([{ id: 'SPEC-001', kind: 'spec', baseRev: 0, approve: true, fields: { title: 'Outbox spec', body: '## GOAL\nx\n' } }]);
    assert.equal(ra[0].item.version, 1);
    await new Promise((r) => setTimeout(r, 1200)); // one delivery attempt fails: nobody listens yet
    a.stop(); await new Promise((r) => setTimeout(r, 600));
    const got = [];
    const late = createHttpServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { got.push(JSON.parse(b || '{}')); res.writeHead(200); res.end('{}'); }); });
    await new Promise((r) => late.listen(hookPort, '127.0.0.1', r));
    const b = await startServer(env);
    try {
      for (let i = 0; i < 60 && !got.length; i++) await new Promise((r) => setTimeout(r, 250));
      assert.equal(got.length, 1); assert.equal(got[0].released[0].id, 'SPEC-001'); ok('a webhook event that could not be delivered is sent after a restart');
    } finally { b.stop(); late.close(); }
  }

  // glossary lookup: input is validated before any third party is asked; sign-in is required
  assert.equal((await admin.get('/api/lookup?q=a')).status, 400); ok('lookup: a too short term is rejected');
  assert.equal((await anon.get('/api/lookup?q=idempotence')).status, 401); ok('lookup: needs a sign-in');

  // ================================================================ security review fixes (SECURITY_FINDINGS.md)
  { // SEC-01: a symbolic link coming from the git remote must not lead out of the team's repository
    const outside = path.join(srv.dir, 'outside-target'); mkdirSync(outside, { recursive: true });
    const lremote = path.join(tmp, 'link-remote.git'); git(tmp, 'init', '--bare', '-b', 'main', lremote);
    const lwork = path.join(tmp, 'link-work'); git(tmp, 'clone', lremote, lwork); git(lwork, 'config', 'user.email', 'a@x'); git(lwork, 'config', 'user.name', 'A');
    git(lwork, 'checkout', '-b', 'main'); symlinkSync(outside, path.join(lwork, 'a')); git(lwork, 'add', '.'); git(lwork, 'commit', '-m', 'link'); git(lwork, 'push', 'origin', 'main');
    const lt = (await admin.post('/api/teams', { name: 'Linked', key: 'LNK' })).data.team;
    const lg = `/api/teams/${lt.id}/git`;
    assert.equal((await admin.req('PUT', lg, { url: lremote, branch: 'main', root: 'a/pwned', auth: 'none', autoPush: false })).status, 200);
    let rr = await admin.push([{ id: 'LNK-1', kind: 'spec', baseRev: 0, approve: true, fields: { title: 'One', body: 'first' } }], lt.id); assert.equal(rr[0].status, 'applied');
    rr = await admin.push([{ id: 'LNK-1', kind: 'spec', baseRev: rr[0].item.rev, revoke: true }], lt.id); assert.equal(rr[0].status, 'applied'); // (a tree that already has files below `a/` cannot merge a link named `a`)
    { const pr = await admin.post(`${lg}/push`); assert.equal(pr.status, 200, JSON.stringify(pr.data)); } // merges the remote, link included
    rr = await admin.push([{ id: 'LNK-1', kind: 'spec', baseRev: rr[0].item.rev, approve: true, fields: { body: 'second' } }], lt.id);
    assert.equal(existsSync(path.join(outside, 'pwned')), false, 'nothing may be written through the link');
    assert.equal(readdirOutside(outside).length, 0);
    const wt = path.join(srv.dir, 'repos', lt.id);
    assert.equal(existsSync(path.join(wt, 'a')) ? lstatSync(path.join(wt, 'a')).isSymbolicLink() : false, false);
    assert.doesNotMatch(git(wt, 'ls-files', '-s'), /^120000/m); ok('SEC-01: symbolic links from a git remote never reach the working tree and nothing is written outside the repository');
    function readdirOutside(d) { return execFileSync('ls', ['-A', d], { encoding: 'utf8' }).split('\n').filter(Boolean); }
  }

  { // SEC-02: git remotes in private networks are refused
    const sg = `/api/teams/${T1}/git`;
    for (const u of ['https://127.0.0.1/x.git', 'https://[::1]/x.git', 'https://localhost/x.git', 'https://10.0.0.5/x.git', 'https://169.254.169.254/x.git', 'https://[::ffff:127.0.0.1]/x.git', 'https://intranet/x.git', 'git@localhost:x.git', 'git@192.168.1.5:x.git', 'ssh://git@10.1.2.3/x.git'])
      assert.equal((await admin.req('PUT', sg, { url: u, branch: 'main', root: 'specs', auth: 'none' })).status, 400, u);
    assert.equal((await admin.req('PUT', sg, { url: 'https://git.example/org/repo.git', branch: 'main', root: 'specs', auth: 'none' })).status, 200);
    ok('SEC-02: git remote URLs that point into a private or local network are rejected');
  }

  { // SEC-03: X-Forwarded-For is only believed for the configured number of proxies
    const px = await startServer({ TRUST_PROXY: '1', SEED_DEMO: '0' });
    try {
      const codes = [];
      for (let i = 0; i < 13; i++) codes.push((await new Client(px.base).req('POST', '/api/auth/login', { email: 'admin@localhost', password: `wrong-${i}` }, { 'x-forwarded-for': `1.2.3.${i}, 9.9.9.9` })).status);
      assert.ok(codes.includes(429), codes.join(',')); ok('SEC-03: a client-supplied X-Forwarded-For entry does not escape the login throttle');
      const open = await startServer({ SEED_DEMO: '0' }); // no proxy configured: the header is ignored altogether
      try {
        const c2 = []; for (let i = 0; i < 12; i++) c2.push((await new Client(open.base).req('POST', '/api/auth/login', { email: 'admin@localhost', password: `wrong-${i}` }, { 'x-forwarded-for': `5.5.5.${i}` })).status);
        assert.ok(c2.includes(429)); ok('SEC-03: without TRUST_PROXY the header is ignored');
      } finally { open.stop(); }
    } finally { px.stop(); }
  }

  { // SEC-06: stored credentials are bound to the server they were entered for
    const cg = `/api/teams/${T1}/git`;
    assert.equal((await admin.req('PUT', cg, { url: 'https://git.example/org/a.git', branch: 'main', root: 'specs', auth: 'token', username: 'bot', token: 'tok-1' })).data.git.hasSecret, true);
    assert.equal((await admin.req('PUT', cg, { url: 'https://git.example/org/b.git', branch: 'main', root: 'specs', auth: 'token', username: 'bot' })).data.git.hasSecret, true); // same server: kept
    assert.equal((await admin.req('PUT', cg, { url: 'https://attacker.example/org/b.git', branch: 'main', root: 'specs', auth: 'token', username: 'bot' })).data.git.hasSecret, false); ok('SEC-06: a git token is dropped when the repository moves to another server');
    const hk = (b) => admin.req('PATCH', `/api/teams/${T1}`, { hook: b });
    const hv = async () => (await admin.get(`/api/teams/${T1}`)).data.team.hook;
    await hk({ url: 'http://127.0.0.1:41111/a', token: 'hook-secret-1', headers: 'X-Test: 1' });
    await hk({ url: 'http://127.0.0.1:41111/b' }); let h = await hv(); assert.equal(h.hasToken, true); assert.deepEqual(h.headerNames, ['X-Test']);
    await hk({ url: 'http://127.0.0.1:42222/b' }); h = await hv(); assert.equal(h.hasToken, false); assert.deepEqual(h.headerNames, []); ok('SEC-06: webhook token and extra headers are dropped when the receiver changes');
    await hk({ url: '' });
  }

  { // SEC-07: security headers
    const hdr = (await fetch(`${BASE}/api/auth/config`)).headers;
    assert.match(hdr.get('content-security-policy'), /default-src 'self'/); assert.match(hdr.get('content-security-policy'), /script-src 'self'(;|$)/); assert.match(hdr.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(hdr.get('x-frame-options'), 'DENY'); assert.equal(hdr.get('cross-origin-opener-policy'), 'same-origin'); assert.match(hdr.get('permissions-policy'), /camera=\(\)/);
    const oa = (await fetch(`${BASE}/oauth/consent?request=none`)).headers.get('content-security-policy'); assert.ok(oa && !/form-action/.test(oa)); ok('SEC-07: CSP, frame and opener protection are sent (the consent page may redirect to the agent)');
    const https = await startServer({ PUBLIC_URL: 'https://garten.example', SEED_DEMO: '0' });
    try { assert.match((await fetch(`${https.base}/healthz`)).headers.get('strict-transport-security') ?? '', /max-age=\d+/); ok('SEC-07: HSTS is sent when the public address is https'); } finally { https.stop(); }
  }

  { // SEC-08, SEC-15: password change ends the other sessions; logout needs the CSRF header; sessions are listed and can be ended; idle sessions expire
    const u = await mk('editor', 'sec'); const mail = u.email;
    const other = new Client(BASE); await other.login(mail, 'password-editor');
    assert.equal((await u.c.get('/api/me/sessions')).data.sessions.filter((x) => x.current).length, 1);
    assert.equal((await u.c.post('/api/me/password', { current: 'wrong-current', password: 'brand-new-pass-1' })).status, 403);
    assert.equal((await u.c.post('/api/me/password', { current: 'password-editor', password: 'brand-new-pass-1' })).status, 200);
    assert.equal((await other.get('/api/me')).status, 401); assert.equal((await u.c.get('/api/me')).status, 200);
    assert.equal((await new Client(BASE).post('/api/auth/login', { email: mail, password: 'password-editor' })).status, 401);
    const again = new Client(BASE); await again.login(mail, 'brand-new-pass-1'); ok('SEC-08: changing the password ends all other sessions (this device stays signed in)');
    assert.equal((await again.req('POST', '/api/auth/logout', undefined, { 'x-specs': '0' })).status, 403); assert.equal((await again.get('/api/me')).status, 200);
    const list = (await again.get('/api/me/sessions')).data.sessions; const mine = list.find((x) => x.current); const foreign = list.find((x) => !x.current);
    assert.ok(mine && foreign); assert.equal((await again.del(`/api/me/sessions/${foreign.id}`)).data.ok, true);
    const db = new DatabaseSync(`${srv.dir}/specs.db`);
    db.prepare('UPDATE sessions SET last_seen_at=? WHERE id=?').run(Math.floor(Date.now() / 1000) - 40 * 86400, mine.id); db.close();
    assert.equal((await again.get('/api/me')).status, 401); ok('SEC-15: logout needs the CSRF header; sessions can be listed and ended; idle sessions expire');
  }

  { // SEC-11: audit log
    const log = (await admin.get('/api/admin/audit?limit=500')).data.entries; const acts = new Set(log.map((e) => e.action));
    for (const a of ['auth.login', 'auth.login.failed', 'team.create', 'team.git.update', 'user.create', 'token.create', 'user.password.change']) assert.ok(acts.has(a), a);
    assert.ok(!JSON.stringify(log).match(/tok-1|ghp_SECRET123|hook-secret-1|brand-new-pass|password-editor/)); assert.equal((await viewer.c.get('/api/admin/audit')).status, 403);
    await admin.req('PUT', `/api/teams/${T1}/git`, { url: `https://git.example/${'long/'.repeat(600)}r.git`, branch: 'main', root: 'specs', auth: 'none' }); // a very long value must not break the log
    const big = await admin.get('/api/admin/audit?limit=5'); assert.equal(big.status, 200); assert.ok(big.data.entries.some((e) => e.action === 'team.git.update' && e.detail.url.length <= 300)); ok('SEC-11: security-relevant actions are logged without secrets; only instance admins read the log');
  }

  { // SEC-12: malformed input does not crash the server
    const ctrl = await admin.sync([null, 5, 'x', { id: 7 }, { id: 'S-1', kind: 'nope' }, { id: 'SPEC-701', kind: 'spec', baseRev: 0, fields: { title: 5 } }, { id: 'SPEC-702', kind: 'spec', baseRev: 0, fields: { title: 'ok', links: 'no' } }, { id: 'SPEC-703', kind: 'spec', baseRev: 0, fields: { title: 'x'.repeat(301) } }]);
    assert.equal(ctrl.status, 200); assert.ok(ctrl.data.results.every((r) => r.status === 'error'), JSON.stringify(ctrl.data.results));
    assert.equal((await admin.post(`/api/teams/${T1}/sync`, { changes: 'nope' })).status, 400);
    assert.equal((await fetch(`${BASE}/api/me`, { headers: { cookie: 'specs_sid=%E0%A4%A' } })).status, 401); ok('SEC-12: malformed changes and cookies are answered with 4xx, not 500');
  }

  { // SEC-13: password policy, upgrade of old hashes
    for (const pw of ['short', 'password123', 'aaaaaaaaaaaa', 'x'.repeat(300)]) assert.equal((await admin.post('/api/users', { email: `pol-${uniq}@example.com`, password: pw })).status, 400, pw.slice(0, 12));
    assert.equal((await admin.post('/api/users', { email: 'bad"mail@example.com', password: 'a-good-password-1' })).status, 400); assert.equal((await admin.post('/api/users', { email: 'a@b.c>', password: 'a-good-password-1' })).status, 400);
    const email = `legacy-${uniq}@example.com`; const mkU = await admin.post('/api/users', { email, password: 'old-legacy-pass-1' }); assert.equal(mkU.status, 200);
    const salt = randomBytes(16); const legacy = `scrypt$${salt.toString('base64')}$${scryptSync('old-legacy-pass-1', salt, 64).toString('base64')}`;
    const db = new DatabaseSync(`${srv.dir}/specs.db`); db.prepare('UPDATE users SET password_hash=? WHERE email=?').run(legacy, email);
    await new Client(BASE).login(email, 'old-legacy-pass-1');
    assert.match(db.prepare('SELECT password_hash h FROM users WHERE email=?').get(email).h, /^scrypt\$65536\$8\$2\$/); db.close(); ok('SEC-13: weak passwords and odd e-mail addresses are refused; old password hashes are upgraded at sign-in');
    const inv = await admin.post(`/api/teams/${T1}/invites`, { email: `nopw-${uniq}@example.com`, role: 'viewer' }); const tkn = inv.data.link.split('/invite/')[1];
    assert.equal((await anon.post(`/api/invites/${tkn}/accept`, { name: 'No Password' })).status, 400); ok('SEC-13: an invitation cannot create an account without a password');
  }

  { // SEC-16: files are private to the service user
    assert.equal(statSync(`${srv.dir}/specs.db`).mode & 0o077, 0); assert.equal(statSync(`${srv.dir}/secret.key`).mode & 0o077, 0); ok('SEC-16: database and key file are not readable by others');
  }

  { // SEC-21: signed webhooks, sanitised texts
    const seen = []; const sink = createHttpServer((rq, rs) => { let b = ''; rq.on('data', (d) => (b += d)); rq.on('end', () => { seen.push({ h: rq.headers, b }); rs.writeHead(200); rs.end('{}'); }); });
    await new Promise((r) => sink.listen(0, '127.0.0.1', r));
    await admin.req('PATCH', `/api/teams/${T1}`, { hook: { url: `http://127.0.0.1:${sink.address().port}/x`, token: 'sig-secret-9', events: ['release', 'answer'], format: 'full' } });
    await admin.post(`/api/teams/${T1}/hook/test`);
    const m = seen[0]; const { createHmac } = await import('node:crypto');
    assert.equal(m.h['x-specs-signature'], `sha256=${createHmac('sha256', 'sig-secret-9').update(`${m.h['x-specs-timestamp']}.${m.b}`).digest('hex')}`); assert.ok(Math.abs(Date.now() / 1000 - Number(m.h['x-specs-timestamp'])) < 30);
    await admin.req('PATCH', `/api/teams/${T1}`, { hook: { url: '' } }); sink.close(); ok('SEC-21: webhook calls carry a timestamp and an HMAC signature');
  }

  console.log(`\n${n} checks passed`);
} finally {
  srv.stop();
  smtp.stop();
}
