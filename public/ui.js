export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const svg = (d, size = 22, sw = 1.8, extra = '') =>
  `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
export const ic = {
  specs: (s) => svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h4"/>', s),
  docs: (s) => svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', s),
  release: (s) => svg('<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>', s),
  sync: (s) => svg('<path d="M20 12a8 8 0 0 0-14-5.3L4 9"/><path d="M4 4v5h5"/><path d="M4 12a8 8 0 0 0 14 5.3L20 15"/><path d="M20 20v-5h-5"/>', s),
  account: (s) => svg('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>', s),
  glossary: (s) => svg('<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5"/><path d="M9 8h6"/><path d="M9 12h4"/>', s),
  more: (s = 22) => svg('<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>', s, 1),
  shield: (s = 22) => svg('<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>', s),
  team: (s) => svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.5 3-6 6.5-6s6.5 2.5 6.5 6"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18 14.3c2.2.8 3.5 2.8 3.5 5.7"/>', s),
  off: (s = 14, sw = 2) => svg('<path d="M2 2l20 20"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M5 12.9a10 10 0 0 1 5.2-2.7"/><path d="M19 12.9a10 10 0 0 0-2.2-1.6"/><path d="M12 20h.01"/>', s, sw),
  up: (s = 12) => svg('<path d="M12 19V5"/><path d="M5 12l7-7 7 7"/>', s, 2.4),
  down: (s = 16) => svg('<path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/>', s, 2.2),
  check: (s = 12) => svg('<path d="M5 12l5 5 9-10"/>', s, 2.4),
  warn: (s = 12) => svg('<path d="M12 8v5"/><path d="M12 17h.01"/><path d="M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>', s, 2.4),
  plus: (s = 18) => svg('<path d="M12 5v14"/><path d="M5 12h14"/>', s, 2.4),
  back: () => svg('<path d="M15 5l-7 7 7 7"/>', 22, 2),
  search: () => svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>', 16, 2),
  phone: () => svg('<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/>', 14, 2),
  box: (s = 20) => svg('<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M8 12l3 3 5-6"/>', s, 2),
  clock: () => svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', 16, 2.2),
  diagram: (s = 20) => svg('<rect x="3" y="3" width="7" height="6" rx="1.5"/><rect x="14" y="15" width="7" height="6" rx="1.5"/><path d="M6.5 9v3a3 3 0 0 0 3 3H14"/>', s, 2),
  grip: () => svg('<circle cx="9" cy="6" r="1.2" fill="currentColor"/><circle cx="15" cy="6" r="1.2" fill="currentColor"/><circle cx="9" cy="12" r="1.2" fill="currentColor"/><circle cx="15" cy="12" r="1.2" fill="currentColor"/><circle cx="9" cy="18" r="1.2" fill="currentColor"/><circle cx="15" cy="18" r="1.2" fill="currentColor"/>', 18, 1),
  book: (s = 18) => svg('<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5"/><path d="M9 8h6"/>', s, 2),
  folder: (s = 18) => svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', s, 1.8),
  chevron: (s = 14) => svg('<path d="M6 9l6 6 6-6"/>', s, 2.2),
  git: (s = 18) => svg('<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="9" r="2.5"/><path d="M6 8.5v7"/><path d="M18 11.5c0 3-3 3.5-9 5"/>', s, 2),
  api: (s = 20) => svg('<path d="M8 5l-5 7 5 7"/><path d="M16 5l5 7-5 7"/><path d="M13.5 4l-3 16"/>', s, 2),
  pin: (s = 16) => svg('<path d="M12 17v5"/><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z"/>', s, 2),
  mail: (s = 16) => svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>', s, 2),
  folderPlus: (s = 16) => svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v5"/><path d="M9.5 13.5h5"/>', s, 1.8),
  file: (s = 16) => svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>', s, 1.8),
  key: (s = 18) => svg('<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9"/><path d="M16 7l3 3"/>', s, 2),
  logout: (s = 18) => svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>', s, 2),
};

export function ago(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 172800) return 'yesterday';
  return new Date(ts).toLocaleDateString();
}
export const touched = (i) => i.editedAt ?? (i.updatedAt ? Date.parse(i.updatedAt) : 0);

let toastTimer;
export function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}
export async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    toast('Copy not available here — select the text instead');
  }
}

/** Shared, non-persistent UI state. */
// ------------------------------------------------------------------ theme (system / light / dark)
const THEME_KEY = 'specs-theme';
export const themePref = () => { try { return localStorage.getItem(THEME_KEY) || 'system'; } catch { return 'system'; } };
export const effectiveTheme = () => { const p = themePref(); return p !== 'system' ? p : matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; };
export function applyTheme() {
  const p = themePref();
  const el = document.documentElement;
  if (p === 'system') el.removeAttribute('data-theme'); else el.dataset.theme = p;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', effectiveTheme() === 'light' ? '#F5F6F8' : '#0F1214');
}
export function setTheme(pref) {
  try { pref === 'system' ? localStorage.removeItem(THEME_KEY) : localStorage.setItem(THEME_KEY, pref); } catch { /* private mode */ }
  applyTheme();
}

export const ui = { openFolders: {}, q: '', gq: '', filter: 'all', mode: 'blocks', sheet: null, account: null, teamInfo: null, admin: null, adminTeams: null, invite: null, inviteLink: null, newToken: null, loginError: '', gitResult: null };
