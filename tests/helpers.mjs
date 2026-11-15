import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { before, after, test } from 'node:test';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const freePort = () =>
  new Promise((res) => {
    const s = createServer().listen(0, () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A fresh scratch directory (below TEST_TMP if set). */
export const scratch = (prefix = 'specs-test-') => mkdtempSync(path.join(process.env.TEST_TMP || tmpdir(), prefix));
export const git = (cwd, ...a) =>
  execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
/** Skip reason for tests that need an external program: `{ skip: missing('ssh-keygen') }`. */
export const missing = (bin) =>
  spawnSync(bin, ['--help'], { stdio: 'ignore' }).error?.code === 'ENOENT' ? `${bin} is not installed` : false;

/** Starts the server with a throw-away data dir (or DATA_DIR from extraEnv). stop() resolves once the process has exited. */
export async function startServer(extraEnv = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await launch(extraEnv);
    } catch (e) {
      if (!e.portTaken || attempt === 3) throw e;
    } // another test file took the port in between
  }
}

async function launch(extraEnv) {
  const port = await freePort();
  const dir = extraEnv.DATA_DIR ?? scratch();
  const env = {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dir,
    ADMIN_PASSWORD: 'adminpass1',
    PUBLIC_URL: `http://localhost:${port}`,
    SEED_DEMO: '1',
    NODE_NO_WARNINGS: '1',
    ...extraEnv,
  };
  const child = spawn('node', [path.join(ROOT, 'server/index.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((r) => child.once('exit', r));
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const base = `http://localhost:${port}`;
  // wait for this process to listen first: a health check alone could reach another test file's server on a reused port
  for (let i = 0; !log.includes('specs listening on'); i++) {
    if (child.exitCode !== null || i > 300) {
      child.kill();
      throw Object.assign(new Error('server did not start:\n' + log), { portTaken: log.includes('EADDRINUSE') });
    }
    await sleep(50);
  }
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {
      /* not yet */
    }
    await sleep(150);
    if (child.exitCode !== null) throw new Error('server exited:\n' + log);
  }
  const stop = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    return exited;
  };
  const kill = async () => {
    // stop, and do not wait for long-lived connections (MCP streams) to end
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    await stop();
    clearTimeout(timer);
  };
  return { base, dir, port, log: () => log, stop, kill };
}

/**
 * One server on its own scratch data directory for the surrounding file or describe block, with the instance admin signed in.
 * The returned object is filled in before the first test: { srv, base, admin, T1, uniq }.
 */
export function useServer(extraEnv = {}) {
  const ctx = { uniq: Date.now().toString(36) };
  before(async () => {
    ctx.srv = await startServer(extraEnv);
    ctx.base = ctx.srv.base;
    ctx.admin = new Client(ctx.base);
    await ctx.admin.login('admin@localhost', 'adminpass1');
    ctx.T1 = ctx.admin.tid;
  });
  after(async () => {
    if (!ctx.srv) return;
    await ctx.srv.kill();
    if (!process.env.KEEP_TEST_DATA && !extraEnv.DATA_DIR) rmSync(ctx.srv.dir, { recursive: true, force: true });
  });
  return ctx;
}

/** A user with the given role in a team (default: the admin's first team), signed in. */
export async function makeUser(ctx, role, tag = '', team = ctx.T1) {
  const email = `${role}${tag}-${ctx.uniq}@example.com`;
  const r = await ctx.admin.post('/api/users', { email, name: `${role} user`, password: 'password-' + role, teamId: team, role });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const c = new Client(ctx.base);
  await c.login(email, 'password-' + role);
  return { c, id: r.data.user.id, email };
}

/**
 * Tests that build on each other: they run in order, and once one fails the rest of the chain is skipped
 * (they would only fail for the same reason). Other chains and files carry on.
 */
export function chain() {
  let failed = null;
  return (name, fn, options = {}) => {
    test(name, options, async (t) => {
      if (failed) return t.skip(`needs "${failed}", which failed`);
      try {
        await fn(t);
      } catch (e) {
        failed = name;
        throw e;
      }
    });
  };
}

// ---- MCP
export async function mcpClient(base, token) {
  const c = new McpClient({ name: 'test', version: '0' });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
  );
  return c;
}
export const call = async (c, name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  return { text: r.content[0].text, isError: !!r.isError };
};
export const toolNames = async (c) => (await c.listTools()).tools.map((t) => t.name).sort();
export const hasParam = async (c, tool, p) => !!(await c.listTools()).tools.find((t) => t.name === tool).inputSchema.properties?.[p];

/** Minimal cookie-aware API client. */
export class Client {
  constructor(base) {
    this.base = base;
    this.cookie = '';
  }
  async req(method, url, body, headers = {}) {
    const res = await fetch(this.base + url, {
      method,
      redirect: 'manual',
      headers: {
        cookie: this.cookie,
        'x-specs': '1',
        ...(body && !(body instanceof URLSearchParams) ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? (body instanceof URLSearchParams ? body : JSON.stringify(body)) : undefined,
    });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) {
      const [kv] = c.split(';');
      if (kv.endsWith('=')) this.cookie = '';
      else this.cookie = kv;
    }
    let data = null;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('json')) data = await res.json();
    else data = await res.text();
    return { status: res.status, data, res };
  }
  get = (u) => this.req('GET', u);
  post = (u, b) => this.req('POST', u, b ?? {});
  patch = (u, b) => this.req('PATCH', u, b);
  del = (u) => this.req('DELETE', u);
  async login(email, password) {
    const r = await this.post('/api/auth/login', { email, password });
    if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.data)}`);
    this.me = r.data.me;
    this.tid = this.me.teams[0]?.id;
    return r.data.me;
  }
  sync = async (changes = [], since = 0, tid = this.tid) => await this.post(`/api/teams/${tid}/sync`, { since, changes });
  push = async (changes, tid = this.tid) => (await this.sync(changes, 1e9, tid)).data.results;
}

/** Minimal in-process SMTP server that records messages (no TLS, no auth). */
export async function startSmtpSink() {
  const { createServer: createNet } = await import('node:net');
  const mails = [];
  const server = createNet((sock) => {
    let buf = '';
    let inData = false;
    let cur = { to: [], from: '', raw: '' };
    sock.write('220 sink ESMTP\r\n');
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            mails.push(decodeMail(cur));
            cur = { to: [], from: '', raw: '' };
            sock.write('250 queued\r\n');
          } else cur.raw += `${line.startsWith('..') ? line.slice(1) : line}\n`;
          continue;
        }
        const up = line.toUpperCase();
        if (up.startsWith('EHLO') || up.startsWith('HELO')) sock.write('250 sink\r\n');
        else if (up.startsWith('MAIL FROM')) {
          cur.from = line.slice(10);
          sock.write('250 ok\r\n');
        } else if (up.startsWith('RCPT TO')) {
          cur.to.push(/<([^>]+)>/.exec(line)?.[1] ?? line);
          sock.write('250 ok\r\n');
        } else if (up === 'DATA') {
          inData = true;
          sock.write('354 go\r\n');
        } else if (up === 'QUIT') {
          sock.write('221 bye\r\n');
          sock.end();
        } else sock.write('250 ok\r\n');
      }
    });
    sock.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, mails, stop: () => server.close() };
}

function decodeMail(m) {
  const [head, ...rest] = m.raw.split('\n\n');
  const body = rest.join('\n\n');
  // multipart/alternative with quoted-printable parts: decode every part's soft line breaks and =XX escapes
  const qp = (t) => t.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const subject = /^Subject: (.*)$/m.exec(head)?.[1] ?? '';
  return { ...m, subject, text: qp(body), headers: head };
}
