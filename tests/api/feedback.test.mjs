// Feedback on specs: agents leave it, people triage it; proposals to accept or delete a spec; e-mail digests; withdrawing.
//   node --test tests/api/feedback.test.mjs
import assert from 'node:assert/strict';
import { before, after, describe } from 'node:test';
import { useServer, makeUser, chain, mcpClient, call, toolNames, startSmtpSink } from '../helpers.mjs';

const smtp = await startSmtpSink();

describe('feedback on specs (agents leave it, people triage it)', () => {
  after(() => smtp.stop());
  const ctx = useServer({
    FEEDBACK_MAIL_DEBOUNCE_MS: '300',
    SMTP_URL: `smtp://127.0.0.1:${smtp.port}`,
    SMTP_FROM: 'Specs <specs@example.test>',
  });
  const step = chain();
  const mcp = (token) => mcpClient(ctx.base, token);
  const sid = 'SPEC-012';
  let admin, T1, fbEd, fbViewer, fa, revBefore, f1, quiet;
  before(async () => {
    ({ admin, T1 } = ctx);
    fbEd = await makeUser(ctx, 'editor', 'fb');
    fbViewer = await makeUser(ctx, 'viewer', 'fb');
  });
  after(async () => {
    await fa?.close();
  });

  step('feedback tools exist only for tokens with write access', async () => {
    const fbTok = (
      await fbEd.c.post('/api/me/tokens', { name: 'Reviewer agent', scopes: ['mcp:read', 'mcp:drafts', 'mcp:write'], teamId: T1 })
    ).data;
    const roTok = (await fbViewer.c.post('/api/me/tokens', { name: 'ro', scopes: ['mcp:read'], teamId: T1 })).data;
    const ro = await mcp(roTok.token);
    const roNames = await toolNames(ro);
    await ro.close();
    assert.ok(!roNames.includes('add_feedback') && !roNames.includes('list_feedback'));
    fa = await mcp(fbTok.token);
    assert.ok((await toolNames(fa)).includes('add_feedback'));
  });
  step('an agent leaves feedback; the same open feedback is merged instead of repeated', async () => {
    revBefore = (await fbEd.c.sync([], 0)).data.items.find((x) => x.id === sid).rev;
    f1 = JSON.parse(
      (
        await call(fa, 'add_feedback', {
          spec_id: sid,
          kind: 'conflict',
          section: '## ENDPOINTS',
          text: 'POST /webhooks/keys/rotate is implemented as PUT in src/hooks.ts',
          evidence: 'src/hooks.ts:42',
        })
      ).text,
    );
    assert.equal(f1.status, 'open');
    assert.equal(f1.duplicate, false);
    const f1b = JSON.parse(
      (
        await call(fa, 'add_feedback', {
          spec_id: sid,
          kind: 'conflict',
          section: '## endpoints',
          text: 'POST /webhooks/keys/rotate  is implemented as PUT in src/hooks.ts',
        })
      ).text,
    );
    assert.equal(f1b.duplicate, true);
    assert.equal(f1b.id, f1.id);
  });
  step('unknown spec, empty text and unknown kinds are refused', async () => {
    assert.equal((await call(fa, 'add_feedback', { spec_id: 'NOPE-1', kind: 'question', text: 'x' })).isError, true);
    assert.equal((await call(fa, 'add_feedback', { spec_id: sid, kind: 'question', text: '   ' })).isError, true);
    await assert.rejects(async () => {
      const r = await fa.callTool({ name: 'add_feedback', arguments: { spec_id: sid, kind: 'rant', text: 'x' } });
      if (r.isError) throw new Error('rejected');
    });
  });
  step('feedback never changes the spec; open counts travel with the sync', async () => {
    const afterSync = (await fbEd.c.sync([], 0)).data;
    assert.equal(afterSync.feedbackOpen[sid], 1);
    assert.equal(afterSync.items.find((x) => x.id === sid).rev, revBefore);
  });
  step('everyone in the team can read feedback', async () => {
    const listed = (await fbViewer.c.get(`/api/teams/${T1}/feedback?spec=${sid}`)).data.feedback;
    assert.equal(listed.length, 1);
    assert.match(listed[0].via, /Reviewer agent/);
    assert.match(listed[0].author, /editor user/);
    assert.equal(listed[0].evidence, 'src/hooks.ts:42');
  });
  step('viewers cannot triage feedback', async () => {
    assert.equal((await fbViewer.c.req('PATCH', `/api/teams/${T1}/feedback/${f1.id}`, { status: 'accepted' })).status, 403);
  });
  step('a person accepts feedback and replies', async () => {
    assert.equal((await fbEd.c.req('PATCH', `/api/teams/${T1}/feedback/${f1.id}`, { status: 'bogus' })).status, 400);
    const tri = (
      await fbEd.c.req('PATCH', `/api/teams/${T1}/feedback/${f1.id}`, { status: 'accepted', reply: 'Right – fixing the spec to PUT.' })
    ).data.feedback;
    assert.equal(tri.status, 'accepted');
    assert.match(tri.resolvedBy, /editor user/);
  });
  step('the agent sees the decision and the reply (list_feedback)', async () => {
    const again = JSON.parse((await call(fa, 'list_feedback', { spec_id: sid })).text);
    assert.equal(again[0].status, 'accepted');
    assert.match(again[0].reply, /fixing the spec/);
    assert.equal(JSON.parse((await call(fa, 'list_feedback', { status: 'open' })).text).length, 0);
  });
  step('after triage the same finding can be raised again', async () => {
    assert.equal(
      JSON.parse(
        (
          await call(fa, 'add_feedback', {
            spec_id: sid,
            kind: 'conflict',
            section: '## ENDPOINTS',
            text: 'POST /webhooks/keys/rotate is implemented as PUT in src/hooks.ts',
          })
        ).text,
      ).duplicate,
      false,
    );
  });

  describe('proposals: agents ask, approvers decide; deleting a spec takes its comments with it', () => {
    let apr, pr;
    step('an editor cannot accept a proposal', async () => {
      apr = await makeUser(ctx, 'approver', 'prop');
      const mkSpec = async (title) => (await apr.c.push([{ id: 'SPEC-890', kind: 'spec', baseRev: 0, fields: { title } }]))[0].item;
      const sp = await mkSpec('Proposal target');
      assert.equal(sp.status, 'draft');
      pr = JSON.parse((await call(fa, 'propose_acceptance', { spec_id: 'SPEC-890', reason: 'Ready for review' })).text);
      assert.equal(pr.status, 'open');
      assert.equal(JSON.parse((await call(fa, 'propose_acceptance', { spec_id: 'SPEC-890', reason: 'again' })).text).duplicate, true);
      assert.equal((await call(fa, 'propose_deletion', { spec_id: 'NOPE-1', reason: 'x' })).isError, true);
      assert.equal((await fbEd.c.req('PATCH', `/api/teams/${T1}/feedback/${pr.id}`, { status: 'accepted' })).status, 403);
    });
    step('accepting propose_acceptance releases the spec', async () => {
      assert.equal(
        (await apr.c.req('PATCH', `/api/teams/${T1}/feedback/${pr.id}`, { status: 'accepted' })).data.feedback.status,
        'accepted',
      );
      const sp = (await apr.c.sync([], 0)).data.items.find((x) => x.id === 'SPEC-890');
      assert.equal(sp.status, 'approved');
    });
    step('accepting propose_deletion revokes and deletes the spec together with its feedback', async () => {
      await call(fa, 'add_feedback', { spec_id: 'SPEC-890', kind: 'question', text: 'a comment that must not outlive its spec' });
      const pd = JSON.parse((await call(fa, 'propose_deletion', { spec_id: 'SPEC-890', reason: 'obsolete' })).text);
      const viaSync = (
        await apr.c.req('POST', `/api/teams/${T1}/sync`, { since: 0, changes: [], feedbackOps: [{ id: pd.id, status: 'accepted' }] })
      ).data; // what the offline outbox of a client sends
      assert.deepEqual(viaSync.fbResults, [{ id: pd.id, ok: true }]);
      assert.equal((await apr.c.sync([], 0)).data.items.find((x) => x.id === 'SPEC-890')?.deleted ?? true, true);
      assert.equal((await apr.c.get(`/api/teams/${T1}/feedback?spec=SPEC-890`)).data.feedback.length, 0);
    });
  });

  // e-mail digest to approvers and admins (not to the author), switchable per team
  describe('e-mail digests and withdrawing', () => {
    const waitMail = async (pred, ms = 4000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const m = smtp.mails.find(pred);
        if (m) return m;
        await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    };
    let fbAppr, fo;
    after(async () => {
      await fo?.close();
    });
    step('new feedback is e-mailed to approvers and admins as one digest', async () => {
      assert.equal((await fbEd.c.sync([], 0)).data.feedbackOpen[sid], 1);
      fbAppr = await makeUser(ctx, 'approver', 'fbm');
      await call(fa, 'add_feedback', { spec_id: sid, kind: 'gap', text: 'digest probe' });
      const digest = await waitMail((m) => /new feedback/.test(m.subject) && m.to.includes(fbAppr.email) && /digest probe/.test(m.raw)); // (creating a user takes a moment: an earlier digest may already be there)
      assert.ok(digest, 'digest mail');
      assert.match(digest.raw, /SPEC-012/);
      assert.ok(!digest.to.includes(fbEd.email));
    });
    step('several findings in a short time arrive in a single mail', async () => {
      await call(fa, 'add_feedback', { spec_id: sid, kind: 'question', text: 'second finding' });
      await call(fa, 'add_feedback', { spec_id: sid, kind: 'gap', text: 'third finding' });
      await waitMail((m) => /2 new feedback/.test(m.subject) && m.to.includes(fbAppr.email));
      assert.ok(smtp.mails.some((m) => /2 new feedback/.test(m.subject)));
    });
    step('team admins can switch the feedback e-mails off', async () => {
      assert.equal((await admin.req('PATCH', `/api/teams/${T1}`, { feedbackMail: false })).data.team.feedbackMail, false);
      const nMails = smtp.mails.length;
      quiet = JSON.parse((await call(fa, 'add_feedback', { spec_id: sid, kind: 'suggestion', text: 'no mail for this one' })).text);
      await new Promise((r) => setTimeout(r, 900));
      assert.equal(smtp.mails.length, nMails);
      await admin.req('PATCH', `/api/teams/${T1}`, { feedbackMail: true });
      // how long closed feedback is kept is a team setting, too: forever unless an admin chooses a period
      assert.equal((await admin.get(`/api/teams/${T1}`)).data.team.feedbackKeepDays, 0);
      assert.equal((await admin.req('PATCH', `/api/teams/${T1}`, { feedbackKeepDays: 45 })).status, 400);
      assert.equal((await admin.req('PATCH', `/api/teams/${T1}`, { feedbackKeepDays: 180 })).data.team.feedbackKeepDays, 180);
      assert.equal((await admin.get('/api/me')).data.me.teams.find((t) => t.id === T1).feedbackKeepDays, 180);
      await admin.req('PATCH', `/api/teams/${T1}`, { feedbackKeepDays: 0 });
    });
    // withdrawing: only your own, only while open
    step('an agent cannot withdraw feedback of someone else', async () => {
      const other = await makeUser(ctx, 'editor', 'fb2');
      const otherTok = (
        await other.c.post('/api/me/tokens', { name: 'Other agent', scopes: ['mcp:read', 'mcp:drafts', 'mcp:write'], teamId: T1 })
      ).data;
      fo = await mcp(otherTok.token);
      assert.equal((await call(fo, 'withdraw_feedback', { id: quiet.id })).isError, true);
    });
    step('an agent can withdraw its own open feedback; withdrawn entries do not count as open', async () => {
      const wd = JSON.parse((await call(fa, 'withdraw_feedback', { id: quiet.id })).text);
      assert.equal(wd.status, 'withdrawn');
      assert.equal(JSON.parse((await call(fa, 'list_feedback', { status: 'withdrawn' })).text).length, 1);
      const oc = (await fbEd.c.sync([], 0)).data.feedbackOpen[sid];
      assert.equal(oc, 4);
    });
    step('feedback a person decided about cannot be withdrawn', async () => {
      assert.match((await call(fa, 'withdraw_feedback', { id: f1.id })).text, /already accepted/);
    });
  });
});
