// Quick React smoke test: login, create spec, insert blocks via the slash menu, check the stored Markdown.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startServer } from '../../tests/helpers.mjs';

const srv = await startServer({ WEB_DIR: new URL('../dist', import.meta.url).pathname });
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
try {
  await page.goto(srv.base);
  await page.fill('#email', 'admin@localhost'); await page.fill('#password', 'adminpass1'); await page.click('button[type=submit]');
  await page.locator('.row', { hasText: 'SPEC-012' }).first().waitFor();
  console.log('ok - login + seeded specs listed');
  await page.click('.bar .btn.primary');
  await page.locator('[data-testid=block-editor] .bn-editor').waitFor();
  await page.fill('#title', 'React spec');
  await page.locator('.bn-editor .bn-block-content').first().click();
  await page.keyboard.type('/endpoint'); await page.keyboard.press('Enter');
  await page.locator('.endpoint').waitFor();
  await page.locator('.ep-method').selectOption('POST'); await page.fill('.ep-path', '/orders');
  await page.fill('.endpoint textarea', 'Creates an order.');
  await page.getByRole('tab', { name: 'Responses' }).click(); await page.fill('.endpoint textarea', '201 Created');
  console.log('ok - endpoint block with tabs');
  await page.getByRole('button', { name: 'Markdown', exact: true }).click();
  const md = await page.inputValue('#body');
  console.log(JSON.stringify(md));
  assert.match(md, /```endpoint POST \/orders\nCreates an order\.\n\nResponses:\n201 Created\n```/);
  console.log('ok - serialises to endpoint fence');
  await page.screenshot({ path: '/tmp/react-smoke.png' });
} finally { await browser.close(); srv.stop(); }
console.log(errors.length ? 'ERRORS: ' + errors.join('\n') : 'no console errors');
