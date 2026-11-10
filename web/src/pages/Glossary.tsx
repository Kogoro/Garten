import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { splitList } from '@shared/glossary.js';
import { Dropdown, FormError, Sheet } from '../dialogs';
import { Bar, Shell } from '../Shell';
import { openMenu, useUi } from '../state';
import { Icon, toast, useStore } from '../ui';
import { Linkify, TermRef, glossaryPath, glossaryTerms, groupOf, mentions, plain, termIndex, type Term } from '../glossaryLib';

type Store = ReturnType<typeof useStore>;

function TermSheet({ initial, folder, onClose }: { initial?: string; folder?: string; onClose: () => void }) {
  const S = useStore(); const nav = useNavigate();
  const [err, setErr] = useState<string | null>(null);
  function submit() {
    const g = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
    const term = g('termname').trim(), def = g('termdef').trim();
    if (!term || !def) return setErr('Enter a term and its definition');
    if (/[[\]|]/.test(term)) return setErr('Terms cannot contain [ ] or |');
    if (glossaryTerms(S).some((t) => t.term.toLowerCase() === term.toLowerCase() && t.defs.some((d) => d.item.id === 'glossary.md'))) return setErr(`“${term}” is already in the glossary`);
    S.saveGlossaryTerm({ term, definition: def, aliases: splitList(g('termaliases')), see: splitList(g('termsee')), folder: g('termfolder') });
    onClose(); nav(glossaryPath(term)); toast('Term added to the glossary');
  }
  return (
    <Sheet onClose={onClose}>
      <h2>New glossary term</h2><p>Added to your glossary. Agents receive it as soon as it is live.</p>
      <label className="sr" htmlFor="termname">Term</label><input id="termname" className="field" placeholder="Term" autoComplete="off" defaultValue={initial ?? ''} />
      <label className="sr" htmlFor="termdef">Definition</label><textarea id="termdef" className="field" style={{ height: 110, padding: 12 }} placeholder="What the term means in this project. Reference other terms with [[Term]]." />
      <label className="sr" htmlFor="termaliases">Also known as</label><input id="termaliases" className="field" placeholder="Also known as (comma separated)" autoComplete="off" />
      <label className="sr" htmlFor="termsee">See also</label><input id="termsee" className="field" placeholder="See also (comma separated terms)" autoComplete="off" />
      <label className="sr" htmlFor="termfolder">Folder</label>
      <select id="termfolder" className="field" defaultValue={folder ?? ''}><option value="">General (no folder)</option>{S.glossaryModel().folders.map((f: string) => <option key={f}>{f}</option>)}</select>
      <FormError msg={err} /><button className="btn primary" data-act="create-term" onClick={submit}>Add term</button>
    </Sheet>
  );
}

function FolderSheet({ from, onClose }: { from?: string; onClose: () => void }) {
  const S = useStore();
  const [v, setV] = useState(from ?? '');
  const [err, setErr] = useState<string | null>(null);
  function go() { try { if (from) S.renameGlossaryFolder(from, v); else S.createGlossaryFolder(v); onClose(); toast(from ? 'Folder renamed' : 'Folder created'); } catch (x: any) { setErr(x.message); } }
  return (
    <Sheet onClose={onClose}>
      <h2>{from ? 'Rename folder' : 'New glossary folder'}</h2><p>Folders group terms in the glossary list (they are section headings in glossary.md).</p>
      <label className="sr" htmlFor="glfname">Folder name</label><input id="glfname" className="field" placeholder="e.g. Payments" value={v} maxLength={60} autoComplete="off" onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} />
      <FormError msg={err} /><button className="btn primary" data-act="do-gl-folder" onClick={go}>{from ? 'Rename' : 'Create'}</button>
    </Sheet>
  );
}

