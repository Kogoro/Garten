import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { ic } from './icons';
import * as S from './store/core';
import type { Item } from './store/types';

/** Re-render on every store change (the store is a mutable singleton; `version` is the snapshot). */
export function useStore(): typeof S {
  useSyncExternalStore(S.subscribe, S.getVersion);
  return S;
}

type IconName = keyof typeof ic;
export const Icon = ({ name, size }: { name: IconName; size?: number }) => <span style={{ display: 'inline-flex' }} dangerouslySetInnerHTML={{ __html: (ic[name] as (s?: number) => string)(size) }} />;

export function ago(ts?: number | null) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 172800) return 'yesterday';
  return new Date(ts).toLocaleDateString();
}
export const touched = (i: Item) => i.editedAt ?? (i.updatedAt ? Date.parse(i.updatedAt) : 0);

// ---- toast
export interface ToastAction { label: string; run: () => void }
let toastEl: ((m: string, a?: ToastAction) => void) | null = null;
/** A short message; with an action (e.g. Undo) it stays a little longer and can be tapped. */
export const toast = (m: string, a?: ToastAction) => toastEl?.(m, a);
export function Toaster() {
  useEffect(() => {
    const el = document.getElementById('toast')!;
    let t: ReturnType<typeof setTimeout>;
    toastEl = (m, a) => {
      el.replaceChildren(document.createTextNode(m));
      el.classList.toggle('has-action', !!a);
      if (a) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'toast-act'; b.textContent = a.label;
        b.onclick = () => { el.classList.remove('show'); clearTimeout(t); a.run(); };
        el.append(b);
      }
      el.classList.add('show'); clearTimeout(t); t = setTimeout(() => el.classList.remove('show'), a ? 6000 : 2800);
    };
    return () => { toastEl = null; };
  }, []);
  return <div id="toast" role="status" aria-live="polite" />;
}

// ---- theme (system / light / dark), same keys as the vanilla app
const KEY = 'specs-theme';
export const themePref = () => { try { return localStorage.getItem(KEY) || 'system'; } catch { return 'system'; } };
export const effectiveTheme = (): 'light' | 'dark' => { const p = themePref(); return p !== 'system' ? (p as 'light' | 'dark') : matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; };
export function applyTheme() {
  const p = themePref(); const el = document.documentElement;
  if (p === 'system') el.removeAttribute('data-theme'); else el.dataset.theme = p;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', effectiveTheme() === 'light' ? '#F9FAF9' : '#0B0D0C');
}
export function setTheme(pref: string) { try { pref === 'system' ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, pref); } catch { /* private mode */ } applyTheme(); }

export const Page = ({ children }: { children: ReactNode }) => <div className="scroll"><div className="page">{children}</div></div>;

export async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Copy not available here — select the text instead'); }
}
