import * as S from './store.js';
import { esc, ic, ago, touched, ui, themePref } from './ui.js';
import { parseDefinitions, hasContent, extractRefs } from './glossary.js';

const RIGHTS = [
  ['read', 'Read specs & documents'],
  ['write', 'Write drafts'],
  ['drafts', 'Agent access to drafts (MCP)'],
  ['approve', 'Approve, revoke & push to Git'],
  ['admin', 'Manage members & Git connection'],
];
export const ROLES = ['viewer', 'editor', 'approver', 'admin'];
const ROLE_RIGHTS = { viewer: ['read'], editor: ['read', 'write', 'drafts'], approver: ['read', 'write', 'drafts', 'approve'], admin: ['read', 'write', 'drafts', 'approve', 'admin'] };
const scopesText = (s) => (s.includes('mcp:write') ? 'writes drafts' : s.includes('mcp:drafts') ? 'incl. drafts' : 'released only');
const initial = (s) => esc((s ?? '?').trim()[0]?.toUpperCase() ?? '?');
export const teamName = () => S.team()?.name ?? S.state.project;
const invites = () => S.state.me?.invites ?? [];
const CORE_LABEL = { 'vision.md': 'Vision', 'strategy.md': 'Strategy', 'glossary.md': 'Glossary' };

// ------------------------------------------------------------------ shared pieces
export function pill() {
  const q = S.queue().length;
  const c = S.conflicts().length;
  const { state } = S;
  if (state.sessionExpired) return { cls: 'bad', text: 'Sign in to sync', icon: ic.warn(14) };
  if (c) return { cls: 'bad', text: `${c} conflict${c > 1 ? 's' : ''}`, icon: ic.warn(14) };
  if (!state.online) return { cls: 'warn', text: `Offline${q ? ` · ${q}` : ''}`, icon: ic.off() };
  if (state.syncing) return { cls: '', text: 'Syncing…', icon: ic.sync(14) };
  if (state.error) return { cls: 'bad', text: 'Sync failed', icon: ic.warn(14) };
  if (q) return { cls: 'warn', text: `${q} queued`, icon: ic.up(14) };
  return { cls: 'ok', text: 'Synced', icon: ic.check(14) };
}
export const pillHtml = () => { const p = pill(); return `<a class="pill ${p.cls}" data-pill href="#/sync">${p.icon}${esc(p.text)}</a>`; };

const wsButton = () => `<button type="button" class="ws-btn only-mobile" data-act="workspace-menu" aria-label="Team: ${esc(teamName())}"><span class="ws-av">${initial(teamName())}</span>${invites().length ? '<span class="badge-dot"></span>' : ''}</button>`;
/** The one page header: compact, same everywhere. */
export const bar = (title, actions = '') => `<header class="bar"><h1>${esc(title)}</h1>${actions}${pillHtml()}${wsButton()}</header>`;

export function sidebarHtml(active) {
  const me = S.state.me;
  const t = S.team();
  const item = (href, label, icon, key, extra = '') => `<a class="navitem" href="#/${href}" ${active === key ? 'aria-current="page"' : ''}>${icon(18)}<span>${label}</span>${extra}</a>`;
  const nSpecs = S.all('spec').length;
  return `<button type="button" class="ws" data-act="workspace-menu" aria-label="Switch team"><span class="ws-av">${initial(teamName())}</span><b>${esc(teamName())}</b>${ic.chevron(14)}${invites().length ? `<span class="navitem badge" style="margin-left:6px;padding:0 5px;height:18px;border-radius:9px;background:var(--amber);color:#1B1300;font-size:11px;font-weight:700;line-height:18px">${invites().length}</span>` : ''}</button>
    <div class="navlabel">Content</div>
    ${item('', 'Specs', ic.specs, 'specs', nSpecs ? `<span class="muted" style="margin-left:auto;font-size:12px">${nSpecs}</span>` : '')}${item('docs', 'Documents', ic.docs, 'docs')}${item('glossary', 'Glossary', ic.glossary, 'glossary')}
    <div class="navlabel">Publish</div>
    ${item('release', 'Release', ic.release, 'release')}
    <div class="navlabel">Team</div>
    ${item('team', 'Members &amp; Git', ic.team, 'team')}
    ${S.isInstanceAdmin() ? `<div class="navlabel">Instance</div>${item('admin', 'Admin', ic.shield, 'admin')}` : ''}
    <div class="sidefoot">${pillHtml()}
      <button type="button" class="me" data-act="user-menu" aria-label="Account menu"><span class="avatar">${initial(me?.name)}</span><span class="who"><b>${esc(me?.name)}</b><small>${esc(t?.role ?? (me?.admin ? 'instance admin' : ''))}</small></span>${ic.more(18)}</button></div>`;
}
export function tabbarHtml(active) {
  const b = S.queue().length + S.conflicts().length;
  const t = (href, label, icon, key, badge = 0) => `<a href="#/${href}" ${active === key ? 'aria-current="page"' : ''}>${icon(22)}<span>${label}</span>${badge ? `<span class="badge">${badge}</span>` : ''}</a>`;
  return `${t('', 'Specs', ic.specs, 'specs')}${t('docs', 'Docs', ic.docs, 'docs')}${t('release', 'Release', ic.release, 'release')}${t('sync', 'Sync', ic.sync, 'sync', b)}
    <button type="button" data-act="more-menu" aria-label="More" ${['glossary', 'team', 'account', 'admin'].includes(active) ? 'aria-current="page"' : ''}>${ic.more(22)}<span>More</span>${invites().length ? `<span class="badge">${invites().length}</span>` : ''}</button>`;
}

export function shell({ active, master, detail, single }) {
  return `<div class="shell ${single ? 'single' : ''}" data-pane="${detail ? 'detail' : 'master'}">
    <aside class="sidebar" id="sidebar">${sidebarHtml(active)}</aside>
    <div class="content"><section class="master" id="master">${master}</section>${single ? '' : `<section class="detail" id="detail">${detail ?? placeholder(active)}</section>`}</div>
    <nav class="tabbar" id="tabbar" aria-label="Main">${tabbarHtml(active)}</nav>
  </div>`;
}
const placeholder = (active) => `<div class="placeholder">${active === 'docs' ? ic.docs(40) : active === 'glossary' ? ic.glossary(40) : ic.specs(40)}<p>${active === 'docs' ? 'Select a document, or create one with “New”.' : active === 'glossary' ? 'Select a term to see its definition, synonyms and links.' : 'Select a spec to edit it, or write a new one.'}</p></div>`;
const page = (inner) => `<div class="scroll"><div class="page">${inner}</div></div>`;

// ------------------------------------------------------------------ menus (opened as sheets)
export const workspaceItems = () => {
  const others = Object.fromEntries(S.otherTeams().map((t) => [t.id, t]));
  return [
    ...S.state.me.teams.map((t) => ({ key: `team:${t.id}`, label: `${t.name} · ${t.role}${others[t.id]?.pending ? ` · ${others[t.id].pending} unsynced` : ''}${others[t.id]?.conflicts ? ' · conflict' : ''}`, current: t.id === S.state.teamId })),
    ...invites().map((i) => ({ key: `invite:${i.id}`, label: `Join “${i.teamName}” as ${i.role} (invitation)` })),
    { key: 'create-team', label: 'Create a new team…' },
  ];
};
const themeLabel = { system: 'System', light: 'Light', dark: 'Dark' };
export const userItems = () => [
  { key: 'go:account', label: 'Account & agent access' },
  ...['system', 'light', 'dark'].map((t) => ({ key: `theme:${t}`, label: `Appearance: ${themeLabel[t]}`, current: themePref() === t })),
  { key: 'logout', label: 'Sign out', danger: true },
];
export const moreItems = () => [
  { key: 'go:glossary', label: 'Glossary' },
  { key: 'go:team', label: 'Members & Git' },
  ...(S.isInstanceAdmin() ? [{ key: 'go:admin', label: 'Admin' }] : []),
  { key: 'go:account', label: 'Account & agent access' },
  ...invites().map((i) => ({ key: `invite:${i.id}`, label: `Join “${i.teamName}” as ${i.role} (invitation)` })),
  { key: 'switch', label: `Team: ${teamName()} – switch or create…` },
  ...['system', 'light', 'dark'].map((t) => ({ key: `theme:${t}`, label: `Appearance: ${themeLabel[t]}`, current: themePref() === t })),
  { key: 'logout', label: 'Sign out', danger: true },
];

// ------------------------------------------------------------------ login + invitation (no shell)
export function loginView() {
  const cfg = S.state.authConfig;
  const err = new URLSearchParams(location.search).get('login_error') || ui.loginError;
  return `<div class="login"><form class="login-card" id="loginForm">
    <span class="logo big">${ic.specs(28)}</span>
    <h1>Specs</h1><p>Specifications for you and your AI agents. Works offline once you are signed in.</p>
    ${err ? `<div class="err-text" role="alert">${esc(err)}</div>` : ''}
    <label class="sr" for="email">E-mail</label><input class="field" id="email" name="email" type="email" placeholder="E-mail" autocomplete="username" required>
    <label class="sr" for="password">Password</label><input class="field" id="password" name="password" type="password" placeholder="Password" autocomplete="current-password" required>
    <button class="btn primary" type="submit">Sign in</button>
    ${cfg?.oidc ? `<a class="btn" href="/auth/oidc/login">${esc(cfg.oidc.name)}</a>` : ''}
    ${S.state.online ? '' : '<p class="err-text">You are offline – sign in needs a connection the first time.</p>'}
  </form></div>`;
}

