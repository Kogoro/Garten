import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';
import { filterSuggestionItems } from '@blocknote/core/extensions';
import { BlockNoteView } from '@blocknote/mantine';
import { SuggestionMenuController, getDefaultReactSlashMenuItems, useCreateBlockNote } from '@blocknote/react';
import { useEffect, useMemo, useRef } from 'react';
import { effectiveTheme } from '../ui';
import { bnToMd, mdToBn, type BnBlock } from './convert';
import { schema } from './schema';

const CUSTOM = [
  { title: 'Requirement (R1, R2 …)', key: 'requirement', aliases: ['req', 'requirement'], group: 'Specs', subtext: 'A numbered, testable requirement', props: {} },
  { title: 'Diagram (Mermaid)', key: 'diagram', aliases: ['mermaid', 'diagram', 'flowchart'], group: 'Specs', subtext: 'Flowchart, sequence, ER …', props: {} },
  { title: 'API endpoint', key: 'endpoint', aliases: ['api', 'endpoint', 'http'], group: 'Specs', subtext: 'Method, path, description, request, responses', props: {} },
  { title: 'Definition (glossary)', key: 'definition', aliases: ['def', 'term', 'glossary'], group: 'Specs', subtext: 'A term with aliases and references', props: {} },
] as const;

/** Block editor for a Markdown body. The Markdown string stays the single source of truth: `value` in, `onChange(md)` out. */
export function SpecEditor({ docKey, value, readOnly, onChange }: { docKey: string; value: string; readOnly: boolean; onChange: (md: string) => void }) {
  const initial = useMemo(() => { const b = mdToBn(value); return b.length ? b : undefined; }, [docKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const editor = useCreateBlockNote({ schema, initialContent: initial as any }, [docKey]);
  const last = useRef(value);

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
        const cur = editor.getTextCursorPosition().block;
        const nb = { type: c.key } as any;
        const empty = cur.type === 'paragraph' && !(cur.content as any[])?.length;
        if (empty) editor.replaceBlocks([cur], [nb]); else editor.insertBlocks([nb], cur, 'after');
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
      </BlockNoteView>
    </div>
  );
}
