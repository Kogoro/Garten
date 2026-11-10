import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './ui';
import { useUi } from './state';

/** Modal bottom sheet / dialog (the scrim closes it, so does Escape). */
export function Sheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', k);
    const i = ref.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input:not([type=hidden]):not([type=radio]):not([type=checkbox]), textarea');
    i?.focus();
    try { if (i?.value) i.setSelectionRange?.(i.value.length, i.value.length); } catch { /* inputs without a caret (email …) */ }
    return () => document.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" ref={ref}>{children}</div>
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
