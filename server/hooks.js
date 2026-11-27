// One webhook per team: tells an agent runner (e.g. a Claude Code routine) that specs were released or decisions answered.
import http from 'node:http';
import https from 'node:https';
import { createHmac } from 'node:crypto';
import { db } from './db.js';
import { events } from './store.js';
import { getTeam, TeamError, remoteOrigin } from './teams.js';
import { encrypt, decrypt } from './secrets.js';
import { HOOK_DEBOUNCE_MS, HOOK_ALLOW_LOCAL, PUBLIC_URL } from './config.js';
import { makeSafeLookup, isPrivateHostLiteral } from './netguard.js';
import { listChecks } from './checks.js';

// release: a person approved a spec · answer: a person answered a decision · check: CI reported a failing check, or a check went stale
// resume: a person resumed paused agents · review: a person sent an implementation back
export const HOOK_EVENTS = ['release', 'answer', 'review', 'check', 'resume'];
export const HOOK_FORMATS = ['full', 'text'];

// ---- never call into the server's own network (SSRF): private, loopback, link-local and metadata ranges are refused (see netguard.js)
const safeLookup = makeSafeLookup(HOOK_ALLOW_LOCAL);

export function validateHookUrl(url) {
  url = String(url ?? '').trim();
  if (!url) return '';
  if (url.length > 500) throw new TeamError('The webhook URL is too long');
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new TeamError('Enter a full webhook URL (https://…)');
  }
  if (u.username || u.password) throw new TeamError('Put credentials into the token or a header, not into the URL');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && HOOK_ALLOW_LOCAL))
    throw new TeamError('The webhook URL must start with https://');
  if (!HOOK_ALLOW_LOCAL && isPrivateHostLiteral(u.hostname))
    throw new TeamError('Webhooks to local or private addresses are disabled on this server (HOOK_ALLOW_LOCAL)');
  return u.toString();
}

const FORBIDDEN = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'content-type',
  'upgrade',
  'expect',
  'te',
  'trailer',
]);
/** "Name: value" per line → { name: value } */
function parseHeaders(text) {
  const out = {};
  for (const line of String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)) {
    const i = line.indexOf(':');
    const name = i > 0 ? line.slice(0, i).trim() : '';
    const value = i > 0 ? line.slice(i + 1).trim() : '';
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || !value)
      throw new TeamError(`Headers are written as "Name: value" – check "${line.slice(0, 40)}"`);
    if (FORBIDDEN.has(name.toLowerCase())) throw new TeamError(`The header ${name} is set by the server`);
    if (value.length > 2000 || /[^\x20-\x7e]/.test(value))
      throw new TeamError(`The value of ${name} contains characters that are not allowed`);
    out[name] = value;
  }
  if (Object.keys(out).length > 10) throw new TeamError('At most 10 extra headers');
  return out;
}
const storedHeaders = (row) => {
  try {
    return row.hook_headers ? JSON.parse(decrypt(row.hook_headers)) : {};
  } catch {
    return {};
  }
};

export const publicHook = (team) => {
  const r = team.row;
  return {
    url: r.hook_url ?? '',
    hasToken: !!r.hook_secret,
    headerNames: Object.keys(storedHeaders(r)),
    events: String(r.hook_events ?? '')
      .split(',')
      .filter(Boolean),
    format: r.hook_format,
    debounceSeconds: Math.round(HOOK_DEBOUNCE_MS / 1000),
    allowLocal: HOOK_ALLOW_LOCAL,
    lastAt: r.hook_last_at,
    lastOk: r.hook_last_ok === null ? null : !!r.hook_last_ok,
    lastInfo: r.hook_last_info,
    lastUrl: /https:\/\/claude\.ai\/[A-Za-z0-9_\-/?=&.%]+/.exec(r.hook_last_info ?? '')?.[0] ?? null,
  };
};