export function inviteView() {
  const v = ui.invite;
  const me = S.state.me;
  const cfg = S.state.authConfig;
  if (!v) return `<div class="login"><div class="login-card"><span class="logo big">${ic.mail(28)}</span><h1>Invitation</h1><p>Checking your invitation…</p></div></div>`;
  if (v.error) return `<div class="login"><div class="login-card"><span class="logo big">${ic.mail(28)}</span><h1>Invitation</h1><p class="err-text">${esc(v.error)}</p><a class="btn" href="#/">Open Specs</a></div></div>`;
  const i = v.info;
  const head = `<span class="logo big">${ic.mail(28)}</span><h1>Join ${esc(i.teamName)}</h1><p>${i.invitedBy ? esc(i.invitedBy) + ' invited ' : 'You are invited: '}<b>${esc(i.email)}</b> as <b>${esc(i.role)}</b>.</p>${v.formError ? `<div class="err-text" role="alert">${esc(v.formError)}</div>` : ''}`;
  if (me) {
    return me.email.toLowerCase() === i.email.toLowerCase()
      ? `<div class="login"><div class="login-card">${head}<button class="btn primary" data-act="accept-link">Join ${esc(i.teamName)}</button></div></div>`
      : `<div class="login"><div class="login-card">${head}<p class="err-text">You are signed in as ${esc(me.email)}. Sign out to use this invitation.</p><button class="btn danger" data-act="logout">Sign out</button></div></div>`;
  }
  const sso = cfg?.oidc ? `<a class="btn" href="/auth/oidc/login?next=${encodeURIComponent('/#/invite/' + v.token)}">${esc(cfg.oidc.name)}</a>` : '';
  return i.userExists
    ? `<div class="login"><form class="login-card" id="inviteLogin">${head}<label class="sr" for="iv-pw">Password</label><input class="field" id="iv-pw" type="password" placeholder="Your password" autocomplete="current-password" required><button class="btn primary" type="submit">Sign in &amp; join</button>${sso}</form></div>`
    : `<div class="login"><form class="login-card" id="inviteRegister">${head}<label class="sr" for="iv-name">Your name</label><input class="field" id="iv-name" placeholder="Your name" autocomplete="name" required><label class="sr" for="iv-pw">Password</label><input class="field" id="iv-pw" type="password" placeholder="Choose a password (min. 8 characters)" autocomplete="new-password" minlength="8" required><button class="btn primary" type="submit">Create account &amp; join</button>${sso}</form></div>`;
}

export function noTeamPage() {
  return page(`<section class="card"><h2>Create your team</h2><p class="note">A team has its own specs, documents, glossary, Git repository and agent access. You become its admin and can invite colleagues.</p>
    <form id="createTeamForm" class="form"><label class="sr" for="newteam">Team name</label><input class="field" id="newteam" placeholder="Team name, e.g. Payments" required maxlength="80"><button class="btn primary" type="submit">${ic.plus(16)} Create team</button></form></section>
    ${invites().length ? `<section class="card"><h2>Invitations</h2>${invites().map((i) => `<div class="rel"><div class="grow"><b>${esc(i.teamName)}</b><span>${i.invitedBy ? esc(i.invitedBy) + ' · ' : ''}role ${esc(i.role)}</span></div><button class="btn small" data-act="invite-decline" data-id="${esc(i.id)}">Decline</button><button class="btn primary small" data-act="invite-accept" data-id="${esc(i.id)}" style="color:var(--on-green)">Join</button></div>`).join('')}</section>` : '<p class="note">Waiting for an invitation? Ask a team admin to invite your e-mail address.</p>'}`);
}

const itemSync = (i) =>
  i.conflict ? `<span class="st bad">${ic.warn()}Conflict</span>` : S.isPending(i) ? `<span class="st warn">${ic.up()}Not synced</span>` : `<span class="st">${ic.check()}Synced</span>`;

// ------------------------------------------------------------------ specs list
export const agentChip = (s) => (s.updatedVia && S.hasUnreleased(s) ? `<span class="chip agent" title="${esc(s.updatedVia)}">Agent draft</span>` : '');
export const typeChip = (s) => { const t = S.specType(s.specType); return `<span class="chip type" title="${esc(t.label)}">${esc(t.short ?? t.label)}</span>`; };

export function specRows(selected) {
  const q = ui.q.trim().toLowerCase();
  const specs = S.all('spec')
    .filter((s) => ui.filter === 'all' || (ui.filter === 'approved') === (s.status === 'approved'))
    .filter((s) => !ui.typeFilter || s.specType === ui.typeFilter)
    .filter((s) => !q || `${s.id} ${s.title} ${s.body}`.toLowerCase().includes(q))
    .sort((a, b) => touched(b) - touched(a));
  if (!specs.length) return `<div class="empty">${S.all('spec').length ? 'No specs match.' : S.can('write') ? 'No specs yet.<br>Create your first one — it works offline.' : 'No specs yet.'}</div>`;
  return specs.map((s) => {
    const badge = s.approve ? '<span class="chip warn">Approval queued</span>' : s.status === 'approved' ? `<span class="chip ok">Approved v${s.version}${S.hasUnreleased(s) ? ' · edited' : ''}</span>` : '<span class="chip">Draft</span>';
    const n = s.links.length;
    return `<a class="row ${selected === s.id ? 'active' : ''}" href="#/spec/${encodeURIComponent(s.id)}">
      <div class="row-top"><span class="row-id">${esc(s.id)}</span>${itemSync(s)}</div>
      <div class="row-title">${esc(s.title) || '<span class="muted">Untitled spec</span>'}</div>
      <div class="row-meta">${typeChip(s)}${badge}${agentChip(s)}<span>${n} document${n === 1 ? '' : 's'}</span><span>${s.fetchedAt && !S.hasUnreleased(s) ? 'Agent fetched ' + ago(Date.parse(s.fetchedAt)) : 'Edited ' + ago(touched(s))}</span></div>
    </a>`;
  }).join('');
}

export function listPane(selected) {
  const specs = S.all('spec');
  const n = (f) => specs.filter(f).length;
  const f = (key, label, count) => `<button class="filter" type="button" data-act="filter" data-v="${key}" aria-pressed="${ui.filter === key}">${label} ${count}</button>`;
  return `${bar('Specs', S.can('write') ? `<button class="btn primary only-desktop" data-act="new-spec">${ic.plus(14)} New</button>` : '')}
    <div class="listtools"><div class="search">${ic.search()}<label class="sr" for="search">Search specs</label><input id="search" type="search" placeholder="Search specs" value="${esc(ui.q)}"></div>
      <div class="filters">${f('all', 'All', specs.length)}${f('draft', 'Draft', n((s) => s.status !== 'approved'))}${f('approved', 'Approved', n((s) => s.status === 'approved'))}
        <select id="typeFilter" class="filter sel" aria-label="Filter by type"><option value="">All types</option>${S.specTypes().map((t) => `<option value="${esc(t.key)}" ${ui.typeFilter === t.key ? 'selected' : ''}>${esc(t.label)}${specs.some((x) => x.specType === t.key) ? '' : ' (none)'}</option>`).join('')}</select></div></div>
    <div class="list" id="list">${specRows(selected)}</div>
    ${S.can('write') ? `<button class="fab" data-act="new-spec" aria-label="New spec">${ic.plus()}New spec</button>` : ''}`;
}

// ------------------------------------------------------------------ documents: foundation + folder tree
export function foundState(d) {
  if (!hasContent(d.body)) return { chip: '<span class="chip">Not written yet</span>', live: false };
  if (d.status === 'approved' && !S.hasUnreleased(d)) return { chip: `<span class="chip ok">Live v${d.version}</span>`, live: true };
  return { chip: `<span class="chip warn">${S.team()?.foundationAuto === false ? 'Needs approval' : 'Going live…'}</span>`, live: false };
}
const termCount = () => glossaryTerms().length;
function foundRow(d, selected) {
  const gl = d.id === 'glossary.md';
  const st = foundState(d);
  const label = CORE_LABEL[d.id] ?? d.id;
  const sub = gl ? `${termCount()} term${termCount() === 1 ? '' : 's'}` : d.core ? (hasContent(d.body) ? 'Always available to agents' : 'Write it once – agents always get it') : 'Pinned document';
  return `<a class="found ${selected === d.id ? 'active' : ''}" href="${gl ? '#/glossary' : `#/doc/${encodeURIComponent(d.id)}`}"><span class="fi">${gl ? ic.glossary(18) : d.id === 'vision.md' ? ic.release(18) : ic.file(18)}</span><span class="fb"><b>${esc(label)}</b><span>${esc(sub)}</span></span>${st.chip}</a>`;
}

function buildTree() {
  const root = { folders: new Map(), docs: [] };
  const node = (path) => path.split('/').filter(Boolean).reduce((n, seg) => { if (!n.folders.has(seg)) n.folders.set(seg, { folders: new Map(), docs: [] }); return n.folders.get(seg); }, root);
  for (const p of S.folderPaths()) node(p);
  for (const d of S.all('doc').filter((x) => !x.pinned)) node(S.folderOf(d.id)).docs.push(d);
  return root;
}
const countDocs = (n) => n.docs.length + [...n.folders.values()].reduce((a, f) => a + countDocs(f), 0);

