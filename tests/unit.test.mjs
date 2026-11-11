// Unit tests of the security helpers: network guard, validation, rate limiter, secrets, repository path safety, cleanup.
//   node tests/unit.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';

const dataDir = mkdtempSync(path.join(process.env.TEST_TMP || tmpdir(), 'specs-unit-'));
process.env.DATA_DIR = dataDir;
process.env.SECRET_KEY = 'unit-test-secret-key';
let n = 0; const ok = (m) => console.log(`ok ${++n} - ${m}`);

// ---- netguard
const { isPrivate, isPrivateHostLiteral, gitHost, assertPublicRemote } = await import('../server/netguard.js');
for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.0.9', '169.254.169.254', '100.64.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'not-an-ip']) assert.equal(isPrivate(a), true, a);
for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPrivate(a), false, a);
for (const h of ['localhost', 'printer.local', 'db.internal', 'intranet', '[::1]', '127.0.0.1', '']) assert.equal(isPrivateHostLiteral(h), true, h);
for (const h of ['github.com', 'git.example.org', '8.8.8.8']) assert.equal(isPrivateHostLiteral(h), false, h);
assert.equal(gitHost('https://user@Git.Example.com:8443/x.git'), 'git.example.com'); assert.equal(gitHost('git@host.example:org/r.git'), 'host.example'); assert.equal(gitHost('/srv/repo.git'), null);
await assert.rejects(() => assertPublicRemote('https://127.0.0.1/x.git', false)); await assert.rejects(() => assertPublicRemote('git@localhost:x.git', false));
await assertPublicRemote('https://127.0.0.1/x.git', true); await assertPublicRemote('/srv/repo.git', false); ok('netguard: private, loopback, mapped and metadata addresses are recognised');

// ---- validate
const { isEmail, passwordProblem } = await import('../server/validate.js');
for (const e of ['a@b.co', 'first.last+tag@sub.example.com', 'admin@localhost']) assert.equal(isEmail(e), true, e);
for (const e of ['"a b"@x.y', 'a@b.c>', 'a(comment)@b.co', 'a@b.co;c@d.co', 'a,b@c.de', 'a b@c.de', '<a@b.co>', 'a@', '@b.co', 'a@b..co', `${'x'.repeat(250)}@b.co`]) assert.equal(isEmail(e), false, e);
assert.ok(passwordProblem('short')); assert.ok(passwordProblem('password123')); assert.ok(passwordProblem('admin-demo-1')); assert.ok(passwordProblem('x'.repeat(257))); assert.equal(passwordProblem('a-long-enough-pass'), null); ok('validate: e-mail addresses and password policy');

// ---- rate limiter
const { Limiter } = await import('../server/ratelimit.js');
const lim = new Limiter({ windowMs: 50, max: 2, maxKeys: 3 });
assert.equal(lim.hit('a'), true); assert.equal(lim.hit('a'), true); assert.equal(lim.hit('a'), false); lim.reset('a'); assert.equal(lim.hit('a'), true);
for (const k of ['b', 'c', 'd', 'e']) lim.hit(k); assert.ok(lim.hitsByKey.size <= 3);
await new Promise((r) => setTimeout(r, 120)); lim.sweep(); assert.equal(lim.hitsByKey.size, 0); ok('ratelimit: window, reset, key bound and sweeping');

// ---- secrets: v1 blobs (SHA-256 key) stay readable, new ones are v2
const { encrypt, decrypt } = await import('../server/secrets.js');
const k1 = createHash('sha256').update('unit-test-secret-key').digest(); const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', k1, iv);
const enc = Buffer.concat([c.update('old token', 'utf8'), c.final()]); const v1 = `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
assert.equal(decrypt(v1), 'old token'); const v2 = encrypt('new token'); assert.match(v2, /^v2\./); assert.equal(decrypt(v2), 'new token'); assert.notEqual(encrypt('x'), encrypt('x')); assert.throws(() => decrypt('v9.a.b.c')); ok('secrets: v2 encryption, v1 still readable');

// ---- repository path safety
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
writeFileSync(path.join(outside, 'keep.txt'), 'still here'); assert.equal(existsSync(path.join(outside, 'keep.txt')), true); ok('repo: links are refused, removed from the index and never followed');

// ---- janitor
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
assert.deepEqual(db.prepare('SELECT client_id FROM oauth_clients').all().map((r) => r.client_id), ['fresh']); ok('janitor: expired sessions, requests and unused clients are removed');

console.log(`\n${n} checks passed`);
process.exit(0);
