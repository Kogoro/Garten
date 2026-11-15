// The gardener loop: work list, decisions, implementation reports, the agent webhook; pausing, metrics, blocked specs, claims and triggers, steering, spec quality.
//   node --test tests/api/garden.test.mjs
import assert from 'node:assert/strict';
import { before, after, describe } from 'node:test';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { useServer, makeUser, chain, startServer, mcpClient, call, toolNames, Client } from '../helpers.mjs';

describe('the gardener loop', () => {
  const ctx = useServer({ HOOK_DEBOUNCE_MS: '250', HOOK_ALLOW_LOCAL: '1' });
  const mcp = (token) => mcpClient(ctx.base, token);
  const mk = (role, tag) => makeUser(ctx, role, tag);
  let admin, T1, uniq, BASE;
  before(() => { ({ admin, T1, uniq, base: BASE } = ctx); });

  describe('work list, decisions, implementation reports, webhook', () => {
    const step = chain();
    const hits = [];
    const sink = createHttpServer((req, res) => {
      let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
        hits.push({ url: req.url, headers: req.headers, body: JSON.parse(b || '{}') });
        if (req.url === '/fail') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"bad token"}'); }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'routine_fire', claude_code_session_id: 'session_1', claude_code_session_url: 'https://claude.ai/code/session_1' }));
      });
    });
    const waitHits = async (count, ms = 4000) => { const t0 = Date.now(); while (hits.length < count && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50)); return hits.length; };
    const work = async (c = ro) => JSON.parse((await call(c, 'get_work_list')).text);
    const release = async (body) => {
      const cur = (await gEd.c.sync([], 0)).data.items.find((x) => x.id === gid);
      const rr = await gAp.c.push([{ id: gid, kind: 'spec', baseRev: cur?.rev ?? 0, approve: true, fields: { title: 'Invoice export', body } }]);
      assert.equal(rr[0].item.status, 'approved', JSON.stringify(rr)); return rr[0].item;
    };
    let sinkUrl, gEd, gAp, gView, ag, ro, syncUrl, gid, w, draftId, q, d1, dl, s1, d3, crit, reps;
    before(async () => {
      await new Promise((r) => sink.listen(0, '127.0.0.1', r));
      sinkUrl = `http://127.0.0.1:${sink.address().port}`;
      gEd = await mk('editor', 'g'); gAp = await mk('approver', 'g'); gView = await mk('viewer', 'g');
      syncUrl = `/api/teams/${T1}/sync`;
      gid = `G${uniq.toUpperCase()}`;
    });
    after(async () => { await ag?.close(); await ro?.close(); sink.close(); });

    step('everyone reads the work list, reports and decisions; only writers report and ask', async () => {
      const agTok = (await gEd.c.post('/api/me/tokens', { name: 'Builder agent', scopes: ['mcp:read', 'mcp:drafts', 'mcp:write'], teamId: T1 })).data;
      const roTok2 = (await gView.c.post('/api/me/tokens', { name: 'ro', scopes: ['mcp:read'], teamId: T1 })).data;
      ag = await mcp(agTok.token); ro = await mcp(roTok2.token);
      const roNames = await toolNames(ro); const agNames = await toolNames(ag);
      assert.ok(['get_work_list', 'get_spec_changes', 'list_reports', 'list_decisions'].every((x) => roNames.includes(x)) && !roNames.includes('report_implementation') && !roNames.includes('request_decision'));
      assert.ok(agNames.includes('report_implementation') && agNames.includes('request_decision'));
    });
    step('a released spec without a report is new work', async () => {
      await release('## GOAL\nExport invoices\n\n## ACCEPTANCE CRITERIA\n- [ ] CSV export\n- [ ] PDF export\n');
      w = (await work()).work.find((x) => x.spec_id === gid);
      assert.equal(w.state, 'new'); assert.equal(w.version, 1);
    });
    step('reports are only accepted for released specs', async () => {
      draftId = JSON.parse((await call(ag, 'create_draft_spec', { title: 'Not released', body: '## GOAL\nx' })).text).id;
      assert.match((await call(ag, 'report_implementation', { spec_id: draftId, status: 'implemented', summary: 'x' })).text, /not released/);
    });

    // decisions: an agent asks, a person answers (also offline, through the sync)
    step('an agent asks for a decision; the same open question is not recorded twice', async () => {
      q = { spec_id: gid, question: 'Which delimiter for the CSV export?', options: [{ label: 'Comma' }, { label: 'Semicolon', detail: 'Opens directly in a German Excel' }], recommended: 1, context: 'src/export.ts has no setting for it', section: '## ACCEPTANCE CRITERIA' };
      d1 = JSON.parse((await call(ag, 'request_decision', q)).text);
      assert.equal(d1.status, 'open'); assert.equal(d1.blocking, true); assert.equal(d1.duplicate, false);
      assert.equal(JSON.parse((await call(ag, 'request_decision', { ...q, question: 'which delimiter  for the CSV export?' })).text).id, d1.id);
    });
    step('a decision needs 2–6 distinct options and a valid recommendation', async () => {
      const refused = async (args) => { try { return (await ag.callTool({ name: 'request_decision', arguments: args })).isError === true; } catch { return true; } };
      assert.ok(await refused({ ...q, question: 'q2', options: [{ label: 'only one' }] })); assert.ok(await refused({ ...q, question: 'q3', recommended: 5 })); assert.ok(await refused({ ...q, question: 'q4', options: [{ label: 'A' }, { label: 'a ' }] }));
    });
    step('decisions are listed separately from feedback, with options and the recommendation', async () => {
      assert.ok(!JSON.parse((await call(ag, 'list_feedback', { spec_id: gid })).text).some((f) => f.id === d1.id));
      dl = JSON.parse((await call(ro, 'list_decisions', { spec_id: gid })).text);
      assert.equal(dl.length, 1); assert.equal(dl[0].status, 'open'); assert.equal(dl[0].options[1].recommended, true); assert.equal(dl[0].answer, undefined);
    });
    step('open decisions travel with the sync for offline use, and only when something changed', async () => {
      w = (await work()).work.find((x) => x.spec_id === gid); assert.equal(w.waiting_for_decision[0].id, d1.id); assert.equal(w.waiting_for_decision[0].blocking, true);
      s1 = (await gEd.c.post(syncUrl, { since: 1e9, changes: [] })).data;
      const gd = s1.garden.feedback.find((f) => f.id === d1.id);
      assert.equal(gd.kind, 'decision'); assert.equal(gd.options.length, 2); assert.equal(gd.recommended, 1); assert.equal(s1.feedbackOpen[gid], 1);
      assert.equal((await gEd.c.post(syncUrl, { since: 1e9, changes: [], gardenRev: s1.garden.rev })).data.garden, undefined);
    });
    step('viewers cannot answer decisions', async () => {
      const vr = (await gView.c.post(syncUrl, { since: 1e9, changes: [], feedbackOps: [{ id: d1.id, answer: 0 }] })).data;
      assert.equal(vr.fbResults[0].ok, false); assert.equal((await gView.c.req('PATCH', `/api/teams/${T1}/feedback/${d1.id}`, { answer: 0 })).status, 403);
    });
    step('an answer must be one of the options, or an own answer in words', async () => {
      assert.equal((await gEd.c.req('PATCH', `/api/teams/${T1}/feedback/${d1.id}`, { answer: 9 })).status, 400);
      assert.equal((await gEd.c.req('PATCH', `/api/teams/${T1}/feedback/${d1.id}`, { answer: -1 })).status, 400);
      assert.equal((await gEd.c.req('PATCH', `/api/teams/${T1}/feedback/${d1.id}`, { status: 'answered' })).status, 400);
      assert.equal((await gEd.c.req('PATCH', `/api/teams/${T1}/feedback/${d1.id}`, { status: 'accepted' })).status, 400);
    });
    step('answers given offline arrive with the next sync; a refused one does not block the others', async () => {
      const s2 = (await gEd.c.post(syncUrl, { since: 1e9, changes: [], gardenRev: s1.garden.rev, feedbackOps: [{ id: d1.id, answer: 1, reply: 'Our customers use a German Excel.' }, { id: 'nope', status: 'done' }] })).data;
      assert.deepEqual(s2.fbResults.map((x) => x.ok), [true, false]);
      const ga = s2.garden.feedback.find((f) => f.id === d1.id); assert.equal(ga.status, 'answered'); assert.equal(ga.answer, 1); assert.match(ga.resolvedBy, /editor user/); assert.equal(s2.feedbackOpen[gid], undefined);
    });
    step('the agent reads the answer (list_decisions)', async () => {
      dl = JSON.parse((await call(ag, 'list_decisions', { id: d1.id })).text);
      assert.equal(dl[0].status, 'answered'); assert.deepEqual(dl[0].answer, { option: 1, label: 'Semicolon' }); assert.match(dl[0].note, /German Excel/);
    });
    step('an answered decision shows up in the work list and can no longer be withdrawn', async () => {
      w = (await work(ag)).work.find((x) => x.spec_id === gid); assert.equal(w.decisions_answered[0].answer, 'Semicolon'); assert.equal(w.waiting_for_decision, undefined);
      assert.match((await call(ag, 'withdraw_feedback', { id: d1.id })).text, /already answered/);
    });
    step('own answers in words, reopening and withdrawing open questions work; a withdrawn question cannot be answered', async () => {
      const d2 = JSON.parse((await call(ag, 'request_decision', { spec_id: gid, question: 'Paper size of the PDF?', options: ['A4', 'Letter'], blocking: false })).text);
      assert.equal(d2.blocking, false);
      const own = (await gEd.c.req('PATCH', `/api/teams/${T1}/feedback/${d2.id}`, { answer: -1, reply: 'Take it from the customer locale.' })).data.feedback;
      assert.equal(own.status, 'answered'); assert.equal(own.answer, -1);
      assert.deepEqual(JSON.parse((await call(ag, 'list_decisions', { id: d2.id })).text)[0].answer, { option: null, label: null });
      const reopened = (await gEd.c.req('PATCH', `/api/teams/${T1}/feedback/${d2.id}`, { status: 'open' })).data.feedback;
      assert.equal(reopened.status, 'open'); assert.equal(reopened.answer, null);
      assert.equal(JSON.parse((await call(ag, 'withdraw_feedback', { id: d2.id })).text).status, 'withdrawn');
      assert.equal((await gEd.c.req('PATCH', `/api/teams/${T1}/feedback/${d2.id}`, { answer: 0 })).status, 409);
    });

    // implementation reports
    step('a report with open criteria cannot claim "implemented"', async () => {
      crit = [{ text: 'CSV export', status: 'met' }, { text: 'PDF export', status: 'open', note: 'needs a PDF library' }];
      assert.match((await call(ag, 'report_implementation', { spec_id: gid, status: 'implemented', summary: 'CSV done', criteria: crit })).text, /partial/);
    });
    step('an agent reports criteria, evidence and deviations; everyone in the team can read the report', async () => {
      assert.equal((await call(ag, 'report_implementation', { spec_id: gid, status: 'partial', summary: 'x', version: 7 })).isError, true);
      const r1 = JSON.parse((await call(ag, 'report_implementation', { spec_id: gid, status: 'partial', summary: 'CSV export works, PDF is open.', criteria: crit, evidence: [{ kind: 'commit', ref: 'abc1234', note: 'export module' }], deviations: 'Dates are ISO, not localized.' })).text);
      assert.equal(r1.status, 'partial'); assert.equal(r1.version, 1);
      reps = (await gView.c.get(`/api/teams/${T1}/reports?spec=${gid}`)).data.reports;
      assert.equal(reps.length, 1); assert.equal(reps[0].criteria[1].status, 'open'); assert.equal(reps[0].evidence[0].ref, 'abc1234'); assert.match(reps[0].via, /Builder agent/); assert.match(reps[0].deviations, /ISO/);
    });
    step('get_criteria: the spec\'s own checklist with stable ids and what the last report said; reports are matched to it', async () => {
      w = (await work()).work.find((x) => x.spec_id === gid); assert.equal(w.state, 'partial'); assert.equal(w.last_report.status, 'partial');
      const gc = JSON.parse((await call(ro, 'get_criteria', { spec_id: gid })).text);
      assert.deepEqual(gc.criteria.map((c) => [c.id, c.text, c.last_reported]), [['AC1', 'CSV export', 'met'], ['AC2', 'PDF export', 'open']]); assert.equal(reps[0].criteria[0].id, 'AC1');
      assert.equal((await call(ro, 'get_criteria', { spec_id: draftId })).isError, true);
    });
    step('a spec with an "implemented" report for its current version leaves the work list; the latest report travels with the sync', async () => {
      await call(ag, 'report_implementation', { spec_id: gid, status: 'implemented', summary: 'CSV and PDF export are done.', criteria: crit.map((c) => ({ text: c.text, status: 'met' })), evidence: [{ kind: 'pr', ref: 'https://git.example/pr/7' }] });
      const wl = await work(); assert.equal(wl.work.find((x) => x.spec_id === gid), undefined); assert.ok(wl.up_to_date >= 1);
      const s3 = (await gEd.c.post(syncUrl, { since: 1e9, changes: [] })).data;
      assert.equal(s3.garden.reports[gid].status, 'implemented'); assert.equal(s3.garden.reports[gid].specVersion, 1);
    });
    // an agent reading a spec reaches the devices as a time, without the spec (and its body) being sent again
    step('agent reads travel as fetched times apart from the items; full syncs and older clients still see fetchedAt on the item', async () => {
      assert.equal(JSON.parse((await call(ro, 'list_reports', { spec_id: gid })).text).length, 2);
      const fs0 = (await gEd.c.post(syncUrl, { since: 0, changes: [], fetchedSince: '' })).data;
      await call(ro, 'get_spec', { id: gid });
      const fs1 = (await gEd.c.post(syncUrl, { since: fs0.cursor, changes: [], fetchedSince: fs0.fetchedCursor })).data;
      assert.equal(fs1.items.some((x) => x.id === gid), false); assert.ok(fs1.fetched[gid] > fs0.fetchedCursor); assert.equal(fs1.fetchedCursor, fs1.fetched[gid]);
      assert.deepEqual((await gEd.c.post(syncUrl, { since: fs1.cursor, changes: [], fetchedSince: fs1.fetchedCursor })).data.fetched, {});
      assert.equal((await gEd.c.sync([], 0)).data.items.find((x) => x.id === gid).fetchedAt, fs1.fetched[gid]);
      assert.equal((await gEd.c.sync([], fs0.cursor)).data.fetched, undefined);
    });
    // a new release makes it work again, and shows what changed
    step('a newer release puts the spec back on the work list as changed, with the changed sections and a diff', async () => {
      await release('## GOAL\nExport invoices\n\n## ACCEPTANCE CRITERIA\n- [ ] CSV export\n- [ ] PDF export\n- [ ] XLSX export\n\n## OUT OF SCOPE\nPrinting\n');
      w = (await work()).work.find((x) => x.spec_id === gid); assert.equal(w.state, 'changed'); assert.equal(w.changed_from, 1); assert.equal(w.version, 2);
      const ch = JSON.parse((await call(ro, 'get_spec_changes', { id: gid })).text);
      assert.equal(ch.from, 1); assert.equal(ch.to, 2); assert.deepEqual(ch.sections_changed, [{ section: 'ACCEPTANCE CRITERIA', change: 'changed' }, { section: 'OUT OF SCOPE', change: 'added' }]); assert.match(ch.diff, /\+- \[ \] XLSX export/);
      assert.equal((await call(ro, 'get_spec_changes', { id: gid, from: 2, to: 2 })).isError, true); assert.equal((await call(ro, 'get_spec_changes', { id: 'NOPE-9' })).isError, true);
    });
    step('"implemented" is refused while a criterion of the spec is missing from the report', async () => {
      const short = await call(ag, 'report_implementation', { spec_id: gid, status: 'implemented', summary: 'All done', criteria: [{ id: 'AC1', status: 'met' }, { text: 'pdf export.', status: 'met' }] });
      assert.equal(short.isError, true); assert.match(short.text, /leaves out 1: AC3 "XLSX export"/);
    });
    step('unknown ids and the same criterion twice are refused', async () => {
      assert.match((await call(ag, 'report_implementation', { spec_id: gid, status: 'partial', summary: 'x', criteria: [{ id: 'AC9', status: 'met' }] })).text, /no criterion "AC9"/);
      assert.match((await call(ag, 'report_implementation', { spec_id: gid, status: 'partial', summary: 'x', criteria: [{ id: 'AC1', status: 'met' }, { text: 'CSV export', status: 'met' }] })).text, /both AC1/);
    });
    step('criteria left out are stored as open in the spec\'s order; extra lines of the agent are kept', async () => {
      const r2 = JSON.parse((await call(ag, 'report_implementation', { spec_id: gid, status: 'partial', summary: 'CSV and PDF', criteria: [{ id: 'AC1', status: 'met' }, { text: 'PDF export', status: 'met' }, { text: 'Faster than before', status: 'met' }] })).text);
      assert.deepEqual(r2.not_reported, ['AC3']); assert.equal(r2.not_in_spec, 1);
      const lr2 = (await gView.c.get(`/api/teams/${T1}/reports?spec=${gid}`)).data.reports[0];
      assert.deepEqual(lr2.criteria.map((c) => [c.id ?? null, c.status]), [['AC1', 'met'], ['AC2', 'met'], ['AC3', 'open'], [null, 'met']]); assert.equal(lr2.criteria[2].missing, true); assert.equal(lr2.criteria[0].text, 'CSV export');
    });

    // webhook: tells an agent runner about releases and answers
    const hookOf = async (c = admin) => (await c.get(`/api/teams/${T1}`)).data.team.hook;
    step('only team admins see and change the webhook', async () => { assert.equal((await gEd.c.req('PATCH', `/api/teams/${T1}`, { hook: { url: `${sinkUrl}/fire` } })).status, 403); assert.equal(await hookOf(gEd.c), undefined); });
    step('invalid webhook settings are refused', async () => {
      assert.equal((await admin.post(`/api/teams/${T1}/hook/test`)).status, 400);
      assert.equal((await admin.req('PATCH', `/api/teams/${T1}`, { hook: { url: `${sinkUrl}/fire`, headers: 'Host: evil' } })).status, 400);
      assert.equal((await admin.req('PATCH', `/api/teams/${T1}`, { hook: { url: `${sinkUrl}/fire`, headers: 'no colon here' } })).status, 400);
      assert.equal((await admin.req('PATCH', `/api/teams/${T1}`, { hook: { url: 'ftp://x.example/y' } })).status, 400);
      assert.equal((await admin.req('PATCH', `/api/teams/${T1}`, { hook: { url: `${sinkUrl}/fire`, format: 'xml' } })).status, 400);
    });
    step('the webhook token is write-only and encrypted at rest', async () => {
      const saved = (await admin.req('PATCH', `/api/teams/${T1}`, { hook: { url: `${sinkUrl}/fire`, token: 'sk-hook-SECRET42', headers: 'anthropic-beta: experimental-cc-routine-2026-04-01\nanthropic-version: 2023-06-01', format: 'text', events: ['release', 'answer'] } })).data.team.hook;
      assert.equal(saved.hasToken, true); assert.deepEqual(saved.headerNames, ['anthropic-beta', 'anthropic-version']); assert.equal(saved.format, 'text');
      assert.ok(!JSON.stringify((await admin.get(`/api/teams/${T1}`)).data).includes('SECRET42')); assert.ok(!readFileSync(`${ctx.srv.dir}/specs.db`).includes('sk-hook-SECRET42'));
    });
    step('the test call sends token, headers and a text-only body (Claude Code routine format) and records the answer', async () => {
      const tst = (await admin.post(`/api/teams/${T1}/hook/test`)).data;
      assert.equal(tst.ok, true); assert.equal(hits.length, 1); assert.equal(hits[0].headers.authorization, 'Bearer sk-hook-SECRET42'); assert.equal(hits[0].headers['anthropic-beta'], 'experimental-cc-routine-2026-04-01');
      assert.deepEqual(Object.keys(hits[0].body), ['text']); assert.equal(tst.hook.lastOk, true); assert.equal(tst.hook.lastUrl, 'https://claude.ai/code/session_1');
    });
    step('a release and an answer shortly after each other reach the webhook as one call', async () => {
      await release('## GOAL\nExport invoices\n\n## ACCEPTANCE CRITERIA\n- [ ] CSV export\n- [ ] PDF export\n- [ ] XLSX export\n- [ ] Totals row\n');
      d3 = JSON.parse((await call(ag, 'request_decision', { spec_id: gid, question: 'Totals per currency?', options: ['Yes', 'No'] })).text);
      await gEd.c.req('PATCH', `/api/teams/${T1}/feedback/${d3.id}`, { answer: 0 });
      assert.equal(await waitHits(2), 2); await new Promise((r) => setTimeout(r, 500)); assert.equal(hits.length, 2);
      assert.match(hits[1].body.text, new RegExp(`${gid} v3: Invoice export`)); assert.match(hits[1].body.text, /Totals per currency\?" → Yes/); assert.match(hits[1].body.text, /get_work_list/);
    });
    step('the full format carries structured data; events can be limited; a changed answer is sent again', async () => {
      await admin.req('PATCH', `/api/teams/${T1}`, { hook: { format: 'full', events: ['answer'] } });
      assert.equal((await hookOf()).hasToken, true);
      await release('## GOAL\nExport invoices\n\n## ACCEPTANCE CRITERIA\n- [ ] CSV export\n');
      await gEd.c.req('PATCH', `/api/teams/${T1}/feedback/${d3.id}`, { answer: 1, reply: 'changed my mind' });
      assert.equal(await waitHits(3), 3);
      assert.equal(hits[2].body.event, 'answer'); assert.equal(hits[2].body.released.length, 0); assert.equal(hits[2].body.answered[0].answer, 'No'); assert.equal(hits[2].body.team.key, 'SPEC'); assert.match(hits[2].body.mcpUrl, /\/mcp$/);
    });
    step('a failing webhook is reported and recorded', async () => {
      await admin.req('PATCH', `/api/teams/${T1}`, { hook: { url: `${sinkUrl}/fail` } });
      const bad = (await admin.post(`/api/teams/${T1}/hook/test`)).data; assert.equal(bad.ok, false); assert.match(bad.hook.lastInfo, /HTTP 401/); assert.equal(bad.hook.lastOk, false);
    });
    step('removing the webhook URL also removes token and headers', async () => {
      const off = (await admin.req('PATCH', `/api/teams/${T1}`, { hook: { url: '' } })).data.team.hook;
      assert.equal(off.url, ''); assert.equal(off.hasToken, false); assert.deepEqual(off.headerNames, []);
    });
  });

  // by default a webhook never points into the server's own network
  describe('webhook targets without HOOK_ALLOW_LOCAL', () => {
    const step = chain();
    let strict;
    after(() => strict?.kill());
    step('webhooks must be https and must not target local or private addresses', async () => {
      strict = await startServer({});
      const sa = new Client(strict.base); await sa.login('admin@localhost', 'adminpass1');
      for (const u of ['http://example.com/hook', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.1.2.3/x', 'https://192.168.1.10:8443/x', 'https://[::1]/x', 'https://169.254.169.254/latest', 'https://printer.local/x', 'https://user:pw@example.com/x'])
        assert.equal((await sa.req('PATCH', `/api/teams/${sa.tid}`, { hook: { url: u } })).status, 400, u);
      assert.equal((await sa.req('PATCH', `/api/teams/${sa.tid}`, { hook: { url: 'https://hooks.example.com/x' } })).status, 200);
    });
  });

  // pausing the agents: empty work list, no webhook calls, a person can resume
  describe('pausing the agents', () => {
    const step = chain();
    let pEd, probe, wl;
    after(async () => { await probe?.close(); });
    step('only team admins can pause the agents', async () => {
      pEd = await mk('editor', 'pz');
      const tok = (await admin.post('/api/me/tokens', { name: 'pause probe', scopes: ['mcp:read'], teamId: admin.tid })).data.token;
      probe = await mcp(tok);
      wl = async () => JSON.parse((await call(probe, 'get_work_list')).text);
      assert.equal((await pEd.c.req('PATCH', `/api/teams/${admin.tid}`, { agentPaused: true })).status, 403);
    });
    step('paused agents get an empty work list with a note; everybody sees that they are paused', async () => {
      const before = await wl(); assert.equal(before.paused, undefined);
      const off = (await admin.req('PATCH', `/api/teams/${admin.tid}`, { agentPaused: true })).data.team; assert.equal(off.agentPaused, true);
      const paused = await wl(); assert.equal(paused.paused, true); assert.deepEqual(paused.work, []); assert.match(paused.note, /paused/);
      assert.equal((await admin.get('/api/me')).data.me.teams.find((t) => t.id === admin.tid).agentPaused, true);
    });
    step('resuming gives the agents their work list back', async () => {
      await admin.req('PATCH', `/api/teams/${admin.tid}`, { agentPaused: false });
      const after = await wl(); assert.equal(after.paused, undefined); assert.ok(after.released_specs >= 0);
    });
  });

  // team metrics: computed from the data the app holds
  describe('team metrics', () => {
    const step = chain();
    step('team health: process figures are computed from existing data and need a sign-in', async () => {
      const anon = new Client(BASE);
      const m = (await admin.get(`/api/teams/${admin.tid}/metrics`)).data.metrics;
      assert.equal(m.days, 30); assert.ok(m.releasedSpecs >= 1 && m.releasedInPeriod >= 1); assert.equal(typeof m.implementation.none, 'number');
      assert.ok(m.medianHoursDraftToRelease === null || m.medianHoursDraftToRelease >= 0); assert.equal((await anon.get(`/api/teams/${admin.tid}/metrics`)).status, 401);
    });
  });

  // a blocked spec comes back to the top of the work list when a person answers or dismisses the question
  describe('blocked specs', () => {
    const step = chain();
    const sid = 'SPEC-871';
    let bEd, ag, wl;
    after(async () => { await ag?.close(); });
    step('an answer moves a blocked spec to "decision_answered" at the top of the work list', async () => {
      bEd = await mk('editor', 'bl');
      ag = await mcp((await bEd.c.post('/api/me/tokens', { name: 'Blocked agent', scopes: ['mcp:read', 'mcp:drafts', 'mcp:write'], teamId: T1 })).data.token);
      const r = await admin.push([{ id: sid, kind: 'spec', baseRev: 0, fields: { title: 'Blocked spec', body: '## REQUIREMENTS\nR1 Do the thing\n\n## ACCEPTANCE CRITERIA\n- [ ] It works\n' } }]);
      await admin.push([{ id: sid, kind: 'spec', baseRev: r[0].item.rev, approve: true, fields: {} }]);
      wl = async () => JSON.parse((await call(ag, 'get_work_list')).text).work.find((x) => x.spec_id === sid);
      const q1 = JSON.parse((await call(ag, 'request_decision', { spec_id: sid, question: 'Which thing?', options: ['A', 'B'] })).text);
      const blocked = JSON.parse((await call(ag, 'report_implementation', { spec_id: sid, status: 'blocked', summary: 'Waiting for the choice', criteria: [{ id: 'R1', status: 'open' }] })).text);
      assert.deepEqual(blocked.not_reported, ['AC1']);
      let w = await wl(); assert.equal(w.state, 'blocked');
      await new Promise((res) => setTimeout(res, 5));
      await bEd.c.req('PATCH', `/api/teams/${T1}/feedback/${q1.id}`, { answer: 1 });
      w = await wl(); assert.equal(w.state, 'decision_answered'); assert.equal(w.decisions_answered[0].outcome, 'answered'); assert.equal(w.decisions_answered[0].answer, 'B'); assert.equal(w.last_report.status, 'blocked');
    });
    step('a dismissed question reaches the agent too, with the note, and unblocks the spec', async () => {
      await call(ag, 'report_implementation', { spec_id: sid, status: 'blocked', summary: 'Still stuck on something else', criteria: [{ id: 'R1', status: 'open' }] });
      const q2 = JSON.parse((await call(ag, 'request_decision', { spec_id: sid, question: 'Which colour?', options: ['Red', 'Blue'] })).text);
      await new Promise((res) => setTimeout(res, 5));
      await bEd.c.req('PATCH', `/api/teams/${T1}/feedback/${q2.id}`, { status: 'dismissed', reply: 'Not a product question – pick one.' });
      const w = await wl(); assert.equal(w.state, 'decision_answered'); assert.deepEqual([w.decisions_answered[0].outcome, w.decisions_answered[0].answer, w.decisions_answered[0].note], ['dismissed', null, 'Not a product question – pick one.']);
    });
    step('reading feedback does not use up the hourly write budget', async () => {
      for (let i = 0; i < 65; i++) assert.ok(!(await call(ag, 'list_feedback', { spec_id: sid })).isError);
      assert.ok(!(await call(ag, 'add_feedback', { spec_id: sid, kind: 'gap', text: 'Colour is not specified' })).isError);
    });
  });

  // claims, liveness and the new trigger events (check, resume)
  describe('claims, liveness and trigger events', () => {
    const step = chain();
    const hits = [];
    const sink = createHttpServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { hits.push(JSON.parse(b || '{}')); res.writeHead(200); res.end('{}'); }); });
    const waitHits = async (count, ms = 4000) => { const t0 = Date.now(); while (hits.length < count && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50)); return hits.length; };
    const sid = 'SPEC-872';
    const body = (n) => `## ACCEPTANCE CRITERIA\n- [ ] Works (${n})\n`;
    const release = async (n) => { const cur = (await admin.sync()).data.items.find((i) => i.id === sid); const r = await admin.push([{ id: sid, kind: 'spec', baseRev: cur?.rev ?? 0, approve: true, fields: { title: 'Claimed spec', body: body(n) } }]); assert.equal(r[0].status, 'applied', JSON.stringify(r)); };
    const listOf = async (c) => JSON.parse((await call(c, 'get_work_list')).text);
    let cEd, tokA, A, B, ci;
    before(async () => {
      await new Promise((r) => sink.listen(0, '127.0.0.1', r));
      cEd = await mk('editor', 'cl');
      tokA = (await cEd.c.post('/api/me/tokens', { name: 'Agent A', scopes: ['mcp:read', 'mcp:drafts', 'mcp:write'], teamId: T1 })).data;
      const tokB = (await cEd.c.post('/api/me/tokens', { name: 'Agent B', scopes: ['mcp:read', 'mcp:drafts', 'mcp:write'], teamId: T1 })).data;
      A = await mcp(tokA.token); B = await mcp(tokB.token);
      await release(1);
    });
    after(async () => { await A?.close(); await B?.close(); sink.close(); });
    step('claims: a claimed spec is listed apart for other agents, and a second claim is refused', async () => {
      const cA = JSON.parse((await call(A, 'claim_spec', { spec_id: sid, note: 'writing the parser' })).text);
      assert.equal(cA.renewed, false); assert.ok(Date.parse(cA.until) - Date.now() > 25 * 60_000);
      const wB = await listOf(B);
      assert.ok(!wB.work.some((x) => x.spec_id === sid)); const other = wB.claimed_by_others.find((x) => x.spec_id === sid); assert.match(other.by, /Agent A/); assert.equal(other.doing, 'writing the parser');
      const refusedB = await call(B, 'claim_spec', { spec_id: sid }); assert.equal(refusedB.isError, true); assert.match(refusedB.text, /being built by token: Agent A/);
      assert.ok((await listOf(A)).work.find((x) => x.spec_id === sid).claimed_by_you_until);
    });
    step('claims: the holder renews its claim (heartbeat); only released specs can be claimed', async () => {
      assert.equal(JSON.parse((await call(A, 'claim_spec', { spec_id: sid, minutes: 60 })).text).renewed, true);
      assert.equal((await call(A, 'claim_spec', { spec_id: 'NOPE-1' })).isError, true);
    });
    step('liveness: the garden knows every agent, its last call, what it builds and when its token runs out', async () => {
      const g = (await cEd.c.post(`/api/teams/${T1}/sync`, { since: 1e9, changes: [] })).data.garden;
      const ga = g.agents.find((x) => x.name === 'token: Agent A');
      assert.equal(ga.connected, true); assert.equal(ga.lastTool, 'claim_spec'); assert.ok(Date.parse(ga.tokenExpiresAt) > Date.now()); assert.equal(ga.claims[0].specId, sid); assert.match(g.claims[sid].by, /Agent A/);
      assert.ok(g.agents.find((x) => x.name === 'token: Agent B'));
    });
    step('claims: an in_progress report renews the claim, any other report gives it back; unclaim_spec only frees the own claim', async () => {
      assert.ok(JSON.parse((await call(A, 'report_implementation', { spec_id: sid, status: 'in_progress', summary: 'Started' })).text).claimed_until);
      await call(A, 'report_implementation', { spec_id: sid, status: 'partial', summary: 'Half', criteria: [{ id: 'AC1', status: 'open' }] });
      assert.equal(JSON.parse((await call(B, 'claim_spec', { spec_id: sid })).text).renewed, false);
      assert.equal(JSON.parse((await call(B, 'unclaim_spec', { spec_id: sid })).text).released, true); assert.equal(JSON.parse((await call(A, 'unclaim_spec', { spec_id: sid })).text).released, false);
    });

    // trigger: failing CI results, stale checks (once per run) and resuming paused agents
    step('trigger: a failing check from CI calls the trigger; one the agent reported itself does not', async () => {
      await admin.req('PATCH', `/api/teams/${T1}`, { hook: { url: `http://127.0.0.1:${sink.address().port}/fire`, events: ['check', 'resume'], format: 'full' } });
      await call(A, 'register_check', { spec_id: sid, name: 'unit: parser', kind: 'test', how: 'npm test' });
      ci = (st) => fetch(`${BASE}/api/ci/checks/results`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokA.token}` }, body: JSON.stringify({ spec_id: sid, name: 'unit: parser', status: st, value: st === 'fail' ? '3 failed' : '9 passed' }) });
      await ci('fail');
      assert.equal(await waitHits(1), 1); assert.equal(hits[0].event, 'check'); assert.deepEqual([hits[0].checks[0].state, hits[0].checks[0].source], ['failing', 'ci']); assert.match(hits[0].text, /unit: parser": failing in CI \(3 failed\)/);
      await call(A, 'report_check_result', { spec_id: sid, name: 'unit: parser', status: 'fail' }); await new Promise((r) => setTimeout(r, 600)); assert.equal(hits.length, 1);
    });
    step('trigger: a check that went stale is announced once per run', async () => {
      await ci('pass'); await release(2);
      assert.equal(await waitHits(2), 2); assert.equal(hits[1].checks[0].state, 'stale'); assert.match(hits[1].text, /stale – run it again/);
      await release(3); await new Promise((r) => setTimeout(r, 600)); assert.equal(hits.length, 2);
    });
    step('trigger: resuming paused agents calls the trigger', async () => {
      await admin.req('PATCH', `/api/teams/${T1}`, { agentPaused: true }); await admin.req('PATCH', `/api/teams/${T1}`, { agentPaused: false });
      assert.equal(await waitHits(3), 3); assert.equal(hits[2].event, 'resume'); assert.equal(hits[2].resumed, true);
      await admin.req('PATCH', `/api/teams/${T1}`, { hook: { url: '' } });
    });
  });

  // steering: priority, hold and dependencies decide what agents build next
  describe('steering', () => {
    const step = chain();
    const ids = ['SPEC-881', 'SPEC-882', 'SPEC-883'];
    const steer = (c, id, body) => c.req('PATCH', `/api/teams/${T1}/steering/${id}`, body);
    const wl = async () => JSON.parse((await call(ag, 'get_work_list')).text);
    const pos = (w, id) => w.work.findIndex((x) => x.spec_id === id);
    let sEd, ag;
    before(async () => {
      sEd = await mk('editor', 'st');
      ag = await mcp((await sEd.c.post('/api/me/tokens', { name: 'Steered agent', scopes: ['mcp:read', 'mcp:drafts', 'mcp:write'], teamId: T1 })).data.token);
      for (const id of ids) { const r = await admin.push([{ id, kind: 'spec', baseRev: 0, fields: { title: `Steered ${id}`, body: '## ACCEPTANCE CRITERIA\n- [ ] Done\n' } }]); await admin.push([{ id, kind: 'spec', baseRev: r[0].item.rev, approve: true, fields: {} }]); }
    });
    after(async () => { await ag?.close(); });
    step('steering: only approvers and admins steer', async () => { assert.equal((await steer(sEd.c, ids[0], { priority: 'high' })).status, 403); });
    step('steering: high priority comes first in the work list', async () => {
      assert.equal((await steer(admin, ids[2], { priority: 'urgent' })).status, 400);
      assert.equal((await steer(admin, ids[2], { priority: 'high' })).data.steering.priority, 'high');
      const w = await wl(); assert.ok(pos(w, ids[2]) < pos(w, ids[0])); assert.equal(w.work[pos(w, ids[2])].priority, 'high'); assert.equal(w.work[0].priority, 'high');
    });
    step('steering: a spec on hold leaves the work list, with the note', async () => {
      await steer(admin, ids[0], { hold: true, holdNote: 'Waiting for legal' });
      const w = await wl(); assert.equal(pos(w, ids[0]), -1); assert.deepEqual(w.on_hold.find((x) => x.spec_id === ids[0]).note, 'Waiting for legal');
    });
    step('steering: a spec waits until its dependencies are implemented; unknown specs and cycles are refused', async () => {
      await steer(admin, ids[1], { depends: [ids[2]] });
      assert.equal((await steer(admin, ids[2], { depends: [ids[1]] })).status, 400); assert.equal((await steer(admin, ids[1], { depends: ['NOPE-1'] })).status, 400); assert.equal((await steer(admin, ids[1], { depends: [ids[1]] })).status, 400);
      const w = await wl(); assert.equal(pos(w, ids[1]), -1); assert.deepEqual(w.waiting_on_specs.find((x) => x.spec_id === ids[1]).waits_for, [ids[2]]);
    });
    step('steering: an implemented dependency releases the waiting spec; steering travels with the sync', async () => {
      await call(ag, 'report_implementation', { spec_id: ids[2], status: 'implemented', summary: 'Done', criteria: [{ id: 'AC1', status: 'met' }] });
      const w = await wl(); assert.ok(pos(w, ids[1]) >= 0); assert.deepEqual(w.work[pos(w, ids[1])].built_after, [ids[2]]);
      const g = (await admin.post(`/api/teams/${T1}/sync`, { since: 1e9, changes: [] })).data.garden;
      assert.equal(g.steering[ids[0]].hold, true); assert.equal(g.steering[ids[2]].priority, 'high');
      await steer(admin, ids[0], { hold: false }); assert.ok(pos(await wl(), ids[0]) >= 0);
    });
  });

  // spec quality: per type, how much agents had to ask, object, deviate and report again (counts what the suites above left behind)
  describe('spec quality', () => {
    const step = chain();
    let m, q;
    step('quality: every released spec counts under its type', async () => {
      m = (await admin.get(`/api/teams/${T1}/metrics`)).data.metrics;
      q = m.quality;
      assert.equal(q.types.reduce((a, t) => a + t.specs, 0), m.releasedSpecs);
    });
    step('quality: types are ordered by how much agents had to ask or object', () => {
      const feat = q.types.find((t) => t.type === 'feature'); const api = q.types.find((t) => t.type === 'api');
      assert.ok(feat.questionsPerSpec > 0 && feat.label === 'Feature spec' && feat.reportsPerSpec >= 1); assert.ok(api && api.specs >= 1);
      const load = (t) => t.questionsPerSpec + t.feedbackPerSpec;
      assert.ok(q.types.every((t, i) => !i || load(q.types[i - 1]) >= load(t)));
    });
    step('quality: the specs agents struggled with most are listed, rates stay between 0 and 1', () => {
      assert.ok(q.unclear.length > 0 && q.unclear.length <= 5); assert.ok(q.unclear.every((x, i) => x.questions + x.feedback > 0 && (!i || q.unclear[i - 1].questions + q.unclear[i - 1].feedback >= x.questions + x.feedback)));
      assert.ok(q.types.every((t) => t.deviationRate === null || (t.deviationRate >= 0 && t.deviationRate <= 1)));
    });
  });
});
