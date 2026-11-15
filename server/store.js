import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DATA_DIR } from './config.js';
import { sql } from './db.js';
import { Repo } from './git.js';
import { parseDefinitions, glossaryMarkdown, hasContent } from '../shared/glossary.js';
import { parseTermFile, isTermPath, isProposedPath, isGlossaryPath, splitGlossaryMd, formatTermFile, termPath, folderSegment } from '../shared/glossaryFiles.js';
import { getTeam, listTeams } from './teams.js';
import { isKnownType } from './specTypes.js';
import { DEFAULT_TYPE } from '../shared/spectypes.js';
import { FOUNDATION_DEBOUNCE_MS } from './config.js';

export const events = new EventEmitter();

// one Git repository per team: DATA_DIR/repos/<team id>
const repos = new Map();
export const repoFor = (team) => {
  if (!repos.has(team.id)) repos.set(team.id, new Repo(path.join(DATA_DIR, 'repos', team.id)));
  return repos.get(team.id);
};

export const SPEC_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
/** Documents may live in folders: adr/ADR-007.md, schemas/billing.yaml (max. 8 levels, no ".."; a leading _ marks app folders such as glossary/_proposed) */
export const FOLDER_ID = /^(?!.*\.\.)(?=.{1,100}$)[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*){0,7}$/;
/** Documents every team has: always present, always available to agents once they contain something. */
export const CORE_DOCS = {
  'vision.md': '# Vision\n\n## Where are we heading?\n\n## Why does it matter?\n',
  'strategy.md': '# Strategy\n\n## Goals\n\n## Principles and trade-offs\n\n## Out of scope\n',
  'guardrails.md': '# Guardrails\n\n<!-- Rules every agent follows on every task, unasked. One rule per line, e.g. "- G1: …". When a task would break a rule, the agent stops and asks. -->\n\n## Always\n\n## Never\n',
};
export const isCoreDoc = (id) => id in CORE_DOCS;
export const hasContentDoc = (d) => hasContent(d.body);
export const DOC_ID = /^(?!.*\.\.)(?=.{3,120}$)[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*){0,7}\.(?:md|yaml|yml|json|txt)$/;
/** A live glossary term: a Markdown file under glossary/ (not _proposed/) whose front matter names the term. Term files are foundation documents. */
export const isTermDoc = (id, body) => isTermPath(id) && !!parseTermFile(body);

export class ApiError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const toItem = (r) =>
  r && {
    id: r.id, kind: r.kind, title: r.title, body: r.body, links: JSON.parse(r.links), pinned: !!r.pinned, specType: r.spec_type, updatedVia: r.updated_via, core: r.kind === 'doc' && isCoreDoc(r.id), rev: r.rev, status: r.status,
    version: r.version, releasedRev: r.released_rev, releasedAt: r.released_at, releasedBy: r.released_by,
    updatedBy: r.updated_by, fetchedAt: r.fetched_at, createdAt: r.created_at, updatedAt: r.updated_at, deleted: !!r.deleted,
  };

const nextSeq = (t) => sql('SELECT COALESCE(MAX(seq),0)+1 AS n FROM items WHERE team_id=?').get(t).n;
export const maxSeq = (t) => sql('SELECT COALESCE(MAX(seq),0) AS n FROM items WHERE team_id=?').get(t).n;
export const count = (t) => sql('SELECT COUNT(*) AS n FROM items WHERE team_id=? AND deleted=0').get(t).n;
const rawItem = (t, id) => toItem(sql('SELECT * FROM items WHERE team_id=? AND id=?').get(t, id));
/** live item or undefined (tombstones are invisible here) */
export const getItem = (t, id) => { const i = rawItem(t, id); return i && !i.deleted ? i : undefined; };
/** Everything changed after `seq`, including tombstones so clients can drop deleted items. */
export const itemsSince = (t, seq) =>
  sql('SELECT * FROM items WHERE team_id=? AND seq>? ORDER BY seq').all(t, seq).map(toItem)
    .map((i) => (i.deleted ? { id: i.id, kind: i.kind, deleted: true, rev: i.rev } : i));
