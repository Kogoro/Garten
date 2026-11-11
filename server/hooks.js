// One webhook per team: tells an agent runner (e.g. a Claude Code routine) that specs were released or decisions answered.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { db } from './db.js';
import { events } from './store.js';
import { getTeam, TeamError } from './teams.js';
import { encrypt, decrypt } from './secrets.js';
import { HOOK_DEBOUNCE_MS, HOOK_ALLOW_LOCAL, PUBLIC_URL } from './config.js';

export const HOOK_EVENTS = ['release', 'answer'];
export const HOOK_FORMATS = ['full', 'text'];

// ---- never call into the server's own network (SSRF): private, loopback, link-local and metadata ranges are refused
const blocked = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) blocked.addSubnet(a, p, 'ipv6');
const isPrivate = (address) => { const fam = net.isIP(address); return fam === 0 || blocked.check(address, fam === 6 ? 'ipv6' : 'ipv4'); };
const safeLookup = (host, opts, cb) => {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  dns.lookup(host, { ...opts, all: true }, (err, list) => {
    if (err) return cb(err);
    if (!HOOK_ALLOW_LOCAL && list.some((a) => isPrivate(a.address))) return cb(new Error('the address is private or local – not allowed for webhooks'));
    if (opts.all) cb(null, list); else cb(null, list[0].address, list[0].family);
  });
};

export function validateHookUrl(url) {
  url = String(url ?? '').trim();
  if (!url) return '';
  if (url.length > 500) throw new TeamError('The webhook URL is too long');
  let u;
  try { u = new URL(url); } catch { throw new TeamError('Enter a full webhook URL (https://…)'); }
  if (u.username || u.password) throw new TeamError('Put credentials into the token or a header, not into the URL');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && HOOK_ALLOW_LOCAL)) throw new TeamError('The webhook URL must start with https://');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!HOOK_ALLOW_LOCAL && (host === 'localhost' || /\.(localhost|local|internal|lan|home)$/.test(host) || (net.isIP(host) && isPrivate(host)))) throw new TeamError('Webhooks to local or private addresses are disabled on this server (HOOK_ALLOW_LOCAL)');
  return u.toString();
}

const FORBIDDEN = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'content-type', 'upgrade', 'expect', 'te', 'trailer']);
/** "Name: value" per line → { name: value } */
function parseHeaders(text) {
  const out = {};
  for (const line of String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean)) {
    const i = line.indexOf(':');
    const name = i > 0 ? line.slice(0, i).trim() : ''; const value = i > 0 ? line.slice(i + 1).trim() : '';
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || !value) throw new TeamError(`Headers are written as "Name: value" – check "${line.slice(0, 40)}"`);
    if (FORBIDDEN.has(name.toLowerCase())) throw new TeamError(`The header ${name} is set by the server`);
    if (value.length > 2000 || /[^\x20-\x7e]/.test(value)) throw new TeamError(`The value of ${name} contains characters that are not allowed`);
    out[name] = value;
  }
  if (Object.keys(out).length > 10) throw new TeamError('At most 10 extra headers');
  return out;
}
const storedHeaders = (row) => { try { return row.hook_headers ? JSON.parse(decrypt(row.hook_headers)) : {}; } catch { return {}; } };

export const publicHook = (team) => {
  const r = team.row;
  return {
    url: r.hook_url ?? '', hasToken: !!r.hook_secret, headerNames: Object.keys(storedHeaders(r)), events: String(r.hook_events ?? '').split(',').filter(Boolean), format: r.hook_format,
    debounceSeconds: Math.round(HOOK_DEBOUNCE_MS / 1000), allowLocal: HOOK_ALLOW_LOCAL,
    lastAt: r.hook_last_at, lastOk: r.hook_last_ok === null ? null : !!r.hook_last_ok, lastInfo: r.hook_last_info, lastUrl: /https:\/\/claude\.ai\/[A-Za-z0-9_\-/?=&.%]+/.exec(r.hook_last_info ?? '')?.[0] ?? null,
  };
};

