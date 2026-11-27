// The second gate and the closed loop: people review what agents report as implemented (accept or send back), and outcomes of a
// spec are measured once it is in use – a miss waits on Today until a person has seen it.
//   node --test tests/api/review.test.mjs
import assert from 'node:assert/strict';
import { before, after, describe, test } from 'node:test';
import { createServer as createHttpServer } from 'node:http';
import { useServer, makeUser, chain, mcpClient, call, Client, startServer } from '../helpers.mjs';
import { specOutcomes } from '../../shared/criteria.js';

const BODY =
  '## GOAL\nFaster checkout\n\n## OUTCOMES\n- Checkout conversion reaches 2.5 %\n- Fewer support tickets about payment\n\n' +
  '## ACCEPTANCE CRITERIA\n- [ ] One-click pay works\n- [ ] Saved cards are shown\n';

describe('review and outcomes', () => {
  const ctx = useServer();
  const sid = 'SPEC-940';
  const step = chain();
  let admin, T1, ed, view, ag, wTok, report, r;
  const fails = async (name, args) => {
    try {
      const x = await ag.callTool({ name, arguments: args });
      return x.isError === true ? x.content[0].text : null;
    } catch (e) {
      return String(e.message);
    }
  };
  const work = async () => JSON.parse((await call(ag, 'get_work_list')).text);
  const entry = async () => (await work()).work.find((x) => x.spec_id === sid);
  const garden = async () => (await admin.sync([], 1e9)).data.garden;
  const review = (who, body) => who.post(`/api/teams/${T1}/reviews/${sid}`, body);
  const ci = (body) =>
    fetch(`${ctx.base}/api/ci/checks/results`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${wTok}` },
      body: JSON.stringify(body),
    }).then((x) => x.json());
  const implemented = (extra = {}) =>
    call(ag, 'report_implementation', {
      spec_id: sid,
      status: 'implemented',
      summary: 'Built one-click pay',
      criteria: [
        { id: 'AC1', status: 'met' },
        { id: 'AC2', status: 'met' },
      ],
      ...extra,
    });

  before(async () => {
    ({ admin, T1 } = ctx);
    ed = await makeUser(ctx, 'editor', 'rv');
    view = await makeUser(ctx, 'viewer', 'rv');
    wTok = (await ed.c.post('/api/me/tokens', { name: 'Review agent', scopes: ['mcp:read', 'mcp:drafts', 'mcp:write'], teamId: T1 })).data
      .token;
    ag = await mcpClient(ctx.base, wTok);
  });
  after(async () => {
    await ag?.close();
  });

  step('outcomes: list items under OUTCOMES are O1, O2 … and are not acceptance criteria', async () => {
    assert.deepEqual(
      specOutcomes(BODY).map((o) => [o.id, o.text]),
      [
        ['O1', 'Checkout conversion reaches 2.5 %'],
        ['O2', 'Fewer support tickets about payment'],
      ],
    );
    r = await admin.push([{ id: sid, kind: 'spec', baseRev: 0, fields: { title: 'One-click checkout', body: BODY } }]);
    r = await admin.push([{ id: sid, kind: 'spec', baseRev: r[0].item.rev, approve: true, fields: {} }]);
    assert.equal(r[0].item.version, 1);
    const crit = JSON.parse((await call(ag, 'get_criteria', { spec_id: sid })).text);
    assert.deepEqual(
      crit.criteria.map((c) => c.id),
      ['AC1', 'AC2'],
    );
    assert.deepEqual(
      crit.outcomes.map((o) => o.id),
      ['O1', 'O2'],
    );
    assert.match(crit.outcomes_note, /register_check with outcome/);
  });

  step('outcomes: a check measures an outcome of the released spec; it cannot prove a criterion', async () => {
    assert.match(
      (await fails('register_check', { spec_id: sid, name: 'm', kind: 'metric', how: 'q', outcome: 'O9' })) ?? '',
      /no outcome "O9"/,
    );
    const reg = JSON.parse(
      (
        await call(ag, 'register_check', {
          spec_id: sid,
          name: 'metric: conversion',
          kind: 'metric',
          how: 'SELECT conversion FROM daily',
          expect: '>= 2.5 %',
          outcome: 'o1',
          max_age_days: 7,
        })
      ).text,
    );
    assert.equal(reg.outcome, 'O1');
    assert.match(reg.note, /Do not name it in report_implementation/);
    assert.match(
      (await fails('report_implementation', {
        spec_id: sid,
        status: 'implemented',
        summary: 's',
        criteria: [
          { id: 'AC1', status: 'met', checks: ['metric: conversion'] },
          { id: 'AC2', status: 'met' },
        ],
      })) ?? '',
      /measures an outcome/,
    );
  });

  step('review: an implemented report names the outcomes without a measurement and goes to review', async () => {
    const out = JSON.parse((await implemented()).text);
    assert.deepEqual(
      out.unmeasured_outcomes.map((o) => o.id),
      ['O2'],
    );
    assert.match(out.note, /A person reviews it next/);
    report = (await admin.get(`/api/teams/${T1}/reports?spec=${sid}`)).data.reports[0];
    assert.equal(report.review, null);
    // the unmeasured outcome check does not put the spec back on the work list
    assert.equal(await entry(), undefined);
  });

  step('review: only approvers review; a send-back needs a note and known criteria', async () => {
    assert.equal((await review(ed.c, { verdict: 'accepted' })).status, 403);
    assert.equal((await review(view.c, { verdict: 'accepted' })).status, 403);
    assert.equal((await review(admin, { verdict: 'maybe' })).status, 400);
    assert.match((await review(admin, { verdict: 'returned', note: ' ' })).data.error, /what has to change/);
    assert.match((await review(admin, { verdict: 'returned', note: 'x', criteria: ['AC7'] })).data.error, /no criterion "AC7"/);
    assert.equal((await review(admin, { verdict: 'accepted', reportId: 'older' })).status, 409);
  });

  step('review: sent back, the spec is on the work list again with the note, and the build is not counted', async () => {
    r = await review(admin, {
      verdict: 'returned',
      note: 'Saved cards show the full number – mask it',
      criteria: ['ac2'],
      reportId: report.id,
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.report.review.verdict, 'returned');
    assert.deepEqual(r.data.report.review.criteria, ['AC2']);
    const e = await entry();
    assert.equal(e.state, 'sent_back');
    assert.match(e.review.note, /mask it/);
    assert.deepEqual(e.review.criteria, [{ id: 'AC2', text: 'Saved cards are shown' }]);
    assert.match(e.hint, /report again/);
    const crit = JSON.parse((await call(ag, 'get_criteria', { spec_id: sid })).text);
    assert.equal(crit.criteria.find((c) => c.id === 'AC2').sent_back, true);
    assert.equal(crit.review.verdict, 'returned');
    const lr = JSON.parse((await call(ag, 'list_reports', { spec_id: sid })).text);
    assert.equal(lr[0].review.verdict, 'returned');
    const m = (await admin.get(`/api/teams/${T1}/metrics`)).data.metrics;
    assert.equal(m.review.sentBack, 1);
    assert.ok(m.quality.types.find((t) => t.type === 'feature').sentBackPerSpec > 0);
  });

  step('review: a new report starts a new review; accepted, it is done', async () => {
    await implemented({ summary: 'Masked the card number' });
    assert.equal(await entry(), undefined);
    const g = await garden();
    assert.equal(g.reports[sid].review, null);
    r = await review(admin, { verdict: 'accepted', reportId: g.reports[sid].id });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.report.review.verdict, 'accepted');
    assert.equal((await admin.get(`/api/teams/${T1}/metrics`)).data.metrics.review.accepted, 1);
    const audit = (await admin.get('/api/admin/audit?limit=50')).data.entries;
    assert.ok(audit.some((x) => x.action === 'spec.accept_build'));
    assert.ok(audit.some((x) => x.action === 'spec.send_back'));
  });

  step('review: a report that is not implemented, or about an older version, cannot be reviewed', async () => {
    await call(ag, 'report_implementation', { spec_id: sid, status: 'in_progress', summary: 'Polishing' });
    assert.match((await review(admin, { verdict: 'accepted' })).data.error, /not "implemented"/);
    await implemented();
  });

  step('outcomes: a miss measured in use waits for a person, not for the agent, until someone has seen it', async () => {
    let out = await ci({ spec_id: sid, name: 'metric: conversion', status: 'fail', value: '2.1 %' });
    assert.equal(out.results[0].state, 'failing');
    let c = (await garden()).checks[sid].find((x) => x.name === 'metric: conversion');
    assert.equal(c.outcome, 'O1');
    assert.equal(c.needsAttention, true);
    assert.equal(await entry(), undefined, 'an outcome off target is not work for the agent');
    assert.equal((await admin.get(`/api/teams/${T1}/metrics`)).data.metrics.outcomes.offTarget, 1);
    assert.equal((await view.c.post(`/api/teams/${T1}/outcomes/${sid}/ack`, { name: 'metric: conversion' })).status, 403);
    r = await ed.c.post(`/api/teams/${T1}/outcomes/${sid}/ack`, { name: 'metric: conversion' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.check.needsAttention, undefined);
    assert.equal(r.data.check.ack.by, 'editor user');
    // still off target: stays seen
    await ci({ spec_id: sid, name: 'metric: conversion', status: 'fail', value: '2.2 %' });
    c = (await garden()).checks[sid].find((x) => x.name === 'metric: conversion');
    assert.equal(c.needsAttention, undefined);
    // on target, then off again: a new miss
    await ci({ spec_id: sid, name: 'metric: conversion', status: 'pass', value: '2.6 %' });
    await ci({ spec_id: sid, name: 'metric: conversion', status: 'fail', value: '2.0 %' });
    c = (await garden()).checks[sid].find((x) => x.name === 'metric: conversion');
    assert.equal(c.needsAttention, true);
  });

  step('outcomes: a new spec version does not make the measurement stale', async () => {
    await ci({ spec_id: sid, name: 'metric: conversion', status: 'pass', value: '2.7 %' });
    const cur = (await admin.sync()).data.items.find((i) => i.id === sid);
    r = await admin.push([{ id: sid, kind: 'spec', baseRev: cur.rev, approve: true, fields: { body: BODY + '- [ ] Works offline\n' } }]);
    assert.equal(r[0].item.version, 2);
    const c = (await garden()).checks[sid].find((x) => x.name === 'metric: conversion');
    assert.equal(c.state, 'passing');
    // the old review belongs to v1: v2 is "changed" for the agent
    assert.equal((await entry()).state, 'changed');
  });
});

describe('review: the agent trigger hears about a build sent back', () => {
  let srv, hook, ag, r;
  const got = [];
  after(async () => {
    await ag?.close();
    await srv?.kill();
    hook?.close();
  });
  test('a send-back calls the trigger with the note; new teams have the event on', async () => {
    hook = createHttpServer((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        got.push(JSON.parse(b || '{}'));
        res.writeHead(200);
        res.end('{}');
      });
    });
    await new Promise((r) => hook.listen(0, '127.0.0.1', r));
    srv = await startServer({ HOOK_ALLOW_LOCAL: '1', HOOK_DEBOUNCE_MS: '100', SEED_DEMO: '0' });
    const c = new Client(srv.base);
    await c.login('admin@localhost', 'adminpass1');
    const t = c.tid;
    const nt = (await c.post('/api/teams', { name: 'Fresh team' })).data;
    const ntId = nt.team?.id ?? nt.id;
    assert.ok(ntId, JSON.stringify(nt));
    assert.deepEqual((await c.get(`/api/teams/${ntId}`)).data.team.hook.events, ['release', 'answer', 'review']);
    r = await c.req('PATCH', `/api/teams/${t}`, {
      hook: { url: `http://127.0.0.1:${hook.address().port}/fire`, format: 'full', events: ['release', 'answer', 'review'] },
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    await c.push([
      {
        id: 'SPEC-001',
        kind: 'spec',
        baseRev: 0,
        approve: true,
        fields: { title: 'Hooked', body: '## ACCEPTANCE CRITERIA\n- [ ] Works\n' },
      },
    ]);
    const tok = (await c.post('/api/me/tokens', { name: 'a', scopes: ['mcp:read', 'mcp:drafts', 'mcp:write'], teamId: t })).data.token;
    ag = await mcpClient(srv.base, tok);
    await call(ag, 'report_implementation', {
      spec_id: 'SPEC-001',
      status: 'implemented',
      summary: 'done',
      criteria: [{ id: 'AC1', status: 'met' }],
    });
    for (let i = 0; i < 40 && !got.length; i++) await new Promise((x) => setTimeout(x, 100)); // the release call
    got.length = 0;
    r = await c.post(`/api/teams/${t}/reviews/SPEC-001`, { verdict: 'returned', note: 'Handle the empty cart' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    for (let i = 0; i < 40 && !got.length; i++) await new Promise((x) => setTimeout(x, 100));
    assert.equal(got.length, 1);
    assert.equal(got[0].event, 'review');
    assert.equal(got[0].returned[0].spec_id, 'SPEC-001');
    assert.match(got[0].text, /Sent back after review[\s\S]*Handle the empty cart/);
  });
});
