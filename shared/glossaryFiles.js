// The glossary is a folder of term files: one Markdown file per term under docs/glossary/ (sub-folders group terms).
//
//   ---
//   term: "Attempt window"
//   aliases: ["retry window", "window"]
//   avoid: ["retry period"]
//   distinct: ["Retry budget"]
//   see: ["Idempotency key"]
//   source: global:7c1e…@3            (only when imported from the instance-wide glossary)
//   ---
//   The **time bucket** in which retries of one [[Invoice run]] count as the same attempt.
//
//   - free Markdown: paragraphs, lists, code, an example …
//
// Terms an agent proposes live in glossary/_proposed/ (never released) until an approver accepts them.
// Pure functions: shared by the server (migration, GLOSSARY.md, MCP) and the browser (glossary page, health, export).
import { parseDefinitions, extractRefs, extractTermRefs } from './glossary.js';

export const GLOSSARY_DIR = 'glossary';
export const PROPOSED_DIR = 'glossary/_proposed';
export const isGlossaryPath = (id) => id === GLOSSARY_DIR || String(id).startsWith(`${GLOSSARY_DIR}/`);
export const isProposedPath = (id) => id === PROPOSED_DIR || String(id).startsWith(`${PROPOSED_DIR}/`);
/** A path where a live term file may sit (the body still has to carry front matter with `term:`). */
export const isTermPath = (id) => String(id).startsWith(`${GLOSSARY_DIR}/`) && String(id).endsWith('.md') && !isProposedPath(id);

const LIST_KEYS = ['aliases', 'avoid', 'distinct', 'see'];
const STR_KEYS = ['term', 'source', 'folder', 'proposed_by', 'from'];
const FM = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

const unquote = (v) => {
  v = v.trim();
  if (/^".*"$/.test(v)) { try { return JSON.parse(v); } catch { /* fall through */ } }
  if (/^'.*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
  return v;
};
const parseList = (v) => {
  v = v.trim();
  if (!v) return [];
  if (v.startsWith('[')) {
    try { const a = JSON.parse(v); if (Array.isArray(a)) return a.map((x) => String(x).trim()).filter(Boolean); } catch { /* YAML flow list without quotes */ }
    v = v.replace(/^\[|\]$/g, '');
  }
  return v.split(',').map(unquote).map((x) => x.trim()).filter(Boolean);
};

/**
 * @typedef {{ term: string, aliases: string[], avoid: string[], distinct: string[], see: string[], origin: string|null, folder: string|null, proposedBy: string|null, from: string|null, body: string, refs: string[] }} TermFile
 */
/** @param {string} md @returns {TermFile|null} Front matter + body -> { term, aliases[], avoid[], distinct[], see[], origin, folder, proposedBy, from, body, refs[] } or null (not a term file). */
export function parseTermFile(md) {
  const text = String(md ?? '').replace(/^﻿/, '');
  const m = FM.exec(text);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const k = kv[1].toLowerCase();
    if (LIST_KEYS.includes(k)) meta[k] = parseList(kv[2]);
    else if (STR_KEYS.includes(k)) meta[k] = unquote(kv[2]);
  }
  const term = String(meta.term ?? '').trim();
  if (!term) return null;
  const body = text.slice(m[0].length).replace(/^\s*\n/, '').trimEnd();
  return {
    term, aliases: meta.aliases ?? [], avoid: meta.avoid ?? [], distinct: meta.distinct ?? [], see: meta.see ?? [],
    origin: /^global:[\w-]+@\d+$/i.test(meta.source ?? '') ? meta.source.toLowerCase() : null,
    folder: meta.folder ?? null, proposedBy: meta.proposed_by ?? null, from: meta.from ?? null,
    body, refs: allRefs(body),
  };
}

const q = (s) => JSON.stringify(String(s).replace(/[\r\n]+/g, ' ').trim());
const qList = (a) => `[${(a ?? []).map((x) => String(x).replace(/[\r\n]+/g, ' ').trim()).filter(Boolean).map((x) => JSON.stringify(x)).join(', ')}]`;
/** { term, body, aliases?, avoid?, distinct?, see?, origin?, folder?, proposedBy?, from? } -> Markdown with front matter */
export function formatTermFile(t) {
  const lines = [`term: ${q(t.term)}`];
  for (const k of LIST_KEYS) if (t[k]?.length) lines.push(`${k}: ${qList(t[k])}`);
  if (t.origin) lines.push(`source: ${t.origin}`);
  if (t.folder) lines.push(`folder: ${q(t.folder)}`);
  if (t.proposedBy) lines.push(`proposed_by: ${q(t.proposedBy)}`);
  if (t.from) lines.push(`from: ${q(t.from)}`);
  return `---\n${lines.join('\n')}\n---\n\n${String(t.body ?? '').trim()}\n`;
}