function ImportSheet({ onClose }: { onClose: () => void }) {
  const S = useStore();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const have = useMemo(() => new Set(glossaryTerms(S).flatMap((t) => [t.term.toLowerCase(), ...t.defs.flatMap((d) => d.aliases.map((a) => a.toLowerCase()))])), [S.getVersion()]); // eslint-disable-line react-hooks/exhaustive-deps
  const terms: any[] = S.state.globalTerms;
  const list = terms.filter((g) => !q || `${g.term} ${g.aliases.join(' ')} ${g.definition}`.toLowerCase().includes(q.toLowerCase()));
  function go() {
    const n = S.importGlobalTerms([...sel]);
    if (!n) return toast('Select at least one term');
    onClose(); toast(`${n} term${n === 1 ? '' : 's'} imported into your glossary`);
  }
  return (
    <Sheet onClose={onClose}>
      <h2>Import from the global glossary</h2>
      <p>Terms are copied into your glossary (glossary.md). You can edit them; if the global term changes later you get an “Update available” hint.</p>
      <label className="sr" htmlFor="gimport-q">Search</label><input id="gimport-q" className="field" type="search" placeholder="Search global terms" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} />
      <div id="gimport-list" className="gi-list">
        {!list.length && <p className="note" style={{ padding: '12px 0' }}>{terms.length ? 'No terms match.' : 'The global glossary is empty. An instance admin can add terms under Admin.'}</p>}
        {list.map((g) => { const taken = have.has(g.term.toLowerCase()); return (
          <label key={g.id} className={`gi-row ${taken ? 'off' : ''}`}>
            <input type="checkbox" className="gi-check" disabled={taken} checked={sel.has(g.id)} onChange={(e) => { const n = new Set(sel); e.target.checked ? n.add(g.id) : n.delete(g.id); setSel(n); }} />
            <span className="gi-body"><b>{g.term}{g.aliases.length > 0 && <small className="muted"> also: {g.aliases.join(', ')}</small>}</b><span>{g.definition.length > 140 ? `${g.definition.slice(0, 140)}…` : g.definition}</span>{taken && <small className="muted">Already in your glossary</small>}</span>
          </label>); })}
      </div>
      <button className="btn primary" data-act="do-gimport" onClick={go}>Import selected</button>
    </Sheet>
  );
}

