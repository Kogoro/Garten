import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Sheet } from './dialogs';
import { glossaryTerms, glossaryPath } from './glossaryLib';
import { NewSpecSheet } from './sheets';
import { setTheme, toast, useStore } from './ui';

/** Keyboard shortcuts: one list drives the help dialog and the handler. */
export const SHORTCUTS: { keys: string; what: string }[] = [
  { keys: 'Ctrl/⌘ K', what: 'Command palette: jump to anything, run an action' },
  { keys: '/', what: 'Search in the current list' },
  { keys: 'g then s', what: 'Go to Specs' }, { keys: 'g then d', what: 'Go to Documents' }, { keys: 'g then l', what: 'Go to Glossary' },
  { keys: 'g then r', what: 'Go to Release' }, { keys: 'g then a', what: 'Go to Garden (agents)' }, { keys: 'g then t', what: 'Go to Members & Git' },
  { keys: 'g then y', what: 'Go to Sync' }, { keys: 'n', what: 'New spec' }, { keys: '?', what: 'This list' }, { keys: 'Esc', what: 'Close a dialog or menu' },
];
const GO: Record<string, string> = { s: '/', d: '/docs', l: '/glossary', r: '/release', a: '/garden', t: '/team', y: '/sync', c: '/account' };
const RECENT_KEY = 'specs-recent';
const typing = (t: EventTarget | null) => { const e = t as HTMLElement | null; return !!e && (/^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName) || e.isContentEditable); };