export function docRows(selected) {
  const found = S.foundationDocs().filter((d) => d.id !== 'glossary.md'); // the glossary has its own page in the navigation
  const render = (node, prefix, depth) => {
    let html = '';
    for (const [name, child] of [...node.folders].sort((a, b) => a[0].localeCompare(b[0]))) {
      const path = prefix ? `${prefix}/${name}` : name;
      const open = ui.openFolders[path] !== false;
      html += `<div class="frow" style="--d:${depth}"><button type="button" class="ftoggle" data-act="toggle-folder" data-path="${esc(path)}" aria-expanded="${open}">${ic.chevron(14)}${ic.folder(16)}<span>${esc(name)}</span><small>${countDocs(child)}</small></button>
        ${S.can('write') ? `<button type="button" class="fbtn" data-act="new-doc-in" data-path="${esc(path)}" aria-label="New document in ${esc(path)}" title="New document here">${ic.plus(16)}</button><button type="button" class="fbtn" data-act="folder-menu" data-path="${esc(path)}" aria-label="Folder actions for ${esc(path)}">${ic.more(18)}</button>` : ''}</div>`;
      if (open) html += render(child, path, depth + 1);
    }
    for (const d of node.docs.sort((a, b) => a.id.localeCompare(b.id))) {
      const used = S.usedBy(d.id);
      html += `<a class="row docrow ${selected === d.id ? 'active' : ''}" style="--d:${depth}" href="#/doc/${encodeURIComponent(d.id)}">
        <div class="row-top"><span class="row-title mono" style="font-size:13.5px">${esc(S.baseName(d.id))}</span>${itemSync(d)}</div>
        <div class="row-meta"><span>${used.length ? 'Used by ' + used.map((u) => esc(u.id)).join(', ') : 'Not linked to a spec'}</span><span>Edited ${ago(touched(d))}</span></div></a>`;
    }
    return html;
  };
  const tree = buildTree();
  return `<div class="sect-title" style="margin-top:6px"><span>Foundation · always available to agents</span></div>${found.map((d) => foundRow(d, selected)).join('')}
    <div class="sect-title" style="margin-top:14px"><span>Documents</span><small>${S.all('doc').filter((d) => !d.pinned).length}</small></div>
    ${tree.folders.size || tree.docs.length ? render(tree, '', 0) : '<div class="empty">No documents yet.<br>Add ADRs, schemas or notes and link them to specs. Organise them in folders.</div>'}`;
}
const newMenu = () => `<div class="dd"><button type="button" class="btn primary" data-act="dd-toggle" aria-haspopup="menu" aria-expanded="false">${ic.plus(14)} New ${ic.chevron(14)}</button>
  <div class="dd-menu" role="menu" aria-label="New" hidden>
    <button type="button" role="menuitem" data-act="new-doc">${ic.file(16)}<span>Document</span></button>
    <button type="button" role="menuitem" data-act="new-folder">${ic.folderPlus(16)}<span>Folder <small>with README.md</small></span></button>
  </div></div>`;
export const docsPane = (selected) => `${bar('Documents', S.can('write') ? newMenu() : '')}<div class="list" id="list" style="padding-top:8px">${docRows(selected)}</div>`;

// ------------------------------------------------------------------ glossary: list (folders) + detail
const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** All definitions found in the working copies of the active team, grouped by term (case-insensitive). */
export function glossaryTerms() {
  const model = S.glossaryModel();
  const map = new Map();
  for (const it of S.state.items.values()) {
    if (it.del || it.kind === 'folder') continue;
    for (const d of parseDefinitions(it.body)) {
      const k = d.term.toLowerCase();
      if (!map.has(k)) map.set(k, { term: d.term, defs: [] });
      map.get(k).defs.push({ ...d, item: it, folder: it.id === 'glossary.md' ? (model.where.get(k) ?? '') : null });
    }
  }
  return [...map.values()].sort((a, b) => a.term.localeCompare(b.term));
}
const termIndex = (terms) => {
  const idx = new Map();
  for (const t of terms) { idx.set(t.term.toLowerCase(), t.term); for (const d of t.defs) for (const a of d.aliases) if (!idx.has(a.toLowerCase())) idx.set(a.toLowerCase(), t.term); }
  return idx;
};
export const glossaryHref = (term) => `#/glossary/${encodeURIComponent(term)}`;
const termRef = (name, idx, label) => {
  const known = idx.get(name.toLowerCase());
  return `<a href="${glossaryHref(known ?? name)}" class="termref${known ? '' : ' broken'}" title="${known ? `Open “${esc(known)}”` : 'Not defined in this glossary yet'}">${esc(label ?? name)}</a>`;
};
const linkify = (text, idx) => esc(text).replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g, (_m, t, label) => termRef(t.trim(), idx, (label ?? t).trim()));
const plain = (text) => String(text).replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g, (_m, t, l) => (l ?? t).trim());

function mentions(t, ownIds) {
  const names = [t.term, ...new Set(t.defs.flatMap((d) => d.aliases))];
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${names.map(escRe).join('|')})(?![\\p{L}\\p{N}])`, 'iu');
  return [...S.all('spec'), ...S.all('doc')].filter((it) => !ownIds.has(it.id) && it.id !== 'glossary.md' && re.test(it.body));
}
const groupOf = (t) => { const own = t.defs.find((d) => d.item.id === 'glossary.md'); return own ? own.folder : '__specs'; };

/** Rows of the term list: terms grouped under the section headings of glossary.md ("folders"). */
export function glossaryListRows(selected) {
  const all = glossaryTerms();
  const q = ui.gq.trim().toLowerCase();
  const terms = all.filter((t) => !q || t.term.toLowerCase().includes(q) || t.defs.some((d) => d.definition.toLowerCase().includes(q) || d.aliases.some((a) => a.toLowerCase().includes(q))));
  const sel = (selected ?? '').toLowerCase();
  const selCanon = termIndex(all).get(sel) ?? selected;
  const model = S.glossaryModel();
  const groups = new Map([['', { label: 'General', terms: [] }], ...model.folders.map((f) => [f, { label: f, terms: [] }]), ['__specs', { label: 'In specs & documents', terms: [] }]]);
  for (const t of terms) (groups.get(groupOf(t)) ?? groups.get('')).terms.push(t);
  if (!all.length) return `<div class="empty">No terms yet.<br>Create one with “New”, add a “Definition” block to any spec, or import terms from the global glossary.</div>`;
  if (!terms.length) return `<div class="empty">No terms match.</div>`;
  const flat = !model.folders.length && !groups.get('__specs').terms.length;
  const row = (t) => {
    const aliases = [...new Set(t.defs.flatMap((d) => d.aliases))];
    const global = t.defs.some((d) => d.origin);
    const first = t.defs[0]?.definition ?? '';
    return `<a class="row ${selCanon && t.term.toLowerCase() === String(selCanon).toLowerCase() ? 'active' : ''}" href="${glossaryHref(t.term)}">
      <div class="row-top"><span class="row-title">${esc(t.term)}</span>${global ? '<span class="chip">Global</span>' : ''}</div>
      <div class="row-meta"><span class="gl-ex">${esc(plain(first).length > 90 ? plain(first).slice(0, 90) + '…' : plain(first))}</span>${aliases.length ? `<span class="muted">aka ${aliases.slice(0, 2).map(esc).join(', ')}${aliases.length > 2 ? ' …' : ''}</span>` : ''}</div></a>`;
  };
  let html = '';
  for (const [key, g] of groups) {
    if (!g.terms.length && (key === '' || key === '__specs' || q)) continue;
    if (flat) { html += g.terms.map(row).join(''); continue; }
    const id = `gl:${key}`;
    const open = ui.openFolders[id] !== false;
    html += `<div class="frow" style="--d:0"><button type="button" class="ftoggle" data-act="toggle-folder" data-path="${esc(id)}" aria-expanded="${open}">${ic.chevron(14)}${ic.folder(16)}<span>${esc(g.label)}</span><small>${g.terms.length}</small></button>
      ${S.can('write') && key && key !== '__specs' ? `<button type="button" class="fbtn" data-act="gl-folder-menu" data-name="${esc(key)}" aria-label="Folder actions for ${esc(key)}">${ic.more(18)}</button>` : ''}</div>`;
    if (open) html += g.terms.map(row).join('');
  }
  return html;
}

const glNewMenu = () => `<div class="dd"><button type="button" class="btn primary" data-act="dd-toggle" aria-haspopup="menu" aria-expanded="false">${ic.plus(14)} New ${ic.chevron(14)}</button>
  <div class="dd-menu" role="menu" aria-label="New" hidden>
    <button type="button" role="menuitem" data-act="new-term">${ic.book(16)}<span>Term</span></button>
    <button type="button" role="menuitem" data-act="gl-folder-new">${ic.folderPlus(16)}<span>Folder</span></button>
    <div class="dd-sep"></div>
    <button type="button" role="menuitem" data-act="gl-import">${ic.glossary(16)}<span>Import from global glossary…</span></button>
    <a role="menuitem" href="#/doc/glossary.md" class="ddlink">${ic.file(16)}<span>Open as Markdown</span></a>
  </div></div>`;

export const glossaryList = (selected) => `${bar('Glossary', S.can('write') ? glNewMenu() : '')}
  <div class="listtools"><div class="search">${ic.search()}<label class="sr" for="gsearch">Search terms</label><input id="gsearch" type="search" placeholder="Search terms and synonyms" value="${esc(ui.gq)}"></div></div>
  <div class="list" id="glList">${glossaryListRows(selected)}</div>`;

/** The right-hand pane: one term with its definition(s), synonyms, references and provenance. */
export function glossaryDetail(arg) {
  const all = glossaryTerms();
  const idx = termIndex(all);
  const canon = idx.get(arg.toLowerCase());
  const t = canon && all.find((x) => x.term.toLowerCase() === canon.toLowerCase());
  const can = S.can('write');
  if (!t) {
    return `<div class="gdetail" id="glDetail"><header class="bar"><a class="icon-btn back" href="#/glossary" aria-label="Back">${ic.back()}</a><h1>${esc(arg)}</h1></header>
      <div class="scroll"><div class="page"><div class="empty" style="padding:24px 0">“${esc(arg)}” is not defined in this glossary yet.${can ? `<br><br><button class="btn primary" data-act="new-term" data-term="${esc(arg)}">${ic.plus(14)} Define “${esc(arg)}”</button>` : ''}</div></div></div></div>`;
  }
  const own = t.defs.find((d) => d.item.id === 'glossary.md');
  const aliases = [...new Set(t.defs.flatMap((d) => d.aliases))];
  const referencedBy = all.filter((o) => o !== t && o.defs.some((d) => [...d.see, ...d.refs].some((r) => (idx.get(r.toLowerCase()) ?? r).toLowerCase() === t.term.toLowerCase()))).map((o) => o.term);
  const related = [...new Set(t.defs.flatMap((d) => [...d.see, ...d.refs]))].filter((r) => r.toLowerCase() !== t.term.toLowerCase());
  const used = mentions(t, new Set(t.defs.map((d) => d.item.id)));
  const clash = new Set(t.defs.map((d) => d.definition)).size > 1;

  if (ui.glEdit && own && can) {
    const folders = S.glossaryModel().folders;
    return `<div class="gdetail" id="glDetail"><header class="bar"><a class="icon-btn back" href="${glossaryHref(t.term)}" data-act="gl-cancel" aria-label="Cancel">${ic.back()}</a><h1>Edit term</h1></header>
      <div class="scroll"><div class="page"><form id="glEditForm" class="form" data-old="${esc(t.term)}">
        <label class="sr" for="gd-term">Term</label><input id="gd-term" class="field" value="${esc(own.item ? t.term : '')}" required maxlength="80" autocomplete="off">
        <label class="sr" for="gd-def">Definition</label><textarea id="gd-def" class="field" style="height:150px;padding:12px" placeholder="Definition – reference other terms with [[Term]]" required>${esc(own.definition)}</textarea>
        <label class="sr" for="gd-aliases">Also known as</label><input id="gd-aliases" class="field" placeholder="Also known as (comma separated)" value="${esc(own.aliases.join(', '))}" autocomplete="off">
        <label class="sr" for="gd-see">See also</label><input id="gd-see" class="field" placeholder="See also (comma separated terms)" value="${esc(own.see.join(', '))}" autocomplete="off">
        <label class="sr" for="gd-folder">Folder</label><select id="gd-folder" class="field"><option value="">General (no folder)</option>${folders.map((f) => `<option ${f === own.folder ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select>
        ${own.origin ? '<p class="note">Imported from the global glossary. Your changes stay local; “Update available” later will offer to replace them.</p>' : ''}
        <div class="btns"><button class="btn primary" type="submit">Save</button><button type="button" class="btn" data-act="gl-cancel">Cancel</button></div></form></div></div></div>`;
  }

  const defs = t.defs.map((d) => {
    const o = S.parseOrigin(d.origin);
    const g = o && S.state.globalTerms.find((x) => x.id === o.id);
    const upd = o && g && g.rev > o.rev;
    return `<section class="gd-def"><p>${linkify(d.definition, idx)}</p>
      <div class="gd-src"><span>Defined in</span><a class="src" href="#/${d.item.kind}/${encodeURIComponent(d.item.id)}">${esc(d.item.id)}</a>${d.folder ? `<span class="muted">· ${esc(d.folder)}</span>` : ''}${o ? '<span class="chip">Global</span>' : ''}${upd ? '<span class="chip warn">Update available</span>' : ''}${o && !g && S.state.globalTerms.length ? '<span class="chip">Removed from global glossary</span>' : ''}
      ${upd && can && d.item.id === 'glossary.md' ? `<button type="button" class="btn small" data-act="gl-update" data-gid="${esc(g.id)}">Update from global</button>` : ''}</div></section>`;
  }).join('');

  return `<div class="gdetail" id="glDetail"><header class="bar"><a class="icon-btn back" href="#/glossary" aria-label="Back">${ic.back()}</a><h1>${esc(t.term)}</h1>
      ${clash ? '<span class="chip warn">conflicting definitions</span>' : ''}${own && can ? `<button class="btn" data-act="gl-edit">Edit</button><button class="btn" data-act="gl-delete" data-term="${esc(t.term)}" style="color:var(--red);border-color:var(--red-line)">Delete</button>` : ''}</header>
    <div class="scroll"><div class="page gd">
      ${aliases.length ? `<div class="relrow"><span>Also known as</span>${aliases.map((a) => `<span class="gd-alias">${esc(a)}</span>`).join('')}</div>` : ''}
      ${defs}
      ${!own && can ? `<div class="card"><p class="note">This term is defined in a spec or document. Edit it there, or add it to the glossary to manage it here (the original stays untouched).</p><div class="btns"><button class="btn small" data-act="gl-adopt" data-term="${esc(t.term)}">Add to glossary</button></div></div>` : ''}
      ${related.length ? `<div class="relrow"><span>See also</span>${related.map((r) => termRef(r, idx)).join('')}</div>` : ''}
      ${referencedBy.length ? `<div class="relrow"><span>Referenced by</span>${referencedBy.map((r) => termRef(r, idx)).join('')}</div>` : ''}
      ${used.length ? `<div class="relrow"><span>Used in</span>${used.slice(0, 8).map((it) => `<a class="src" href="#/${it.kind}/${encodeURIComponent(it.id)}">${esc(it.id)}</a>`).join('')}${used.length > 8 ? `<small class="muted">+${used.length - 8} more</small>` : ''}</div>` : ''}
    </div></div></div>`;
}

