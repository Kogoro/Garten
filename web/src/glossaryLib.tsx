import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { parse as parseBlocks } from '@shared/blocksModel.js';
import { definitionsOf, isGlossaryPath, isProposedPath, isTermPath, termFolder, plainText, firstParagraph, avoidHits, parseTermFile, firstMention, allRefs } from '@shared/glossaryFiles.js';
import { setTermLookup } from './editor/termLookup';
import { mdToInline, type Inline } from './editor/inline';
import type * as Store from './store/core';
import type { Item } from './store/types';

export interface Def { term: string; definition: string; aliases: string[]; see: string[]; avoid: string[]; distinct: string[]; origin: string | null; refs: string[]; item: Item; folder: string | null; own: boolean }
export interface Term { term: string; defs: Def[] }

/** Every term of the team: term files (own = true, with their folder) and definition lists in specs and documents. Proposals are not terms yet. */
let memo: { v: number; team: string | null; terms: Term[] } = { v: -1, team: null, terms: [] };
export function glossaryTerms(S: typeof Store): Term[] {
  // parsed once per store version: lists, chips, suggestions and health all read it on every render
  if (memo.v === S.getVersion() && memo.team === S.state.teamId) return memo.terms;
  const terms = computeTerms(S);
  memo = { v: S.getVersion(), team: S.state.teamId, terms };
  return terms;
}
function computeTerms(S: typeof Store): Term[] {
  const map = new Map<string, Term>();
  for (const it of S.state.items.values() as Iterable<Item>) {
    if (it.del || it.kind === 'folder' || isProposedPath(it.id)) continue;
    for (const d of definitionsOf(it.id, it.body) as any[]) {
      const own = !!d.file && isTermPath(it.id);
      const k = d.term.toLowerCase();
      if (!map.has(k)) map.set(k, { term: d.term, defs: [] });
      map.get(k)!.defs.push({ ...d, avoid: d.avoid ?? [], distinct: d.distinct ?? [], item: it, folder: own ? termFolder(it.id) : null, own });
    }
  }
  for (const t of map.values()) t.defs.sort((a, b) => Number(b.own) - Number(a.own)); // the glossary's own file first
  return [...map.values()].sort((a, b) => a.term.localeCompare(b.term));
}
export function termIndex(terms: Term[]) {
  const idx = new Map<string, string>();
  for (const t of terms) { idx.set(t.term.toLowerCase(), t.term); for (const d of t.defs) for (const a of d.aliases) if (!idx.has(a.toLowerCase())) idx.set(a.toLowerCase(), t.term); }
  return idx;
}
export const glossaryPath = (term: string) => `/glossary/${encodeURIComponent(term)}`;
export const plain = (text: string) => plainText(text);
export { firstParagraph };
const escRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentionRe = (t: Term) => new RegExp(`(^|[^\\p{L}\\p{N}])(${[t.term, ...new Set(t.defs.flatMap((d) => d.aliases))].map(escRe).join('|')})(?![\\p{L}\\p{N}])`, 'iu');

/** Specs and documents that use a term (by name, synonym or #[reference]), not counting the files that define it. */
export function mentions(S: typeof Store, t: Term, ownIds: Set<string>): Item[] {
  const re = mentionRe(t);
  return [...S.all('spec'), ...S.all('doc')].filter((it) => !ownIds.has(it.id) && !isGlossaryPath(it.id) && re.test(plainText(it.body)));
}
/** Where a term is used, with the sentence: [{ item, line }] */
export function usages(S: typeof Store, t: Term, ownIds: Set<string>): { item: Item; line: string }[] {
  const re = mentionRe(t);
  return mentions(S, t, ownIds).map((item) => ({ item, line: item.body.split('\n').map(plainText).find((l) => re.test(l)) ?? '' }));
}
export const groupOf = (t: Term) => { const own = t.defs.find((d) => d.own); return own ? own.folder ?? '' : '__specs'; };

