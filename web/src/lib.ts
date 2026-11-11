import { hasContent } from '@shared/glossary.js';
import type * as Store from './store/core';
import type { Item } from './store/types';

export const CORE_LABEL: Record<string, string> = { 'vision.md': 'Vision', 'strategy.md': 'Strategy', 'guardrails.md': 'Guardrails', 'glossary.md': 'Glossary' };
export const rawMode = (i: Item) => i.kind === 'doc' && !i.id.endsWith('.md');
export const enc = encodeURIComponent;

/** Status of a foundation document (vision, strategy, glossary, pinned): live for agents, going live, or empty. */
export function foundState(d: Item, S: typeof Store): { text: string; cls: string; live: boolean } {
  if (!hasContent(d.body)) return { text: 'Not written yet', cls: '', live: false };
  if (d.status === 'approved' && !S.hasUnreleased(d)) return { text: `Live v${d.version}`, cls: 'ok', live: true };
  return { text: S.team()?.foundationAuto === false ? 'Needs approval' : 'Going live…', cls: 'warn', live: false };
}
export const initial = (s?: string) => (s ?? '?').trim()[0]?.toUpperCase() ?? '?';
export { hasContent };

/** Waiting for an approver: a draft with a title, or a released spec with edits that are not released yet. */
export const awaitsApproval = (S: any, s: { status: string; title: string }): boolean => (s.status !== 'approved' ? !!s.title.trim() : S.hasUnreleased(s));
