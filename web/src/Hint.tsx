import { useState, type ReactNode } from 'react';

const seen = (id: string) => { try { return localStorage.getItem(`specs-hint-${id}`) === '1'; } catch { return false; } };

/** A one-time tip next to the task it is about. Dismissed for good on this device; never blocks anything. */
export function Hint({ id, children, fineOnly }: { id: string; children: ReactNode; fineOnly?: boolean }) {
  const [gone, setGone] = useState(() => seen(id));
  if (gone) return null;
  if (fineOnly && typeof matchMedia === 'function' && !matchMedia('(pointer: fine)').matches) return null; // keyboard tips are noise on a phone
  return (
    <aside className="hint-card" role="note" data-hint={id}>
      <p>{children}</p>
      <button type="button" className="btn small" data-act="hint-dismiss" onClick={() => { try { localStorage.setItem(`specs-hint-${id}`, '1'); } catch { /* private mode */ } setGone(true); }}>Got it</button>
    </aside>
  );
}
