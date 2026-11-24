// Sharing between teams (docs/SHARED-SPECS.md).
//
// Teams form a TREE (teams.parent_id). A child team inherits the foundation of its ancestors – vision, strategy, other foundation
// documents, guardrails and glossary – pinned to one foundation version per ancestor (foundation_pins). Every change of a team's
// released foundation is a new foundation version (foundation_versions keeps the released files). An approver of the child moves
// the pin; a rule marked `required_by` in a parent applies to the child after that date even without the update (forced_rules).
//
// On top of the tree any team can SHARE released documents, folders and specs with other teams (shares, share_teams). The
// receiving team accepts once, then links them as @KEY/path@vN. Every released state of a shared item is kept as a version
// (shared_versions), so a link keeps working after the owner changes, revokes or stops sharing the item. A spec can say it
// IMPLEMENTS a spec of another team (items.implements); the owner sees the reports of the implementing teams rolled up.
// Only released content crosses a team boundary. Drafts never do.
import { createHash, randomUUID } from 'node:crypto';
import { sql, db } from './db.js';
import * as store from './store.js';
import { ApiError } from './store.js';
import { getTeam, getTeamByKey, listTeams } from './teams.js';
import { rulesOf, isRulePath, parseRuleFile, isGuardrailsPath } from '../shared/guardrailFiles.js';
import { isTermPath, parseTermFile, isGlossaryPath, termPath, formatTermFile } from '../shared/glossaryFiles.js';
import { hasContent } from '../shared/glossary.js';
import { specCriteria } from '../shared/criteria.js';
import { audit } from './audit.js';

export const MAX_DEPTH = 4; // levels in the tree, the root included
const iso = () => new Date().toISOString();
const hash = (s) => createHash('sha256').update(s).digest('hex');
const json = (s, fallback) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};
const brief = (t) => t && { id: t.id, key: t.key, name: t.name };

/** Everything the app shows about sharing changes with this counter (instance-wide; the client asks again when it moved). */
export const sharingRev = () => sql('SELECT rev FROM sharing_state WHERE id=1').get()?.rev ?? 0;
export const bump = () => sql('UPDATE sharing_state SET rev = rev + 1 WHERE id=1').run();

// ------------------------------------------------------------------ references
// @KEY/path@v4 – a document or folder of team KEY, version 4. @KEY/SPEC-12@v3 – a spec. Without @vN: the version the team pinned, or the newest.
const REF = /^@([A-Za-z][A-Za-z0-9]{1,7})\/(.+?)(?:@v(\d+))?$/;
/** @returns {{ key: string, id: string, version: number|null }|null} */
export function parseRef(ref) {
  const m = REF.exec(String(ref ?? '').trim());
  return m ? { key: m[1].toUpperCase(), id: m[2], version: m[3] ? Number(m[3]) : null } : null;
}
export const isSharedRef = (s) => String(s ?? '').startsWith('@');
export const formatRef = (key, id, version) => `@${key}/${id}${version ? `@v${version}` : ''}`;
/** Within one team: "SPEC-007@2" -> { id, version }. */
const LOCAL_IMPL = /^([A-Za-z0-9][A-Za-z0-9_-]{0,39})(?:@v?(\d+))?$/;

// ------------------------------------------------------------------ the team tree
const row = (id) => sql('SELECT id, key, name, parent_id, foundation_version FROM teams WHERE id=?').get(id);
/** Parent first, root last. */
export function ancestors(teamId) {
  const out = [];
  const seen = new Set([teamId]);
  let r = row(teamId);
  while (r?.parent_id && !seen.has(r.parent_id) && out.length < MAX_DEPTH + 2) {
    seen.add(r.parent_id);
    r = row(r.parent_id);
    if (r) out.push(r);
  }
  return out;
}
export const children = (teamId) => sql('SELECT id, key, name, parent_id FROM teams WHERE parent_id=? ORDER BY name').all(teamId);
export function descendants(teamId) {
  const out = [];
  const walk = (id, depth) => {
    if (depth > MAX_DEPTH + 1) return;
    for (const c of children(id)) {
      out.push(c);
      walk(c.id, depth + 1);
    }
  };
  walk(teamId, 1);
  return out;
}
/** Levels below a team, the team itself counting as one. */
const height = (teamId) => {
  const kids = children(teamId);
  return 1 + (kids.length ? Math.max(...kids.map((k) => height(k.id))) : 0);
};

function checkLink(parentId, childId) {
  if (parentId === childId) throw new ApiError('A team cannot be its own parent.');
  if (descendants(childId).some((d) => d.id === parentId))
    throw new ApiError('That would make a circle: the parent team is below this team.');
  const levels = ancestors(parentId).length + 1 + height(childId);
  if (levels > MAX_DEPTH) throw new ApiError(`The tree may have ${MAX_DEPTH} levels at most.`);
  if (row(childId)?.parent_id) throw new ApiError('This team has a parent team already. Unlink it first.', 409);
}

