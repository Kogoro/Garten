import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';

export const freePort = () => new Promise((res) => { const s = createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

/** Starts the server with a throw-away data dir. Pass BASE to test an already running instance instead. */
export async function startServer(extraEnv = {}) {
  const port = await freePort();
  const dir = mkdtempSync(path.join(process.env.TEST_TMP || tmpdir(), 'specs-test-'));
  const env = { ...process.env, PORT: String(port), DATA_DIR: dir, ADMIN_PASSWORD: 'adminpass1', PUBLIC_URL: `http://localhost:${port}`, SEED_DEMO: '1', NODE_NO_WARNINGS: '1', ...extraEnv };
  const child = spawn('node', ['server/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 150));
    if (child.exitCode !== null) throw new Error('server exited:\n' + log);
  }
  return { base, dir, port, log: () => log, stop: () => child.kill() };
}

/** Minimal cookie-aware API client. */
export class Client {
  constructor(base) { this.base = base; this.cookie = ''; }
  async req(method, url, body, headers = {}) {
    const res = await fetch(this.base + url, {
      method, redirect: 'manual',
      headers: { cookie: this.cookie, 'x-specs': '1', ...(body && !(body instanceof URLSearchParams) ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? (body instanceof URLSearchParams ? body : JSON.stringify(body)) : undefined,
    });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) { const [kv] = c.split(';'); if (kv.endsWith('=')) this.cookie = ''; else this.cookie = kv; }
    let data = null;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('json')) data = await res.json(); else data = await res.text();
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
  sync = async (changes = [], since = 0, tid = this.tid) => (await this.post(`/api/teams/${tid}/sync`, { since, changes }));
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
          if (line === '.') { inData = false; mails.push(decodeMail(cur)); cur = { to: [], from: '', raw: '' }; sock.write('250 queued\r\n'); }
          else cur.raw += `${line.startsWith('..') ? line.slice(1) : line}\n`;
          continue;
        }
        const up = line.toUpperCase();
        if (up.startsWith('EHLO') || up.startsWith('HELO')) sock.write('250 sink\r\n');
        else if (up.startsWith('MAIL FROM')) { cur.from = line.slice(10); sock.write('250 ok\r\n'); }
        else if (up.startsWith('RCPT TO')) { cur.to.push(/<([^>]+)>/.exec(line)?.[1] ?? line); sock.write('250 ok\r\n'); }
        else if (up === 'DATA') { inData = true; sock.write('354 go\r\n'); }
        else if (up === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 ok\r\n');
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