/** Fields that are left out stay as they are; token: '' keeps the stored one, clearToken removes it. */
export function saveHook(teamId, s = {}) {
  const t = getTeam(teamId); const r = t.row;
  const url = s.url === undefined ? r.hook_url ?? '' : validateHookUrl(s.url);
  let secret = r.hook_secret;
  if (s.token) { const tok = String(s.token).trim(); if (tok.length > 2000 || /[^\x21-\x7e]/.test(tok)) throw new TeamError('The token contains characters that are not allowed'); secret = encrypt(tok); }
  if (s.clearToken || !url) secret = null;
  let headers = r.hook_headers;
  if (s.headers !== undefined) { const h = parseHeaders(s.headers); headers = Object.keys(h).length ? encrypt(JSON.stringify(h)) : null; }
  if (!url) headers = null;
  let ev = r.hook_events;
  if (s.events !== undefined) {
    if (!Array.isArray(s.events) || s.events.some((e) => !HOOK_EVENTS.includes(e))) throw new TeamError(`events: any of ${HOOK_EVENTS.join(', ')}`);
    ev = [...new Set(s.events)].join(',');
  }
  const format = s.format === undefined ? r.hook_format : s.format;
  if (!HOOK_FORMATS.includes(format)) throw new TeamError(`format: ${HOOK_FORMATS.join(' or ')}`);
  db.prepare('UPDATE teams SET hook_url=?, hook_secret=?, hook_headers=?, hook_events=?, hook_format=? WHERE id=?').run(url || null, secret, headers, ev, format, teamId);
  if ((url || null) !== (r.hook_url ?? null)) db.prepare('UPDATE teams SET hook_last_at=NULL, hook_last_ok=NULL, hook_last_info=NULL WHERE id=?').run(teamId);
  return getTeam(teamId);
}

function post(team, payload) {
  const r = team.row;
  return new Promise((resolve) => {
    let u;
    try { u = new URL(validateHookUrl(r.hook_url)); } catch (e) { return resolve({ ok: false, info: e.message }); }
    const body = JSON.stringify(r.hook_format === 'text' ? { text: payload.text } : payload);
    const headers = { ...storedHeaders(r), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'specs-webhook' };
    try { if (r.hook_secret) headers.Authorization = `Bearer ${decrypt(r.hook_secret)}`; } catch { return resolve({ ok: false, info: 'The stored token cannot be read – enter it again.' }); }
    const req = (u.protocol === 'https:' ? https : http).request(u, { method: 'POST', headers, lookup: safeLookup, timeout: 10_000 }, (res) => {
      let got = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (got.length < 4000) got += c; });
      res.on('end', () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        resolve({ ok, status: res.statusCode, info: `HTTP ${res.statusCode}${got.trim() ? ` · ${got.replace(/\s+/g, ' ').trim().slice(0, 300)}` : ''}` });
      });
      res.on('error', (e) => resolve({ ok: false, info: e.message }));
    });
    req.on('timeout', () => req.destroy(new Error('no answer within 10 seconds')));
    req.on('error', (e) => resolve({ ok: false, info: e.message }));
    req.end(body);
  });
}
async function send(teamId, payload) {
  const team = getTeam(teamId);
  if (!team?.row.hook_url) return { ok: false, info: 'No webhook configured.' };
  const out = await post(team, payload);
  db.prepare('UPDATE teams SET hook_last_at=?, hook_last_ok=?, hook_last_info=? WHERE id=?').run(new Date().toISOString(), out.ok ? 1 : 0, String(out.info).slice(0, 400), teamId);
  if (!out.ok) console.warn(`webhook of team ${team.key}: ${out.info}`);
  return out;
}

const HOWTO = `Connect to the Specs MCP server (${PUBLIC_URL}/mcp) and call get_work_list: it lists what is left to do. Report with report_implementation when you are done.`;
export async function testHook(teamId) {
  const team = getTeam(teamId);
  if (!team?.row.hook_url) throw new TeamError('Save a webhook URL first');
  const out = await send(teamId, {
    event: 'test', team: { id: team.id, key: team.key, name: team.name }, released: [], answered: [], mcpUrl: `${PUBLIC_URL}/mcp`,
    text: `Connection test from Specs for the team "${team.name}". Nothing was released and there is nothing to implement: check that you can reach the Specs MCP server (${PUBLIC_URL}/mcp) by calling get_work_list, answer in one line whether that worked, and stop.`,
  });
  return { ...out, hook: publicHook(getTeam(teamId)) };
}

