// Webhook outbox: an event that could not be delivered survives a restart and is delivered afterwards.
//   node --test tests/api/webhook-outbox.test.mjs
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { createServer as createHttpServer } from 'node:http';
import { rmSync } from 'node:fs';
import { startServer, scratch, Client } from '../helpers.mjs';

describe('webhook outbox', () => {
  const dataDir = scratch('specs-outbox-');
  let a, b, late;
  after(async () => {
    await Promise.all([a?.kill(), b?.kill()]);
    late?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('a webhook event that could not be delivered is sent after a restart', async () => {
    const probe = createHttpServer();
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const hookPort = probe.address().port;
    await new Promise((r) => probe.close(r));
    const env = { DATA_DIR: dataDir, HOOK_ALLOW_LOCAL: '1', HOOK_DEBOUNCE_MS: '100', SEED_DEMO: '0' };
    a = await startServer(env);
    const ca = new Client(a.base);
    await ca.login('admin@localhost', 'adminpass1');
    assert.equal(
      (await ca.req('PATCH', `/api/teams/${ca.tid}`, { hook: { url: `http://127.0.0.1:${hookPort}/fire`, format: 'full' } })).status,
      200,
    );
    const ra = await ca.push([
      { id: 'SPEC-001', kind: 'spec', baseRev: 0, approve: true, fields: { title: 'Outbox spec', body: '## GOAL\nx\n' } },
    ]);
    assert.equal(ra[0].item.version, 1);
    await new Promise((r) => setTimeout(r, 1200)); // one delivery attempt fails: nobody listens yet
    void a.stop();
    await new Promise((r) => setTimeout(r, 600));
    const got = [];
    late = createHttpServer((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        got.push(JSON.parse(b || '{}'));
        res.writeHead(200);
        res.end('{}');
      });
    });
    await new Promise((r) => late.listen(hookPort, '127.0.0.1', r));
    b = await startServer(env);
    for (let i = 0; i < 60 && !got.length; i++) await new Promise((r) => setTimeout(r, 250));
    assert.equal(got.length, 1);
    assert.equal(got[0].released[0].id, 'SPEC-001');
  });
});
