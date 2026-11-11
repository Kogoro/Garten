import { useRef, type KeyboardEvent } from 'react';

export interface TabDef { id: string; label: string; badge?: number | string }

/** Tabs for pages with several sections (Members & Git, Admin, Account). Arrow keys move between them; the choice is kept by the caller. */
export function Tabs({ tabs, value, onChange, label }: { tabs: TabDef[]; value: string; onChange: (id: string) => void; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const key = (e: KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === value);
    const n = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
    if (n < 0) return;
    e.preventDefault(); onChange(tabs[n].id);
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(`[data-tab="${tabs[n].id}"]`)?.focus());
  };
  return (
    <div className="tabs" role="tablist" aria-label={label} ref={ref} onKeyDown={key}>
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} data-tab={t.id} aria-selected={value === t.id} aria-controls="tabpanel" tabIndex={value === t.id ? 0 : -1} className={`tab${value === t.id ? ' on' : ''}`} onClick={() => onChange(t.id)}>
          {t.label}{t.badge !== undefined && t.badge !== '' && <span className="tab-badge">{t.badge}</span>}
        </button>
      ))}
    </div>
  );
}
