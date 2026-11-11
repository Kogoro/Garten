// Browser test: login, offline-first block editor with diagrams, conflicts, desktop layout, roles.
//   node tests/ui.test.mjs              (starts its own server)      SHOTS=./shots to keep screenshots
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { startServer, Client, startSmtpSink } from '../../tests/helpers.mjs';

const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });

const tmp = mkdtempSync(path.join(process.env.TEST_TMP || tmpdir(), 'specs-ui-'));
const remote = path.join(tmp, 'remote.git');
execFileSync('git', ['init', '--bare', '-b', 'main', remote]);
const smtp = await startSmtpSink();
// stands in for the Claude Code routine API: records what the agent trigger sends
const hits = [];
const sink = createServer((q, r) => { let b = ''; q.on('data', (c) => (b += c)); q.on('end', () => { hits.push({ headers: q.headers, body: JSON.parse(b) }); r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ type: 'routine_fire', claude_code_session_id: 'session_test', claude_code_session_url: 'https://claude.ai/code/session_test' })); }); });
await new Promise((res) => sink.listen(0, '127.0.0.1', res));
const srv = await startServer({ HOOK_ALLOW_LOCAL: '1', HOOK_DEBOUNCE_MS: '200', WEB_DIR: new URL('../dist', import.meta.url).pathname, GIT_ALLOW_LOCAL: '1', FOUNDATION_DEBOUNCE_MS: '150', SMTP_URL: `smtp://127.0.0.1:${smtp.port}`, SMTP_FROM: 'Specs <specs@example.test>' });
const BASE = srv.base;
const admin = new Client(BASE);
await admin.login('admin@localhost', 'adminpass1');
await admin.post('/api/users', { email: 'viewer@example.com', name: 'Vera Viewer', teamId: admin.tid, role: 'viewer', password: 'viewerpass1' });

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];
const watch = (page) => {
  page.setDefaultTimeout(8000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text()) && errors.push(m.text()));
};
let n = 0;
const ok = (m) => console.log(`ok ${++n} - ${m}`);
const serverItem = async (id) => (await admin.sync()).data.items.find((i) => i.id === id);
const signIn = async (page, email, pw) => { await page.fill('#email', email); await page.fill('#password', pw); await page.click('#loginForm button[type=submit]'); };

