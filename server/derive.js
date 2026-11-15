// Deriving glossary entries and specs from an existing document (done by an agent through the MCP tool `derive_from_document`).
//
// Nothing here releases anything: results are DRAFTS carrying a "Derived from" line, so people see where they came from and review them.
//  - Glossary entries become proposed term files (glossary/_proposed/<term>.md). They never go live by themselves: an approver
//    accepts them in the Glossary (Proposed tab), which moves them into a folder of the glossary.
//  - Terms that are already defined (released, in a draft or proposed elsewhere) are not written again; they are reported back so the agent can link to them.
import * as store from './store.js';
import { glossaryEntries } from './store.js';
import { definitionsOf, parseTermFile, formatTermFile, termPath, isProposedPath, PROPOSED_DIR } from '../shared/glossaryFiles.js';
import { listTypes, isKnownType } from './specTypes.js';

const key = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');

/** The text a derivation starts from: a document (path) or a spec (id), working copy preferred. */
export function readSource(t, source) {
  const item = store.getItem(t, source);
  if (!item || (item.kind !== 'doc' && item.kind !== 'spec')) throw new store.ApiError(`No document or spec "${source}".`);
  return item;
}

/** key(term/alias) -> { term, definition, where } over released files and all working copies (proposals included, except their own file). */
/** @param {any} team @param {(item: any) => boolean} [skip] */
async function knownTerms(team, skip = () => false) {
  const known = new Map();
  const add = (d, where) => {
    for (const k of [d.term, ...(d.aliases ?? [])]) if (!known.has(key(k))) known.set(key(k), { term: d.term, definition: d.definition, where });
  };
  for (const e of await glossaryEntries(team)) add(e, `${e.source} (released)`);
  for (const i of [...store.allDocs(team.id), ...store.allSpecs(team.id)]) {
    if (skip(i)) continue;
    for (const d of definitionsOf(i.id, i.body)) add(d, `${i.id} (${isProposedPath(i.id) ? 'proposed' : 'draft'})`);
  }
  return known;
}

/** Proposed term files of the team: key(term) -> item */
const proposals = (t) => new Map(store.allDocs(t).filter((d) => isProposedPath(d.id)).map((d) => /** @type {[string, any]} */ ([key(parseTermFile(d.body)?.term ?? d.id), d])).filter(([k]) => k));

/**
 * entries: [{ term, definition, aliases?, see_also?, avoid?, folder? }] -> proposed term files (one per term).
 * Returns { proposed: [path], added[], updated[], exists[] } – `exists` are terms (or aliases) already defined elsewhere; they are left alone.
 * A proposal of the same term from an earlier call (by anyone) is updated instead of duplicated.
 */
export async function proposeTerms(team, entries, by, from = null) {
  const t = team.id;
  const mine = proposals(t);
  const known = await knownTerms(team, (i) => isProposedPath(i.id) && entries.some((e) => mine.get(key(e.term))?.id === i.id));
  const added = []; const updated = []; const exists = []; const paths = [];
  for (const e of entries) {
    const term = e.term.trim();
    const other = [term, ...(e.aliases ?? [])].map((k) => known.get(key(k))).find(Boolean);
    if (other) { exists.push({ term, defined_as: other.term, definition: other.definition, in: other.where }); continue; }
    const cur = mine.get(key(term));
    const body = formatTermFile({ term, body: e.definition, aliases: e.aliases ?? [], see: e.see_also ?? [], avoid: e.avoid ?? [], folder: e.folder || null, proposedBy: by?.name ? `${by.name}${by.via ? ` (${by.via})` : ''}` : 'an agent', from });
    const id = cur?.id ?? termPath('', term, (p) => !!store.getItem(t, p), PROPOSED_DIR);
    const item = store.saveItem(t, { id, kind: 'doc', title: id, body, links: [] }, cur?.rev ?? 0, by);
    (cur ? updated : added).push(term);
    paths.push(item.id);
    known.set(key(term), { term, definition: e.definition, where: `${item.id} (proposed)` });
  }
  return { proposed: paths, added, updated, exists };
}

/** specs: [{ title, type?, body }] -> new draft specs, each with a "## SOURCE" section. */
export function deriveSpecs(team, source, specs, by) {
  const t = team.id;
  const out = [];
  for (const s of specs) {
    if (s.type && !isKnownType(t, s.type)) throw new store.ApiError(`Unknown spec type "${s.type}". Known: ${listTypes(t).map((x) => x.key).join(', ')}`);
  }
  for (const s of specs) {
    const id = store.nextSpecId(team);
    const links = [];
    const body = `${s.body.trim()}\n\n## SOURCE\n\nDerived from \`${source}\` by an agent – not yet reviewed.\n`;
    const item = store.saveItem(t, { id, kind: 'spec', title: s.title, body, links, specType: s.type ?? 'feature' }, 0, by);
    out.push({ id: item.id, rev: item.rev, type: item.specType, title: item.title, documents: item.links });
  }
  return out;
}