export function TermRef({ name, idx, label }: { name: string; idx: Map<string, string>; label?: string }) {
  const known = idx.get(name.toLowerCase());
  return <Link to={glossaryPath(known ?? name)} className={`termref${known ? '' : ' broken'}`} title={known ? `Open “${known}”` : 'Not defined in this glossary yet'}>{label ?? name}</Link>;
}
const REF = /\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]|#\[([^\]|\n]+)(?:\|([^\]\n]*))?\]/g;
/** Text with [[Term]] / #[Term] references (optionally with |label) turned into links; undefined terms are flagged. */
export function Linkify({ text, idx }: { text: string; idx: Map<string, string> }) {
  const out: ReactNode[] = [];
  let last = 0, m: RegExpExecArray | null, n = 0;
  // eslint-disable-next-line react-hooks/immutability -- module-level /g regex, reset before each use
  REF.lastIndex = 0;
  while ((m = REF.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const name = (m[1] ?? m[3]).trim();
    out.push(<TermRef key={`r${n++}`} name={name} idx={idx} label={(m[2] ?? m[4] ?? name).trim()} />);
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return <>{out.map((x, i) => <Fragment key={i}>{x}</Fragment>)}</>;
}

function Inl({ c, idx }: { c: Inline[]; idx: Map<string, string> }) {
  return <>{c.map((x, i) => {
    if (x.type === 'link') return <a key={i} href={x.href} target="_blank" rel="noopener noreferrer"><Inl c={x.content} idx={idx} /></a>;
    if (x.type === 'termref') return <TermRef key={i} name={x.props.term} idx={idx} label={x.props.label || x.props.term} />;
    let el: ReactNode = x.styles.code ? <code>{x.text}</code> : <Linkify text={x.text} idx={idx} />;
    if (x.styles.strike) el = <s>{el}</s>;
    if (x.styles.italic) el = <em>{el}</em>;
    if (x.styles.bold) el = <strong>{el}</strong>;
    return <Fragment key={i}>{el}</Fragment>;
  })}</>;
}
/** Read view of a definition: the Markdown the editor writes (paragraphs, headings, lists, checklists, quotes, code, tables) with term references as links. */
export function Md({ text, idx }: { text: string; idx: Map<string, string> }) {
  const blocks: any[] = parseBlocks(text);
  const out: ReactNode[] = [];
  const inl = (t: string) => <Inl c={mdToInline(t ?? '')} idx={idx} />;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === 'li' || b.type === 'task') {
      const items: any[] = [];
      while (i < blocks.length && blocks[i].type === b.type) items.push(blocks[i++]);
      i--;
      out.push(<ul key={i} className={b.type === 'task' ? 'md-tasks' : undefined}>{items.map((x, k) => <li key={k}>{b.type === 'task' && <input type="checkbox" checked={!!x.checked} readOnly disabled aria-label={x.checked ? 'done' : 'open'} />}{inl(x.text)}</li>)}</ul>);
      continue;
    }
    switch (b.type) {
      case 'h': out.push(b.level <= 2 ? <h3 key={i}>{inl(b.text)}</h3> : <h4 key={i}>{inl(b.text)}</h4>); break;
      case 'quote': out.push(<blockquote key={i}>{inl(b.text)}</blockquote>); break;
      case 'code': case 'diagram': case 'endpoint': out.push(<pre key={i}><code>{b.type === 'endpoint' ? `${b.method} ${b.path}\n${b.text}` : b.text}</code></pre>); break;
      case 'hr': out.push(<hr key={i} />); break;
      case 'req': out.push(<p key={i}><b className="mono">{b.label}</b> {inl(b.text)}</p>); break;
      case 'table': out.push(<div className="md-table" key={i}><table><thead><tr>{b.rows[0].map((c: string, k: number) => <th key={k}>{inl(c)}</th>)}</tr></thead><tbody>{b.rows.slice(1).map((r: string[], k: number) => <tr key={k}>{r.map((c, j) => <td key={j}>{inl(c)}</td>)}</tr>)}</tbody></table></div>); break;
      case 'img': out.push(<p key={i}><a href={b.src} target="_blank" rel="noopener noreferrer">{b.text || b.src}</a></p>); break;
      case 'def': out.push(<p key={i}><strong>{b.term}</strong>: {inl(b.text)}</p>); break;
      default: out.push(<p key={i}>{b.text.split('\n').map((l: string, k: number) => <Fragment key={k}>{k > 0 && <br />}{inl(l)}</Fragment>)}</p>);
    }
  }
  return <div className="md">{out}</div>;
}

