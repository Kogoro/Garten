// Spec model blocks (shared/blocksModel.js – the Markdown format) <-> BlockNote documents.
import { parse, serialize } from '@shared/blocksModel.js';
import { inlineToMd, mdToInline } from './inline';

export interface ModelBlock { id?: string; type: string; text?: string; level?: number; checked?: boolean; label?: string; lang?: string; info?: string; view?: string; term?: string; aliases?: string; see?: string; src?: string; method?: string; path?: string; rows?: string[][]; req?: string; res?: string }
export interface BnBlock { id?: string; type: string; props?: Record<string, any>; content?: any; children?: BnBlock[] }

export function modelToBn(blocks: ModelBlock[]): BnBlock[] {
  return blocks.map((b): BnBlock => {
    const inl = (t?: string) => mdToInline(t ?? '');
    switch (b.type) {
      case 'h': return { type: 'heading', props: { level: b.level || 2 }, content: inl(b.text) };
      case 'li': return { type: 'bulletListItem', content: inl(b.text) };
      case 'task': return { type: 'checkListItem', props: { checked: !!b.checked }, content: inl(b.text) };
      case 'quote': return { type: 'quote', content: inl(b.text) };
      case 'hr': return { type: 'divider' };
      case 'img': return { type: 'image', props: { url: b.src ?? '', caption: b.text ?? '', name: b.text ?? '' } };
      case 'table': return { type: 'table', content: { type: 'tableContent', headerRows: 1, rows: (b.rows ?? []).map((r) => ({ cells: r.map((c) => inl(c)) })) } };
      case 'req': return { type: 'requirement', props: { label: b.label ?? 'R1' }, content: inl(b.text) };
      case 'code': return { type: 'codeBlock', props: { language: b.lang || 'text' }, content: [{ type: 'text', text: b.text ?? '', styles: {} }] };
      case 'diagram': return { type: 'diagram', props: { text: b.text ?? '', view: b.view === 'code' || b.view === 'split' || b.view === 'edit' ? b.view : 'view' } };
      case 'endpoint': return { type: 'endpoint', props: { method: b.method ?? 'GET', path: b.path ?? '', text: b.text ?? '', req: b.req ?? '', res: b.res ?? '' } };
      case 'def': return { type: 'definition', props: { term: b.term ?? '', text: b.text ?? '', aliases: b.aliases ?? '', see: b.see ?? '', src: b.src ?? '' } };
      default: return { type: 'paragraph', content: inl(b.text) };
    }
  });
}

export function bnToModel(blocks: BnBlock[]): ModelBlock[] {
  const out: ModelBlock[] = [];
  const walk = (list: BnBlock[]) => {
    for (const b of list) {
      const p = b.props ?? {};
      const text = () => inlineToMd(b.content);
      switch (b.type) {
        case 'heading': out.push({ type: 'h', level: Math.min(Number(p.level) || 2, 3), text: text() }); break;
        case 'bulletListItem': case 'numberedListItem': out.push({ type: 'li', text: text() }); break;
        case 'checkListItem': out.push({ type: 'task', checked: !!p.checked, text: text() }); break;
        case 'quote': out.push({ type: 'quote', text: text() }); break;
        case 'image': if (p.url) out.push({ type: 'img', src: p.url, text: p.caption || p.name || '' }); break;
        case 'table': {
          const rows = (b.content?.rows ?? []).map((r: any) => (r.cells ?? []).map((c: any) => inlineToMd(Array.isArray(c) ? c : c?.content)));
          if (rows.length) out.push({ type: 'table', rows });
          break;
        }
        case 'divider': out.push({ type: 'hr', text: '' }); break;
        case 'requirement': out.push({ type: 'req', label: p.label || 'R1', text: text() }); break;
        case 'codeBlock': out.push({ type: 'code', lang: p.language === 'text' ? '' : p.language, info: '', text: (b.content ?? []).map((c: any) => c.text ?? '').join('') }); break;
        case 'diagram': out.push({ type: 'diagram', text: p.text ?? '', view: p.view }); break;
        case 'endpoint': out.push({ type: 'endpoint', method: p.method, path: p.path ?? '', text: p.text ?? '', req: p.req ?? '', res: p.res ?? '' }); break;
        case 'definition': out.push({ type: 'def', term: p.term ?? '', text: p.text ?? '', aliases: p.aliases ?? '', see: p.see ?? '', src: p.src ?? '' }); break;
        default: out.push({ type: 'p', text: text() });
      }
      if (b.children?.length) walk(b.children);
    }
  };
  walk(blocks);
  return renumber(out);
}

/** Requirements are numbered R1, R2 … in document order. */
export function renumber(blocks: ModelBlock[]): ModelBlock[] {
  let n = 0;
  return blocks.map((b) => (b.type === 'req' ? { ...b, label: `R${++n}` } : b));
}

export const mdToBn = (md: string) => modelToBn(parse(md));
export const bnToMd = (blocks: BnBlock[]) => serialize(bnToModel(blocks));
