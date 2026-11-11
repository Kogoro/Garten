import { Icon } from './ui';

/** Floating add button – phones only: the thumb reaches it, and it sits above the bottom navigation. Desktops use the labelled button in the header. */
export function Fab({ label, onClick, act }: { label: string; onClick: () => void; act?: string }) {
  return <button type="button" className="fab only-mobile" data-act={act} aria-label={label} onClick={onClick}><Icon name="plus" size={20} />{label}</button>;
}
