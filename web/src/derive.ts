// Turning a selection (or a whole document) into a spec or a glossary term – the manual counterpart of the agent tool `derive_from_document`.
import { parseDefinitions } from '@shared/glossary.js';

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const stripMd = (s: string) => oneLine(s.replace(/^#{1,6}\s+/, '').replace(/^[-*>]\s+(\[[ x]\]\s+)?/, '').replace(/[*_`]/g, ''));
const baseTitle = (id: string) => id.slice(id.lastIndexOf('/') + 1).replace(/\.(md|yaml|yml|json|txt)$/i, '');

/** First heading, else first line of text, else the file name – the proposed title of what is derived. */
export function titleOf(text: string, sourceId: string, max = 80): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const heading = lines.find((l) => /^#{1,6}\s/.test(l));
  const t = stripMd(heading ?? lines.find((l) => !/^```/.test(l)) ?? '') || baseTitle(sourceId);
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Body of a new spec: the text, plus a pointer to where it came from (same section the agent tool writes). */
export const specBody = (text: string, sourceId: string) => `${text.trim()}\n\n## SOURCE\n\nDerived from \`${sourceId}\`.\n`;

/** Prefill for the glossary dialog. A short selection is the term, a longer one its definition; a whole document is named by its title and described by its first paragraph. */
export function termPrefill(text: string, sourceId: string, whole: boolean): { term: string; definition: string } {
  if (whole) {
    const para = text.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !/^(#{1,6}\s|```|---|\||[-*]\s|R\d+\s)/.test(p) && !/^[^\n]+\n: /.test(p));
    return { term: titleOf(text, sourceId, 60), definition: para ? oneLine(para).slice(0, 400) : '' };
  }
  const one = oneLine(text);
  return one.length <= 60 && !/[.!?:]\s/.test(one) ? { term: one.replace(/[[\]|]/g, ''), definition: '' } : { term: '', definition: one.slice(0, 600) };
}

/** Definitions already written in a document that the glossary does not have yet. */
export const newDefinitions = (body: string, known: (term: string) => boolean) =>
  (parseDefinitions(body) as { term: string; definition: string; aliases: string[]; see: string[] }[]).filter((d) => d.definition && !known(d.term));
