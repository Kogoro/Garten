// Instance-wide glossary. Instance admins maintain it; every team can import terms (as editable copies that remember
// their source and revision, so an "update available" hint can be shown when the global term changes).
import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { splitList } from '../public/glossary.js';

export class GlossaryError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const toTerm = (r) => r && {
  id: r.id, term: r.term, definition: r.definition, aliases: JSON.parse(r.aliases), see: JSON.parse(r.see),
  rev: r.rev, updatedAt: r.updated_at, updatedBy: r.updated_by,
};
export const listGlobalTerms = () => db.prepare('SELECT * FROM global_terms ORDER BY term COLLATE NOCASE').all().map(toTerm);
export const getGlobalTerm = (id) => toTerm(db.prepare('SELECT * FROM global_terms WHERE id=?').get(id));

function validate(b) {
  const term = String(b?.term ?? '').replace(/\s+/g, ' ').trim();
  const definition = String(b?.definition ?? '').replace(/\s*\n\s*/g, ' ').trim();
  const list = (v) => (Array.isArray(v) ? v : splitList(v)).map((x) => String(x).replace(/[;,\n]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const aliases = list(b?.aliases);
  const see = list(b?.see);
  if (!term || term.length > 80) throw new GlossaryError('A term needs 1–80 characters');
  if (/[\[\]|]/.test(term)) throw new GlossaryError('Terms cannot contain [ ] or |');
  if (!definition || definition.length > 2000) throw new GlossaryError('A definition needs 1–2000 characters');
  if (aliases.length > 10 || see.length > 20 || [...aliases, ...see].some((x) => x.length > 80)) throw new GlossaryError('Too many or too long aliases / related terms');
  return { term, definition, aliases, see };
}

export function createGlobalTerm(body, by) {
  const t = validate(body);
  if (db.prepare('SELECT 1 FROM global_terms WHERE term=?').get(t.term)) throw new GlossaryError(`“${t.term}” already exists in the global glossary`, 409);
  const id = randomUUID();
  db.prepare('INSERT INTO global_terms (id,term,definition,aliases,see,rev,updated_at,updated_by) VALUES (?,?,?,?,?,1,?,?)')
    .run(id, t.term, t.definition, JSON.stringify(t.aliases), JSON.stringify(t.see), new Date().toISOString(), by?.name ?? null);
  return getGlobalTerm(id);
}
export function updateGlobalTerm(id, body, by) {
  const cur = getGlobalTerm(id);
  if (!cur) throw new GlossaryError('Unknown term', 404);
  const t = validate({ ...cur, ...body });
  const clash = db.prepare('SELECT id FROM global_terms WHERE term=? AND id<>?').get(t.term, id);
  if (clash) throw new GlossaryError(`“${t.term}” already exists in the global glossary`, 409);
  db.prepare('UPDATE global_terms SET term=?, definition=?, aliases=?, see=?, rev=rev+1, updated_at=?, updated_by=? WHERE id=?')
    .run(t.term, t.definition, JSON.stringify(t.aliases), JSON.stringify(t.see), new Date().toISOString(), by?.name ?? null, id);
  return getGlobalTerm(id);
}
export const deleteGlobalTerm = (id) => db.prepare('DELETE FROM global_terms WHERE id=?').run(id).changes > 0;

/** Bulk import (file import in the admin UI). mode: 'skip' keeps existing terms, 'update' overwrites changed ones. */
export function importGlobalTerms(list, mode, by) {
  if (!Array.isArray(list)) throw new GlossaryError('Expected a list of terms');
  if (list.length > 2000) throw new GlossaryError('Import up to 2000 terms at a time');
  const res = { created: 0, updated: 0, unchanged: 0, skipped: 0, errors: [] };
  for (const raw of list) {
    try {
      const t = validate(raw);
      const cur = db.prepare('SELECT * FROM global_terms WHERE term=?').get(t.term);
      if (!cur) { createGlobalTerm(t, by); res.created++; }
      else if (mode !== 'update') res.skipped++;
      else {
        const old = toTerm(cur);
        if (JSON.stringify([old.definition, old.aliases, old.see]) === JSON.stringify([t.definition, t.aliases, t.see])) res.unchanged++;
        else { updateGlobalTerm(cur.id, t, by); res.updated++; }
      }
    } catch (e) {
      if (!(e instanceof GlossaryError)) throw e;
      res.errors.push({ term: String(raw?.term ?? '').slice(0, 80), error: e.message });
    }
  }
  return res;
}
