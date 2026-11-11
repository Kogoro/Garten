import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';
import { createExtension } from '@blocknote/core';
import { filterSuggestionItems } from '@blocknote/core/extensions';
import { BlockNoteView } from '@blocknote/mantine';
import { SuggestionMenuController, getDefaultReactSlashMenuItems, useCreateBlockNote } from '@blocknote/react';
import { useEffect, useMemo, useRef } from 'react';
import { effectiveTheme } from '../ui';
import { bnToMd, mdToBn, type BnBlock } from './convert';
import { schema } from './schema';

/** Enter in a requirement starts the next requirement; Enter in an empty one leaves the list. */
const requirementEnter = createExtension({
  key: 'requirementEnter',
  keyboardShortcuts: {
    Enter: ({ editor }) => {
      const cur: any = editor.getTextCursorPosition().block;
      if (cur.type !== 'requirement') return false;
      if (!cur.content?.length) { editor.updateBlock(cur, { type: 'paragraph' } as any); return true; }
      const r: any = editor.insertBlocks([{ type: 'requirement' } as any], cur, 'after');
      const nb = r.insertedBlocks?.[0] ?? r[0];
      if (nb) editor.setTextCursorPosition(nb, 'start');
      return true;
    },
  },
});

const CUSTOM = [
  { title: 'Requirement (R1, R2 …)', key: 'requirement', aliases: ['req', 'requirement'], group: 'Specs', subtext: 'A numbered, testable requirement', props: {} },
  { title: 'Diagram (Mermaid)', key: 'diagram', aliases: ['mermaid', 'diagram', 'flowchart'], group: 'Specs', subtext: 'Flowchart, sequence, ER …', props: {} },
  { title: 'API endpoint', key: 'endpoint', aliases: ['api', 'endpoint', 'http'], group: 'Specs', subtext: 'Method, path, description, request, responses', props: {} },
  { title: 'Definition (glossary)', key: 'definition', aliases: ['def', 'term', 'glossary'], group: 'Specs', subtext: 'A term with aliases and references', props: {} },
] as const;

/** Block editor for a Markdown body. The Markdown string stays the single source of truth: `value` in, `onChange(md)` out. */
export type EditorApi = { insert: (key: string) => void; insertText: (t: string) => void };
import { termRef } from '@shared/glossary.js';

