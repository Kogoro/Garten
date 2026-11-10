import * as S from './store.js';
import { $, $$, esc, ic, toast, copy, ui, setTheme, applyTheme, themePref } from './ui.js';
import * as V from './views.js';
import { mountBlocks, BLOCK_TYPES, configureMermaid } from './blocks.js';
import { formatDefinition, splitList } from './glossary.js';
import { parseGlossaryFile } from './glossaryImport.js';

const route = () => {
  const [name, ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  return { name: name || 'specs', arg: decodeURIComponent(rest.join('/')) };
};
const go = (hash) => (location.hash = hash);
const tabOf = (name) => ({ spec: 'specs', doc: 'docs' })[name] ?? name;
const isEditorRoute = (r) => r.name === 'spec' || r.name === 'doc';
const FORM_PAGES = ['account', 'team', 'admin']; // contain inputs: never re-rendered in the background

let mounted = null; // key of what is currently rendered
let blocksApi = null;

// ------------------------------------------------------------------ rendering
function render() {
  const app = $('#app');
  blocksApi = null;
  const r = route();
  if (r.name === 'invite') {
    app.innerHTML = V.inviteView();
    mounted = `invite:${r.arg}`;
    if (!ui.invite || ui.invite.token !== r.arg) loadInvite(r.arg);
    return;
  }
  if (!S.state.me) { app.innerHTML = V.loginView(); mounted = 'login'; return; }
  let html;
  let item;
  if (!S.team() && !['admin', 'account'].includes(r.name)) {
    app.innerHTML = V.shell({ active: 'account', master: `${V.bar('Welcome')}${V.noTeamPage()}`, single: true });
    mounted = 'noteam';
    return;
  }
  switch (r.name) {
    case 'spec': case 'doc':
      item = S.get(r.arg);
      if (!item || item.kind !== r.name) return go(r.name === 'doc' ? '#/docs' : '#/');
      html = V.shell({ active: tabOf(r.name), master: r.name === 'spec' ? V.listPane(r.arg) : V.docsPane(r.arg), detail: V.editorPane(item) });
      break;
    case 'docs': html = V.shell({ active: 'docs', master: V.docsPane(null) }); break;
    case 'glossary': html = V.shell({ active: 'glossary', master: V.glossaryList(r.arg), detail: r.arg ? V.glossaryDetail(r.arg) : undefined }); break;
    case 'release': html = V.shell({ active: 'release', master: V.releasePage(), single: true }); break;
    case 'sync': html = V.shell({ active: 'sync', master: V.syncPage(), single: true }); break;
    case 'account': html = V.shell({ active: 'account', master: V.accountPage(), single: true }); break;
    case 'team': html = V.shell({ active: 'team', master: V.teamPage(), single: true }); break;
    case 'admin':
      if (!S.isInstanceAdmin()) return go('#/account');
      html = V.shell({ active: 'admin', master: V.adminPage(), single: true });
      break;
    default: html = V.shell({ active: 'specs', master: V.listPane(null) });
  }
  app.innerHTML = html;
  mounted = `${r.name}:${r.arg}`;
  if (item) mountEditorBody(item);
  if (r.name === 'account' && !ui.account) loadAccount();
  if (['team', 'release'].includes(r.name) && !ui.teamInfo) loadTeamInfo();
  if (r.name === 'admin' && !ui.admin) loadAdmin();
  if (r.name === 'glossary') S.loadGlobalGlossary();
  renderSheet();
}

function mountEditorBody(item) {
  const host = $('#editorBody');
  const ro = !S.can('write');
  if (ui.mode === 'blocks' && !V.rawMode(item)) {
    host.innerHTML = '<div class="blocks" id="blocks"></div>';
    blocksApi = mountBlocks($('#blocks'), item.body, { readonly: ro, onChange: (md) => S.edit(item.id, { body: md }), menu: openMenu });
  } else {
    host.innerHTML = `<label class="sr" for="body">Content</label><textarea id="body" class="ed-body" spellcheck="false" placeholder="Write Markdown…" ${ro ? 'readonly' : ''}>${esc(item.body)}</textarea>`;
  }
  $('#tools').innerHTML = V.toolsHtml(item);
}

function updateEditorChrome(item) {
  $('#saveInd').innerHTML = V.saveInd(item);
  $('#saveInd').dataset.state = V.saveState(item);
  $('#chips').innerHTML = V.chipsHtml(item);
  $('#banner').innerHTML = V.conflictBanner(item);
  $('#approveSlot').innerHTML = V.approveBtn(item);
  const menu = $('#docsSlot .dd-menu');
  const docs = V.docsDd(item, !!menu && !menu.hidden); // keep the dropdown open while links are toggled
  if ($('#docsSlot').innerHTML !== docs) $('#docsSlot').innerHTML = docs;
  if (!S.isPending(item)) { // adopt remote changes only when nothing local is waiting
    const ta = $('#body');
    if (ta && ta.value !== item.body) ta.value = item.body;
    blocksApi?.setMarkdown(item.body);
    const t = $('#title');
    if (t && t.value !== item.title) t.value = item.title;
  }
}

function onChange() {
  const r = route();
  if (r.name === 'invite') return;
  if (!S.state.me) {
    if (mounted !== 'login') return render();
    if (!$('#email')?.value && !$('#password')?.value) render(); // pick up late-arriving SSO config without wiping input
    return;
  }
  if (mounted === 'login' || mounted === 'noteam' || String(mounted).startsWith('invite:')) return render();
  if ($('#sidebar')) $('#sidebar').innerHTML = V.sidebarHtml(tabOf(r.name));
  if ($('#tabbar')) $('#tabbar').innerHTML = V.tabbarHtml(tabOf(r.name));
  $$('.bar [data-pill]').forEach((el) => (el.outerHTML = V.pillHtml()));
  if (!S.team() || ui.renderedTeam !== S.state.teamId) { ui.renderedTeam = S.state.teamId; return render(); }
  if (isEditorRoute(r) && mounted === `${r.name}:${r.arg}`) {
    const item = S.get(r.arg);
    if (item) updateEditorChrome(item); else return go(r.name === 'doc' ? '#/docs' : '#/'); // deleted elsewhere
    refreshList(r);
  } else if (['specs', 'docs'].includes(r.name) && $('#list')) refreshList(r);
  else if (r.name === 'glossary' && $('#glList')) refreshGlossary();
  else if (FORM_PAGES.includes(r.name)) { /* contains forms – never re-render in the background */ }
  else render();
  if (ui.sheet && ['link', 'ref'].includes(ui.sheet.type)) renderSheet();
}
/** Glossary: refresh the term list and (unless an edit form is open) the detail pane without losing focus elsewhere. */
function refreshGlossary() {
  const arg = route().arg;
  if ($('#glList')) $('#glList').innerHTML = V.glossaryListRows(arg);
  if (!ui.glEdit && arg && $('#glDetail')) $('#glDetail').outerHTML = V.glossaryDetail(arg);
}
function refreshGlossaryDetail() { const arg = route().arg; if (arg && $('#glDetail')) $('#glDetail').outerHTML = V.glossaryDetail(arg); }
function refreshList(r) {
  const list = $('#list');
  if (!list) return;
  const sel = isEditorRoute(r) ? r.arg : null;
  list.innerHTML = r.name === 'doc' || r.name === 'docs' ? V.docRows(sel) : V.specRows(sel);
}

// ------------------------------------------------------------------ sheets
const BTN = (label, act, cls = '', data = '') => `<button class="btn ${cls}" data-act="${act}" ${data}>${label}</button>`;
function sheetHtml() {
  const sh = ui.sheet;
  if (!sh) return '';
  let inner = '';
  if (sh.type === 'menu') {
    inner = `<h2>${esc(sh.title)}</h2><div class="menu">${sh.items.map((it) => `<button type="button" class="menu-item ${it.danger ? 'danger' : ''} ${it.current ? 'current' : ''}" data-act="menu-pick" data-key="${esc(it.key)}" ${it.disabled ? 'disabled' : ''}>${esc(it.label)}${it.current ? ' ✓' : ''}</button>`).join('')}</div>`;
  } else if (sh.type === 'relogin') {
    inner = `<h2>Sign in again</h2><p>Your session expired. Your local changes are safe and will sync after you sign in.</p>
      <form id="reloginForm" class="form"><label class="sr" for="rl-email">E-mail</label><input id="rl-email" class="field" type="email" value="${esc(S.state.me?.email)}" autocomplete="username" required>
      <label class="sr" for="rl-pw">Password</label><input id="rl-pw" class="field" type="password" placeholder="Password" autocomplete="current-password" required>
      ${sh.error ? `<span class="err-text">${esc(sh.error)}</span>` : ''}<button class="btn primary" type="submit">Sign in</button>
      ${S.state.authConfig?.oidc ? `<a class="btn" href="/auth/oidc/login?next=${encodeURIComponent(location.pathname + location.hash)}">${esc(S.state.authConfig.oidc.name)}</a>` : ''}</form>`;
  } else if (sh.type === 'createteam') {
    inner = `<h2>Create a team</h2><p>A team has its own specs, documents, glossary, Git repository and agent access. You become its admin and can invite colleagues.</p>
      <form id="createTeamForm" class="form"><label class="sr" for="newteam">Team name</label><input id="newteam" class="field" placeholder="Team name, e.g. Payments" maxlength="80" required>${sh.error ? `<span class="err-text">${esc(sh.error)}</span>` : ''}<button class="btn primary" type="submit">Create team</button></form>`;
  } else if (['newdoc', 'move', 'newfolder', 'renamefolder'].includes(sh.type)) {
    const folder = sh.type === 'newfolder' || sh.type === 'renamefolder';
    const folders = S.folderPaths();
    const title = { newdoc: 'New document', move: 'Move / rename document', newfolder: 'New folder with README.md', renamefolder: 'Rename / move folder' }[sh.type];
    const help = folder ? (sh.type === 'newfolder' ? 'Folder path, e.g. <span class="mono">adr</span> or <span class="mono">adr/2026</span>. A <span class="mono">README.md</span> is created inside, so the folder also exists in Git.' : 'New folder path, e.g. <span class="mono">adr/2026</span>. Everything inside moves with it.') : 'Path including folders and extension, e.g. <span class="mono">adr/ADR-008.md</span> or <span class="mono">schemas/billing.yaml</span>.';
    const act = { newdoc: 'create-doc', move: 'do-move', newfolder: 'create-folder', renamefolder: 'do-rename-folder' }[sh.type];
    inner = `<h2>${title}</h2><p>${help}</p>
      <label class="sr" for="docname">Path</label><input id="docname" class="field mono" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${folder ? 'folder/subfolder' : 'folder/name.md'}" value="${esc(sh.value ?? '')}">
      ${folders.length ? `<div class="chips">${folders.map((f) => `<button type="button" class="doc-chip" data-act="pick-folder" data-path="${esc(f)}">${ic.folder(14)}&nbsp;${esc(f)}/</button>`).join('')}</div>` : ''}
      ${sh.error ? `<span class="err-text">${esc(sh.error)}</span>` : ''}${BTN(sh.type === 'move' || sh.type === 'renamefolder' ? 'Move' : 'Create', act, 'primary')}`;
  } else if (sh.type === 'term') {
    const folders = S.glossaryModel().folders;
    inner = `<h2>New glossary term</h2><p>Added to your glossary. Agents receive it as soon as it is live.</p>
      <label class="sr" for="termname">Term</label><input id="termname" class="field" placeholder="Term" autocomplete="off" value="${esc(sh.value ?? '')}">
      <label class="sr" for="termdef">Definition</label><textarea id="termdef" class="field" style="height:110px;padding:12px" placeholder="What the term means in this project. Reference other terms with [[Term]]."></textarea>
      <label class="sr" for="termaliases">Also known as</label><input id="termaliases" class="field" placeholder="Also known as (comma separated)" autocomplete="off">
      <label class="sr" for="termsee">See also</label><input id="termsee" class="field" placeholder="See also (comma separated terms)" autocomplete="off">
      <label class="sr" for="termfolder">Folder</label><select id="termfolder" class="field"><option value="">General (no folder)</option>${folders.map((f) => `<option ${f === sh.folder ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select>
      ${sh.error ? `<span class="err-text">${esc(sh.error)}</span>` : ''}${BTN('Add term', 'create-term', 'primary')}`;
  } else if (sh.type === 'glfolder') {
    inner = `<h2>${sh.from ? 'Rename folder' : 'New glossary folder'}</h2><p>Folders group terms in the glossary list (they are section headings in glossary.md).</p>
      <label class="sr" for="glfname">Folder name</label><input id="glfname" class="field" placeholder="e.g. Payments" value="${esc(sh.from ?? '')}" maxlength="60" autocomplete="off">
      ${sh.error ? `<span class="err-text">${esc(sh.error)}</span>` : ''}${BTN(sh.from ? 'Rename' : 'Create', 'do-gl-folder', 'primary')}`;
  } else if (sh.type === 'newspec') {
    inner = `<h2>New spec</h2><p>Pick a type – it decides the starting structure. You can change the type later; the content stays.</p>
      <div class="typelist">${S.specTypes().map((t) => `<button type="button" class="typeopt ${t.key === ui.lastType ? 'current' : ''}" data-act="create-spec" data-type="${esc(t.key)}"><b>${esc(t.label)}</b><span>${esc(t.description)}</span></button>`).join('')}</div>`;
  } else if (sh.type === 'stype') {
    const t = sh.stype ?? {};
    inner = `<h2>${t.key ? 'Edit spec type' : 'New spec type'}</h2><p>The template is Markdown that new specs of this type start from (headings, requirements, code or diagram blocks).</p>
      <form id="stypeForm" class="form"><label class="sr" for="st-label">Name</label><input id="st-label" class="field" placeholder="Name, e.g. Runbook" value="${esc(t.label ?? '')}" required maxlength="40" autocomplete="off">
      <label class="sr" for="st-desc">Description</label><input id="st-desc" class="field" placeholder="One line: what is this type for?" value="${esc(t.description ?? '')}" maxlength="200" autocomplete="off">
      ${t.key ? '' : `<label class="sr" for="st-from">Start from</label><select id="st-from" class="field"><option value="">Start from an empty template</option>${S.specTypes().filter((x) => x.builtin).map((x) => `<option value="${esc(x.key)}">Start from: ${esc(x.label)}</option>`).join('')}</select>`}
      <label class="sr" for="st-tpl">Template</label><textarea id="st-tpl" class="field mono" style="height:180px;padding:12px;font-size:13px" placeholder="## SECTION\n\n## ANOTHER SECTION\n">${esc(t.template ?? '')}</textarea>
      ${sh.error ? `<span class="err-text">${esc(sh.error)}</span>` : ''}<button class="btn primary" type="submit">${t.key ? 'Save' : 'Add type'}</button></form>`;
  } else if (sh.type === 'gimport') {
    inner = `<h2>Import from the global glossary</h2><p>Terms are copied into your glossary (glossary.md). You can edit them; if the global term changes later you get an “Update available” hint.</p>
      <label class="sr" for="gimport-q">Search</label><input id="gimport-q" class="field" type="search" placeholder="Search global terms" autocomplete="off">
      <div id="gimport-list" class="gi-list">${V.gimportRows('', sh.sel)}</div>
      ${BTN('Import selected', 'do-gimport', 'primary')}`;
  } else if (sh.type === 'gfile') {
    const p = sh.parsed;
    const have = new Set((ui.adminGlobal ?? []).map((g) => g.term.toLowerCase()));
    const fresh = p.terms.filter((t) => !have.has(t.term.toLowerCase())).length;
    inner = `<h2>Import “${esc(sh.name)}”</h2>
      <p><b>${p.terms.length}</b> term${p.terms.length === 1 ? '' : 's'} found: <b>${fresh}</b> new, <b>${p.terms.length - fresh}</b> already in the global glossary.</p>
      ${p.errors.length ? `<div class="card warn"><div class="grow"><b>${p.errors.length} problem${p.errors.length === 1 ? '' : 's'}</b><span>${p.errors.slice(0, 4).map(esc).join('<br>')}${p.errors.length > 4 ? '<br>…' : ''}</span></div></div>` : ''}
      <div class="gi-list">${p.terms.slice(0, 8).map((t) => `<div class="gi-row"><span class="gi-body"><b>${esc(t.term)}${t.aliases.length ? ` <small class="muted">also: ${t.aliases.map(esc).join(', ')}</small>` : ''}</b><span>${esc(t.definition.length > 110 ? t.definition.slice(0, 110) + '…' : t.definition)}</span></span></div>`).join('')}${p.terms.length > 8 ? `<p class="note" style="padding:8px 4px">…and ${p.terms.length - 8} more</p>` : ''}</div>
      <fieldset class="check-group"><legend class="sr">If a term already exists</legend>
        <label class="check"><input type="radio" name="gmode" value="skip" checked> Keep existing terms (skip duplicates)</label>
        <label class="check"><input type="radio" name="gmode" value="update"> Update existing terms from the file</label></fieldset>
      ${sh.error ? `<span class="err-text">${esc(sh.error)}</span>` : ''}${BTN(`Import ${p.terms.length} term${p.terms.length === 1 ? '' : 's'}`, 'do-gfile', 'primary', p.terms.length ? '' : 'disabled')}`;
  } else if (sh.type === 'gterm') {
    const g = sh.term ?? {};
    inner = `<h2>${g.id ? 'Edit global term' : 'New global term'}</h2>
      <form id="gtermForm" class="form"><label class="sr" for="gt-term">Term</label><input id="gt-term" class="field" placeholder="Term" value="${esc(g.term ?? '')}" required maxlength="80" autocomplete="off">
      <label class="sr" for="gt-def">Definition</label><textarea id="gt-def" class="field" style="height:110px;padding:12px" placeholder="Definition – reference other terms with [[Term]]" required>${esc(g.definition ?? '')}</textarea>
      <label class="sr" for="gt-aliases">Also known as</label><input id="gt-aliases" class="field" placeholder="Also known as (comma separated)" value="${esc((g.aliases ?? []).join(', '))}" autocomplete="off">
      <label class="sr" for="gt-see">See also</label><input id="gt-see" class="field" placeholder="See also (comma separated terms)" value="${esc((g.see ?? []).join(', '))}" autocomplete="off">
      ${sh.error ? `<span class="err-text">${esc(sh.error)}</span>` : ''}<button class="btn primary" type="submit">${g.id ? 'Save' : 'Add term'}</button></form>`;
  } else if (sh.type === 'link' || sh.type === 'ref') {
    const spec = S.get(sh.specId);
    const docs = S.all('doc').filter((d) => !d.pinned || sh.type === 'ref' || spec.links.includes(d.id)).sort((a, b) => a.id.localeCompare(b.id));
    inner = `<h2>${sh.type === 'ref' ? 'Reference a document' : 'Linked documents'}</h2><p>${sh.type === 'ref' ? 'Inserts an @reference at the cursor and links the document to this spec.' : 'Linked documents are released together with this spec. Foundation documents (vision, strategy, glossary) are always available to agents and need no link.'}</p>
      ${docs.length ? docs.map((d) => `<button type="button" class="pick" data-act="${sh.type === 'ref' ? 'pick-ref' : 'toggle-link'}" data-id="${esc(d.id)}" aria-pressed="${spec.links.includes(d.id)}"><span class="box">${spec.links.includes(d.id) ? '✓' : ''}</span>${esc(d.id)}</button>`).join('') : '<p>No documents yet.</p>'}
      ${BTN(`${ic.plus(14)} New document`, 'new-doc-link')}`;
  } else if (sh.type === 'conflict') {
    const it = S.get(sh.id);
    const srv = it?.conflict;
    if (!srv) return '';
    inner = `<h2>Conflict in ${esc(it.id)}</h2><p>${srv.deleted ? 'It was deleted on the server' : `This was changed on the server (revision ${srv.rev}${srv.updatedBy ? ' by ' + esc(srv.updatedBy) : ''})`} and changed on this device. Choose which version to keep.</p>
      <div class="diff"><h3>This device</h3><pre>${esc((it.kind === 'spec' ? it.title + '\n\n' : '') + it.body)}</pre></div>
      ${srv.deleted ? '' : `<div class="diff"><h3>Server</h3><pre>${esc((it.kind === 'spec' ? srv.title + '\n\n' : '') + srv.body)}</pre></div>`}
      <div class="btns">${BTN('Keep mine', 'keep-mine', 'primary', `data-id="${esc(it.id)}"`)}${BTN(srv.deleted ? 'Discard (delete)' : 'Use server', 'keep-server', '', `data-id="${esc(it.id)}"`)}</div>`;
  }
  return `<div class="scrim" data-act="close-sheet"><div class="sheet" role="dialog" aria-modal="true">${inner}</div></div>`;
}
function renderSheet() { $('#sheet').innerHTML = sheetHtml(); }
function openSheet(sh) { ui.sheet = sh; renderSheet(); const i = $('#sheet input, #sheet textarea'); i?.focus(); if (i?.value) i.setSelectionRange?.(i.value.length, i.value.length); }
function closeSheet() {
  const sh = ui.sheet;
  ui.sheet = null;
  renderSheet();
  sh?.resolve?.(null);
}
function openMenu(title, items) {
  return new Promise((resolve) => { ui.sheet = { type: 'menu', title, items, resolve }; renderSheet(); });
}

// ------------------------------------------------------------------ editor helpers
const activeId = () => $('[data-editor]')?.dataset.editor;
function insertIntoTextarea(text) {
  const el = $('#body');
  if (!el || el.readOnly) return;
  const prev = el.value[el.selectionStart - 1];
  el.setRangeText((prev && !/\s/.test(prev) ? ' ' : '') + text, el.selectionStart, el.selectionEnd, 'end');
  el.focus();
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
function insertRef(docId) {
  const text = `@${docId} `;
  if (blocksApi) blocksApi.insertText(text); else insertIntoTextarea(text);
}

// ------------------------------------------------------------------ data loaders
async function loadInvite(token) {
  ui.invite = null;
  try { ui.invite = { token, info: (await S.api('GET', `/api/invites/${encodeURIComponent(token)}`)).invite }; }
  catch (e) { ui.invite = { token, error: e.message }; }
  if (route().name === 'invite') render();
}
async function loadAccount() {
  try { ui.account = await S.api('GET', '/api/me/tokens'); } catch { ui.account = { tokens: [], connections: [] }; }
  if (route().name === 'account') render();
}
async function loadTeamInfo() {
  const tid = S.state.teamId;
  try {
    const [t, m, ty] = await Promise.all([S.teamApi('GET', ''), S.teamApi('GET', '/members'), S.teamApi('GET', '/spec-types')]);
    if (tid === S.state.teamId) ui.teamInfo = { git: t.team.git, members: m.members, invites: m.invites, mailEnabled: t.team.mailEnabled, types: ty.types };
  } catch (e) { ui.teamInfo = { git: null, members: [], invites: [] }; toast(e.message); }
  if (['team', 'release'].includes(route().name)) render();
}
async function loadAdmin() {
  try {
    const [u, t, gl] = await Promise.all([S.api('GET', '/api/users'), S.api('GET', '/api/admin/teams'), S.api('GET', '/api/glossary/global')]);
    ui.adminGlobal = gl.terms;
    ui.admin = { users: u.users, open: ui.admin?.open ?? {} };
    ui.adminTeams = t.teams;
    ui.adminMail = t.mail;
  } catch (e) { ui.admin = { users: [], open: {} }; ui.adminTeams = []; toast(e.message); }
  if (route().name === 'admin') render();
}
const closeDropdowns = () => $$('.dd-menu').forEach((m) => { m.hidden = true; m.parentElement.querySelector('[aria-expanded]')?.setAttribute('aria-expanded', 'false'); });
const guarded = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };
const reloadTeamInfo = async () => { ui.teamInfo = null; await loadTeamInfo(); };

// ------------------------------------------------------------------ menu handlers
async function pickMenuAction(key) {
  if (!key) return;
  if (key.startsWith('team:')) { const id = key.slice(5); if (id !== S.state.teamId) { ui.teamInfo = null; ui.q = ''; ui.renderedTeam = id; S.switchTeam(id); go('#/'); render(); } return; }
  if (key.startsWith('invite:')) { await S.acceptInvite(key.slice(7)); toast('Joined the team'); go('#/'); return render(); }
  if (key.startsWith('go:')) return go(`#/${key.slice(3)}`);
  if (key.startsWith('theme:')) { setTheme(key.slice(6)); configureMermaid(); return render(); }
  if (key === 'create-team') return openSheet({ type: 'createteam' });
  if (key === 'switch') return pickMenuAction(await openMenu('Team', V.workspaceItems()));
  if (key === 'logout') return doLogout();
}
async function doLogout() {
  const n = [...S.state.maps.values()].reduce((a, m) => a + [...m.values()].filter(S.isPending).length, 0);
  if (n && !confirm(`${n} change(s) are not synced yet and will be lost. Sign out anyway?`)) return;
  ui.account = ui.admin = ui.adminTeams = ui.teamInfo = ui.newToken = null;
  await S.logout();
  go('#/');
  render();
}
async function enterAfterJoin(teamId) {
  history.replaceState(null, '', location.pathname);
  go('#/');
  if (teamId) { ui.renderedTeam = teamId; S.switchTeam(teamId); }
  render();
}

// ------------------------------------------------------------------ events
document.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.tools button')) e.preventDefault(); // keep the on-screen keyboard open + caret position
});

document.addEventListener('input', (e) => {
  const id = activeId();
  if (e.target.id === 'title') S.edit(id, { title: e.target.value });
  else if (e.target.id === 'body') S.edit(id, { body: e.target.value });
  else if (e.target.id === 'search') { ui.q = e.target.value; refreshList(route()); }
  else if (e.target.id === 'gsearch') { ui.gq = e.target.value; $('#glList').innerHTML = V.glossaryListRows(route().arg); }
  else if (e.target.id === 'gimport-q') $('#gimport-list').innerHTML = V.gimportRows(e.target.value, ui.sheet?.sel);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeDropdowns(); if (ui.sheet) closeSheet(); }
  if (e.key === 'Enter' && e.target.id === 'docname') $('#sheet [data-act="create-doc"], #sheet [data-act="do-move"], #sheet [data-act="create-folder"], #sheet [data-act="do-rename-folder"]')?.click();
});

