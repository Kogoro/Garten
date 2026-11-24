// Images in specs and documents: upload, reading, who may do what, release into Git, get_image over MCP, removal from Git.
//   node --test tests/api/images.test.mjs
import assert from 'node:assert/strict';
import { before, describe } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { useServer, makeUser, chain, mcpClient } from '../helpers.mjs';

// a 1×1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

describe('images', () => {
  const ctx = useServer();
  let admin, T1, viewer, src, name;
  const upload = (c, body, type = 'image/png', tid = T1) =>
    fetch(`${ctx.base}/api/teams/${tid}/images`, {
      method: 'POST',
      headers: { cookie: c.cookie, 'x-specs': '1', 'content-type': type },
      body,
    }).then(async (r) => ({ status: r.status, data: await r.json() }));
  const fetchImage = (c, n, tid = T1) => fetch(`${ctx.base}/api/teams/${tid}/images/${n}`, { headers: { cookie: c.cookie } });
  before(async () => {
    ({ admin, T1 } = ctx);
    viewer = await makeUser(ctx, 'viewer');
  });

  const step = chain();
  step('an editor uploads a PNG and gets a content-addressed path', async () => {
    const r = await upload(admin, PNG);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.match(r.data.src, /^images\/[a-f0-9]{32}\.png$/);
    ({ src, name } = r.data);
    const again = await upload(admin, PNG, 'application/octet-stream');
    assert.equal(again.data.src, src, 'the same bytes give the same path, whatever type the client claims');
  });

  step('members read it, with a type taken from the bytes and a sandboxing policy', async () => {
    const r = await fetchImage(viewer.c, name);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.match(r.headers.get('content-security-policy') ?? '', /sandbox/);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), PNG);
    assert.equal((await fetchImage(viewer.c, 'ffffffffffffffffffffffffffffffff.png')).status, 404);
    assert.equal((await fetchImage(viewer.c, '..%2F..%2Fspecs.db')).status, 404);
  });

  step('only images are accepted, and viewers and strangers cannot upload', async () => {
    assert.equal(
      (await upload(admin, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml')).status,
      415,
    );
    assert.equal((await upload(admin, Buffer.alloc(0))).status, 400);
    assert.equal((await upload(viewer.c, PNG)).status, 403);
    const anon = await fetch(`${ctx.base}/api/teams/${T1}/images/${name}`);
    assert.equal(anon.status, 401);
  });

  const specFile = () => path.join(ctx.srv.dir, 'repos', T1, 'specs', 'images', name);
  step('releasing a spec that shows the image writes it into the team repository', async () => {
    const [r] = await admin.push([
      { id: 'IMG-1', kind: 'spec', baseRev: 0, approve: true, fields: { title: 'With a picture', body: `Look:\n\n![The flow](${src})\n` } },
    ]);
    assert.equal(r.status, 'applied', JSON.stringify(r));
    assert.ok(existsSync(specFile()), 'image written next to the spec files');
    assert.deepEqual(readFileSync(specFile()), PNG);
  });

  step('agents read it with get_image', async () => {
    const tok = (await admin.post('/api/me/tokens', { name: 'img', scopes: ['mcp:read'], teamId: T1 })).data.token;
    const cl = await mcpClient(ctx.base, tok);
    const out = await cl.callTool({ name: 'get_image', arguments: { path: src } });
    assert.equal(out.isError, undefined);
    assert.equal(out.content[0].type, 'image');
    assert.equal(out.content[0].mimeType, 'image/png');
    assert.deepEqual(Buffer.from(out.content[0].data, 'base64'), PNG);
    const bad = await cl.callTool({ name: 'get_image', arguments: { path: 'https://example.com/x.png' } });
    assert.equal(bad.isError, true);
    await cl.close();
  });

  step('a release that no longer shows the image removes it from the repository', async () => {
    const cur = (await admin.sync()).data.items.find((i) => i.id === 'IMG-1');
    const [r] = await admin.push([
      { id: 'IMG-1', kind: 'spec', baseRev: cur.rev, approve: true, fields: { body: 'No picture any more.\n' } },
    ]);
    assert.equal(r.status, 'applied', JSON.stringify(r));
    assert.ok(!existsSync(specFile()));
  });
});