// every column but the body: for lists that only need the metadata (items without `body`)
const META = 'id,kind,title,links,pinned,spec_type,updated_via,rev,status,version,released_rev,released_at,released_by,updated_by,fetched_at,created_at,updated_at,deleted';
const live = (t, kind, body) => sql(`SELECT ${body ? '*' : META} FROM items WHERE team_id=? AND kind=? AND deleted=0 ORDER BY id`).all(t, kind).map(toItem);
/** Live items of a kind. `{ body: false }` leaves the bodies out. */
export const allSpecs = (t, { body = true } = {}) => live(t, 'spec', body);
export const allDocs = (t, { body = true } = {}) => live(t, 'doc', body);
export const allFolders = (t) => live(t, 'folder', false);
/** Foundation documents, without bodies (getItem has the body). */
export const pinnedDocs = (t) => sql(`SELECT ${META} FROM items WHERE team_id=? AND kind='doc' AND deleted=0 AND pinned=1 ORDER BY id`).all(t).map(toItem);
/** Released specs, without bodies (agents read the released text from Git; getItem has the working copy). */
export const approvedSpecs = (t) => sql(`SELECT ${META} FROM items WHERE team_id=? AND kind='spec' AND deleted=0 AND status='approved' ORDER BY id`).all(t).map(toItem);
/** Released version of every live spec: { id: version }. */
export const currentVersions = (t) => new Map(sql("SELECT id, version FROM items WHERE team_id=? AND kind='spec' AND deleted=0").all(t).map((r) => [r.id, r.version]));

/**
 * An agent read a spec. This is not an edit: the item keeps its place in the sync sequence (which would send its whole body
 * to every device again). Devices ask for the reads since the newest fetched_at they know instead (fetchedSince), so fetched_at
 * is kept strictly increasing per team.
 */
export function touchFetched(t, id) {
  const last = sql('SELECT MAX(fetched_at) AS at FROM items WHERE team_id=?').get(t).at;
  const at = new Date(Math.max(Date.now(), last ? Date.parse(last) + 1 : 0)).toISOString();
  sql('UPDATE items SET fetched_at=? WHERE team_id=? AND id=?').run(at, t, id);
}
/** { id: fetched_at } of the items read by an agent after `since` (an ISO time; '' = all). */
export const fetchedSince = (t, since) =>
  Object.fromEntries(sql('SELECT id, fetched_at FROM items WHERE team_id=? AND fetched_at>? ORDER BY fetched_at').all(t, String(since)).map((r) => [r.id, r.fetched_at]));
export const lastFetched = (t) => sql('SELECT MAX(fetched_at) AS at FROM items WHERE team_id=?').get(t).at ?? '';

