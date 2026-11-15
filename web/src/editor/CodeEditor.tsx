import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { expand, onBackspace, onChar, onEnter, onTab, suggest, toggleComment, type Edit, type Suggestion } from './codeAssist';

/** Replaces text through the browser so Ctrl+Z keeps working; falls back to setRangeText where execCommand is missing. */
function apply(ta: HTMLTextAreaElement, ed: Edit) {
  ta.focus();
  ta.setSelectionRange(ed.from, ed.to);
  let done = false;
  try { done = ed.insert === '' && ed.from === ed.to ? true : document.execCommand('insertText', false, ed.insert); } catch { done = false; }
  if (!done) { ta.setRangeText(ed.insert, ed.from, ed.to, 'end'); ta.dispatchEvent(new Event('input', { bubbles: true })); }
  ta.setSelectionRange(ed.selStart, ed.selEnd);
}

interface Pop { from: number; items: Suggestion[]; index: number }

/** A small code editor on a textarea: line numbers, Tab / Shift+Tab, auto-indent, bracket pairs, Ctrl+/ comments and completion for the diagram type. */
export function CodeEditor({ value, onChange, readOnly, label = 'Mermaid source', rows, fill, className = '' }: { value: string; onChange: (v: string) => void; readOnly?: boolean; label?: string; rows?: number; fill?: boolean; className?: string }) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const [pop, setPop] = useState<Pop | null>(null);
  const [at, setAt] = useState({ top: 0, left: 0 });
  const id = useId();
  const lines = useMemo(() => value.split('\n').length, [value]);
  const nums = useMemo(() => Array.from({ length: Math.max(lines, rows ?? 1) }, (_, i) => i + 1).join('\n'), [lines, rows]);

  const place = (caret: number) => {
    const el = ta.current; if (!el) return;
    const before = el.value.slice(0, caret), line = before.split('\n').length - 1, col = before.length - (before.lastIndexOf('\n') + 1);
    setAt({ top: 12 + (line + 1) * 20 - el.scrollTop, left: 12 + col * ((el.dataset.cw && parseFloat(el.dataset.cw)) || 7.8) - el.scrollLeft });
  };
  useLayoutEffect(() => { // the width of one character, for placing the completion list
    const el = ta.current; if (!el) return;
    const c = document.createElement('canvas').getContext('2d');
    if (c) { c.font = `13px ${getComputedStyle(el).fontFamily}`; const w = c.measureText('0').width; if (w > 0) el.dataset.cw = String(w); }
  }, []);
  useEffect(() => { if (!pop) return; const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest?.('.ce')) setPop(null); }; document.addEventListener('mousedown', close); return () => document.removeEventListener('mousedown', close); }, [pop]);

  const refresh = (explicit = false) => {
    const el = ta.current; if (!el || readOnly || el.selectionStart !== el.selectionEnd) return setPop(null);
    const r = suggest(el.value, el.selectionStart, explicit);
    if (!r) return setPop(null);
    place(el.selectionStart);
    setPop({ from: r.from, items: r.items, index: 0 });
  };
  const accept = (item: Suggestion) => {
    const el = ta.current; if (!el || !pop) return;
    const { text, caret } = expand(item);
    const to = el.selectionStart;
    // keep the indentation of the line for multi-line snippets
    const ls = el.value.lastIndexOf('\n', pop.from - 1) + 1;
    const indent = /^[ \t]*/.exec(el.value.slice(ls, pop.from))![0];
    const body = text.replace(/\n/g, `\n${indent}`);
    const pos = pop.from + text.slice(0, caret).replace(/\n/g, `\n${indent}`).length;
    apply(el, { from: pop.from, to, insert: body, selStart: pos, selEnd: pos });
    setPop(null);
  };

  const keydown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (readOnly || e.nativeEvent.isComposing) return;
    const stop = () => { e.preventDefault(); e.nativeEvent.stopPropagation(); }; // the dialog must not see Tab / Escape
    if (pop) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { stop(); setPop({ ...pop, index: (pop.index + (e.key === 'ArrowDown' ? 1 : pop.items.length - 1)) % pop.items.length }); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { stop(); accept(pop.items[pop.index]); return; }
      if (e.key === 'Escape') { stop(); setPop(null); return; }
    }
    const { selectionStart: s, selectionEnd: en, value: t } = el;
    let ed: Edit | null = null;
    if ((e.ctrlKey || e.metaKey) && e.key === ' ') { stop(); refresh(true); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === '/') { stop(); ed = toggleComment(t, s, en); }
    else if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) { stop(); ed = onTab(t, s, en, e.shiftKey); if (!ed) return; }
    else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey) { stop(); ed = onEnter(t, s, en); }
    else if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey) { ed = onBackspace(t, s, en); if (ed) e.preventDefault(); }
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { ed = onChar(t, s, en, e.key); if (ed) e.preventDefault(); }
    if (ed) { apply(el, ed); setPop(null); if (e.key.length === 1) requestAnimationFrame(() => refresh()); }
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) setPop(null); // a typed character makes the open list stale until the next refresh: Enter/Tab must not accept an outdated suggestion
  };

  return (
    <div className={`ce${fill ? ' fill' : ''} ${className}`}>
      <div className="ce-gutter" ref={gutter} aria-hidden>{nums}</div>
      <textarea
        ref={ta} className="ce-input" aria-label={label} spellCheck={false} autoCapitalize="off" autoCorrect="off" wrap="off" readOnly={readOnly}
        rows={rows} value={value} role="combobox" aria-autocomplete="list" aria-expanded={!!pop} aria-controls={pop ? `${id}-list` : undefined} aria-activedescendant={pop ? `${id}-${pop.index}` : undefined}
        onChange={(e) => { onChange(e.target.value); requestAnimationFrame(() => refresh()); }}
        onKeyDown={keydown}
        onScroll={(e) => { if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop; setPop(null); }}
        onClick={() => setPop(null)} onBlur={() => setTimeout(() => setPop(null), 120)}
      />
      {pop && (
        <ul className="ce-pop" id={`${id}-list`} role="listbox" style={{ top: at.top, left: Math.min(at.left, 9999) }}>
          {pop.items.map((it, i) => (
            <li key={it.label} id={`${id}-${i}`} role="option" aria-selected={i === pop.index} onMouseDown={(e) => { e.preventDefault(); accept(it); }}>
              <span className="ce-l mono">{it.label}</span>{it.detail && <span className="ce-d">{it.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
