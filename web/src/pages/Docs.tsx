import { useState, type ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Dropdown } from '../dialogs';
import { Bar, Shell } from '../Shell';
import { CORE_LABEL, enc, foundState, hasContent } from '../lib';
import { PathSheet, type PathSheetKind } from '../sheets';
import { openMenu, useUi } from '../state';
import { Fab } from '../Fab';
import type { Item } from '../store/types';
import { Icon, ago, toast, touched, useStore } from '../ui';
import { ItemEditor, ItemSync, NotFound } from './ItemEditor';

type Store = ReturnType<typeof useStore>;
interface Node { folders: Map<string, Node>; docs: Item[] }

function buildTree(S: Store): Node {
  const root: Node = { folders: new Map(), docs: [] };
  const node = (path: string) => path.split('/').filter(Boolean).reduce((n, seg) => { if (!n.folders.has(seg)) n.folders.set(seg, { folders: new Map(), docs: [] }); return n.folders.get(seg)!; }, root);
  for (const p of S.folderPaths()) node(p);
  for (const d of S.all('doc').filter((x) => !x.pinned)) node(S.folderOf(d.id)).docs.push(d);
  return root;
}
const countDocs = (n: Node): number => n.docs.length + [...n.folders.values()].reduce((a, f) => a + countDocs(f), 0);

function DocsList({ selected }: { selected?: string }) {
  const S = useStore(); const ui = useUi();
  const [sheet, setSheet] = useState<null | { kind: PathSheetKind; value?: string; from?: string }>(null);
  const can = S.can('write');
  const found = S.foundationDocs().filter((d) => d.id !== 'glossary.md');
  const tree = buildTree(S);

  async function folderMenu(path: string) {
    const k = await openMenu(path, [{ key: 'doc', label: 'New document here' }, { key: 'sub', label: 'New subfolder' }, { key: 'rename', label: 'Rename / move…' }, { key: 'delete', label: 'Delete folder', danger: true, disabled: !S.folderEmpty(path) }]);
    if (k === 'doc') setSheet({ kind: 'newdoc', value: `${path}/` });
    if (k === 'sub') setSheet({ kind: 'newfolder', value: `${path}/` });
    if (k === 'rename') setSheet({ kind: 'renamefolder', from: path, value: path });
    if (k === 'delete' && confirm(`Delete the empty folder ${path}?`)) { S.deleteFolder(path); toast('Folder deleted'); }
  }
  const renderNode = (node: Node, prefix: string, depth: number): ReactElement[] => {
    const out: ReactElement[] = [];
    for (const [name, child] of [...node.folders].sort((a, b) => a[0].localeCompare(b[0]))) {
      const path = prefix ? `${prefix}/${name}` : name;
      const open = ui.openFolders[path] !== false;
      out.push(
        <div className="frow" style={{ ['--d' as any]: depth }} key={`f:${path}`}>
          <button type="button" className="ftoggle" aria-expanded={open} onClick={() => ui.set({ openFolders: { ...ui.openFolders, [path]: !open } })}><Icon name="chevron" size={14} /><Icon name="folder" size={16} /><span>{name}</span><small>{countDocs(child)}</small></button>
          {can && <><button type="button" className="fbtn" data-act="new-doc-in" aria-label={`New document in ${path}`} title="New document here" onClick={() => setSheet({ kind: 'newdoc', value: `${path}/` })}><Icon name="plus" size={16} /></button>
            <button type="button" className="fbtn" data-act="folder-menu" aria-label={`Folder actions for ${path}`} onClick={() => folderMenu(path)}><Icon name="more" size={18} /></button></>}
        </div>,
      );
      if (open) out.push(...renderNode(child, path, depth + 1));
    }
    for (const d of [...node.docs].sort((a, b) => a.id.localeCompare(b.id))) {
      const used = S.usedBy(d.id);
      out.push(
        <Link key={d.id} className={`row docrow ${selected === d.id ? 'active' : ''}`} style={{ ['--d' as any]: depth }} to={`/doc/${enc(d.id)}`}>
          <div className="row-top"><span className="row-title mono" style={{ fontSize: 13.5 }}>{S.baseName(d.id)}</span><ItemSync i={d} S={S} quiet /></div>
          <div className="row-meta"><span>{used.length ? `Used by ${used.map((u) => u.id).join(', ')}` : 'Not linked to a spec'}</span><span>Edited {ago(touched(d))}</span></div>
        </Link>,
      );
    }
    return out;
  };
  const nDocs = S.all('doc').filter((d) => !d.pinned).length;
  return (
    <>
      <Bar title="Documents">
        {can && (
          <Dropdown className="btn primary only-desktop" ariaLabel="New" label={<><Icon name="plus" size={14} /> New <Icon name="chevron" size={14} /></>}>
            {(close) => <>
              <button type="button" role="menuitem" onClick={() => { close(); setSheet({ kind: 'newdoc', value: ui.lastFolder ? `${ui.lastFolder}/` : '' }); }}><Icon name="file" size={16} /><span>Document</span></button>
              <button type="button" role="menuitem" onClick={() => { close(); setSheet({ kind: 'newfolder', value: '' }); }}><Icon name="folderPlus" size={16} /><span>Folder <small>with README.md</small></span></button>
            </>}
          </Dropdown>
        )}
      </Bar>
      <div className="list" id="list" style={{ paddingTop: 8 }}>
        <div className="sect-title" style={{ marginTop: 6 }}><span>Foundation · always available to agents</span></div>
        {found.map((d) => {
          const st = foundState(d, S);
          const sub = d.core ? (hasContent(d.body) ? 'Always available to agents' : 'Write it once – agents always get it') : 'Pinned document';
          return <Link key={d.id} className={`found ${selected === d.id ? 'active' : ''}`} to={`/doc/${enc(d.id)}`}><span className="fi"><Icon name={d.id === 'vision.md' ? 'release' : 'file'} size={18} /></span><span className="fb"><b>{CORE_LABEL[d.id] ?? d.id}</b>{!(d.core && hasContent(d.body)) && <span>{sub}</span>}</span><span className={`chip ${st.cls}`}>{st.text}</span></Link>;
        })}
        <div className="sect-title" style={{ marginTop: 14 }}><span>Documents</span><small>{nDocs}</small></div>
        {tree.folders.size || tree.docs.length ? renderNode(tree, '', 0) : <div className="empty">No documents yet.<br />Add ADRs, schemas or notes and link them to specs. Organise them in folders.</div>}
      </div>
      {sheet && <PathSheet kind={sheet.kind} value={sheet.value} from={sheet.from} onClose={() => setSheet(null)} />}
      {can && <Fab label="New" act="new-doc" onClick={async () => { const k = await openMenu('New', [{ key: 'doc', label: 'Document' }, { key: 'folder', label: 'Folder with README.md' }]); if (k === 'doc') setSheet({ kind: 'newdoc', value: ui.lastFolder ? `${ui.lastFolder}/` : '' }); else if (k === 'folder') setSheet({ kind: 'newfolder', value: '' }); }} />}
    </>
  );
}

export function DocsPage() {
  const S = useStore();
  const { '*': rest } = useParams();
  const id = rest ? decodeURIComponent(rest) : undefined;
  const item = id ? S.get(id) : undefined;
  return <Shell master={<DocsList selected={id} />} detail={id ? (item && item.kind === 'doc' ? <ItemEditor key={id} item={item} /> : <NotFound what="document" to="/docs" back="Documents" />) : undefined} />;
}