/** Rows of the import dialog: global terms, minus the ones the team already defines. */
export function gimportRows(q, sel) {
  const have = new Set(glossaryTerms().flatMap((t) => [t.term.toLowerCase(), ...t.defs.flatMap((d) => d.aliases.map((a) => a.toLowerCase()))]));
  const list = S.state.globalTerms.filter((g) => !q || `${g.term} ${g.aliases.join(' ')} ${g.definition}`.toLowerCase().includes(q.toLowerCase()));
  if (!list.length) return `<p class="note" style="padding:12px 0">${S.state.globalTerms.length ? 'No terms match.' : 'The global glossary is empty. An instance admin can add terms under Admin.'}</p>`;
  return list.map((g) => {
    const taken = have.has(g.term.toLowerCase());
    return `<label class="gi-row ${taken ? 'off' : ''}"><input type="checkbox" class="gi-check" value="${esc(g.id)}" ${taken ? 'disabled' : ''} ${sel?.has(g.id) ? 'checked' : ''}>
      <span class="gi-body"><b>${esc(g.term)}${g.aliases.length ? ` <small class="muted">also: ${g.aliases.map(esc).join(', ')}</small>` : ''}</b><span>${esc(g.definition.length > 140 ? g.definition.slice(0, 140) + '…' : g.definition)}</span>${taken ? '<small class="muted">Already in your glossary</small>' : ''}</span></label>`;
  }).join('');
}

// ------------------------------------------------------------------ editor
export const statusChip = (i) => {
  if (i.kind === 'doc') return i.pinned ? `<span class="chip">Foundation</span>${foundState(i).chip}` : '';
  return i.approve ? '<span class="chip warn">Approval queued</span>' : i.status === 'approved' ? `<span class="chip ok">Approved v${i.version}${S.hasUnreleased(i) ? ' · edited' : ''}</span>` : '<span class="chip">Draft</span>';
};
export const chipsHtml = (i) => (i.kind === 'spec' ? typeChip(i) : '') + statusChip(i) + agentChip(i);

export function saveState(i) {
  if (!S.can('write')) return 'ro';
  if (i.conflict) return 'conflict';
  if (i.syncError) return 'error';
  return S.isPending(i) ? 'dirty' : 'synced';
}
export function saveInd(i) {
  const st = saveState(i);
  const txt = { ro: `View only · your role (${S.team()?.role}) cannot edit`, conflict: 'Conflict with server', error: i.syncError, dirty: 'Saved on device · not synced', synced: 'Synced' }[st];
  const icon = { ro: ic.file(14), conflict: ic.warn(14), error: ic.warn(14), dirty: ic.phone(), synced: ic.check(14) }[st];
  return `<span class="save-ind ${st === 'dirty' ? 'dirty' : ''} ${st === 'conflict' || st === 'error' ? 'bad' : ''}" role="status" title="${esc(txt)}">${icon}<span class="lbl">${esc(txt)}</span></span>`;
}
export function approveBtn(i) {
  if (i.kind === 'doc' && i.pinned) {
    const auto = S.team()?.foundationAuto !== false;
    if (!S.can('approve')) return `<span class="muted hint">${auto ? 'Goes live automatically after you stop typing' : 'An approver publishes this'}</span>`;
    if (i.approve) return `<button class="approve queued" data-act="cancel-approve" type="button">${ic.clock()}Publish queued</button>`;
    if (foundState(i).live || !hasContent(i.body)) return `<span class="muted hint">${hasContent(i.body) ? `Live v${i.version}` : 'Empty – not published'}</span>`;
    return `<button class="approve" data-act="approve" type="button">Publish now${ic.check(16)}</button>`;
  }
  if (i.kind !== 'spec') return `<span class="muted hint">Released with the specs that link it</span>`;
  if (!S.can('approve')) return `<span class="muted hint">${i.status === 'approved' ? `Approved v${i.version}` : 'An approver releases this'}</span>`;
  if (i.approve) return `<button class="approve queued" data-act="cancel-approve" type="button">${ic.clock()}Approval queued</button>`;
  if (i.status === 'approved' && !S.hasUnreleased(i)) return `<button class="approve done" disabled type="button">Approved v${i.version}${ic.check(16)}</button>`;
  return `<button class="approve" data-act="approve" type="button">${i.status === 'approved' ? `Approve v${i.version + 1}` : 'Approve'}${ic.check(16)}</button>`;
}
/** Linked documents of a spec as a dropdown in the bar (documents show who uses them instead). */
export function docsDd(i, open = false) {
  if (i.kind !== 'spec') {
    const used = S.usedBy(i.id);
    return i.pinned ? '' : `<span class="muted hint docinfo">${used.length ? 'Used by ' + used.map((s) => esc(s.id)).join(', ') : 'Not linked to a spec yet'}</span>`;
  }
  const n = i.links.length;
  const docs = S.all('doc').filter((d) => !d.pinned || i.links.includes(d.id)).sort((a, b) => a.id.localeCompare(b.id));
  const can = S.can('write');
  return `<div class="dd" id="docsDd"><button type="button" class="docsbtn" data-act="dd-toggle" aria-haspopup="menu" aria-expanded="${open}" aria-label="Linked documents: ${n}">${ic.file(15)}<span class="lbl">${n} document${n === 1 ? '' : 's'}</span><span class="cnt">${n}</span>${ic.chevron(14)}</button>
    <div class="dd-menu docs-menu" role="menu" aria-label="Linked documents" ${open ? '' : 'hidden'}>
      <div class="dd-title">Linked documents · released with this spec</div>
      ${docs.length ? docs.map((d) => { const on = i.links.includes(d.id); return `<div class="ddrow"><button type="button" role="menuitemcheckbox" aria-checked="${on}" data-act="dd-link" data-id="${esc(d.id)}" ${can ? '' : 'disabled'}><span class="box ${on ? 'on' : ''}">${on ? ic.check(11) : ''}</span><span class="mono">${esc(d.id)}</span></button><a class="fbtn" href="#/doc/${encodeURIComponent(d.id)}" aria-label="Open ${esc(d.id)}" title="Open">${ic.back().replace('M15 5l-7 7 7 7', 'M9 5l7 7-7 7')}</a></div>`; }).join('') : '<div class="dd-empty">No documents yet.</div>'}
      ${can ? `<div class="dd-sep"></div><button type="button" role="menuitem" data-act="new-doc-link">${ic.plus(14)}<span>New document…</span></button>` : ''}
    </div></div>`;
}
export const conflictBanner = (i) =>
  i.conflict ? `<div class="card bad banner"><div class="grow"><b>Changed on the server</b><span>Your edits and the server version differ.</span></div><button class="btn danger" data-act="conflict" data-id="${esc(i.id)}">Review</button></div>` : '';