export function readRecent(): string[] { try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'); } catch { return []; } }
function pushRecent(path: string) { try { localStorage.setItem(RECENT_KEY, JSON.stringify([path, ...readRecent().filter((p) => p !== path)].slice(0, 8))); } catch { /* private mode */ } }

type Cmd = { id: string; label: string; hint?: string; run: () => void };

export function Palette() {
  const S = useStore(); const nav = useNavigate(); const loc = useLocation();
  const [open, setOpen] = useState(false); const [help, setHelp] = useState(false); const [newSpec, setNewSpec] = useState(false);
  const pendingG = useRef<number>(0);
  const signedIn = !!S.state.me && !!S.team();

  useEffect(() => { if (/^\/(spec|doc)\//.test(loc.pathname)) pushRecent(loc.pathname); }, [loc.pathname]);

  useEffect(() => {
    if (!signedIn) return;
    const k = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o); return; }
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || document.querySelector('.scrim')) return;
      if (e.key === '?') { e.preventDefault(); setHelp(true); return; }
      if (e.key === '/') { const f = document.getElementById('search') as HTMLInputElement | null; if (f) { e.preventDefault(); f.focus(); } return; }
      if (Date.now() - pendingG.current < 1200 && GO[e.key]) { e.preventDefault(); pendingG.current = 0; nav(GO[e.key]); return; }
      if (e.key === 'g') { pendingG.current = Date.now(); return; }
      if (e.key === 'n' && S.can('write')) { e.preventDefault(); setNewSpec(true); }
    };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [signedIn, nav, S]);

  if (!signedIn) return null;
  return <>
    {open && <PaletteDialog onClose={() => setOpen(false)} onNewSpec={() => { setOpen(false); setNewSpec(true); }} />}
    {help && <Sheet onClose={() => setHelp(false)}><h2>Keyboard shortcuts</h2>
      <dl className="keys">{SHORTCUTS.map((s) => <div key={s.keys}><dt>{s.keys.split(' ').map((p, i) => (p === 'then' || p === '/' && s.keys.length > 1 ? <span key={i}> {p} </span> : <kbd key={i}>{p}</kbd>))}</dt><dd>{s.what}</dd></div>)}</dl>
      <p className="note">Shortcuts do not fire while you type in a field.</p></Sheet>}
    {newSpec && <NewSpecSheet onClose={() => setNewSpec(false)} />}
  </>;
}

function PaletteDialog({ onClose, onNewSpec }: { onClose: () => void; onNewSpec: () => void }) {
  const S = useStore(); const nav = useNavigate();
  const [q, setQ] = useState(''); const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);
  useEffect(() => { input.current?.focus(); const o = opener.current; return () => { if (o?.isConnected) o.focus?.(); }; }, []);
  const go = (to: string) => () => { onClose(); nav(to); };
  const base: Cmd[] = useMemo(() => [
    ...(S.can('write') ? [{ id: 'new-spec', label: 'New spec…', hint: 'n', run: onNewSpec }] : []),
    { id: 'go-specs', label: 'Go to Specs', hint: 'g s', run: go('/') }, { id: 'go-docs', label: 'Go to Documents', hint: 'g d', run: go('/docs') }, { id: 'go-glossary', label: 'Go to Glossary', hint: 'g l', run: go('/glossary') },
    { id: 'go-release', label: 'Go to Release', hint: 'g r', run: go('/release') }, { id: 'go-garden', label: 'Go to Garden', hint: 'g a', run: go('/garden') }, { id: 'go-team', label: 'Go to Members & Git', hint: 'g t', run: go('/team') },
    { id: 'go-sync', label: 'Go to Sync', hint: 'g y', run: go('/sync') }, { id: 'go-account', label: 'Go to Account & agent access', hint: 'g c', run: go('/account') },
    { id: 'sync', label: 'Sync now', run: () => { onClose(); S.sync().then(() => toast(S.state.error ?? 'Synced')); } },
    ...(['light', 'dark', 'system'] as const).map((t) => ({ id: `theme-${t}`, label: `Appearance: ${t[0].toUpperCase()}${t.slice(1)}`, run: () => { onClose(); setTheme(t); } })),
  ], []); // eslint-disable-line react-hooks/exhaustive-deps
  const items: Cmd[] = useMemo(() => {
    const out: Cmd[] = [];
    for (const s of S.all('spec')) out.push({ id: `s:${s.id}`, label: `${s.title || 'Untitled'}`, hint: s.id, run: go(`/spec/${encodeURIComponent(s.id)}`) });
    for (const d of S.all('doc')) out.push({ id: `d:${d.id}`, label: d.id, hint: 'document', run: go(`/doc/${encodeURIComponent(d.id)}`) });
    for (const t of glossaryTerms(S)) out.push({ id: `g:${t.term}`, label: t.term, hint: 'glossary', run: go(glossaryPath(t.term)) });
    return out;
  }, [S.state.items.size]); // eslint-disable-line react-hooks/exhaustive-deps
  const recent = useMemo(() => readRecent().map((p): Cmd | null => { const m = /^\/(spec|doc)\/(.+)$/.exec(p); if (!m) return null; const id = decodeURIComponent(m[2]); const it = S.get(id); return it ? { id: `r:${p}`, label: it.title || id, hint: 'recent', run: go(p) } : null; }).filter(Boolean) as Cmd[], []); // eslint-disable-line react-hooks/exhaustive-deps
  const needle = q.trim().toLowerCase();
  const list = needle
    ? [...base, ...items].filter((c) => needle.split(/\s+/).every((w) => `${c.label} ${c.hint ?? ''}`.toLowerCase().includes(w))).slice(0, 40)
    : [...recent, ...base].slice(0, 40);
  const idx = Math.min(i, Math.max(list.length - 1, 0));
  useEffect(() => { document.getElementById(`pal-opt-${idx}`)?.scrollIntoView({ block: 'nearest' }); }, [idx]);
  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setI(Math.min(idx + 1, list.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setI(Math.max(idx - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); list[idx]?.run(); }
    else if (e.key === 'Tab') e.preventDefault(); // focus stays in the field; the list is driven with the arrow keys
  };
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet palette" role="dialog" aria-modal="true" aria-label="Command palette" data-palette onKeyDown={key}>
        <label className="sr" htmlFor="pal-q">Search commands, specs, documents and terms</label>
        <input id="pal-q" ref={input} className="field" role="combobox" aria-expanded="true" aria-controls="pal-list" aria-activedescendant={list[idx] ? `pal-opt-${idx}` : undefined} autoComplete="off" placeholder="Type a command or search…" value={q} onChange={(e) => { setQ(e.target.value); setI(0); }} />
        <ul id="pal-list" role="listbox" aria-label="Results" className="pal-list">
          {list.map((c, n) => <li key={c.id} id={`pal-opt-${n}`} role="option" aria-selected={n === idx} className={n === idx ? 'on' : ''} onMouseMove={() => setI(n)} onClick={c.run}><span>{c.label}</span>{c.hint && <kbd>{c.hint}</kbd>}</li>)}
          {!list.length && <li className="muted pal-none" role="option" aria-selected="false" aria-disabled="true">Nothing matches “{q}”.</li>}
        </ul>
        <div className="pal-foot muted"><span>↑↓ choose · ↵ open · Esc close</span><span>? all shortcuts</span></div>
      </div>
    </div>
  );
}
