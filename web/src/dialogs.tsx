import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './ui';
import { useUi } from './state';

/** Modal bottom sheet / dialog (the scrim, the close button and Escape close it). Focus moves in, stays in and returns to the opener. */
export function Sheet({ onClose, wide, xl, children }: { onClose: () => void; wide?: boolean; xl?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const box = ref.current;
    const heading = box?.querySelector('h1, h2, h3');
    if (heading) { heading.id ||= `sheet-title-${Math.random().toString(36).slice(2, 8)}`; box?.setAttribute('aria-labelledby', heading.id); }
    const focusable = () => [...(box?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([type=hidden]):not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])].filter((e) => e.offsetParent !== null);
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return onClose();
      if (e.key !== 'Tab') return;
      const f = focusable(); if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (!box?.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', k);
    // A touch keyboard popping up would cover the sheet: only text fields get the focus on devices with a precise pointer.
    const fine = typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;
    const i = fine ? box?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input:not([type=hidden]):not([type=radio]):not([type=checkbox]), textarea') : null;
    if (i) {
      i.focus();
      try { if (i.value) i.setSelectionRange?.(i.value.length, i.value.length); } catch { /* inputs without a caret (email …) */ }
    } else box?.focus();
    return () => { document.removeEventListener('keydown', k); if (opener?.isConnected) opener.focus?.(); };
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={xl ? 'sheet xl' : wide ? 'sheet wide' : 'sheet'} role="dialog" aria-modal="true" tabIndex={-1} ref={ref}>
        <button type="button" className="sheet-x" aria-label="Close" onClick={onClose}>×</button>
        {children}
      </div>
    </div>
  );
}

export function MenuHost() {
  const menu = useUi((s) => s.menu);
  const set = useUi((s) => s.set);
  if (!menu) return null;
  const done = (k: string | null) => { set({ menu: null }); menu.resolve(k); };
  return (
    <Sheet onClose={() => done(null)}>
      <h2>{menu.title}</h2>
      <div className="menu">
        {menu.items.map((it) => <button key={it.key} type="button" className={`menu-item ${it.danger ? 'danger' : ''} ${it.current ? 'current' : ''}`} disabled={it.disabled} onClick={() => done(it.key)}>{it.label}{it.current ? ' ✓' : ''}</button>)}
      </div>
    </Sheet>
  );
}

/** Small anchored dropdown (New ▾, linked documents …). Closes on outside click / Escape. */
export function Dropdown({ label, className, buttonProps, children, menuClass, ariaLabel, id }: { id?: string; label: ReactNode; className?: string; buttonProps?: Record<string, unknown>; children: (close: () => void) => ReactNode; menuClass?: string; ariaLabel?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', click); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', click); document.removeEventListener('keydown', key); };
  }, [open]);
  return (
    <div className="dd" id={id} ref={ref}>
      <button type="button" data-act="dd-toggle" className={className} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} {...buttonProps}>{label}</button>
      <div className={`dd-menu ${menuClass ?? ''}`} role="menu" aria-label={ariaLabel} hidden={!open}>{children(() => setOpen(false))}</div>
    </div>
  );
}

export const FormError = ({ msg }: { msg?: string | null }) => (msg ? <span className="err-text">{msg}</span> : null);
export { Icon };