/** Fields that are left out stay as they are; token: '' keeps the stored one, clearToken removes it. */
export function saveHook(teamId, s = {}) {
  const t = getTeam(teamId);
  const r = t.row;
  const url = s.url === undefined ? (r.hook_url ?? '') : validateHookUrl(s.url);
  let secret = r.hook_secret;
  if (s.token) {
    const tok = String(s.token).trim();
    if (tok.length > 2000 || /[^\x21-\x7e]/.test(tok)) throw new TeamError('The token contains characters that are not allowed');
    secret = encrypt(tok);
  }
  // A stored token and the extra headers belong to the receiver they were entered for: a different server does not get them.
  const otherServer = s.url !== undefined && !!url && !!r.hook_url && remoteOrigin(url) !== remoteOrigin(r.hook_url);
  if (otherServer && !s.token) secret = null;
  if (s.clearToken || !url) secret = null;
  let headers = otherServer && s.headers === undefined ? null : r.hook_headers;
  if (s.headers !== undefined) {
    const h = parseHeaders(s.headers);
    headers = Object.keys(h).length ? encrypt(JSON.stringify(h)) : null;
  }
  if (!url) headers = null;
  let ev = r.hook_events;
  if (s.events !== undefined) {
    if (!Array.isArray(s.events) || s.events.some((e) => !HOOK_EVENTS.includes(e)))
      throw new TeamError(`events: any of ${HOOK_EVENTS.join(', ')}`);
    ev = [...new Set(s.events)].join(',');
  }
  const format = s.format === undefined ? r.hook_format : s.format;
  if (!HOOK_FORMATS.includes(format)) throw new TeamError(`format: ${HOOK_FORMATS.join(' or ')}`);
  db.prepare('UPDATE teams SET hook_url=?, hook_secret=?, hook_headers=?, hook_events=?, hook_format=? WHERE id=?').run(
    url || null,
    secret,
    headers,
    ev,
    format,
    teamId,
  );
  if ((url || null) !== (r.hook_url ?? null))
    db.prepare('UPDATE teams SET hook_last_at=NULL, hook_last_ok=NULL, hook_last_info=NULL WHERE id=?').run(teamId);
  return getTeam(teamId);
}

function post(team, payload) {
  const r = team.row;
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(validateHookUrl(r.hook_url));
    } catch (e) {
      return resolve({ ok: false, info: e.message });
    }
    const body = JSON.stringify(r.hook_format === 'text' ? { text: payload.text } : payload);
    const headers = {
      ...storedHeaders(r),
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'User-Agent': 'specs-webhook',
    };
    try {
      if (r.hook_secret) {
        // bearer token, plus an HMAC over timestamp and body so the receiver can verify integrity and reject replays
        const token = decrypt(r.hook_secret);
        const ts = String(Math.floor(Date.now() / 1000));
        headers.Authorization = `Bearer ${token}`;
        headers['X-Specs-Timestamp'] = ts;
        headers['X-Specs-Signature'] = `sha256=${createHmac('sha256', token).update(`${ts}.${body}`).digest('hex')}`;
      }
    } catch {
      return resolve({ ok: false, info: 'The stored token cannot be read – enter it again.' });
    }
    const req = (u.protocol === 'https:' ? https : http).request(
      u,
      { method: 'POST', headers, lookup: safeLookup, timeout: 10_000 },
      (res) => {
        let got = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          if (got.length < 4000) got += c;
        });
        res.on('end', () => {
          const ok = res.statusCode >= 200 && res.statusCode < 300;
          resolve({
            ok,
            status: res.statusCode,
            info: `HTTP ${res.statusCode}${got.trim() ? ` · ${got.replace(/\s+/g, ' ').trim().slice(0, 300)}` : ''}`,
          });
        });
        res.on('error', (e) => resolve({ ok: false, info: e.message }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('no answer within 10 seconds')));
    req.on('error', (e) => resolve({ ok: false, info: e.message }));
    req.end(body);
  });
}
async function send(teamId, payload) {
  const team = getTeam(teamId);
  if (!team?.row.hook_url) return { ok: false, info: 'No webhook configured.' };
  const out = await post(team, payload);
  db.prepare('UPDATE teams SET hook_last_at=?, hook_last_ok=?, hook_last_info=? WHERE id=?').run(
    new Date().toISOString(),
    out.ok ? 1 : 0,
    String(out.info).slice(0, 400),
    teamId,
  );
  if (!out.ok) console.warn(`webhook of team ${team.key}: ${out.info}`);
  return out;
}