/** The parent team's admin asks to become the parent of a child team. The child team's admin accepts. */
export function requestLink(parent, childKey, user) {
  const child = getTeamByKey(String(childKey ?? '').toUpperCase());
  if (!child) throw new ApiError(`No team "${childKey}".`, 404);
  checkLink(parent.id, child.id);
  sql('INSERT OR REPLACE INTO team_links (parent_id, child_id, requested_by, created_at) VALUES (?,?,?,?)').run(
    parent.id,
    child.id,
    user?.name ?? null,
    iso(),
  );
  bump();
  return brief(child);
}
export const pendingLinks = (teamId) => ({
  incoming: sql('SELECT l.*, t.key, t.name FROM team_links l JOIN teams t ON t.id = l.parent_id WHERE l.child_id=? ORDER BY l.created_at')
    .all(teamId)
    .map((r) => ({ team: { id: r.parent_id, key: r.key, name: r.name }, requestedBy: r.requested_by, at: r.created_at })),
  outgoing: sql('SELECT l.*, t.key, t.name FROM team_links l JOIN teams t ON t.id = l.child_id WHERE l.parent_id=? ORDER BY l.created_at')
    .all(teamId)
    .map((r) => ({ team: { id: r.child_id, key: r.key, name: r.name }, requestedBy: r.requested_by, at: r.created_at })),
});
export function cancelLink(parentId, childId) {
  sql('DELETE FROM team_links WHERE parent_id=? AND child_id=?').run(parentId, childId);
  bump();
}

