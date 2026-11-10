// Client state: IndexedDB-backed items per team, an implicit outbox (pending items) and the sync engine.
import { idb } from './idb';
import type { Item, Me, SpecType, TeamInfo } from './types';
import { BUILTIN_TYPES, DEFAULT_TYPE, typeFrom } from '@shared/spectypes.js';
import { parse as parseBlocks, serialize as serializeBlocks } from '@shared/blocksModel.js';

export const state: any = {
  me: null as Me | null, // cached so the app opens offline
  teamId: null as string | null, // active team
  maps: new Map<string, Map<string, Item>>(), // team id -> Map(item id -> item)
  cursors: {} as Record<string, number>,
  authConfig: null as any,
  project: 'specs',
  mcpUrl: `${location.origin}/mcp`,
  online: navigator.onLine,
  syncing: false,
  sessionExpired: false,
  lastSync: null,
  error: null,
};
const mapOf = (tid: string): Map<string, Item> => { if (!state.maps.has(tid)) state.maps.set(tid, new Map()); return state.maps.get(tid); };
Object.defineProperty(state, 'items', { get: (): Map<string, Item> => mapOf(state.teamId) });

/** Never-synced items the user removed locally. A push that was already in flight may still create them on the
 *  server; when that result arrives they come back marked for deletion instead of lingering as orphans. */
const dropped = new Set<string>();
const listeners = new Set<() => void>();
export const subscribe = (fn: () => void) => (listeners.add(fn), () => listeners.delete(fn));
export let version = 0;
export const getVersion = () => version;
export const emit = () => { version++; listeners.forEach((fn) => fn()); };

const meta = (key: string, value: unknown) => idb.put('meta', value, key);
const persist = (item: Item) => idb.put('items', { ...JSON.parse(JSON.stringify(item)), key: `${item.team}|${item.id}` });
const forget = (item: Item) => idb.del('items', `${item.team}|${item.id}`);

export async function init() {
  for (const rec of await idb.all('items')) mapOf(rec.team).set(rec.id, rec);
  state.cursors = (await idb.get('meta', 'cursors')) ?? {};
  state.me = (await idb.get('meta', 'me')) ?? null;
  state.authConfig = (await idb.get('meta', 'authConfig')) ?? null;
  state.project = state.authConfig?.project ?? 'specs';
  state.lastSync = (await idb.get('meta', 'lastSync')) ?? null;
  state.globalTerms = (await idb.get('meta', 'globalTerms')) ?? [];
  state.types = (await idb.get('meta', 'types')) ?? {};
  pickTeam((await idb.get('meta', 'teamId')) ?? null);
  addEventListener('online', () => ((state.online = true), emit(), sync()));
  addEventListener('offline', () => ((state.online = false), emit()));
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && sync());
  setInterval(() => sync(), 30000);
  loadAuthConfig();
  sync();
}

function pickTeam(preferred: string | null | undefined) {
  const teams = state.me?.teams ?? [];
  state.teamId = teams.find((t: TeamInfo) => t.id === preferred)?.id ?? teams.find((t: TeamInfo) => t.id === state.teamId)?.id ?? teams[0]?.id ?? null;
  meta('teamId', state.teamId);
}
export const team = () => state.me?.teams.find((t: TeamInfo) => t.id === state.teamId) ?? null;
export const can = (perm: string) => !!team()?.perms.includes(perm);
export const isInstanceAdmin = () => !!state.me?.admin;
export function switchTeam(id: string) { pickTeam(id); emit(); }
/** pending work of the other teams (shown next to the switcher) */
export const otherTeams = () => (state.me?.teams ?? [] as TeamInfo[]).filter((t: TeamInfo) => t.id !== state.teamId).map((t: TeamInfo) => ({ ...t, pending: [...mapOf(t.id).values()].filter(isPending).length, conflicts: [...mapOf(t.id).values()].filter((i) => i.conflict).length }));

