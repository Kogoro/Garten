// Re-runnable evidence (checks) and guardrails: registering and reporting checks, the CI endpoint and CI loop, guardrails that change after a spec was built.
//   node --test tests/api/checks.test.mjs
import assert from 'node:assert/strict';
import { before, after, describe } from 'node:test';
import { useServer, makeUser, chain, mcpClient, call, toolNames } from '../helpers.mjs';
import { formatRuleFile, parseRuleFile } from '../../shared/guardrailFiles.js';

describe('checks and guardrails', () => {
  const ctx = useServer();
  const mcp = (token) => mcpClient(ctx.base, token);
  const mk = (role, tag) => makeUser(ctx, role, tag);
  const fails = async (c, name, args) => {
    try {
      const x = await c.callTool({ name, arguments: args });
      return x.isError === true ? x.content[0].text : null;
    } catch (e) {
      return String(e.message);
    }
  };
  let admin, T1, BASE;
  before(() => {
    ({ admin, T1, base: BASE } = ctx);
  });

  describe('v0.12: re-runnable evidence (checks)', () => {
    const step = chain();
    const sid = 'SPEC-870';
    const wl = async () => JSON.parse((await call(ro, 'get_work_list')).text).work.find((x) => x.spec_id === sid);
    let kEd, kView, wTok, rTok, ag, ro, r, w;
    before(async () => {
      kEd = await mk('editor', 'k');
      kView = await mk('viewer', 'k');
      wTok = (await kEd.c.post('/api/me/tokens', { name: 'Check agent', scopes: ['mcp:read', 'mcp:drafts', 'mcp:write'], teamId: T1 }))
        .data;
      rTok = (await kView.c.post('/api/me/tokens', { name: 'ro', scopes: ['mcp:read'], teamId: T1 })).data;
      ag = await mcp(wTok.token);
      ro = await mcp(rTok.token);
    });
    after(async () => {
      await ag?.close();
      await ro?.close();
    });

    step('checks: everybody reads them, only write tokens register and report', async () => {
      r = await admin.push([
        {
          id: sid,
          kind: 'spec',
          baseRev: 0,
          fields: {
            title: 'Checked spec',
            body: '## GOAL\nx\n\n## ACCEPTANCE CRITERIA\n- [ ] Rotation works\n- [ ] Old key accepted for 24 h\n',
          },
        },
      ]);
      r = await admin.push([{ id: sid, kind: 'spec', baseRev: r[0].item.rev, approve: true, fields: {} }]);
      assert.equal(r[0].item.version, 1);
      const roNames = await toolNames(ro),
        agNames = await toolNames(ag);
      assert.ok(roNames.includes('list_checks') && !roNames.includes('register_check') && !roNames.includes('report_check_result'));
      assert.ok(agNames.includes('register_check') && agNames.includes('report_check_result') && agNames.includes('retire_check'));
    });
    step('checks: a check needs a spec and a way to run it', async () => {
      const reg = JSON.parse(
        (
          await call(ag, 'register_check', {
            spec_id: sid,
            name: 'unit: rotation',
            kind: 'test',
            how: 'npm test -- rotation',
            expect: 'exit 0',
            criterion: 'Rotation works',
          })
        ).text,
      );
      assert.equal(reg.state, 'unverified');
      assert.match(
        (await fails(ag, 'register_check', { spec_id: sid, name: 'bad', kind: 'test', how: ' ' })) ?? '',
        /how to run|Too small|how/i,
      );
      assert.ok(await fails(ag, 'register_check', { spec_id: 'NOPE-1', name: 'x', kind: 'test', how: 'y' }));
    });
    step('a report cannot name a check that does not exist', async () => {
      assert.match(
        (await fails(ag, 'report_implementation', {
          spec_id: sid,
          status: 'implemented',
          summary: 's',
          criteria: [{ text: 'Rotation works', status: 'met', checks: ['does not exist'] }],
        })) ?? '',
        /does not have/,
      );
    });
    step('met criteria without a check are called out to the agent', async () => {
      const rep = JSON.parse(
        (
          await call(ag, 'report_implementation', {
            spec_id: sid,
            status: 'implemented',
            summary: 'Built',
            criteria: [
              { text: 'Rotation works', status: 'met', checks: ['unit: rotation'] },
              { text: 'Old key accepted for 24 h', status: 'met' },
            ],
          })
        ).text,
      );
      assert.equal(rep.unverified_criteria, 1);
    });
    step('an implemented spec whose check never ran is back on the work list as "recheck"', async () => {
      w = await wl();
      assert.equal(w.state, 'recheck');
      assert.equal(w.checks_to_run[0].name, 'unit: rotation');
      assert.equal(w.checks_to_run[0].state, 'unverified');
    });
    step('a passing check takes the spec off the work list', async () => {
      assert.equal(
        JSON.parse(
          (
            await call(ag, 'report_check_result', {
              spec_id: sid,
              name: 'unit: rotation',
              status: 'pass',
              value: '12 passed',
              ref: 'https://ci.example/run/1',
              commit: 'abc123',
            })
          ).text,
        ).state,
        'passing',
      );
      assert.equal(await wl(), undefined);
    });
    step('the report shows which criteria are verified by a passing check and which are only claimed', async () => {
      const lr = (await kEd.c.get(`/api/teams/${T1}/reports?spec=${sid}`)).data.reports[0];
      assert.equal(lr.criteria[0].verified, true);
      assert.equal(lr.criteria[1].verified, false);
      assert.equal(lr.verification.verified, 1);
      assert.equal(lr.verification.claimed, 1);
    });
    step('a failing result puts the spec back on the work list', async () => {
      assert.equal(
        JSON.parse(
          (await call(ag, 'report_check_result', { spec_id: sid, name: 'unit: rotation', status: 'fail', value: '2 failed' })).text,
        ).state,
        'failing',
      );
      w = await wl();
      assert.equal(w.state, 'recheck');
      assert.equal(w.checks_to_run[0].state, 'failing');
    });
    step('check states travel with the sync for offline use', async () => {
      const sy = (await kEd.c.post(`/api/teams/${T1}/sync`, { since: 1e9, changes: [] })).data;
      assert.equal(sy.garden.checks[sid][0].state, 'failing');
      assert.equal(sy.garden.reports[sid].criteria[0].checkStates[0].state, 'failing');
    });
    // a pipeline reports with its own token: source "ci"
    const ci = async (token, body) =>
      fetch(`${BASE}/api/ci/checks/results`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      });
    step('CI endpoint: needs a token with write scope', async () => {
      assert.equal((await ci(null, {})).status, 401);
      assert.equal((await ci(rTok.token, { spec_id: sid, name: 'unit: rotation', status: 'pass' })).status, 403);
    });
    step('CI endpoint: a pipeline reports results; they are marked as coming from CI and the history is kept', async () => {
      const cr = await ci(wTok.token, {
        results: [
          { spec_id: sid, name: 'unit: rotation', status: 'pass', value: '14 passed', ref: 'https://ci.example/run/2', commit: 'def456' },
          { spec_id: sid, name: 'nope', status: 'pass' },
        ],
      });
      const cj = await cr.json();
      assert.equal(cj.results[0].state, 'passing');
      assert.match(cj.results[1].error, /no check/);
      const last = (await kEd.c.get(`/api/teams/${T1}/checks?spec=${sid}`)).data.checks[0];
      assert.equal(last.last.source, 'ci');
      assert.equal(last.runs.length, 3);
      assert.equal(last.state, 'passing');
    });
    // a new released version makes older passing results stale
    step('a passing result for an older spec version is stale after a new release', async () => {
      const cur = (await admin.sync()).data.items.find((i) => i.id === sid);
      r = await admin.push([{ id: sid, kind: 'spec', baseRev: cur.rev, fields: { body: cur.body + '\n- [ ] Third criterion\n' } }]);
      r = await admin.push([{ id: sid, kind: 'spec', baseRev: r[0].item.rev, approve: true, fields: {} }]);
      assert.equal(r[0].item.version, 2);
      w = await wl();
      assert.equal(w.state, 'changed');
      const v2rep = await call(ag, 'report_implementation', {
        spec_id: sid,
        version: 2,
        status: 'implemented',
        summary: 'v2',
        criteria: [
          { text: 'Rotation works', status: 'met', checks: ['unit: rotation'] },
          { id: 'AC2', status: 'met' },
          { id: 'AC3', status: 'deviating', note: 'only for v2 keys' },
        ],
      });
      assert.ok(!v2rep.isError, v2rep.text);
      w = await wl();
      assert.equal(w.state, 'recheck');
      assert.equal(w.checks_to_run[0].state, 'stale');
    });
    step('a retired check no longer counts', async () => {
      assert.equal(JSON.parse((await call(ag, 'retire_check', { spec_id: sid, name: 'unit: rotation' })).text).retired, 'unit: rotation');
      assert.equal((await call(ro, 'list_checks', { spec_id: sid })).text, '[]');
    });
    step('a criterion whose check was retired counts as stale: every met criterion is in exactly one bucket', async () => {
      const rv = (await kEd.c.get(`/api/teams/${T1}/reports?spec=${sid}`)).data.reports[0];
      assert.equal(rv.criteria[0].checkStates[0].state, 'retired');
      assert.deepEqual(rv.verification, { met: 2, verified: 0, claimed: 1, failing: 0, stale: 1 });
    });
  });

  // guardrails: one file per rule (a foundation document every agent receives); people curate them, agents propose
  describe('guardrails', () => {
    const step = chain();
    let agent2, rules;
    const ruleFiles = async () =>
      (await admin.sync()).data.items.filter((i) => i.kind === 'doc' && /^guardrails\/(?!_proposed\/).*\.md$/.test(i.id));
    after(async () => {
      await agent2?.close();
    });
    step('every team has a guardrails folder; each rule is a file with an id, pinned like a foundation document', async () => {
      const items = (await admin.sync()).data.items;
      assert.ok(items.find((i) => i.id === 'guardrails' && i.kind === 'folder'));
      assert.ok(!items.find((i) => i.id === 'guardrails.md'));
      rules = (await ruleFiles()).map((i) => ({ ...i, rule: parseRuleFile(i.body) }));
      assert.deepEqual(rules.map((r) => r.rule.id).sort(), ['G1', 'G2']);
      assert.ok(rules.every((r) => r.pinned && r.status === 'approved'));
    });
    step('agents cannot change the guardrails; they are told to propose', async () => {
      const kEd = await mk('editor', 'k2');
      agent2 = await mcp(
        (await kEd.c.post('/api/me/tokens', { name: 'g', scopes: ['mcp:read', 'mcp:drafts', 'mcp:write'], teamId: T1 })).data.token,
      );
      assert.match(
        (await fails(agent2, 'update_draft_document', { path: rules[0].id, body: 'nothing matters' })) ?? 'no error',
        /foundation document/,
      );
      assert.match(
        (await fails(agent2, 'create_draft_document', { path: 'guardrails/mine.md', body: '---\nrule: "Anything goes"\n---\n' })) ??
          'no error',
        /propose_guardrail/,
      );
    });
    step('released rules reach agents in the team context, one line each and binding; get_guardrails has the reasons', async () => {
      const ctx = (await call(agent2, 'get_team_context')).text;
      assert.match(ctx, /GUARDRAILS below are binding/);
      assert.match(ctx, /### Always\n\n- G1: Verify the signature/);
      assert.match(ctx, /### Never\n\n- G2: Never write card numbers/);
      assert.ok(!ctx.includes('**Why:**'));
      const one = JSON.parse((await call(agent2, 'get_guardrails', { id: 'g2' })).text);
      assert.deepEqual([one[0].id, one[0].kind, one[0].folder], ['G2', 'never', 'security']);
      assert.match(one[0].details, /\*\*Why:\*\*/);
      assert.equal(JSON.parse((await call(agent2, 'get_guardrails')).text).length, 2);
      assert.match((await fails(agent2, 'get_guardrails', { id: 'G99' })) ?? 'no error', /No guardrail/);
    });
    step('a new rule gets the next id; an id is never given twice, not even after its rule was deleted', async () => {
      let r = await admin.push([
        {
          id: 'guardrails/utc.md',
          kind: 'doc',
          baseRev: 0,
          approve: true,
          fields: { title: 'utc', body: formatRuleFile({ rule: 'Store times in UTC.', kind: 'always' }) },
        },
      ]);
      assert.equal(r[0].status, 'applied');
      assert.equal(parseRuleFile(r[0].item.body).id, 'G3');
      assert.ok(r[0].item.pinned);
      r = await admin.push([{ id: 'guardrails/utc.md', kind: 'doc', baseRev: r[0].item.rev, delete: true }]);
      assert.equal(r[0].status, 'applied');
      r = await admin.push([
        {
          id: 'guardrails/tz.md',
          kind: 'doc',
          baseRev: 0,
          fields: { title: 'tz', body: formatRuleFile({ id: 'G3', rule: 'Show local times.', kind: 'always' }) },
        },
      ]);
      assert.equal(parseRuleFile(r[0].item.body).id, 'G4');
      // a move writes the new path first: the rule keeps its id
      r = await admin.push([
        { id: 'guardrails/security/tz.md', kind: 'doc', baseRev: 0, fields: { title: 'tz', body: r[0].item.body } },
        { id: 'guardrails/tz.md', kind: 'doc', baseRev: r[0].item.rev, delete: true },
      ]);
      assert.equal(parseRuleFile(r.find((x) => x.id === 'guardrails/security/tz.md').item.body).id, 'G4');
      // reworded and moved in one sync: the old file is deleted in the same batch, so the id moves with the rule
      const moved = r.find((x) => x.id === 'guardrails/security/tz.md').item;
      r = await admin.push([
        {
          id: 'guardrails/display/tz.md',
          kind: 'doc',
          baseRev: 0,
          fields: { title: 'tz', body: formatRuleFile({ id: 'G4', rule: 'Show times in the viewer’s time zone.', kind: 'always' }) },
        },
        { id: 'guardrails/security/tz.md', kind: 'doc', baseRev: moved.rev, delete: true },
      ]);
      assert.equal(parseRuleFile(r.find((x) => x.id === 'guardrails/display/tz.md').item.body).id, 'G4');
      // an edit without an id (made before the server's id arrived on the device) keeps the file's id
      const tz = r.find((x) => x.id === 'guardrails/display/tz.md').item;
      r = await admin.push([
        {
          id: tz.id,
          kind: 'doc',
          baseRev: tz.rev,
          fields: { body: formatRuleFile({ rule: 'Show times in local time.', kind: 'always' }) },
        },
      ]);
      assert.equal(parseRuleFile(r[0].item.body).id, 'G4');
      const ctx = (await call(agent2, 'get_team_context')).text;
      assert.ok(!ctx.includes('G3:'));
    });
    step('agents propose rules: a proposal has no id, is not released and is refused when the rule exists', async () => {
      const out = JSON.parse(
        (
          await call(agent2, 'propose_guardrail', {
            rule: 'Never retry a charge without an idempotency key.',
            kind: 'never',
            why: 'Double charges.',
            source: 'SPEC-014',
          })
        ).text,
      );
      assert.match(out.proposed, /^guardrails\/_proposed\/never-retry-a-charge-without-an\.md$/);
      const p = (await admin.sync()).data.items.find((i) => i.id === out.proposed);
      assert.ok(p && !p.pinned && p.status === 'draft');
      const pr = parseRuleFile(p.body);
      assert.deepEqual([pr.id, pr.kind, pr.from], [null, 'never', 'SPEC-014']);
      assert.match(pr.proposedBy, /editor/i);
      const again = JSON.parse(
        (await call(agent2, 'propose_guardrail', { rule: 'Never  retry a charge without an idempotency key.', kind: 'never' })).text,
      );
      assert.equal(again.updated, true);
      const known = JSON.parse((await call(agent2, 'propose_guardrail', { rule: 'store times in utc.', kind: 'always' })).text);
      assert.equal(known.refused, undefined); // G3 was deleted: not a guardrail any more
      const dup = JSON.parse(
        (await call(agent2, 'propose_guardrail', { rule: 'Never write card numbers, tokens or secrets to logs.', kind: 'never' })).text,
      );
      assert.equal(dup.refused, 'already a guardrail');
      assert.equal(dup.id, 'G2');
    });
  });

  // the CI loop: a pipeline lists the checks to run, reports per tested version, and can be the only proof
  describe('the CI loop', () => {
    const step = chain();
    const sid = 'SPEC-895';
    const rel = async (body) => {
      const cur = (await admin.sync()).data.items.find((i) => i.id === sid);
      const r = await admin.push([{ id: sid, kind: 'spec', baseRev: cur?.rev ?? 0, approve: true, fields: { title: 'CI spec', body } }]);
      assert.equal(r[0].status, 'applied');
    };
    const list = async (tok, q = '') => fetch(`${BASE}/api/ci/checks${q}`, { headers: tok ? { authorization: `Bearer ${tok}` } : {} });
    const post = (body) =>
      fetch(`${BASE}/api/ci/checks/results`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${wTok}` },
        body: JSON.stringify(body),
      }).then((r) => r.json());
    let cEd, wTok, rTok, ag, lj, out;
    before(async () => {
      cEd = await mk('editor', 'ci');
      wTok = (await cEd.c.post('/api/me/tokens', { name: 'CI', scopes: ['mcp:read', 'mcp:drafts', 'mcp:write'], teamId: T1 })).data.token;
      rTok = (await cEd.c.post('/api/me/tokens', { name: 'CI read', scopes: ['mcp:read'], teamId: T1 })).data.token;
      ag = await mcp(wTok);
      await rel('## ACCEPTANCE CRITERIA\n- [ ] Fast\n');
      await call(ag, 'register_check', { spec_id: sid, name: 'perf: p95', kind: 'metric', how: 'k6 run perf.js', expect: 'p95 < 200 ms' });
    });
    after(async () => {
      await ag?.close();
    });
    step('CI: a pipeline lists the checks to run with any team token, filtered by state or spec', async () => {
      assert.equal((await list(null)).status, 401);
      lj = await (await list(rTok, `?spec=${sid}`)).json();
      assert.deepEqual(
        lj.checks.map((c) => [c.spec_id, c.spec_version, c.name, c.how, c.state]),
        [[sid, 1, 'perf: p95', 'k6 run perf.js', 'unverified']],
      );
      assert.match(lj.report_to, /\/api\/ci\/checks\/results$/);
      assert.equal((await (await list(rTok, `?spec=${sid}&state=failing`)).json()).checks.length, 0);
    });
    step('CI: a result counts for the spec version the tested code implements', async () => {
      await rel('## ACCEPTANCE CRITERIA\n- [ ] Fast\n- [ ] Cheap\n');
      out = await post({ spec_id: sid, name: 'perf: p95', status: 'pass', spec_version: 1, commit: 'old' });
      assert.equal(out.results[0].state, 'stale');
      assert.match((await post({ spec_id: sid, name: 'perf: p95', status: 'pass', spec_version: 9 })).results[0].error, /spec_version/);
      out = await post({ spec_id: sid, name: 'perf: p95', status: 'pass', commit: 'new' });
      assert.equal(out.results[0].state, 'passing');
    });
    step('CI: where a team requires it, only results from CI prove a check; only admins switch it', async () => {
      assert.equal((await cEd.c.req('PATCH', `/api/teams/${T1}`, { ciRequired: true })).status, 403);
      assert.equal((await admin.req('PATCH', `/api/teams/${T1}`, { ciRequired: true })).data.team.ciRequired, true);
      assert.equal((await admin.get('/api/me')).data.me.teams.find((t) => t.id === T1).ciRequired, true);
      const mine = JSON.parse(
        (await call(ag, 'report_check_result', { spec_id: sid, name: 'perf: p95', status: 'pass', value: '150 ms' })).text,
      );
      assert.equal(mine.state, 'unverified');
      assert.equal(mine.needs_ci, true);
      assert.match(mine.note, /only results reported by CI/);
      lj = await (await list(rTok, `?spec=${sid}`)).json();
      assert.equal(lj.ci_required, true);
      assert.equal(lj.checks[0].needs_ci, true);
      assert.equal((await post({ spec_id: sid, name: 'perf: p95', status: 'pass' })).results[0].state, 'passing');
      await admin.req('PATCH', `/api/teams/${T1}`, { ciRequired: false });
    });
  });

  // guardrails that change after a spec was built put it back on the work list
  describe('guardrail drift', () => {
    const step = chain();
    const sid = 'SPEC-891';
    const ids = {}; // test key -> id the server gave
    /** Makes the released rule files exactly `want` ({ key: [kind, text] }): rewords the ones with a known key, deletes the rest. */
    const setRules = async (want) => {
      const files = (await admin.sync()).data.items.filter((i) => i.kind === 'doc' && /^guardrails\/(?!_proposed\/).*\.md$/.test(i.id));
      const byId = new Map(files.map((f) => [parseRuleFile(f.body)?.id, f]));
      const changes = [];
      for (const [k, [kind, rule]] of Object.entries(want)) {
        const f = ids[k] && byId.get(ids[k]);
        const body = formatRuleFile({ id: ids[k], rule, kind });
        changes.push(
          f
            ? { id: f.id, kind: 'doc', baseRev: f.rev, approve: true, fields: { body } }
            : { id: `guardrails/drift-${k}.md`, kind: 'doc', baseRev: 0, approve: true, fields: { title: k, body } },
        );
      }
      const keep = new Set(Object.keys(want).map((k) => ids[k]));
      for (const f of files)
        if (!keep.has(parseRuleFile(f.body)?.id)) changes.push({ id: f.id, kind: 'doc', baseRev: f.rev, delete: true });
      const r = await admin.push(changes);
      assert.ok(
        r.every((x) => x.status === 'applied'),
        JSON.stringify(r),
      );
      for (const [k] of Object.entries(want)) {
        const x =
          r.find((y) => y.id === (changes.find((c) => c.fields?.title === k)?.id ?? '')) ??
          r.find((y) => parseRuleFile(y.item?.body ?? '')?.id === ids[k]);
        ids[k] = parseRuleFile(x.item.body).id;
      }
    };
    const report = () =>
      call(ag, 'report_implementation', {
        spec_id: sid,
        status: 'implemented',
        summary: 'Built',
        criteria: [{ id: 'AC1', status: 'met' }],
      });
    const entry = async () => JSON.parse((await call(ag, 'get_work_list')).text).work.find((x) => x.spec_id === sid);
    let ag;
    before(async () => {
      const gEd2 = await mk('editor', 'gd');
      ag = await mcp(
        (await gEd2.c.post('/api/me/tokens', { name: 'Rule agent', scopes: ['mcp:read', 'mcp:drafts', 'mcp:write'], teamId: T1 })).data
          .token,
      );
      const r0 = await admin.push([
        { id: sid, kind: 'spec', baseRev: 0, fields: { title: 'Rule-bound spec', body: '## ACCEPTANCE CRITERIA\n- [ ] Done\n' } },
      ]);
      await admin.push([{ id: sid, kind: 'spec', baseRev: r0[0].item.rev, approve: true, fields: {} }]);
    });
    after(async () => {
      await ag?.close();
    });
    step('guardrails: a report records the rules it was built against', async () => {
      await setRules({ a: ['always', 'Verify webhook signatures.'], b: ['never', 'Log secrets.'] });
      await report();
      assert.equal(await entry(), undefined);
      const rep = (await admin.get(`/api/teams/${T1}/reports?spec=${sid}`)).data.reports[0];
      assert.deepEqual(rep.guardrails, { [ids.a]: 'Verify webhook signatures.', [ids.b]: 'Log secrets.' });
    });
    step(
      'guardrails: new or reworded rules put an implemented spec back on the work list, with the rules to check; the garden knows',
      async () => {
        await setRules({
          a: ['always', 'Verify webhook signatures in constant time.'],
          b: ['never', 'Log secrets.'],
          c: ['never', 'Store card numbers.'],
        });
        const e = await entry();
        assert.equal(e.state, 'guardrails_changed');
        assert.deepEqual(
          e.rules_changed.map((r) => [r.id, r.kind, r.change]),
          [
            [ids.a, 'always', 'changed'],
            [ids.c, 'never', 'added'],
          ],
        );
        assert.match(e.hint, /report again/);
        const g = (await admin.post(`/api/teams/${T1}/sync`, { since: 1e9, changes: [] })).data.garden;
        assert.deepEqual(g.guardrailDrift[sid], [ids.a, ids.c]);
      },
    );
    step('guardrails: reporting again clears it; removing a rule asks nothing', async () => {
      await report();
      assert.equal(await entry(), undefined);
      await setRules({ a: ['always', 'Verify webhook signatures in constant time.'], c: ['never', 'Store card numbers.'] });
      assert.equal(await entry(), undefined);
    });
  });
});
