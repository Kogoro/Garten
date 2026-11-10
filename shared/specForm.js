// Spec forms: a spec type can describe its content as a form (fields, lists, tabs) instead of free-form blocks.
// The stored format stays plain Markdown: every field is a `## LABEL` section, so agents, Git and the block editor keep
// working on the same file. parseForm() reads a body into field values; serializeForm() writes it back. Anything the
// schema does not know (other sections, text before the first heading, leftovers inside a field) is preserved.
import { fenceSafe, parseEndpoint } from './blocksModel.js';

export const FIELD_KINDS = ['text', 'longtext', 'select', 'list', 'checklist', 'requirements', 'endpoints', 'diagram', 'code'];
export const KIND_LABELS = {
  text: 'Single line', longtext: 'Text', select: 'Choice', list: 'List', checklist: 'Checklist', requirements: 'Requirements (R1, R2 …)',
  endpoints: 'API endpoints', diagram: 'Diagram (Mermaid)', code: 'Code',
};
const HEAD = /^##\s+(.*?)\s*#*\s*$/;
const FENCE_OPEN = /^```\s*([\w+-]*)[ \t]*(.*)$/;
const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Validates and normalises a form schema (server + client). Throws Error with a readable message. */
export function cleanForm(raw) {
  if (raw == null || raw === '') return null;
  const f = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!f || !Array.isArray(f.fields)) throw new Error('A form needs a list of fields');
  if (f.fields.length < 1 || f.fields.length > 40) throw new Error('A form can have 1–40 fields');
  const tabs = (Array.isArray(f.tabs) ? f.tabs : []).slice(0, 8).map((t) => ({ key: String(t.key ?? '').slice(0, 24), label: String(t.label ?? '').replace(/\s+/g, ' ').trim().slice(0, 30) })).filter((t) => t.key && t.label);
  const seenKeys = new Set();
  const seenLabels = new Set();
  const fields = f.fields.map((x) => {
    const label = String(x.label ?? '').replace(/\s+/g, ' ').replace(/^#+\s*/, '').trim();
    if (!label || label.length > 60) throw new Error('Every field needs a label of 1–60 characters');
    if (!FIELD_KINDS.includes(x.kind)) throw new Error(`Unknown field type “${x.kind}”`);
    let key = String(x.key ?? '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 30) || norm(label).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'field';
    while (seenKeys.has(key)) key += '_';
    seenKeys.add(key);
    if (seenLabels.has(norm(label))) throw new Error(`Two fields are called “${label}”`);
    seenLabels.add(norm(label));
    const out = { key, label, kind: x.kind };
    if (x.help) out.help = String(x.help).slice(0, 200);
    if (x.tab && tabs.some((t) => t.key === x.tab)) out.tab = x.tab;
    if (x.kind === 'select') {
      out.options = (Array.isArray(x.options) ? x.options : String(x.options ?? '').split(',')).map((o) => String(o).trim()).filter(Boolean).slice(0, 30);
      if (!out.options.length) throw new Error(`“${label}” needs at least one choice`);
    }
    if (x.kind === 'code') out.lang = String(x.lang ?? '').replace(/[^\w+-]/g, '').slice(0, 12);
    return out;
  });
  if (JSON.stringify({ tabs, fields }).length > 20000) throw new Error('The form is too large');
  return { tabs, fields };
}

// ------------------------------------------------------------------ body -> sections
function splitSections(body) {
  const lines = String(body ?? '').replace(/\r\n/g, '\n').split('\n');
  const preface = [];
  const sections = [];
  let cur = null;
  let fence = false;
  for (const l of lines) {
    const isFence = /^```/.test(l);
    if (isFence) fence = !fence;
    const h = !fence && !isFence ? HEAD.exec(l) : null;
    if (h && !l.startsWith('###')) { cur = { heading: h[1], lines: [] }; sections.push(cur); continue; }
    (cur ? cur.lines : preface).push(l);
  }
  return { preface: preface.join('\n').trim(), sections };
}

/** Pulls fenced blocks out of a section: -> { fences: [{lang, info, body}], rest: string } */
function takeFences(lines) {
  const fences = [];
  const rest = [];
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE_OPEN.exec(lines[i]);
    if (m) {
      const body = [];
      for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) body.push(lines[i]);
      fences.push({ lang: m[1].toLowerCase(), info: (m[2] ?? '').trim(), body: body.join('\n') });
    } else rest.push(lines[i]);
  }
  return { fences, rest: rest.join('\n').trim() };
}
const bullets = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean);

