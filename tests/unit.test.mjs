// Unit tests of the security helpers: network guard, validation, rate limiter, secrets, repository path safety, cleanup.
//   node --test tests/unit.test.mjs
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdtempSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { missing, chain } from './helpers.mjs';

const dataDir = mkdtempSync(path.join(process.env.TEST_TMP || tmpdir(), 'specs-unit-'));
process.env.DATA_DIR = dataDir;
process.env.SECRET_KEY = 'unit-test-secret-key';

test('netguard: private, loopback, mapped and metadata addresses are recognised', async () => {
  const { isPrivate, isPrivateHostLiteral, gitHost, assertPublicRemote } = await import('../server/netguard.js');
  for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.0.9', '169.254.169.254', '100.64.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'not-an-ip']) assert.equal(isPrivate(a), true, a);
  for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPrivate(a), false, a);
  for (const h of ['localhost', 'printer.local', 'db.internal', 'intranet', '[::1]', '127.0.0.1', '']) assert.equal(isPrivateHostLiteral(h), true, h);
  for (const h of ['github.com', 'git.example.org', '8.8.8.8']) assert.equal(isPrivateHostLiteral(h), false, h);
  assert.equal(gitHost('https://user@Git.Example.com:8443/x.git'), 'git.example.com'); assert.equal(gitHost('git@host.example:org/r.git'), 'host.example'); assert.equal(gitHost('/srv/repo.git'), null);
  await assert.rejects(() => assertPublicRemote('https://127.0.0.1/x.git', false)); await assert.rejects(() => assertPublicRemote('git@localhost:x.git', false));
  await assertPublicRemote('https://127.0.0.1/x.git', true); await assertPublicRemote('/srv/repo.git', false);
});

test('validate: e-mail addresses and password policy', async () => {
  const { isEmail, passwordProblem } = await import('../server/validate.js');
  for (const e of ['a@b.co', 'first.last+tag@sub.example.com', 'admin@localhost']) assert.equal(isEmail(e), true, e);
  for (const e of ['"a b"@x.y', 'a@b.c>', 'a(comment)@b.co', 'a@b.co;c@d.co', 'a,b@c.de', 'a b@c.de', '<a@b.co>', 'a@', '@b.co', 'a@b..co', `${'x'.repeat(250)}@b.co`]) assert.equal(isEmail(e), false, e);
  assert.ok(passwordProblem('short')); assert.ok(passwordProblem('password123')); assert.ok(passwordProblem('admin-demo-1')); assert.ok(passwordProblem('x'.repeat(257))); assert.equal(passwordProblem('a-long-enough-pass'), null);
});

test('ratelimit: window, reset, key bound and sweeping', async () => {
  const { Limiter } = await import('../server/ratelimit.js');
  const lim = new Limiter({ windowMs: 50, max: 2, maxKeys: 3 });
  assert.equal(lim.hit('a'), true); assert.equal(lim.hit('a'), true); assert.equal(lim.hit('a'), false); lim.reset('a'); assert.equal(lim.hit('a'), true);
  for (const k of ['b', 'c', 'd', 'e']) lim.hit(k); assert.ok(lim.hitsByKey.size <= 3);
  await new Promise((r) => setTimeout(r, 120)); lim.sweep(); assert.equal(lim.hitsByKey.size, 0);
});

