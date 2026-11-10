// Block model (Markdown <-> blocks), the block editor and Mermaid rendering.
// The stored format stays plain Markdown so agents and Git see ordinary files; blocks are only an editing view.
import { esc, ic, $, $$, effectiveTheme } from './ui.js';
import { formatDefinition, parseDefLines, splitList } from './glossary.js';

let uid = 0;
const nid = () => `b${++uid}`;

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
function parseEndpoint(info, body) {
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
const fenceSafe = (t) => String(t ?? '').replace(/```/g, "'''");
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

// ------------------------------------------------------------------ Mermaid
const MM_THEMES = {
  dark: { background: '#171B1F', primaryColor: '#12261E', primaryTextColor: '#E8ECEF', primaryBorderColor: '#5FD4A0', lineColor: '#9AA4AE', secondaryColor: '#14223A', tertiaryColor: '#171B1F', fontFamily: 'Inter, system-ui, sans-serif' },
  light: { background: '#FFFFFF', primaryColor: '#E3F4EC', primaryTextColor: '#14181C', primaryBorderColor: '#0B7A52', lineColor: '#5A6672', secondaryColor: '#E7EFFC', tertiaryColor: '#FFFFFF', fontFamily: 'Inter, system-ui, sans-serif' },
};
/** (Re-)initialises Mermaid for the current app theme; call again after the theme changed, then re-render diagrams. */
export function configureMermaid() {
  const t = effectiveTheme();
  window.mermaid?.initialize({ startOnLoad: false, securityLevel: 'strict', theme: t === 'light' ? 'default' : 'dark', suppressErrorRendering: true, themeVariables: MM_THEMES[t] });
}
let mermaidP;
export function loadMermaid() {
  mermaidP ??= new Promise((resolve, reject) => {
    if (window.mermaid) return resolve(window.mermaid);
    const s = document.createElement('script');
    s.src = '/vendor/mermaid.min.js';
    s.onload = () => {
      configureMermaid();
      resolve(window.mermaid);
    };
    s.onerror = () => { mermaidP = undefined; reject(new Error('The diagram library is not available offline yet. Open the app once while online.')); };
    document.head.appendChild(s);
  });
  return mermaidP;
}
let mmN = 0;
let mmQueue = Promise.resolve();
/** Render Mermaid source into `el` (serialised – Mermaid is not re-entrant). */
export function renderDiagram(el, src) {
  const job = async () => {
    if (!el.isConnected) return;
    if (!src.trim()) { el.innerHTML = '<span class="mm-hint">Empty diagram – write Mermaid code on the left.</span>'; el.classList.remove('err'); return; }
    try {
      const mm = await loadMermaid();
      await mm.parse(src);
      const { svg } = await mm.render(`mm${++mmN}`, src);
      if (el.isConnected) { el.innerHTML = svg; el.classList.remove('err'); }
    } catch (e) {
      document.getElementById(`dmm${mmN}`)?.remove();
      if (el.isConnected) { el.classList.add('err'); el.innerHTML = `<span class="mm-hint">${esc(String(e.message ?? e).split('\n')[0])}</span>`; }
    }
  };
  mmQueue = mmQueue.then(job, job);
}

export const DIAGRAM_TEMPLATES = {
  Flowchart: 'flowchart TD\n  A[Client] --> B{Valid key?}\n  B -- yes --> C[Return first result]\n  B -- no --> D[Create charge]',
  'Sequence diagram': 'sequenceDiagram\n  participant C as Client\n  participant S as Billing\n  C->>S: charge(key)\n  S-->>C: result',
  'State diagram': 'stateDiagram-v2\n  [*] --> Draft\n  Draft --> Approved: approve\n  Approved --> Draft: edit',
  'ER diagram': 'erDiagram\n  INVOICE ||--o{ CHARGE : has\n  CHARGE {\n    string idempotency_key\n  }',
  'Class diagram': 'classDiagram\n  class Invoice {\n    +id\n    +retry()\n  }',
};
export const CODE_LANGS = ['', 'yaml', 'json', 'sql', 'ts', 'python', 'bash', 'http', 'plantuml', 'd2', 'dot'];

// ------------------------------------------------------------------ block types (menu)
const nextReq = (blocks) => Math.max(0, ...blocks.filter((b) => b.type === 'req').map((b) => Number(/\d+/.exec(b.label)?.[0] ?? 0))) + 1;
export const BLOCK_TYPES = [
  { key: 'p', label: 'Text', make: () => ({ type: 'p', text: '' }) },
  { key: 'h1', label: 'Heading 1', make: () => ({ type: 'h', level: 1, text: '' }) },
  { key: 'h2', label: 'Heading 2', make: () => ({ type: 'h', level: 2, text: '' }) },
  { key: 'h3', label: 'Heading 3', make: () => ({ type: 'h', level: 3, text: '' }) },
  { key: 'req', label: 'Requirement (R1, R2 …)', make: (blocks) => ({ type: 'req', label: `R${nextReq(blocks)}`, text: '' }) },
  { key: 'task', label: 'Checklist item', make: () => ({ type: 'task', checked: false, text: '' }) },
  { key: 'li', label: 'Bullet', make: () => ({ type: 'li', text: '' }) },
  { key: 'def', label: 'Definition (glossary term)', make: () => ({ type: 'def', term: '', text: '', aliases: '', see: '', src: '' }) },
  { key: 'quote', label: 'Quote / note', make: () => ({ type: 'quote', text: '' }) },
  { key: 'code', label: 'Code block', make: () => ({ type: 'code', lang: '', text: '' }) },
  { key: 'endpoint', label: 'API endpoint', make: () => ({ type: 'endpoint', method: 'GET', path: '', text: '', req: '', res: '' }) },
  { key: 'diagram', label: 'Diagram (Mermaid)', make: () => ({ type: 'diagram', text: DIAGRAM_TEMPLATES.Flowchart, view: 'split' }) },
  { key: 'hr', label: 'Divider', make: () => ({ type: 'hr', text: '' }) },
];
const typeKey = (b) => (b.type === 'h' ? `h${b.level}` : b.type);
const TEXTLIKE = new Set(['p', 'h', 'req', 'task', 'li', 'quote']);

// ------------------------------------------------------------------ editor
/**
 * ctx: { onChange(md), readonly, menu(title, items) -> Promise<key|null> }
 * Returns a controller: .insert(typeKey) (at the caret), .insertText(text), .setMarkdown(md).
 */
export function mountBlocks(root, md, ctx) {
  let blocks = parse(md);
  let focus = -1;
  let focusAt = 'end';
  let lastMd = md;
  let suppressClick = false;
  const timers = new Map();
  const caret = { i: -1, pos: 0 };

  const emitChange = () => { lastMd = serialize(blocks); ctx.onChange(lastMd); };
  const idx = (el) => Number(el.closest('.blk')?.dataset.i ?? -1);
  const track = (el) => { if (el?.classList?.contains('blk-in') || el?.classList?.contains('def-term')) { caret.i = idx(el); caret.pos = el.selectionStart ?? 0; caret.inTerm = el.classList.contains('def-term'); } };

  function blockHtml(b, i) {
    const ro = ctx.readonly;
    const ta = (cls = '', ph = '', val = b.text, field = 'text', aria = `${typeKey(b)} block`) =>
      `<textarea class="blk-in ${cls}" data-f="${field}" rows="1" spellcheck="${b.type === 'code' || b.type === 'diagram' || b.type === 'endpoint' ? 'false' : 'true'}" placeholder="${esc(ph)}" ${ro ? 'readonly' : ''} aria-label="${esc(aria)}">${esc(val ?? '')}</textarea>`;
    let inner;
    switch (b.type) {
      case 'h': inner = ta(`h${b.level}`, `Heading ${b.level}`); break;
      case 'req': inner = `<span class="rid">${esc(b.label)}</span>${ta('', 'Requirement')}`; break;
      case 'task': inner = `<button type="button" class="cb ${b.checked ? 'on' : ''}" data-b="toggle" aria-pressed="${b.checked}" aria-label="Done" ${ro ? 'disabled' : ''}>${b.checked ? ic.check(14) : ''}</button>${ta(b.checked ? 'done' : '', 'To do')}`; break;
      case 'li': inner = `<span class="dot">•</span>${ta('', 'List item')}`; break;
      case 'quote': inner = ta('quote', 'Note'); break;
      case 'hr': inner = '<hr>'; break;
      case 'def':
        inner = `<div class="def"><span class="def-tag">${ic.book(14)} Definition</span><label class="sr" for="term${b.id}">Term</label><input id="term${b.id}" class="def-term" value="${esc(b.term)}" placeholder="Term" ${ro ? 'readonly' : ''} autocomplete="off">${ta('', 'Definition – what the term means. Reference other terms with [[Term]].')}
          ${ro && !b.aliases && !b.see ? '' : `<div class="def-meta"><label><span>Also known as</span><input class="def-aliases" value="${esc(b.aliases ?? '')}" placeholder="synonyms, comma separated" ${ro ? 'readonly' : ''} autocomplete="off"></label>
          <label><span>See also</span><input class="def-see" value="${esc(b.see ?? '')}" placeholder="related terms, comma separated" ${ro ? 'readonly' : ''} autocomplete="off"></label></div>`}
          ${b.src ? '<span class="def-src">Imported from the global glossary – update it on the Glossary page</span>' : ''}</div>`;
        break;
      case 'code':
        inner = `<div class="code-head"><label class="sr" for="lang${b.id}">Language</label><select id="lang${b.id}" class="lang" data-b="lang" ${ro ? 'disabled' : ''}>${[...new Set([...CODE_LANGS, b.lang ?? ''])].map((l) => `<option value="${esc(l)}" ${l === (b.lang ?? '') ? 'selected' : ''}>${l || 'plain text'}</option>`).join('')}</select></div>${ta('mono', 'Code')}`;
        break;
      case 'diagram': {
        const v = b.view ?? 'view';
        inner = `<div class="diagram" data-view="${v}"><div class="dg-bar"><span class="lang-tag">${ic.diagram(14)} Mermaid</span>
          <div class="seg sm" role="group" aria-label="Diagram view">${[['view', 'Diagram'], ['code', 'Code'], ['split', 'Split']].map(([k, l]) => `<button type="button" data-b="dview" data-v="${k}" aria-pressed="${v === k}">${l}</button>`).join('')}</div>
          ${ro ? '' : '<button type="button" class="mini" data-b="template">Template</button>'}</div>
          <div class="dg-src">${ta('mono', 'flowchart TD …', b.text, 'text', 'Mermaid code')}</div><div class="mm" data-mm="${esc(b.id)}" role="img" aria-label="Diagram preview"></div></div>`;
        break;
      }
      case 'endpoint':
        inner = `<div class="endpoint"><div class="ep-head"><label class="sr" for="m${b.id}">HTTP method</label>
          <select id="m${b.id}" class="ep-method m-${esc(b.method)}" data-b="method" ${ro ? 'disabled' : ''}>${METHODS.map((m) => `<option ${m === b.method ? 'selected' : ''}>${m}</option>`).join('')}</select>
          <label class="sr" for="p${b.id}">Path</label><input id="p${b.id}" class="ep-path" value="${esc(b.path)}" placeholder="/resources/{id}" ${ro ? 'readonly' : ''} autocomplete="off" spellcheck="false"></div>
          <span class="ep-l">Description</span>${ta('ep-text', 'What does this endpoint do? Preconditions, side effects, idempotency …', b.text, 'text', 'Endpoint description')}
          ${ro && !b.req ? '' : `<span class="ep-l">Request</span>${ta('mono', 'Parameters, headers, body …', b.req, 'req', 'Endpoint request')}`}
          ${ro && !b.res ? '' : `<span class="ep-l">Responses</span>${ta('mono', '200 OK – … · 404 – …', b.res, 'res', 'Endpoint responses')}`}</div>`;
        break;
      default: inner = ta('', i === 0 && !blocks[1] ? "Write something, or press '/' for blocks" : '');
    }
    return `<div class="blk blk-${b.type}" data-i="${i}" data-id="${b.id}">
      ${ro ? '' : `<button type="button" class="grip" data-b="menu" aria-label="Block options – drag to move">${ic.grip()}</button>`}
      <div class="blk-body">${inner}</div></div>`;
  }

  function render() {
    root.innerHTML = blocks.map(blockHtml).join('') +
      (ctx.readonly ? '' : `<button type="button" class="add-block" data-b="add-end">${ic.plus(16)} Add block</button>`);
    $$('.blk-in', root).forEach(autosize);
    $$('.mm', root).forEach((el) => renderDiagram(el, blocks.find((b) => b.id === el.dataset.mm)?.text ?? ''));
    if (focus >= 0) {
      const blk = $(`.blk[data-i="${focus}"]`, root);
      const el = blk && (blk.classList.contains('blk-endpoint') ? $('.ep-path', blk) : blk.classList.contains('blk-def') && focusAt !== 'end' ? $('.def-term', blk) : $('.blk-in', blk)) || $('.def-term', blk ?? root);
      if (el) { el.focus(); const at = focusAt === 'start' ? 0 : el.value.length; el.setSelectionRange(at, at); track(el); }
      focus = -1;
    }
  }
  function autosize(el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; }
  function put(i, b, at = 'end') { blocks.splice(i, 0, { id: nid(), ...b }); focus = i; focusAt = at; render(); emitChange(); }
  function replace(i, b, at = 'end') { blocks[i] = { ...blocks[i], ...b, id: blocks[i].id }; focus = i; focusAt = at; render(); emitChange(); }
  function remove(i) { blocks.splice(i, 1); if (!blocks.length) blocks.push({ id: nid(), type: 'p', text: '' }); focus = Math.max(0, i - 1); focusAt = 'end'; render(); emitChange(); }
  function move(from, to) { const [b] = blocks.splice(from, 1); blocks.splice(to, 0, b); focus = to; focusAt = 'end'; render(); emitChange(); }
  function convert(i, key) {
    const t = BLOCK_TYPES.find((x) => x.key === key).make(blocks);
    const text = blocks[i].text;
    const keepText = !['hr', 'diagram'].includes(t.type) && !['hr', 'diagram'].includes(blocks[i].type);
    blocks[i] = { id: blocks[i].id, ...t, text: keepText ? text : t.text };
    focus = i; focusAt = key === 'def' ? 'start' : 'end'; render(); emitChange();
  }
  const nextAfter = (b) => (b.type === 'req' ? { type: 'req', label: `R${nextReq(blocks)}`, text: '' } : b.type === 'task' ? { type: 'task', checked: false, text: '' } : b.type === 'li' ? { type: 'li', text: '' } : { type: 'p', text: '' });

  // ---- events
  root.addEventListener('input', (e) => {
    const el = e.target;
    if (el.classList.contains('def-term')) { blocks[idx(el)].term = el.value; track(el); return emitChange(); }
    if (el.classList.contains('ep-path')) { blocks[idx(el)].path = el.value; return emitChange(); }
    if (el.classList.contains('def-aliases')) { blocks[idx(el)].aliases = el.value; return emitChange(); }
    if (el.classList.contains('def-see')) { blocks[idx(el)].see = el.value; return emitChange(); }
    if (!el.classList.contains('blk-in')) return;
    const i = idx(el);
    blocks[i][el.dataset.f ?? 'text'] = el.value;
    autosize(el);
    track(el);
    if (blocks[i].type === 'diagram') {
      clearTimeout(timers.get(i));
      timers.set(i, setTimeout(() => renderDiagram($(`.blk[data-i="${i}"] .mm`, root), blocks[i].text), 350));
    }
    emitChange();
  });
  for (const ev of ['focusin', 'keyup', 'pointerup', 'select']) root.addEventListener(ev, (e) => track(e.target));

  root.addEventListener('keydown', async (e) => {
    const el = e.target;
    if (el.classList.contains('ep-path') && !ctx.readonly) { if (e.key === 'Enter') { e.preventDefault(); $('.ep-text', el.closest('.blk'))?.focus(); } return; }
    const isTerm = el.classList.contains('def-term');
    if ((!el.classList.contains('blk-in') && !isTerm) || ctx.readonly) return;
    const i = idx(el);
    const b = blocks[i];
    if (isTerm) { // definition term input
      if (e.key === 'Enter' || (e.key === 'ArrowDown' && !e.shiftKey)) { e.preventDefault(); $('.blk-in', el.closest('.blk'))?.focus(); }
      else if (e.key === 'ArrowUp') { const t = $(`.blk[data-i="${i - 1}"] .blk-in`, root); if (t) { e.preventDefault(); t.focus(); } }
      else if (e.key === 'Backspace' && !el.value && !b.text) { e.preventDefault(); replace(i, { type: 'p' }, 'start'); }
      return;
    }
    if (b.type === 'endpoint') { // multi-line fields: Enter is a newline, Ctrl/Cmd+Enter continues below
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); put(i + 1, { type: 'p', text: '' }, 'start'); }
      return;
    }
    const multiline = b.type === 'code' || b.type === 'diagram';
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      if (multiline && !(e.ctrlKey || e.metaKey)) return; // plain newline in code
      e.preventDefault();
      if (LISTY.has(b.type) && !b.text.trim()) return replace(i, { type: 'p', text: '' }); // empty list item exits the list
      const at = el.selectionStart;
      const tail = multiline || b.type === 'def' ? '' : b.text.slice(at);
      if (tail) b.text = b.text.slice(0, at);
      return put(i + 1, { ...nextAfter(b), text: tail }, 'start');
    }
    if (e.key === 'Backspace' && el.selectionStart === 0 && el.selectionEnd === 0) {
      if (b.type === 'def') { e.preventDefault(); $('.def-term', el.closest('.blk'))?.focus(); return; }
      if (b.type !== 'p' && !multiline) { e.preventDefault(); return replace(i, { type: 'p' }, 'start'); }
      if (!b.text && blocks.length > 1) { e.preventDefault(); return remove(i); }
      if (b.type === 'p' && i > 0 && !['hr', 'code', 'diagram', 'def'].includes(blocks[i - 1].type)) {
        e.preventDefault(); // merge into previous block
        const prev = blocks[i - 1];
        const at = prev.text.length;
        prev.text += b.text; blocks.splice(i, 1); focus = i - 1; focusAt = 'end'; render(); emitChange();
        $(`.blk[data-i="${i - 1}"] .blk-in`, root)?.setSelectionRange(at, at);
        return;
      }
    }
    if (e.key === '/' && !b.text && b.type === 'p') {
      e.preventDefault();
      const key = await ctx.menu('Turn into', BLOCK_TYPES.map((t) => ({ key: t.key, label: t.label })));
      if (key) convert(i, key); else el.focus();
      return;
    }
    if ((e.altKey || e.metaKey) && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const j = e.key === 'ArrowUp' ? i - 1 : i + 1;
      if (j < 0 || j >= blocks.length) return;
      e.preventDefault(); move(i, j); return;
    }
    if (!multiline && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey) {
      const atStart = el.value.lastIndexOf('\n', el.selectionStart - 1) === -1 && e.key === 'ArrowUp';
      const atEnd = el.value.indexOf('\n', el.selectionEnd) === -1 && e.key === 'ArrowDown';
      const j = atStart ? i - 1 : atEnd ? i + 1 : -1;
      const target = j >= 0 ? ($(`.blk[data-i="${j}"] .def-term`, root) ?? $(`.blk[data-i="${j}"] .blk-in`, root)) : null;
      if (target) { e.preventDefault(); target.focus(); }
    }
  });

  root.addEventListener('paste', (e) => {
    const el = e.target;
    if (!el.classList.contains('blk-in') || ctx.readonly) return;
    const text = e.clipboardData?.getData('text/plain') ?? '';
    const i = idx(el);
    if (!text.includes('\n') || ['code', 'diagram', 'def', 'endpoint'].includes(blocks[i].type)) return;
    e.preventDefault(); // multi-line paste → split into blocks (so pasted Markdown becomes real blocks)
    const parsed = parse(text);
    const empty = !blocks[i].text.trim();
    blocks.splice(empty ? i : i + 1, empty ? 1 : 0, ...parsed);
    focus = (empty ? i : i + 1) + parsed.length - 1; focusAt = 'end';
    render(); emitChange();
  });

  root.addEventListener('change', (e) => {
    if (e.target.dataset.b === 'lang') { blocks[idx(e.target)].lang = e.target.value; emitChange(); }
    if (e.target.dataset.b === 'method') { blocks[idx(e.target)].method = e.target.value; e.target.className = `ep-method m-${e.target.value}`; emitChange(); }
  });

  root.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-b]');
    if (!act) return;
    if (act.dataset.b === 'dview') { // code / diagram / split toggle – also available to read-only viewers
      const blk = act.closest('.blk');
      const bi = idx(act);
      blocks[bi].view = act.dataset.v;
      $('.diagram', blk).dataset.view = act.dataset.v;
      $$('[data-b="dview"]', blk).forEach((x) => x.setAttribute('aria-pressed', String(x === act)));
      $$('.blk-in', blk).forEach(autosize);
      if (act.dataset.v !== 'code') renderDiagram($('.mm', blk), blocks[bi].text);
      return;
    }
    if (ctx.readonly) return;
    if (suppressClick) { suppressClick = false; return; }
    const i = idx(act);
    switch (act.dataset.b) {
      case 'toggle': blocks[i].checked = !blocks[i].checked; render(); return emitChange();
      case 'add-end': {
        const key = await ctx.menu('Add block', BLOCK_TYPES.map((t) => ({ key: t.key, label: t.label })));
        if (key) api.insert(key, blocks.length - 1);
        return;
      }
      case 'template': {
        const k = await ctx.menu('Diagram template', Object.keys(DIAGRAM_TEMPLATES).map((t) => ({ key: t, label: t })));
        if (k) { blocks[i].text = DIAGRAM_TEMPLATES[k]; render(); emitChange(); }
        return;
      }
      case 'menu': {
        const key = await ctx.menu(`Block ${i + 1}`, [
          ...BLOCK_TYPES.map((t) => ({ key: `to:${t.key}`, label: `Turn into ${t.label}`, current: t.key === typeKey(blocks[i]) })),
          { key: 'up', label: 'Move up', disabled: i === 0 },
          { key: 'down', label: 'Move down', disabled: i === blocks.length - 1 },
          { key: 'dup', label: 'Duplicate' },
          { key: 'del', label: 'Delete', danger: true },
        ]);
        if (!key) return;
        if (key.startsWith('to:')) return convert(i, key.slice(3));
        if (key === 'up' || key === 'down') return move(i, key === 'up' ? i - 1 : i + 1);
        if (key === 'dup') return put(i + 1, { ...blocks[i], ...(blocks[i].type === 'def' ? { src: '' } : {}) });
        if (key === 'del') return remove(i);
      }
    }
  });

  // ---- drag & drop (pointer based: mouse, pen and touch) – grab the ⋮⋮ handle
  root.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('.grip');
    if (!grip || ctx.readonly || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const from = idx(grip);
    const el = grip.closest('.blk');
    const scroller = root.closest('.ed-scroll') ?? root.parentElement;
    const startY = e.clientY;
    let dragging = false;
    let to = from;
    let line;
    let raf;
    let lastY = startY;
    try { grip.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }

    const update = () => {
      const others = $$('.blk', root).filter((b) => b !== el);
      let t = 0;
      for (const b of others) { const r = b.getBoundingClientRect(); if (lastY > r.top + r.height / 2) t++; else break; }
      to = t;
      const rootTop = root.getBoundingClientRect().top;
      const ref = others[t] ? others[t].getBoundingClientRect().top : (others.at(-1)?.getBoundingClientRect().bottom ?? rootTop);
      line.style.top = `${ref - rootTop - 1}px`;
      el.style.transform = `translateY(${lastY - startY + (scroller.scrollTop - startScroll)}px)`;
    };
    const startScroll = scroller.scrollTop;
    const autoscroll = () => {
      const r = scroller.getBoundingClientRect();
      const edge = 56;
      if (lastY < r.top + edge) scroller.scrollTop -= 12; else if (lastY > r.bottom - edge) scroller.scrollTop += 12;
      update();
      raf = requestAnimationFrame(autoscroll);
    };
    const onMove = (ev) => {
      lastY = ev.clientY;
      if (!dragging && Math.abs(lastY - startY) < 6) return;
      if (!dragging) {
        dragging = true;
        el.classList.add('dragging');
        root.classList.add('is-dragging');
        line = document.createElement('div');
        line.className = 'drop-line';
        root.appendChild(line);
        raf = requestAnimationFrame(autoscroll);
      }
      ev.preventDefault();
    };
    const finish = (ev) => {
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', finish);
      grip.removeEventListener('pointercancel', finish);
      cancelAnimationFrame(raf);
      if (!dragging) return;
      suppressClick = true; // the pointerup would otherwise open the block menu
      setTimeout(() => (suppressClick = false), 0);
      line.remove();
      root.classList.remove('is-dragging');
      if (ev.type === 'pointercancel' || to === from) { el.classList.remove('dragging'); el.style.transform = ''; return; }
      move(from, to);
    };
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', finish);
    grip.addEventListener('pointercancel', finish);
  });

  const api = {
    caret,
    /** Insert a block at the cursor: splits the current text block at the caret; replaces an empty text block. */
    insert(key, at) {
      const t = BLOCK_TYPES.find((x) => x.key === key).make(blocks);
      if (at !== undefined) return put(at + 1, t);
      const i = caret.i >= 0 && caret.i < blocks.length ? caret.i : blocks.length - 1;
      const cur = blocks[i];
      if (!cur) return put(0, t);
      if (cur.type === 'p' && !cur.text.trim()) return replace(i, t);
      if (cur.type === 'def' && caret.inTerm) return put(i + 1, t);
      if (TEXTLIKE.has(cur.type) && cur.text.trim()) {
        const pos = Math.min(caret.pos, cur.text.length);
        if (pos <= 0) return put(i, t);
        if (pos < cur.text.length) { // caret inside the text → head | new block | tail
          const tail = cur.text.slice(pos).trimStart();
          cur.text = cur.text.slice(0, pos).trimEnd();
          const n = { id: nid(), ...t };
          blocks.splice(i + 1, 0, n, { id: nid(), ...(cur.type === 'req' ? { type: 'p' } : nextAfter(cur)), text: tail }); // a split requirement keeps its number; the rest becomes plain text
          focus = i + 1; focusAt = key === 'def' ? 'start' : 'end'; render(); emitChange();
          return;
        }
      }
      put(i + 1, t, key === 'def' ? 'start' : 'end');
    },
    insertText(text) {
      const blk = $(`.blk[data-i="${caret.i}"]`, root);
      const el = (caret.inTerm ? $('.def-term', blk) : $('.blk-in', blk)) ?? $$('.blk-in', root).at(-1);
      if (!el) { put(blocks.length, { type: 'p', text }); return; }
      el.focus();
      const pos = Math.min(caret.pos ?? el.value.length, el.value.length);
      el.setSelectionRange(pos, pos);
      const prev = el.value[pos - 1];
      el.setRangeText((prev && !/\s/.test(prev) ? ' ' : '') + text, pos, pos, 'end');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    /** External update (sync pulled a newer body). Ignored when it equals what we just emitted. */
    setMarkdown(next) {
      if (next === lastMd) return;
      blocks = parse(next); lastMd = next; render();
    },
  };
  if (!blocks.length) blocks.push({ id: nid(), type: 'p', text: '' });
  render();
  return api;
}
