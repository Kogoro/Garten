import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DATA_DIR } from './config.js';
import { db } from './db.js';
import { Repo } from './git.js';
import { parseDefinitions, glossaryMarkdown, hasContent } from '../shared/glossary.js';
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
/** Documents may live in folders: adr/ADR-007.md, schemas/billing.yaml (max. 5 levels, no "..") */
export const FOLDER_ID = /^(?!.*\.\.)(?=.{1,100}$)[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*){0,4}$/;
/** Documents every team has: always present, always available to agents once they contain something. */
export const CORE_DOCS = {
  'vision.md': '# Vision\n\n## Where are we heading?\n\n## Why does it matter?\n',
  'strategy.md': '# Strategy\n\n## Goals\n\n## Principles and trade-offs\n\n## Out of scope\n',
  'glossary.md': '# Glossary\n\n',
};
export const isCoreDoc = (id) => id in CORE_DOCS;
export const hasContentDoc = (d) => hasContent(d.body);
export const DOC_ID = /^(?!.*\.\.)(?=.{3,120}$)[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*){0,4}\.(?:md|yaml|yml|json|txt)$/;

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

const nextSeq = (t) => db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS n FROM items WHERE team_id=?').get(t).n;
export const maxSeq = (t) => db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM items WHERE team_id=?').get(t).n;
export const count = (t) => db.prepare('SELECT COUNT(*) AS n FROM items WHERE team_id=? AND deleted=0').get(t).n;
const rawItem = (t, id) => toItem(db.prepare('SELECT * FROM items WHERE team_id=? AND id=?').get(t, id));
/** live item or undefined (tombstones are invisible here) */
export const getItem = (t, id) => { const i = rawItem(t, id); return i && !i.deleted ? i : undefined; };
/** Everything changed after `seq`, including tombstones so clients can drop deleted items. */
export const itemsSince = (t, seq) =>
  db.prepare('SELECT * FROM items WHERE team_id=? AND seq>? ORDER BY seq').all(t, seq).map(toItem)
    .map((i) => (i.deleted ? { id: i.id, kind: i.kind, deleted: true, rev: i.rev } : i));
const live = (t, kind) => db.prepare('SELECT * FROM items WHERE team_id=? AND kind=? AND deleted=0 ORDER BY id').all(t, kind).map(toItem);
export const allSpecs = (t) => live(t, 'spec');
export const allDocs = (t) => live(t, 'doc');
export const allFolders = (t) => live(t, 'folder');
export const pinnedDocs = (t) => allDocs(t).filter((d) => d.pinned);
export const approvedSpecs = (t) => allSpecs(t).filter((s) => s.status === 'approved');

export function touchFetched(t, id) {
  db.prepare('UPDATE items SET fetched_at=?, seq=? WHERE team_id=? AND id=?').run(new Date().toISOString(), nextSeq(t), t, id);
}

