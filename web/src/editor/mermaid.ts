import { effectiveTheme } from '../ui';

const THEMES = {
  dark: { background: '#171B1F', primaryColor: '#12261E', primaryTextColor: '#E8ECEF', primaryBorderColor: '#5FD4A0', lineColor: '#9AA4AE', secondaryColor: '#14223A', tertiaryColor: '#171B1F', fontFamily: 'Inter, system-ui, sans-serif' },
  light: { background: '#FFFFFF', primaryColor: '#E3F4EC', primaryTextColor: '#14181C', primaryBorderColor: '#0B7A52', lineColor: '#5A6672', secondaryColor: '#E7EFFC', tertiaryColor: '#FFFFFF', fontFamily: 'Inter, system-ui, sans-serif' },
};
let mm: Promise<typeof import('mermaid').default> | undefined;
let n = 0;
let queue: Promise<unknown> = Promise.resolve();

/** Mermaid is bundled as lazy chunks. The service worker caches them on first use (not at install – they are most of the
 *  app's weight), so diagrams work offline once Mermaid has run on this device. A failed load (offline before that) is not
 *  remembered: the next diagram tries again. */
export function loadMermaid() {
  mm ??= import('mermaid').then((m) => m.default, (e) => { mm = undefined; throw e; });
  return mm;
}
// a chunk that could not be fetched (Chrome / Firefox / Safari wording)
const CHUNK_FAILED = /dynamically imported module|error loading dynamically imported|importing a module script failed/i;
export function renderMermaid(src: string): Promise<{ svg?: string; error?: string }> {
  const job = async () => {
    if (!src.trim()) return { error: 'Empty diagram – write Mermaid code.' };
    try {
      const m = await loadMermaid();
      const t = effectiveTheme();
      m.initialize({ startOnLoad: false, securityLevel: 'strict', theme: t === 'light' ? 'default' : 'dark', suppressErrorRendering: true, themeVariables: THEMES[t] });
      await m.parse(src);
      const { svg } = await m.render(`mm${++n}`, src);
      return { svg };
    } catch (e: any) {
      document.getElementById(`dmm${n}`)?.remove();
      const msg = String(e?.message ?? e);
      if (CHUNK_FAILED.test(msg)) return { error: navigator.onLine ? 'Could not load the diagram renderer – try again.' : 'Offline: this kind of diagram renders once it has been shown online on this device.' };
      return { error: msg.split('\n')[0] };
    }
  };
  const p = queue.then(job, job); // Mermaid is not re-entrant
  queue = p;
  return p;
}
