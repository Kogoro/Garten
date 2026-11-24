// E-mail delivery of invitations and the admin test e-mail, against an in-process SMTP sink.
//   node --test tests/api/invite-mail.test.mjs
import assert from 'node:assert/strict';
import { before, after, describe } from 'node:test';
import { useServer, makeUser, chain, startServer, startSmtpSink, Client } from '../helpers.mjs';

const smtp = await startSmtpSink();

describe('e-mail delivery of invitations', () => {
  after(() => smtp.stop());
  const ctx = useServer({ MAX_TEAMS_PER_USER: '2', SMTP_URL: `smtp://127.0.0.1:${smtp.port}`, SMTP_FROM: 'Specs <specs@example.test>' });
  const step = chain();
  let admin, T1, uniq, viewer, t2, mailTo, sent, got, tokenFromMail;
  before(async () => {
    ({ admin, T1, uniq } = ctx);
    viewer = await makeUser(ctx, 'viewer');
    t2 = (await admin.post('/api/teams', { name: 'Payments', key: 'PAY' })).data.team; // a second team for the HTML-escaping check
  });

  step('invitation is e-mailed when a mail server is configured (the link goes only to the mailbox)', async () => {
    mailTo = `mailtest-${uniq}@example.com`;
    sent = await admin.post(`/api/teams/${T1}/invites`, { email: mailTo, role: 'editor' });
    assert.equal(sent.status, 200);
    assert.equal(sent.data.mailEnabled, true);
    assert.equal(sent.data.emailed, true);
    assert.equal(sent.data.link, undefined, 'the inviter does not get the mailed link');
  });
  step('the mail names team, inviter and role, contains the one-time link and its expiry', async () => {
    got = smtp.mails.find((m) => m.to.includes(mailTo));
    assert.ok(got, 'mail arrived at the sink');
    assert.match(got.subject, /invited you to specs/);
    assert.match(got.from, /specs@example\.test/);
    assert.match(got.text, /#\/invite\/inv_[\w-]+/, 'mail contains the one-time link');
    assert.match(got.text, /as editor/);
    assert.match(got.text, /expires in 7 days/);
  });
  step('the link from the e-mail is valid', async () => {
    tokenFromMail = /#\/invite\/(inv_[\w-]+)/.exec(got.text)[1];
    assert.equal((await new Client(ctx.base).get(`/api/invites/${tokenFromMail}`)).status, 200);
  });
  step('an account created from a mailed link counts as verified, also when a non-admin invited', async () => {
    const own = (await viewer.c.post('/api/teams', { name: 'Viewer own', key: 'VOWN' })).data.team;
    const to = `mailed-${uniq}@example.com`;
    const inv = await viewer.c.post(`/api/teams/${own.id}/invites`, { email: to, role: 'viewer' });
    assert.equal(inv.data.emailed, true);
    assert.equal(inv.data.link, undefined);
    const tok = /#\/invite\/(inv_[\w-]+)/.exec(smtp.mails.find((m) => m.to.includes(to)).text)[1];
    const reg = await new Client(ctx.base).post(`/api/invites/${tok}/accept`, { name: 'Mailed', password: 'mailed-pass-1' });
    assert.equal(reg.status, 200, JSON.stringify(reg.data));
    assert.equal(reg.data.me.emailVerified, true);
  });
  step('re-sending replaces the old link (the old one stops working)', async () => {
    const again = await admin.post(`/api/teams/${T1}/invites`, { email: mailTo, role: 'viewer' });
    assert.equal(again.data.emailed, true);
    assert.equal((await new Client(ctx.base).get(`/api/invites/${tokenFromMail}`)).status, 404);
    assert.equal(smtp.mails.filter((m) => m.to.includes(mailTo)).length, 2);
  });
  step('team and user names are HTML-escaped in the mail', async () => {
    await admin.req('PATCH', `/api/teams/${t2.id}`, { name: 'Pay <script>alert(1)</script>' });
    await admin.post(`/api/teams/${t2.id}/invites`, { email: `html-${uniq}@example.com`, role: 'viewer' });
    const htmlMail = smtp.mails.at(-1);
    assert.ok(!htmlMail.text.includes('<script>alert(1)</script>') || !/<a [^>]*>.*<script>/.test(htmlMail.text));
    assert.match(htmlMail.text, /&lt;script&gt;/);
    await admin.req('PATCH', `/api/teams/${t2.id}`, { name: 'Payments' });
  });

  // a broken mail server must not block the invitation and must not leak credentials
  describe('a broken mail server', () => {
    const step = chain();
    let brokenMail, ba;
    before(async () => {
      brokenMail = await startServer({ SMTP_URL: 'smtp://mailuser:topsecretpw@127.0.0.1:1', MAX_TEAMS_PER_USER: '2' });
      ba = new Client(brokenMail.base);
      await ba.login('admin@localhost', 'adminpass1');
    });
    after(() => brokenMail?.kill());
    step('a failing mail server still yields the link, reports the problem and leaks no credentials', async () => {
      const failed = await ba.post(`/api/teams/${ba.tid}/invites`, { email: 'x@example.com', role: 'viewer' });
      assert.equal(failed.status, 200);
      assert.equal(failed.data.emailed, false);
      assert.match(failed.data.emailError, /could not be sent/);
      assert.ok(failed.data.link);
      assert.ok(!JSON.stringify(failed.data).includes('topsecretpw') && !brokenMail.log().includes('topsecretpw'));
    });
    step('admin test e-mail reports delivery failures', async () => {
      const tm = await ba.post('/api/admin/mail/test');
      assert.equal(tm.status, 502);
      assert.ok(!JSON.stringify(tm.data).includes('topsecretpw'));
    });
  });

  step('admin can send a test e-mail to themselves', async () => {
    const tmOk = await admin.post('/api/admin/mail/test');
    assert.equal(tmOk.status, 200);
    assert.ok(smtp.mails.some((m) => m.to.includes('admin@localhost') && /test e-mail/.test(m.subject)));
  });
  step('only instance admins can trigger the test e-mail', async () => {
    assert.equal((await viewer.c.post('/api/admin/mail/test')).status, 403);
    assert.equal((await admin.get('/api/admin/teams')).data.mail.enabled, true);
  });
});
