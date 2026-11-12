// Deriving glossary entries and specs from an existing document (done by an agent through the MCP tool `derive_from_document`).
//
// Nothing here releases anything: results are DRAFTS carrying a "Derived from" line, so people see where they came from and review them.
//  - Glossary entries go into one draft document per source (`glossary/from-<source>.md`) as Markdown definition lists. Such a document
//    reaches the glossary the usual way: it is released together with a spec that links it.
//  - Terms that are already defined (released or in another draft) are not written again; they are reported back so the agent can link to them.
import * as store from './store.js';
import { glossaryEntries } from './store.js';
import { parseDefinitions, formatDefinition } from '../shared/glossary.js';
import { listTypes, isKnownType } from './specTypes.js';

const key = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');
export const derivedDocPath = (source) => `glossary/from-${source.replace(/\.(md|yaml|yml|json|txt)$/i, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'source'}.md`;
const HEAD = (source) => `# Terms derived from ${source}\n\n_Proposed by an agent. A person checks every definition before it goes live._\n`;

/** The text a derivation starts from: a document (path) or a spec (id), working copy preferred. */
export function readSource(t, source) {
  const item = store.getItem(t, source);
  if (!item || (item.kind !== 'doc' && item.kind !== 'spec')) throw new store.ApiError(`No document or spec "${source}".`);
  return item;
}

/** key(term/alias) -> { term, definition, where } over released files and all working copies except `skipDoc`. */
async function knownTerms(team, skipDoc) {
  const known = new Map();
  const add = (d, where) => {
    for (const k of [d.term, ...(d.aliases ?? [])]) if (!known.has(key(k))) known.set(key(k), { term: d.term, definition: d.definition, where });
  };
  for (const e of await glossaryEntries(team)) add(e, `${e.source} (released)`);
  for (const i of [...store.allDocs(team.id), ...store.allSpecs(team.id)]) {
    if (i.id === skipDoc) continue;
    for (const d of parseDefinitions(i.body)) add(d, `${i.id} (draft)`);
  }
  return known;
}

/**
 * entries: [{ term, definition, aliases?, see_also? }] -> writes/merges the draft glossary document of `source`.
 * Returns { path, rev, added[], updated[], exists[] } – `exists` are terms (or aliases) someone else already defines; they are left alone.
 */
export async function deriveGlossary(team, source, entries, by) {
  const t = team.id;
  const path = derivedDocPath(source);
  const cur = store.getItem(t, path);
  if (cur && cur.kind !== 'doc') throw new store.ApiError(`${path} is not a document.`);
  const known = await knownTerms(team, path);
  const own = new Map(parseDefinitions(cur?.body ?? '').map((d) => [key(d.term), d]));
  const added = []; const updated = []; const exists = [];
  for (const e of entries) {
    const term = e.term.trim();
    const other = [term, ...(e.aliases ?? [])].map((k) => known.get(key(k))).find(Boolean);
    if (other) { exists.push({ term, defined_as: other.term, definition: other.definition, in: other.where }); continue; }
    (own.has(key(term)) ? updated : added).push(term);
    own.set(key(term), { term, definition: e.definition, aliases: e.aliases ?? [], see: e.see_also ?? [], origin: null });
  }
  if (!added.length && !updated.length) return { path: cur ? path : null, rev: cur?.rev, added, updated, exists };
  const body = [...own.values()].sort((a, b) => a.term.localeCompare(b.term)).map((d) => formatDefinition(d.term, d.definition, { aliases: d.aliases, see: d.see })).join('\n\n');
  const item = store.saveItem(t, { id: path, kind: 'doc', title: path, body: `${HEAD(source)}\n${body}\n`, links: [] }, cur?.rev ?? 0, by);
  return { path, rev: item.rev, added, updated, exists };
}

/** specs: [{ title, type?, body }] -> new draft specs, each with a "## SOURCE" section and linked to the glossary draft (so the terms go live with the first released spec). */
export function deriveSpecs(team, source, specs, { glossaryPath }, by) {
  const t = team.id;
  const out = [];
  for (const s of specs) {
    if (s.type && !isKnownType(t, s.type)) throw new store.ApiError(`Unknown spec type "${s.type}". Known: ${listTypes(t).map((x) => x.key).join(', ')}`);
  }
  for (const s of specs) {
    const id = store.nextSpecId(team);
    const links = glossaryPath ? [glossaryPath] : [];
    const body = `${s.body.trim()}\n\n## SOURCE\n\nDerived from \`${source}\` by an agent – not yet reviewed.\n`;
    const item = store.saveItem(t, { id, kind: 'spec', title: s.title, body, links, specType: s.type ?? 'feature' }, 0, by);
    out.push({ id: item.id, rev: item.rev, type: item.specType, title: item.title, documents: item.links });
  }
  return out;
}

/** Link the glossary draft to an existing draft spec so that it is released with it. */
export function attachGlossary(t, specId, path, by) {
  const spec = store.getItem(t, specId);
  if (!spec || spec.kind !== 'spec') throw new store.ApiError(`No spec "${specId}".`);
  if (spec.links.includes(path)) return spec;
  return store.saveItem(t, { id: specId, kind: 'spec', links: [...spec.links, path] }, spec.rev, by);
}