/** Both reference forms: [[Term]] (definitions) and #[Term] (running text). */
export function allRefs(md) { return [...new Set([...extractRefs(md), ...extractTermRefs(md)])]; }

/** File name of a term: lower case, ASCII, dashes ("Attempt window" -> attempt-window). */
export function slugify(term) {
  const s = String(term ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return s || 'term';
}
/** Folder segment from a free name ("Payments & Billing" -> Payments-Billing). */
export const folderSegment = (name) => String(name ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').trim().replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, 40) || 'Folder';

/** glossary/billing/x.md -> "billing"; glossary/x.md -> "" */
export const termFolder = (id) => { const p = String(id).split('/').slice(1, -1); return p.join('/'); };
/**
 * Path for a term in a folder ("" = top level); `taken(path)` says whether a path is used already.
 * @param {string} folder @param {string} term @param {(p: string) => boolean} [taken] @param {string} [dir]
 */
export function termPath(folder, term, taken = (_p) => false, dir = GLOSSARY_DIR) {
  const base = `${dir}${folder ? `/${folder}` : ''}/${slugify(term)}`;
  let p = `${base}.md`;
  for (let n = 2; taken(p); n++) p = `${base}-${n}.md`;
  return p;
}

/** Every definition an item carries: a term file is one, anything else its "Term / : definition" lists. */
export function definitionsOf(id, body) {
  if (isGlossaryPath(id) && String(id).endsWith('.md')) {
    const t = parseTermFile(body);
    if (t) return [{ term: t.term, definition: t.body, aliases: t.aliases, see: t.see, avoid: t.avoid, distinct: t.distinct, origin: t.origin, refs: t.refs, file: true }];
  }
  return parseDefinitions(body).map((d) => ({ ...d, avoid: [], distinct: [], file: false }));
}

/** The first paragraph as plain text (for lists, hover cards and the agents' short context). */
export function firstParagraph(md) {
  const blocks = String(md ?? '').trim().split(/\n\s*\n/);
  const p = blocks.find((b) => b.trim() && !/^(```|#{1,6}\s|\|)/.test(b.trim())) ?? '';
  return plainText(p);
}
export function plainText(md) {
  return String(md ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g, (_m, t, l) => (l ?? t).trim())
    .replace(/#\[([^\]|\n]+)(?:\|([^\]\n]*))?\]/g, (_m, t, l) => (l ?? t).trim())
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:[-*]\s+(?:\[[ xX]\]\s*)?|>\s?|#{1,6}\s+|\d+\.\s+)/gm, '')
    .replace(/(\*\*|__|~~|\*|_|`)/g, '')
    .replace(/\s+/g, ' ').trim();
}

const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const refRe = (name) => new RegExp(`(\\[\\[|#\\[)\\s*${esc(name.trim())}\\s*(\\|[^\\]\\n]*)?(\\]\\]|\\])`, 'gi');
/** How often a text references `name` ([[name]] or #[name], any case). */
export const countRefs = (text, name) => [...String(text ?? '').matchAll(refRe(name))].filter((m) => (m[1] === '[[') === (m[3] === ']]')).length;
/** Point every reference to `from` at `to` (labels stay). */
export function renameRefs(text, from, to) {
  return String(text ?? '').replace(refRe(from), (m, open, label, close) => {
    if ((open === '[[') !== (close === ']]')) return m;
    return `${open}${to}${label ?? ''}${close}`;
  });
}
/** Replace references to `name` with plain text (the label, else the term). */
export function unlinkRefs(text, name) {
  return String(text ?? '').replace(refRe(name), (m, open, label, close) => {
    if ((open === '[[') !== (close === ']]')) return m;
    return label ? label.slice(1).trim() : name.trim();
  });
}
/** Rename in a list ("See also", "Not to be confused with"), case-insensitive; `to` = null removes. */
export const renameInList = (list, from, to) => [...new Set((list ?? []).flatMap((x) => (x.trim().toLowerCase() === from.trim().toLowerCase() ? (to ? [to] : []) : [x])))];

/** Rewrites every reference to a term in one item body: term files (body + lists), definition lists in specs/documents and running text. */
export function rewriteRefsIn(id, body, from, to) {
  if (isGlossaryPath(id)) {
    const t = parseTermFile(body);
    if (t) {
      const next = { ...t, body: to ? renameRefs(t.body, from, to) : unlinkRefs(t.body, from), see: renameInList(t.see, from, to), distinct: renameInList(t.distinct, from, to) };
      const out = formatTermFile(next);
      return out === formatTermFile(t) ? body : out;
    }
  }
  let out = to ? renameRefs(body, from, to) : unlinkRefs(body, from);
  out = out.replace(/^(: See also:\s*)(.*)$/gim, (_m, head, rest) => {
    const list = renameInList(rest.split(/[;,]/).map((x) => x.trim()).filter(Boolean), from, to);
    return list.length ? `${head}${list.join(', ')}` : '';
  }).replace(/\n{2,}(?=: )/g, '\n');
  return out;
}
/** References to `name` in one body: [[…]], #[…] and "See also"/"Not to be confused with" lists. */
export function refsIn(id, body, name) {
  let n = countRefs(body, name);
  const k = name.trim().toLowerCase();
  const t = isGlossaryPath(id) ? parseTermFile(body) : null;
  if (t) n += [...t.see, ...t.distinct].filter((x) => x.trim().toLowerCase() === k).length;
  else for (const d of parseDefinitions(body)) n += d.see.filter((x) => x.trim().toLowerCase() === k).length;
  return n;
}

/** Words to avoid that a text uses: [{ word, term, line }] – code (fences, inline) does not count. */
export function avoidHits(md, terms) {
  const lines = String(md ?? '').replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, ' ')).replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length)).split('\n');
  const out = [];
  for (const t of terms) {
    for (const w of t.avoid ?? []) {
      if (!w.trim()) continue;
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${esc(w.trim())})(?![\\p{L}\\p{N}])`, 'iu');
      lines.forEach((l, i) => { const m = re.exec(l); if (m) out.push({ word: m[2], term: t.term, line: i + 1, text: l.trim() }); });
    }
  }
  return out;
}
/** Replace an avoided word with the term it stands for (outside code). */
export function replaceWord(md, word, term) {
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${esc(word.trim())})(?![\\p{L}\\p{N}])`, 'giu');
  return String(md ?? '').split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, i) => (i % 2 ? part : part.replace(re, (_m, pre) => `${pre}${term}`))).join('');
}

