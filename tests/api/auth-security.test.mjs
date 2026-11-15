// Authentication, the glossary lookup and the security review fixes (SECURITY_FINDINGS.md): git remote safety, proxies, credentials,
// headers, sessions, the audit log, malformed input, password policy, file modes, signed webhooks.
//   node --test tests/api/auth-security.test.mjs
import assert from 'node:assert/strict';
import { before, after, describe } from 'node:test';
import { createServer as createHttpServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, lstatSync, statSync } from 'node:fs';
import { randomBytes, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { useServer, makeUser, chain, startServer, scratch, git, missing, Client } from '../helpers.mjs';

describe('authentication and security', () => {
  const ctx = useServer({ GIT_ALLOW_LOCAL: '1', HOOK_DEBOUNCE_MS: '250', HOOK_ALLOW_LOCAL: '1' });
  let BASE, srv, admin, T1, uniq, anon, viewer;
  before(async () => {
    ({ base: BASE, srv, admin, T1, uniq } = ctx);
    anon = new Client(BASE);
    viewer = await makeUser(ctx, 'viewer');
    // the audit log check below expects a token.create entry; in the single script earlier sections created tokens
    await admin.post('/api/me/tokens', { name: 'audit probe', scopes: ['mcp:read'], teamId: T1 });
  });

  describe('authentication', () => {
    const step = chain();
    step('api requires a session', async () => {
      assert.equal((await anon.get('/api/me')).status, 401);
    });
    step('wrong password rejected', async () => {
      assert.equal((await anon.post('/api/auth/login', { email: 'admin@localhost', password: 'wrong-password' })).status, 401);
    });
    step('login without CSRF header rejected', async () => {
      assert.equal(
        (await anon.req('POST', '/api/auth/login', { email: 'admin@localhost', password: 'adminpass1' }, { 'x-specs': '0' })).status,
        403,
      );
    });
    step('instance admin signs in and sees the default team', async () => {
      const me = await new Client(BASE).login('admin@localhost', 'adminpass1');
      assert.equal(me.admin, true);
      assert.equal(me.teams.length, 1);
      assert.equal(me.teams[0].role, 'admin');
    });
  });

  // glossary lookup: input is validated before any third party is asked; sign-in is required
  describe('glossary lookup', () => {
    const step = chain();
    step('lookup: a too short term is rejected', async () => {
      assert.equal((await admin.get('/api/lookup?q=a')).status, 400);
    });
    step('lookup: needs a sign-in', async () => {
      assert.equal((await anon.get('/api/lookup?q=idempotence')).status, 401);
    });
  });

  // ================================================================ security review fixes (SECURITY_FINDINGS.md)
  describe(
    "SEC-01: a symbolic link coming from the git remote must not lead out of the team's repository",
    { skip: missing('git') },
    () => {
      const step = chain();
      step(
        'SEC-01: symbolic links from a git remote never reach the working tree and nothing is written outside the repository',
        async () => {
          const tmp = scratch('specs-remote-');
          const outside = path.join(srv.dir, 'outside-target');
          mkdirSync(outside, { recursive: true });
          const lremote = path.join(tmp, 'link-remote.git');
          git(tmp, 'init', '--bare', '-b', 'main', lremote);
          const lwork = path.join(tmp, 'link-work');
          git(tmp, 'clone', lremote, lwork);
          git(lwork, 'config', 'user.email', 'a@x');
          git(lwork, 'config', 'user.name', 'A');
          git(lwork, 'checkout', '-b', 'main');
          symlinkSync(outside, path.join(lwork, 'a'));
          git(lwork, 'add', '.');
          git(lwork, 'commit', '-m', 'link');
          git(lwork, 'push', 'origin', 'main');
          const lt = (await admin.post('/api/teams', { name: 'Linked', key: 'LNK' })).data.team;
          const lg = `/api/teams/${lt.id}/git`;
          assert.equal(
            (await admin.req('PUT', lg, { url: lremote, branch: 'main', root: 'a/pwned', auth: 'none', autoPush: false })).status,
            200,
          );
          let rr = await admin.push(
            [{ id: 'LNK-1', kind: 'spec', baseRev: 0, approve: true, fields: { title: 'One', body: 'first' } }],
            lt.id,
          );
          assert.equal(rr[0].status, 'applied');
          rr = await admin.push([{ id: 'LNK-1', kind: 'spec', baseRev: rr[0].item.rev, revoke: true }], lt.id);
          assert.equal(rr[0].status, 'applied'); // (a tree that already has files below `a/` cannot merge a link named `a`)
          {
            const pr = await admin.post(`${lg}/push`);
            assert.equal(pr.status, 200, JSON.stringify(pr.data));
          } // merges the remote, link included
          rr = await admin.push([{ id: 'LNK-1', kind: 'spec', baseRev: rr[0].item.rev, approve: true, fields: { body: 'second' } }], lt.id);
          assert.equal(existsSync(path.join(outside, 'pwned')), false, 'nothing may be written through the link');
          assert.equal(readdirOutside(outside).length, 0);
          const wt = path.join(srv.dir, 'repos', lt.id);
          assert.equal(existsSync(path.join(wt, 'a')) ? lstatSync(path.join(wt, 'a')).isSymbolicLink() : false, false);
          assert.doesNotMatch(git(wt, 'ls-files', '-s'), /^120000/m);
          function readdirOutside(d) {
            return execFileSync('ls', ['-A', d], { encoding: 'utf8' }).split('\n').filter(Boolean);
          }
        },
      );
    },
  );

  describe('SEC-02: git remotes in private networks are refused', () => {
    const step = chain();
    step('SEC-02: git remote URLs that point into a private or local network are rejected', async () => {
      const sg = `/api/teams/${T1}/git`;
      for (const u of [
        'https://127.0.0.1/x.git',
        'https://[::1]/x.git',
        'https://localhost/x.git',
        'https://10.0.0.5/x.git',
        'https://169.254.169.254/x.git',
        'https://[::ffff:127.0.0.1]/x.git',
        'https://intranet/x.git',
        'git@localhost:x.git',
        'git@192.168.1.5:x.git',
        'ssh://git@10.1.2.3/x.git',
      ])
        assert.equal((await admin.req('PUT', sg, { url: u, branch: 'main', root: 'specs', auth: 'none' })).status, 400, u);
      assert.equal(
        (await admin.req('PUT', sg, { url: 'https://git.example/org/repo.git', branch: 'main', root: 'specs', auth: 'none' })).status,
        200,
      );
    });
  });

  describe('SEC-03: X-Forwarded-For is only believed for the configured number of proxies', () => {
    const step = chain();
    let px, open;
    after(() => Promise.all([px?.kill(), open?.kill()]));
    step('SEC-03: a client-supplied X-Forwarded-For entry does not escape the login throttle', async () => {
      px = await startServer({ TRUST_PROXY: '1', SEED_DEMO: '0' });
      const codes = [];
      for (let i = 0; i < 13; i++)
        codes.push(
          (
            await new Client(px.base).req(
              'POST',
              '/api/auth/login',
              { email: 'admin@localhost', password: `wrong-${i}` },
              { 'x-forwarded-for': `1.2.3.${i}, 9.9.9.9` },
            )
          ).status,
        );
      assert.ok(codes.includes(429), codes.join(','));
    });
    step('SEC-03: without TRUST_PROXY the header is ignored', async () => {
      open = await startServer({ SEED_DEMO: '0' }); // no proxy configured: the header is ignored altogether
      const c2 = [];
      for (let i = 0; i < 12; i++)
        c2.push(
          (
            await new Client(open.base).req(
              'POST',
              '/api/auth/login',
              { email: 'admin@localhost', password: `wrong-${i}` },
              { 'x-forwarded-for': `5.5.5.${i}` },
            )
          ).status,
        );
      assert.ok(c2.includes(429));
    });
  });

  describe('SEC-06: stored credentials are bound to the server they were entered for', () => {
    const step = chain();
    step('SEC-06: a git token is dropped when the repository moves to another server', async () => {
      const cg = `/api/teams/${T1}/git`;
      assert.equal(
        (
          await admin.req('PUT', cg, {
            url: 'https://git.example/org/a.git',
            branch: 'main',
            root: 'specs',
            auth: 'token',
            username: 'bot',
            token: 'tok-1',
          })
        ).data.git.hasSecret,
        true,
      );
      assert.equal(
        (
          await admin.req('PUT', cg, {
            url: 'https://git.example/org/b.git',
            branch: 'main',
            root: 'specs',
            auth: 'token',
            username: 'bot',
          })
        ).data.git.hasSecret,
        true,
      ); // same server: kept
      assert.equal(
        (
          await admin.req('PUT', cg, {
            url: 'https://attacker.example/org/b.git',
            branch: 'main',
            root: 'specs',
            auth: 'token',
            username: 'bot',
          })
        ).data.git.hasSecret,
        false,
      );
    });
    step('SEC-06: webhook token and extra headers are dropped when the receiver changes', async () => {
      const hk = (b) => admin.req('PATCH', `/api/teams/${T1}`, { hook: b });
      const hv = async () => (await admin.get(`/api/teams/${T1}`)).data.team.hook;
      await hk({ url: 'http://127.0.0.1:41111/a', token: 'hook-secret-1', headers: 'X-Test: 1' });
      await hk({ url: 'http://127.0.0.1:41111/b' });
      let h = await hv();
      assert.equal(h.hasToken, true);
      assert.deepEqual(h.headerNames, ['X-Test']);
      await hk({ url: 'http://127.0.0.1:42222/b' });
      h = await hv();
      assert.equal(h.hasToken, false);
      assert.deepEqual(h.headerNames, []);
      await hk({ url: '' });
    });
  });

  describe('SEC-07: security headers', () => {
    const step = chain();
    let https;
    after(() => https?.kill());
    step('SEC-07: CSP, frame and opener protection are sent (the consent page may redirect to the agent)', async () => {
      const hdr = (await fetch(`${BASE}/api/auth/config`)).headers;
      assert.match(hdr.get('content-security-policy'), /default-src 'self'/);
      assert.match(hdr.get('content-security-policy'), /script-src 'self'(;|$)/);
      assert.match(hdr.get('content-security-policy'), /frame-ancestors 'none'/);
      assert.equal(hdr.get('x-frame-options'), 'DENY');
      assert.equal(hdr.get('cross-origin-opener-policy'), 'same-origin');
      assert.match(hdr.get('permissions-policy'), /camera=\(\)/);
      const oa = (await fetch(`${BASE}/oauth/consent?request=none`)).headers.get('content-security-policy');
      assert.ok(oa && !/form-action/.test(oa));
    });
    step('SEC-07: HSTS is sent when the public address is https', async () => {
      https = await startServer({ PUBLIC_URL: 'https://garten.example', SEED_DEMO: '0' });
      assert.match((await fetch(`${https.base}/healthz`)).headers.get('strict-transport-security') ?? '', /max-age=\d+/);
    });
  });

  describe('SEC-08, SEC-15: password change ends the other sessions; logout needs the CSRF header; sessions are listed and can be ended; idle sessions expire', () => {
    const step = chain();
    let again;
    step('SEC-08: changing the password ends all other sessions (this device stays signed in)', async () => {
      const u = await makeUser(ctx, 'editor', 'sec');
      const mail = u.email;
      const other = new Client(BASE);
      await other.login(mail, 'password-editor');
      assert.equal((await u.c.get('/api/me/sessions')).data.sessions.filter((x) => x.current).length, 1);
      assert.equal((await u.c.post('/api/me/password', { current: 'wrong-current', password: 'brand-new-pass-1' })).status, 403);
      assert.equal((await u.c.post('/api/me/password', { current: 'password-editor', password: 'brand-new-pass-1' })).status, 200);
      assert.equal((await other.get('/api/me')).status, 401);
      assert.equal((await u.c.get('/api/me')).status, 200);
      assert.equal((await new Client(BASE).post('/api/auth/login', { email: mail, password: 'password-editor' })).status, 401);
      again = new Client(BASE);
      await again.login(mail, 'brand-new-pass-1');
    });
    step('SEC-15: logout needs the CSRF header; sessions can be listed and ended; idle sessions expire', async () => {
      assert.equal((await again.req('POST', '/api/auth/logout', undefined, { 'x-specs': '0' })).status, 403);
      assert.equal((await again.get('/api/me')).status, 200);
      const list = (await again.get('/api/me/sessions')).data.sessions;
      const mine = list.find((x) => x.current);
      const foreign = list.find((x) => !x.current);
      assert.ok(mine && foreign);
      assert.equal((await again.del(`/api/me/sessions/${foreign.id}`)).data.ok, true);
      const db = new DatabaseSync(`${srv.dir}/specs.db`);
      db.prepare('UPDATE sessions SET last_seen_at=? WHERE id=?').run(Math.floor(Date.now() / 1000) - 40 * 86400, mine.id);
      db.close();
      assert.equal((await again.get('/api/me')).status, 401);
    });
  });

  describe('SEC-11: audit log', () => {
    const step = chain();
    step('SEC-11: security-relevant actions are logged without secrets; only instance admins read the log', async () => {
      const log = (await admin.get('/api/admin/audit?limit=500')).data.entries;
      const acts = new Set(log.map((e) => e.action));
      for (const a of [
        'auth.login',
        'auth.login.failed',
        'team.create',
        'team.git.update',
        'user.create',
        'token.create',
        'user.password.change',
      ])
        assert.ok(acts.has(a), a);
      assert.ok(!JSON.stringify(log).match(/tok-1|ghp_SECRET123|hook-secret-1|brand-new-pass|password-editor/));
      assert.equal((await viewer.c.get('/api/admin/audit')).status, 403);
      await admin.req('PUT', `/api/teams/${T1}/git`, {
        url: `https://git.example/${'long/'.repeat(600)}r.git`,
        branch: 'main',
        root: 'specs',
        auth: 'none',
      }); // a very long value must not break the log
      const big = await admin.get('/api/admin/audit?limit=5');
      assert.equal(big.status, 200);
      assert.ok(big.data.entries.some((e) => e.action === 'team.git.update' && e.detail.url.length <= 300));
    });
  });

  describe('SEC-12: malformed input does not crash the server', () => {
    const step = chain();
    step('SEC-12: malformed changes and cookies are answered with 4xx, not 500', async () => {
      const ctrl = await admin.sync([
        null,
        5,
        'x',
        { id: 7 },
        { id: 'S-1', kind: 'nope' },
        { id: 'SPEC-701', kind: 'spec', baseRev: 0, fields: { title: 5 } },
        { id: 'SPEC-702', kind: 'spec', baseRev: 0, fields: { title: 'ok', links: 'no' } },
        { id: 'SPEC-703', kind: 'spec', baseRev: 0, fields: { title: 'x'.repeat(301) } },
      ]);
      assert.equal(ctrl.status, 200);
      assert.ok(
        ctrl.data.results.every((r) => r.status === 'error'),
        JSON.stringify(ctrl.data.results),
      );
      assert.equal((await admin.post(`/api/teams/${T1}/sync`, { changes: 'nope' })).status, 400);
      assert.equal((await fetch(`${BASE}/api/me`, { headers: { cookie: 'specs_sid=%E0%A4%A' } })).status, 401);
    });
  });

  describe('SEC-13: password policy, upgrade of old hashes', () => {
    const step = chain();
    step('SEC-13: weak passwords and odd e-mail addresses are refused; old password hashes are upgraded at sign-in', async () => {
      for (const pw of ['short', 'password123', 'aaaaaaaaaaaa', 'x'.repeat(300)])
        assert.equal((await admin.post('/api/users', { email: `pol-${uniq}@example.com`, password: pw })).status, 400, pw.slice(0, 12));
      assert.equal((await admin.post('/api/users', { email: 'bad"mail@example.com', password: 'a-good-password-1' })).status, 400);
      assert.equal((await admin.post('/api/users', { email: 'a@b.c>', password: 'a-good-password-1' })).status, 400);
      const email = `legacy-${uniq}@example.com`;
      const mkU = await admin.post('/api/users', { email, password: 'old-legacy-pass-1' });
      assert.equal(mkU.status, 200);
      const salt = randomBytes(16);
      const legacy = `scrypt$${salt.toString('base64')}$${scryptSync('old-legacy-pass-1', salt, 64).toString('base64')}`;
      const db = new DatabaseSync(`${srv.dir}/specs.db`);
      db.prepare('UPDATE users SET password_hash=? WHERE email=?').run(legacy, email);
      await new Client(BASE).login(email, 'old-legacy-pass-1');
      assert.match(db.prepare('SELECT password_hash h FROM users WHERE email=?').get(email).h, /^scrypt\$65536\$8\$2\$/);
      db.close();
    });
    step('SEC-13: an invitation cannot create an account without a password', async () => {
      const inv = await admin.post(`/api/teams/${T1}/invites`, { email: `nopw-${uniq}@example.com`, role: 'viewer' });
      const tkn = inv.data.link.split('/invite/')[1];
      assert.equal((await anon.post(`/api/invites/${tkn}/accept`, { name: 'No Password' })).status, 400);
    });
  });

  describe('SEC-16: files are private to the service user', () => {
    const step = chain();
    step('SEC-16: database and key file are not readable by others', () => {
      assert.equal(statSync(`${srv.dir}/specs.db`).mode & 0o077, 0);
      assert.equal(statSync(`${srv.dir}/secret.key`).mode & 0o077, 0);
    });
  });

  describe('SEC-21: signed webhooks, sanitised texts', () => {
    const step = chain();
    const seen = [];
    const sink = createHttpServer((rq, rs) => {
      let b = '';
      rq.on('data', (d) => (b += d));
      rq.on('end', () => {
        seen.push({ h: rq.headers, b });
        rs.writeHead(200);
        rs.end('{}');
      });
    });
    after(() => {
      if (sink.listening) sink.close();
    });
    step('SEC-21: webhook calls carry a timestamp and an HMAC signature', async () => {
      await new Promise((r) => sink.listen(0, '127.0.0.1', r));
      await admin.req('PATCH', `/api/teams/${T1}`, {
        hook: { url: `http://127.0.0.1:${sink.address().port}/x`, token: 'sig-secret-9', events: ['release', 'answer'], format: 'full' },
      });
      await admin.post(`/api/teams/${T1}/hook/test`);
      const m = seen[0];
      const { createHmac } = await import('node:crypto');
      assert.equal(
        m.h['x-specs-signature'],
        `sha256=${createHmac('sha256', 'sig-secret-9').update(`${m.h['x-specs-timestamp']}.${m.b}`).digest('hex')}`,
      );
      assert.ok(Math.abs(Date.now() / 1000 - Number(m.h['x-specs-timestamp'])) < 30);
      await admin.req('PATCH', `/api/teams/${T1}`, { hook: { url: '' } });
    });
  });
});