// ---- releases and answers are collected per team (table hook_outbox) and sent as one call after a quiet period.
// A failed delivery stays in the table and is retried after 30 s, 2 min, 10 min, 1 h; then it is dropped (the work list is what counts).
const timers = new Map();
const attempts = new Map();
const RETRY_MS = [30_000, 120_000, 600_000, 3_600_000];
function arm(teamId, delay) {
  clearTimeout(timers.get(teamId));
  const t = setTimeout(() => flush(teamId).catch((e) => console.error('webhook:', e.message)), delay);
  t.unref?.();
  timers.set(teamId, t);
}
function queue(teamId, kind, key, entry) {
  const team = getTeam(teamId);
  if (!team?.row.hook_url || !String(team.row.hook_events).split(',').includes(kind)) return;
  db.prepare('INSERT OR REPLACE INTO hook_outbox (team_id,kind,key,entry,created_at) VALUES (?,?,?,?,?)').run(teamId, kind, key, JSON.stringify(entry), new Date().toISOString());
  arm(teamId, HOOK_DEBOUNCE_MS);
}
async function flush(teamId) {
  timers.delete(teamId);
  const rows = db.prepare('SELECT kind,key,entry FROM hook_outbox WHERE team_id=? ORDER BY created_at').all(teamId);
  const team = getTeam(teamId);
  if (!rows.length) return;
  if (!team?.row.hook_url) { db.prepare('DELETE FROM hook_outbox WHERE team_id=?').run(teamId); return; }
  const released = rows.filter((r) => r.kind === 'release').map((r) => JSON.parse(r.entry));
  const answered = rows.filter((r) => r.kind === 'answer').map((r) => JSON.parse(r.entry));
  const lines = [`Update from Specs for the team "${team.name}".`];
  if (released.length) lines.push('', 'Released (approved by a person):', ...released.map((r) => `- ${r.id} v${r.version}: ${r.title}${r.by ? ` (approved by ${r.by})` : ''}`));
  if (answered.length) lines.push('', 'Decisions answered:', ...answered.map((a) => `- ${a.spec_id}: "${a.question}" → ${a.answer ?? 'see note'}${a.note ? ` (note: ${a.note})` : ''}`));
  lines.push('', HOWTO);
  const out = await send(teamId, {
    event: released.length && answered.length ? 'release+answer' : released.length ? 'release' : 'answer',
    team: { id: team.id, key: team.key, name: team.name }, released, answered, mcpUrl: `${PUBLIC_URL}/mcp`, text: lines.join('\n'),
  });
  // remove only what was sent; entries that arrived meanwhile stay for the next call
  const del = db.prepare('DELETE FROM hook_outbox WHERE team_id=? AND kind=? AND key=? AND entry=?');
  if (out.ok) { for (const r of rows) del.run(teamId, r.kind, r.key, r.entry); attempts.delete(teamId); return; }
  const n = attempts.get(teamId) ?? 0;
  if (n < RETRY_MS.length) { attempts.set(teamId, n + 1); arm(teamId, RETRY_MS[n]); }
  else { for (const r of rows) del.run(teamId, r.kind, r.key, r.entry); attempts.delete(teamId); console.warn(`webhook of team ${team.key}: giving up after ${n + 1} attempts`); }
}
/** At startup: deliver what was still waiting when the server stopped. */
export function resumeHooks() {
  for (const { team_id } of db.prepare('SELECT DISTINCT team_id FROM hook_outbox').all()) arm(team_id, 3000);
}

export function initHooks() {
  events.on('released', (e) => queue(e.teamId, 'release', e.id, { id: e.id, version: e.version, title: e.title, by: e.by }));
  events.on('answered', ({ teamId, decision: d, by }) => queue(teamId, 'answer', d.id, {
    id: d.id, spec_id: d.specId, question: d.text.slice(0, 300), answer: d.answer >= 0 ? d.options[d.answer]?.label ?? null : null, note: d.reply || undefined, by,
  }));
}
