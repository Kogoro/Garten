import { create } from 'zustand';
import type { SpecType } from './store/types';

export interface MenuItem { key: string; label: string; danger?: boolean; current?: boolean; disabled?: boolean }
interface MenuState { title: string; items: MenuItem[]; resolve: (k: string | null) => void }

interface UiState {
  mode: 'blocks' | 'markdown';
  openFolders: Record<string, boolean>;
  lastFolder: string;
  lastType: string;
  menu: MenuState | null;
  set: (p: Partial<UiState>) => void;
}
export const useUi = create<UiState>((set) => ({
  mode: 'blocks', openFolders: {}, lastFolder: '', lastType: 'feature', menu: null,
  set: (p) => set(p),
}));

/** Bottom-sheet menu: resolves with the picked key, or null when dismissed. */
export function openMenu(title: string, items: MenuItem[]): Promise<string | null> {
  return new Promise((resolve) => useUi.getState().set({ menu: { title, items, resolve } }));
}
export type { SpecType };
