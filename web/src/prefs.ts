import { useCallback, useState } from 'react';

/** A setting that stays on this device (list sorting, filters, density). Falls back to memory when storage is unavailable. */
export function usePref<T extends string>(key: string, initial: T, allowed?: readonly T[]): [T, (v: T) => void] {
  const read = (): T => { try { const v = localStorage.getItem(`specs-pref-${key}`); return v !== null && (!allowed || (allowed as readonly string[]).includes(v)) ? (v as T) : initial; } catch { return initial; } };
  const [value, setValue] = useState<T>(read);
  const set = useCallback((v: T) => { setValue(v); try { localStorage.setItem(`specs-pref-${key}`, v); } catch { /* private mode */ } }, [key]);
  return [value, set];
}

export type Density = 'comfortable' | 'compact';
const DENSITY_KEY = 'specs-density';
export const densityPref = (): Density => { try { return localStorage.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable'; } catch { return 'comfortable'; } };
export function applyDensity() { const d = densityPref(); if (d === 'compact') document.documentElement.dataset.density = 'compact'; else delete document.documentElement.dataset.density; }
export function setDensity(d: Density) { try { d === 'compact' ? localStorage.setItem(DENSITY_KEY, d) : localStorage.removeItem(DENSITY_KEY); } catch { /* private mode */ } applyDensity(); }

import { useEffect } from 'react';
/** Follows a CSS media query (e.g. "is this a phone?") so a component can render one layout instead of two. */
export function useMedia(query: string): boolean {
  const get = () => (typeof matchMedia === 'function' ? matchMedia(query).matches : false);
  const [on, setOn] = useState(get);
  useEffect(() => { if (typeof matchMedia !== 'function') return; const m = matchMedia(query); const f = () => setOn(m.matches); f(); m.addEventListener('change', f); return () => m.removeEventListener('change', f); }, [query]);
  return on;
}