try {
  // =============================================================== MOBILE
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  watch(page);
  const setMode = async (pg, mode) => { await pg.click('[data-act=item-menu]'); await pg.getByRole('button', { name: `Editor: ${{ markdown: 'Markdown', blocks: 'Blocks', form: 'Form' }[mode]}` }).click(); };
  const pill = () => page.locator('.bar [data-pill]').first().innerText();

  await page.goto(BASE);
  await page.locator('#loginForm').waitFor();
  await shot(page, '01-login');
  await signIn(page, 'admin@localhost', 'wrong-password');
  await page.getByText('Wrong e-mail or password').waitFor(); ok('wrong password shows an error');
  await signIn(page, 'admin@localhost', 'adminpass1');
  await page.locator('.row', { hasText: 'SPEC-012' }).waitFor();
  await page.locator('.bar [data-pill].sync-ok').first().waitFor(); ok('sign in + initial sync');
  await shot(page, '02-list');

  // offline reload must not ask for a login again
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  await page.waitForTimeout(800); // let the service worker finish caching mermaid
  await ctx.setOffline(true);
  await page.reload();
  await page.locator('.row', { hasText: 'SPEC-012' }).waitFor(); ok('offline reload opens the app without a new login');

  // --- block editor, offline
  await page.click('.fab[data-act=new-spec]'); await page.getByRole('button', { name: /Feature spec/ }).click();
  const title = `Offline spec ${Date.now() % 100000}`;
  await page.fill('#title', title);
  await page.locator('.bn-editor .bn-block').first().waitFor();
  assert.ok(await page.locator('.bn-editor .bn-block').count() >= 3); ok('new spec starts from a block template');
  // type into first empty paragraph-like block via toolbar-added blocks
  await page.click('[data-act=t-add]');
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.keyboard.type('Plain paragraph typed offline.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  await page.getByText('Requirement (R1, R2 …)').click();
  await page.keyboard.type('Works on the train');
  await page.keyboard.press('Enter'); // next requirement
  await page.keyboard.type('Never double-bills');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter'); // empty item leaves the list
  await page.keyboard.type('/');
  await page.getByText('Diagram (Mermaid)').click();
  await page.locator('.mm svg').first().waitFor({ timeout: 15000 }); ok('slash menu inserts a Mermaid diagram that renders offline');
  await shot(page, '03-editor-blocks');
  const src = page.locator('[data-content-type=diagram] textarea');
  await src.fill('flowchart LR\n  Phone --> Server\n  Server --> Git');
  await page.waitForFunction(() => /Phone/.test(document.querySelector('[data-content-type=diagram] .mm')?.textContent ?? ''), null, { timeout: 10000 }); ok('diagram preview follows the source');
  await src.fill('flowchart LR\n  A -->');
  await page.locator('.mm.err').waitFor(); ok('invalid diagram shows an error instead of breaking');
  await src.fill('flowchart LR\n  Phone --> Server\n  Server --> Git');
  await page.locator('.mm:not(.err) svg').waitFor();

  // diagram: toggle between rendered view and code
  const dg = page.locator('[data-content-type=diagram]').first();
  await dg.getByRole('button', { name: 'Code', exact: true }).click();
  assert.equal(await dg.locator('.mm').isVisible(), false); assert.equal(await dg.locator('textarea').isVisible(), true);
  await dg.getByRole('button', { name: 'Diagram', exact: true }).click();
  assert.equal(await dg.locator('.mm').isVisible(), true); assert.equal(await dg.locator('textarea').isVisible(), false);
  await dg.getByRole('button', { name: 'Split', exact: true }).click();
  assert.equal(await dg.locator('.mm').isVisible() && await dg.locator('textarea').isVisible(), true); ok('diagram block: toggle between Diagram, Code and Split');
  // endpoint blocks: repeatable, each with description
  for (const [method, path, text] of [['POST', '/orders', 'Creates an order. Idempotent via Idempotency-Key.'], ['GET', '/orders/{id}', 'Returns one order.']]) {
    await page.click('[data-act=t-add]'); await page.getByRole('button', { name: 'API endpoint', exact: true }).click();
    const ep = page.locator('[data-content-type=endpoint]').last();
    await ep.locator('.ep-method').selectOption(method); await ep.locator('.ep-path').fill(path); await ep.getByRole('tab', { name: 'Description' }).click(); await ep.locator('textarea').fill(text);
  }
  assert.equal(await page.locator('[data-content-type=endpoint]').count() >= 2, true);
  const lastEp = page.locator('[data-content-type=endpoint]').last(); await lastEp.getByRole('tab', { name: 'Responses' }).click(); await lastEp.locator('textarea').fill('200 OK – the order\n404 – unknown id');
  await setMode(page, 'markdown');
  const epMd = await page.inputValue('#body');
  assert.match(epMd, /```endpoint POST \/orders\nCreates an order\. Idempotent via Idempotency-Key\.\n```/);
  assert.match(epMd, /```endpoint GET \/orders\/\{id\}\nReturns one order\.\n\nResponses:\n200 OK – the order\n404 – unknown id\n```/); ok('endpoint blocks are repeatable, carry a description and serialise to endpoint fences');
  await setMode(page, 'blocks');
  assert.equal(await page.locator('[data-content-type=endpoint] .ep-path').last().inputValue(), '/orders/{id}'); ok('endpoint fences parse back into endpoint blocks');

  // markdown view round trip
  await setMode(page, 'markdown');
  const md = await page.inputValue('#body');
  assert.match(md, /Plain paragraph typed offline\./);
  assert.match(md, /R1 Works on the train\nR2 Never double-bills/);
  assert.match(md, /```mermaid\nflowchart LR\n  Phone --> Server/); ok('blocks serialise to clean Markdown (requirements, mermaid fence)');
  await page.locator('#body').press('Control+End');
  await page.keyboard.type('\n\n## EXTRA\nAdded as Markdown');
  await setMode(page, 'blocks');
  await page.locator('.bn-inline-content', { hasText: 'Added as Markdown' }).waitFor(); ok('Markdown edits come back as blocks');

  // @ reference + approve
  await page.click('[data-act=t-ref]');
  await page.locator('.pick', { hasText: 'ADR-007.md' }).click();
  await page.click('[data-act=edit-done]');                      // phone: back to the read view with the overview list
  await page.locator('[data-act=link-docs]', { hasText: '1 linked' }).waitFor(); ok('@ reference links the document (shown in the overview)');
  await page.locator('#edMeta', { hasText: 'not synced' }).waitFor();
  await page.click('[data-act=approve]');
  await page.getByRole('button', { name: /Approval queued/ }).waitFor(); ok('approve offline is queued');
  const specId = await page.evaluate(() => decodeURIComponent(location.hash.split('/').pop()));
  await page.click('a[aria-label=Back]');
  assert.match(await pill(), /Offline · 1/); ok('pill shows Offline · 1');
  assert.equal(await serverItem(specId), undefined);

  // conflict: edit SPEC-014 offline while the server changes it
  await page.locator('.row', { hasText: 'SPEC-014' }).click();
  await page.click('[data-act=edit]');                           // phone: items open to read first
  const stamp = Date.now();
  await page.locator('.bn-inline-content').last().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(` LOCAL${stamp}`);
  const s14 = await serverItem('SPEC-014');
  await admin.push([{ id: 'SPEC-014', kind: 'spec', baseRev: s14.rev, fields: { body: s14.body + `\nSERVER${stamp}` } }]);

  await ctx.setOffline(false);
  await page.evaluate(() => dispatchEvent(new Event('online')));
  await page.locator('#edMeta', { hasText: 'Conflict' }).waitFor({ timeout: 10000 }); ok('conflicting edit is detected, not overwritten');
  const released = await serverItem(specId);
  assert.equal(released.status, 'approved'); assert.equal(released.updatedBy, 'Admin');
  assert.match(released.body, /```mermaid\nflowchart LR/); ok('queued approval released on reconnect (with the diagram)');
  assert.doesNotMatch((await serverItem('SPEC-014')).body, new RegExp(`LOCAL${stamp}`));
  await page.click('[data-act=conflict]');
  await page.getByText('Choose which version to keep').waitFor();
  await shot(page, '04-conflict-sheet');
  await page.click('[data-act=keep-mine]');
  await page.waitForFunction(() => !/Saved on device|Conflict|Sync problem/.test(document.getElementById('edMeta')?.textContent ?? ''), null, { timeout: 10000 });
  assert.match((await serverItem('SPEC-014')).body, new RegExp(`LOCAL${stamp}`)); ok('"Keep mine" resolves the conflict');

  // agent sees the diagram
  const pat = (await admin.post('/api/me/tokens', { name: 'ui-test', scopes: ['mcp:read'], teamId: admin.tid })).data.token;
  const rpc = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${pat}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_spec', arguments: { id: specId } } }) });
  assert.match(await rpc.text(), /mermaid\\nflowchart LR/); ok('agent receives the diagram as a mermaid block');

  // --- garden: the agent asks and reports, a person answers on the phone – also without a connection
  const agentTok = (await admin.post('/api/me/tokens', { name: 'Claude Code', scopes: ['mcp:read', 'mcp:drafts', 'mcp:write'], teamId: admin.tid })).data.token;
  const tool = async (name, args = {}) => {
    const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${agentTok}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    assert.match(r.headers.get('content-type'), /application\/json/);
    const res = (await r.json()).result;
    assert.ok(!res.isError, `${name}: ${res.content[0].text}`);
    return JSON.parse(res.content[0].text);
  };
  const dec = await tool('request_decision', { spec_id: 'SPEC-012', question: 'How long do old signing keys stay valid after a rotation?', options: [{ label: '24 hours', detail: 'Matches the retry window of the queue' }, { label: '7 days', detail: 'Safer for slow consumers' }], recommended: 0, blocking: true, context: 'src/webhooks/keys.ts has no overlap at all' });
  await tool('report_implementation', { spec_id: 'SPEC-012', status: 'partial', summary: 'Rotation endpoint is built. The overlap of old and new keys waits for a decision.', criteria: [{ text: 'A new key can be issued', status: 'met' }, { text: 'Old keys keep working during the overlap', status: 'open', note: 'waits for the decision' }], evidence: [{ kind: 'pr', ref: 'https://git.example.test/acme/api/pull/7', note: 'draft' }, { kind: 'test', ref: 'keys.rotate.test.ts' }], deviations: 'The audit log entry is written asynchronously.' });
  await page.click('a[aria-label=Back]').catch(() => {});
  await page.evaluate(() => dispatchEvent(new Event('online')));
  await page.locator('.tabbar a[href="#/garden"] .badge', { hasText: '1' }).waitFor({ timeout: 10000 }); ok('garden: a question from an agent shows up as a badge in the tab bar');
  await page.click('.tabbar a[href="#/garden"]');
  const card = page.locator(`[data-decision="${dec.id}"]`);
  await card.getByText('How long do old signing keys stay valid').waitFor();
  assert.equal(await page.locator('#gd-needs').innerText(), '1');
  assert.ok(await card.getByText('Blocks the agent').isVisible());
  assert.ok(await card.locator('.dc-opt', { hasText: '24 hours' }).locator('.dc-rec').isVisible()); ok('garden: the decision shows the spec, the options and the recommendation of the agent');
  await page.locator('#gd-impl .gd-row[data-spec="SPEC-012"] [data-impl=partial]', { hasText: '1/2 criteria' }).waitFor(); ok('garden: every released spec shows how far the agent is');
  await shot(page, '05a-garden');
  await ctx.setOffline(true);
  await page.evaluate(() => dispatchEvent(new Event('offline')));
  assert.equal(await card.locator('[data-act=dc-send]').isDisabled(), true);
  await card.locator('.dc-opt', { hasText: '7 days' }).click();
  await card.locator('textarea').fill('Consumers in the field sync weekly.');
  await card.locator('[data-act=dc-send]').click();
  await page.locator('#gd-waiting').getByText('1 answer waiting to sync').waitFor();
  assert.equal(await page.locator('#gd-needs').innerText(), '0');
  await page.locator(`#gd-answered [data-decision="${dec.id}"] .dc-answer`, { hasText: '7 days' }).waitFor();
  assert.equal((await admin.get(`/api/teams/${admin.tid}/feedback?spec=SPEC-012&kind=decision`)).data.feedback[0].status, 'open'); ok('garden: a decision is answered offline and waits on the device');
  await page.waitForTimeout(500); // let IndexedDB finish writing the queued answer
  await page.reload();
  await page.locator('#gd-waiting').waitFor();
  await page.locator(`#gd-answered [data-decision="${dec.id}"] .dc-answer`, { hasText: '7 days' }).waitFor(); ok('garden: the offline answer survives a reload');
  await shot(page, '05b-garden-offline');
  await ctx.setOffline(false);
  await page.evaluate(() => dispatchEvent(new Event('online')));
  await page.locator('#gd-waiting').waitFor({ state: 'detached', timeout: 10000 });
  const answeredDec = (await tool('list_decisions', { spec_id: 'SPEC-012' }));
  assert.match(JSON.stringify(answeredDec), /7 days/); assert.match(JSON.stringify(answeredDec), /Consumers in the field sync weekly/);
  assert.match(JSON.stringify(await tool('get_work_list')), /decisions_answered/); ok('garden: the answer reaches the server on reconnect and the agent finds it in its work list');
  await page.click('#gd-impl .gd-row[data-spec="SPEC-012"]');
  await page.locator('.sheet .rp-sum', { hasText: 'Rotation endpoint is built' }).waitFor();
  assert.equal(await page.locator('.sheet .rp-crit li').count(), 2);
  assert.equal(await page.locator('.sheet .rp-crit li[data-status=open]').count(), 1);
  assert.equal(await page.locator('.sheet .rp-ev a').getAttribute('href'), 'https://git.example.test/acme/api/pull/7');
  assert.ok(await page.locator('.sheet .rp-dev', { hasText: 'audit log' }).isVisible()); ok('garden: the report of the agent lists criteria, evidence and deviations');
  await shot(page, '05c-report');
  await page.keyboard.press('Escape');
  // checks: re-runnable evidence next to the report, and "make it a rule" for a deviation
  await tool('register_check', { spec_id: 'SPEC-012', name: 'unit: key rotation', kind: 'test', how: 'npm test -- rotation', expect: 'exit 0', criterion: 'A new key can be issued' });
  await tool('report_check_result', { spec_id: 'SPEC-012', name: 'unit: key rotation', status: 'pass', value: '12 passed', ref: 'https://ci.example.test/run/9' });
  await tool('report_implementation', { spec_id: 'SPEC-012', status: 'partial', summary: 'Rotation endpoint is built. The overlap of old and new keys waits for a decision.', criteria: [{ text: 'A new key can be issued', status: 'met', checks: ['unit: key rotation'] }, { text: 'Old keys keep working during the overlap', status: 'open' }], deviations: 'Key changes are written to the audit log, which the spec does not mention.' });
  await page.evaluate(() => dispatchEvent(new Event('online')));
  await page.locator('#gd-impl .gd-row[data-spec="SPEC-012"] [data-impl=partial]', { hasText: '1 verified' }).waitFor({ timeout: 10000 });
  await page.click('#gd-impl .gd-row[data-spec="SPEC-012"]');
  await page.locator('.sheet .rp-chk li[data-check="unit: key rotation"][data-state=passing]').waitFor();
  await page.locator('.sheet .rp-crit li[data-status=met] .chip', { hasText: 'Verified' }).waitFor(); ok('garden: the report shows its checks and which criteria are verified by a passing check');
  await shot(page, '05d-report-checks');
  await page.click('.sheet [data-act=dev-rule]');
  await page.fill('#rule-text', 'Every change of a signing key is written to the audit log.');
  await page.getByRole('button', { name: 'Never' }).click(); await page.getByRole('button', { name: 'Always' }).click();
  await page.click('[data-act=rule-add]');
  await page.evaluate(() => dispatchEvent(new Event('online')));
  for (let i = 0; i < 40; i++) { const g = (await admin.sync()).data.items.find((x) => x.id === 'guardrails.md'); if (/G1: Every change of a signing key/.test(g?.body ?? '')) break; await page.waitForTimeout(250); }
  assert.match((await admin.sync()).data.items.find((x) => x.id === 'guardrails.md').body, /## Always\n- G1: Every change of a signing key is written to the audit log\./); ok('guardrails: a deviation becomes a rule in the guardrails document');
  await page.keyboard.press('Escape').catch(() => {});
  await page.click('[data-act=more-menu]'); await page.getByRole('button', { name: /^Sync/ }).click();
  await page.waitForFunction(() => location.hash === '#/sync'); ok('the sync page moved into the More menu');

  // keyboard: command palette, shortcuts, skip link, one title per page
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('Control+k');
  const pal = page.locator('[data-palette]'); await pal.waitFor();
  await pal.locator('input').fill('webhook sig'); await pal.locator('[role=option]', { hasText: 'Webhook signature rotation' }).waitFor();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => location.hash === '#/spec/SPEC-012');
  await page.waitForFunction(() => /^Webhook signature rotation · Specs · /.test(document.title)); ok('keyboard: Ctrl+K finds a spec by title and opens it; the window title names page and team');
  await page.keyboard.press('Escape').catch(() => {});
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('g'); await page.keyboard.press('y');
  await page.waitForFunction(() => location.hash === '#/sync'); await page.waitForFunction(() => /^Sync · /.test(document.title)); ok('keyboard: "g" then "y" goes to Sync');
  await page.keyboard.press('?'); await page.getByRole('dialog', { name: /Keyboard shortcuts/ }).waitFor(); await page.keyboard.press('Escape'); ok('keyboard: "?" lists the shortcuts');
  await page.evaluate(() => document.body.focus()); await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Skip to content'); ok('the first Tab stop is a skip link');
  // phone toolbar: one row, sort and type live in a sheet
  await page.evaluate(() => { location.hash = '#/'; });
  await page.click('[data-act=filters]'); await page.getByRole('dialog', { name: 'Sort and filter' }).waitFor();
  await page.getByRole('button', { name: /^Show \d+/ }).click(); ok('specs on a phone: sorting and type filter open from one button');
  // phone: an existing spec opens to read; editing is a deliberate switch
  await page.evaluate(() => { location.hash = '#/spec/SPEC-012'; });
  await page.locator('.sumstrip').waitFor();
  assert.equal(await page.locator('.toolbar').count(), 0); assert.equal(await page.locator('[data-act=edit-done]').count(), 0);
  assert.match(await page.locator('#edMeta').innerText(), /Approved v\d/);
  assert.ok(await page.locator('.sumcell', { hasText: 'Feedback' }).isVisible() && await page.locator('.sumcell', { hasText: 'Documents' }).isVisible()); ok('phone: a spec opens read-only with status, feedback and documents at a glance');
  await page.click('[data-act=edit]'); await page.locator('[data-act=edit-done]').waitFor(); assert.equal(await page.locator('.sumstrip').count(), 0); await page.click('[data-act=edit-done]'); await page.locator('.sumstrip').waitFor(); ok('phone: Edit switches to editing, Done returns to reading');
  // an address that leads nowhere offers the way back
  await page.evaluate(() => { location.hash = '#/spec/NOPE-999'; });
  await page.getByText('does not exist (anymore)').waitFor(); await page.getByRole('link', { name: /Back to Specs/ }).first().click();
  await page.waitForFunction(() => location.hash === '#/'); ok('a missing spec shows a message with a way back, not a blank page');
  // pause and resume the agents
  await page.evaluate(() => { location.hash = '#/garden'; });
  page.once('dialog', (dlg) => dlg.accept());
  await page.click('[data-act=agent-pause]'); await page.locator('#gd-paused').waitFor();
  await page.click('[data-act=agent-resume]'); await page.locator('#gd-paused').waitFor({ state: 'detached' }); ok('garden: agents can be paused and resumed');

  // account on mobile
  await page.click('[data-act=more-menu]'); await page.getByRole('button', { name: 'Account & agent access' }).click();
  await page.getByText('Agent access (MCP)').waitFor();
  await shot(page, '05-account-mobile');
  await ctx.close();

  // =============================================================== DESKTOP
  const dctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const d = await dctx.newPage();
  watch(d);
  await d.goto(BASE);
  await signIn(d, 'admin@localhost', 'adminpass1');
  await d.locator('.row', { hasText: 'SPEC-014' }).waitFor();
  assert.ok(await d.locator('.sidebar').isVisible() && (await d.locator('.sidebar').boundingBox()).width > 200); ok('desktop: sidebar navigation');
  assert.ok(await d.locator('.detail .placeholder').isVisible()); ok('desktop: empty detail pane until a spec is selected');
  await d.locator('.row', { hasText: 'SPEC-014' }).click();
  await d.locator('.bn-inline-content').first().waitFor();
  assert.ok(await d.locator('#list').isVisible() && await d.locator('.editor').isVisible()); ok('desktop: list and editor side by side');
  await d.locator('.bn-inline-content', { hasText: 'idempotency key' }).first().waitFor();

  // --- editor bar: title, status, linked documents, save state, approve and overflow menu in ONE row
  const bar = await d.locator('.ed-bar').boundingBox();
  assert.ok(bar.height < 70, `bar height ${bar.height}`);
  for (const sel of ['.ed-title', '#chips', '#docsDd', '#saveInd', '#approveSlot [data-act=approve]', '[data-act=item-menu]']) {
    const b = await d.locator(`.ed-bar ${sel}`).boundingBox();
    assert.ok(b && b.y >= bar.y - 1 && b.y + b.height <= bar.y + bar.height + 1, `${sel} sits in the bar`);
  }
  assert.equal(await d.locator('.ed-bar [data-act=mode]').count(), 0); assert.equal(await d.locator('.editor .ed-meta, .editor .links').count(), 0);
  ok('editor: title, status, documents, save state and Approve share one compact bar; no extra meta/link rows');
  await d.click('#docsDd [data-act=dd-toggle]');
  await d.locator('#docsDd .dd-menu').waitFor();
  const labelBefore = await d.locator('#docsDd .docsbtn').innerText();
  await d.locator('#docsDd [data-act=dd-link][aria-checked=false]').first().click();
  await d.locator('#docsDd .dd-menu').waitFor(); // stays open while toggling
  await d.waitForFunction((l) => document.querySelector('#docsDd .docsbtn')?.innerText !== l, labelBefore);
  await d.locator('#docsDd [data-act=dd-link][aria-checked=true]').first().click();
  await d.keyboard.press('Escape'); assert.equal(await d.locator('#docsDd .dd-menu').isVisible(), false);
  ok('linked documents dropdown: toggle links (stays open), Escape closes');
  await d.click('[data-act=item-menu]');
  await d.getByRole('button', { name: 'Editor: Blocks' }).waitFor(); await d.getByRole('button', { name: 'Editor: Markdown' }).waitFor(); await d.keyboard.press('Escape');
  ok('Blocks/Markdown switch lives in the overflow menu');

  // --- feedback on a spec: left by an agent / colleague, triaged in the editor
  const fbRes = await admin.post(`/api/teams/${admin.tid}/feedback`, { specId: 'SPEC-014', kind: 'concern', section: '## REQUIREMENTS', text: 'R3 (keys expire) conflicts with the retry window in ADR-007.', evidence: 'docs/adr/ADR-007.md' });
  assert.equal(fbRes.status, 200);
  await d.evaluate(() => dispatchEvent(new Event('online')));
  await d.locator('.fbbtn.has .cnt', { hasText: '1' }).waitFor({ timeout: 10000 });
  await d.locator('#list .row', { hasText: 'SPEC-014' }).locator('.chip', { hasText: '1 feedback' }).waitFor(); ok('open feedback shows up as a badge in the editor bar and in the spec list');
  await d.click('[data-act=feedback]');
  await d.locator('.fb-item', { hasText: 'conflicts with the retry window' }).waitFor();
  assert.ok(await d.locator('.fb-item .fb-evidence', { hasText: 'ADR-007.md' }).isVisible()); ok('the feedback sheet shows kind, section, text and evidence');
  await d.fill('.fb-item input', 'Good catch – extending the window in ADR-007.'); await d.click('[data-act=fb-accept]');
  await d.getByText('No open feedback.').waitFor();
  await d.locator('.sheet').getByRole('button', { name: /^All/ }).click(); await d.locator('.fb-item .fb-reply', { hasText: 'Good catch' }).waitFor(); ok('a person accepts feedback with a reply; it leaves the open list');
  await d.keyboard.press('Escape');
  await d.waitForFunction(() => !document.querySelector('.fbbtn.has'), null, { timeout: 10000 }); ok('the badge disappears once nothing is open');
  // accept a finding and take it into the spec as a review note (checklist item)
  const fb2 = await admin.post(`/api/teams/${admin.tid}/feedback`, { specId: 'SPEC-014', kind: 'question', section: '## ACCEPTANCE CRITERIA', text: 'What happens when the key store is unavailable?' });
  assert.equal(fb2.status, 200);
  await d.evaluate(() => dispatchEvent(new Event('online')));
  await d.locator('.fbbtn.has').waitFor({ timeout: 10000 });
  await d.click('[data-act=feedback]'); await d.locator('.fb-item', { hasText: 'key store is unavailable' }).waitFor();
  await d.click('[data-act=fb-accept-note]'); await d.getByText('No open feedback.').waitFor(); await d.keyboard.press('Escape');
  await setMode(d, 'markdown');
  assert.match(await d.inputValue('#body'), /## REVIEW NOTES\n\n- \[ \] question \(ACCEPTANCE CRITERIA\): What happens when the key store is unavailable\?/); ok('"Accept & add to spec" turns a finding into a checklist item under REVIEW NOTES (an unreleased edit)');
  await setMode(d, 'blocks');

  // --- insert at cursor: splits the block at the caret
  const req2 = d.locator('[data-content-type=requirement] .bn-inline-content').nth(1);
  const before = await req2.innerText();
  await req2.click(); await d.keyboard.press('Home'); for (let k = 0; k < 11; k++) await d.keyboard.press('ArrowRight');
  await d.click('[data-act=t-def]');
  await d.locator('[data-content-type=definition] .def-term').waitFor();
  await d.locator('.def-term').fill('Ledger entry');
  await d.locator('[data-content-type=definition] textarea').fill('One immutable row per charge.');
  await setMode(d, 'markdown');
  const md1 = await d.inputValue('#body');
  const [head, tail] = [before.slice(0, 11).trimEnd(), before.slice(11).trimStart()];
  assert.ok(md1.includes(`R2 ${head}\n\nLedger entry\n: One immutable row per charge.\n\n${tail}`), md1); ok('toolbar inserts a block at the cursor and splits the text there');
  assert.match(md1, /Ledger entry\n: One immutable row per charge\./); ok('definition block serialises as a Markdown definition list');
  await setMode(d, 'blocks');
  await d.locator('[data-content-type=definition] .def-term').waitFor(); assert.equal(await d.locator('.def-term').inputValue(), 'Ledger entry'); ok('definition list parses back into a definition block');

  // --- drag & drop with the block handle: drag the first block below the fourth one
  const bodyOf = async () => (await (async () => { await setMode(d, 'markdown'); const v = await d.inputValue('#body'); await setMode(d, 'blocks'); return v; })());
  const mdBefore = await bodyOf();
  const firstBlock = d.locator('.bn-block-outer').nth(0);
  await firstBlock.hover();
  const handle = d.locator('.bn-side-menu [draggable=true]').first();
  await handle.waitFor();
  const hb = await handle.boundingBox(); const tb = await d.locator('.bn-block-outer').nth(3).boundingBox();
  await d.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2); await d.mouse.down();
  await d.mouse.move(hb.x + 20, hb.y + 30, { steps: 5 }); await d.mouse.move(tb.x + 80, tb.y + tb.height - 3, { steps: 12 }); await d.mouse.up();
  await d.waitForTimeout(300);
  const mdAfter = await bodyOf();
  assert.notEqual(mdAfter, mdBefore); ok('drag & drop with the block handle moves a block');
  const firstLine = mdBefore.split('\n')[0];
  assert.ok(mdAfter.indexOf(firstLine) > 0, 'the first block moved down'); ok('the new order is persisted in the Markdown');
  await shot(d, '06-desktop-editor');
  await d.locator('.bn-block-outer').nth(0).hover();
  await d.locator('.bn-side-menu [draggable=true]').first().click();
  await d.locator('.bn-menu-dropdown').first().waitFor(); await d.keyboard.press('Escape'); ok('clicking the handle (without dragging) opens the block menu');

  // --- glossary: master/detail with folders, synonyms, references, global glossary
  const settle = (await admin.get('/api/glossary/global')).data.terms.find((t) => t.term === 'Settlement'); // seeded demo terms: Chargeback, Settlement
  assert.ok(settle);
  await d.click('.sidebar a[href="#/glossary"]');
  await d.locator('#glList .row', { hasText: 'Ledger entry' }).waitFor(); await d.locator('#glList .row', { hasText: 'Attempt window' }).waitFor();
  assert.equal(await d.locator('#glDetail').count(), 0); assert.ok(await d.locator('.detail .placeholder').isVisible()); ok('glossary: term list on the left, placeholder on the right until a term is selected');
  await d.locator('#glList .row', { hasText: 'Attempt window' }).click();
  await d.locator('#glDetail h1', { hasText: 'Attempt window' }).waitFor(); await d.locator('#glDetail .gd-def', { hasText: 'time bucket' }).waitFor(); ok('glossary: selecting a term shows its definition in the detail pane');
  await d.click('.bar [data-act=dd-toggle]'); await d.getByRole('menuitem', { name: 'Term' }).click();
  await d.fill('#termname', 'Dunning');
  await d.route('**/api/lookup**', (r) => r.fulfill({ json: { query: 'Dunning', lang: 'en', results: [{ source: 'Wikipedia', title: 'Dunning (debt)', text: 'Dunning is the process of communicating with customers to ensure the collection of accounts receivable.', url: 'https://en.wikipedia.org/wiki/Dunning', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/' }] } }));
  await d.click('[data-act=lookup]'); await d.locator('[data-lookup-hit]').waitFor(); await d.click('[data-act=lookup-use]');
  assert.match(await d.inputValue('#termdef'), /Dunning is the process.*\(Source: Wikipedia, CC BY-SA 4\.0 – https:\/\/en\.wikipedia\.org\/wiki\/Dunning\)/); ok('glossary: online lookup offers a definition and copies it with its source');
  await d.unroute('**/api/lookup**');
  await d.fill('#termdef', 'Reminding customers about unpaid invoices.'); await d.click('[data-act=create-term]');
  await d.locator('#glDetail h1', { hasText: 'Dunning' }).waitFor(); await d.locator('#glList .row.active', { hasText: 'Dunning' }).waitFor(); ok('glossary: New → Term creates the term and opens it');
  // folder + a term with synonyms and references inside it
  await d.click('.bar [data-act=dd-toggle]'); await d.getByRole('menuitem', { name: 'Folder' }).click();
  await d.fill('#glfname', 'Payments'); await d.click('[data-act=do-gl-folder]');
  await d.locator('#glList .ftoggle', { hasText: 'Payments' }).waitFor(); ok('glossary folders: create a folder (a section heading in glossary.md)');
  await d.click('.bar [data-act=dd-toggle]'); await d.getByRole('menuitem', { name: 'Term' }).click();
  await d.fill('#termname', 'Payout'); await d.fill('#termdef', 'Money sent to the merchant after [[Settlement]] and [[Ghost term]].');
  await d.fill('#termaliases', 'disbursement, transfer'); await d.fill('#termsee', 'Chargeback'); await d.selectOption('#termfolder', 'Payments'); await d.click('[data-act=create-term]');
  await d.locator('#glDetail h1', { hasText: 'Payout' }).waitFor();
  await d.locator('#glDetail .gd-alias', { hasText: 'disbursement' }).waitFor(); await d.locator('#glDetail .gd-alias', { hasText: 'transfer' }).waitFor();
  assert.equal(await d.locator('#glDetail .termref.broken').count(), 5); ok('glossary detail: synonyms as chips, undefined references flagged (inline and in the related row)');
  const order = await d.locator('#glList').evaluate((el) => el.innerText);
  assert.ok(order.indexOf('Payments') >= 0 && order.indexOf('Payout') > order.indexOf('Payments')); ok('the term is listed under its folder');
  // edit in the detail pane
  await d.click('[data-act=gl-edit]');
  await d.fill('#gd-def', 'Money sent to the merchant after [[Settlement]] and [[Ghost term]]. Paid daily.');
  await d.click('#glEditForm button[type=submit]');
  await d.locator('#glDetail').getByText('Paid daily.').waitFor(); ok('glossary: edit a term in the detail pane (no jump to glossary.md)');
  // folder actions + alias search
  await d.locator('#glList .frow', { hasText: 'Payments' }).locator('[data-act=gl-folder-menu]').click();
  await d.getByRole('button', { name: 'Rename…' }).click(); await d.fill('#glfname', 'Billing'); await d.click('[data-act=do-gl-folder]');
  await d.locator('#glList .ftoggle', { hasText: 'Billing' }).waitFor(); await d.locator('#glList .row', { hasText: 'Payout' }).waitFor(); ok('glossary folders can be renamed (terms move with them)');
  await d.fill('#gsearch', 'disbursement');
  await d.waitForFunction(() => document.querySelectorAll('#glList .row').length === 1 && /Payout/.test(document.querySelector('#glList .row').textContent)); ok('search also matches synonyms');
  await d.fill('#gsearch', '');
  // import from the global glossary
  await d.click('.bar [data-act=dd-toggle]'); await d.getByRole('menuitem', { name: /Import from global/ }).click();
  await d.locator('.gi-row', { hasText: 'Chargeback' }).waitFor();
  await d.locator('.gi-row', { hasText: /^\s*Settlement/ }).locator('input').check();
  await d.fill('#gimport-q', 'clearing'); assert.equal(await d.locator('.gi-row').count(), 1); ok('import dialog: search the global glossary');
  await d.click('[data-act=do-gimport]');
  await d.locator('#glList .row[href$="/Settlement"]').waitFor(); await d.locator('#glList .row[href$="/Settlement"]').locator('.chip', { hasText: 'Global' }).waitFor();
  assert.equal(await d.locator('#glDetail .termref.broken').count(), 3); ok('importing a global term adds it to the glossary and resolves references to it');
  await d.locator('#glDetail .termref', { hasText: 'Settlement' }).first().click();
  await d.locator('#glDetail h1', { hasText: 'Settlement' }).waitFor();
  await d.locator('#glDetail .relrow', { hasText: 'Referenced by' }).getByText('Payout').waitFor(); ok('clicking a reference opens that term, which lists what references it');
  // the global term changes -> "Update available"
  await admin.patch(`/api/glossary/global/${settle.id}`, { definition: 'Funds move from the processor to our bank account.' });
  await d.click('.sidebar a[href="#/docs"]'); await d.click('.sidebar a[href="#/glossary"]');
  await d.locator('#glList .row[href$="/Settlement"]').click();
  await d.locator('#glDetail').getByText('Update available').first().waitFor({ timeout: 10000 });
  await d.locator('#glDetail [data-act=gl-update]').click();
  await d.locator('#glDetail').getByText('Funds move from the processor to our bank account.').waitFor();
  assert.equal(await d.locator('#glDetail').getByText('Update available').count(), 0); ok('an updated global term can be pulled into the team glossary');
  await shot(d, '06e-desktop-glossary-refs');
  // terms defined in a spec can be adopted; deleting a term
  await d.locator('#glList .row', { hasText: 'Ledger entry' }).click();
  await d.locator('#glDetail [data-act=gl-adopt]').waitFor(); ok('terms that live in a spec offer "Add to glossary"');
  await d.locator('#glList .row', { hasText: 'Dunning' }).click();
  d.once('dialog', (x) => x.accept()); await d.click('[data-act=gl-delete]');
  await d.waitForFunction(() => ![...document.querySelectorAll('#glList .row')].some((r) => /Dunning/.test(r.textContent))); ok('a term can be deleted from the glossary');
  // the block editor still shows the same definitions (glossary.md is just Markdown)
  await d.evaluate(() => (location.hash = '#/doc/glossary.md'));
  await d.locator('[data-content-type=definition]').first().waitFor();
  assert.equal(await d.locator('.editor .back').getAttribute('href'), '#/glossary');
  const pay = d.locator('[data-content-type=definition]').filter({ has: d.locator('.def-term[value="Payout"]') });
  assert.equal(await pay.locator('.def-aliases').inputValue(), 'disbursement, transfer'); ok('glossary.md still carries aliases and references as Markdown; its back link returns to the glossary');
  await d.evaluate(() => (location.hash = '#/glossary'));

  // --- documents in folders
  await d.click('.sidebar a[href="#/docs"]');
  await d.locator('.ftoggle', { hasText: 'adr' }).waitFor();
  await d.locator('.ftoggle', { hasText: 'schemas' }).waitFor(); ok('documents are shown in a folder tree');
  await d.locator('.ftoggle', { hasText: 'adr' }).click();
  assert.equal(await d.locator('.docrow', { hasText: 'ADR-007.md' }).count(), 0); await d.locator('.ftoggle', { hasText: 'adr' }).click();
  await d.locator('.docrow', { hasText: 'ADR-007.md' }).waitFor(); ok('folders collapse and expand');
  // the New button is a dropdown at the right edge of the bar
  const ddBtn = await d.locator('.bar [data-act=dd-toggle]').boundingBox();
  await d.click('.bar [data-act=dd-toggle]');
  await d.locator('.dd-menu').waitFor();
  const ddMenu = await d.locator('.dd-menu').boundingBox();
  assert.ok(Math.abs((ddMenu.x + ddMenu.width) - (ddBtn.x + ddBtn.width)) <= 2); ok('documents: New is a dropdown aligned to the right edge');
  assert.ok(await d.getByRole('menuitem', { name: 'Document' }).isVisible() && await d.getByRole('menuitem', { name: /Folder/ }).isVisible());
  await d.keyboard.press('Escape'); assert.equal(await d.locator('.dd-menu').isVisible(), false);
  await d.click('.bar [data-act=dd-toggle]'); await d.locator('#list').click({ position: { x: 5, y: 5 } }); assert.equal(await d.locator('.dd-menu').isVisible(), false); ok('the dropdown closes with Escape and on outside click');
  await d.click('.bar [data-act=dd-toggle]'); await d.getByRole('menuitem', { name: 'Document' }).click();
  await d.fill('#docname', 'notes/ideas/retry.md'); await d.click('[data-act=create-doc]');
  await d.locator('.ed-title', { hasText: 'notes/ideas/retry.md' }).waitFor();
  await d.locator('.ftoggle', { hasText: 'ideas' }).waitFor(); ok('a document in a new nested folder creates the folder');
  await d.click('[data-act=item-menu]'); await d.getByRole('button', { name: 'Move / rename…' }).click();
  await d.fill('#docname', 'decisions/retry.md'); await d.click('[data-act=do-move]');
  await d.locator('.ed-title', { hasText: 'decisions/retry.md' }).waitFor();
  await d.locator('.ftoggle', { hasText: 'decisions' }).waitFor();
  assert.equal(await d.locator('.ftoggle', { hasText: 'ideas' }).count(), 0); ok('moving a document updates the tree');
  await d.locator('#list .docrow.active').waitFor();
  await d.locator('.sidebar .pill').first().waitFor();
  await d.waitForFunction(() => document.querySelector('#saveInd')?.dataset.state === 'synced', null, { timeout: 15000 });
  assert.ok((await admin.sync()).data.items.some((i) => i.id === 'decisions/retry.md' && !i.deleted)); ok('moved document reaches the server');
  await d.click('[data-act=item-menu]'); d.once('dialog', (x) => x.accept()); await d.getByRole('button', { name: 'Delete document' }).click();
  await d.waitForFunction(() => !document.querySelector('.docrow .row-title')?.textContent.includes('retry.md'));
  await d.waitForTimeout(500);
  await d.waitForFunction(async () => true);
  await shot(d, '06c-desktop-docs');

  // --- foundation documents: write the vision, it goes live without any spec
  const ctxPat = (await admin.post('/api/me/tokens', { name: 'ctx', scopes: ['mcp:read'], teamId: admin.tid })).data.token;
  const teamContext = async () => (await (await fetch(`${BASE}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${ctxPat}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_team_context', arguments: {} } }) })).text());
  assert.match(await teamContext(), /Payout/); ok('glossary terms are served by MCP without being linked to any spec');
  await d.click('.sidebar a[href="#/docs"]');
  await d.locator('.found', { hasText: 'Vision' }).click();
  await d.locator('.bn-editor').first().waitFor();
  await d.click('[data-act=t-add]'); await d.getByRole('button', { name: 'Text', exact: true }).click();
  await d.keyboard.type('Calm, correct billing for everyone.');
  await new Promise((r) => setTimeout(r, 3500)); // client sync (2 s debounce) + server auto-release
  await d.evaluate(() => dispatchEvent(new Event('online')));
  await d.locator('#chips', { hasText: 'Live v' }).waitFor({ timeout: 15000});
  assert.match(await teamContext(), /Calm, correct billing/); ok('a foundation document goes live automatically and reaches the agent');
  await d.locator('.found.active', { hasText: 'Vision' }).waitFor();

  // --- folders can be created, filled, renamed and deleted in the UI
  await d.click('.sidebar a[href="#/docs"]');
  await d.click('.bar [data-act=dd-toggle]'); await d.getByRole('menuitem', { name: /Folder/ }).click();
  await d.fill('#docname', 'notes'); await d.click('[data-act=create-folder]');
  await d.locator('.ftoggle', { hasText: 'notes' }).waitFor();
  await d.locator('.ed-title', { hasText: 'notes/README.md' }).waitFor();
  assert.equal(await d.locator('.docrow', { hasText: 'README.md' }).count(), 1); ok('a new folder is created together with a default README.md, which opens for editing');
  await d.locator('.frow', { hasText: 'notes' }).hover();
  await d.locator('.frow', { hasText: 'notes' }).locator('[data-act=new-doc-in]').click();
  assert.equal(await d.inputValue('#docname'), 'notes/'); await d.fill('#docname', 'notes/plan.md'); await d.click('[data-act=create-doc]');
  await d.locator('.ed-title', { hasText: 'notes/plan.md' }).waitFor(); ok('a document can be created directly inside a folder');
  await d.locator('.frow', { hasText: 'notes' }).locator('[data-act=folder-menu]').click();
  assert.ok(await d.getByRole('button', { name: 'Delete folder' }).isDisabled()); ok('a folder with content cannot be deleted');
  await d.getByRole('button', { name: 'Rename / move…' }).click();
  await d.fill('#docname', 'team-notes'); await d.click('[data-act=do-rename-folder]');
  await d.locator('.ftoggle', { hasText: 'team-notes' }).waitFor();
  assert.equal(await d.locator('.ftoggle', { hasText: /^notes/ }).count(), 0); ok('renaming a folder moves its documents');
  await d.click('.bar [data-act=dd-toggle]'); await d.getByRole('menuitem', { name: /Folder/ }).click();
  await d.fill('#docname', 'scratch'); await d.click('[data-act=create-folder]');
  await d.locator('.ed-title', { hasText: 'scratch/README.md' }).waitFor();
  await d.click('[data-act=item-menu]'); d.once('dialog', (x) => x.accept()); await d.getByRole('button', { name: 'Delete document' }).click();
  await d.locator('.ftoggle', { hasText: 'scratch' }).waitFor();
  await d.locator('.frow', { hasText: 'scratch' }).locator('[data-act=folder-menu]').click();
  d.once('dialog', (x) => x.accept()); await d.getByRole('button', { name: 'Delete folder' }).click();
  await d.waitForFunction(() => ![...document.querySelectorAll('.ftoggle')].some((e) => /scratch/.test(e.textContent))); ok('an empty folder can be deleted');
  await d.evaluate(() => dispatchEvent(new Event('online')));
  await d.waitForFunction(() => /Synced/.test(document.querySelector('.sidebar .pill')?.textContent ?? ''), null, { timeout: 15000 });
  const folderState = (items) => items.some((i) => i.id === 'team-notes/plan.md' && !i.deleted) && items.some((i) => i.id === 'team-notes/README.md' && !i.deleted) && items.some((i) => i.id === 'team-notes' && i.kind === 'folder' && !i.deleted) && !items.some((i) => i.id === 'notes/plan.md' && !i.deleted) && !items.some((i) => i.id === 'notes' && !i.deleted) && !items.some((i) => i.id === 'scratch' && !i.deleted);
  let srvItems = [];
  for (let i = 0; i < 40 && !folderState(srvItems); i++) { await d.evaluate(() => dispatchEvent(new Event('online'))); await new Promise((r) => setTimeout(r, 400)); srvItems = (await admin.sync()).data.items; }
  assert.ok(folderState(srvItems), JSON.stringify(srvItems.filter((i) => i.kind !== 'spec').map((i) => `${i.kind}:${i.id}${i.deleted ? ' (deleted)' : ''}`))); ok('folder renames and documents reach the server');
  await shot(d, '06d-desktop-docs-folders');

  // --- spec types: choose a type, template, chip, filter, change type, team-defined types
  await d.click('.sidebar a[href="#/"]');
  await d.click('.bar [data-act=new-spec]');
  const chooser = d.locator('.typelist .typeopt');
  assert.equal(await chooser.count(), 8); await d.getByRole('button', { name: /ADR \(decision record\)/ }).waitFor(); await d.getByRole('button', { name: /Architecture spec/ }).waitFor(); await d.getByRole('button', { name: /UI spec \/ design rule/ }).waitFor(); await d.getByRole('button', { name: /API spec/ }).waitFor(); ok('new spec: choose from the built-in types (API, UI spec / design rule, feature, data model …)');
  await d.getByRole('button', { name: /API spec/ }).click();
  await d.locator('#title').waitFor(); await d.fill('#title', 'Orders API');
  await d.locator('[data-testid=spec-form]').waitFor();
  assert.equal(await d.locator('.editor .bn-editor').count(), 0);
  assert.deepEqual(await d.locator('.form-tabs .tab').allInnerTexts(), ['Overview', 'Endpoints', 'Contract', 'Quality']); ok('an API spec opens as a form with tabs (no editor): Overview, Endpoints, Contract, Quality');
  await d.locator('[data-field=overview] textarea').fill('Orders for the checkout.');
  await d.locator('[data-field=authentication] select').selectOption('OAuth 2');
  await d.getByRole('tab', { name: 'Endpoints', exact: true }).click();
  await d.getByRole('button', { name: 'Add endpoint' }).click(); await d.getByRole('button', { name: 'Add endpoint' }).click();
  await d.locator('[aria-label="HTTP method 1"]').selectOption('POST'); await d.locator('[aria-label="Path 1"]').fill('/orders');
  await d.locator('[aria-label="Endpoint 1 description"]').fill('Creates an order. Idempotent via Idempotency-Key.');
  await d.locator('[data-content-type=endpoint]').first().getByRole('tab', { name: 'Responses' }).click(); await d.locator('[aria-label="Endpoint 1 responses"]').fill('201 Created');
  await d.locator('[aria-label="Path 2"]').fill('/orders/{id}'); await d.locator('[aria-label="Endpoint 2 description"]').fill('Returns one order.');
  await d.getByRole('tab', { name: 'Quality', exact: true }).click();
  await d.locator('[data-field=requirements] .btn', { hasText: 'Add' }).click();
  const reqs = d.locator('[aria-label="REQUIREMENTS 1"]'); await reqs.fill('Orders are never duplicated'); await reqs.press('Enter'); await d.keyboard.type('Creating an order takes under 300 ms');
  await d.locator('[data-field=acceptance] .btn', { hasText: 'Add' }).click(); await d.keyboard.type('Retry with the same key returns the first order'); await d.locator('[aria-label="Done 1"]').check();
  ok('form: fields, select, repeatable endpoint cards with tabs, requirement and checklist rows (Enter adds a row)');
  await setMode(d, 'markdown');
  const formMd = await d.inputValue('#body');
  assert.match(formMd, /## OVERVIEW\n\nOrders for the checkout\.\n\n## AUTHENTICATION\n\nOAuth 2\n\n## ENDPOINTS\n\n```endpoint POST \/orders\nCreates an order\. Idempotent via Idempotency-Key\.\n\nResponses:\n201 Created\n```\n\n```endpoint GET \/orders\/\{id\}\nReturns one order\.\n```/);
  assert.match(formMd, /## REQUIREMENTS\n\nR1 Orders are never duplicated\nR2 Creating an order takes under 300 ms\n\n## ACCEPTANCE CRITERIA\n\n- \[x\] Retry with the same key returns the first order/); ok('the form is stored as plain Markdown sections (what agents read)');
  await setMode(d, 'blocks');
  await d.locator('[data-content-type=endpoint]').first().waitFor(); assert.equal(await d.locator('[data-content-type=endpoint]').count(), 2); ok('the same spec can be opened in the block editor');
  await setMode(d, 'form');
  await d.getByRole('tab', { name: 'Endpoints', exact: true }).click(); assert.equal(await d.locator('[aria-label="Path 2"]').inputValue(), '/orders/{id}'); ok('...and back as a form');
  assert.match(await d.locator('#chips').innerText(), /API/); ok('the type is shown as a chip in the editor bar');
  await d.locator('.row', { hasText: 'Orders API' }).locator('.chip.type', { hasText: 'API' }).waitFor(); ok('...and in the spec list');
  await d.selectOption('#typeFilter', 'api');
  await d.waitForFunction(() => [...document.querySelectorAll('#list .row')].every((r) => /Orders API|Webhook signature/.test(r.textContent)) && document.querySelectorAll('#list .row').length >= 1);
  assert.equal(await d.locator('#list .row', { hasText: 'Idempotent invoice retries' }).count(), 0); ok('the list can be filtered by type');
  await d.selectOption('#typeFilter', '');
  await d.click('[data-act=item-menu]'); await d.getByRole('button', { name: /Type: API spec/ }).click();
  await d.getByRole('button', { name: 'UI spec / design rule' }).click();
  await d.waitForFunction(() => /UI/.test(document.querySelector('#chips')?.textContent ?? '')); ok('the type can be changed later (content stays)');
  await setMode(d, 'markdown'); assert.match(await d.inputValue('#body'), /## ENDPOINTS[\s\S]*```endpoint POST \/orders/); ok('sections the new type does not know are kept (shown under "Other content")');
  await setMode(d, 'blocks');
  // team-defined type
  await d.click('.sidebar a[href="#/team"]'); await d.click('[data-tab=types]');
  await d.getByText('Spec types').first().waitFor();
  await d.click('[data-act=stype-new]');
  await d.fill('#st-label', 'Runbook'); await d.fill('#st-desc', 'Operational procedure');
  await d.fill('#st-tpl', '## TRIGGER\n\n## STEPS\n\n## ROLLBACK\n');
  await d.click('#stypeForm button[type=submit]');
  await d.locator('.typerow', { hasText: 'Runbook' }).waitFor(); ok('team admin defines a spec type with its own template');
  await d.click('.sidebar a[href="#/"]');
  await d.click('.bar [data-act=new-spec]');
  await d.getByRole('button', { name: /^Runbook/ }).click();
  await d.locator('[data-content-type=heading] .bn-inline-content', { hasText: 'ROLLBACK' }).waitFor(); ok('the custom type is offered when creating a spec and applies its template');
  // team-defined FORM type
  await d.click('.sidebar a[href="#/team"]'); await d.click('[data-tab=types]');
  await d.click('[data-act=stype-new]');
  await d.fill('#st-label', 'Checklist type'); await d.fill('#st-desc', 'Release checklist');
  await d.check('#st-useform'); await d.check('#st-formview');
  await d.fill('#st-tabs', 'Prepare, Release');
  await d.fill('[aria-label="Field 1 label"]', 'OWNER'); await d.selectOption('[aria-label="Field 1 type"]', 'text');
  await d.click('#st-addfield'); await d.fill('[aria-label="Field 2 label"]', 'STEPS'); await d.selectOption('[aria-label="Field 2 type"]', 'checklist'); await d.selectOption('[aria-label="Field 2 tab"]', 'release');
  await d.click('#stypeForm button[type=submit]');
  await d.locator('.typerow', { hasText: 'Checklist type' }).getByText('form', { exact: false }).first().waitFor();
  await d.click('.sidebar a[href="#/"]'); await d.click('.bar [data-act=new-spec]'); await d.getByRole('button', { name: /^Checklist type/ }).click();
  await d.locator('[data-testid=spec-form]').waitFor(); assert.deepEqual(await d.locator('.form-tabs .tab').allInnerTexts(), ['Prepare', 'Release']);
  await d.locator('[aria-label="OWNER"]').fill('Ops'); await d.getByRole('tab', { name: 'Release' }).click(); await d.locator('[data-field=steps] .btn', { hasText: 'Add' }).click(); await d.keyboard.type('Tag the build');
  await setMode(d, 'markdown'); assert.match(await d.inputValue('#body'), /## OWNER\n\nOps\n\n## STEPS\n\n- \[ \] Tag the build/); ok('a team-defined type can describe its own form (fields, tabs, default view) and specs of it open as that form');
  await setMode(d, 'blocks');
  await d.click('[data-act=item-menu]'); d.once('dialog', (x) => x.accept()); await d.getByRole('button', { name: 'Delete spec' }).click();
  await d.click('.sidebar a[href="#/"]'); await d.click('.bar [data-act=new-spec]'); await d.getByRole('button', { name: /^Runbook/ }).click();
  await d.locator('[data-content-type=heading] .bn-inline-content', { hasText: 'ROLLBACK' }).waitFor();
  await shot(d, '06f-desktop-spec-types');
  await d.click('[data-act=item-menu]'); d.once('dialog', (x) => x.accept()); await d.getByRole('button', { name: 'Delete spec' }).click();
  await d.click('.sidebar a[href="#/"]');

  // --- delete a spec
  await d.click('.sidebar a[href="#/"]');
  await d.click('.bar [data-act=new-spec]'); await d.getByRole('button', { name: /Feature spec/ }).click();
  const newId = await d.evaluate(() => decodeURIComponent(location.hash.split('/').pop()));
  await d.fill('#title', 'To be deleted');
  await d.click('[data-act=item-menu]'); d.once('dialog', (x) => x.accept()); await d.getByRole('button', { name: 'Delete spec' }).click();
  await d.waitForFunction((t) => ![...document.querySelectorAll('.row-title')].some((e) => e.textContent === t), 'To be deleted'); ok('a draft spec can be deleted');

  // --- teams: second team, switcher, isolation
  await admin.post('/api/teams', { name: 'Payments', key: 'PAY' });
  await d.reload();
  await d.locator('.sidebar .ws').click();
  await d.getByRole('button', { name: /Payments/ }).click();
  await d.locator('#list .empty').waitFor();
  assert.match(await d.locator('.sidebar .ws').innerText(), /Payments/); ok('team switcher: other team starts empty (data is scoped per team)');
  await d.click('.bar [data-act=new-spec]'); await d.getByRole('button', { name: /Feature spec/ }).click();
  await d.waitForFunction(() => /PAY-001/.test(decodeURIComponent(location.hash))); ok('spec ids carry the team key');
  await d.fill('#title', 'Payments spec');
  await d.waitForFunction(() => document.querySelector('#saveInd')?.dataset.state === 'synced', null, { timeout: 15000 });
  const t2 = (await admin.get('/api/teams')).data.teams.find((t) => t.key === 'PAY');
  assert.ok((await admin.sync([], 0, t2.id)).data.items.some((i) => i.id === 'PAY-001')); ok('edits sync into the active team');
  await d.locator('.sidebar .ws').click();
  await d.getByRole('button', { name: /^specs ·/ }).click();
  await d.locator('.row', { hasText: 'SPEC-014' }).waitFor();

  // --- team page: members + git connection per team
  await d.click('.sidebar a[href="#/team"]'); await d.click('[data-tab=git]');
  await d.getByText('Git connection').first().waitFor(); await d.click('[data-tab=team]');
  await d.locator('#fb-mail:checked').waitFor(); await d.uncheck('#fb-mail');
  await d.waitForFunction(async () => true); assert.equal((await admin.get(`/api/teams/${admin.tid}`)).data.team.feedbackMail, false); await d.check('#fb-mail');
  await d.waitForFunction(() => document.querySelector('#fb-mail')?.checked); ok('team admins switch the feedback e-mails on and off');
  await d.click('[data-tab=git]');
  await d.fill('#g-url', remote); await d.fill('#g-branch', 'main'); await d.fill('#g-root', 'specs');
  await d.click('#gitForm button[type=submit]');
  await d.waitForFunction((u) => document.querySelector('#g-url')?.value === u, remote);
  await d.click('[data-act=git-test]');
  await d.getByText(/Connection works/).waitFor(); ok('team page: git connection can be saved and tested');
  // --- agent trigger: a webhook per team (e.g. a Claude Code routine) + what an agent needs to connect
  await d.click('[data-tab=agents]');
  await d.click('[data-act=hook-preset]');
  assert.equal(await d.inputValue('#h-format'), 'text'); assert.match(await d.inputValue('#h-headers'), /anthropic-beta: experimental-cc-routine/);
  await d.fill('#h-url', `http://127.0.0.1:${sink.address().port}/v1/claude_code/routines/trig_test/fire`); await d.fill('#h-token', 'sk-routine-token');
  await d.click('#hookForm button[type=submit]');
  await d.locator('#hookCard .card-head .chip.ok', { hasText: 'on' }).waitFor();
  assert.equal(await d.inputValue('#h-token'), ''); assert.match(await d.getAttribute('#h-headers', 'placeholder'), /Saved: anthropic-beta, anthropic-version/); ok('team page: the agent trigger is saved; token and headers are never shown again');
  d.once('dialog', (x) => x.accept()); await d.click('[data-act=hook-test]');
  await d.locator('#hookRes', { hasText: 'accepted the call' }).waitFor();
  assert.equal(hits.length, 1); assert.equal(hits[0].headers.authorization, 'Bearer sk-routine-token'); assert.equal(hits[0].headers['anthropic-beta'], 'experimental-cc-routine-2026-04-01');
  assert.deepEqual(Object.keys(hits[0].body), ['text']); assert.match(hits[0].body.text, /Connection test/);
  await d.locator('#hookStatus a', { hasText: 'Open the run' }).waitFor(); ok('team page: "Send test" calls the routine the way Claude Code expects and links the started run');
  assert.match(await d.locator('#as-prompt').innerText(), /get_work_list[\s\S]*request_decision[\s\S]*report_implementation/);
  assert.match(await d.locator('#as-json').innerText(), /"url": "http:\/\/[^"]+\/mcp"[\s\S]*SPECS_TOKEN/); ok('team page: agent setup offers the MCP connection and the standing instruction to copy');
  await d.click('[data-tab=git]');
  await d.selectOption('#g-auth', 'ssh');
  assert.ok(await d.locator('.g-ssh').isVisible()); assert.ok(!(await d.locator('.g-token').isVisible()));
  await d.selectOption('#g-auth', 'none');
  await d.click('[data-act=git-push]');
  await d.getByText('Pushed to the remote.').waitFor({ timeout: 20000 }); ok('team page: push now');
  const cloned = path.join(tmp, 'clone'); execFileSync('git', ['clone', '-q', remote, cloned]);
  assert.ok(existsSync(path.join(cloned, 'specs', 'SPEC-012.md')) && existsSync(path.join(cloned, 'specs', 'docs', 'adr', 'webhook-keys.md'))); ok('released specs and folders arrive in the team’s git repository');
  await shot(d, '07-desktop-team');
  await d.click('[data-tab=members]');
  await d.locator('.user-main', { hasText: 'Vera' }).locator('select').selectOption('editor');
  await d.waitForFunction(async () => true);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await admin.get(`/api/teams/${admin.tid}/members`)).data.members.find((m) => m.email === 'viewer@example.com').role, 'editor'); ok('team admins change member roles');
  await d.locator('.user-main', { hasText: 'Vera' }).locator('select').selectOption('viewer');
  await new Promise((r) => setTimeout(r, 400));

  await d.click('.sidebar a[href="#/release"]');
  await d.getByText('Agent endpoint').waitFor();
  await d.getByText(/Pushed .* ago|Pushed just now/).first().waitFor(); ok('release page shows the git status');
  await shot(d, '07b-desktop-release');

  // account: create token for a team, shown once
  await d.click('[data-act=user-menu]'); await d.getByRole('button', { name: 'Account & agent access' }).click();
  await d.fill('#tname', 'Desktop agent');
  await d.selectOption('#tscope', 'mcp:read mcp:drafts');
  await d.click('#tokenForm button[type=submit]');
  await d.getByText('copy it now, it is shown only once').waitFor();
  const token = await d.locator('.ok-card .code').first().innerText();
  assert.match(token, /^spc_/); ok('account: personal token created and shown once');
  await d.click('.sidebar a[href="#/"]'); await d.click('[data-act=user-menu]'); await d.getByRole('button', { name: 'Account & agent access' }).click();
  await d.getByText('Your tokens').waitFor();
  assert.ok(!(await d.content()).includes(token)); assert.ok(await d.getByText('Desktop agent').count() > 0); ok('account: token no longer visible afterwards, only its prefix');
  await shot(d, '08-desktop-account');

  // theme: light / dark / system, remembered
  await d.click('[data-tab=settings]');
  await d.locator('[data-act=set-theme][data-v=light]').click();
  assert.equal(await d.evaluate(() => document.documentElement.dataset.theme), 'light');
  assert.equal(await d.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(244, 245, 247)'); ok('appearance: light mode');
  await shot(d, '08b-desktop-light-account');
  await d.reload(); assert.equal(await d.evaluate(() => document.documentElement.dataset.theme), 'light'); ok('appearance: choice is remembered');
  await d.locator('[data-act=set-theme][data-v=dark]').click();
  assert.equal(await d.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(15, 18, 20)'); ok('appearance: dark mode');

  // any user can create a team from the workspace menu
  await d.locator('.sidebar .ws').click();
  await d.getByRole('button', { name: 'Create a new team…' }).click();
  await d.fill('#newteam', 'Platform Crew'); await d.click('#createTeamForm button[type=submit]');
  await d.waitForFunction(() => /Platform Crew/.test(document.querySelector('.sidebar .ws')?.textContent ?? ''));
  assert.ok(await d.locator('.found', { hasText: 'Vision' }).count() === 0); // lands on specs
  await d.click('.sidebar a[href="#/docs"]');
  await d.locator('.found', { hasText: 'Vision' }).waitFor(); await d.locator('.found', { hasText: 'Strategy' }).waitFor();
  assert.equal(await d.locator('.found', { hasText: 'Glossary' }).count(), 0); ok('a new team starts with vision and strategy under Documents; the glossary lives on its own page, not in the document list');

  // invitation flow: team admin invites, the invitee registers through the link
  await d.click('.sidebar a[href="#/team"]'); await d.click('[data-tab=members]');
  await d.focus('[data-tab=members]'); await d.keyboard.press('ArrowRight'); await d.locator('[data-tab=types][aria-selected=true]').waitFor(); await d.click('[data-tab=members]'); ok('tabs: arrow keys move between the sections of a page');
  await d.fill('#inv-email', 'ed@example.com'); await d.selectOption('#inv-role', 'editor');
  await d.click('#inviteForm button[type=submit]');
  await d.locator('.ok-card .code').waitFor();
  await d.getByText('Invitation e-mailed to ed@example.com').waitFor();
  const shownLink = await d.locator('.ok-card .code').innerText();
  assert.match(shownLink, /#\/invite\/inv_/);
  const firstMail = smtp.mails.find((m) => m.to.includes('ed@example.com'));
  assert.ok(firstMail && firstMail.text.includes(shownLink)); ok('team admin sends an invitation: it is e-mailed and the link is shown as a fallback');
  // resend: a new mail with a new link; the old link stops working
  await d.locator('[data-act=invite-resend]').click();
  await d.waitForFunction(() => /sent again/.test(document.querySelector('#toast')?.textContent ?? ''));
  const link = await d.locator('.ok-card .code').innerText();
  assert.notEqual(link, shownLink);
  assert.equal(smtp.mails.filter((m) => m.to.includes('ed@example.com')).length, 2);
  assert.equal((await new Client(BASE).get(`/api/invites/${shownLink.split('/invite/')[1]}`)).status, 404); ok('resending creates a new e-mail and link and invalidates the old one');
  await shot(d, '09-desktop-invite');
  const ictx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const ip = await ictx.newPage(); watch(ip);
  await ip.goto(link);
  await ip.getByText('Join Platform Crew').waitFor();
  await ip.fill('#iv-name', 'Ed Editor'); await ip.fill('#iv-pw', 'editorpass1'); await ip.click('#inviteRegister button[type=submit]');
  await ip.waitForFunction(() => /Platform Crew/.test(document.querySelector('.ws-btn')?.getAttribute('aria-label') ?? ''));
  await ip.click('.tabbar a[href="#/docs"]');
  await ip.locator('.found', { hasText: 'Vision' }).waitFor(); ok('the invited person creates their account from the link and lands in the team');
  await shot(ip, '09b-invitee');
  await ictx.close();

  // admin page: teams + accounts, delete an account
  await d.click('.sidebar a[href="#/admin"]'); await d.click('[data-tab=email]');
  await d.getByText('configured', { exact: true }).waitFor();
  await d.click('[data-act=mail-test]');
  await d.waitForFunction(() => /Test e-mail sent/.test(document.querySelector('#toast')?.textContent ?? ''));
  assert.ok(smtp.mails.some((m) => m.to.includes('admin@localhost') && /test e-mail/.test(m.subject))); ok('admin page: e-mail status and test e-mail');
  // global glossary: import a file (CSV), preview, conflict mode
  await d.click('[data-tab=glossary]');
  await d.locator('#gfile').setInputFiles({ name: 'terms.csv', mimeType: 'text/csv', buffer: Buffer.from('term,definition,aliases\nChargeback,Changed text,dispute\nRefund,Money returned to the customer,reimbursement\n"Bad [term]",x,\n') });
  await d.getByRole('heading', { name: /Import “terms.csv”/ }).waitFor();
  await d.getByText(/found:/).waitFor();
  assert.match(await d.locator('.sheet').innerText(), /3 terms found: 2 new, 1 already/); ok('admin: importing a glossary file shows a preview (new vs. existing, parse problems)');
  await d.locator('input[name=gmode][value=skip]').check(); await d.click('[data-act=do-gfile]');
  await d.waitForFunction(() => /1 added/.test(document.querySelector('#toast')?.textContent ?? ''));
  await d.locator('.rel', { hasText: 'Refund' }).waitFor();
  assert.equal((await admin.get('/api/glossary/global')).data.terms.find((t) => t.term === 'Chargeback').definition.startsWith('Changed'), false); ok('admin: file import adds new terms and keeps existing ones by default');
  await d.locator('#gfile').setInputFiles({ name: 'terms.md', mimeType: 'text/markdown', buffer: Buffer.from('Chargeback\n: Updated from a Markdown file.\n') });
  await d.locator('input[name=gmode][value=update]').check(); await d.click('[data-act=do-gfile]');
  await d.waitForFunction(() => /1 updated/.test(document.querySelector('#toast')?.textContent ?? ''));
  assert.match((await admin.get('/api/glossary/global')).data.terms.find((t) => t.term === 'Chargeback').definition, /Updated from a Markdown file/); ok('admin: "update existing" overwrites terms from a Markdown file');
  const dl = d.waitForEvent('download'); await d.click('[data-act=gterm-export]');
  assert.equal((await dl).suggestedFilename(), 'global-glossary.md'); ok('admin: the global glossary can be exported as Markdown');
  await d.click('[data-tab=teams]');
  await d.locator('.user:has(.ws-av)', { hasText: 'Platform Crew' }).waitFor(); await d.locator('.user:has(.ws-av)', { hasText: 'Payments' }).waitFor();
  await d.click('[data-tab=accounts]');
  await d.locator('.user:has(.avatar)', { hasText: 'Ed Editor' }).waitFor();
  assert.equal(await d.locator('#userForm').count(), 0); ok('admin page lists teams and accounts (no account creation form – people are invited)');
  await shot(d, '09c-desktop-admin');
  d.once('dialog', (x) => x.accept());
  await d.locator('.user:has(.avatar)', { hasText: 'Ed Editor' }).locator('[data-act=user-delete]').click();
  await d.waitForFunction(() => ![...document.querySelectorAll('.user')].some((u) => /Ed Editor/.test(u.textContent)));
  assert.equal((await admin.get('/api/users')).data.users.some((u) => u.email === 'ed@example.com'), false); ok('admin can delete an account');
  await dctx.close();

  // =============================================================== VIEWER (rights in the UI)
  const vctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const v = await vctx.newPage();
  watch(v);
  await v.goto(BASE);
  await signIn(v, 'viewer@example.com', 'viewerpass1');
  await v.locator('.row', { hasText: 'SPEC-014' }).click();
  await v.locator('.bn-editor').first().waitFor();
  assert.equal(await v.locator('[data-act=new-spec]').count(), 0);
  assert.equal(await v.locator('[data-act=approve]').count(), 0);
  assert.equal(await v.locator('.bn-side-menu').count(), 0);
  assert.equal(await v.locator('.sidebar a[href="#/admin"]').count(), 0);
  assert.equal(await v.locator('.bn-editor').first().getAttribute('contenteditable'), 'false');
  await v.locator('#saveInd[data-state="ro"]').waitFor(); ok('viewer: read-only editor, no drag handles, no create/approve/admin');
  await v.click('.sidebar a[href="#/team"]'); await v.click('[data-tab=git]');
  await v.locator('#g-url[readonly]').waitFor(); assert.equal(await v.locator('#gitForm button[type=submit]').count(), 0); ok('viewer: git connection is read-only');
  await shot(v, '10-viewer');
  await vctx.close();

  assert.deepEqual(errors, [], 'page errors: ' + errors.join('; ')); ok('no console/page errors');
  console.log(`\n${n} checks passed`);
} catch (e) {
  if (SHOTS) { let k = 0; for (const c of browser.contexts()) for (const pg of c.pages()) await pg.screenshot({ path: `${SHOTS}/fail-${++k}.png` }).catch(() => {}); }
  throw e;
} finally {
  await browser.close();
  srv.stop();
  smtp.stop();
  sink.close();
}
