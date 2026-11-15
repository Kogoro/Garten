import { effectiveTheme } from '../ui';

const THEMES = {
  dark: { background: '#141614', primaryColor: '#1D211F', primaryTextColor: '#F2F5F3', primaryBorderColor: '#3B423E', lineColor: '#9CA8A2', secondaryColor: '#1D211F', tertiaryColor: '#141614', fontFamily: 'Inter, system-ui, sans-serif' },
  light: { background: '#FFFFFF', primaryColor: '#F1F4F2', primaryTextColor: '#111815', primaryBorderColor: '#C3CAC6', lineColor: '#59635E', secondaryColor: '#F1F4F2', tertiaryColor: '#FFFFFF', fontFamily: 'Inter, system-ui, sans-serif' },
};
let mm: Promise<typeof import('mermaid').default> | undefined;
let n = 0;
let queue: Promise<unknown> = Promise.resolve();

/** Mermaid is bundled as lazy chunks. They are not part of the install (they are most of the app's weight); the page
 *  downloads them in the background after start (warmup.ts) and the service worker keeps them, so diagrams work offline.
 *  A failed load (offline before that download finished) is not remembered: the next diagram tries again. */
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
      if (CHUNK_FAILED.test(msg)) return { error: navigator.onLine ? 'Could not load the diagram renderer – try again.' : 'Offline: the diagram renderer was not downloaded yet – it loads by itself the next time this device is online.' };
      return { error: msg.split('\n')[0] };
    }
  };
  const p = queue.then(job, job); // Mermaid is not re-entrant
  queue = p;
  return p;
}