function GlossaryList({ selected }: { selected?: string }) {
  const S = useStore(); const ui = useUi();
  const [q, setQ] = useState('');
  const [sheet, setSheet] = useState<null | { t: 'term' | 'folder' | 'import'; from?: string }>(null);
  const all = glossaryTerms(S);
  const ql = q.trim().toLowerCase();
  const terms = all.filter((t) => !ql || t.term.toLowerCase().includes(ql) || t.defs.some((d) => d.definition.toLowerCase().includes(ql) || d.aliases.some((a) => a.toLowerCase().includes(ql))));
  const selCanon = (termIndex(all).get((selected ?? '').toLowerCase()) ?? selected ?? '').toLowerCase();
  const model = S.glossaryModel();
  const groups = new Map<string, { label: string; terms: Term[] }>([['', { label: 'General', terms: [] }], ...model.folders.map((f: string) => [f, { label: f, terms: [] }] as [string, { label: string; terms: Term[] }]), ['__specs', { label: 'In specs & documents', terms: [] }]]);
  for (const t of terms) (groups.get(groupOf(t)) ?? groups.get('')!).terms.push(t);
  const flat = !model.folders.length && !groups.get('__specs')!.terms.length;
  const row = (t: Term) => {
    const aliases = [...new Set(t.defs.flatMap((d) => d.aliases))];
    const first = plain(t.defs[0]?.definition ?? '');
    return (
      <Link key={t.term} className={`row ${selCanon && t.term.toLowerCase() === selCanon ? 'active' : ''}`} to={glossaryPath(t.term)}>
        <div className="row-top"><span className="row-title">{t.term}</span>{t.defs.some((d) => d.origin) && <span className="chip">Global</span>}</div>
        <div className="row-meta"><span className="gl-ex">{first.length > 90 ? `${first.slice(0, 90)}…` : first}</span>{aliases.length > 0 && <span className="muted">aka {aliases.slice(0, 2).join(', ')}{aliases.length > 2 ? ' …' : ''}</span>}</div>
      </Link>
    );
  };
  async function folderMenu(name: string) {
    const k = await openMenu(name, [{ key: 'rename', label: 'Rename…' }, { key: 'delete', label: 'Delete folder', danger: true }]);
    if (k === 'rename') setSheet({ t: 'folder', from: name });
    if (k === 'delete') { try { S.deleteGlossaryFolder(name); toast('Folder deleted'); } catch (x: any) { toast(x.message); } }
  }
  const can = S.can('write');
  useEffect(() => { S.loadGlobalGlossary(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <Bar title="Glossary">
        {can && (
          <Dropdown className="btn primary" ariaLabel="New" label={<><Icon name="plus" size={14} /> New <Icon name="chevron" size={14} /></>}>
            {(close) => <>
              <button type="button" role="menuitem" onClick={() => { close(); setSheet({ t: 'term' }); }}><Icon name="book" size={16} /><span>Term</span></button>
              <button type="button" role="menuitem" onClick={() => { close(); setSheet({ t: 'folder' }); }}><Icon name="folderPlus" size={16} /><span>Folder</span></button>
              <div className="dd-sep" />
              <button type="button" role="menuitem" onClick={async () => { close(); await S.loadGlobalGlossary(); setSheet({ t: 'import' }); }}><Icon name="glossary" size={16} /><span>Import from global glossary…</span></button>
              <Link role="menuitem" to="/doc/glossary.md" className="ddlink"><Icon name="file" size={16} /><span>Open as Markdown</span></Link>
            </>}
          </Dropdown>
        )}
      </Bar>
      <div className="listtools"><div className="search"><Icon name="search" /><label className="sr" htmlFor="gsearch">Search terms</label><input id="gsearch" type="search" placeholder="Search terms and synonyms" value={q} onChange={(e) => setQ(e.target.value)} /></div></div>
      <div className="list" id="glList">
        {!all.length && <div className="empty">No terms yet.<br />Create one with “New”, add a “Definition” block to any spec, or import terms from the global glossary.</div>}
        {all.length > 0 && !terms.length && <div className="empty">No terms match.</div>}
        {[...groups].map(([key, g]) => {
          if (!g.terms.length && (key === '' || key === '__specs' || ql)) return null;
          if (flat) return g.terms.map(row);
          const id = `gl:${key}`; const open = ui.openFolders[id] !== false;
          return (
            <div key={key}>
              <div className="frow" style={{ ['--d' as any]: 0 }}>
                <button type="button" className="ftoggle" aria-expanded={open} onClick={() => ui.set({ openFolders: { ...ui.openFolders, [id]: !open } })}><Icon name="chevron" size={14} /><Icon name="folder" size={16} /><span>{g.label}</span><small>{g.terms.length}</small></button>
                {can && key && key !== '__specs' && <button type="button" className="fbtn" data-act="gl-folder-menu" aria-label={`Folder actions for ${key}`} onClick={() => folderMenu(key)}><Icon name="more" size={18} /></button>}
              </div>
              {open && g.terms.map(row)}
            </div>
          );
        })}
      </div>
      {sheet?.t === 'term' && <TermSheet onClose={() => setSheet(null)} />}
      {sheet?.t === 'folder' && <FolderSheet from={sheet.from} onClose={() => setSheet(null)} />}
      {sheet?.t === 'import' && <ImportSheet onClose={() => setSheet(null)} />}
    </>
  );
}

function GlossaryDetail({ arg }: { arg: string }) {
  const S = useStore(); const nav = useNavigate();
  const [edit, setEdit] = useState(false);
  const [define, setDefine] = useState(false);
  const all = glossaryTerms(S);
  const idx = termIndex(all);
  const canon = idx.get(arg.toLowerCase());
  const t = canon ? all.find((x) => x.term.toLowerCase() === canon.toLowerCase()) : undefined;
  const can = S.can('write');
  useEffect(() => setEdit(false), [arg]);
  if (!t) return (
    <div className="gdetail" id="glDetail">
      <header className="bar"><Link className="icon-btn back" to="/glossary" aria-label="Back"><Icon name="back" /></Link><h1>{arg}</h1></header>
      <div className="scroll"><div className="page"><div className="empty" style={{ padding: '24px 0' }}>“{arg}” is not defined in this glossary yet.{can && <><br /><br /><button className="btn primary" onClick={() => setDefine(true)}><Icon name="plus" size={14} /> Define “{arg}”</button></>}</div></div></div>
      {define && <TermSheet initial={arg} onClose={() => setDefine(false)} />}
    </div>
  );
  const own = t.defs.find((d) => d.item.id === 'glossary.md');
  const aliases = [...new Set(t.defs.flatMap((d) => d.aliases))];
  const referencedBy = all.filter((o) => o !== t && o.defs.some((d) => [...d.see, ...d.refs].some((r) => (idx.get(r.toLowerCase()) ?? r).toLowerCase() === t.term.toLowerCase()))).map((o) => o.term);
  const related = [...new Set(t.defs.flatMap((d) => [...d.see, ...d.refs]))].filter((r) => r.toLowerCase() !== t.term.toLowerCase());
  const used = mentions(S, t, new Set(t.defs.map((d) => d.item.id)));
  const clash = new Set(t.defs.map((d) => d.definition)).size > 1;

  if (edit && own && can) return <TermEdit t={t} own={own} onDone={(newName) => { setEdit(false); if (newName && newName !== t.term) nav(glossaryPath(newName), { replace: true }); }} />;

  return (
    <div className="gdetail" id="glDetail">
      <header className="bar"><Link className="icon-btn back" to="/glossary" aria-label="Back"><Icon name="back" /></Link><h1>{t.term}</h1>
        {clash && <span className="chip warn">conflicting definitions</span>}
        {own && can && <><button className="btn" data-act="gl-edit" onClick={() => setEdit(true)}>Edit</button><button className="btn" data-act="gl-delete" style={{ color: 'var(--red)', borderColor: 'var(--red-line)' }} onClick={() => { if (!confirm(`Delete the term “${t.term}” from the glossary?`)) return; S.deleteGlossaryTerm(t.term); nav('/glossary'); toast('Term deleted'); }}>Delete</button></>}
      </header>
      <div className="scroll"><div className="page gd">
        {aliases.length > 0 && <div className="relrow"><span>Also known as</span>{aliases.map((a) => <span key={a} className="gd-alias">{a}</span>)}</div>}
        {t.defs.map((d, i) => {
          const o = S.parseOrigin(d.origin); const g = o && (S.state.globalTerms as any[]).find((x) => x.id === o.id); const upd = o && g && g.rev > o.rev;
          return (
            <section className="gd-def" key={i}><p><Linkify text={d.definition} idx={idx} /></p>
              <div className="gd-src"><span>Defined in</span><Link className="src" to={`/${d.item.kind}/${encodeURIComponent(d.item.id)}`}>{d.item.id}</Link>{d.folder && <span className="muted">· {d.folder}</span>}{o && <span className="chip">Global</span>}{upd && <span className="chip warn">Update available</span>}{o && !g && S.state.globalTerms.length > 0 && <span className="chip">Removed from global glossary</span>}
                {upd && can && d.item.id === 'glossary.md' && <button type="button" className="btn small" data-act="gl-update" onClick={() => { S.upsertGlossaryTerms([{ term: g.term, definition: g.definition, aliases: g.aliases, see: g.see, source: `global:${g.id}@${g.rev}` }]); toast(`“${g.term}” updated from the global glossary`); }}>Update from global</button>}
              </div></section>);
        })}
        {!own && can && <div className="card"><p className="note">This term is defined in a spec or document. Edit it there, or add it to the glossary to manage it here (the original stays untouched).</p><div className="btns"><button className="btn small" data-act="gl-adopt" onClick={() => { const d = t.defs[0]; S.saveGlossaryTerm({ term: t.term, definition: d.definition, aliases: d.aliases, see: d.see }); toast('Added to the glossary'); }}>Add to glossary</button></div></div>}
        {related.length > 0 && <div className="relrow"><span>See also</span>{related.map((r) => <TermRef key={r} name={r} idx={idx} />)}</div>}
        {referencedBy.length > 0 && <div className="relrow"><span>Referenced by</span>{referencedBy.map((r) => <TermRef key={r} name={r} idx={idx} />)}</div>}
        {used.length > 0 && <div className="relrow"><span>Used in</span>{used.slice(0, 8).map((it) => <Link key={it.id} className="src" to={`/${it.kind}/${encodeURIComponent(it.id)}`}>{it.id}</Link>)}{used.length > 8 && <small className="muted">+{used.length - 8} more</small>}</div>}
      </div></div>
    </div>
  );
}

function TermEdit({ t, own, onDone }: { t: Term; own: any; onDone: (name?: string) => void }) {
  const S = useStore();
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const term = String(f.get('term')).trim();
    S.saveGlossaryTerm({ term, oldTerm: t.term, definition: String(f.get('def')).trim(), aliases: splitList(String(f.get('aliases'))), see: splitList(String(f.get('see'))), folder: String(f.get('folder')) });
    toast('Term saved'); onDone(term);
  }
  return (
    <div className="gdetail" id="glDetail">
      <header className="bar"><button className="icon-btn back" data-act="gl-cancel" aria-label="Cancel" onClick={() => onDone()}><Icon name="back" /></button><h1>Edit term</h1></header>
      <div className="scroll"><div className="page">
        <form id="glEditForm" className="form" onSubmit={submit}>
          <label className="sr" htmlFor="gd-term">Term</label><input id="gd-term" name="term" className="field" defaultValue={t.term} required maxLength={80} autoComplete="off" />
          <label className="sr" htmlFor="gd-def">Definition</label><textarea id="gd-def" name="def" className="field" style={{ height: 150, padding: 12 }} placeholder="Definition – reference other terms with [[Term]]" required defaultValue={own.definition} />
          <label className="sr" htmlFor="gd-aliases">Also known as</label><input id="gd-aliases" name="aliases" className="field" placeholder="Also known as (comma separated)" defaultValue={own.aliases.join(', ')} autoComplete="off" />
          <label className="sr" htmlFor="gd-see">See also</label><input id="gd-see" name="see" className="field" placeholder="See also (comma separated terms)" defaultValue={own.see.join(', ')} autoComplete="off" />
          <label className="sr" htmlFor="gd-folder">Folder</label><select id="gd-folder" name="folder" className="field" defaultValue={own.folder ?? ''}><option value="">General (no folder)</option>{S.glossaryModel().folders.map((f: string) => <option key={f}>{f}</option>)}</select>
          {own.origin && <p className="note">Imported from the global glossary. Your changes stay local; “Update available” later will offer to replace them.</p>}
          <div className="btns"><button className="btn primary" type="submit">Save</button><button type="button" className="btn" onClick={() => onDone()}>Cancel</button></div>
        </form>
      </div></div>
    </div>
  );
}

export function GlossaryPage() {
  const { '*': rest } = useParams();
  const arg = rest ? decodeURIComponent(rest) : undefined;
  return <Shell active="glossary" master={<GlossaryList selected={arg} />} detail={arg ? <GlossaryDetail key={arg} arg={arg} /> : undefined} />;
}
export type { Store };