/** Create or update an item. `baseRev` must equal the current revision (0 = create). */
export function saveItem(t, { id, kind, title, body, links, pinned, specType }, baseRev, by = null) {
  if (specType !== undefined && kind === 'spec' && !isKnownType(t, specType)) throw new ApiError(`unknown spec type: ${specType}`);
  const st = kind === 'spec' ? specType : undefined;
  const now = new Date().toISOString();
  const cur = rawItem(t, id);
  const who = by?.name ?? null;
  const termBody = body ?? cur?.body ?? '';
  const pin = kind !== 'doc' ? 0 : isCoreDoc(id) || isTermDoc(id, termBody) ? 1 : isProposedPath(id) ? 0 : pinned === undefined ? undefined : pinned ? 1 : 0;
  if (!cur || cur.deleted) {
    if (kind === 'spec' && !SPEC_ID.test(id)) throw new ApiError(`invalid spec id: ${id}`);
    if (kind === 'doc' && !DOC_ID.test(id)) throw new ApiError(`invalid document path: ${id}`);
    if (kind === 'folder' && !FOLDER_ID.test(id)) throw new ApiError(`invalid folder path: ${id}`);
    if (kind === 'folder' && rawItem(t, id)?.kind === 'doc') throw new ApiError(`${id} is a document`);
    if (cur?.deleted) {
      sql("UPDATE items SET updated_via=?, spec_type=?, kind=?, title=?, body=?, links=?, pinned=?, deleted=0, rev=rev+1, seq=?, status='draft', released_rev=0, released_at=NULL, released_by=NULL, updated_at=?, updated_by=? WHERE team_id=? AND id=?")
        .run(by?.via ?? null, st ?? DEFAULT_TYPE, kind, title ?? '', body ?? '', JSON.stringify(links ?? []), pin ?? 0, nextSeq(t), now, who, t, id);
    } else {
      sql('INSERT INTO items (team_id,id,kind,title,body,links,pinned,spec_type,rev,seq,created_at,updated_at,updated_by,updated_via) VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?,?)')
        .run(t, id, kind, title ?? '', body ?? '', JSON.stringify(links ?? []), pin ?? 0, st ?? DEFAULT_TYPE, nextSeq(t), now, now, who, by?.via ?? null);
    }
  } else {
    if (cur.rev !== baseRev) throw new ApiError('conflict', 409);
    sql('UPDATE items SET title=?, body=?, links=?, pinned=?, spec_type=?, rev=rev+1, seq=?, updated_at=?, updated_by=?, updated_via=? WHERE team_id=? AND id=?').run(
      title ?? cur.title, body ?? cur.body, JSON.stringify(links ?? cur.links), pin ?? (cur.pinned ? 1 : 0), st ?? cur.specType, nextSeq(t), now, who ?? cur.updatedBy, by?.via ?? null, t, id,
    );
  }
  return getItem(t, id);
}

/** Delete a draft spec or an unreleased document. Released content must be revoked first. */
export function deleteItem(t, id, baseRev) {
  const cur = getItem(t, id);
  if (!cur) return;
  if (cur.rev !== baseRev) throw new ApiError('conflict', 409);
  if (cur.kind === 'spec' && cur.status === 'approved') throw new ApiError(`${id} is released – revoke it before deleting`, 409);
  if (cur.kind === 'doc' && isCoreDoc(id)) throw new ApiError(`${id} is a foundation document every team has – it cannot be deleted`, 409);
  if (cur.kind === 'folder' && sql("SELECT 1 FROM items WHERE team_id=? AND kind IN ('doc','folder') AND deleted=0 AND substr(id, 1, ?)=? LIMIT 1").get(t, id.length + 1, `${id}/`)) throw new ApiError(`Folder ${id} is not empty`, 409);
  if (cur.kind === 'doc') {
    const users = approvedSpecs(t).filter((s) => s.links.includes(id)).map((s) => s.id);
    if (users.length) throw new ApiError(`${id} is still used by released spec(s): ${users.join(', ')}`, 409);
    for (const s of allSpecs(t, { body: false }).filter((x) => x.links.includes(id))) { // drop dangling links from drafts
      sql('UPDATE items SET links=?, rev=rev+1, seq=? WHERE team_id=? AND id=?').run(JSON.stringify(s.links.filter((l) => l !== id)), nextSeq(t), t, s.id);
    }
  }
  sql("UPDATE items SET deleted=1, title='', body='', links='[]', rev=rev+1, seq=?, updated_at=? WHERE team_id=? AND id=?").run(nextSeq(t), new Date().toISOString(), t, id);
  if (cur.kind === 'spec') { // nothing may outlive its spec: comments, decisions, reports and checks would show up on the garden with no spec behind them
    sql('DELETE FROM feedback WHERE team_id=? AND spec_id=?').run(t, id);
    sql('DELETE FROM reports WHERE team_id=? AND spec_id=?').run(t, id);
    sql('DELETE FROM check_runs WHERE team_id=? AND spec_id=?').run(t, id);
    sql('DELETE FROM checks WHERE team_id=? AND spec_id=?').run(t, id);
    sql('UPDATE teams SET garden_rev = garden_rev + 1 WHERE id=?').run(t);
  }
}