document.addEventListener('change', guarded(async (e) => {
  if (e.target.id === 'gfile') {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > 1_000_000) return toast('The file is larger than 1 MB');
    const parsed = parseGlossaryFile(f.name, await f.text());
    return openSheet({ type: 'gfile', name: f.name, parsed });
  }
  if (e.target.id === 'typeFilter') { ui.typeFilter = e.target.value; return refreshList(route()); }
  if (e.target.id === 'st-from') {
    const t = S.specTypes().find((x) => x.key === e.target.value);
    if (t) { $('#st-tpl').value = t.template; if (!$('#st-desc').value) $('#st-desc').value = t.description; }
    return;
  }
  if (e.target.classList?.contains('gi-check') && ui.sheet?.sel) { e.target.checked ? ui.sheet.sel.add(e.target.value) : ui.sheet.sel.delete(e.target.value); return; }
  if (e.target.id === 'g-auth') { // show only the fields of the chosen authentication
    $('.g-token').hidden = e.target.value !== 'token';
    $('.g-ssh').hidden = e.target.value !== 'ssh';
    return;
  }
  if (e.target.id === 'found-auto') {
    await S.teamApi('PATCH', '', { foundationAuto: e.target.checked });
    await S.refreshMe();
    return toast(e.target.checked ? 'Foundation documents go live automatically' : 'Foundation documents now need approval');
  }
  if (e.target.dataset.act === 'member-role') {
    await S.teamApi('PATCH', `/members/${e.target.dataset.id}`, { role: e.target.value });
    toast('Role updated – tokens of this member follow immediately');
    await reloadTeamInfo(); S.refreshMe();
  }
}));

