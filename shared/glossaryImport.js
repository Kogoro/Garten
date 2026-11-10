// Parses glossary files for the import into the global glossary: CSV/TSV, JSON or a Markdown definition list.
// Pure functions (no DOM) so the same code can be tested in Node.
import { parseDefinitions } from './glossary.js';

const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[|;,]/)).map((x) => String(x).trim()).filter(Boolean);
const COLS = {
  term: ['term', 'begriff', 'name', 'title'],
  definition: ['definition', 'description', 'beschreibung', 'bedeutung', 'meaning'],
  aliases: ['aliases', 'alias', 'synonyms', 'synonym', 'synonyme', 'aka', 'also known as'],
  see: ['see', 'see also', 'related', 'siehe auch', 'verweise', 'references'],
};
const pick = (obj, names) => { for (const k of Object.keys(obj)) if (names.includes(k.trim().toLowerCase())) return obj[k]; return undefined; };

function parseCsv(text) {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const delim = [',', ';', '\t'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some((x) => x.trim())) rows.push(row); row = []; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); if (row.some((x) => x.trim())) rows.push(row); }
  return rows;
}

function fromRows(rows) {
  if (!rows.length) return { terms: [], errors: ['The file is empty'] };
  const head = rows[0].map((x) => x.trim().toLowerCase());
  const has = (k) => head.findIndex((h) => COLS[k].includes(h));
  const headed = has('term') >= 0;
  const idx = headed ? { term: has('term'), definition: has('definition'), aliases: has('aliases'), see: has('see') } : { term: 0, definition: 1, aliases: 2, see: 3 };
  const terms = [];
  const errors = [];
  rows.slice(headed ? 1 : 0).forEach((r, n) => {
    const line = n + (headed ? 2 : 1);
    const term = (r[idx.term] ?? '').trim();
    const definition = (r[idx.definition] ?? '').trim();
    if (!term && !definition) return;
    if (!term || !definition) { errors.push(`Row ${line}: a term and a definition are required`); return; }
    terms.push({ term, definition, aliases: list(idx.aliases >= 0 ? r[idx.aliases] : ''), see: list(idx.see >= 0 ? r[idx.see] : '') });
  });
  return { terms, errors };
}

function fromJson(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { return { terms: [], errors: [`Invalid JSON: ${e.message}`] }; }
  let items = Array.isArray(data) ? data : Array.isArray(data?.terms) ? data.terms : null;
  if (!items && data && typeof data === 'object') items = Object.entries(data).map(([term, definition]) => ({ term, definition })); // { "Term": "Definition" }
  if (!items) return { terms: [], errors: ['Expected a JSON array of terms'] };
  const terms = [];
  const errors = [];
  items.forEach((it, n) => {
    const term = String(pick(it ?? {}, COLS.term) ?? '').trim();
    const definition = String(pick(it ?? {}, COLS.definition) ?? '').trim();
    if (!term || !definition) { errors.push(`Entry ${n + 1}: a term and a definition are required`); return; }
    terms.push({ term, definition, aliases: list(pick(it, COLS.aliases)), see: list(pick(it, COLS.see)) });
  });
  return { terms, errors };
}

function fromMarkdown(text) {
  const terms = parseDefinitions(text).map((d) => ({ term: d.term, definition: d.definition, aliases: d.aliases, see: d.see }));
  return { terms, errors: terms.length ? [] : ['No definitions found. Expected “Term” followed by “: Definition” lines, a CSV with term,definition columns, or JSON.'] };
}

/** -> { terms: [{ term, definition, aliases[], see[] }], errors: string[] } */
export function parseGlossaryFile(name, text) {
  text = String(text ?? '').replace(/^﻿/, '');
  const ext = String(name ?? '').toLowerCase().split('.').pop();
  const t = text.trim();
  let out;
  if (ext === 'json' || (!['csv', 'tsv', 'md', 'markdown', 'txt'].includes(ext) && /^[[{]/.test(t))) out = fromJson(text);
  else if (ext === 'csv' || ext === 'tsv') out = fromRows(parseCsv(text));
  else out = fromMarkdown(text);
  // the same term twice in one file: keep the first, report the rest
  const seen = new Set();
  out.terms = out.terms.filter((x) => { const k = x.term.toLowerCase(); if (seen.has(k)) { out.errors.push(`“${x.term}” appears more than once – only the first is used`); return false; } seen.add(k); return true; });
  return out;
}