// secrets: v1 blobs (SHA-256 key) stay readable, new ones are v2
test('secrets: v2 encryption, v1 still readable', async () => {
  const { encrypt, decrypt } = await import('../server/secrets.js');
  const k1 = createHash('sha256').update('unit-test-secret-key').digest(); const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', k1, iv);
  const enc = Buffer.concat([c.update('old token', 'utf8'), c.final()]); const v1 = `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
  assert.equal(decrypt(v1), 'old token'); const v2 = encrypt('new token'); assert.match(v2, /^v2\./); assert.equal(decrypt(v2), 'new token'); assert.notEqual(encrypt('x'), encrypt('x')); assert.throws(() => decrypt('v9.a.b.c'));
});

test('repo: links are refused, removed from the index and never followed', { skip: missing('git') }, async () => {
  const { Repo } = await import('../server/git.js');
  const root = mkdtempSync(path.join(tmpdir(), 'specs-repo-')); const outside = mkdtempSync(path.join(tmpdir(), 'specs-out-'));
  const repo = new Repo(path.join(root, 'r')); await repo.ensure();
  symlinkSync(outside, path.join(repo.dir, 'link')); symlinkSync(path.join(outside, 'x.md'), path.join(repo.dir, 'leaf.md'));
  assert.throws(() => repo.safe('link/x.md'), /symbolic link/); assert.throws(() => repo.safe('link'), /symbolic link/); assert.throws(() => repo.safe('../x'), /unsafe/); assert.throws(() => repo.safe('leaf.md'), /symbolic link/);
  assert.doesNotThrow(() => repo.safe('leaf.md', true)); assert.doesNotThrow(() => repo.safe('specs/new/file.md'));
  await assert.rejects(() => repo.commit({ write: { 'link/pwned.md': 'x' }, message: 'x' })); assert.equal(existsSync(path.join(outside, 'pwned.md')), false);
  for (const name of ['link', 'leaf.md']) { // links that got into the index (e.g. via a merge) are removed again
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo.dir, input: outside, encoding: 'utf8' }).trim();
    await repo.raw(null, 'update-index', '--add', '--cacheinfo', `120000,${blob},${name}`);
  }
  assert.deepEqual((await repo.dropLinks()).sort(), ['leaf.md', 'link'].sort()); assert.equal(existsSync(path.join(repo.dir, 'link')), false);
  writeFileSync(path.join(outside, 'keep.txt'), 'still here'); assert.equal(existsSync(path.join(outside, 'keep.txt')), true);
});

test('janitor: expired sessions, requests and unused clients are removed', async () => {
  const { db } = await import('../server/db.js');
  const { audit, listAudit } = await import('../server/audit.js');
  const { sweepExpired } = await import('../server/janitor.js');
  const t = Math.floor(Date.now() / 1000);
  db.prepare("INSERT INTO users (id,email,name,created_at) VALUES ('u1','u@x.co','U','x')").run();
  db.prepare("INSERT INTO sessions (id,user_id,expires_at,created_at) VALUES ('old','u1',?, 'x'), ('new','u1',?, 'x')").run(t - 10, t + 1000);
  db.prepare("INSERT INTO oauth_requests (id,client_id,data,expires_at) VALUES ('r1','c','{}',?)").run(t - 10);
  db.prepare("INSERT INTO oauth_clients (client_id,data,created_at) VALUES ('stale','{}',?), ('fresh','{}',?)").run(new Date(Date.now() - 40 * 86400_000).toISOString(), new Date().toISOString());
  audit(null, 'unit.test', { target: 't' }); assert.equal(listAudit({ action: 'unit' }).length, 1);
  sweepExpired();
  assert.deepEqual(db.prepare('SELECT id FROM sessions').all().map((r) => r.id), ['new']); assert.equal(db.prepare('SELECT COUNT(*) n FROM oauth_requests').get().n, 0);
  assert.deepEqual(db.prepare('SELECT client_id FROM oauth_clients').all().map((r) => r.client_id), ['fresh']);
});

// criteria: the checklist a report is held against
test('criteria: requirements and acceptance items get stable ids; fences and other sections are ignored; reports match by id or text', async () => {
  const { specCriteria, findCriterion } = await import('../shared/criteria.js');
  const md = '---\nid: X\n---\n\n# X\n\n## REQUIREMENTS\nR1 Keys rotate.\nR2 Window is 24h\n\n- not a criterion\n\n## ACCEPTANCE CRITERIA\n- [ ] Old key accepted\n- [x] **Revoked** key rejected\n* plain bullet\n\n```\n- [ ] in a fence\nR9 in a fence\n```\n\n## Definition of done\n- Docs updated\n\n## OUT OF SCOPE\n- Printing\n';
  const c = specCriteria(md);
  assert.deepEqual(c.map((x) => x.id), ['R1', 'R2', 'AC1', 'AC2', 'AC3', 'AC4']);
  assert.equal(c[3].text, '**Revoked** key rejected'); assert.equal(c[5].section, 'Definition of done');
  assert.equal(findCriterion(c, { id: 'r2' }).id, 'R2'); assert.equal(findCriterion(c, { text: 'R1: keys rotate' }).id, 'R1');
  assert.equal(findCriterion(c, { text: 'revoked key rejected.' }).id, 'AC2'); assert.equal(findCriterion(c, { text: 'AC1 – done' }).id, 'AC1');
  assert.equal(findCriterion(c, { text: 'Verified: old key accepted for 24 h' }).id, 'AC1'); assert.equal(findCriterion(c, { text: 'Something else' }), null);
  assert.deepEqual(specCriteria('## GOAL\nnothing\n'), []);
});

// guardrails: rules and what changed since a report
test('guardrails: rules are parsed by section; new and reworded rules count, whitespace and removed rules do not', async () => {
  const { parseRules, ruleSnapshot, rulesChanged } = await import('../shared/guardrails.js');
  const md = '# Guardrails\n\n<!-- - G9: in a comment -->\n## Always\n- G1: Verify signatures.\n* G2) Log in UTC\n\n## Never\n- G3: Log secrets.\n- G3: duplicate\n```\n- G7: in a fence\n```\n';
  const r = parseRules(md);
  assert.deepEqual(r.map((x) => [x.id, x.kind, x.text]), [['G1', 'always', 'Verify signatures.'], ['G2', 'always', 'Log in UTC'], ['G3', 'never', 'Log secrets.']]);
  const snap = ruleSnapshot(r.slice(0, 2));
  assert.deepEqual(rulesChanged(r, snap).map((x) => [x.id, x.change]), [['G3', 'added']]);
  assert.deepEqual(rulesChanged(parseRules('- G1: Verify  signatures.\n- G2: Log in local time\n'), snap).map((x) => [x.id, x.change]), [['G2', 'changed']]);
  assert.deepEqual(rulesChanged(r, null), []);
});

// bounded history: reports per spec, closed feedback
describe('bounded history', () => {
  const step = chain();
  const ago = (days) => new Date(Date.now() - days * 86400_000).toISOString();
  step('reports: the newest per spec are kept, latestReports picks the newest of every spec', async () => {
    const { db, REPORTS_KEPT } = await import('../server/db.js');
    const { addReport, latestReports, listReports } = await import('../server/reports.js');
    db.prepare("INSERT INTO teams (id,key,name,created_at) VALUES ('tp','TP','Prune',?)").run(ago(0));
    for (const id of ['P-1', 'P-2']) db.prepare("INSERT INTO items (team_id,id,kind,title,rev,seq,status,version,created_at,updated_at) VALUES ('tp',?,'spec','x',1,1,'approved',1,?,?)").run(id, ago(0), ago(0));
    for (let i = 0; i < REPORTS_KEPT + 5; i++) await addReport({ id: 'tp' }, { specId: 'P-1', status: 'in_progress', summary: `step ${i}` }, { name: 'agent' });
    await addReport({ id: 'tp' }, { specId: 'P-2', status: 'implemented', summary: 'done' }, { name: 'agent' });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM reports WHERE spec_id='P-1'").get().n, REPORTS_KEPT); assert.equal(listReports('tp', { specId: 'P-1' }).at(-1).summary, 'step 5');
    const latest = latestReports('tp'); assert.equal(latest['P-1'].summary, `step ${REPORTS_KEPT + 4}`); assert.equal(latest['P-2'].summary, 'done');
  });
  step('janitor: old closed feedback beyond 100 per spec goes; open entries and decisions stay', async () => {
    const { db } = await import('../server/db.js');
    const { sweepExpired } = await import('../server/janitor.js');
    db.prepare("DELETE FROM reports WHERE team_id='tp'").run();
    db.prepare("INSERT INTO reports (id,team_id,spec_id,spec_version,status,created_at) VALUES ('rp','tp','P-1',1,'implemented',?)").run(ago(5));
    const fb = db.prepare("INSERT INTO feedback (id,team_id,spec_id,kind,text,status,created_at,resolved_at) VALUES (?,'tp','P-1',?,'x',?,?,?)");
    for (let i = 0; i < 104; i++) fb.run(`d${i}`, 'concern', 'dismissed', ago(400), ago(200 + i));
    fb.run('ans', 'decision', 'answered', ago(400), ago(310)); // a person's decision: kept, however old
    fb.run('open', 'question', 'open', ago(900), null);
    sweepExpired();
    const left = new Set(db.prepare("SELECT id FROM feedback WHERE team_id='tp'").all().map((r) => r.id));
    assert.equal(left.size, 102); assert.ok(left.has('ans') && left.has('open') && left.has('d99') && !left.has('d100') && !left.has('d103'));
  });
});

// schema migrations: databases without a recorded version (earlier releases) are upgraded
test('migrations: a v0.3 database without a schema version is brought to the current schema; a newer one is refused', async () => {
  const { db, SCHEMA_VERSION } = await import('../server/db.js');
  const old = mkdtempSync(path.join(process.env.TEST_TMP || tmpdir(), 'specs-old-'));
  const odb = new (await import('node:sqlite')).DatabaseSync(path.join(old, 'specs.db'));
  odb.exec(`CREATE TABLE teams (id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, created_at TEXT NOT NULL, git_url TEXT, git_branch TEXT NOT NULL DEFAULT 'main', git_root TEXT NOT NULL DEFAULT 'specs',
    git_auth TEXT NOT NULL DEFAULT 'none', git_username TEXT, git_secret TEXT, git_ssh_public TEXT, git_auto_push INTEGER NOT NULL DEFAULT 1, git_last_push_at TEXT, git_last_ok INTEGER, git_last_error TEXT, git_last_sha TEXT);
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, admin INTEGER NOT NULL DEFAULT 0, password_hash TEXT, oidc_sub TEXT UNIQUE, disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_login_at TEXT);
    CREATE TABLE items (team_id TEXT NOT NULL, id TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', links TEXT NOT NULL DEFAULT '[]',
      rev INTEGER NOT NULL, seq INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'draft', version INTEGER NOT NULL DEFAULT 0, released_rev INTEGER NOT NULL DEFAULT 0, released_at TEXT, released_by TEXT, updated_by TEXT, fetched_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (team_id, id));
    INSERT INTO teams (id,key,name,created_at) VALUES ('t3','OLD','Old','x');
    INSERT INTO items (team_id,id,kind,title,body,rev,seq,created_at,updated_at) VALUES ('t3','OLD-001','spec','Kept','body',1,1,'x','x');`); // the v0.3 schema
  odb.close();
  const openWith = (dir) => execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('../server/db.js', import.meta.url).href)})`], { env: { ...process.env, DATA_DIR: dir, NODE_NO_WARNINGS: '1' }, stdio: 'pipe' });
  openWith(old); openWith(old); // the second start finds nothing to do
  const up = new (await import('node:sqlite')).DatabaseSync(path.join(old, 'specs.db'));
  assert.equal(up.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  const cols = (db2, t2) => db2.prepare(`SELECT name FROM pragma_table_info('${t2}') ORDER BY name`).all().map((r) => r.name).join();
  for (const t2 of ['items', 'teams', 'feedback', 'reports', 'checks', 'sessions', 'oauth_tokens', 'agent_activity', 'claims', 'spec_steering']) assert.equal(cols(up, t2), cols(db, t2), t2);
  assert.equal(up.prepare("SELECT title FROM items WHERE id='OLD-001'").get().title, 'Kept'); assert.ok(up.prepare("SELECT 1 FROM sqlite_master WHERE name='items_fetched'").get());
  up.exec('PRAGMA user_version = 99'); up.close();
  assert.throws(() => openWith(old), /newer version/);
});