document.addEventListener('submit', guarded(async (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.id === 'loginForm') {
    ui.loginError = '';
    try { await S.login($('#email').value, $('#password').value); history.replaceState(null, '', location.pathname + location.hash); render(); }
    catch (err) { ui.loginError = err.message; render(); }
  } else if (f.id === 'reloginForm') {
    try { await S.login($('#rl-email').value, $('#rl-pw').value); closeSheet(); toast('Signed in'); }
    catch (err) { ui.sheet.error = err.message; renderSheet(); }
  } else if (f.id === 'inviteLogin' || f.id === 'inviteRegister') {
    const { token, info } = ui.invite;
    ui.invite.formError = '';
    try {
      let res;
      if (f.id === 'inviteLogin') {
        await S.login(info.email, $('#iv-pw').value);
        res = await S.api('POST', `/api/invites/${encodeURIComponent(token)}/accept`, {});
        await S.refreshMe(res.teamId);
      } else {
        res = await S.api('POST', `/api/invites/${encodeURIComponent(token)}/accept`, { name: $('#iv-name').value, password: $('#iv-pw').value });
        await S.adoptLogin(res.me);
      }
      ui.invite = null;
      await enterAfterJoin(res.teamId);
    } catch (err) { ui.invite.formError = err.message; render(); }
  } else if (f.id === 'stypeForm') {
    const cur = ui.sheet.stype;
    const body = { label: $('#st-label').value, description: $('#st-desc').value, template: $('#st-tpl').value };
    try {
      if (cur?.key) await S.teamApi('PATCH', `/spec-types/${cur.key}`, body); else await S.teamApi('POST', '/spec-types', body);
      await S.refreshTypes(); closeSheet(); ui.teamInfo = null; await loadTeamInfo(); toast(cur?.key ? 'Type saved' : 'Type added');
    } catch (err) { ui.sheet.error = err.message; renderSheet(); }
  } else if (f.id === 'glEditForm') {
    const old = f.dataset.old;
    const term = $('#gd-term').value.trim();
    if (/[\[\]|]/.test(term)) return toast('Terms cannot contain [ ] or |');
    if (term.toLowerCase() !== old.toLowerCase() && V.glossaryTerms().some((t) => t.term.toLowerCase() === term.toLowerCase())) return toast(`“${term}” already exists`);
    S.saveGlossaryTerm({ oldTerm: old, term, definition: $('#gd-def').value, aliases: splitList($('#gd-aliases').value), see: splitList($('#gd-see').value), folder: $('#gd-folder').value });
    ui.glEdit = false;
    if (term !== old) go(V.glossaryHref(term)); else refreshGlossary();
    toast('Term saved');
  } else if (f.id === 'gtermForm') {
    const g = ui.sheet.term ?? {};
    const body = { term: $('#gt-term').value, definition: $('#gt-def').value, aliases: splitList($('#gt-aliases').value), see: splitList($('#gt-see').value) };
    try {
      const res = g.id ? await S.api('PATCH', `/api/glossary/global/${g.id}`, body) : await S.api('POST', '/api/glossary/global', body);
      ui.adminGlobal = res.terms; await S.loadGlobalGlossary(); closeSheet(); render(); toast(g.id ? 'Global term updated' : 'Global term added');
    } catch (err) { ui.sheet.error = err.message; renderSheet(); }
  } else if (f.id === 'createTeamForm') {
    try { await S.createTeam($('#newteam').value); closeSheet(); ui.teamInfo = null; ui.renderedTeam = S.state.teamId; go('#/'); render(); toast('Team created'); }
    catch (err) { if (ui.sheet) { ui.sheet.error = err.message; renderSheet(); } else toast(err.message); }
  } else if (f.id === 'tokenForm') {
    ui.newToken = await S.api('POST', '/api/me/tokens', { name: $('#tname').value, teamId: $('#tteam').value, scopes: $('#tscope').value.split(' '), days: Number($('#tdays').value) });
    ui.account = await S.api('GET', '/api/me/tokens');
    render();
  } else if (f.id === 'pwForm') {
    await S.api('POST', '/api/me/password', { current: $('#pwcur').value, password: $('#pwnew').value });
    f.reset();
    toast('Password changed');
  } else if (f.id === 'gitForm') {
    const body = { url: $('#g-url').value, branch: $('#g-branch').value, root: $('#g-root').value, auth: $('#g-auth').value, username: $('#g-user')?.value, autoPush: $('#g-auto').checked };
    if ($('#g-token')?.value) body.token = $('#g-token').value;
    ui.gitResult = null;
    await S.teamApi('PUT', '/git', body);
    toast('Git connection saved');
    await reloadTeamInfo();
  } else if (f.id === 'teamNameForm') {
    await S.teamApi('PATCH', '', { name: $('#tm-name').value });
    await S.refreshMe(); ui.teamInfo = null; render();
    toast('Renamed');
  } else if (f.id === 'inviteForm') {
    const res = await S.teamApi('POST', '/invites', { email: $('#inv-email').value, role: $('#inv-role').value });
    ui.inviteLink = { email: res.invite.email, link: res.link, userExists: res.userExists, emailed: res.emailed, emailError: res.emailError };
    ui.teamInfo = { ...ui.teamInfo, invites: res.invites };
    render();
    toast(res.emailed ? `Invitation sent to ${res.invite.email}` : res.emailError ? 'E-mail failed – copy the link' : 'Invitation created');
  }
}));

