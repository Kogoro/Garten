import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { parseDefinitions } from '@shared/glossary.js';
import type * as Store from './store/core';
import type { Item } from './store/types';

export interface Def { term: string; definition: string; aliases: string[]; see: string[]; origin: string | null; refs: string[]; item: Item; folder: string | null }
export interface Term { term: string; defs: Def[] }

export function glossaryTerms(S: typeof Store): Term[] {
  const model = S.glossaryModel();
  const map = new Map<string, Term>();
  for (const it of S.state.items.values() as Iterable<Item>) {
    if (it.del || it.kind === 'folder') continue;
    for (const d of parseDefinitions(it.body) as any[]) {
      const k = d.term.toLowerCase();
      if (!map.has(k)) map.set(k, { term: d.term, defs: [] });
      map.get(k)!.defs.push({ ...d, item: it, folder: it.id === 'glossary.md' ? (model.where.get(k) ?? '') : null });
    }
  }
  return [...map.values()].sort((a, b) => a.term.localeCompare(b.term));
}
export function termIndex(terms: Term[]) {
  const idx = new Map<string, string>();
  for (const t of terms) { idx.set(t.term.toLowerCase(), t.term); for (const d of t.defs) for (const a of d.aliases) if (!idx.has(a.toLowerCase())) idx.set(a.toLowerCase(), t.term); }
  return idx;
}
export const glossaryPath = (term: string) => `/glossary/${encodeURIComponent(term)}`;
export const plain = (text: string) => String(text).replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g, (_m, t, l) => (l ?? t).trim());
const escRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function mentions(S: typeof Store, t: Term, ownIds: Set<string>): Item[] {
  const names = [t.term, ...new Set(t.defs.flatMap((d) => d.aliases))];
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${names.map(escRe).join('|')})(?![\\p{L}\\p{N}])`, 'iu');
  return [...S.all('spec'), ...S.all('doc')].filter((it) => !ownIds.has(it.id) && it.id !== 'glossary.md' && re.test(it.body));
}
export const groupOf = (t: Term) => { const own = t.defs.find((d) => d.item.id === 'glossary.md'); return own ? own.folder ?? '' : '__specs'; };

export function TermRef({ name, idx, label }: { name: string; idx: Map<string, string>; label?: string }) {
  const known = idx.get(name.toLowerCase());
  return <Link to={glossaryPath(known ?? name)} className={`termref${known ? '' : ' broken'}`} title={known ? `Open “${known}”` : 'Not defined in this glossary yet'}>{label ?? name}</Link>;
}
/** Text with [[Term]] / [[Term|label]] references turned into links (undefined terms are flagged). */
export function Linkify({ text, idx }: { text: string; idx: Map<string, string> }) {
  const out: ReactNode[] = [];
  const re = /\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g;
  let last = 0, m: RegExpExecArray | null, n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<TermRef key={n++} name={m[1].trim()} idx={idx} label={(m[2] ?? m[1]).trim()} />);
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return <>{out.map((x, i) => <Fragment key={i}>{x}</Fragment>)}</>;
}