export const rawMode = (i) => i.kind === 'doc' && !i.id.endsWith('.md');

export function editorPane(i) {
  const isSpec = i.kind === 'spec';
  const ro = !S.can('write');
  const path = isSpec ? `${S.team().key}/${i.id}.md` : `docs/${i.id}`;
  const back = isSpec ? '#/' : i.id === 'glossary.md' ? '#/glossary' : '#/docs';
  return `<div class="editor" data-editor="${esc(i.id)}">
    <header class="bar ed-bar">
      <a class="icon-btn back" href="${back}" aria-label="Back">${ic.back()}</a>
      ${isSpec ? `<label class="sr" for="title">Title</label><input id="title" class="ed-title" placeholder="Spec title" value="${esc(i.title)}" autocomplete="off" title="${esc(path)}" ${ro ? 'readonly' : ''}>` : `<h1 class="ed-title" title="${esc(path)}" style="${i.core ? '' : 'font-family:var(--mono);font-size:15px'}">${esc(CORE_LABEL[i.id] ?? i.id)}</h1>`}
      <span id="chips" class="barchips">${chipsHtml(i)}</span>
      <span id="docsSlot">${docsDd(i)}</span>
      <span id="saveInd" data-state="${saveState(i)}">${saveInd(i)}</span>
      <span id="approveSlot">${approveBtn(i)}</span>
      <button type="button" class="icon-btn" data-act="item-menu" aria-label="More actions" aria-haspopup="menu">${ic.more()}</button>
    </header>
    <div id="banner">${conflictBanner(i)}</div>
    <div id="editorBody" class="ed-scroll"></div>
    <div class="toolbar"><div class="tools" id="tools"></div></div>
  </div>`;
}
export function toolsHtml(i) {
  if (!S.can('write')) return '';
  const blocksMode = ui.mode === 'blocks' && !rawMode(i);
  const isSpec = i.kind === 'spec';
  return blocksMode
    ? `<button type="button" data-act="t-add" aria-label="Add block" title="Add block at cursor">${ic.plus(20)}</button>
       <button type="button" data-act="t-h2" aria-label="Heading" title="Heading">H</button>
       ${isSpec ? `<button type="button" data-act="t-req" aria-label="Requirement" title="Requirement">R+</button>` : ''}
       <button type="button" data-act="t-task" aria-label="Checklist item" title="Checklist item">${ic.box()}</button>
       <button type="button" data-act="t-def" aria-label="Definition" title="Definition (glossary term)">${ic.book(20)}</button>
       ${isSpec && i.specType === 'api' ? `<button type="button" data-act="t-endpoint" aria-label="API endpoint" title="API endpoint">${ic.api()}</button>` : ''}
       <button type="button" data-act="t-diagram" aria-label="Diagram" title="Diagram">${ic.diagram()}</button>
       ${isSpec ? `<button type="button" class="at" data-act="t-ref" aria-label="Reference a document" title="Reference a document">@</button>` : ''}`
    : isSpec ? `<button type="button" class="at" data-act="t-ref" aria-label="Reference a document">@</button>` : '';
}