const PROTECTED = /(```[\s\S]*?```|`[^`\n]*`|#\[[^\]\n]*\]|\[\[[^\]\n]*\]\]|\[[^\]\n]*\]\([^)\n]*\))/;
const wordRe = (w, flags = 'iu') => new RegExp(`(^|[^\\p{L}\\p{N}])(${esc(w.trim())})(?![\\p{L}\\p{N}])`, flags);
/** The first plain mention of `word` (outside code, links and references), or null. */
export function firstMention(md, word) {
  const parts = String(md ?? '').split(PROTECTED);
  for (let i = 0; i < parts.length; i += 2) { const m = wordRe(word).exec(parts[i]); if (m) return m[2]; }
  return null;
}
/** Turns the first plain mention of `word` into a reference #[term] (#[term|word] when the text differs). */
export function linkFirst(md, word, term) {
  const parts = String(md ?? '').split(PROTECTED);
  for (let i = 0; i < parts.length; i += 2) {
    const m = wordRe(word).exec(parts[i]);
    if (!m) continue;
    const at = m.index + m[1].length;
    const ref = m[2] === term ? `#[${term}]` : `#[${term}|${m[2]}]`;
    parts[i] = parts[i].slice(0, at) + ref + parts[i].slice(at + m[2].length);
    return parts.join('');
  }
  return md;
}

/** glossary.md (the old single file) -> [{ folder, term, body, aliases, see, origin }]. "## X" is a folder, "### Y" a sub-folder of the last "## X". */
export function splitGlossaryMd(md) {
  const out = [];
  let h2 = '', h3 = '';
  let chunk = [];
  const flush = () => {
    const folder = [h2, h3].filter(Boolean).map(folderSegment).join('/');
    for (const d of parseDefinitions(chunk.join('\n'))) out.push({ folder, term: d.term, body: d.definition, aliases: d.aliases, see: d.see, origin: d.origin });
    chunk = [];
  };
  let fence = false;
  for (const l of String(md ?? '').replace(/\r\n/g, '\n').split('\n')) {
    if (/^```/.test(l)) fence = !fence;
    const h = !fence && /^(#{2,3})\s+(.*)$/.exec(l);
    if (h) { flush(); if (h[1].length === 2) { h2 = h[2].trim(); h3 = ''; } else h3 = h[2].trim(); continue; }
    chunk.push(l);
  }
  flush();
  return out;
}

// ---------------------------------------------------------------- CSV
const cell = (v) => { const s = String(v ?? ''); return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
/** terms: [{ term, body, aliases, see, avoid, distinct, folder }] -> CSV (comma, quoted, header row; lists are "|"-separated). */
export function termsToCsv(terms) {
  const head = ['term', 'definition', 'aliases', 'see also', 'avoid', 'not to be confused with', 'folder'];
  const rows = terms.map((t) => [t.term, t.body, (t.aliases ?? []).join(' | '), (t.see ?? []).join(' | '), (t.avoid ?? []).join(' | '), (t.distinct ?? []).join(' | '), t.folder ?? '']);
  return [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
