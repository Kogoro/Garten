#!/usr/bin/env node
// Repeatable UI/UX audit of the rendered app. Starts a throw-away server with stress data (long names, 120 specs), opens every main page on a
// phone and on a desktop (light and dark) and checks what can be measured: axe-core (WCAG 2.2 AA + best practice), touch targets, text size of
// inputs, horizontal overflow, visible focus, one h1 / a unique title / a main landmark per page, a skip link, keyboard shortcuts, response
// headers, icons and metadata. Prints the failures and a score out of 10 per area.
//
//   node scripts/ux-audit.mjs            (needs: npm run build in web/, and `npm i --no-save axe-core` – done on first run)
//   AUDIT_JSON=out.json node scripts/ux-audit.mjs
//
// The score covers only what a script can see. Screen-reader use, wording and layout taste still need a person.
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let axePath; try { axePath = require.resolve('axe-core/axe.min.js'); } catch { execFileSync('npm', ['i', '--no-save', '--no-audit', '--no-fund', 'axe-core'], { cwd: root, stdio: 'ignore' }); axePath = require.resolve('axe-core/axe.min.js'); }
const axeSrc = readFileSync(axePath, 'utf8');

const PORT = 3400 + Math.floor(Math.random() * 400), BASE = `http://localhost:${PORT}`;
const dir = mkdtempSync(path.join(process.env.TEST_TMP || tmpdir(), 'ux-audit-'));
const srv = spawn('node', ['server/index.js'], { cwd: root, env: { ...process.env, PORT: String(PORT), DATA_DIR: dir, ADMIN_PASSWORD: 'adminpass1', PUBLIC_URL: BASE, SEED_DEMO: '1', NODE_NO_WARNINGS: '1' }, stdio: 'ignore' });
const stop = () => { try { srv.kill(); } catch { /* gone */ } };
process.on('exit', stop);
for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 200)); }