// ---------------------------------------------------------------- releases (Git)
const root = (team) => team.row.git_root;
const specPath = (team, id) => `${root(team)}/${id}.md`;
const docPath = (team, id) => `${root(team)}/docs/${id}`;
const glossaryPath = (team) => `${root(team)}/GLOSSARY.md`;
export const tagFor = (id, version) => `${id}/v${version}`;

function specFile(s, docs, version, at) {
  const list = docs.length ? '\n' + docs.map((d) => `  - ${d.id}`).join('\n') : ' []';
  return `---\nid: ${s.id}\ntype: ${s.specType}\ntitle: ${JSON.stringify(s.title)}\nversion: ${version}\nstatus: approved\napproved_at: ${at}\ndocuments:${list}\n---\n\n# ${s.title}\n\n${s.body.trim()}\n`;
}

/** Every definition found in the released files of a team's repository. */
export async function glossaryEntries(team, repo = repoFor(team)) {
  const r = root(team);
  const files = (await repo.walk(r)).filter((f) => f.endsWith('.md') && f !== glossaryPath(team));
  const out = [];
  for (const f of files) {
    const rel = f.slice(r.length + 1);
    const source = rel.startsWith('docs/') ? rel.slice(5) : rel.replace(/\.md$/, '');
    const body = await repo.readFile(f);
    const t = isTermPath(source) ? parseTermFile(body) : null;
    if (t) out.push({ term: t.term, definition: t.body, aliases: t.aliases, see: t.see, avoid: t.avoid, distinct: t.distinct, origin: t.origin, refs: t.refs, source, folder: source.split('/').slice(1, -1).join('/') });
    else for (const d of parseDefinitions(body)) out.push({ avoid: [], distinct: [], ...d, source });
  }
  return out;
}

/** Documents that must stay in the repository: linked by a released spec, or released foundation documents. */
function keepSet(t, { excludeSpec, excludeDoc, extra = [] } = {}) {
  return new Set([
    ...approvedSpecs(t).filter((s) => s.id !== excludeSpec).flatMap((s) => s.links),
    ...pinnedDocs(t).filter((d) => d.status === 'approved' && d.id !== excludeDoc).map((d) => d.id),
    ...extra,
  ]);
}

/** Runs inside the commit: removes documents no released spec links to and regenerates GLOSSARY.md. */
const tidy = (team, keepDocs) => async (repo) => {
  const prefix = `${root(team)}/docs/`;
  for (const f of await repo.walk(`${root(team)}/docs`)) {
    if (!keepDocs.has(f.slice(prefix.length))) await repo.commitRemove(f);
  }
  const entries = await glossaryEntries(team, repo);
  if (entries.length) await repo.commitWrite(glossaryPath(team), glossaryMarkdown(entries));
  else await repo.commitRemove(glossaryPath(team));
};

export async function releaseSpec(team, id, by = null) {
  const t = team.id;
  const spec = getItem(t, id);
  if (!spec || spec.kind !== 'spec') throw new ApiError(`unknown spec: ${id}`, 404);
  if (!spec.title.trim()) throw new ApiError('a spec needs a title before it can be approved');
  if (spec.status === 'approved' && spec.rev === spec.releasedRev) return spec; // nothing new to release
  const docs = spec.links.map((l) => getItem(t, l));
  const missing = spec.links.filter((_, i) => !docs[i] || docs[i].kind !== 'doc');
  if (missing.length) throw new ApiError(`linked documents missing on server: ${missing.join(', ')}`);

  const relRev = spec.rev; // an edit may arrive while git works: only this revision is released
  const version = spec.version + 1;
  const at = new Date().toISOString();
  const write = { [specPath(team, id)]: specFile(spec, docs, version, at) };
  for (const d of docs) write[docPath(team, d.id)] = d.body;
  const keep = keepSet(t, { excludeSpec: id, extra: spec.links });
  const tag = tagFor(id, version);
  const repo = repoFor(team);
  const sha = await repo.commit({ write, message: `Release ${id} v${version}: ${spec.title}`, tag, author: by, post: tidy(team, keep) });
  if (!sha) await repo.tag(tag);

  sql("UPDATE items SET status='approved', version=?, released_rev=?, released_at=?, released_by=?, seq=? WHERE team_id=? AND id=?")
    .run(version, relRev, at, by?.name ?? null, nextSeq(t), t, id);
  events.emit('committed', t);
  events.emit('released', { teamId: t, id, version, title: spec.title, by: by?.name ?? null });
  return getItem(t, id);
}