document.addEventListener('click', guarded(async (e) => {
  if (!e.target.closest('.dd')) closeDropdowns();
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const id = el.dataset.id ?? activeId();
  if (act === 'close-sheet') return e.target === el ? closeSheet() : undefined;
  if (act === 'menu-pick') { const sh = ui.sheet; ui.sheet = null; renderSheet(); return sh.resolve(el.dataset.key); }
  switch (act) {
    case 'filter': ui.filter = el.dataset.v; return render();
    case 'mode': ui.mode = el.dataset.v; return render();
    case 'workspace-menu': return pickMenuAction(await openMenu('Team', V.workspaceItems()));
    case 'user-menu': return pickMenuAction(await openMenu(S.state.me.name, V.userItems()));
    case 'more-menu': return pickMenuAction(await openMenu('More', V.moreItems()));
    case 'set-theme': setTheme(el.dataset.v); configureMermaid(); return render();
    case 'create-team-sheet': return openSheet({ type: 'createteam' });
    case 'invite-accept': await S.acceptInvite(id); toast('Joined the team'); ui.renderedTeam = S.state.teamId; go('#/'); return render();
    case 'invite-decline': await S.declineInvite(id); return render();
    case 'accept-link': { const res = await S.api('POST', `/api/invites/${encodeURIComponent(ui.invite.token)}/accept`, {}); await S.refreshMe(res.teamId); ui.invite = null; return enterAfterJoin(res.teamId); }
    case 'new-spec': return openSheet({ type: 'newspec' });
    case 'create-spec': { ui.lastType = el.dataset.type; const s = S.createSpec(el.dataset.type); closeSheet(); go(`#/spec/${encodeURIComponent(s.id)}`); setTimeout(() => $('#title')?.focus(), 80); return; }
    case 'stype-new': return openSheet({ type: 'stype' });
    case 'stype-edit': return openSheet({ type: 'stype', stype: ui.teamInfo.types.find((t) => t.key === el.dataset.key) });
    case 'stype-delete': {
      if (!confirm(`Delete the spec type “${el.dataset.key}”?`)) return;
      await S.teamApi('DELETE', `/spec-types/${el.dataset.key}`); await S.refreshTypes(); ui.teamInfo = null; return loadTeamInfo();
    }
    case 'dd-toggle': { const m = el.parentElement.querySelector('.dd-menu'); const open = m.hidden; closeDropdowns(); m.hidden = !open; el.setAttribute('aria-expanded', String(open)); return; }
    case 'new-folder': closeDropdowns(); return openSheet({ type: 'newfolder', value: '' });
    case 'new-doc': closeDropdowns(); return openSheet({ type: 'newdoc', value: ui.lastFolder ? `${ui.lastFolder}/` : '' });
    case 'new-doc-in': return openSheet({ type: 'newdoc', value: `${el.dataset.path}/` });
    case 'new-doc-link': { const spec = ui.sheet?.specId ?? activeId(); closeDropdowns(); return openSheet({ type: 'newdoc', linkTo: spec }); }
    case 'dd-link': return S.toggleLink(activeId(), el.dataset.id);
    case 'pick-folder': { const i = $('#docname'); const folderMode = ['newfolder', 'renamefolder'].includes(ui.sheet?.type); i.value = folderMode ? el.dataset.path + '/' : `${el.dataset.path}/${i.value.split('/').pop()}`; i.focus(); return; }
    case 'toggle-folder': ui.openFolders[el.dataset.path] = ui.openFolders[el.dataset.path] === false; if (route().name === 'glossary') refreshGlossary(); else refreshList(route()); return;
    case 'folder-menu': {
      const path = el.dataset.path;
      const k = await openMenu(path, [{ key: 'doc', label: 'New document here' }, { key: 'sub', label: 'New subfolder' }, { key: 'rename', label: 'Rename / move…' }, { key: 'delete', label: 'Delete folder', danger: true, disabled: !S.folderEmpty(path) }]);
      if (k === 'doc') return openSheet({ type: 'newdoc', value: `${path}/` });
      if (k === 'sub') return openSheet({ type: 'newfolder', value: `${path}/` });
      if (k === 'rename') return openSheet({ type: 'renamefolder', from: path, value: path });
      if (k === 'delete' && confirm(`Delete the empty folder ${path}?`)) { S.deleteFolder(path); refreshList(route()); toast('Folder deleted'); }
      return;
    }
    case 'create-folder': {
      try {
        const f = S.createFolder($('#docname').value);
        const readme = S.createDoc(`${f.id}/README.md`, `# ${S.baseName(f.id)}\n\n`); // Git cannot hold empty folders: every new folder starts with a README.md
        ui.openFolders[f.id] = true; ui.lastFolder = f.id; closeSheet();
        go(`#/doc/${encodeURIComponent(readme.id)}`); toast(`Folder ${f.id} created with README.md`);
      }
      catch (err) { ui.sheet.error = err.message; renderSheet(); }
      return;
    }
    case 'do-rename-folder': {
      try { S.moveFolder(ui.sheet.from, $('#docname').value); closeSheet(); refreshList(route()); toast('Folder moved'); }
      catch (err) { ui.sheet.error = err.message; renderSheet(); }
      return;
    }
    case 'create-doc': {
      try {
        const d = S.createDoc($('#docname').value);
        ui.lastFolder = S.folderOf(d.id);
        const linkTo = ui.sheet?.linkTo;
        if (linkTo) S.toggleLink(linkTo, d.id);
        closeSheet();
        if (!linkTo) go(`#/doc/${encodeURIComponent(d.id)}`); else toast(`${d.id} created and linked`);
      } catch (err) { ui.sheet.error = err.message; renderSheet(); }
      return;
    }
    case 'item-menu': {
      const it = S.get(id);
      const raw = V.rawMode(it);
      const path = it.kind === 'spec' ? `${S.team().key}/${it.id}.md` : `docs/${it.id}`;
      const info = [{ key: 'info', label: `${path}${it.version ? ` · v${it.version}` : ''}${it.updatedBy ? ` · edited by ${it.updatedBy}` : ''}`, disabled: true }];
      const typeItem = it.kind === 'spec' && S.can('write') ? [{ key: 'type', label: `Type: ${S.specType(it.specType).label} – change…` }] : [];
      const mode = raw ? [] : [{ key: 'mode:blocks', label: 'Editor: Blocks', current: ui.mode === 'blocks' }, { key: 'mode:markdown', label: 'Editor: Markdown', current: ui.mode === 'markdown' }];
      const actions = !S.can('write') ? [] : it.kind === 'spec'
        ? [{ key: 'delete', label: 'Delete spec', danger: true }]
        : it.core
          ? [{ key: 'none', label: 'Foundation document – every team has it', disabled: true }]
          : [{ key: 'move', label: 'Move / rename…' }, { key: 'pin', label: it.pinned ? 'Unpin: no longer always available to agents' : 'Pin: always available to agents' }, { key: 'delete', label: 'Delete document', danger: true }];
      const key = await openMenu(it.id, [...info, ...mode, ...typeItem, ...actions]);
      if (key === 'type') {
        const k = await openMenu('Spec type', S.specTypes().map((t) => ({ key: t.key, label: t.label, current: t.key === it.specType })));
        if (k && k !== it.specType) { S.edit(it.id, { specType: k }); toast('Type changed – the content stays as it is'); }
        return;
      }
      if (key?.startsWith('mode:')) { ui.mode = key.slice(5); return render(); }
      if (key === 'move') return openSheet({ type: 'move', id: it.id, value: it.id });
      if (key === 'pin') { S.setPinned(it.id, !it.pinned); return toast(it.pinned ? 'Pinned – goes live for agents' : 'Unpinned'); }
      if (key === 'delete') {
        if (!confirm(`Delete ${it.id}? ${it.baseRev === 0 ? '' : 'It is removed for everyone in the team after sync.'}`)) return;
        S.deleteItem(it.id);
        go(it.kind === 'spec' ? '#/' : '#/docs');
        toast(`${it.id} deleted`);
      }
      return;
    }
    case 'do-move': {
      try { const d = S.moveDoc(ui.sheet.id, $('#docname').value); closeSheet(); go(`#/doc/${encodeURIComponent(d.id)}`); toast('Moved'); }
      catch (err) { ui.sheet.error = err.message; renderSheet(); }
      return;
    }
    case 'gl-folder-new': closeDropdowns(); return openSheet({ type: 'glfolder' });
    case 'gl-folder-menu': {
      const name = el.dataset.name;
      const k = await openMenu(name, [{ key: 'rename', label: 'Rename…' }, { key: 'delete', label: 'Delete folder', danger: true }]);
      if (k === 'rename') return openSheet({ type: 'glfolder', from: name });
      if (k === 'delete') { try { S.deleteGlossaryFolder(name); refreshGlossary(); toast('Folder deleted'); } catch (err) { toast(err.message); } }
      return;
    }
    case 'do-gl-folder': {
      try { const from = ui.sheet.from; const name = $('#glfname').value; if (from) S.renameGlossaryFolder(from, name); else S.createGlossaryFolder(name); closeSheet(); refreshGlossary(); toast(from ? 'Folder renamed' : 'Folder created'); }
      catch (err) { ui.sheet.error = err.message; renderSheet(); }
      return;
    }
    case 'gl-edit': ui.glEdit = true; return refreshGlossaryDetail();
    case 'gl-cancel': e.preventDefault(); ui.glEdit = false; return refreshGlossaryDetail();
    case 'gl-delete': { if (!confirm(`Delete the term “${el.dataset.term}” from the glossary?`)) return; S.deleteGlossaryTerm(el.dataset.term); go('#/glossary'); return toast('Term deleted'); }
    case 'gl-adopt': {
      const t = V.glossaryTerms().find((x) => x.term === el.dataset.term);
      const d = t.defs[0];
      S.saveGlossaryTerm({ term: t.term, definition: d.definition, aliases: d.aliases, see: d.see });
      refreshGlossary(); return toast('Added to the glossary');
    }
    case 'gl-import': await S.loadGlobalGlossary(); return openSheet({ type: 'gimport', sel: new Set() });
    case 'do-gimport': {
      const n = S.importGlobalTerms([...ui.sheet.sel]);
      if (!n) { toast('Select at least one term'); return; }
      closeSheet(); refreshGlossary();
      return toast(`${n} term${n === 1 ? '' : 's'} imported into your glossary`);
    }
    case 'gl-update': {
      const g = S.state.globalTerms.find((x) => x.id === el.dataset.gid);
      if (!g) return;
      S.upsertGlossaryTerms([{ term: g.term, definition: g.definition, aliases: g.aliases, see: g.see, source: `global:${g.id}@${g.rev}` }]);
      refreshGlossary();
      return toast(`“${g.term}” updated from the global glossary`);
    }
    case 'gfile-pick': return $('#gfile').click();
    case 'do-gfile': {
      const mode = document.querySelector('input[name=gmode]:checked')?.value ?? 'skip';
      try {
        const res = await S.api('POST', '/api/glossary/global/import', { terms: ui.sheet.parsed.terms, mode });
        ui.adminGlobal = res.terms; await S.loadGlobalGlossary(); closeSheet(); render();
        const r = res.result;
        toast(`${r.created} added${r.updated ? `, ${r.updated} updated` : ''}${r.skipped ? `, ${r.skipped} skipped` : ''}${r.errors.length ? `, ${r.errors.length} rejected` : ''}`);
      } catch (err) { ui.sheet.error = err.message; renderSheet(); }
      return;
    }
    case 'gterm-export': {
      const md = ui.adminGlobal.map((g) => formatDefinition(g.term, g.definition, { aliases: g.aliases, see: g.see })).join('\n\n') + '\n';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
      a.download = 'global-glossary.md';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      return;
    }
    case 'gterm-new': return openSheet({ type: 'gterm' });
    case 'gterm-edit': return openSheet({ type: 'gterm', term: ui.adminGlobal.find((g) => g.id === id) });
    case 'gterm-delete': {
      if (!confirm(`Delete “${el.dataset.term}” from the global glossary? Copies in team glossaries stay as they are.`)) return;
      const res = await S.api('DELETE', `/api/glossary/global/${id}`); ui.adminGlobal = res.terms; await S.loadGlobalGlossary(); return render();
    }
    case 'new-term': closeDropdowns(); return openSheet({ type: 'term', value: el.dataset.term ?? '', folder: route().name === 'glossary' ? undefined : undefined });
    case 'create-term': {
      const term = $('#termname').value.trim();
      const def = $('#termdef').value.trim();
      if (!term || !def) { ui.sheet.error = 'Enter a term and its definition'; return renderSheet(); }
      if (/[\[\]|]/.test(term)) { ui.sheet.error = 'Terms cannot contain [ ] or |'; return renderSheet(); }
      if (V.glossaryTerms().some((t) => t.term.toLowerCase() === term.toLowerCase() && t.defs.some((d) => d.item.id === 'glossary.md'))) { ui.sheet.error = `“${term}” is already in the glossary`; return renderSheet(); }
      S.saveGlossaryTerm({ term, definition: def, aliases: splitList($('#termaliases').value), see: splitList($('#termsee').value), folder: $('#termfolder').value });
      closeSheet();
      go(V.glossaryHref(term));
      return toast('Term added to the glossary');
    }
    case 'link-sheet': return openSheet({ type: 'link', specId: id });
    case 'toggle-link': return S.toggleLink(ui.sheet.specId, el.dataset.id);
    case 't-add': { const k = await openMenu('Add block at cursor', BLOCK_TYPES.map((t) => ({ key: t.key, label: t.label }))); if (k) blocksApi?.insert(k); return; }
    case 't-h2': return blocksApi?.insert('h2');
    case 't-req': return blocksApi?.insert('req');
    case 't-task': return blocksApi?.insert('task');
    case 't-def': return blocksApi?.insert('def');
    case 't-diagram': return blocksApi?.insert('diagram');
    case 't-endpoint': return blocksApi?.insert('endpoint');
    case 't-ref': return openSheet({ type: 'ref', specId: id });
    case 'pick-ref': {
      const spec = S.get(ui.sheet.specId);
      if (!spec.links.includes(el.dataset.id)) S.toggleLink(spec.id, el.dataset.id);
      closeSheet();
      insertRef(el.dataset.id);
      return;
    }
    case 'approve':
      if (S.get(id).kind === 'spec' && !S.get(id).title.trim()) return toast('Add a title first');
      S.requestApprove(id);
      return toast(S.state.online && !S.state.sessionExpired ? (S.get(id).kind === 'doc' ? 'Publishing…' : 'Approving…') : 'Queued — released after next sync');
    case 'cancel-approve': return S.cancelApprove(id);
    case 'revoke': if (confirm(`Revoke ${id}? Agents will no longer see it.`)) S.requestRevoke(id); return;
    case 'undo-revoke': return S.cancelRevoke(id);
    case 'copy-url': return copy(S.state.mcpUrl);
    case 'retry': await S.sync(); return toast(S.state.error ?? 'Synced');
    case 'relogin': return openSheet({ type: 'relogin' });
    case 'conflict': return openSheet({ type: 'conflict', id: el.dataset.id });
    case 'keep-mine': S.resolveConflict(el.dataset.id, 'mine'); closeSheet(); if (isEditorRoute(route())) render(); return toast('Kept your version');
    case 'keep-server': S.resolveConflict(el.dataset.id, 'server'); closeSheet(); render(); return toast('Server version restored');
    // git
    case 'git-test': { ui.gitResult = null; const r = await S.teamApi('POST', '/git/test'); ui.gitResult = { ok: true, text: r.branchExists ? 'Connection works – the branch exists and will be merged.' : 'Connection works – the branch does not exist yet and will be created.' }; return render(); }
    case 'git-push': {
      toast('Pushing…');
      try { const r = await S.teamApi('POST', '/git/push'); ui.gitResult = { ok: true, text: r.warning ?? 'Pushed to the remote.' }; toast('Pushed'); }
      catch (err) { ui.gitResult = { ok: false, text: err.message }; toast('Push failed'); }
      return reloadTeamInfo();
    }
    case 'git-keygen': { if (ui.teamInfo?.git?.sshPublicKey && !confirm('Replace the existing key? The old deploy key stops working.')) return; await S.teamApi('POST', '/git/ssh-key'); toast('Key generated – add the public key as a deploy key'); return reloadTeamInfo(); }
    case 'copy-pubkey': return copy(ui.teamInfo.git.sshPublicKey);
    // team
    case 'member-remove': if (!confirm('Remove this member from the team? Their tokens for this team stop working.')) return; await S.teamApi('DELETE', `/members/${id}`); await reloadTeamInfo(); return S.refreshMe();
    case 'copy-invite': return copy(ui.inviteLink.link);
    case 'dismiss-invite': ui.inviteLink = null; return render();
    case 'invite-resend': {
      const res = await S.teamApi('POST', '/invites', { email: el.dataset.email, role: el.dataset.role });
      ui.inviteLink = { email: res.invite.email, link: res.link, userExists: res.userExists, emailed: res.emailed, emailError: res.emailError };
      ui.teamInfo = { ...ui.teamInfo, invites: res.invites };
      render();
      return toast(res.emailed ? `Invitation sent again to ${res.invite.email}` : res.emailError ? 'E-mail failed – copy the link' : 'New link created');
    }
    case 'mail-test': { await S.api('POST', '/api/admin/mail/test'); return toast(`Test e-mail sent to ${S.state.me.email}`); }
    case 'invite-revoke': { const r = await S.teamApi('DELETE', `/invites/${id}`); ui.teamInfo = { ...ui.teamInfo, invites: r.invites }; return render(); }
    case 'leave-team': {
      if (!confirm(`Leave ${V.teamName()}? You lose access to its specs and your agent tokens for it stop working.`)) return;
      await S.leaveTeam(); ui.teamInfo = null; ui.renderedTeam = S.state.teamId; go('#/'); render(); return toast('You left the team');
    }
    // account
    case 'copy-token': return copy(ui.newToken.token);
    case 'copy-token-cmd': return copy(`claude mcp add --transport http specs-${ui.newToken.pat.teamName.toLowerCase().replace(/\W+/g, '-')} ${S.state.mcpUrl} --header "Authorization: Bearer ${ui.newToken.token}"`);
    case 'dismiss-token': ui.newToken = null; return render();
    case 'revoke-token': await S.api('DELETE', `/api/me/tokens/${id}`); ui.account = await S.api('GET', '/api/me/tokens'); return render();
    case 'revoke-conn': await S.api('DELETE', `/api/me/connections/${id}`); ui.account = await S.api('GET', '/api/me/tokens'); return render();
    case 'logout': return doLogout();
    // instance admin
    case 'admin-open-team': { await S.refreshMe(id); ui.teamInfo = null; ui.renderedTeam = id; go('#/'); return render(); }
    case 'admin-rename-team': { const n = prompt('New team name'); if (!n) return; await S.api('PATCH', `/api/teams/${id}`, { name: n }); await S.refreshMe(); return loadAdmin(); }
    case 'admin-delete-team': {
      const key = prompt(`Delete this team with all its specs, documents, Git repository and agent tokens?\nType the team key (${el.dataset.key}) to confirm.`);
      if (!key) return;
      await S.api('DELETE', `/api/teams/${id}`, { confirmKey: key });
      S.state.maps.delete(id);
      await S.refreshMe(); ui.renderedTeam = S.state.teamId; toast('Team deleted'); return loadAdmin();
    }
    case 'user-toggle': await S.api('PATCH', `/api/users/${id}`, { disabled: el.dataset.v === '1' }); return loadAdmin();
    case 'user-admin': await S.api('PATCH', `/api/users/${id}`, { admin: el.dataset.v === '1' }); return loadAdmin();
    case 'user-delete': if (!confirm(`Delete the account ${el.dataset.name}? Their sessions, tokens and team memberships are removed.`)) return; await S.api('DELETE', `/api/users/${id}`); toast('Account deleted'); return loadAdmin();
    case 'user-pw': { const pw = prompt('New password for this user (min. 8 characters)'); if (!pw) return; await S.api('PATCH', `/api/users/${id}`, { password: pw }); return toast('Password reset'); }
    case 'user-tokens': {
      ui.admin.open ??= {};
      if (ui.admin.open[id]) delete ui.admin.open[id]; else ui.admin.open[id] = await S.api('GET', `/api/users/${id}/tokens`);
      return render();
    }
    case 'admin-revoke-token': await S.api('DELETE', `/api/users/${id}/tokens/${el.dataset.tid}`); ui.admin.open[id] = await S.api('GET', `/api/users/${id}/tokens`); return loadAdmin();
    case 'admin-revoke-conn': await S.api('DELETE', `/api/users/${id}/connections/${el.dataset.tid}`); ui.admin.open[id] = await S.api('GET', `/api/users/${id}/tokens`); return loadAdmin();
  }
}));

addEventListener('hashchange', () => {
  if (ui.sheet && ui.sheet.type !== 'relogin') closeSheet();
  const n = route().name;
  if (n !== 'account') { ui.account = null; ui.newToken = null; }
  if (n !== 'admin') { ui.admin = null; ui.adminTeams = null; ui.adminMail = null; ui.adminGlobal = null; }
  if (['team', 'release'].includes(n)) ui.teamInfo = null;
  if (n !== 'team') ui.inviteLink = null;
  ui.gitResult = null;
  ui.glEdit = false;
  render();
});

// ------------------------------------------------------------------ boot
applyTheme();
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (themePref() === 'system') { applyTheme(); configureMermaid(); render(); } });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
await S.init();
ui.renderedTeam = S.state.teamId;
S.subscribe(onChange);
render();