// ------------------------------------------------------------------ release
export function releasePage() {
  const st = S.state;
  const pending = S.all('spec').filter((s) => s.approve);
  const released = S.all('spec').filter((s) => s.status === 'approved').sort((a, b) => a.id.localeCompare(b.id));
  const online = st.online && !st.error && !st.sessionExpired;
  const url = st.mcpUrl;
  const g = ui.teamInfo?.git;
  const gitLine = !g ? '' : !g.url ? 'No Git remote connected for this team.' : g.lastOk === false ? `Last push failed: ${esc(g.lastError ?? '')}` : g.lastPushAt ? `Pushed ${ago(Date.parse(g.lastPushAt))}${g.lastError ? ' – ' + esc(g.lastError) : ''}` : 'Connected, nothing pushed yet.';
  const found = S.foundationDocs();
  return `${bar('Release')}${page(`
      <section class="card">
        <div class="card-head"><h2>Agent endpoint</h2><span class="st" style="${online ? 'color:var(--green);font-weight:600' : 'color:var(--amber);font-weight:600'}">● ${online ? 'Server online' : 'Server unreachable'}</span></div>
        <div class="mono" style="font-size:13px;color:var(--soft);word-break:break-all">${esc(url)}</div>
        <div class="code">claude mcp add --transport http specs-${esc((S.team()?.key ?? 'team').toLowerCase())} ${esc(url)}</div>
        <p class="note">Claude opens a browser to sign in; choose <b style="color:var(--text)">${esc(teamName())}</b> on the consent screen. Without OAuth: <a href="#/account" style="color:var(--green)">create a token</a>. Agents act with the rights of the person who connected them.</p>
        <div class="btns"><button class="btn small" data-act="copy-url">Copy URL</button><a class="btn small" href="#/account">Manage tokens</a></div>
      </section>
      <section class="card"><div class="card-head"><h2>Always available to agents</h2></div>
        ${found.map((d) => `<div class="kv"><a href="${d.id === 'glossary.md' ? '#/glossary' : `#/doc/${encodeURIComponent(d.id)}`}">${esc(CORE_LABEL[d.id] ?? d.id)}</a><span>${foundState(d).chip}</span></div>`).join('')}
        <p class="note">Served via <span class="mono">get_team_context</span> as soon as they contain something${S.team()?.foundationAuto === false ? ' and have been approved' : ' – they go live automatically after edits'}.</p></section>
      <section class="card"><div class="card-head"><h2>${ic.git(16)} Git repository</h2>${g?.url ? `<span class="st ${g.lastOk === false ? 'bad' : ''}">${g.lastOk === false ? ic.warn() : ic.check()} ${g.lastOk === false ? 'Failed' : g.lastPushAt ? 'Pushed' : 'Connected'}</span>` : ''}</div>
        <p class="note">${g?.url ? `<span class="mono">${esc(g.url)}</span> · branch <span class="mono">${esc(g.branch)}</span> · folder <span class="mono">${esc(g.root)}/</span><br>` : ''}${gitLine}</p>
        <div class="btns">${g?.url && S.can('approve') ? '<button class="btn small" data-act="git-push">Push now</button>' : ''}<a class="btn small" href="#/team">${S.can('admin') ? 'Git settings' : 'Team'}</a></div>
      </section>
      ${pending.map((s) => `<section class="card warn"><span style="color:var(--amber)">${ic.up(20)}</span><div class="grow"><b>${esc(s.id)} approved on this device</b><span>Available to your agent after sync.</span></div></section>`).join('')}
      <section>
        <div class="sect-title"><span>Released specs</span><small>${released.length} approved</small></div>
        ${released.length ? released.map((s) => `<div class="rel"><div class="grow"><b>${typeChip(s)} ${esc(s.title)}${S.hasUnreleased(s) ? ' <span class="chip warn" style="margin-left:4px">edited since release</span>' : ''}</b><span><span class="mono">${esc(s.id)}</span> · v${s.version}${s.releasedBy ? ' by ' + esc(s.releasedBy) : ''} · ${s.links.length} document${s.links.length === 1 ? '' : 's'} · ${s.fetchedAt ? 'fetched ' + ago(Date.parse(s.fetchedAt)) : 'never fetched'}</span></div>
          ${!S.can('approve') ? '' : s.revoke ? `<button class="btn small" data-act="undo-revoke" data-id="${esc(s.id)}">Undo revoke</button>` : `<button class="btn small" data-act="revoke" data-id="${esc(s.id)}">Revoke</button>`}</div>`).join('') : '<div class="empty" style="padding:16px 0">Nothing released yet. Approve a spec in the editor.</div>'}
      </section>
      <section><div class="sect-title"><span>What the agent can call</span></div>
        <div class="code">get_team_context()            # vision, strategy, glossary\nlist_specs()\nget_spec("SPEC-012", version?)\nlist_documents(folder?)\nget_document("adr/ADR-007.md")\nget_glossary(term?)\n# tokens with draft access also get: include_drafts / draft=true</div></section>`)}`;
}

// ------------------------------------------------------------------ sync
export function syncPage() {
  const st = S.state;
  const q = S.queue();
  const conf = S.conflicts();
  const others = S.otherTeams().filter((t) => t.pending || t.conflicts);
  return `${bar('Sync')}${page(`
      <section class="card">
        <div class="card-head"><h2>${st.sessionExpired ? 'Signed out' : !st.online ? 'Offline' : st.syncing ? 'Syncing…' : 'Online'}</h2><span class="muted" style="font-size:12px">${st.lastSync ? 'Last sync ' + ago(st.lastSync) : 'Never synced'}</span></div>
        <p class="note">Everything is saved on this device and syncs when your server is reachable. Approved specs reach your agent after the next sync.</p>
        <span class="mono" style="font-size:13px;color:var(--soft)">${esc(location.origin)}</span>
        <span class="muted" style="font-size:13px">Signed in as ${esc(st.me?.name)}${S.team() ? ` · ${esc(S.team().name)} (${esc(S.team().role)})` : ''}</span>
        ${st.error ? `<span class="err-text">${esc(st.error)}</span>` : ''}
        <div class="btns"><button class="btn primary" data-act="retry" ${st.syncing ? 'disabled' : ''}>Retry now</button>${st.sessionExpired ? '<button class="btn" data-act="relogin">Sign in</button>' : ''}</div>
      </section>
      <section>
        <div class="sect-title"><span>Waiting to sync · ${esc(teamName())}</span><small style="color:${q.length ? 'var(--amber)' : 'var(--muted)'}">${q.length} change${q.length === 1 ? '' : 's'}</small></div>
        ${q.length ? q.map((c) => `<div class="q"><div class="l"><span>${esc(c.what)}</span><span>${esc(c.id)}</span>${c.error ? `<span class="err">${esc(c.error)}</span>` : ''}</div><span class="r">${esc(ago(c.at))}</span></div>`).join('') : '<div class="kv" style="border-bottom:1px solid var(--line)"><span class="muted">Nothing waiting — all changes are on the server.</span></div>'}
        ${others.map((t) => `<div class="kv"><span>${esc(t.name)}</span><span style="color:var(--amber)">${t.pending} pending${t.conflicts ? ` · ${t.conflicts} conflict(s)` : ''}</span></div>`).join('')}
      </section>
      ${conf.map((c) => `<section class="card bad"><span style="color:var(--red)">${ic.warn(20)}</span><div class="grow"><b>Conflict in ${esc(c.id)}</b><span>Changed on the server and on this device.</span></div><button class="btn danger" data-act="conflict" data-id="${esc(c.id)}">Review</button></section>`).join('')}
      <section><div class="sect-title"><span>Storage</span></div>
        <div class="kv"><span>Format</span><span>Markdown files in a Git repo per team</span></div>
        <div class="kv"><span>On this device</span><span>${S.all('spec').length} specs · ${S.all('doc').length} documents</span></div>
        <div class="kv"><span>Offline app</span><span>${'serviceWorker' in navigator && navigator.serviceWorker.controller ? 'Installed' : isSecureContext ? 'Installing…' : 'Needs HTTPS'}</span></div></section>`)}`;
}

// ------------------------------------------------------------------ account
export function accountPage() {
  const me = S.state.me;
  const a = ui.account;
  const online = S.state.online && !S.state.sessionExpired;
  const teams = me.teams;
  const nt = ui.newToken;
  const anyDrafts = teams.some((t) => t.perms.includes('drafts'));
  return `${bar('Account')}${page(`
      <p class="note" style="margin:0">${esc(me.name)} · ${esc(me.email)}${me.admin ? ' · instance admin' : ''}</p>
      ${invites().length ? `<section class="card"><h2>Invitations</h2>${invites().map((i) => `<div class="rel"><div class="grow"><b>${esc(i.teamName)}</b><span>${i.invitedBy ? esc(i.invitedBy) + ' · ' : ''}role ${esc(i.role)}</span></div><button class="btn small" data-act="invite-decline" data-id="${esc(i.id)}">Decline</button><button class="btn primary small" data-act="invite-accept" data-id="${esc(i.id)}">Join</button></div>`).join('')}</section>` : ''}
      <section class="card"><div class="card-head"><h2>Your teams &amp; roles</h2><button class="btn small" data-act="create-team-sheet">${ic.plus(14)} New team</button></div>
        ${teams.length ? teams.map((t) => `<div class="kv"><span>${esc(t.name)} <span class="muted mono">${esc(t.key)}</span></span><span class="chip ok">${esc(t.role)}</span></div>`).join('') : '<div class="muted">You are not a member of any team yet.</div>'}
        ${S.team() ? `<div class="rights">${RIGHTS.map(([k, l]) => `<span class="right ${S.team().perms.includes(k) ? 'yes' : 'no'}">${S.team().perms.includes(k) ? ic.check(12) : '–'} ${esc(l)}</span>`).join('')}</div><p class="note">Rights shown for ${esc(S.team().name)}. Agents you connect act with exactly these rights in the team you choose.</p>` : ''}</section>

      <section class="card"><div class="card-head"><h2>Agent access (MCP)</h2></div>
        <div class="mono" style="font-size:13px;color:var(--soft);word-break:break-all">${esc(S.state.mcpUrl)}</div>
        <p class="note"><b style="color:var(--text)">OAuth (recommended):</b> <span class="mono">claude mcp add --transport http specs ${esc(S.state.mcpUrl)}</span>, then authenticate in the browser and pick the team.</p>
        ${nt ? `<div class="card ok-card"><b>Token “${esc(nt.pat.name)}” for ${esc(nt.pat.teamName)} — copy it now, it is shown only once.</b><div class="code">${esc(nt.token)}</div>
          <div class="code">claude mcp add --transport http specs-${esc(nt.pat.teamName.toLowerCase().replace(/\W+/g, '-'))} ${esc(S.state.mcpUrl)} --header "Authorization: Bearer ${esc(nt.token)}"</div>
          <div class="btns"><button class="btn small" data-act="copy-token">Copy token</button><button class="btn small" data-act="copy-token-cmd">Copy command</button><button class="btn small" data-act="dismiss-token">Done</button></div></div>` : ''}
        <form id="tokenForm" class="form">
          <div class="sect-title" style="margin:4px 0 0"><span>Personal token</span></div>
          <label class="sr" for="tname">Token name</label><input class="field" id="tname" placeholder="Name, e.g. “Laptop – Claude Code”" required maxlength="60" ${online ? '' : 'disabled'}>
          <div class="grid2"><label class="sr" for="tteam">Team</label><select class="field" id="tteam" ${online ? '' : 'disabled'}>${teams.map((t) => `<option value="${esc(t.id)}" ${t.id === S.state.teamId ? 'selected' : ''}>${esc(t.name)} (${esc(t.role)})</option>`).join('')}</select>
            <label class="sr" for="tscope">Access</label><select class="field" id="tscope" ${online ? '' : 'disabled'}><option value="mcp:read">Released specs only</option>${anyDrafts ? '<option value="mcp:read mcp:drafts">Released + drafts</option><option value="mcp:read mcp:drafts mcp:write">Read &amp; write drafts (you approve)</option>' : ''}</select></div>
          <label class="sr" for="tdays">Expires</label><select class="field" id="tdays" ${online ? '' : 'disabled'}><option value="30">30 days</option><option value="90" selected>90 days</option><option value="365">1 year</option></select>
          <button class="btn primary" type="submit" ${online && teams.length ? '' : 'disabled'}>${ic.key(16)} Create token</button>
          ${online ? '' : '<span class="muted" style="font-size:12px">Needs a connection to the server.</span>'}
        </form>
        <div class="sect-title" style="margin:6px 0 0"><span>Your tokens</span><small>${a ? a.tokens.length : '…'}</small></div>
        ${a ? (a.tokens.length ? a.tokens.map((t) => `<div class="rel" style="padding:10px 0"><div class="grow"><b>${esc(t.name)}</b><span class="mono">${esc(t.teamName)} · ${esc(t.prefix)}… · ${esc(scopesText(t.scopes))} · ${t.expired ? 'expired' : 'expires ' + new Date(t.expiresAt).toLocaleDateString()} · ${t.lastUsedAt ? 'used ' + ago(Date.parse(t.lastUsedAt)) : 'never used'}</span></div><button class="btn small" data-act="revoke-token" data-id="${esc(t.id)}">Revoke</button></div>`).join('') : '<div class="muted" style="font-size:13px">No personal tokens.</div>') : '<div class="muted" style="font-size:13px">Loading…</div>'}
        <div class="sect-title" style="margin:6px 0 0"><span>Connected apps (OAuth)</span><small>${a ? a.connections.length : '…'}</small></div>
        ${a ? (a.connections.length ? a.connections.map((c) => `<div class="rel" style="padding:10px 0"><div class="grow"><b>${esc(c.clientName)}</b><span>${esc(c.teamName)} · ${esc(scopesText(c.scopes))} · ${c.lastUsedAt ? 'used ' + ago(Date.parse(c.lastUsedAt)) : 'never used'}</span></div><button class="btn small" data-act="revoke-conn" data-id="${esc(c.id)}">Disconnect</button></div>`).join('') : '<div class="muted" style="font-size:13px">No agents connected via OAuth.</div>') : ''}
      </section>

      <section class="card"><div class="card-head"><h2>Appearance</h2></div>
        <div class="seg" role="group" aria-label="Appearance" style="margin-left:0;align-self:flex-start">${['system', 'light', 'dark'].map((t) => `<button type="button" data-act="set-theme" data-v="${t}" aria-pressed="${themePref() === t}">${themeLabel[t]}</button>`).join('')}</div></section>

      <section class="card"><div class="card-head"><h2>Security</h2></div>
        <form id="pwForm" class="form"><label class="sr" for="pwcur">Current password</label><input class="field" id="pwcur" type="password" placeholder="Current password" autocomplete="current-password" ${online ? '' : 'disabled'}>
          <label class="sr" for="pwnew">New password</label><input class="field" id="pwnew" type="password" placeholder="New password (min. 8 characters)" autocomplete="new-password" minlength="8" ${online ? '' : 'disabled'}>
          <button class="btn" type="submit" ${online ? '' : 'disabled'}>Change password</button></form>
        <button class="btn danger" data-act="logout">${ic.logout(16)} Sign out &amp; remove local data</button>
      </section>`)}`;
}

// ------------------------------------------------------------------ team: general, members + invitations, git, roles
const gitStatus = (g) => (!g.url ? '' : g.lastOk === false ? `<span class="err-text">Last push failed: ${esc(g.lastError ?? '')}</span>` : g.lastPushAt ? `<span class="muted" style="font-size:13px">Last push ${ago(Date.parse(g.lastPushAt))}${g.lastSha ? ' · ' + esc(g.lastSha.slice(0, 7)) : ''}${g.lastError ? ' · ' + esc(g.lastError) : ''}</span>` : '<span class="muted" style="font-size:13px">Nothing pushed yet.</span>');

export function teamPage() {
  const t = S.team();
  const d = ui.teamInfo;
  const admin = S.can('admin');
  const online = S.state.online && !S.state.sessionExpired;
  if (!t) return `${bar('Team')}${noTeamPage()}`;
  const g = d?.git;
  const gitForm = !g ? '<div class="muted">Loading…</div>' : `
    <form id="gitForm" class="form">
      <label class="sr" for="g-url">Repository URL</label><input class="field mono" id="g-url" value="${esc(g.url)}" placeholder="https://github.com/org/product.git  or  git@github.com:org/product.git" autocomplete="off" autocapitalize="off" ${admin ? '' : 'readonly'}>
      <div class="grid2"><label class="sr" for="g-branch">Branch</label><input class="field mono" id="g-branch" value="${esc(g.branch)}" placeholder="Branch" ${admin ? '' : 'readonly'}>
        <label class="sr" for="g-root">Folder</label><input class="field mono" id="g-root" value="${esc(g.root)}" placeholder="Folder in the repo" ${admin ? '' : 'readonly'}></div>
      <label class="sr" for="g-auth">Authentication</label>
      <select class="field" id="g-auth" ${admin ? '' : 'disabled'}><option value="none" ${g.auth === 'none' ? 'selected' : ''}>No authentication (public / local)</option><option value="token" ${g.auth === 'token' ? 'selected' : ''}>HTTPS access token</option><option value="ssh" ${g.auth === 'ssh' ? 'selected' : ''}>SSH deploy key</option></select>
      <div class="grid2 g-token" ${g.auth === 'token' ? '' : 'hidden'}><label class="sr" for="g-user">Username</label><input class="field" id="g-user" value="${esc(g.username)}" placeholder="Username (e.g. x-access-token)" autocomplete="off" ${admin ? '' : 'readonly'}>
        <label class="sr" for="g-token">Access token</label><input class="field" id="g-token" type="password" placeholder="${g.hasSecret && g.auth === 'token' ? '•••••••• saved – type to replace' : 'Access token (write access to the repo)'}" autocomplete="new-password" ${admin ? '' : 'readonly'}></div>
      <div class="g-ssh" ${g.auth === 'ssh' ? '' : 'hidden'}>
        ${g.sshPublicKey ? `<div class="code" aria-label="Public deploy key">${esc(g.sshPublicKey)}</div><p class="note" style="margin-top:6px">Add this public key as a <b style="color:var(--text)">deploy key with write access</b> to the repository, then save and test.</p>` : '<p class="note">No key yet. Generate one and add its public half as a deploy key.</p>'}
        ${admin ? `<div class="btns" style="margin-top:8px"><button type="button" class="btn small" data-act="git-keygen" ${online ? '' : 'disabled'}>${ic.key(14)} ${g.sshPublicKey ? 'Generate a new key' : 'Generate key'}</button>${g.sshPublicKey ? '<button type="button" class="btn small" data-act="copy-pubkey">Copy public key</button>' : ''}</div>` : ''}
      </div>
      <label class="check"><input type="checkbox" id="g-auto" ${g.autoPush ? 'checked' : ''} ${admin ? '' : 'disabled'}> Push automatically after every approval or revoke</label>
      ${gitStatus(g)}${ui.gitResult ? `<span class="${ui.gitResult.ok ? '' : 'err-text'}" style="font-size:13px;${ui.gitResult.ok ? 'color:var(--green)' : ''}">${esc(ui.gitResult.text)}</span>` : ''}
      ${admin ? `<div class="btns"><button class="btn primary" type="submit" ${online ? '' : 'disabled'}>Save</button><button type="button" class="btn" data-act="git-test" ${online && g.url ? '' : 'disabled'}>Test connection</button>${S.can('approve') ? `<button type="button" class="btn" data-act="git-push" ${online && g.url ? '' : 'disabled'}>Push now</button>` : ''}</div>` : (S.can('approve') && g.url ? '<div class="btns"><button type="button" class="btn" data-act="git-push">Push now</button></div>' : '')}
      <p class="note" style="font-size:12px">Specs writes only inside <span class="mono">${esc(g.root)}/</span> (<span class="mono">&lt;ID&gt;.md</span>, <span class="mono">docs/</span>, <span class="mono">GLOSSARY.md</span>); everything else in your repository is left alone. If the branch already has commits they are merged in first; on conflicts in files Specs manages, Specs wins. The folder is locked after the first release.</p>
    </form>`;
  const invite = ui.inviteLink;
  return `${bar('Members & Git')}${page(`
      <section class="card"><div class="card-head"><h2>${esc(t.name)}</h2><span class="chip ok">${esc(t.role)}</span></div>
        <div class="kv"><span>Key <span class="muted">(prefix of spec ids)</span></span><span class="mono">${esc(t.key)}</span></div>
        ${admin ? `<form id="teamNameForm" class="form"><label class="sr" for="tm-name">Team name</label><div class="btns"><input class="field" id="tm-name" value="${esc(t.name)}" maxlength="80" style="flex:3"><button class="btn" type="submit" ${online ? '' : 'disabled'}>Rename</button></div></form>
        <label class="check"><input type="checkbox" id="found-auto" ${t.foundationAuto ? 'checked' : ''}> Publish foundation documents (vision, strategy, glossary …) automatically after edits</label>
        <p class="note" style="margin-top:-6px">Off: they reach agents only after an approver presses “Publish now”.</p>` : ''}
        <div class="btns"><button class="btn small" data-act="leave-team">Leave team</button></div></section>

      <section class="card"><div class="card-head"><h2>Members</h2><small class="muted">${d ? d.members.length : '…'}</small></div>
        ${d ? d.members.map((m) => `<div class="user-main" style="padding:6px 0;border-top:1px solid var(--line)"><span class="avatar">${esc(m.name[0].toUpperCase())}</span><div class="grow"><b>${esc(m.name)}${m.id === S.state.me.id ? ' <span class="chip">you</span>' : ''}${m.disabled ? ' <span class="chip warn">disabled</span>' : ''}</b><span class="muted">${esc(m.email)}</span></div>
          ${admin ? `<label class="sr" for="m-${esc(m.id)}">Role of ${esc(m.name)}</label><select class="field role" id="m-${esc(m.id)}" data-act="member-role" data-id="${esc(m.id)}" ${online ? '' : 'disabled'}>${ROLES.map((r) => `<option ${r === m.role ? 'selected' : ''}>${r}</option>`).join('')}</select><button class="btn small" data-act="member-remove" data-id="${esc(m.id)}" aria-label="Remove ${esc(m.name)}">Remove</button>` : `<span class="chip ok">${esc(m.role)}</span>`}</div>`).join('') : '<div class="muted">Loading…</div>'}
        ${admin ? `<div class="sect-title" style="margin:10px 0 0"><span>Invite people</span></div>
        <form id="inviteForm" class="form"><div class="grid2"><label class="sr" for="inv-email">E-mail</label><input class="field" id="inv-email" type="email" placeholder="colleague@company.com" required><label class="sr" for="inv-role">Role</label><select class="field" id="inv-role">${ROLES.map((r) => `<option ${r === 'editor' ? 'selected' : ''}>${r}</option>`).join('')}</select></div>
          <button class="btn primary" type="submit" ${online ? '' : 'disabled'}>${ic.mail(16)} ${d?.mailEnabled ? 'Send invitation' : 'Create invitation'}</button>
          <p class="note">${d?.mailEnabled ? 'The invitation is sent by e-mail. You also get the one-time link in case it does not arrive.' : 'No mail server is configured: you get a one-time link to send yourself (ask an instance admin to set up e-mail).'}</p></form>
        ${invite ? `<div class="card ok-card"><b>${invite.emailed ? `Invitation e-mailed to ${esc(invite.email)}` : `Invitation for ${esc(invite.email)}`}</b>${invite.emailError ? `<p class="err-text" role="alert">${esc(invite.emailError)}</p>` : ''}<p class="note" style="color:var(--soft)">${invite.userExists ? 'They already have an account and will also see the invitation after signing in. ' : ''}${invite.emailed ? 'You can also send them this one-time link yourself' : 'Send them this one-time link'} (valid 7 days):</p><div class="code">${esc(invite.link)}</div><div class="btns"><button class="btn small" data-act="copy-invite">Copy link</button><button class="btn small" data-act="dismiss-invite">Done</button></div></div>` : ''}
        ${d?.invites?.length ? `<div class="sect-title" style="margin:6px 0 0"><span>Pending invitations</span><small>${d.invites.length}</small></div>${d.invites.map((i) => `<div class="rel" style="padding:8px 0"><div class="grow"><b>${esc(i.email)}</b><span>${esc(i.role)} · invited by ${esc(i.invitedBy ?? '?')} · expires ${new Date(i.expiresAt).toLocaleDateString()}</span></div>${d.mailEnabled ? `<button class="btn small" data-act="invite-resend" data-email="${esc(i.email)}" data-role="${esc(i.role)}">Resend</button>` : ''}<button class="btn small" data-act="invite-revoke" data-id="${esc(i.id)}">Revoke</button></div>`).join('')}` : ''}` : ''}
      </section>

      <section class="card"><div class="card-head"><h2>Spec types</h2>${admin ? `<button class="btn small" data-act="stype-new">${ic.plus(14)} New type</button>` : ''}</div>
        <p class="note">A type gives a new spec its starting structure and tells agents what kind of specification they are reading (<span class="mono">list_specs(type: "api")</span>). Built-in types are fixed; add your own for your team.</p>
        ${d?.types ? d.types.map((t) => `<div class="typerow"><div><b>${esc(t.label)}</b> <small class="muted mono">${esc(t.key)}${t.builtin ? ' · built-in' : ''}</small><p class="muted">${esc(t.description)}</p></div>${admin && !t.builtin ? `<div class="typeacts"><button class="btn small" data-act="stype-edit" data-key="${esc(t.key)}">Edit</button><button class="btn small" data-act="stype-delete" data-key="${esc(t.key)}" style="color:var(--red);border-color:var(--red-line)">Delete</button></div>` : ''}</div>`).join('') : '<div class="muted">Loading…</div>'}</section>

      <section class="card"><div class="card-head"><h2>${ic.git(16)} Git connection</h2></div>${gitForm}</section>

      <section class="card"><h2>Roles &amp; rights</h2>
        <div class="table-wrap"><table class="matrix"><thead><tr><th></th>${ROLES.map((r) => `<th>${r}</th>`).join('')}</tr></thead><tbody>
          ${RIGHTS.map(([k, l]) => `<tr><th scope="row">${esc(l)}</th>${ROLES.map((r) => `<td>${ROLE_RIGHTS[r].includes(k) ? '<span class="yes">✓</span>' : '<span class="no">–</span>'}</td>`).join('')}</tr>`).join('')}
        </tbody></table></div></section>`)}`;
}

// ------------------------------------------------------------------ admin (instance): teams + accounts
export function adminPage() {
  const d = ui.admin;
  const tms = ui.adminTeams;
  return `${bar('Admin')}${page(`
      <p class="note" style="margin:0">People join teams by invitation from a team admin. Here you manage teams and accounts across the whole instance.</p>
      <section class="card"><div class="card-head"><h2>E-mail</h2>${ui.adminMail ? `<span class="chip ${ui.adminMail.enabled ? 'ok' : 'warn'}">${ui.adminMail.enabled ? 'configured' : 'not configured'}</span>` : ''}</div>
        <p class="note">${ui.adminMail?.enabled ? `Invitations are sent from <span class="mono">${esc(ui.adminMail.from)}</span> via <span class="mono">${esc(ui.adminMail.host)}</span>.` : 'Set <span class="mono">SMTP_URL</span> (and <span class="mono">SMTP_FROM</span>) on the server to send invitations by e-mail. Until then team admins copy the invitation link.'}</p>
        ${ui.adminMail?.enabled ? `<div class="btns"><button class="btn small" data-act="mail-test">Send test e-mail to ${esc(S.state.me.email)}</button></div>` : ''}</section>
      <section class="card"><div class="card-head"><h2>Global glossary</h2><div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn small" data-act="gfile-pick">Import file…</button><button class="btn small" data-act="gterm-export" ${ui.adminGlobal?.length ? '' : 'disabled'}>Export</button><button class="btn small" data-act="gterm-new">${ic.plus(14)} New term</button></div><input type="file" id="gfile" accept=".csv,.tsv,.json,.md,.markdown,.txt" hidden aria-label="Glossary file"></div>
        <p class="note">Terms every team can import into its own glossary. Teams keep their own copy and see “Update available” when you change a term here. Import a file with <span class="mono">term, definition, aliases, see</span> columns (CSV), a JSON list, or a Markdown definition list.</p>
        ${ui.adminGlobal ? (ui.adminGlobal.length ? ui.adminGlobal.map((g) => `<div class="rel" style="padding:10px 0"><div class="grow"><b>${esc(g.term)}${g.aliases.length ? ` <small class="muted">also: ${g.aliases.map(esc).join(', ')}</small>` : ''} <span class="chip">rev ${g.rev}</span></b><span>${esc(g.definition.length > 160 ? g.definition.slice(0, 160) + '…' : g.definition)}</span></div><button class="btn small" data-act="gterm-edit" data-id="${esc(g.id)}">Edit</button><button class="btn small" data-act="gterm-delete" data-id="${esc(g.id)}" data-term="${esc(g.term)}" style="color:var(--red);border-color:var(--red-line)">Delete</button></div>`).join('') : '<div class="muted" style="font-size:13px">No global terms yet.</div>') : '<div class="muted">Loading…</div>'}</section>
      <section class="card"><div class="card-head"><h2>Teams</h2><small class="muted">${tms ? tms.length : '…'}</small></div>
        ${tms ? tms.map((t) => `<div class="user"><div class="user-main"><span class="ws-av">${initial(t.name)}</span><div class="grow"><b>${esc(t.name)} <span class="chip">${esc(t.key)}</span></b><span class="muted">${t.members} member${t.members === 1 ? '' : 's'} · ${t.items} item${t.items === 1 ? '' : 's'}${t.gitUrl ? ' · git connected' : ''}${t.createdBy ? ' · created by ' + esc(t.createdBy) : ''}</span></div></div>
          <div class="user-actions"><button class="btn small" data-act="admin-open-team" data-id="${esc(t.id)}">Open</button><button class="btn small" data-act="admin-rename-team" data-id="${esc(t.id)}">Rename</button><button class="btn small" data-act="admin-delete-team" data-id="${esc(t.id)}" data-key="${esc(t.key)}" style="color:var(--red);border-color:var(--red-line)">Delete…</button></div></div>`).join('') : '<div class="muted">Loading…</div>'}</section>
      <section><div class="sect-title"><span>Accounts</span><small>${d ? d.users.length : '…'}</small></div>
        ${d ? d.users.map((u) => `<div class="user ${u.disabled ? 'off' : ''}">
          <div class="user-main"><span class="avatar">${esc(u.name[0].toUpperCase())}</span><div class="grow"><b>${esc(u.name)}${u.id === S.state.me.id ? ' <span class="chip">you</span>' : ''}${u.admin ? ' <span class="chip ok">instance admin</span>' : ''}${u.sso ? ' <span class="chip">SSO</span>' : ''}${u.disabled ? ' <span class="chip warn">disabled</span>' : ''}</b><span class="muted">${esc(u.email)}</span>
            <span class="muted">${u.teams.length ? u.teams.map((t) => `${esc(t.name)} (${esc(t.role)})`).join(' · ') : 'no team'}</span></div></div>
          <div class="user-actions"><button class="btn small" data-act="user-tokens" data-id="${esc(u.id)}">${ic.key(14)} ${u.tokens} token${u.tokens === 1 ? '' : 's'} · ${u.connections} app${u.connections === 1 ? '' : 's'}</button>
            <button class="btn small" data-act="user-admin" data-id="${esc(u.id)}" data-v="${u.admin ? '0' : '1'}">${u.admin ? 'Remove admin' : 'Make admin'}</button>
            <button class="btn small" data-act="user-pw" data-id="${esc(u.id)}">Reset password</button>
            <button class="btn small" data-act="user-toggle" data-id="${esc(u.id)}" data-v="${u.disabled ? '0' : '1'}">${u.disabled ? 'Enable' : 'Disable'}</button>
            ${u.id === S.state.me.id ? '' : `<button class="btn small" data-act="user-delete" data-id="${esc(u.id)}" data-name="${esc(u.email)}" style="color:var(--red);border-color:var(--red-line)">Delete</button>`}</div>
          ${d.open?.[u.id] ? `<div class="user-tokens">${[...d.open[u.id].tokens.map((k) => `<div class="rel" style="padding:8px 0"><div class="grow"><b>${esc(k.name)}</b><span class="mono">${esc(k.teamName)} · ${esc(k.prefix)}… · ${esc(scopesText(k.scopes))} · ${k.lastUsedAt ? 'used ' + ago(Date.parse(k.lastUsedAt)) : 'never used'}</span></div><button class="btn small" data-act="admin-revoke-token" data-id="${esc(u.id)}" data-tid="${esc(k.id)}">Revoke</button></div>`), ...d.open[u.id].connections.map((c) => `<div class="rel" style="padding:8px 0"><div class="grow"><b>${esc(c.clientName)}</b><span>OAuth · ${esc(c.teamName)} · ${esc(scopesText(c.scopes))}</span></div><button class="btn small" data-act="admin-revoke-conn" data-id="${esc(u.id)}" data-tid="${esc(c.id)}">Disconnect</button></div>`)].join('') || '<div class="muted" style="font-size:13px">No tokens or connected apps.</div>'}</div>` : ''}
        </div>`).join('') : '<div class="muted">Loading…</div>'}</section>`)}`;
}