/** Withdraw a spec from the agent-visible tree. Tags/history stay in Git. */
export async function revokeSpec(team, id, by = null) {
  const t = team.id;
  const spec = getItem(t, id);
  if (!spec || spec.kind !== 'spec') throw new ApiError(`unknown spec: ${id}`, 404);
  if (spec.status !== 'approved') return spec;
  const keep = keepSet(t, { excludeSpec: id });
  await repoFor(team).commit({ remove: [specPath(team, id)], message: `Revoke ${id}`, author: by, post: tidy(team, keep) });
  sql("UPDATE items SET status='draft', seq=? WHERE team_id=? AND id=?").run(nextSeq(t), t, id);
  events.emit('committed', t);
  return getItem(t, id);
}

// ---------------------------------------------------------------- foundation documents (vision, strategy, glossary, …)
/** Publishes a foundation document independently of any spec. An empty (template-only) document is withdrawn instead. */
export async function releaseDoc(team, id, by = null) {
  const t = team.id;
  const doc = getItem(t, id);
  if (!doc || doc.kind !== 'doc') throw new ApiError(`unknown document: ${id}`, 404);
  if (!doc.pinned) throw new ApiError(`${id} is not a foundation document – it is released together with a spec`);
  if (!hasContent(doc.body)) return unreleaseDoc(team, id, by);
  await releaseDocs(team, [id], by);
  return getItem(t, id);
}

/** Releases several foundation documents in ONE commit (glossary terms change in groups: a rename, an import, the migration). */
export async function releaseDocs(team, ids, by = null, message) {
  const t = team.id;
  const docs = [...new Set(ids)].map((id) => getItem(t, id)).filter((d) => d && d.kind === 'doc' && d.pinned && hasContent(d.body) && !(d.status === 'approved' && d.rev === d.releasedRev));
  if (!docs.length) return [];
  const at = new Date().toISOString();
  const write = Object.fromEntries(docs.map((d) => [docPath(team, d.id), d.body]));
  const terms = docs.filter((d) => isTermPath(d.id));
  const msg = message ?? (docs.length === 1 ? `Update ${docs[0].id} (foundation document, v${docs[0].version + 1})`
    : terms.length === docs.length ? `Glossary: update ${docs.length} terms` : `Update ${docs.length} foundation documents`);
  await repoFor(team).commit({ write, message: msg, author: by, post: tidy(team, keepSet(t, { extra: docs.map((d) => d.id) })) });
  for (const d of docs) {
    sql("UPDATE items SET status='approved', version=?, released_rev=?, released_at=?, released_by=?, seq=? WHERE team_id=? AND id=?")
      .run(d.version + 1, d.rev, at, by?.name ?? null, nextSeq(t), t, d.id);
  }
  events.emit('committed', t);
  const g = docs.find((d) => d.id === 'guardrails.md');
  if (g) events.emit('guardrails', { teamId: t, version: g.version + 1, by: by?.name ?? null });
  return docs.map((d) => d.id);
}

export async function unreleaseDoc(team, id, by = null) {
  const t = team.id;
  const doc = getItem(t, id);
  if (!doc || doc.status !== 'approved') return doc;
  await repoFor(team).commit({ message: `Withdraw ${id}`, author: by, post: tidy(team, keepSet(t, { excludeDoc: id })) });
  sql("UPDATE items SET status='draft', released_rev=0, seq=? WHERE team_id=? AND id=?").run(nextSeq(t), t, id);
  events.emit('committed', t);
  return getItem(t, id);
}

