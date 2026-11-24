// Authorization regressions found in the security review: reading another team's shared items through an unreleased link,
// taking over invitations by registering an address from one's own invitation link, and editors withdrawing released guardrails.
//   node --test tests/api/authz-regressions.test.mjs
import assert from 'node:assert/strict';
import { before, describe } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { useServer, chain, Client } from '../helpers.mjs';
import { formatRuleFile } from '../../shared/guardrailFiles.js';

describe('authorization regressions', () => {
  const ctx = useServer({ SEED_DEMO: '0' });
  const teams = {};
  let mallory;
  const signIn = async (email, password) => {
    const c = new Client(ctx.base);
    await c.login(email, password);
    return c;
  };
  const sharedItem = (c, tid, ref) => c.get(`/api/teams/${tid}/shared/item?ref=${encodeURIComponent(ref)}`);
  before(async () => {
    for (const key of ['VIC', 'OTHER']) teams[key] = (await ctx.admin.post('/api/teams', { name: key, key })).data.team;
    // an ordinary user who belongs to no team (anyone may create teams by default)
    await ctx.admin.post('/api/users', { email: 'mallory@example.com', name: 'Mallory', password: 'mallory-pass-1' });
    mallory = await signIn('mallory@example.com', 'mallory-pass-1');
  });

  describe('items shared with one team stay with that team', () => {
    const step = chain();
    let atk, spec;
    step('VIC releases secret.md and shares it with OTHER only', async () => {
      const V = teams.VIC.id;
      await ctx.admin.push(
        [
          { id: 'secret.md', kind: 'doc', baseRev: 0, fields: { title: 'secret', body: '# Secret\n\nTOP-SECRET\n' } },
          { id: 'VIC-001', kind: 'spec', baseRev: 0, fields: { title: 'Uses secret', body: 'x', links: ['secret.md'] } },
        ],
        V,
      );
      const r = await ctx.admin.push([{ id: 'VIC-001', kind: 'spec', baseRev: 1, approve: true }], V);
      assert.equal(r[0].status, 'applied', JSON.stringify(r));
      const s = await ctx.admin.post(`/api/teams/${V}/shares`, { itemId: 'secret.md', audience: 'teams', teams: ['OTHER'] });
      assert.equal(s.status, 200, JSON.stringify(s.data));
    });
    step('another team releases a spec of its own', async () => {
      atk = (await mallory.post('/api/teams', { name: 'Attack', key: 'ATK' })).data.team;
      await mallory.push([{ id: 'ATK-001', kind: 'spec', baseRev: 0, fields: { title: 'a', body: 'a' } }], atk.id);
      [spec] = await mallory.push([{ id: 'ATK-001', kind: 'spec', baseRev: 1, approve: true }], atk.id);
      assert.equal(spec.status, 'applied', JSON.stringify(spec));
      assert.equal((await sharedItem(mallory, atk.id, '@VIC/secret.md@v1')).status, 403);
    });
    step('linking an item that was not shared with the team is refused', async () => {
      const [r] = await mallory.push(
        [{ id: 'ATK-001', kind: 'spec', baseRev: spec.item.rev, fields: { links: ['@VIC/secret.md@v1'] } }],
        atk.id,
      );
      assert.equal(r.status, 'error', JSON.stringify(r));
      assert.match(r.message, /not shared/);
      assert.equal((await sharedItem(mallory, atk.id, '@VIC/secret.md@v1')).status, 403);
    });
    step('a link in the working copy of a released spec grants nothing (only the released links pin a version)', async () => {
      const db = new DatabaseSync(`${ctx.srv.dir}/specs.db`);
      db.prepare('UPDATE items SET links=? WHERE team_id=? AND id=?').run(JSON.stringify(['@VIC/secret.md@v1']), atk.id, 'ATK-001');
      db.close();
      const leak = await sharedItem(mallory, atk.id, '@VIC/secret.md@v1');
      assert.equal(leak.status, 403, JSON.stringify(leak.data));
    });
    step('the team it was shared with accepts, links and reads it as before', async () => {
      const O = teams.OTHER.id;
      const a = await ctx.admin.post(`/api/teams/${O}/shared/answer`, { owner: teams.VIC.id, itemId: 'secret.md', accept: true });
      assert.equal(a.status, 200, JSON.stringify(a.data));
      const [r] = await ctx.admin.push(
        [{ id: 'OTHER-001', kind: 'spec', baseRev: 0, fields: { title: 'o', body: 'o', links: ['@VIC/secret.md@v1'] } }],
        O,
      );
      assert.equal(r.status, 'applied', JSON.stringify(r));
      const [rel] = await ctx.admin.push([{ id: 'OTHER-001', kind: 'spec', baseRev: r.item.rev, approve: true }], O);
      assert.equal(rel.status, 'applied', JSON.stringify(rel));
      assert.deepEqual(rel.item.releasedLinks, ['@VIC/secret.md@v1']);
      const ok = await sharedItem(ctx.admin, O, '@VIC/secret.md@v1');
      assert.equal(ok.status, 200);
      assert.match(ok.data.item.body, /TOP-SECRET/);
    });
  });

  describe('an invitation link the inviter could see proves no e-mail address', () => {
    const step = chain();
    let squatter;
    step('a team admin registers the address they invited, with their own password', async () => {
      const t = (await mallory.post('/api/teams', { name: 'Squat', key: 'SQT' })).data.team;
      const inv = await mallory.post(`/api/teams/${t.id}/invites`, { email: 'ceo@victim.example', role: 'viewer' });
      const token = inv.data.link.split('/invite/')[1];
      squatter = new Client(ctx.base);
      const reg = await squatter.post(`/api/invites/${token}/accept`, { name: 'CEO', password: 'attacker-pass-1' });
      assert.equal(reg.status, 200, JSON.stringify(reg.data));
      assert.equal(reg.data.me.emailVerified, false);
    });
    step('a later invitation for that address is neither listed nor accepted for the unverified account', async () => {
      const inv = await ctx.admin.post(`/api/teams/${teams.VIC.id}/invites`, { email: 'ceo@victim.example', role: 'approver' });
      assert.equal(inv.status, 200);
      const me = (await squatter.get('/api/me')).data.me;
      assert.deepEqual(me.invites, []);
      const acc = await squatter.post(`/api/me/invites/${inv.data.invite.id}/accept`);
      assert.equal(acc.status, 403, JSON.stringify(acc.data));
      assert.ok(!(await squatter.get('/api/me')).data.me.teams.some((x) => x.key === 'VIC'));
    });
    step('an account created from an instance admin’s invitation is verified and sees its invitations', async () => {
      const inv = await ctx.admin.post(`/api/teams/${teams.VIC.id}/invites`, { email: 'bob@example.com', role: 'viewer' });
      const bob = new Client(ctx.base);
      const reg = await bob.post(`/api/invites/${inv.data.link.split('/invite/')[1]}/accept`, { name: 'Bob', password: 'bob-pass-123' });
      assert.equal(reg.status, 200, JSON.stringify(reg.data));
      assert.equal(reg.data.me.emailVerified, true);
      const second = await ctx.admin.post(`/api/teams/${teams.OTHER.id}/invites`, { email: 'bob@example.com', role: 'editor' });
      const me = (await bob.get('/api/me')).data.me;
      assert.ok(me.invites.some((i) => i.id === second.data.invite.id));
      assert.equal((await bob.post(`/api/me/invites/${second.data.invite.id}/accept`)).status, 200);
    });
  });

  describe('withdrawing a released foundation document needs approval rights', () => {
    const step = chain();
    let editor, rule, policy;
    step('VIC releases a guardrail and a pinned document (auto-release off)', async () => {
      const V = teams.VIC.id;
      await ctx.admin.patch(`/api/teams/${V}`, { foundationAuto: false });
      const body = formatRuleFile({ rule: 'Never log card numbers', kind: 'never' });
      let [r, p] = await ctx.admin.push(
        [
          { id: 'guardrails/no-pan.md', kind: 'doc', baseRev: 0, fields: { title: 'g', body } },
          { id: 'policies.md', kind: 'doc', baseRev: 0, fields: { title: 'p', body: '# Policies\n\nBe kind.\n', pinned: true } },
        ],
        V,
      );
      [rule, policy] = await ctx.admin.push(
        [
          { id: 'guardrails/no-pan.md', kind: 'doc', baseRev: r.item.rev, approve: true },
          { id: 'policies.md', kind: 'doc', baseRev: p.item.rev, approve: true },
        ],
        V,
      );
      assert.equal(rule.item.status, 'approved', JSON.stringify(rule));
      assert.equal(policy.item.status, 'approved', JSON.stringify(policy));
      await ctx.admin.post('/api/users', { email: 'ed@example.com', password: 'editor-pass-1', teamId: V, role: 'editor' });
      editor = await signIn('ed@example.com', 'editor-pass-1');
    });
    step('an editor cannot delete a released guardrail', async () => {
      const [d] = await editor.push([{ id: 'guardrails/no-pan.md', kind: 'doc', baseRev: rule.item.rev, delete: true }], teams.VIC.id);
      assert.equal(d.status, 'error', JSON.stringify(d));
      assert.equal(d.forbidden, true);
      assert.equal(d.item.status, 'approved');
    });
    step('an editor cannot un-pin a released foundation document', async () => {
      const [u] = await editor.push(
        [{ id: 'policies.md', kind: 'doc', baseRev: policy.item.rev, fields: { pinned: false } }],
        teams.VIC.id,
      );
      assert.equal(u.status, 'error', JSON.stringify(u));
      assert.equal(u.forbidden, true);
      const items = (await editor.sync([], 0, teams.VIC.id)).data.items;
      const cur = items.find((i) => i.id === 'policies.md');
      assert.equal(cur.pinned, true);
      assert.equal(cur.status, 'approved');
    });
    step('an approver can', async () => {
      const [d] = await ctx.admin.push([{ id: 'guardrails/no-pan.md', kind: 'doc', baseRev: rule.item.rev, delete: true }], teams.VIC.id);
      assert.equal(d.status, 'applied', JSON.stringify(d));
    });
  });
});
