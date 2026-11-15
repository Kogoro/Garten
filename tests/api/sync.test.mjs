// Sync: retries after a lost response, a re-created spec keeps counting versions.
//   node --test tests/api/sync.test.mjs
import assert from 'node:assert/strict';
import { before, describe } from 'node:test';
import { useServer, chain } from '../helpers.mjs';

describe('review fixes: retries after a lost response, a re-created spec keeps counting versions', () => {
  const ctx = useServer();
  const step = chain();
  const ch = { id: 'SPEC-880', kind: 'spec', baseRev: 0, fields: { title: 'Retry me', body: 'one' } };
  let admin, r;
  before(() => {
    ({ admin } = ctx);
  });

  step('sync: the same change sent twice is applied once, not reported as a conflict', async () => {
    r = await admin.push([ch]);
    assert.equal(r[0].status, 'applied');
    r = await admin.push([ch]);
    assert.equal(r[0].status, 'applied');
    assert.equal(r[0].item.title, 'Retry me');
  });
  step('a spec id that is used again continues its version numbers', async () => {
    r = await admin.push([{ id: 'SPEC-880', kind: 'spec', baseRev: r[0].item.rev, approve: true, fields: { body: 'one' } }]);
    assert.equal(r[0].item.version, 1);
    r = await admin.push([{ id: 'SPEC-880', kind: 'spec', baseRev: r[0].item.rev, revoke: true }]);
    r = await admin.push([{ id: 'SPEC-880', kind: 'spec', baseRev: r[0].item.rev, delete: true }]);
    assert.equal(r[0].deleted, true);
    r = await admin.push([{ id: 'SPEC-880', kind: 'spec', baseRev: 0, fields: { title: 'Again', body: 'two' } }]);
    assert.equal(r[0].status, 'applied');
    r = await admin.push([{ id: 'SPEC-880', kind: 'spec', baseRev: r[0].item.rev, approve: true, fields: { body: 'two' } }]);
    assert.equal(r[0].item.version, 2);
  });
});