const timers = new Map();
/** Foundation documents go live shortly after the last edit (debounced per team, so typing or a batch of term edits makes one commit). */
export function scheduleFoundation(teamId, id, by) {
  const cur = timers.get(teamId) ?? { ids: new Set(), timer: null };
  clearTimeout(cur.timer);
  cur.ids.add(id);
  cur.by = by;
  cur.timer = setTimeout(async () => {
    timers.delete(teamId);
    try {
      const team = getTeam(teamId);
      if (!team?.row.foundation_auto) return;
      const ids = [...cur.ids].filter((x) => getItem(teamId, x)?.pinned);
      for (const x of ids.filter((i) => !hasContent(getItem(teamId, i).body))) await unreleaseDoc(team, x, cur.by);
      await releaseDocs(team, ids, cur.by);
    } catch (e) { console.error('foundation release:', e.message); }
  }, FOUNDATION_DEBOUNCE_MS);
  timers.set(teamId, cur);
}

/** Creates the documents every team has (vision, strategy, glossary) and makes sure they are pinned. */
export function ensureFoundation(team) {
  const t = team.id;
  for (const [id, body] of Object.entries(CORE_DOCS)) {
    const cur = rawItem(t, id);
    if (!cur || cur.deleted) saveItem(t, { id, kind: 'doc', title: id, body, links: [] }, 0);
    else if (!cur.pinned) sql('UPDATE items SET pinned=1, seq=? WHERE team_id=? AND id=?').run(nextSeq(t), t, id);
  }
}

/**
 * One-time move from the single glossary.md to a folder of term files: every definition becomes glossary/<folder>/<term>.md
 * ("## Heading" -> folder, "### Heading" -> sub-folder), drafts of agents (glossary/from-<source>.md, not released) become
 * proposals in glossary/_proposed/. Released content is released again in one commit. Returns the number of terms written.
 */