const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-specs': '1' }, body: JSON.stringify({ email: 'admin@localhost', password: 'adminpass1' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const tid = (await login.json()).me.teams[0].id;
const changes = [];
for (let i = 1; i <= 120; i++) changes.push({ id: `SPEC-${100 + i}`, kind: 'spec', baseRev: 0, fields: { title: i % 7 === 0 ? `Pneumonoultramicroscopicsilicovolcanoconiosis-Abrechnung für Müller-Lüdenscheidt-Schmidt-Hohenzollern ${i}` : `Spec number ${i} for invoices`, body: '## GOAL\nx\n' } });
changes.push({ id: 'docs/ThisIsAVeryLongDocumentNameWithoutAnySpacesOrBreakpointsAtAllToStressTheLayout.md', kind: 'doc', baseRev: 0, fields: { title: 'Long', body: '# Long\n' } });
await fetch(`${BASE}/api/teams/${tid}/sync`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-specs': '1', cookie }, body: JSON.stringify({ since: 0, changes }) });

const ROUTES = ['#/', '#/garden', '#/docs', '#/glossary', '#/release', '#/sync', '#/team', '#/account', '#/admin', '#/spec/SPEC-107'];
const fails = []; // { area, where, what }
const fail = (area, where, what) => fails.push({ area, where, what });
const totals = {}; // area -> { checks, failed }
const count = (area, n = 1) => { (totals[area] ??= { checks: 0, failed: 0 }).checks += n; };
const miss = (area, where, what) => { count(area, 0); totals[area].failed += 1; fail(area, where, what); };
const check = (area, ok, where, what) => { count(area); if (!ok) miss(area, where, what); };

// ---- static: headers, metadata, icons
{
  const res = await fetch(`${BASE}/`); const html = await res.text(); const h = (k) => res.headers.get(k);
  check('security', !!h('content-security-policy'), '/', 'no Content-Security-Policy');
  check('security', /frame-ancestors/.test(h('content-security-policy') ?? '') || !!h('x-frame-options'), '/', 'no clickjacking protection (frame-ancestors / X-Frame-Options)');
  check('security', h('x-content-type-options') === 'nosniff', '/', 'no X-Content-Type-Options');
  check('security', !!h('referrer-policy'), '/', 'no Referrer-Policy');
  check('security', !!h('permissions-policy'), '/', 'no Permissions-Policy');
  check('metadata', /<meta name="viewport"/.test(html), '/', 'no viewport meta');
  check('metadata', /<meta name="theme-color"/.test(html), '/', 'no theme-color');
  check('metadata', /<meta name="description"/.test(html), '/', 'no meta description');
  check('metadata', /rel="apple-touch-icon" href="[^"]+\.png"/.test(html), '/', 'apple-touch-icon is not a PNG');
  check('metadata', /<html lang="/.test(html), '/', 'no html lang');
  const man = await (await fetch(`${BASE}/manifest.webmanifest`)).json().catch(() => ({}));
  const sizes = (man.icons ?? []).map((i) => i.sizes);
  check('metadata', sizes.includes('192x192') && sizes.includes('512x512'), '/manifest', 'manifest has no 192 and 512 PNG icons');
  check('metadata', (man.icons ?? []).some((i) => /maskable/.test(i.purpose ?? '')), '/manifest', 'manifest has no maskable icon');
  const asset = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  if (asset) { const a = await fetch(BASE + asset, { headers: { 'accept-encoding': 'gzip, br' } }); check('performance', /immutable/.test(a.headers.get('cache-control') ?? ''), asset, 'hashed assets are not cached as immutable'); check('performance', !!a.headers.get('content-encoding'), asset, 'assets are not compressed'); }
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const titles = new Map();
async function pass(label, viewport, scheme) {
  const phone = viewport.width < 700;
  const ctx = await browser.newContext({ viewport, colorScheme: scheme, hasTouch: phone, isMobile: phone, reducedMotion: 'no-preference' });
  const page = await ctx.newPage();
  const jsErrors = []; page.on('pageerror', (e) => jsErrors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') jsErrors.push(m.text()); });
  await page.goto(`${BASE}/`);
  await page.fill('input[type=email]', 'admin@localhost'); await page.fill('input[type=password]', 'adminpass1'); await page.keyboard.press('Enter');
  await page.waitForSelector('.tabbar, .sidebar', { state: 'attached', timeout: 20000 });
  await page.waitForTimeout(1200);
  for (const r of ROUTES) {
    const where = `${label} ${r}`;
    await page.evaluate((h) => { location.hash = h; }, r); await page.waitForTimeout(600);
    await page.evaluate(axeSrc); // via DevTools: the page's own Content-Security-Policy stays in force
    const violations = await page.evaluate(async () => (await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'] })).violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, sample: v.nodes[0]?.target?.join(' ').slice(0, 80) })));
    count('accessibility', 8);
    for (const v of violations) miss('accessibility', where, `axe ${v.id} (${v.impact}) ×${v.n}, e.g. ${v.sample}`);
    const m = await page.evaluate((phone) => {
      const vis = (e) => { const b = e.getBoundingClientRect(); const cs = getComputedStyle(e); return b.width > 0 && b.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
      const ctl = [...document.querySelectorAll('button, a[href], [role=button], [role=tab], input:not([type=hidden]), select, textarea')].filter(vis);
      const inText = (e) => e.tagName === 'A' && getComputedStyle(e).display.startsWith('inline') && [...(e.parentElement?.childNodes ?? [])].some((n) => n.nodeType === 3 && n.textContent.trim().length > 3); // a link inside a sentence is exempt (WCAG 2.5.8 "inline")
      const small = ctl.filter((e) => { const box = e.matches('input[type=checkbox], input[type=radio]') ? (e.closest('label') ?? e) : e; const b = box.getBoundingClientRect(); return (b.height < 44 || b.width < 44) && !inText(e); }).map((e) => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : ''}[${(e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.textContent || '').trim().slice(0, 18)}|${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}]`);
      const tinyEls = phone ? [...document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea')].filter(vis).filter((e) => parseFloat(getComputedStyle(e).fontSize) < 16) : []; const tiny = tinyEls.length; const tinyList = tinyEls.map((e) => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}.${String(e.className).split(' ')[0]}`);
      const body = parseFloat(getComputedStyle(document.body).fontSize);
      const clipped = [...document.querySelectorAll('.row, .item, li, h1, h2, h3, b, span, p')].filter((e) => e.children.length === 0 && vis(e) && e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflow === 'visible' && e.getBoundingClientRect().right > (e.parentElement?.getBoundingClientRect().right ?? 1e9) + 1).length;
      const title = document.title;
      return { overflowX: document.documentElement.scrollWidth - innerWidth, small: [...new Set(small)], smallN: small.length, tiny, tinyList, body, clipped, h1: document.querySelectorAll('h1').length, main: !!document.querySelector('main, [role=main]'), skip: !!document.querySelector('a.skip, a[href="#main"]'), title, hoverOnly: document.querySelectorAll('[title]:not(a):not(button):not(span):not(input)').length };
    }, phone);
    check('layout', m.overflowX <= 0, where, `horizontal overflow ${m.overflowX}px`);
    check('layout', m.clipped === 0, where, `${m.clipped} text elements overflow their box (long words do not wrap)`);
    check('layout', m.body >= 16 || !phone, where, `body text ${m.body}px on a phone (min 16)`);
    check('touch', !phone || m.smallN === 0, where, `${m.smallN} touch targets under 44px: ${m.small.slice(0, 5).join(', ')}`);
    check('touch', m.tiny === 0, where, `${m.tiny} inputs under 16px (iOS zooms in): ${m.tinyList.join(', ')}`);
    check('semantics', m.h1 === 1, where, `${m.h1} h1 elements`);
    check('semantics', m.main, where, 'no main landmark');
    check('semantics', m.skip, where, 'no skip link');
    if (label === ROUTES_LABEL) { titles.set(r, m.title); }
  }
  // keyboard: every tabbable element on the home page shows a focus indicator
  await page.evaluate(() => { location.hash = '#/'; }); await page.waitForTimeout(400);
  let noRing = 0, tabbed = 0;
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    const ring = await page.evaluate(() => { const e = document.activeElement; if (!e || e === document.body) return null; const cs = getComputedStyle(e); const own = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none'; const parent = e.closest('label, .field-wrap, .search'); const pcs = parent && getComputedStyle(parent); return own || (pcs && ((pcs.outlineStyle !== 'none' && parseFloat(pcs.outlineWidth) > 0) || pcs.boxShadow !== 'none')) ? 1 : 0; });
    if (ring === null) continue; tabbed += 1; if (!ring) noRing += 1;
  }
  check('keyboard', noRing === 0, label, `${noRing} of ${tabbed} focused elements show no focus indicator`);
  await page.evaluate(() => (document.activeElement)?.blur?.());
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k'); await page.waitForTimeout(250);
  check('keyboard', await page.locator('[role=dialog][aria-label*=ommand], [data-palette]').count() > 0, label, 'Ctrl/Cmd+K opens no command palette');
  await page.keyboard.press('Escape');
  await page.keyboard.press('?'); await page.waitForTimeout(250);
  check('keyboard', await page.locator('[role=dialog]').count() > 0, label, '"?" shows no keyboard shortcut list');
  await page.keyboard.press('Escape');
  check('stability', jsErrors.length === 0, label, `${jsErrors.length} console/page errors: ${jsErrors[0]?.slice(0, 120)}`);
  // reduced motion
  await ctx.close();
}
const ROUTES_LABEL = 'desktop-dark';
await pass('phone-light', { width: 390, height: 844 }, 'light');
await pass('phone-small-dark', { width: 320, height: 640 }, 'dark');
await pass('desktop-dark', { width: 1440, height: 900 }, 'dark');
await pass('desktop-light', { width: 1280, height: 800 }, 'light');
await browser.close(); stop();
// one distinct title per page
const distinct = new Set(titles.values()).size;
check('semantics', distinct === ROUTES.length, 'all pages', `only ${distinct} distinct document titles for ${ROUTES.length} pages (${[...new Set(titles.values())].slice(0, 4).join(' | ')})`);

const areas = Object.keys(totals).sort();
// Score per area: 10 minus the weight of its distinct defects (the same defect on ten pages counts once).
// Weight: 1.5 for axe "critical/serious", 1 for other axe findings and touch/keyboard/semantics/security, 0.5 for metadata/performance/layout.
const defects = new Map();
for (const f of fails) { const k = `${f.area}|${f.what.replace(/\d+/g, 'N').replace(/, e\.g\..*$/, '')}`; if (!defects.has(k)) defects.set(k, { ...f, where: [] }); defects.get(k).where.push(f.where); }
const weight = (d) => (/\((serious|critical)\)/.test(d.what) ? 1.5 : ['metadata', 'performance', 'layout'].includes(d.area) ? 0.5 : 1);
const score = (a) => Math.max(0, 10 - [...defects.values()].filter((d) => d.area === a).reduce((s, d) => s + weight(d), 0));
console.log('\nUX audit\n');
for (const a of areas) console.log(`${a.padEnd(14)} ${score(a).toFixed(1).padStart(4)} / 10   (${[...defects.values()].filter((d) => d.area === a).length} defects, ${totals[a].failed} failing checks of ${totals[a].checks})`);
const overall = areas.reduce((s, a) => s + score(a), 0) / areas.length;
console.log(`\nautomated overall: ${overall.toFixed(1)} / 10   (${defects.size} distinct defects, ${fails.length} failing checks)\n`);
for (const g of defects.values()) console.log(`- [${g.area}] ${g.what}\n    ${[...new Set(g.where)].slice(0, 6).join('; ')}${g.where.length > 6 ? ` … (${g.where.length}×)` : ''}`);
if (process.env.AUDIT_JSON) writeFileSync(process.env.AUDIT_JSON, JSON.stringify({ totals, fails, overall }, null, 1));
process.exit(fails.length ? 1 : 0);
