// Who works on what: the last MCP call of every agent, and claims (leases) on specs.
import { sql } from './db.js';
import * as store from './store.js';
import { ApiError } from './store.js';
import { bumpGarden } from './feedback.js';

export const CLAIM_DEFAULT_MIN = 30;
export const CLAIM_MAX_MIN = 240;
/** An agent counts as connected when its last call is this recent. */
export const ACTIVE_MS = 15 * 60_000;

const iso = (ms = Date.now()) => new Date(ms).toISOString();

/** The identity of an MCP connection: one per user, kind of access and client/token name. */
export function agentOf(auth, user) {
  const via = auth.extra.via === 'pat' ? 'pat' : 'oauth';
  const label = String(auth.extra.label ?? 'MCP client');
  return {
    key: `${user.id}|${via}|${label}`.slice(0, 200),
    name: `${via === 'pat' ? 'token' : 'agent'}: ${label}`.slice(0, 80),
    userName: user.name,
    tokenExpiresAt: via === 'pat' ? (auth.extra.tokenExpiresAt ?? null) : null,
  };
}

/** Called for every MCP request. The garden only changes (and is re-sent to devices) when an agent shows up, or comes back after a pause. */
export function recordActivity(teamId, agent, tool) {
  const cur = sql('SELECT last_at FROM agent_activity WHERE team_id=? AND agent=?').get(teamId, agent.key);
  const now = iso();
  sql(`INSERT INTO agent_activity (team_id,agent,name,user_name,last_at,last_tool,calls,token_expires_at) VALUES (?,?,?,?,?,?,1,?)
    ON CONFLICT (team_id, agent) DO UPDATE SET name=excluded.name, user_name=excluded.user_name, last_at=excluded.last_at,
      last_tool=COALESCE(excluded.last_tool, last_tool), calls=calls+1, token_expires_at=excluded.token_expires_at`).run(
    teamId,
    agent.key,
    agent.name,
    agent.userName,
    now,
    tool ?? null,
    agent.tokenExpiresAt,
  );
  if (!cur || Date.now() - Date.parse(cur.last_at) > 5 * 60_000) bumpGarden(teamId);
}

const claimView = (r) => ({
  specId: r.spec_id,
  agent: r.agent,
  by: r.name,
  note: r.note || undefined,
  claimedAt: r.claimed_at,
  heartbeatAt: r.heartbeat_at,
  until: r.expires_at,
});
const live = (teamId) => sql('SELECT * FROM claims WHERE team_id=? AND expires_at>?').all(teamId, iso());

/** { SPEC-1: claim } of the claims that have not run out. */
export function activeClaims(teamId) {
  return Object.fromEntries(live(teamId).map((r) => [r.spec_id, claimView(r)]));
}

/** Claim a released spec, or renew the own claim (a heartbeat). Another agent's live claim is refused. */
/** @param {any} team @param {any} agent @param {{ specId: string, minutes?: number, note?: string }} claim */
export function claimSpec(team, agent, { specId, minutes, note }) {
  const spec = store.getItem(team.id, specId);
  if (!spec || spec.kind !== 'spec' || spec.version < 1) throw new ApiError(`No released spec "${specId}".`, 404);
  const m = minutes === undefined || minutes === null ? CLAIM_DEFAULT_MIN : Number(minutes);
  if (!Number.isInteger(m) || m < 5 || m > CLAIM_MAX_MIN) throw new ApiError(`minutes must be between 5 and ${CLAIM_MAX_MIN}.`);
  const cur = sql('SELECT * FROM claims WHERE team_id=? AND spec_id=?').get(team.id, specId);
  const now = Date.now();
  if (cur && cur.agent !== agent.key && Date.parse(cur.expires_at) > now) {
    throw new ApiError(
      `${specId} is being built by ${cur.name} until ${cur.expires_at} (unless it renews its claim). Work on another spec.`,
      409,
    );
  }
  const mine = cur && cur.agent === agent.key && Date.parse(cur.expires_at) > now;
  sql(`INSERT INTO claims (team_id,spec_id,agent,name,note,claimed_at,heartbeat_at,expires_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT (team_id, spec_id) DO UPDATE SET agent=excluded.agent, name=excluded.name, note=excluded.note, claimed_at=excluded.claimed_at, heartbeat_at=excluded.heartbeat_at, expires_at=excluded.expires_at`).run(
    team.id,
    specId,
    agent.key,
    agent.name,
    String(note ?? '')
      .trim()
      .slice(0, 300),
    mine ? cur.claimed_at : iso(now),
    iso(now),
    iso(now + m * 60_000),
  );
  bumpGarden(team.id);
  return { ...claimView(sql('SELECT * FROM claims WHERE team_id=? AND spec_id=?').get(team.id, specId)), renewed: !!mine };
}

/** Give a claim back (the agent finished, or stops). Only the own claim. Returns whether there was one. */
export function releaseClaim(teamId, agent, specId) {
  const r = sql('DELETE FROM claims WHERE team_id=? AND spec_id=? AND agent=?').run(teamId, specId, agent.key);
  if (r.changes) bumpGarden(teamId);
  return r.changes > 0;
}

/** Every agent the team has seen, newest first, with what it is building right now. */
export function listAgents(teamId) {
  const claims = live(teamId).map(claimView);
  const now = Date.now();
  return sql('SELECT * FROM agent_activity WHERE team_id=? ORDER BY last_at DESC LIMIT 30')
    .all(teamId)
    .map((r) => ({
      agent: r.agent,
      name: r.name,
      user: r.user_name,
      lastAt: r.last_at,
      lastTool: r.last_tool || undefined,
      calls: r.calls,
      connected: now - Date.parse(r.last_at) < ACTIVE_MS,
      ...(r.token_expires_at ? { tokenExpiresAt: iso(r.token_expires_at * 1000) } : {}),
      claims: claims.filter((c) => c.agent === r.agent).map((c) => ({ specId: c.specId, until: c.until, note: c.note })),
    }));
}