const HOWTO = `Connect to the Specs MCP server (${PUBLIC_URL}/mcp) and call get_work_list: it lists what is left to do. Report with report_implementation when you are done.`;
export async function testHook(teamId) {
  const team = getTeam(teamId);
  if (!team?.row.hook_url) throw new TeamError('Save a webhook URL first');
  const out = await send(teamId, {
    event: 'test',
    team: { id: team.id, key: team.key, name: team.name },
    released: [],
    answered: [],
    mcpUrl: `${PUBLIC_URL}/mcp`,
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
  if (!team?.row.hook_url || team.row.agent_paused || !String(team.row.hook_events).split(',').includes(kind)) return;
  db.prepare('INSERT OR REPLACE INTO hook_outbox (team_id,kind,key,entry,created_at) VALUES (?,?,?,?,?)').run(
    teamId,
    kind,
    key,
    JSON.stringify(entry),
    new Date().toISOString(),
  );
  arm(teamId, HOOK_DEBOUNCE_MS);
}
async function flush(teamId) {
  timers.delete(teamId);
  const rows = db.prepare('SELECT kind,key,entry FROM hook_outbox WHERE team_id=? ORDER BY created_at').all(teamId);
  const team = getTeam(teamId);
  if (!rows.length) return;
  if (!team?.row.hook_url) {
    db.prepare('DELETE FROM hook_outbox WHERE team_id=?').run(teamId);
    return;
  }
  const released = rows.filter((r) => r.kind === 'release').map((r) => JSON.parse(r.entry));
  const answered = rows.filter((r) => r.kind === 'answer').map((r) => JSON.parse(r.entry));
  const checks = rows.filter((r) => r.kind === 'check').map((r) => JSON.parse(r.entry));
  const returned = rows.filter((r) => r.kind === 'review').map((r) => JSON.parse(r.entry));
  const resumed = rows.some((r) => r.kind === 'resume');
  // Names, titles and notes are written by people (or other agents): one line each, shortened – they are data, not instructions.
  const one = (x, n = 200) =>
    String(x ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, n);
  const lines = [`Update from Specs for the team "${one(team.name, 80)}".`];
  if (released.length)
    lines.push(
      '',
      'Released (approved by a person):',
      ...released.map((r) => `- ${one(r.id, 40)} v${r.version}: ${one(r.title)}${r.by ? ` (approved by ${one(r.by, 80)})` : ''}`),
    );
  if (answered.length)
    lines.push(
      '',
      'Decisions answered:',
      ...answered.map(
        (a) =>
          `- ${one(a.spec_id, 40)}: "${one(a.question, 300)}" → ${one(a.answer, 120) || 'see note'}${a.note ? ` (note: ${one(a.note, 300)})` : ''}`,
      ),
    );
  if (returned.length)
    lines.push(
      '',
      'Sent back after review (a person wants changes):',
      ...returned.map((x) => `- ${one(x.spec_id, 40)} v${x.version}: ${one(x.note, 300)}${x.by ? ` (${one(x.by, 80)})` : ''}`),
    );
  if (checks.length)
    lines.push(
      '',
      'Checks to look at:',
      ...checks.map(
        (c) =>
          `- ${one(c.spec_id, 40)} "${one(c.name, 80)}": ${c.state === 'failing' ? `failing${c.source === 'ci' ? ' in CI' : ''}${c.value ? ` (${one(c.value, 120)})` : ''}` : 'stale – run it again'}`,
      ),
    );
  if (resumed) lines.push('', 'A person resumed the agents of this team after a pause: pick up everything that is open.');
  lines.push('', HOWTO);
  const out = await send(teamId, {
    event: [
      released.length && 'release',
      answered.length && 'answer',
      returned.length && 'review',
      checks.length && 'check',
      resumed && 'resume',
    ]
      .filter(Boolean)
      .join('+'),
    team: { id: team.id, key: team.key, name: team.name },
    released,
    answered,
    returned,
    checks,
    resumed,
    mcpUrl: `${PUBLIC_URL}/mcp`,
    text: lines.join('\n'),
  });
  // remove only what was sent; entries that arrived meanwhile stay for the next call
  const del = db.prepare('DELETE FROM hook_outbox WHERE team_id=? AND kind=? AND key=? AND entry=?');
  if (out.ok) {
    for (const r of rows) del.run(teamId, r.kind, r.key, r.entry);
    attempts.delete(teamId);
    return;
  }
  const n = attempts.get(teamId) ?? 0;
  if (n < RETRY_MS.length) {
    attempts.set(teamId, n + 1);
    arm(teamId, RETRY_MS[n]);
  } else {
    for (const r of rows) del.run(teamId, r.kind, r.key, r.entry);
    attempts.delete(teamId);
    console.warn(`webhook of team ${team.key}: giving up after ${n + 1} attempts`);
  }
}
/** At startup: deliver what was still waiting when the server stopped. */
export function resumeHooks() {
  for (const { team_id } of db.prepare('SELECT DISTINCT team_id FROM hook_outbox').all()) arm(team_id, 3000);
}

/** Checks that went stale since the last look: each stale run is announced once. */
export function sweepStaleChecks(teamId = null) {
  for (const t of db
    .prepare("SELECT id FROM teams WHERE hook_url IS NOT NULL AND agent_paused=0 AND (',' || hook_events || ',') LIKE '%,check,%'")
    .all()) {
    if (teamId && t.id !== teamId) continue;
    for (const c of listChecks(t.id)) {
      if (c.state !== 'stale' || !c.last || c.outcome) continue;
      const run = db.prepare('SELECT id FROM check_runs WHERE check_id=? ORDER BY at DESC, rowid DESC LIMIT 1').get(c.id);
      const row = db.prepare('SELECT stale_notified FROM checks WHERE id=?').get(c.id);
      if (!run || row?.stale_notified === run.id) continue;
      db.prepare('UPDATE checks SET stale_notified=? WHERE id=?').run(run.id, c.id);
      queue(t.id, 'check', `${c.specId}|${c.name}`, { spec_id: c.specId, name: c.name, state: 'stale' });
    }
  }
}

export function initHooks() {
  // failing results from a pipeline: the agent did not run them itself, so it does not know yet
  events.on('check', ({ teamId, check: c, source }) => {
    if (c.state === 'failing' && source === 'ci' && !c.outcome)
      queue(teamId, 'check', `${c.specId}|${c.name}`, { spec_id: c.specId, name: c.name, state: 'failing', source, value: c.last?.value });
  });
  // new guardrails: agents check what they built against them (the work list says which specs); the garden shows the drift
  events.on('guardrails', ({ teamId, rules, by }) => {
    db.prepare('UPDATE teams SET garden_rev = garden_rev + 1 WHERE id=?').run(teamId);
    queue(teamId, 'release', 'guardrails', {
      id: 'guardrails',
      rules,
      title: 'Guardrails (check built specs against new rules)',
      by,
    });
  });
  // an implementation sent back: the agent has to work on it again (the work list says what the person wrote)
  events.on('reviewed', ({ teamId, specId, version, review }) => {
    if (review?.verdict === 'returned')
      queue(teamId, 'review', specId, { spec_id: specId, version, note: review.note, criteria: review.criteria, by: review.by });
  });
  events.on('resumed', ({ teamId }) => queue(teamId, 'resume', 'resume', { at: new Date().toISOString() }));
  const sweep = setInterval(() => {
    try {
      sweepStaleChecks();
    } catch (e) {
      console.error('stale checks:', e.message);
    }
  }, 3600_000);
  sweep.unref?.();
  // a release makes the passing results of the older version stale at once – no need to wait for the hourly look
  events.on('released', (e) =>
    setImmediate(() => {
      try {
        sweepStaleChecks(e.teamId);
      } catch (err) {
        console.error('stale checks:', err.message);
      }
    }),
  );
  events.on('released', (e) => queue(e.teamId, 'release', e.id, { id: e.id, version: e.version, title: e.title, by: e.by }));
  events.on('answered', ({ teamId, decision: d, by }) =>
    queue(teamId, 'answer', d.id, {
      id: d.id,
      spec_id: d.specId,
      question: d.text.slice(0, 300),
      answer: d.answer >= 0 ? (d.options[d.answer]?.label ?? null) : null,
      note: d.reply || undefined,
      by,
    }),
  );
}