export function SpecEditor({ docKey, value, readOnly, onChange, onReady, refs, onRef, terms }: { docKey: string; value: string; readOnly: boolean; onChange: (md: string) => void; onReady?: (api: EditorApi | null) => void; refs?: string[]; onRef?: (docId: string) => void; terms?: string[] }) {
  const initial = useMemo(() => { const b = mdToBn(value); return b.length ? b : undefined; }, [docKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const editor = useCreateBlockNote({ schema, initialContent: initial as any, extensions: [requirementEnter], domAttributes: { editor: { 'aria-label': 'Content', 'aria-multiline': 'true' } } as any }, [docKey]);
  const last = useRef(value);

  /** Splits the current text block at the caret (head stays, tail becomes a paragraph) – returns the block to insert after. */
  const splitAtCaret = (cur: any): any => {
    const view: any = (editor as any).prosemirrorView;
    const off: number | undefined = view?.state?.selection?.$from?.parentOffset;
    const content: any[] = Array.isArray(cur.content) ? cur.content : [];
    const len = content.reduce((n, c) => n + (c.type === 'link' ? c.content.reduce((m: number, x: any) => m + x.text.length, 0) : c.text.length), 0);
    if (off === undefined || off <= 0 || off >= len) return cur;
    const head: any[] = [], tail: any[] = [];
    let pos = 0;
    const cut = (c: any, into: (x: any) => void, from: number, to: number) => { if (to > from) into({ ...c, text: c.text.slice(from, to) }); };
    for (const c of content) {
      if (c.type === 'link') { (pos + c.content.reduce((m: number, x: any) => m + x.text.length, 0) <= off ? head : tail).push(c); pos += c.content.reduce((m: number, x: any) => m + x.text.length, 0); continue; }
      const a = pos, b = pos + c.text.length; pos = b;
      cut(c, (x) => head.push(x), 0, Math.max(0, Math.min(off - a, c.text.length)));
      cut(c, (x) => tail.push(x), Math.max(0, off - a), c.text.length);
    }
    editor.updateBlock(cur, { content: head } as any);
    const res: any = editor.insertBlocks([{ type: 'paragraph', content: tail } as any], cur, 'after');
    return res.insertedBlocks?.[0] ?? res[0] ?? cur;
  };
  const insert = (key: string) => {
    const cur: any = editor.getTextCursorPosition().block;
    const map: Record<string, any> = { p: { type: 'paragraph' }, h2: { type: 'heading', props: { level: 2 } }, h1: { type: 'heading', props: { level: 1 } }, h3: { type: 'heading', props: { level: 3 } }, task: { type: 'checkListItem' }, li: { type: 'bulletListItem' }, quote: { type: 'quote' }, code: { type: 'codeBlock' }, hr: { type: 'divider' } };
    const nb = map[key] ?? { type: key };
    const empty = !(cur.content as any[])?.length && ['paragraph', 'bulletListItem', 'checkListItem', 'requirement', 'quote'].includes(cur.type);
    editor.focus();
    let target: any = cur;
    if (empty) editor.updateBlock(cur, nb);
    else { const anchor = splitAtCaret(cur); const res: any = editor.insertBlocks([nb], cur === anchor ? cur : cur, 'after'); target = res.insertedBlocks?.[0] ?? res[0]; }
    if (target) editor.setTextCursorPosition(target, 'start');
  };
  const insertText = (t: string) => { editor.focus(); editor.insertInlineContent([{ type: 'text', text: t, styles: {} }]); };
  useEffect(() => { onReady?.({ insert, insertText }); return () => onReady?.(null); }, [editor]); // eslint-disable-line react-hooks/exhaustive-deps

  // external change (sync, conflict resolution, Markdown view) -> replace the document
  useEffect(() => {
    if (value === last.current) return;
    last.current = value;
    editor.replaceBlocks(editor.document, (mdToBn(value).length ? mdToBn(value) : [{ type: 'paragraph' }]) as any);
  }, [value, editor]);

  const slash = async (query: string) => {
    const base = getDefaultReactSlashMenuItems(editor).filter((i) => !['Numbered List', 'Toggle List', 'Image', 'Video', 'Audio', 'File', 'Emoji', 'Heading 4', 'Heading 5', 'Heading 6', 'Table', 'Page Break', 'Toggle Heading 1', 'Toggle Heading 2', 'Toggle Heading 3', 'Numbered list', 'Bullet list'].includes(i.title) || i.title === 'Bullet List');
    const mine = CUSTOM.map((c) => ({
      title: c.title, aliases: [...c.aliases], group: c.group, subtext: c.subtext,
      onItemClick: () => {
        insert(c.key);
      },
    }));
    return filterSuggestionItems([...mine, ...base] as any, query);
  };

  return (
    <div className="bn-host" data-testid="block-editor">
      <BlockNoteView
        editor={editor}
        editable={!readOnly}
        theme={effectiveTheme()}
        slashMenu={false}
        onChange={() => {
          const md = bnToMd(editor.document as unknown as BnBlock[]);
          if (md === last.current) return;
          last.current = md;
          onChange(md);
        }}
      >
        <SuggestionMenuController {...({ triggerCharacter: '/', getItems: slash } as any)} />
        {terms && terms.length > 0 && <SuggestionMenuController {...({ triggerCharacter: '#', getItems: async (q: string) => terms.filter((t) => t.toLowerCase().includes(q.toLowerCase())).slice(0, 12).map((t) => ({ title: t, onItemClick: () => editor.insertInlineContent([{ type: 'text', text: `${termRef(t)} `, styles: {} }]) })) } as any)} />}
        {refs && <SuggestionMenuController {...({ triggerCharacter: '@', getItems: async (q: string) => refs.filter((r) => r.toLowerCase().includes(q.toLowerCase())).slice(0, 12).map((r) => ({ title: r, onItemClick: () => { onRef?.(r); editor.insertInlineContent([{ type: 'text', text: `@${r} `, styles: {} }]); } })) } as any)} />}
      </BlockNoteView>
    </div>
  );
}
