import { db } from './db.js';
import { cleanForm, formTemplate } from '../shared/specForm.js';
import { BUILTIN_TYPES, builtinKeys, DEFAULT_TYPE } from '../shared/spectypes.js';

export class TypeError_ extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const custom = (r) => ({ key: r.key, label: r.label, short: r.label, description: r.description, template: r.template, form: r.form ? JSON.parse(r.form) : null, view: r.form ? r.view : 'editor', builtin: false });
export function listTypes(teamId) {
  const mine = db.prepare('SELECT * FROM spec_types WHERE team_id=? ORDER BY label COLLATE NOCASE').all(teamId).map(custom);
  return [...BUILTIN_TYPES.map((t) => ({ ...t, builtin: true })), ...mine];
}
export const isKnownType = (teamId, key) => key === DEFAULT_TYPE || builtinKeys.has(key) || !!db.prepare('SELECT 1 FROM spec_types WHERE team_id=? AND key=?').get(teamId, key);
export const typeLabel = (teamId, key) => listTypes(teamId).find((t) => t.key === key)?.label ?? key;
export const specsUsingType = (teamId, key) => db.prepare("SELECT COUNT(*) AS n FROM items WHERE team_id=? AND kind='spec' AND deleted=0 AND spec_type=?").get(teamId, key).n;

function clean(b) {
  const label = String(b?.label ?? '').replace(/\s+/g, ' ').trim();
  const description = String(b?.description ?? '').replace(/\s+/g, ' ').trim();
  const template = String(b?.template ?? '').replace(/\r\n/g, '\n');
  if (!label || label.length > 40) throw new TypeError_('A type needs a name of 1–40 characters');
  if (description.length > 200) throw new TypeError_('The description can have up to 200 characters');
  if (template.length > 20000) throw new TypeError_('The template is too long (20 000 characters at most)');
  let form = null;
  try { form = cleanForm(b?.form); } catch (e) { throw new TypeError_(`Form: ${e.message}`); }
  const view = form && b?.view === 'form' ? 'form' : 'editor';
  // a form type starts new specs from its (empty) sections
  return { label, description, template: form && view === 'form' ? formTemplate(form) : template, form, view };
}
const slug = (label) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 24);

export function createType(teamId, body) {
  const t = clean(body);
  const key = slug(String(body?.key ?? t.label));
  if (!/^[a-z][a-z0-9-]{1,23}$/.test(key)) throw new TypeError_('Could not derive a key from that name – use letters and digits');
  if (builtinKeys.has(key) || isKnownType(teamId, key)) throw new TypeError_(`A type with the key “${key}” already exists`, 409);
  db.prepare('INSERT INTO spec_types (team_id,key,label,description,template,form,view,created_at) VALUES (?,?,?,?,?,?,?,?)').run(teamId, key, t.label, t.description, t.template, t.form ? JSON.stringify(t.form) : null, t.view, new Date().toISOString());
  return listTypes(teamId).find((x) => x.key === key);
}
export function updateType(teamId, key, body) {
  if (builtinKeys.has(key)) throw new TypeError_('Built-in types cannot be changed', 403);
  const cur = db.prepare('SELECT * FROM spec_types WHERE team_id=? AND key=?').get(teamId, key);
  if (!cur) throw new TypeError_('Unknown type', 404);
  const t = clean({ ...cur, form: cur.form ? JSON.parse(cur.form) : null, ...body });
  db.prepare('UPDATE spec_types SET label=?, description=?, template=?, form=?, view=? WHERE team_id=? AND key=?').run(t.label, t.description, t.template, t.form ? JSON.stringify(t.form) : null, t.view, teamId, key);
  return listTypes(teamId).find((x) => x.key === key);
}
export function deleteType(teamId, key) {
  if (builtinKeys.has(key)) throw new TypeError_('Built-in types cannot be deleted', 403);
  const n = specsUsingType(teamId, key);
  if (n) throw new TypeError_(`${n} spec${n === 1 ? ' uses' : 's use'} this type – change their type first`, 409);
  return db.prepare('DELETE FROM spec_types WHERE team_id=? AND key=?').run(teamId, key).changes > 0;
}
