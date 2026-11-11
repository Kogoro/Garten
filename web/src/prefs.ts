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