/** Create or update an item. `baseRev` must equal the current revision (0 = create). */
export function saveItem(t, { id, kind, title, body, links, pinned, specType }, baseRev, by = null) {
  if (specType !== undefined && kind === 'spec' && !isKnownType(t, specType)) throw new ApiError(`unknown spec type: ${specType}`);
  const st = kind === 'spec' ? specType : undefined;
  const now = new Date().toISOString();
  const cur = rawItem(t, id);
  const who = by?.name ?? null;
  const pin = kind !== 'doc' ? 0 : isCoreDoc(id) ? 1 : pinned === undefined ? undefined : pinned ? 1 : 0;
  if (!cur || cur.deleted) {
    if (kind === 'spec' && !SPEC_ID.test(id)) throw new ApiError(`invalid spec id: ${id}`);
    if (kind === 'doc' && !DOC_ID.test(id)) throw new ApiError(`invalid document path: ${id}`);
    if (kind === 'folder' && !FOLDER_ID.test(id)) throw new ApiError(`invalid folder path: ${id}`);
    if (kind === 'folder' && rawItem(t, id)?.kind === 'doc') throw new ApiError(`${id} is a document`);
    if (cur?.deleted) {
      db.prepare("UPDATE items SET updated_via=?, spec_type=?, kind=?, title=?, body=?, links=?, pinned=?, deleted=0, rev=rev+1, seq=?, status='draft', released_rev=0, released_at=NULL, released_by=NULL, updated_at=?, updated_by=? WHERE team_id=? AND id=?")
        .run(by?.via ?? null, st ?? DEFAULT_TYPE, kind, title ?? '', body ?? '', JSON.stringify(links ?? []), pin ?? 0, nextSeq(t), now, who, t, id);
    } else {
      db.prepare('INSERT INTO items (team_id,id,kind,title,body,links,pinned,spec_type,rev,seq,created_at,updated_at,updated_by,updated_via) VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?,?)')
        .run(t, id, kind, title ?? '', body ?? '', JSON.stringify(links ?? []), pin ?? 0, st ?? DEFAULT_TYPE, nextSeq(t), now, now, who, by?.via ?? null);
    }
  } else {
    if (cur.rev !== baseRev) throw new ApiError('conflict', 409);
    db.prepare('UPDATE items SET title=?, body=?, links=?, pinned=?, spec_type=?, rev=rev+1, seq=?, updated_at=?, updated_by=?, updated_via=? WHERE team_id=? AND id=?').run(
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
  if (cur.kind === 'folder' && [...allDocs(t), ...allFolders(t)].some((x) => x.id.startsWith(`${id}/`))) throw new ApiError(`Folder ${id} is not empty`, 409);
  if (cur.kind === 'doc') {
    const users = approvedSpecs(t).filter((s) => s.links.includes(id)).map((s) => s.id);
    if (users.length) throw new ApiError(`${id} is still used by released spec(s): ${users.join(', ')}`, 409);
    for (const s of allSpecs(t).filter((x) => x.links.includes(id))) { // drop dangling links from drafts
      db.prepare('UPDATE items SET links=?, rev=rev+1, seq=? WHERE team_id=? AND id=?').run(JSON.stringify(s.links.filter((l) => l !== id)), nextSeq(t), t, s.id);
    }
  }
  db.prepare("UPDATE items SET deleted=1, title='', body='', links='[]', rev=rev+1, seq=?, updated_at=? WHERE team_id=? AND id=?").run(nextSeq(t), new Date().toISOString(), t, id);
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
    for (const d of parseDefinitions(await repo.readFile(f))) out.push({ ...d, source });
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

  db.prepare("UPDATE items SET status='approved', version=?, released_rev=?, released_at=?, released_by=?, seq=? WHERE team_id=? AND id=?")
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
  db.prepare("UPDATE items SET status='draft', seq=? WHERE team_id=? AND id=?").run(nextSeq(t), t, id);
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
  if (doc.status === 'approved' && doc.rev === doc.releasedRev) return doc;
  const relRev = doc.rev;
  const version = doc.version + 1;
  const at = new Date().toISOString();
  await repoFor(team).commit({
    write: { [docPath(team, id)]: doc.body },
    message: `Update ${id} (foundation document, v${version})`, author: by, post: tidy(team, keepSet(t, { extra: [id] })),
  });
  db.prepare("UPDATE items SET status='approved', version=?, released_rev=?, released_at=?, released_by=?, seq=? WHERE team_id=? AND id=?")
    .run(version, relRev, at, by?.name ?? null, nextSeq(t), t, id);
  events.emit('committed', t);
  return getItem(t, id);
}

export async function unreleaseDoc(team, id, by = null) {
  const t = team.id;
  const doc = getItem(t, id);
  if (!doc || doc.status !== 'approved') return doc;
  await repoFor(team).commit({ message: `Withdraw ${id}`, author: by, post: tidy(team, keepSet(t, { excludeDoc: id })) });
  db.prepare("UPDATE items SET status='draft', released_rev=0, seq=? WHERE team_id=? AND id=?").run(nextSeq(t), t, id);
  events.emit('committed', t);
  return getItem(t, id);
}

const timers = new Map();
/** Foundation documents go live shortly after the last edit (debounced, so typing does not create a commit per keystroke). */
export function scheduleFoundation(teamId, id, by) {
  const k = `${teamId}|${id}`;
  clearTimeout(timers.get(k));
  timers.set(k, setTimeout(async () => {
    timers.delete(k);
    try {
      const team = getTeam(teamId);
      if (team?.row.foundation_auto && getItem(teamId, id)?.pinned) await releaseDoc(team, id, by);
    } catch (e) { console.error(`foundation release ${id}:`, e.message); }
  }, FOUNDATION_DEBOUNCE_MS));
}

/** Creates the documents every team has (vision, strategy, glossary) and makes sure they are pinned. */
export function ensureFoundation(team) {
  const t = team.id;
  for (const [id, body] of Object.entries(CORE_DOCS)) {
    const cur = rawItem(t, id);
    if (!cur || cur.deleted) saveItem(t, { id, kind: 'doc', title: id, body, links: [] }, 0);
    else if (!cur.pinned) db.prepare('UPDATE items SET pinned=1, seq=? WHERE team_id=? AND id=?').run(nextSeq(t), t, id);
  }
}

/** Startup: make sure every team has its foundation documents and that auto-release is caught up. */
export async function startupSweep() {
  for (const team of listTeams()) {
    ensureFoundation(team);
    if (!team.row.foundation_auto) continue;
    for (const d of pinnedDocs(team.id)) {
      if (d.rev > d.releasedRev && hasContent(d.body)) await releaseDoc(team, d.id).catch((e) => console.error('sweep', d.id, e.message));
    }
  }
}

export async function deleteTeamData(team) {
  const { rm } = await import('node:fs/promises');
  await rm(path.join(DATA_DIR, 'repos', team.id), { recursive: true, force: true });
  repos.delete(team.id);
}

export const hasReleases = (t) => db.prepare("SELECT 1 FROM items WHERE team_id=? AND (status='approved' OR version>0) LIMIT 1").get(t) !== undefined;
export const listTags = (team, id) => repoFor(team).tags(`${id}/v`);
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
  const rows = db.prepare("SELECT id FROM items WHERE team_id=? AND kind='spec'").all(team.id);
  const n = Math.max(0, ...rows.map((r) => (r.id.startsWith(`${team.key}-`) ? Number(/(\d+)$/.exec(r.id)?.[1] ?? 0) : 0))) + 1;
  return `${team.key}-${String(n).padStart(3, '0')}`;
}