export async function migrateGlossary(team) {
  const t = team.id;
  let n = 0;
  const taken = (p) => !!getItem(t, p);
  const folder = (path) => { const parts = path.split('/'); parts.forEach((_, i) => { const id = parts.slice(0, i + 1).join('/'); if (!getItem(t, id)) saveItem(t, { id, kind: 'folder' }, 0); }); };
  const old = getItem(t, 'glossary.md');
  const written = [];
  if (old && old.kind === 'doc') {
    const entries = splitGlossaryMd(old.body);
    if (entries.length || !hasContent(old.body)) {
      folder('glossary');
      for (const h of old.body.split('\n').filter((l) => /^##\s/.test(l))) folder(`glossary/${folderSegment(h.replace(/^##\s+/, ''))}`);
      for (const e of entries) {
        if (e.folder) folder(`glossary/${e.folder}`);
        const id = termPath(e.folder, e.term, taken);
        saveItem(t, { id, kind: 'doc', title: id, body: formatTermFile({ term: e.term, body: e.body, aliases: e.aliases, see: e.see, origin: e.origin }), links: [] }, 0, old.updatedBy ? { name: old.updatedBy } : null);
        written.push(id);
      }
      const wasLive = old.status === 'approved';
      sql("UPDATE items SET deleted=1, title='', body='', links='[]', pinned=0, rev=rev+1, seq=?, updated_at=? WHERE team_id=? AND id=?").run(nextSeq(t), new Date().toISOString(), t, 'glossary.md');
      if (written.length && (wasLive || team.row.foundation_auto)) await releaseDocs(team, written, null, `Glossary: one file per term (${written.length} terms)`);
      else if (wasLive) await repoFor(team).commit({ message: 'Glossary: one file per term', post: tidy(team, keepSet(t)) });
      n += written.length;
    }
  }
  const linkedLive = new Set(approvedSpecs(t).flatMap((s) => s.links));
  for (const d of allDocs(t).filter((x) => /^glossary\/from-[^/]+\.md$/.test(x.id) && !linkedLive.has(x.id))) {
    const from = /^# Terms derived from (.+)$/m.exec(d.body)?.[1]?.trim() ?? null;
    for (const e of parseDefinitions(d.body)) {
      const id = termPath('', e.term, taken, 'glossary/_proposed');
      saveItem(t, { id, kind: 'doc', title: id, body: formatTermFile({ term: e.term, body: e.definition, aliases: e.aliases, see: e.see, proposedBy: d.updatedBy ?? 'an agent', from }), links: [] }, 0, d.updatedBy ? { name: d.updatedBy, via: d.updatedVia } : null);
      n++;
    }
    deleteItem(t, d.id, d.rev);
  }
  return n;
}

/** Startup: make sure every team has its foundation documents and that auto-release is caught up. */
export async function startupSweep() {
  for (const team of listTeams()) {
    try { const n = await migrateGlossary(team); if (n) console.log(`glossary of ${team.key}: ${n} terms moved to glossary/`); } catch (e) { console.error('glossary migration', team.key, e); }
    ensureFoundation(team);
    if (!team.row.foundation_auto) continue;
    const due = pinnedDocs(team.id).filter((d) => d.rev > d.releasedRev && hasContent(getItem(team.id, d.id).body)).map((d) => d.id);
    await releaseDocs(team, due).catch((e) => console.error('sweep', e.message));
  }
}

/** Commits that touched one released document, newest first (the History of a glossary term). */
export async function docHistory(team, id) {
  const out = await repoFor(team).git('log', '--follow', '--format=%h%x09%aI%x09%an%x09%s', '--', docPath(team, id)).catch(() => '');
  return out.trim().split('\n').filter(Boolean).map((l) => { const [commit, at, by, message] = l.split('\t'); return { commit, at, by, message }; });
}

export async function deleteTeamData(team) {
  const { rm } = await import('node:fs/promises');
  await rm(path.join(DATA_DIR, 'repos', team.id), { recursive: true, force: true });
  repos.delete(team.id);
}

export const hasReleases = (t) => sql("SELECT 1 FROM items WHERE team_id=? AND (status='approved' OR version>0) LIMIT 1").get(t) !== undefined;
export const listTags = (team, id) => repoFor(team).tags(`${id}/v`);
/** Released versions of a spec, newest first: the Git tag, the commit, who released it and when. */
export async function specVersions(team, id) {
  const repo = repoFor(team), prefix = `${id}/v`;
  const out = [];
  for (const tag of await repo.tags(prefix)) {
    const [commit, at, by] = (await repo.git('log', '-1', '--format=%h%x09%aI%x09%an', tag)).trim().split('\t');
    const version = Number(tag.slice(prefix.length));
    if (Number.isInteger(version)) out.push({ version, tag, commit, at, by });
  }
  return out.sort((x, y) => y.version - x.version);
}
export const readReleasedSpec = (team, id, version) => repoFor(team).readFile(specPath(team, id), version ? tagFor(id, version) : undefined);
/** Unified diff of a spec between two released versions (both are Git tags). */
export const diffReleasedSpec = (team, id, from, to) => repoFor(team).git('diff', '--no-color', '-U2', tagFor(id, from), tagFor(id, to), '--', specPath(team, id));
export const readReleasedDoc = (team, id) => repoFor(team).readFile(docPath(team, id));
export const isReleasedDoc = (team, id) => repoFor(team).exists(docPath(team, id));
export async function releasedDocs(team) {
  const prefix = `${root(team)}/docs/`;
  return (await repoFor(team).walk(`${root(team)}/docs`)).map((f) => f.slice(prefix.length)).sort();
}

/** Next free spec id for a team, e.g. SPEC-015 (used when an agent creates a draft; people number specs on their device). */
export function nextSpecId(team) {
  const rows = sql("SELECT id FROM items WHERE team_id=? AND kind='spec'").all(team.id);
  const n = Math.max(0, ...rows.map((r) => (r.id.startsWith(`${team.key}-`) ? Number(/(\d+)$/.exec(r.id)?.[1] ?? 0) : 0))) + 1;
  return `${team.key}-${String(n).padStart(3, '0')}`;
}