function parseField(f, lines) {
  const text = lines.join('\n').trim();
  switch (f.kind) {
    case 'text': return { value: text.split('\n').map((l) => l.trim()).filter(Boolean).join(' '), rest: '' };
    case 'longtext': return { value: text, rest: '' };
    case 'select': return { value: text.split('\n')[0]?.trim() ?? '', rest: text.split('\n').slice(1).join('\n').trim() };
    case 'list': return { value: bullets(text).map((l) => l.replace(/^[-*]\s+(\[[ xX]\]\s*)?/, '')), rest: '' };
    case 'checklist': return { value: bullets(text).map((l) => { const m = /^[-*]\s+\[([ xX])\]\s?(.*)$/.exec(l); return m ? { text: m[2], done: m[1] !== ' ' } : { text: l.replace(/^[-*]\s+/, ''), done: false }; }), rest: '' };
    case 'requirements': {
      const items = [];
      const rest = [];
      for (const l of lines) { const m = /^R\d+(?:\s+(.*))?$/.exec(l.trim()); if (m) items.push(m[1] ?? ''); else if (l.trim()) rest.push(l); }
      return { value: items, rest: rest.join('\n').trim() };
    }
    case 'endpoints': {
      const { fences, rest } = takeFences(lines);
      const eps = fences.filter((x) => x.lang === 'endpoint').map((x) => parseEndpoint(x.info, x.body));
      const other = fences.filter((x) => x.lang !== 'endpoint').map((x) => `\`\`\`${x.lang}${x.info ? ` ${x.info}` : ''}\n${x.body}\n\`\`\``);
      return { value: eps, rest: [rest, ...other].filter(Boolean).join('\n\n') };
    }
    case 'diagram': case 'code': {
      const { fences, rest } = takeFences(lines);
      const want = f.kind === 'diagram' ? 'mermaid' : null;
      const i = fences.findIndex((x) => (want ? x.lang === want : true));
      const others = fences.filter((_, k) => k !== i).map((x) => `\`\`\`${x.lang}${x.info ? ` ${x.info}` : ''}\n${x.body}\n\`\`\``);
      return { value: i >= 0 ? fences[i].body : '', rest: [rest, ...others].filter(Boolean).join('\n\n') };
    }
    default: return { value: text, rest: '' };
  }
}

export const emptyValue = (f) => (['list', 'checklist', 'requirements', 'endpoints'].includes(f.kind) ? [] : '');

/** body -> { values: {key: value}, rest: {key: leftover markdown}, preface, extra } */
export function parseForm(schema, body) {
  const { preface, sections } = splitSections(body);
  const values = {};
  const rest = {};
  const extra = [];
  const used = new Set();
  for (const s of sections) {
    const f = schema.fields.find((x) => !used.has(x.key) && (norm(x.label) === norm(s.heading) || norm(x.key) === norm(s.heading)));
    if (!f) { extra.push(`## ${s.heading}\n${s.lines.join('\n')}`.trimEnd()); continue; }
    used.add(f.key);
    const p = parseField(f, s.lines);
    values[f.key] = p.value;
    if (p.rest) rest[f.key] = p.rest;
  }
  for (const f of schema.fields) if (!(f.key in values)) values[f.key] = emptyValue(f);
  return { values, rest, preface, extra: extra.join('\n\n').trim() };
}

// ------------------------------------------------------------------ values -> body
const endpointFence = (e) => `\`\`\`endpoint ${e.method || 'GET'} ${fenceSafe(e.path).trim()}\n${fenceSafe(e.text).trim()}${String(e.req ?? '').trim() ? `\n\nRequest:\n${fenceSafe(e.req).trim()}` : ''}${String(e.res ?? '').trim() ? `\n\nResponses:\n${fenceSafe(e.res).trim()}` : ''}\n\`\`\``;

function fieldBody(f, v, counter) {
  switch (f.kind) {
    case 'text': return String(v ?? '').replace(/\s*\n\s*/g, ' ').trim();
    case 'longtext': case 'select': return String(v ?? '').trim();
    case 'list': return (v ?? []).map((x) => String(x).replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean).map((x) => `- ${x}`).join('\n');
    case 'checklist': return (v ?? []).filter((x) => String(x.text ?? '').trim()).map((x) => `- [${x.done ? 'x' : ' '}] ${String(x.text).replace(/\s*\n\s*/g, ' ').trim()}`).join('\n');
    case 'requirements': return (v ?? []).map((x) => String(x).replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean).map((x) => `R${++counter.n} ${x}`).join('\n');
    case 'endpoints': return (v ?? []).filter((e) => String(e.path ?? '').trim()).map(endpointFence).join('\n\n');
    case 'diagram': return String(v ?? '').trim() ? `\`\`\`mermaid\n${fenceSafe(String(v).replace(/\s+$/, ''))}\n\`\`\`` : '';
    case 'code': return String(v ?? '').trim() ? `\`\`\`${f.lang ?? ''}\n${fenceSafe(String(v).replace(/\s+$/, ''))}\n\`\`\`` : '';
    default: return '';
  }
}

/** { values, rest, preface, extra } -> Markdown body */
export function serializeForm(schema, state = {}) {
  const { values = {}, rest = {}, preface = '', extra = '' } = state;
  const counter = { n: 0 };
  const parts = [];
  if (String(preface).trim()) parts.push(String(preface).trim());
  for (const f of schema.fields) {
    const body = [fieldBody(f, values[f.key], counter), String(rest[f.key] ?? '').trim()].filter(Boolean).join('\n\n');
    parts.push(`## ${f.label}${body ? `\n\n${body}` : ''}`);
  }
  if (String(extra).trim()) parts.push(String(extra).trim());
  return `${parts.join('\n\n')}\n`;
}

/** The body a new spec of this type starts with: all sections, empty. */
export const formTemplate = (schema) => serializeForm(schema, {});
export const formIsEmpty = (schema, state) => schema.fields.every((f) => !fieldBody(f, state.values[f.key], { n: 0 }));