/** Makes `parentId` the parent of `child`. The child and every team below it pin the current foundation of their new ancestors. */
export async function link(parentId, child, user) {
  checkLink(parentId, child.id);
  const parent = getTeam(parentId);
  // a parent that never recorded a foundation version (an older instance) gets one now, so there is something to pin
  for (const a of [parent, ...ancestors(parentId).map((r) => getTeam(r.id))]) if (a) await snapshotFoundation(a, user);
  db.exec('BEGIN IMMEDIATE');
  try {
    sql('UPDATE teams SET parent_id=? WHERE id=?').run(parentId, child.id);
    sql('DELETE FROM team_links WHERE child_id=?').run(child.id);
    for (const t of [row(child.id), ...descendants(child.id)])
      for (const a of ancestors(t.id))
        sql('INSERT OR IGNORE INTO foundation_pins (team_id, ancestor_id, version, accepted_by, accepted_at) VALUES (?,?,?,?,?)').run(
          t.id,
          a.id,
          a.foundation_version,
          user?.name ?? null,
          iso(),
        );
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  bump();
  store.events.emit('guardrails', { teamId: child.id, rules: [], by: user?.name ?? null, inherited: true });
  return getTeam(child.id);
}
export async function acceptLink(child, parentId, user) {
  if (!sql('SELECT 1 FROM team_links WHERE parent_id=? AND child_id=?').get(parentId, child.id))
    throw new ApiError('There is no such request (it may have been withdrawn).', 404);
  return link(parentId, child, user);
}

/** Ends the parent link. The team and the teams below it no longer inherit anything from the old ancestors. */
export function unlink(teamId) {
  const old = ancestors(teamId).map((a) => a.id);
  if (!old.length) return;
  sql('UPDATE teams SET parent_id=NULL WHERE id=?').run(teamId);
  for (const t of [{ id: teamId }, ...descendants(teamId)]) {
    for (const a of old) {
      sql('DELETE FROM foundation_pins WHERE team_id=? AND ancestor_id=?').run(t.id, a);
      sql('DELETE FROM forced_rules WHERE team_id=? AND ancestor_id=?').run(t.id, a);
    }
  }
  bump();
  store.events.emit('guardrails', { teamId, rules: [], by: null, inherited: true });
}

/** Before a team is deleted: its child teams move up to its parent (or become roots); nothing cascades. */
export function beforeDeleteTeam(teamId) {
  const parent = row(teamId)?.parent_id ?? null;
  for (const c of children(teamId)) {
    sql('UPDATE teams SET parent_id=? WHERE id=?').run(parent, c.id);
    for (const t of [c, ...descendants(c.id)]) sql('DELETE FROM foundation_pins WHERE team_id=? AND ancestor_id=?').run(t.id, teamId);
  }
  sql('DELETE FROM team_links WHERE parent_id=? OR child_id=?').run(teamId, teamId);
  sql('DELETE FROM foundation_pins WHERE team_id=? OR ancestor_id=?').run(teamId, teamId);
  sql('DELETE FROM forced_rules WHERE team_id=? OR ancestor_id=?').run(teamId, teamId);
  for (const t of ['shares', 'share_teams', 'shared_versions', 'foundation_versions']) sql(`DELETE FROM ${t} WHERE team_id=?`).run(teamId);
  sql('DELETE FROM share_teams WHERE to_team_id=?').run(teamId);
  bump();
}

// ------------------------------------------------------------------ foundation versions
/** The released foundation of a team as it is in its repository right now: [{ id, body }] (proposals and empty documents left out). */
async function releasedFoundation(team) {
  const out = [];
  for (const d of store.pinnedDocs(team.id).filter((x) => x.status === 'approved')) {
    try {
      const body = await store.readReleasedDoc(team, d.id);
      if (hasContent(body)) out.push({ id: d.id, body });
    } catch {
      /* not in the repository (yet) */
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
const lastFoundation = (teamId) => sql('SELECT * FROM foundation_versions WHERE team_id=? ORDER BY version DESC LIMIT 1').get(teamId);
export const foundationFiles = (teamId, version) =>
  version ? json(sql('SELECT files FROM foundation_versions WHERE team_id=? AND version=?').get(teamId, version)?.files, []) : [];
const queues = new Map();
/** Serialises work per team (two commits close together must not both write version n+1). */
const serial = (key, fn) => {
  const p = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  queues.set(
    key,
    p.catch(() => {}),
  );
  return p;
};
/** Records a new foundation version when the released foundation differs from the last one. Returns the current version. */
export function snapshotFoundation(team, by = null) {
  return serial(`f:${team.id}`, async () => {
    const files = await releasedFoundation(team);
    const h = hash(JSON.stringify(files));
    const last = lastFoundation(team.id);
    if (last?.hash === h) return last.version;
    if (!last && !files.length) return 0;
    const version = (last?.version ?? 0) + 1;
    sql('INSERT INTO foundation_versions (team_id, version, files, hash, at, by) VALUES (?,?,?,?,?,?)').run(
      team.id,
      version,
      JSON.stringify(files),
      h,
      iso(),
      by?.name ?? null,
    );
    sql('UPDATE teams SET foundation_version=? WHERE id=?').run(version, team.id);
    bump();
    if (descendants(team.id).length) applyRequiredRules();
    return version;
  });
}

/** The rules, terms and documents of a set of foundation files. */
function partsOf(files) {
  const rules = rulesOf(files.filter((f) => isRulePath(f.id)));
  const terms = files
    .filter((f) => isTermPath(f.id))
    .map((f) => ({ id: f.id, ...parseTermFile(f.body) }))
    .filter((t) => t.term);
  const docs = files.filter((f) => !isGuardrailsPath(f.id) && !isGlossaryPath(f.id));
  const notes = files.filter((f) => isGuardrailsPath(f.id) && !(isRulePath(f.id) && parseRuleFile(f.body)));
  return { rules, terms, docs: [...docs, ...notes] };
}

/** What changed between two foundation versions of a team: [{ id, change: added|changed|removed, before?, after? }]. */
export function foundationDiff(teamId, from, to) {
  const a = new Map(foundationFiles(teamId, from).map((f) => [f.id, f.body]));
  const b = new Map(foundationFiles(teamId, to).map((f) => [f.id, f.body]));
  const out = [];
  for (const [id, body] of b) {
    if (!a.has(id)) out.push({ id, change: 'added', after: body });
    else if (a.get(id) !== body) out.push({ id, change: 'changed', before: a.get(id), after: body });
  }
  for (const [id, body] of a) if (!b.has(id)) out.push({ id, change: 'removed', before: body });
  return out.sort((x, y) => x.id.localeCompare(y.id));
}

const pinOf = (teamId, ancestorId) => sql('SELECT * FROM foundation_pins WHERE team_id=? AND ancestor_id=?').get(teamId, ancestorId);

/**
 * What a team inherits, nearest ancestor first: [{ team, pinned, newest, files, rules, terms, docs, forced, update }].
 * `rules` already contain rules applied after their required-by date (`forced`); `update` describes a newer foundation version.
 */
export function inherited(teamId) {
  return ancestors(teamId).map((a) => {
    const pin = pinOf(teamId, a.id);
    const pinned = pin?.version ?? 0;
    const files = foundationFiles(a.id, pinned);
    const parts = partsOf(files);
    const forced = sql('SELECT * FROM forced_rules WHERE team_id=? AND ancestor_id=?').all(teamId, a.id);
    /** @type {any[]} */
    let rules = parts.rules;
    for (const f of forced) {
      const r = rulesOf(foundationFiles(a.id, f.version).filter((x) => isRulePath(x.id))).find((x) => x.id === f.rule_id);
      if (r) rules = [...rules.filter((x) => x.id !== r.id), { ...r, forced: true, forcedAt: f.applied_at }];
    }
    const newest = a.foundation_version;
    const update =
      newest > pinned
        ? {
            version: newest,
            at: sql('SELECT at FROM foundation_versions WHERE team_id=? AND version=?').get(a.id, newest)?.at ?? null,
            since: sql('SELECT at FROM foundation_versions WHERE team_id=? AND version=?').get(a.id, pinned + 1)?.at ?? null,
            changes: foundationDiff(a.id, pinned, newest).map(({ id, change }) => ({ id, change })),
            required: rulesOf(foundationFiles(a.id, newest).filter((x) => isRulePath(x.id)))
              .filter((r) => r.requiredBy)
              .filter((r) => {
                const now = rules.find((x) => x.id === r.id);
                return !now || now.text !== r.text || now.kind !== r.kind;
              })
              .map((r) => ({ id: r.id, text: r.text, requiredBy: r.requiredBy })),
          }
        : null;
    return {
      team: brief(a),
      pinned,
      newest,
      acceptedBy: pin?.accepted_by ?? null,
      acceptedAt: pin?.accepted_at ?? null,
      files,
      rules: rules.map((r) => ({ ...r, ref: `${a.key}/${r.id}`, team: a.key })),
      terms: parts.terms.map((t) => ({ ...t, team: a.key })),
      docs: parts.docs.map((d) => ({ ...d, team: a.key })),
      forced: forced.map((f) => f.rule_id),
      update,
    };
  });
}

/** An approver of the child accepts a newer foundation version of an ancestor: from now on the team builds against it. */
export function acceptFoundation(team, ancestorId, version, user) {
  const a = ancestors(team.id).find((x) => x.id === ancestorId);
  if (!a) throw new ApiError('That team is not a parent team of this team.', 404);
  const v = Number(version) || a.foundation_version;
  if (v > a.foundation_version || v < 1) throw new ApiError(`${a.key} has no foundation version v${v}.`);
  const before = inherited(team.id).find((x) => x.team.id === ancestorId)?.rules ?? [];
  sql(
    'INSERT INTO foundation_pins (team_id, ancestor_id, version, accepted_by, accepted_at) VALUES (?,?,?,?,?) ON CONFLICT(team_id, ancestor_id) DO UPDATE SET version=excluded.version, accepted_by=excluded.accepted_by, accepted_at=excluded.accepted_at',
  ).run(team.id, ancestorId, v, user?.name ?? null, iso());
  // a forced rule is part of the accepted version now (or was dropped by it)
  sql('DELETE FROM forced_rules WHERE team_id=? AND ancestor_id=? AND version<=?').run(team.id, ancestorId, v);
  bump();
  const after = inherited(team.id).find((x) => x.team.id === ancestorId)?.rules ?? [];
  const changed = after.filter((r) => !before.some((b) => b.id === r.id && b.text === r.text && b.kind === r.kind));
  if (changed.length)
    store.events.emit('guardrails', { teamId: team.id, rules: changed.map((r) => r.ref), by: user?.name ?? null, inherited: true });
  return inherited(team.id).find((x) => x.team.id === ancestorId);
}

/** Rules a parent marked "required by <date>" apply to child teams once the date has passed – only those rules. Runs hourly and after foundation releases. */
export function applyRequiredRules(today = iso().slice(0, 10)) {
  for (const t of sql('SELECT id FROM teams WHERE parent_id IS NOT NULL').all()) {
    for (const anc of inherited(t.id)) {
      if (!anc.update) continue;
      for (const r of anc.update.required.filter((x) => x.requiredBy <= today)) {
        if (
          sql('SELECT 1 FROM forced_rules WHERE team_id=? AND ancestor_id=? AND rule_id=? AND version=?').get(
            t.id,
            anc.team.id,
            r.id,
            anc.newest,
          )
        )
          continue;
        sql(
          'INSERT INTO forced_rules (team_id, ancestor_id, rule_id, version, applied_at) VALUES (?,?,?,?,?) ON CONFLICT(team_id, ancestor_id, rule_id) DO UPDATE SET version=excluded.version, applied_at=excluded.applied_at',
        ).run(t.id, anc.team.id, r.id, anc.newest, iso());
        audit(null, 'foundation.rule.required', {
          team: t.id,
          target: `${anc.team.key}/${r.id}`,
          detail: { requiredBy: r.requiredBy, version: anc.newest },
          actor: 'system',
        });
        bump();
        store.events.emit('guardrails', { teamId: t.id, rules: [`${anc.team.key}/${r.id}`], by: null, inherited: true });
      }
    }
  }
}

/** All rules a team's agents follow: the ancestors' (root first, ids KEY/Gn) and then the team's own. */
export async function effectiveRules(team) {
  const own = await store.releasedRules(team).catch(() => []);
  const up = inherited(team.id)
    .reverse()
    .flatMap((a) => a.rules.map((r) => ({ ...r, id: r.ref, team: a.team.key, inherited: true })));
  return [...up, ...own];
}

/**
 * The glossary a team's agents see: its own entries, then the ancestors' terms (nearest first) that no nearer team defines.
 * A shadowed term still passes on its words to avoid. Every entry says where it comes from (`team`).
 */
export function mergedGlossary(team, own) {
  const seen = new Map(own.map((e) => [e.term.toLowerCase(), e]));
  const out = own.map((e) => ({ ...e, team: team.key }));
  for (const a of inherited(team.id)) {
    for (const t of a.terms) {
      const k = t.term.toLowerCase();
      const near = seen.get(k);
      if (near) {
        const avoid = [...new Set([...(near.avoid ?? []), ...(t.avoid ?? [])])];
        near.avoid = avoid;
        const o = out.find((x) => x.term.toLowerCase() === k);
        if (o) o.avoid = avoid;
        if (o && o.team === team.key) o.shadows = [...(o.shadows ?? []), a.team.key];
        continue;
      }
      const e = {
        term: t.term,
        definition: t.body,
        aliases: t.aliases ?? [],
        see: t.see ?? [],
        avoid: t.avoid ?? [],
        distinct: t.distinct ?? [],
        refs: t.refs ?? [],
        source: `@${a.team.key}/${t.id}`,
        team: a.team.key,
      };
      seen.set(k, e);
      out.push(e);
    }
  }
  return out;
}

// ------------------------------------------------------------------ shares
const shareRow = (teamId, itemId) => sql('SELECT * FROM shares WHERE team_id=? AND item_id=?').get(teamId, itemId);
/** The teams a share reaches: [{ id, key, name, accepted, declined }]. */
function recipients(s) {
  const named = sql(
    'SELECT st.*, t.key, t.name FROM share_teams st JOIN teams t ON t.id = st.to_team_id WHERE st.team_id=? AND st.item_id=?',
  ).all(s.team_id, s.item_id);
  const list =
    s.audience === 'children'
      ? children(s.team_id)
      : s.audience === 'descendants'
        ? descendants(s.team_id)
        : named.map((n) => ({ id: n.to_team_id, key: n.key, name: n.name }));
  return list.map((t) => {
    const n = named.find((x) => x.to_team_id === t.id);
    return {
      id: t.id,
      key: t.key,
      name: t.name,
      accepted: !!n?.accepted_at,
      declined: n?.accepted_by === 'declined' && !n?.accepted_at,
      acceptedBy: n?.accepted_at ? n.accepted_by : null,
    };
  });
}

/** An approver of the owning team shares a document, a folder (everything below it) or a spec. */
export async function share(team, itemId, { audience = 'teams', teams = [] } = {}, user = null) {
  const item = store.getItem(team.id, itemId);
  if (!item) throw new ApiError(`No item "${itemId}".`, 404);
  if (item.kind === 'doc' && (isGlossaryPath(itemId) || isGuardrailsPath(itemId)))
    throw new ApiError('Glossary terms and guardrails reach other teams through the team tree (parent and child teams).');
  if (!['children', 'descendants', 'teams'].includes(audience)) throw new ApiError('audience must be children, descendants or teams');
  const to = [];
  if (audience === 'teams') {
    for (const k of [...new Set((teams ?? []).map((x) => String(x).toUpperCase()))]) {
      const t = getTeamByKey(k);
      if (!t) throw new ApiError(`No team "${k}".`, 404);
      if (t.id === team.id) continue;
      to.push(t);
    }
    if (!to.length) throw new ApiError('Name at least one team to share with.');
  }
  sql(
    'INSERT INTO shares (team_id, item_id, kind, audience, created_by, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(team_id, item_id) DO UPDATE SET audience=excluded.audience',
  ).run(team.id, itemId, item.kind, audience, user?.name ?? null, iso());
  if (audience === 'teams') {
    const keep = new Set(to.map((t) => t.id));
    for (const r of sql('SELECT to_team_id FROM share_teams WHERE team_id=? AND item_id=?').all(team.id, itemId))
      if (!keep.has(r.to_team_id))
        sql('DELETE FROM share_teams WHERE team_id=? AND item_id=? AND to_team_id=?').run(team.id, itemId, r.to_team_id);
    for (const t of to) sql('INSERT OR IGNORE INTO share_teams (team_id, item_id, to_team_id) VALUES (?,?,?)').run(team.id, itemId, t.id);
  }
  await snapshotShares(team, user);
  bump();
  return shareView(team, shareRow(team.id, itemId));
}
/** The owner stops sharing. Released specs of other teams that link a version keep reading that version. */
export function unshare(team, itemId) {
  sql('DELETE FROM shares WHERE team_id=? AND item_id=?').run(team.id, itemId);
  sql('DELETE FROM share_teams WHERE team_id=? AND item_id=?').run(team.id, itemId);
  bump();
}
/** The receiving team accepts (or ends) a share. */
export function answerShare(receiver, owner, itemId, accept, user) {
  const s = shareRow(owner.id, itemId);
  if (!s || !recipients(s).some((r) => r.id === receiver.id)) throw new ApiError('This was not shared with your team.', 404);
  sql(
    'INSERT INTO share_teams (team_id, item_id, to_team_id, accepted_by, accepted_at) VALUES (?,?,?,?,?) ON CONFLICT(team_id, item_id, to_team_id) DO UPDATE SET accepted_by=excluded.accepted_by, accepted_at=excluded.accepted_at',
  ).run(owner.id, itemId, receiver.id, accept ? (user?.name ?? 'someone') : 'declined', accept ? iso() : null);
  // a named team that ends a share leaves the list
  if (!accept && s.audience === 'teams')
    sql('DELETE FROM share_teams WHERE team_id=? AND item_id=? AND to_team_id=?').run(owner.id, itemId, receiver.id);
  bump();
}

/** Items a share covers right now (a folder: every document below it). */
function coveredItems(s) {
  if (s.kind !== 'folder') {
    const i = store.getItem(s.team_id, s.item_id);
    return i ? [i] : [];
  }
  return store.allDocs(s.team_id, { body: false }).filter((d) => d.id.startsWith(`${s.item_id}/`));
}
const covers = (s, itemId) => (s.kind === 'folder' ? itemId.startsWith(`${s.item_id}/`) : s.item_id === itemId);

/** Records a version of every shared item whose released content changed (specs: the released version; documents: a counter). */
export function snapshotShares(team, by = null) {
  return serial(`s:${team.id}`, async () => {
    const shares = sql('SELECT * FROM shares WHERE team_id=?').all(team.id);
    if (!shares.length) return;
    const done = new Set();
    for (const s of shares) {
      for (const it of coveredItems(s)) {
        if (done.has(it.id)) continue;
        done.add(it.id);
        let body = null;
        let version = 0;
        const last = sql('SELECT * FROM shared_versions WHERE team_id=? AND item_id=? ORDER BY version DESC LIMIT 1').get(team.id, it.id);
        try {
          if (it.kind === 'spec') {
            if (it.status !== 'approved' || !it.version) continue;
            if (last?.version === it.version) continue;
            body = await store.readReleasedSpec(team, it.id, it.version);
            version = it.version;
          } else if (it.kind === 'doc') {
            if (!(await store.isReleasedDoc(team, it.id))) continue;
            body = await store.readReleasedDoc(team, it.id);
            if (last?.body === body) continue;
            version = (last?.version ?? 0) + 1;
          } else continue;
        } catch {
          continue;
        }
        sql('INSERT OR IGNORE INTO shared_versions (team_id, item_id, version, kind, title, body, at, by) VALUES (?,?,?,?,?,?,?,?)').run(
          team.id,
          it.id,
          version,
          it.kind,
          it.kind === 'spec' ? it.title : it.id,
          body,
          iso(),
          it.releasedBy ?? by?.name ?? null,
        );
        bump();
      }
    }
  });
}
const versionsOf = (ownerId, itemId) =>
  sql('SELECT version, kind, title, at, by FROM shared_versions WHERE team_id=? AND item_id=? ORDER BY version DESC').all(ownerId, itemId);
const versionRow = (ownerId, itemId, version) =>
  version
    ? sql('SELECT * FROM shared_versions WHERE team_id=? AND item_id=? AND version=?').get(ownerId, itemId, version)
    : sql('SELECT * FROM shared_versions WHERE team_id=? AND item_id=? ORDER BY version DESC LIMIT 1').get(ownerId, itemId);

/** Shares of `owner` that `receiver` has accepted and that cover `itemId`. */
const acceptedShare = (owner, receiverId, itemId) =>
  sql('SELECT * FROM shares WHERE team_id=?')
    .all(owner.id)
    .find((s) => covers(s, itemId) && recipients(s).some((r) => r.id === receiverId && r.accepted));

/** Versions of an item of another team that a team links in its own specs: { '@KEY/id': [4, …] } (released specs only unless `drafts`). */
export function linkedVersions(teamId, { drafts = false } = {}) {
  const out = {};
  for (const s of store.allSpecs(teamId, { body: false })) {
    if (!drafts && s.status !== 'approved') continue;
    // released only: the links of the released version – an unreleased edit must not grant access to anything
    const links = drafts ? s.links : (s.releasedLinks ?? []);
    for (const l of [...links, ...(s.implements ? [s.implements] : [])]) {
      const r = parseRef(l);
      if (!r?.version) continue;
      const k = `@${r.key}/${r.id}`;
      out[k] = [...new Set([...(out[k] ?? []), r.version])];
    }
  }
  return out;
}

/**
 * A shared item as `team` may read it: the given version, else the version the team's released specs link (the newest of them),
 * else the newest. Access needs an accepted share – or a released spec of the team that links exactly that version (a share that
 * ended or a revoked item keeps serving the pinned version). Throws when the team may not read it.
 */
/** @param {any} team @param {any} ref @param {{ version?: number }} [opts] */
export function resolveRef(team, ref, { version } = {}) {
  const r = typeof ref === 'string' ? parseRef(ref) : ref;
  if (!r) throw new ApiError(`"${ref}" is not a reference to another team (use @KEY/path or @KEY/SPEC-ID).`);
  const owner = getTeamByKey(r.key);
  if (!owner) throw new ApiError(`No team "${r.key}".`, 404);
  if (owner.id === team.id) throw new ApiError(`${ref} belongs to your own team: link it without the @${r.key}/ prefix.`);
  const share = acceptedShare(owner, team.id, r.id);
  const pins = linkedVersions(team.id)[`@${owner.key}/${r.id}`] ?? [];
  const want = Number(version) || r.version || (pins.length ? Math.max(...pins) : null);
  if (!share && !(want && pins.includes(want)))
    throw new ApiError(`${owner.key} has not shared "${r.id}" with your team (or your team has not accepted it yet).`, 403);
  const v = versionRow(owner.id, r.id, want);
  if (!v)
    throw new ApiError(
      want ? `${owner.key}/${r.id} has no released version v${want}.` : `${owner.key}/${r.id} has no released version yet.`,
      404,
    );
  const newest = versionRow(owner.id, r.id, null);
  const item = store.getItem(owner.id, r.id);
  return {
    owner: brief(owner),
    id: r.id,
    kind: v.kind,
    title: v.title,
    version: v.version,
    newest: newest?.version ?? v.version,
    pinned: pins,
    body: v.body,
    at: v.at,
    by: v.by,
    ref: formatRef(owner.key, r.id, v.version),
    shared: !!share,
    revoked: !share || !item || (item.kind === 'spec' && item.status !== 'approved'),
  };
}
/** Checks every @link of a spec before it is released. Returns the links with a version (the newest when none was given). */
export function validateLinks(team, links) {
  return links.map((l) => {
    if (!isSharedRef(l)) return l;
    const r = resolveRef(team, l);
    return r.ref;
  });
}

/** Links an edit adds to an item: each @KEY/… link must be readable by the team now (an accepted share or a released pin). */
export function checkNewLinks(team, links, before = []) {
  const had = new Set(before);
  for (const l of links ?? []) if (isSharedRef(l) && !had.has(l)) resolveRef(team, l);
}

/** Everything other teams shared with `team`, accepted or waiting: [{ owner, itemId, kind, accepted, items: [...] }]. */
export function sharedWith(team) {
  const out = [];
  for (const s of sql('SELECT * FROM shares WHERE team_id<>?').all(team.id)) {
    const me = recipients(s).find((r) => r.id === team.id);
    if (!me || me.declined) continue;
    const owner = getTeam(s.team_id);
    const items = me.accepted
      ? coveredItems(s)
          .map((i) => {
            const vs = versionsOf(owner.id, i.id);
            return vs.length ? { id: i.id, kind: vs[0].kind, title: vs[0].title, newest: vs[0].version, versions: vs } : null;
          })
          .filter(Boolean)
      : [];
    out.push({
      owner: brief(owner),
      itemId: s.item_id,
      kind: s.kind,
      audience: s.audience,
      accepted: me.accepted,
      by: s.created_by,
      at: s.created_at,
      items,
    });
  }
  return out;
}

/** Released specs anywhere that link a version of `owner`'s item: [{ team, specId, title, version }] (never drafts). */
export function usedBy(owner, itemId) {
  const needle = `@${owner.key}/${itemId}@v`;
  return sql(
    "SELECT team_id, id, title, links, implements FROM items WHERE kind='spec' AND deleted=0 AND status='approved' AND team_id<>? AND (instr(links, ?) > 0 OR instr(COALESCE(implements,''), ?) > 0)",
  )
    .all(owner.id, needle, needle)
    .flatMap((r) => {
      const t = getTeam(r.team_id);
      return [...json(r.links, []), ...(r.implements ? [r.implements] : [])]
        .map(parseRef)
        .filter((x) => x && x.key === owner.key && x.id === itemId && x.version)
        .map((x) => ({
          team: brief(t),
          specId: r.id,
          title: r.title,
          version: x.version,
          implements: r.implements?.startsWith(needle) ?? false,
        }));
    });
}
function shareView(team, s) {
  const items = coveredItems(s).map((i) => ({ id: i.id, kind: i.kind, newest: versionRow(team.id, i.id, null)?.version ?? 0 }));
  return {
    itemId: s.item_id,
    kind: s.kind,
    audience: s.audience,
    by: s.created_by,
    at: s.created_at,
    teams: recipients(s),
    items,
    usedBy: items.flatMap((i) => usedBy(team, i.id).map((u) => ({ ...u, itemId: i.id, newest: i.newest }))),
  };
}
export const myShares = (team) =>
  sql('SELECT * FROM shares WHERE team_id=? ORDER BY item_id')
    .all(team.id)
    .map((s) => shareView(team, s));

// ------------------------------------------------------------------ implements
/** "@PLAT/SPEC-012@v3" | "SPEC-007@2" | "" -> normalised value for items.implements, checked against what the team may read. */
export function normaliseImplements(team, value) {
  const v = String(value ?? '').trim();
  if (!v) return null;
  if (isSharedRef(v)) return resolveRef(team, v).ref;
  const m = LOCAL_IMPL.exec(v);
  if (!m) throw new ApiError(`implements: "${v}" is neither a spec of your team (SPEC-007) nor of another team (@KEY/SPEC-ID).`);
  const s = store.getItem(team.id, m[1]);
  if (!s || s.kind !== 'spec') throw new ApiError(`implements: your team has no spec "${m[1]}".`);
  return `${s.id}@v${m[2] ? Number(m[2]) : s.version || 0}`;
}
/** Criterion references inside an implementing spec: "… (→ @PLAT/SPEC-012#AC4)" or "→ AC4". */
const MAP = /(?:→|->)\s*(?:@([A-Za-z][A-Za-z0-9]{1,7})\/([A-Za-z0-9][A-Za-z0-9_-]{0,39}))?#?((?:R|AC)\d+)\b/g;
export function criteriaMapping(md) {
  const out = [];
  for (const c of specCriteria(md)) {
    for (const m of c.text.matchAll(MAP))
      out.push({ from: c.id, text: c.text, key: m[1]?.toUpperCase() ?? null, spec: m[2] ?? null, to: m[3] });
  }
  return out;
}

/**
 * The implementing specs of `owner`'s spec, in any team: [{ team, specId, title, version, implementedVersion, report, criteria }].
 * `criteria` maps the owner's criteria to the implementing criteria and their reported state. `done` is true when every
 * implementing spec reports "implemented" against the owner's current version.
 */
export async function implementedBy(owner, specId, latestReportsOf) {
  const spec = store.getItem(owner.id, specId);
  const rows = sql(
    "SELECT team_id, id, title, version, implements FROM items WHERE kind='spec' AND deleted=0 AND status='approved' AND implements IS NOT NULL",
  )
    .all()
    .filter((r) => {
      if (r.team_id === owner.id) return LOCAL_IMPL.exec(r.implements)?.[1] === specId;
      const p = parseRef(r.implements);
      return p?.key === owner.key && p.id === specId;
    });
  const out = [];
  for (const r of rows) {
    const t = getTeam(r.team_id);
    const implVersion = r.team_id === owner.id ? Number(LOCAL_IMPL.exec(r.implements)?.[2] ?? 0) : parseRef(r.implements)?.version;
    const rep = latestReportsOf(r.team_id)[r.id] ?? null;
    let mapping = [];
    try {
      mapping = criteriaMapping(await store.readReleasedSpec(t, r.id, r.version)).filter(
        (m) => !m.key || (m.key === owner.key && (!m.spec || m.spec === specId)),
      );
    } catch {
      /* no released file */
    }
    out.push({
      team: brief(t),
      specId: r.id,
      title: r.title,
      version: r.version,
      implementedVersion: implVersion ?? null,
      current: !!spec && implVersion === spec.version,
      report: rep && { status: rep.status, specVersion: rep.specVersion, createdAt: rep.createdAt, author: rep.author },
      criteria: mapping.map((m) => ({
        owner: m.to,
        own: m.from,
        status: rep?.criteria?.find((c) => c.id === m.from)?.status ?? 'open',
      })),
    });
  }
  return {
    rows: out,
    done: out.length > 0 && out.every((r) => r.current && r.report?.status === 'implemented' && r.report.specVersion === r.version),
  };
}

// ------------------------------------------------------------------ adopt
/** Copies a shared item (or an inherited foundation document) into the team as its own draft; `origin` remembers where it came from. */
/** @param {any} team @param {string} ref @param {{ as?: string }} [opts] @param {any} [user] */
export function adopt(team, ref, { as } = {}, user = null) {
  const r = resolveRef(team, ref);
  const id = String(as ?? '').trim() || (r.kind === 'spec' ? store.nextSpecId(team) : r.id);
  if (store.getItem(team.id, id)) throw new ApiError(`Your team has "${id}" already. Choose another name.`, 409);
  const origin = `${r.owner.key}/${r.id}@${r.version}`;
  let item;
  if (r.kind === 'spec') {
    const md = r.body.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^\s*# .*\n+/, '');
    item = store.saveItem(team.id, { id, kind: 'spec', title: r.title, body: md.trim(), links: [], origin }, 0, user);
  } else {
    ensureFolders(team.id, id);
    item = store.saveItem(team.id, { id, kind: 'doc', title: id, body: r.body, links: [], origin }, 0, user);
  }
  bump();
  return item;
}
/** Copies an inherited foundation document into the team (before unlinking, or to change it locally). */
export function adoptInherited(team, ancestorKey, fileId, user = null) {
  const a = inherited(team.id).find((x) => x.team.key === String(ancestorKey).toUpperCase());
  if (!a) throw new ApiError(`${ancestorKey} is not a parent team of yours.`, 404);
  const f = a.files.find((x) => x.id === fileId);
  if (!f) throw new ApiError(`${a.team.key} foundation v${a.pinned} has no "${fileId}".`, 404);
  let id = fileId;
  if (store.isCoreDoc(fileId) || store.getItem(team.id, id)) id = fileId.replace(/(\.[a-z]+)$/i, `-${a.team.key.toLowerCase()}$1`);
  if (isRulePath(id)) {
    // the rule gets an id of this team when it is saved
    const body = f.body.replace(/^id:.*\n/m, '');
    ensureFolders(team.id, id);
    return store.saveItem(team.id, { id, kind: 'doc', title: id, body, links: [], origin: `${a.team.key}/${fileId}@${a.pinned}` }, 0, user);
  }
  ensureFolders(team.id, id);
  return store.saveItem(
    team.id,
    { id, kind: 'doc', title: id, body: f.body, links: [], origin: `${a.team.key}/${fileId}@${a.pinned}` },
    0,
    user,
  );
}
function ensureFolders(teamId, path) {
  const parts = path.split('/').slice(0, -1);
  parts.forEach((_, i) => {
    const id = parts.slice(0, i + 1).join('/');
    if (!store.getItem(teamId, id)) store.saveItem(teamId, { id, kind: 'folder' }, 0);
  });
}

/** The instance-wide glossary becomes the glossary of a team (usually the root of the tree): one term file per global term. */
export function globalGlossaryToTeam(team, terms, user = null) {
  ensureFolders(team.id, 'glossary/company/x.md');
  let n = 0;
  const taken = (p) => !!store.getItem(team.id, p);
  for (const g of terms) {
    if (store.allDocs(team.id).some((d) => isTermPath(d.id) && parseTermFile(d.body)?.term?.toLowerCase() === g.term.toLowerCase()))
      continue;
    const id = termPath('company', g.term, taken);
    store.saveItem(
      team.id,
      { id, kind: 'doc', title: id, body: formatTermFile({ term: g.term, body: g.definition, aliases: g.aliases, see: g.see }), links: [] },
      0,
      user,
    );
    n++;
  }
  return n;
}

// ------------------------------------------------------------------ what the app shows
/** One payload for the app: tree, inheritance, shares in both directions, implementing specs and the teams one can share with. */
export async function sharingView(team, latestReportsOf) {
  const me = row(team.id);
  const impl = {};
  // only specs some released spec says it implements (one query, instead of one per spec)
  const targets = new Set(
    sql("SELECT team_id, implements FROM items WHERE kind='spec' AND deleted=0 AND status='approved' AND implements IS NOT NULL")
      .all()
      .map((r) =>
        r.team_id === team.id
          ? LOCAL_IMPL.exec(r.implements)?.[1]
          : parseRef(r.implements)?.key === team.key
            ? parseRef(r.implements)?.id
            : null,
      )
      .filter(Boolean),
  );
  for (const id of targets) {
    const r = await implementedBy(team, id, latestReportsOf);
    if (r.rows.length) impl[id] = r;
  }
  return {
    rev: sharingRev(),
    parent: me?.parent_id ? brief(row(me.parent_id)) : null,
    ancestors: ancestors(team.id).map(brief),
    children: children(team.id).map(brief),
    links: pendingLinks(team.id),
    foundationVersion: me?.foundation_version ?? 0,
    inherited: inherited(team.id).map(({ files, ...rest }) => ({ ...rest, files: files.map((f) => ({ id: f.id, body: f.body })) })),
    shares: myShares(team),
    sharedWith: sharedWith(team),
    implementedBy: impl,
    teams: listTeams()
      .filter((t) => t.id !== team.id)
      .map((t) => brief(t)),
  };
}

export const newId = () => randomUUID();

/** Keeps foundation versions and shared versions in step with the team's repository. */
export function startSharing() {
  store.setLinkValidator((team, links) => validateLinks(team, links));
  store.setImplementsValidator((team, v) => normaliseImplements(team, v));
  store.events.on('committed', (teamId) => {
    const team = getTeam(teamId);
    if (!team) return;
    snapshotFoundation(team).catch((e) => console.error('foundation version', team.key, e.message));
    snapshotShares(team).catch((e) => console.error('shared versions', team.key, e.message));
  });
}
/** Hourly: drop foundation versions nobody pins any more (the newest 20 always stay), apply required rules whose date has come. */
export function sweepSharing() {
  for (const t of sql('SELECT DISTINCT team_id FROM foundation_versions').all()) {
    const min = sql('SELECT MIN(version) AS v FROM foundation_pins WHERE ancestor_id=?').get(t.team_id)?.v;
    const keepFrom = sql('SELECT version FROM foundation_versions WHERE team_id=? ORDER BY version DESC LIMIT 1 OFFSET 19').get(
      t.team_id,
    )?.version;
    if (!keepFrom) continue;
    const forced = sql('SELECT MIN(version) AS v FROM forced_rules WHERE ancestor_id=?').get(t.team_id)?.v;
    const cut = Math.min(keepFrom, min ?? keepFrom, forced ?? keepFrom);
    sql('DELETE FROM foundation_versions WHERE team_id=? AND version<?').run(t.team_id, cut);
  }
  applyRequiredRules();
}
