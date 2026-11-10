// Block model: Markdown <-> blocks. Pure functions (no DOM), shared by the editor and the tests.
// The stored format stays plain Markdown so agents and Git see ordinary files; blocks are only an editing view.
import { formatDefinition, parseDefLines, splitList } from './glossary.js';

let uid = 0;
export const nid = () => `b${++uid}`;

// ------------------------------------------------------------------ Markdown <-> blocks
const FENCE = /^```\s*([\w+-]*)[ \t]*(.*)$/;
const HEAD = /^(#{1,6})\s+(.*)$/;
const TASK = /^\s*[-*]\s+\[([ xX])\]\s?(.*)$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const REQ = /^(R\d+)(?:\s+(.*))?$/;
const QUOTE = /^>\s?(.*)$/;
const HR = /^(?:---+|\*\*\*+)\s*$/;
const DEF = /^: (.*)$/;
const startsBlock = (l) => FENCE.test(l) || HEAD.test(l) || TASK.test(l) || BULLET.test(l) || REQ.test(l) || QUOTE.test(l) || HR.test(l);

export function parse(md) {
  const lines = String(md ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if (!l.trim()) continue;
    if ((m = FENCE.exec(l))) {
      const body = [];
      for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) body.push(lines[i]);
      const lang = m[1].toLowerCase();
      const info = (m[2] ?? '').trim();
      if (lang === 'mermaid') out.push({ id: nid(), type: 'diagram', text: body.join('\n'), view: 'view' });
      else if (lang === 'endpoint') out.push({ id: nid(), type: 'endpoint', ...parseEndpoint(info, body.join('\n')) });
      else out.push({ id: nid(), type: 'code', lang, info, text: body.join('\n') });
    } else if ((m = HEAD.exec(l))) out.push({ id: nid(), type: 'h', level: Math.min(m[1].length, 3), text: m[2] });
    else if ((m = TASK.exec(l))) out.push({ id: nid(), type: 'task', checked: m[1] !== ' ', text: m[2] });
    else if ((m = BULLET.exec(l))) out.push({ id: nid(), type: 'li', text: m[1] });
    else if ((m = REQ.exec(l))) out.push({ id: nid(), type: 'req', label: m[1], text: m[2] ?? '' });
    else if (HR.test(l)) out.push({ id: nid(), type: 'hr', text: '' });
    else if ((m = QUOTE.exec(l))) {
      const q = [m[1]];
      while (i + 1 < lines.length && (m = QUOTE.exec(lines[i + 1]))) (q.push(m[1]), i++);
      out.push({ id: nid(), type: 'quote', text: q.join('\n') });
    } else if (DEF.test(lines[i + 1] ?? '')) { // definition list entry: "Term" + ": definition"
      const defs = [];
      while (DEF.test(lines[i + 1] ?? '')) defs.push(DEF.exec(lines[++i])[1]);
      const d = parseDefLines(defs);
      out.push({ id: nid(), type: 'def', term: l.trim(), text: d.definition, aliases: d.aliases.join(', '), see: d.see.join(', '), src: d.origin ?? '' });
    } else {
      const p = [l];
      while (i + 1 < lines.length && lines[i + 1].trim() && !startsBlock(lines[i + 1]) && !DEF.test(lines[i + 2] ?? '')) p.push(lines[++i]);
      out.push({ id: nid(), type: 'p', text: p.join('\n') });
    }
  }
  return out;
}

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
/** ```endpoint GET /orders/{id}  +  description, optional "Request:" / "Responses:" sections */
export function parseEndpoint(info, body) {
  const [first, ...rest] = info.split(/\s+/);
  const isMethod = METHODS.includes(first?.toUpperCase());
  const parts = { text: [], req: [], res: [] };
  let cur = 'text';
  for (const l of body.split('\n')) {
    if (l === 'Request:') cur = 'req';
    else if (l === 'Responses:') cur = 'res';
    else parts[cur].push(l);
  }
  const j = (a) => a.join('\n').trim();
  return { method: isMethod ? first.toUpperCase() : 'GET', path: isMethod ? rest.join(' ') : info, text: j(parts.text), req: j(parts.req), res: j(parts.res) };
}
export const fenceSafe = (t) => String(t ?? '').replace(/```/g, "'''");
const LISTY = new Set(['task', 'li', 'req']);
const line = (b) => {
  switch (b.type) {
    case 'h': return `${'#'.repeat(b.level || 2)} ${b.text}`;
    case 'task': return `- [${b.checked ? 'x' : ' '}] ${b.text}`;
    case 'li': return `- ${b.text}`;
    case 'req': return `${b.label} ${b.text}`.trimEnd();
    case 'quote': return b.text.split('\n').map((t) => `> ${t}`).join('\n');
    case 'hr': return '---';
    case 'def': return formatDefinition(b.term, b.text, { aliases: splitList(b.aliases), see: splitList(b.see), origin: b.src || null });
    case 'code': return `\`\`\`${b.lang ?? ''}${b.info ? ' ' + b.info : ''}\n${b.text}\n\`\`\``;
    case 'endpoint': return `\`\`\`endpoint ${b.method} ${fenceSafe(b.path).trim()}\n${fenceSafe(b.text).trim()}${b.req?.trim() ? `\n\nRequest:\n${fenceSafe(b.req).trim()}` : ''}${b.res?.trim() ? `\n\nResponses:\n${fenceSafe(b.res).trim()}` : ''}\n\`\`\``;
    case 'diagram': return `\`\`\`mermaid\n${b.text}\n\`\`\``;
    default: return b.text;
  }
};
export function serialize(blocks) {
  const kept = blocks.filter((b) => b.type === 'hr' || b.type === 'diagram' || b.type === 'code' || (b.type === 'endpoint' ? b.path.trim() : false) || (b.type === 'def' ? b.term.trim() && b.text.trim() : b.text.trim()));
  let s = '';
  kept.forEach((b, i) => {
    if (i) s += LISTY.has(b.type) && LISTY.has(kept[i - 1].type) ? '\n' : '\n\n';
    s += line(b);
  });
  return s ? s + '\n' : '';
}