// ---------------------------------------------------------------- health: what is wrong in the glossary
export interface Issue { id: string; kind: 'conflict' | 'broken' | 'avoid' | 'alias' | 'update' | 'unused'; title: string; detail: string; term?: string; item?: Item; word?: string; global?: any }
export const ISSUE_GROUPS: { kind: Issue['kind']; label: string }[] = [
  { kind: 'conflict', label: 'Two definitions' }, { kind: 'broken', label: 'Broken references' }, { kind: 'avoid', label: 'Words to avoid in specs' },
  { kind: 'alias', label: 'Synonym used by two terms' }, { kind: 'update', label: 'Update from the global glossary' }, { kind: 'unused', label: 'Not used anywhere' },
];
export function glossaryIssues(S: typeof Store): Issue[] {
  const terms = glossaryTerms(S);
  const idx = termIndex(terms);
  const out: Issue[] = [];
  for (const t of terms) if (new Set(t.defs.map((d) => plainText(d.definition))).size > 1) out.push({ id: `conflict:${t.term}`, kind: 'conflict', title: t.term, detail: `Defined in ${t.defs.map((d) => d.item.id).join(' and ')}`, term: t.term });
  const broken = new Map<string, Issue>();
  for (const it of [...S.all('spec'), ...S.all('doc')]) {
    if (isProposedPath(it.id)) continue;
    const t = isGlossaryPath(it.id) ? parseTermFile(it.body) : null;
    const names: string[] = t ? [...t.refs, ...t.see, ...t.distinct] : [...((it.body.match(/(?<![\w&#/])#\[([^\]|\n]+)(?:\|[^\]\n]*)?\]/g) ?? []).map((m) => m.replace(/^#\[|\]$/g, '').split('|')[0].trim())), ...definitionsOf(it.id, it.body).flatMap((d: any) => d.refs)];
    for (const n of names) {
      if (idx.has(n.toLowerCase())) continue;
      const key = `broken:${n.toLowerCase()}:${it.id}`;
      if (!broken.has(key)) broken.set(key, { id: key, kind: 'broken', title: n, detail: `in ${t ? `the term ${t.term}` : it.id} – not defined`, term: n, item: it });
    }
  }
  out.push(...broken.values());
  const withAvoid = terms.map((t) => ({ term: t.term, avoid: [...new Set(t.defs.flatMap((d) => d.avoid))] })).filter((t) => t.avoid.length);
  for (const s of S.all('spec')) for (const h of avoidHits(s.body, withAvoid)) {
    const id = `avoid:${s.id}:${h.word.toLowerCase()}`;
    if (!out.some((x) => x.id === id)) out.push({ id, kind: 'avoid', title: h.word, detail: `${s.id} · use ${h.term}`, term: h.term, item: s, word: h.word });
  }
  const owner = new Map<string, string[]>();
  for (const t of terms) for (const a of new Set(t.defs.filter((d) => d.own).flatMap((d) => d.aliases.map((x) => x.toLowerCase())))) owner.set(a, [...(owner.get(a) ?? []), t.term]);
  for (const [a, ts] of owner) {
    const clash = idx.get(a) && !ts.includes(idx.get(a)!) && terms.some((t) => t.term.toLowerCase() === a) ? [...ts, idx.get(a)!] : ts;
    if (clash.length > 1) out.push({ id: `alias:${a}`, kind: 'alias', title: a, detail: `${clash.join(' and ')} both use it`, term: clash[0] });
  }
  for (const t of terms) for (const d of t.defs.filter((x) => x.own && x.origin)) {
    const o = S.parseOrigin(d.origin); const g = o && (S.state.globalTerms as any[]).find((x) => x.id === o.id);
    if (o && g && g.rev > o.rev) out.push({ id: `update:${t.term}`, kind: 'update', title: t.term, detail: `Revision ${g.rev} is available (you have ${o.rev})`, term: t.term, item: d.item, global: g });
  }
  const referenced = new Set(terms.flatMap((t) => t.defs.flatMap((d) => [...d.refs, ...d.see, ...d.distinct])).map((x) => (idx.get(x.toLowerCase()) ?? x).toLowerCase()));
  for (const t of terms) {
    if (!t.defs.some((d) => d.own) || referenced.has(t.term.toLowerCase())) continue;
    if (!mentions(S, t, new Set(t.defs.map((d) => d.item.id))).length) out.push({ id: `unused:${t.term}`, kind: 'unused', title: t.term, detail: 'No spec or document mentions it', term: t.term });
  }
  return out;
}

/** Lets the term chips in the editors show the current glossary. Call while rendering a page that hosts an editor. */
export function registerTermLookup(S: typeof Store) {
  const terms = glossaryTerms(S);
  const idx = termIndex(terms);
  setTermLookup((name) => {
    const canon = idx.get(name.trim().toLowerCase());
    const t = canon ? terms.find((x) => x.term === canon) : undefined;
    if (!t) return null;
    const d = t.defs.find((x) => x.own) ?? t.defs[0];
    return { term: t.term, folder: d.folder ?? d.item.id, text: firstParagraph(d.definition) || plainText(d.definition), aliases: [...new Set(t.defs.flatMap((x) => x.aliases))], avoid: [...new Set(t.defs.flatMap((x) => x.avoid))], version: d.own && d.item.status === 'approved' ? d.item.version : undefined };
  });
}

/** Words to avoid of the glossary's own terms: [{ term, avoid[] }] */
export const avoidList = (S: typeof Store) => glossaryTerms(S).map((t) => ({ term: t.term, avoid: [...new Set(t.defs.filter((d) => d.own).flatMap((d) => d.avoid))] })).filter((t) => t.avoid.length);
export interface Suggestion { kind: 'avoid' | 'link'; word: string; term: string; line?: number }
/** What the glossary suggests for one spec: avoided words to replace, and defined terms it mentions without referencing them. */
export function specSuggestions(S: typeof Store, body: string): Suggestion[] {
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  for (const h of avoidHits(body, avoidList(S))) { const k = `a:${h.word.toLowerCase()}`; if (!seen.has(k)) { seen.add(k); out.push({ kind: 'avoid', word: h.word, term: h.term, line: h.line }); } }
  const refs = new Set(allRefs(body).map((r: string) => r.toLowerCase()));
  const avoided = new Set(out.map((x) => x.word.toLowerCase()));
  const own = new Set(definitionsOf('', body).map((d: any) => d.term.toLowerCase()));
  for (const t of glossaryTerms(S).filter((x) => x.defs.some((d) => d.own))) {
    const names = [t.term, ...new Set(t.defs.flatMap((d) => d.aliases))].filter((n) => n.length >= 4);
    if (own.has(t.term.toLowerCase()) || names.some((n) => refs.has(n.toLowerCase()))) continue;
    for (const n of names) { const w = firstMention(body, n); if (w && !avoided.has(w.toLowerCase())) { out.push({ kind: 'link', word: w, term: t.term }); break; } }
  }
  return out;
}