// ------------------------------------------------------------ api + auth
export async function api(method: string, url: string, body?: unknown): Promise<any> {
  const res = await fetch(url, {
    method, credentials: 'same-origin',
    headers: { 'x-specs': '1', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !url.startsWith('/api/auth/')) { state.sessionExpired = true; emit(); }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw Object.assign(new Error(data?.error ?? `Server error ${res.status}`), { status: res.status });
  return data;
}
export const teamApi = (method: string, path: string, body?: unknown) => api(method, `/api/teams/${state.teamId}${path}`, body);

export async function loadAuthConfig() {
  try {
    state.authConfig = await api('GET', '/api/auth/config');
    state.project = state.authConfig.project;
    await meta('authConfig', state.authConfig);
    emit();
  } catch { /* offline: use cached */ }
}

async function wipeLocal() {
  state.maps.clear();
  state.cursors = {};
  state.types = {};
  await idb.clear('items');
  await Promise.all([meta('cursors', {}), meta('lastSync', null), meta('teamId', null), meta('types', {})]);
}

export async function login(email: string, password: string) {
  const { me } = await api('POST', '/api/auth/login', { email, password });
  return adoptLogin(me);
}
export async function adoptLogin(me: Me) {
  if (state.me && state.me.id !== me.id) await wipeLocal(); // never mix two users' data on one device
  state.me = me;
  state.sessionExpired = false;
  state.error = null;
  await meta('me', me);
  pickTeam(state.teamId);
  emit();
  sync();
}

export async function logout() {
  try { await api('POST', '/api/auth/logout'); } catch { /* offline: cookie stays but local state is wiped */ }
  await wipeLocal();
  state.me = null;
  state.teamId = null;
  state.sessionExpired = false;
  await meta('me', null);
  emit();
}

/** Refresh /api/me (team list, roles) – e.g. after an admin changed something. */
export async function refreshMe(teamId?: string | null) {
  const { me } = await api('GET', '/api/me');
  await adoptMe(me, teamId);
}

// ------------------------------------------------------------ queries
const visible = (i: Item) => !i.del;
export const all = (kind: string): Item[] => [...state.items.values()].filter((i) => i.kind === kind && visible(i));
export const get = (id: string): Item | undefined => { const i = state.items.get(id); return i && visible(i) ? i : undefined; };
export const isPending = (i: Item) => !!(i.dirty || i.approve || i.revoke || i.del);
export const hasUnreleased = (i: Item) => i.dirty || i.rev > i.releasedRev;

export function queue() {
  return [...state.items.values()]
    .filter((i) => isPending(i) && !i.conflict)
    .map((i) => {
      const noun = ({ spec: 'spec', doc: 'document', folder: 'folder' } as Record<string, string>)[i.kind];
      const base = i.baseRev === 0 ? `${i.kind === 'doc' ? 'Added' : 'Created'} ${noun}` : i.dirty ? `Edited ${noun}` : '';
      const what = i.del ? `Delete ${noun}` : i.revoke ? 'Revoke release' : i.approve ? (base ? `${base} + approve` : 'Approve for release') : base;
      return { id: i.id, what, at: i.editedAt, error: i.syncError };
    })
    .sort((a: any, b: any) => (b.at ?? 0) - (a.at ?? 0));
}
export const conflicts = () => [...state.items.values()].filter((i) => i.conflict);
export const usedBy = (docId: string) => all('spec').filter((s) => s.links.includes(docId));

// ------------------------------------------------------------ spec types
export const specTypes = (): SpecType[] => state.types[state.teamId] ?? BUILTIN_TYPES.map((t: SpecType) => ({ ...t, builtin: true }));
export const specType = (key: string): SpecType => typeFrom(specTypes(), key);
export async function refreshTypes() {
  const { types } = await teamApi('GET', '/spec-types');
  state.types[state.teamId] = types;
  await meta('types', state.types);
  emit();
  return types;
}

/** Term definitions across the team's working copies (specs + documents). */
export const folderOf = (id: string) => (id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '');
export const baseName = (id: string) => id.slice(id.lastIndexOf('/') + 1);

// ------------------------------------------------------------ mutations
const blank = (id: string, kind: Item['kind'], extra: Partial<Item> = {}): Item => ({
  id, team: state.teamId, kind, title: '', body: '', links: [], pinned: false, core: false, specType: DEFAULT_TYPE, rev: 0, status: 'draft', version: 0, releasedRev: 0,
  releasedAt: null, fetchedAt: null, createdAt: null, updatedAt: null,
  dirty: true, baseRev: 0, approve: false, revoke: false, del: false, conflict: null, localSeq: 1, editedAt: Date.now(),
  ...extra,
});

const SPEC_TEMPLATE = '## GOAL\n\n## REQUIREMENTS\n\n## ACCEPTANCE CRITERIA\n';

export function createSpec(typeKey: string = DEFAULT_TYPE) {
  const key = team()!.key;
  const n = Math.max(0, ...all('spec').filter((s) => s.id.startsWith(`${key}-`)).map((s) => Number(/(\d+)$/.exec(s.id)?.[1] ?? 0))) + 1;
  const type = specType(typeKey);
  const item = blank(`${key}-${String(n).padStart(3, '0')}`, 'spec', { body: type.template || SPEC_TEMPLATE, specType: type.missing ? DEFAULT_TYPE : type.key });
  dropped.delete(item.id);
  state.items.set(item.id, item);
  persist(item);
  emit();
  return item;
}

export const DOC_PATH = /^(?!.*\.\.)(?=.{3,120}$)[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*){0,4}\.(?:md|yaml|yml|json|txt)$/;
function checkDocPath(path: string) {
  path = path.trim().replace(/^\/+/, '');
  if (!DOC_PATH.test(path)) throw new Error('Use a path like adr/ADR-008.md (folders allowed; md, yaml, yml, json or txt)');
  if (state.items.get(path) && visible(state.items.get(path)!)) throw new Error(`${path} already exists`);
  return path;
}

export function createDoc(path: string, body?: string) {
  path = checkDocPath(path);
  dropped.delete(path);
  const item = blank(path, 'doc', { title: path, body: body ?? (path.endsWith('.md') ? `# ${baseName(path).replace(/\.md$/, '')}\n\n` : '') });
  state.items.set(path, item);
  persist(item);
  emit();
  return item;
}

let syncTimer: ReturnType<typeof setTimeout>;
export function edit(id: string, patch: Partial<Item>) {
  const it = state.items.get(id);
  if (!it) return;
  Object.assign(it, patch, { dirty: true, localSeq: it.localSeq + 1, editedAt: Date.now(), syncError: null });
  persist(it);
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, 2000);
  emit();
}

function flag(id: string, patch: Partial<Item>) {
  const it = state.items.get(id)!;
  Object.assign(it, patch, { editedAt: Date.now(), syncError: null });
  persist(it);
  emit();
  sync();
}
export const requestApprove = (id: string) => flag(id, { approve: true, revoke: false });
export const cancelApprove = (id: string) => flag(id, { approve: false });
export const requestRevoke = (id: string) => flag(id, { revoke: true, approve: false });
export const cancelRevoke = (id: string) => flag(id, { revoke: false });

export function toggleLink(specId: string, docId: string) {
  const s = state.items.get(specId)!;
  edit(specId, { links: s.links.includes(docId) ? s.links.filter((l: string) => l !== docId) : [...s.links, docId] });
}

/** Delete a spec or document. Never-synced items vanish immediately, others are queued. */
export function deleteItem(id: string) {
  const it = state.items.get(id);
  if (!it) return;
  if (it.kind === 'doc') for (const s of all('spec').filter((x: Item) => x.links.includes(id))) edit(s.id, { links: s.links.filter((l) => l !== id) });
  if (it.baseRev === 0) { state.items.delete(id); forget(it); dropped.add(id); emit(); return; }
  Object.assign(it, { del: true, dirty: false, approve: false, revoke: false, editedAt: Date.now(), syncError: null });
  persist(it);
  emit();
  sync();
}

/** Move/rename a document: new path + relink specs + delete the old path (processed in this order by the server). */
export function moveDoc(oldId: string, newPath: string) {
  const old = state.items.get(oldId)!;
  const path = checkDocPath(newPath);
  if (path === oldId) return old;
  dropped.delete(path);
  const item = blank(path, 'doc', { title: path, body: old.body });
  state.items.set(path, item);
  persist(item);
  for (const s of all('spec').filter((x: Item) => x.links.includes(oldId))) edit(s.id, { links: s.links.map((l) => (l === oldId ? path : l)) });
  if (old.baseRev === 0) { state.items.delete(oldId); forget(old); dropped.add(oldId); }
  else { Object.assign(old, { del: true, dirty: false, editedAt: Date.now(), syncError: null }); persist(old); }
  emit();
  sync();
  return item;
}


// ------------------------------------------------------------ folders, foundation documents
/** All folder paths of the team: explicit folder items plus every parent implied by a document path. */
export function folderPaths() {
  const set = new Set(all('folder').map((f) => f.id));
  for (const d of all('doc')) { const parts = d.id.split('/').slice(0, -1); parts.forEach((_, i) => set.add(parts.slice(0, i + 1).join('/'))); }
  for (const f of [...set]) { const parts = f.split('/'); parts.forEach((_, i) => set.add(parts.slice(0, i + 1).join('/'))); }
  return [...set].sort();
}
export const folderEmpty = (path: string) => ![...all('doc'), ...all('folder')].some((x: Item) => x.id.startsWith(`${path}/`));
const FOLDER_PATH = /^(?!.*\.\.)(?=.{1,100}$)[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*){0,4}$/;

export function createFolder(path: string) {
  path = path.trim().replace(/^\/+|\/+$/g, '');
  if (!FOLDER_PATH.test(path)) throw new Error('Use letters, digits, . _ - and / (up to 5 levels), e.g. adr/2026');
  if (folderPaths().includes(path)) throw new Error(`${path} already exists`);
  if (state.items.get(path) && visible(state.items.get(path)!)) throw new Error(`${path} already exists`);
  dropped.delete(path);
  const item = blank(path, 'folder');
  state.items.set(path, item);
  persist(item);
  emit();
  sync();
  return item;
}

function dropItem(it?: Item) {
  if (!it) return;
  if (it.baseRev === 0) { state.items.delete(it.id); forget(it); dropped.add(it.id); }
  else { Object.assign(it, { del: true, dirty: false, approve: false, revoke: false, editedAt: Date.now(), syncError: null }); persist(it); }
}
export function deleteFolder(path: string) {
  if (!folderEmpty(path)) throw new Error('Move or delete the documents in this folder first');
  dropItem(state.items.get(path));
  emit();
  sync();
}
/** Rename/move a folder together with everything inside it (documents are moved one by one, links follow). */
export function moveFolder(oldPath: string, newPath: string) {
  newPath = newPath.trim().replace(/^\/+|\/+$/g, '');
  if (!FOLDER_PATH.test(newPath)) throw new Error('Use letters, digits, . _ - and / (up to 5 levels)');
  if (newPath === oldPath) return;
  if (newPath.startsWith(`${oldPath}/`)) throw new Error('A folder cannot be moved into itself');
  if (folderPaths().includes(newPath)) throw new Error(`${newPath} already exists`);
  const re = (id: string) => newPath + id.slice(oldPath.length);
  for (const f of folderPaths().filter((p) => p === oldPath || p.startsWith(`${oldPath}/`))) {
    const target = re(f);
    if (!state.items.get(target)) { dropped.delete(target); const it = blank(target, 'folder'); state.items.set(target, it); persist(it); }
  }
  for (const d of all('doc').filter((x: Item) => x.id.startsWith(`${oldPath}/`))) moveDoc(d.id, re(d.id));
  for (const f of all('folder').filter((x: Item) => x.id === oldPath || x.id.startsWith(`${oldPath}/`)).sort((a: any, b: any) => b.id.length - a.id.length)) dropItem(f);
  emit();
  sync();
}

/** Foundation documents are always available to agents (vision, strategy, glossary, anything pinned). */
export const foundationDocs = () => {
  const order = ['vision.md', 'strategy.md', 'glossary.md'];
  return all('doc').filter((d) => d.pinned).sort((a: any, b: any) => (order.indexOf(a.id) < 0 ? 9 : order.indexOf(a.id)) - (order.indexOf(b.id) < 0 ? 9 : order.indexOf(b.id)) || a.id.localeCompare(b.id));
};
export const setPinned = (id: string, on: boolean) => edit(id, { pinned: !!on });

// ------------------------------------------------------------ teams + invitations
async function adoptMe(me: Me, teamId?: string | null) {
  state.me = me;
  await meta('me', me);
  pickTeam(teamId ?? state.teamId);
  emit();
  sync();
}
export async function createTeam(name: string) {
  const res = await api('POST', '/api/teams', { name });
  await adoptMe(res.me, res.team.id);
  return res.team;
}
export async function acceptInvite(id: string) { const r = await api('POST', `/api/me/invites/${id}/accept`); await adoptMe(r.me, r.teamId); }
export async function declineInvite(id: string) { const r = await api('POST', `/api/me/invites/${id}/decline`); await adoptMe(r.me); }
export async function leaveTeam() { const r = await teamApi('POST', '/leave'); state.maps.delete(state.teamId); await adoptMe(r.me, null); }

export function resolveConflict(id: string, choice: 'server' | 'mine') {
  const it = state.items.get(id)!;
  const srv = it.conflict;
  if (!srv) return;
  if (choice === 'server') {
    if (srv.deleted) { state.items.delete(id); forget(it); } else { const next = fromServer(srv, it.team); state.items.set(id, next); persist(next); }
  } else {
    Object.assign(it, { baseRev: srv.rev, conflict: null, dirty: true, localSeq: it.localSeq + 1 }, serverMeta(srv));
    persist(it);
  }
  emit();
  sync();
}

// ------------------------------------------------------------ sync engine
const serverMeta = (s: any) => ({
  core: !!s.core, rev: s.rev, status: s.status, version: s.version, releasedRev: s.releasedRev,
  releasedAt: s.releasedAt, releasedBy: s.releasedBy, updatedBy: s.updatedBy, updatedVia: s.updatedVia ?? null, fetchedAt: s.fetchedAt, createdAt: s.createdAt, updatedAt: s.updatedAt,
});
const fromServer = (s: any, tid: string): Item => ({
  id: s.id, team: tid, kind: s.kind, title: s.title, body: s.body, links: s.links, pinned: !!s.pinned, specType: s.specType ?? DEFAULT_TYPE, ...serverMeta(s),
  dirty: false, baseRev: s.rev, approve: false, revoke: false, del: false, conflict: null, localSeq: 1, editedAt: null,
});

let again = false;
export async function sync() {
  if (state.syncing) return (again = true);
  if (!state.me || !navigator.onLine) return;
  state.syncing = true;
  state.error = null;
  emit();
  try {
    for (const t of [...state.me.teams]) await syncTeam(t.id);
    state.lastSync = Date.now();
    state.online = true;
    await Promise.all([meta('cursors', state.cursors), meta('lastSync', state.lastSync), meta('types', state.types)]);
  } catch (e: any) {
    state.error = e.message;
    if (e instanceof TypeError) state.online = false; // network failure
  } finally {
    state.syncing = false;
    emit();
    if (again) { again = false; sync(); }
  }
}

async function syncTeam(tid: string) {
  const map = mapOf(tid);
  const sent = [...map.values()].filter((i) => isPending(i) && !i.conflict);
  const changes = sent.map((i): any => ({
    id: i.id, kind: i.kind, baseRev: i.baseRev, approve: i.approve, revoke: i.revoke, delete: i.del || undefined,
    fields: i.dirty && !i.del ? (i.kind === 'doc' ? { title: i.title, body: i.body, links: i.links, pinned: !!i.pinned } : { title: i.title, body: i.body, links: i.links, specType: i.specType }) : {},
    ls: i.localSeq,
  }));
  let data: any;
  try {
    data = await api('POST', `/api/teams/${tid}/sync`, { since: state.cursors[tid] ?? 0, changes });
  } catch (e: any) {
    if (e.status === 401) { state.sessionExpired = true; throw new Error('Session expired – sign in again to sync'); }
    if (e.status === 404) return; // team no longer accessible; refreshMe will drop it
    throw e;
  }
  state.sessionExpired = false;

  // 1) pull: adopt server copies unless there are local changes waiting
  for (const srv of data.items) {
    const local = map.get(srv.id);
    if (local && isPending(local)) continue;
    if (srv.deleted) { if (local) { map.delete(srv.id); await forget(local); } continue; }
    const next = fromServer(srv, tid);
    if (dropped.has(srv.id)) next.del = true; // the user already removed it while the push was in flight
    map.set(srv.id, next);
    await persist(next);
  }
  // 2) push results
  for (const r of data.results) {
    const local = map.get(r.id);
    const ch = changes.find((c) => c.id === r.id);
    if (!local && r.status === 'applied' && r.item && dropped.has(r.id)) { // created on the server after the user removed it locally
      const back = fromServer(r.item, tid); back.del = true; map.set(r.id, back); await persist(back); continue;
    }
    if (!local || !ch) continue;
    if (r.status === 'applied') {
      if (r.deleted) { dropped.delete(r.id); map.delete(r.id); await forget(local); continue; }
      if (local.localSeq === ch.ls) { map.set(r.id, fromServer(r.item, tid)); if (dropped.has(r.id)) map.get(r.id)!.del = true; }
      else Object.assign(local, serverMeta(r.item), { baseRev: r.item.rev, approve: false, revoke: false }); // edited meanwhile
    } else if (r.status === 'conflict') {
      local.conflict = r.server ?? { ...local, rev: 0, deleted: true };
    } else {
      local.syncError = r.message;
      if (local.del) local.del = false; // refused deletion: bring the item back
      if (r.forbidden) { local.approve = false; local.revoke = false; }
    }
    if (map.has(r.id)) await persist(map.get(r.id)!);
  }
  if (data.specTypes) state.types[tid] = data.specTypes;
  state.cursors[tid] = data.cursor;
  if (data.me) { state.me = data.me; await meta('me', data.me); }
  state.project = data.project;
  state.mcpUrl = data.mcpUrl;
  if (!state.me.teams.some((t: TeamInfo) => t.id === state.teamId)) pickTeam(null);
}


// ------------------------------------------------------------ glossary: global terms + editing glossary.md
export async function loadGlobalGlossary() {
  try {
    const { terms } = await api('GET', '/api/glossary/global');
    if (JSON.stringify(terms) !== JSON.stringify(state.globalTerms)) { state.globalTerms = terms; await meta('globalTerms', terms); emit(); }
  } catch { /* offline: keep the cached list */ }
  return state.globalTerms;
}
export const parseOrigin = (o?: string | null) => { const m = /^global:([\w-]+)@(\d+)$/i.exec(o ?? ''); return m ? { id: m[1], rev: Number(m[2]) } : null; };

// glossary.md as a structure: section headings (h2/h3) act as folders for the definition blocks below them.
const headingAt = (blocks: any[], idx: number) => { for (let k = idx; k >= 0; k--) if (blocks[k].type === 'h' && blocks[k].level >= 2) return blocks[k].text.trim(); return ''; };

export function glossaryModel() {
  const g = get('glossary.md');
  const folders: string[] = [];
  const where = new Map<string, string>();
  if (g) {
    const blocks = parseBlocks(g.body);
    blocks.forEach((b: any, i: number) => {
      if (b.type === 'h' && b.level >= 2 && !folders.includes(b.text.trim())) folders.push(b.text.trim());
      if (b.type === 'def') where.set(b.term.trim().toLowerCase(), headingAt(blocks, i));
    });
  }
  return { folders, where };
}

/** Insert `nb` at the end of the section `folder` ('' = before the first section heading). */
function insertInFolder(blocks: any[], folder: string, nb: any) {
  if (!folder) {
    const first = blocks.findIndex((b: any) => b.type === 'h' && b.level >= 2);
    blocks.splice(first < 0 ? blocks.length : first, 0, nb);
    return;
  }
  const hi = blocks.findIndex((b: any) => b.type === 'h' && b.level >= 2 && b.text.trim() === folder);
  if (hi < 0) { blocks.push({ id: `g${Date.now()}h`, type: 'h', level: 2, text: folder }, nb); return; }
  let end = blocks.length;
  for (let k = hi + 1; k < blocks.length; k++) if (blocks[k].type === 'h' && blocks[k].level <= blocks[hi].level) { end = k; break; }
  blocks.splice(end, 0, nb);
}

function applyTerm(blocks: any[], t: any) {
  const key = (t.oldTerm ?? t.term).trim().toLowerCase();
  const nb = { type: 'def', term: t.term, text: t.definition, aliases: (t.aliases ?? []).join(', '), see: (t.see ?? []).join(', '), src: t.source ?? '' };
  const i = blocks.findIndex((b: any) => b.type === 'def' && b.term.trim().toLowerCase() === key);
  const cur = i >= 0 ? headingAt(blocks, i) : null;
  const want = t.folder === undefined ? (cur ?? '') : t.folder;
  if (i >= 0 && want === cur) { blocks[i] = { ...blocks[i], ...nb, src: t.source ?? blocks[i].src ?? '' }; return; }
  const keepSrc = i >= 0 ? blocks[i].src : '';
  if (i >= 0) blocks.splice(i, 1);
  insertInFolder(blocks, want, { id: `g${Date.now()}${blocks.length}`, ...nb, src: t.source ?? keepSrc ?? '' });
}

function editGlossary(fn: (b: any[]) => void) {
  const g = get('glossary.md') ?? createDoc('glossary.md', '# Glossary\n\n');
  const blocks = parseBlocks(g.body);
  fn(blocks);
  edit('glossary.md', { body: serializeBlocks(blocks) });
}

/** Adds or replaces definition blocks in the team's glossary.md (created when missing) in a single edit.
 *  Each item: { term, definition, aliases[], see[], source?, folder?, oldTerm? } – oldTerm renames, folder moves. */
export function upsertGlossaryTerms(list: any[]) { editGlossary((blocks) => list.forEach((t) => applyTerm(blocks, t))); }
export const saveGlossaryTerm = (t: any) => upsertGlossaryTerms([t]);
export function deleteGlossaryTerm(term: string) {
  editGlossary((blocks) => { const i = blocks.findIndex((b: any) => b.type === 'def' && b.term.trim().toLowerCase() === term.toLowerCase()); if (i >= 0) blocks.splice(i, 1); });
}
export function createGlossaryFolder(name: string) {
  name = name.trim();
  if (!name || name.length > 60) throw new Error('Give the folder a name (up to 60 characters)');
  if (glossaryModel().folders.some((f) => f.toLowerCase() === name.toLowerCase())) throw new Error(`“${name}” already exists`);
  editGlossary((blocks) => blocks.push({ id: `g${Date.now()}f`, type: 'h', level: 2, text: name }));
}
export function renameGlossaryFolder(oldName: string, name: string) {
  name = name.trim();
  if (!name || name.length > 60) throw new Error('Give the folder a name (up to 60 characters)');
  if (name.toLowerCase() !== oldName.toLowerCase() && glossaryModel().folders.some((f) => f.toLowerCase() === name.toLowerCase())) throw new Error(`“${name}” already exists`);
  editGlossary((blocks) => blocks.forEach((b: any) => { if (b.type === 'h' && b.level >= 2 && b.text.trim() === oldName) b.text = name; }));
}
export function deleteGlossaryFolder(name: string) {
  const m = glossaryModel();
  if ([...m.where.values()].includes(name)) throw new Error('Move or delete the terms in this folder first');
  editGlossary((blocks) => { const i = blocks.findIndex((b: any) => b.type === 'h' && b.level >= 2 && b.text.trim() === name); if (i >= 0) blocks.splice(i, 1); });
}
export function importGlobalTerms(ids: string[]) {
  const picked = state.globalTerms.filter((g: any) => ids.includes(g.id));
  upsertGlossaryTerms(picked.map((g: any) => ({ term: g.term, definition: g.definition, aliases: g.aliases, see: g.see, source: `global:${g.id}@${g.rev}` })));
  return picked.length;
}
