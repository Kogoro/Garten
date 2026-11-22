import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { splitList } from '@shared/glossary.js';
import { parseTermFile, termFolder, termsToCsv, isProposedPath, replaceWord } from '@shared/glossaryFiles.js';
import { parseGlossaryFile } from '@shared/glossaryImport.js';
import { Dropdown, FormError, Sheet } from '../dialogs';
import { Bar, Shell } from '../Shell';
import { openMenu, useUi } from '../state';
import { usePref } from '../prefs';
import { Fab } from '../Fab';
import { Tabs } from '../Tabs';
import { foundState } from '../lib';
import { GrowthIcon } from '../growth';
import { Icon, ago, toast, useStore } from '../ui';
import { api } from '../store/core';
import { readZip, writeZip, download } from '../zip';
import { DefinitionEditor } from '../editor/DefinitionEditor';
import {
  DefPreview,
  ISSUE_GROUPS,
  Md,
  registerTermLookup,
  TermRef,
  glossaryIssues,
  glossaryPath,
  glossaryTerms,
  groupOf,
  plain,
  termIndex,
  usages,
  type Issue,
  type Term,
} from '../glossaryLib';

type Store = ReturnType<typeof useStore>;
const PROPOSED = '~proposed/';
const HEALTH = '~health/';

/** Free online lookup (Wikipedia, Wiktionary, dictionaryapi.dev through this server). "Use" hands the text with its source to the caller. */
function LookupPanel({ term, onUse }: { term: () => string; onUse: (text: string) => void }) {
  const S = useStore();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lang, setLang] = useState(() => {
    try {
      return localStorage.getItem('lookupLang') || 'en';
    } catch {
      return 'en';
    }
  });
  const [res, setRes] = useState<{ query: string; results: any[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function search() {
    const q = term().trim();
    if (q.length < 2) return setErr('Type the term first.');
    setBusy(true);
    setErr(null);
    try {
      localStorage.setItem('lookupLang', lang);
    } catch {
      /* storage unavailable */
    }
    try {
      setRes(await api('GET', `/api/lookup?q=${encodeURIComponent(q)}&lang=${lang}`));
    } catch (e: any) {
      setRes(null);
      setErr(e.message || 'Lookup failed');
    }
    setBusy(false);
  }
  if (!open)
    return (
      <button type="button" className="disc" data-act="lookup-open" onClick={() => setOpen(true)}>
        <Icon name="chevron" size={14} />
        Look up online (Wikipedia, Wiktionary)
      </button>
    );
  return (
    <div className="lookup">
      <div className="lookup-row">
        <select aria-label="Language" className="field" value={lang} onChange={(e) => setLang(e.target.value)}>
          {['en', 'de', 'fr', 'es', 'it', 'nl', 'pt'].map((l) => (
            <option key={l} value={l}>
              {l.toUpperCase()}
            </option>
          ))}
        </select>
        <button type="button" className="btn" data-act="lookup" disabled={busy || !S.state.online} onClick={search}>
          {busy ? 'Searching…' : S.state.online ? 'Search definitions online' : 'Online lookup needs a connection'}
        </button>
      </div>
      {err && <span className="err-text">{err}</span>}
      {res && !res.results.length && <p className="note">Nothing found for “{res.query}”. Try another spelling or language.</p>}
      {res?.results.map((r, i) => (
        <div className="lookup-hit" key={i} data-lookup-hit>
          <b>{r.title}</b>
          <p>{r.text}</p>
          <small className="muted">
            <a href={r.url} target="_blank" rel="noopener noreferrer">
              {r.source}
            </a>{' '}
            ·{' '}
            <a href={r.licenseUrl} target="_blank" rel="noopener noreferrer">
              {r.license}
            </a>
          </small>
          <button
            type="button"
            className="btn small"
            data-act="lookup-use"
            onClick={() => {
              onUse(`${r.text} (Source: ${r.source}, ${r.license} – ${r.url})`);
              toast('Definition copied – shorten or reword it, the source stays');
            }}
          >
            Use as definition
          </button>
        </div>
      ))}
    </div>
  );
}

/** Words as removable chips; Enter or comma adds, Backspace in the empty field removes the last one. */
function TokenField({
  id,
  label,
  value,
  onChange,
  placeholder,
  suggest,
}: {
  id: string;
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  suggest?: string[];
}) {
  const [draft, setDraft] = useState('');
  const add = (raw: string) => {
    const v = splitList(raw).filter((x) => !value.some((y) => y.toLowerCase() === x.toLowerCase()));
    if (v.length) onChange([...value, ...v]);
    setDraft('');
  };
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === 'Enter' || e.key === ',') && draft.trim()) {
      e.preventDefault();
      add(draft);
    } else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
  };
  return (
    <div className="tokf-wrap">
      <label className="field-lbl" htmlFor={id}>
        {label}
      </label>
      <div className="tokf" onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement)?.focus()}>
        {value.map((v) => (
          <span className="tok" key={v}>
            {v}
            <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((x) => x !== v))}>
              <Icon name="close" size={12} />
            </button>
          </span>
        ))}
        <input
          id={id}
          value={draft}
          placeholder={value.length ? '' : placeholder}
          autoComplete="off"
          list={suggest ? `${id}-list` : undefined}
          onChange={(e) => (e.target.value.includes(',') ? add(e.target.value) : setDraft(e.target.value))}
          onKeyDown={key}
          onBlur={() => draft.trim() && add(draft)}
        />
        {suggest && (
          <datalist id={`${id}-list`}>
            {suggest.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        )}
      </div>
    </div>
  );
}

const folderLabel = (f: string) => f.split('/').join(' / ');
function FolderSelect({ id, value, onChange, S }: { id: string; value: string; onChange: (v: string) => void; S: Store }) {
  const folders = S.glossaryFolders();
  return (
    <select id={id} className="field" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">General (no folder)</option>
      {folders.map((f) => (
        <option key={f} value={f}>
          {'  '.repeat(f.split('/').length - 1)}
          {f.split('/').pop()}
        </option>
      ))}
      {value && !folders.includes(value) && <option value={value}>{folderLabel(value)} (new)</option>}
    </select>
  );
}

export function TermSheet({
  initial,
  definition,
  folder,
  from,
  onClose,
}: {
  initial?: string;
  definition?: string;
  folder?: string;
  from?: string;
  onClose: () => void;
}) {
  const S = useStore();
  const nav = useNavigate();
  const [err, setErr] = useState<string | null>(null);
  const [f, setF] = useState(folder ?? '');
  const [body, setBody] = useState(definition ?? '');
  registerTermLookup(S);
  const names = glossaryTerms(S).map((t) => t.term);
  function submit() {
    const g = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
    try {
      const term = g('termname').trim();
      S.saveTerm({ term, body, aliases: splitList(g('termaliases')), see: splitList(g('termsee')), folder: f });
      onClose();
      nav(glossaryPath(term));
      toast('Term added to the glossary');
    } catch (e: any) {
      setErr(e.message);
    }
  }
  return (
    <Sheet onClose={onClose} wide>
      <h2>New glossary term</h2>
      <p>
        {from ? (
          <>
            Taken from <span className="mono">{from}</span> – check the wording.{' '}
          </>
        ) : null}
        Added to your glossary. Agents receive it as soon as it is live.
      </p>
      <label className="sr" htmlFor="termname">
        Term
      </label>
      <input id="termname" className="field" placeholder="Term" autoComplete="off" maxLength={80} defaultValue={initial ?? ''} />
      <DefinitionEditor id="termdef" docKey="term|new" value={body} onChange={setBody} terms={names} />
      <LookupPanel
        term={() => (document.getElementById('termname') as HTMLInputElement)?.value ?? ''}
        onUse={(text) => setBody((b) => (b.trim() ? `${b.trim()}\n\n${text}` : text))}
      />
      <label className="sr" htmlFor="termaliases">
        Also known as
      </label>
      <input id="termaliases" className="field" placeholder="Also known as (comma separated)" autoComplete="off" />
      <label className="sr" htmlFor="termsee">
        See also
      </label>
      <input id="termsee" className="field" placeholder="See also (comma separated terms)" autoComplete="off" />
      <label className="sr" htmlFor="termfolder">
        Folder
      </label>
      <FolderSelect id="termfolder" value={f} onChange={setF} S={S} />
      <FormError msg={err} />
      <button className="btn primary" data-act="create-term" onClick={submit}>
        Add term
      </button>
    </Sheet>
  );
}

function FolderSheet({ from, parent, onClose }: { from?: string; parent?: string; onClose: () => void }) {
  const S = useStore();
  const [v, setV] = useState(from ?? (parent ? `${parent}/` : ''));
  const [err, setErr] = useState<string | null>(null);
  function go() {
    try {
      if (from) S.renameGlossaryFolder(from, v);
      else S.createGlossaryFolder(v);
      onClose();
      toast(from ? 'Folder renamed' : 'Folder created');
    } catch (x: any) {
      setErr(x.message);
    }
  }
  return (
    <Sheet onClose={onClose}>
      <h2>{from ? 'Rename or move folder' : 'New glossary folder'}</h2>
      <p>
        Folders group terms; use / for sub-folders (Billing/Invoices). Each folder is a folder in the team repository, each term a file in
        it.
      </p>
      <label className="sr" htmlFor="glfname">
        Folder
      </label>
      <input
        id="glfname"
        className="field"
        placeholder="e.g. Payments or Billing/Invoices"
        value={v}
        maxLength={90}
        autoComplete="off"
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && go()}
      />
      <FormError msg={err} />
      <button className="btn primary" data-act="do-gl-folder" onClick={go}>
        {from ? 'Rename' : 'Create'}
      </button>
    </Sheet>
  );
}

function ImportSheet({ onClose }: { onClose: () => void }) {
  const S = useStore();
  const [q, setQ] = useState('');
  const [folder, setFolder] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const have = useMemo(
    () => new Set(glossaryTerms(S).flatMap((t) => [t.term.toLowerCase(), ...t.defs.flatMap((d) => d.aliases.map((a) => a.toLowerCase()))])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [S.getVersion()],
  );
  const terms: any[] = S.state.globalTerms;
  const list = terms.filter((g) => !q || `${g.term} ${g.aliases.join(' ')} ${g.definition}`.toLowerCase().includes(q.toLowerCase()));
  function go() {
    const n = S.importGlobalTerms([...sel], folder);
    if (!n) return toast('Select at least one term');
    onClose();
    toast(`${n} term${n === 1 ? '' : 's'} imported into your glossary`);
  }
  return (
    <Sheet onClose={onClose}>
      <h2>Import from the global glossary</h2>
      <p>
        Terms are copied into your glossary as term files. You can edit them; if the global term changes later, Health offers the update.
      </p>
      <label className="sr" htmlFor="gimport-q">
        Search
      </label>
      <input
        id="gimport-q"
        className="field"
        type="search"
        placeholder="Search global terms"
        autoComplete="off"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div id="gimport-list" className="gi-list">
        {!list.length && (
          <p className="note" style={{ padding: '12px 0' }}>
            {terms.length ? 'No terms match.' : 'The global glossary is empty. An instance admin can add terms under Admin.'}
          </p>
        )}
        {list.map((g) => {
          const taken = have.has(g.term.toLowerCase());
          return (
            <label key={g.id} className={`gi-row ${taken ? 'off' : ''}`}>
              <input
                type="checkbox"
                className="gi-check"
                disabled={taken}
                checked={sel.has(g.id)}
                onChange={(e) => {
                  const n = new Set(sel);
                  e.target.checked ? n.add(g.id) : n.delete(g.id);
                  setSel(n);
                }}
              />
              <span className="gi-body">
                <b>
                  {g.term}
                  {g.aliases.length > 0 && <small className="muted"> also: {g.aliases.join(', ')}</small>}
                </b>
                <span className="gl-ex">
                  <DefPreview text={g.definition} />
                </span>
                {taken && <small className="muted">Already in your glossary</small>}
              </span>
            </label>
          );
        })}
      </div>
      <label className="field-lbl" htmlFor="gimport-folder">
        Into folder
      </label>
      <FolderSelect id="gimport-folder" value={folder} onChange={setFolder} S={S} />
      <button className="btn primary" data-act="do-gimport" onClick={go}>
        Import selected
      </button>
    </Sheet>
  );
}

type FileTerm = {
  term: string;
  body: string;
  aliases: string[];
  see: string[];
  avoid: string[];
  distinct: string[];
  folder: string;
  origin?: string | null;
};
/** Import a team glossary from a ZIP of term files (as exported) or a CSV/JSON/Markdown list. */
function FileImportSheet({ name, terms, errors, onClose }: { name: string; terms: FileTerm[]; errors: string[]; onClose: () => void }) {
  const S = useStore();
  const [mode, setMode] = useState<'skip' | 'overwrite'>('skip');
  const existing = terms.filter((t) => S.termByName(t.term)).length;
  function go() {
    const r = S.importTerms(terms, mode);
    onClose();
    toast(`${r.added} added${r.updated ? `, ${r.updated} updated` : ''}${r.skipped ? `, ${r.skipped} skipped` : ''}`);
  }
  return (
    <Sheet onClose={onClose}>
      <h2>Import {name}</h2>
      <p>
        <b>{terms.length}</b> term{terms.length === 1 ? '' : 's'} found: <b>{terms.length - existing}</b> new, <b>{existing}</b> already in
        your glossary.
      </p>
      {errors.length > 0 && (
        <div className="card warn" style={{ padding: 12 }}>
          <small>
            {errors.slice(0, 5).join(' · ')}
            {errors.length > 5 ? ` · +${errors.length - 5} more` : ''}
          </small>
        </div>
      )}
      {existing > 0 && (
        <div className="opts">
          <label className={`opt ${mode === 'skip' ? 'on' : ''}`}>
            <input type="radio" name="gimode" checked={mode === 'skip'} onChange={() => setMode('skip')} />
            <span>
              Keep my terms<small>Terms that exist are skipped</small>
            </span>
          </label>
          <label className={`opt ${mode === 'overwrite' ? 'on' : ''}`}>
            <input type="radio" name="gimode" checked={mode === 'overwrite'} onChange={() => setMode('overwrite')} />
            <span>
              Replace them<small>Definition, synonyms and folder come from the file</small>
            </span>
          </label>
        </div>
      )}
      <button className="btn primary" data-act="do-file-import" disabled={!terms.length} onClick={go}>
        Import {terms.length}
      </button>
    </Sheet>
  );
}

async function parseImportFile(f: File): Promise<{ terms: FileTerm[]; errors: string[] }> {
  if (/\.zip$/i.test(f.name)) {
    const files = await readZip(await f.arrayBuffer());
    const terms: FileTerm[] = [];
    const errors: string[] = [];
    for (const x of files.filter((y) => y.name.endsWith('.md'))) {
      const rel = x.name.replace(/^\/+/, '').replace(/^glossary\//, '');
      if (rel.startsWith('_proposed/')) continue;
      const t = parseTermFile(x.text);
      if (!t) {
        errors.push(`${x.name}: no term front matter`);
        continue;
      }
      terms.push({
        term: t.term,
        body: t.body,
        aliases: t.aliases,
        see: t.see,
        avoid: t.avoid,
        distinct: t.distinct,
        folder: rel.split('/').slice(0, -1).join('/'),
        origin: t.origin,
      });
    }
    if (!terms.length && !errors.length) errors.push('The archive holds no term files');
    return { terms, errors };
  }
  const r = parseGlossaryFile(f.name, await f.text());
  return {
    terms: r.terms.map((t: any) => ({
      term: t.term,
      body: t.definition,
      aliases: t.aliases ?? [],
      see: t.see ?? [],
      avoid: t.avoid ?? [],
      distinct: t.distinct ?? [],
      folder: t.folder ?? '',
    })),
    errors: r.errors,
  };
}

function exportTerms(S: Store, kind: 'csv' | 'zip') {
  const items = S.termItems();
  if (!items.length) return toast('The glossary is empty');
  const name = `${S.team()?.key ?? 'team'}-glossary`;
  if (kind === 'csv') {
    const rows = items.map((d) => ({ ...parseTermFile(d.body)!, folder: termFolder(d.id) })).sort((a, b) => a.term.localeCompare(b.term));
    download(`${name}.csv`, new Blob([termsToCsv(rows)], { type: 'text/csv' }));
  } else download(`${name}.zip`, writeZip(items.map((d) => ({ name: d.id.replace(/^glossary\//, ''), text: d.body }))));
  toast(`${items.length} term${items.length === 1 ? '' : 's'} exported`);
}

interface FNode {
  folders: Map<string, FNode>;
  terms: Term[];
}
function GlossaryList({ arg }: { arg?: string }) {
  const S = useStore();
  const ui = useUi();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [pref, setPref] = usePref<'terms' | 'proposed' | 'health'>('tab-glossary', 'terms', ['terms', 'proposed', 'health']);
  const tab = arg?.startsWith(PROPOSED) ? 'proposed' : arg?.startsWith(HEALTH) ? 'health' : arg ? 'terms' : pref;
  const [sheet, setSheet] = useState<
    | null
    | { t: 'term' | 'folder' | 'import'; from?: string; parent?: string; folder?: string }
    | { t: 'file'; name: string; terms: FileTerm[]; errors: string[] }
  >(null);
  const file = useRef<HTMLInputElement>(null);
  const all = glossaryTerms(S);
  const proposed = S.proposedItems();
  const issues = glossaryIssues(S);
  const serious = issues.filter((i) => i.kind !== 'unused').length;
  const can = S.can('write');
  useEffect(() => {
    S.loadGlobalGlossary();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const ql = q.trim().toLowerCase();
  const terms = all.filter(
    (t) =>
      !ql ||
      t.term.toLowerCase().includes(ql) ||
      t.defs.some((d) => plain(d.definition).toLowerCase().includes(ql) || d.aliases.some((a) => a.toLowerCase().includes(ql))),
  );
  const idx = termIndex(all);
  const selCanon = tab === 'terms' && arg ? (idx.get(arg.toLowerCase()) ?? arg).toLowerCase() : '';
  const root: FNode = { folders: new Map(), terms: [] };
  const node = (path: string) =>
    path
      .split('/')
      .filter(Boolean)
      .reduce((n, seg) => {
        if (!n.folders.has(seg)) n.folders.set(seg, { folders: new Map(), terms: [] });
        return n.folders.get(seg)!;
      }, root);
  if (!ql) for (const f of S.glossaryFolders()) node(f);
  const specs: Term[] = [];
  for (const t of terms) {
    const g = groupOf(t);
    if (g === '__specs') specs.push(t);
    else node(g).terms.push(t);
  }
  const count = (n: FNode): number => n.terms.length + [...n.folders.values()].reduce((a, c) => a + count(c), 0);

  const row = (t: Term, depth: number) => {
    const aliases = [...new Set(t.defs.flatMap((d) => d.aliases))];
    const two = new Set(t.defs.map((d) => plain(d.definition))).size > 1;
    return (
      <Link
        key={t.term}
        className={`row glrow ${selCanon && t.term.toLowerCase() === selCanon ? 'active' : ''}`}
        style={{ ['--d' as any]: depth }}
        to={glossaryPath(t.term)}
      >
        <div className="row-top">
          <span className="row-title">{t.term}</span>
          {t.defs.some((d) => d.origin) && <span className="chip">Global</span>}
          {two && <span className="chip warn">2 definitions</span>}
        </div>
        <div className="row-meta">
          <span className="gl-ex">
            <DefPreview text={t.defs[0]?.definition ?? ''} />
          </span>
          {aliases.length > 0 && (
            <span className="muted">
              aka {aliases.slice(0, 2).join(', ')}
              {aliases.length > 2 ? ' …' : ''}
            </span>
          )}
        </div>
      </Link>
    );
  };
  async function folderMenu(path: string) {
    const k = await openMenu(folderLabel(path), [
      { key: 'term', label: 'New term here' },
      { key: 'sub', label: 'New sub-folder' },
      { key: 'rename', label: 'Rename / move…' },
      { key: 'delete', label: 'Delete folder', danger: true },
    ]);
    if (k === 'term') setSheet({ t: 'term', folder: path });
    if (k === 'sub') setSheet({ t: 'folder', parent: path });
    if (k === 'rename') setSheet({ t: 'folder', from: path });
    if (k === 'delete') {
      try {
        S.deleteGlossaryFolder(path);
        toast('Folder deleted');
      } catch (x: any) {
        toast(x.message);
      }
    }
  }
  const renderNode = (n: FNode, prefix: string, depth: number): ReactElement[] => {
    const out: ReactElement[] = [];
    for (const [name, child] of [...n.folders].sort((a, b) => a[0].localeCompare(b[0]))) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (ql && !count(child)) continue;
      const id = `gl:${path}`;
      const open = ql ? true : ui.openFolders[id] !== false;
      out.push(
        <div className="frow" style={{ ['--d' as any]: depth }} key={`f:${path}`}>
          <button
            type="button"
            className="ftoggle"
            aria-expanded={open}
            onClick={() => ui.set({ openFolders: { ...ui.openFolders, [id]: !open } })}
          >
            <Icon name="chevron" size={14} />
            <Icon name="folder" size={16} />
            <span>{name}</span>
            <small>{count(child)}</small>
          </button>
          {can && (
            <button
              type="button"
              className="fbtn"
              data-act="gl-folder-menu"
              aria-label={`Folder actions for ${path}`}
              onClick={() => folderMenu(path)}
            >
              <Icon name="more" size={18} />
            </button>
          )}
        </div>,
      );
      if (open) out.push(...renderNode(child, path, depth + 1));
    }
    out.push(...[...n.terms].sort((a, b) => a.term.localeCompare(b.term)).map((t) => row(t, depth)));
    return out;
  };
  async function pickFile(f?: File) {
    if (!f) return;
    try {
      const r = await parseImportFile(f);
      setSheet({ t: 'file', name: f.name, ...r });
    } catch (e: any) {
      toast(e.message || 'Could not read the file');
    }
  }
  async function newMenu() {
    const k = await openMenu('New', [
      { key: 'term', label: 'Term' },
      { key: 'folder', label: 'Folder' },
      { key: 'import', label: 'Import from global glossary…' },
      { key: 'file', label: 'Import file (ZIP, CSV) …' },
      { key: 'csv', label: 'Export as CSV' },
      { key: 'zip', label: 'Export as ZIP' },
    ]);
    if (k === 'term') setSheet({ t: 'term' });
    else if (k === 'folder') setSheet({ t: 'folder' });
    else if (k === 'import') {
      await S.loadGlobalGlossary();
      setSheet({ t: 'import' });
    } else if (k === 'file') file.current?.click();
    else if (k === 'csv' || k === 'zip') exportTerms(S, k);
  }
  const setTab = (t: string) => {
    setPref(t as typeof pref);
    if (arg) nav('/glossary');
  };
  const specsOpen = ui.openFolders['gl:__specs'] !== false;
  return (
    <>
      <Bar title="Glossary">
        {can && (
          <Dropdown
            className={`btn ${arg ? '' : 'primary'} only-desktop`}
            ariaLabel="New"
            label={
              <>
                <Icon name="plus" size={14} /> New <Icon name="chevron" size={14} />
              </>
            }
          >
            {(close) => (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close();
                    setSheet({ t: 'term' });
                  }}
                >
                  <Icon name="book" size={16} />
                  <span>Term</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close();
                    setSheet({ t: 'folder' });
                  }}
                >
                  <Icon name="folderPlus" size={16} />
                  <span>Folder</span>
                </button>
                <div className="dd-sep" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={async () => {
                    close();
                    await S.loadGlobalGlossary();
                    setSheet({ t: 'import' });
                  }}
                >
                  <Icon name="glossary" size={16} />
                  <span>Import from global glossary…</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-act="gl-import-file"
                  onClick={() => {
                    close();
                    file.current?.click();
                  }}
                >
                  <Icon name="up" size={16} />
                  <span>
                    Import file <small>ZIP, CSV</small>
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-act="gl-export-csv"
                  onClick={() => {
                    close();
                    exportTerms(S, 'csv');
                  }}
                >
                  <Icon name="file" size={16} />
                  <span>Export as CSV</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-act="gl-export-zip"
                  onClick={() => {
                    close();
                    exportTerms(S, 'zip');
                  }}
                >
                  <Icon name="file" size={16} />
                  <span>
                    Export as ZIP <small>a file per entry</small>
                  </span>
                </button>
              </>
            )}
          </Dropdown>
        )}
      </Bar>
      <input
        type="file"
        ref={file}
        hidden
        aria-label="Glossary file"
        accept=".zip,.csv,.tsv,.json,.md,.markdown,.txt"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          pickFile(f);
        }}
      />
      <Tabs
        label="Glossary views"
        controls={tab === 'terms' ? 'glList' : tab === 'proposed' ? 'glProposed' : 'glHealth'}
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'terms', label: 'Terms' },
          { id: 'proposed', label: 'Proposed', badge: proposed.length || undefined },
          { id: 'health', label: 'Health', badge: serious || undefined },
        ]}
      />
      {tab === 'terms' && (
        <>
          <div className="listtools">
            <div className="search">
              <Icon name="search" />
              <label className="sr" htmlFor="gsearch">
                Search terms
              </label>
              <input
                id="gsearch"
                type="search"
                placeholder="Search terms, synonyms and definitions"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
          </div>
          <div className="list" id="glList" role="tabpanel" aria-labelledby="tab-terms">
            {!all.length && !S.glossaryFolders().length && (
              <div className="empty">
                No terms yet.
                <br />
                Create one with “New”, add a “Definition” block to any spec, or import terms.
              </div>
            )}
            {all.length > 0 && !terms.length && <div className="empty">No terms match.</div>}
            {renderNode(root, '', 0)}
            {specs.length > 0 && (
              <>
                <div className="frow" style={{ ['--d' as any]: 0 }}>
                  <button
                    type="button"
                    className="ftoggle"
                    aria-expanded={specsOpen}
                    onClick={() => ui.set({ openFolders: { ...ui.openFolders, 'gl:__specs': !specsOpen } })}
                  >
                    <Icon name="chevron" size={14} />
                    <Icon name="file" size={16} />
                    <span>In specs &amp; documents</span>
                    <small>{specs.length}</small>
                  </button>
                </div>
                {specsOpen && specs.map((t) => row(t, 1))}
              </>
            )}
          </div>
        </>
      )}
      {tab === 'proposed' && (
        <div className="list" id="glProposed" role="tabpanel" aria-labelledby="tab-proposed">
          {!proposed.length && (
            <div className="empty">
              No proposed terms. Agents propose terms with propose_term or derive_from_document; they wait here for an approver.
            </div>
          )}
          {proposed.map((d) => {
            const t = parseTermFile(d.body)!;
            return (
              <Link
                key={d.id}
                className={`row ${arg === PROPOSED + d.id ? 'active' : ''}`}
                to={`/glossary/${PROPOSED}${encodeURIComponent(d.id)}`}
              >
                <div className="row-top">
                  <GrowthIcon stage="sprout" size={14} />
                  <span className="row-title">{t.term}</span>
                </div>
                <div className="row-meta">
                  <span>
                    {[t.proposedBy, t.from && `from ${t.from}`, ago(Date.parse(d.updatedAt ?? '') || undefined)]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
      {tab === 'health' && (
        <div className="list" id="glHealth" role="tabpanel" aria-labelledby="tab-health">
          {!issues.length && <div className="empty">Nothing to fix. Terms, synonyms and references are consistent.</div>}
          {ISSUE_GROUPS.map((g) => {
            const list = issues.filter((i) => i.kind === g.kind);
            if (!list.length) return null;
            return (
              <div key={g.kind} data-issues={g.kind}>
                <div className="sect-title">
                  <span>{g.label}</span>
                  <small>{list.length}</small>
                </div>
                {list.map((i) => (
                  <Link
                    key={i.id}
                    className={`row ${arg === HEALTH + i.id ? 'active' : ''}`}
                    to={`/glossary/${HEALTH}${encodeURIComponent(i.id)}`}
                  >
                    <div className="row-top">
                      <span className={`row-title ${i.kind === 'broken' ? 'bad-text' : ''}`}>{i.title}</span>
                    </div>
                    <div className="row-meta">
                      <span>{i.detail}</span>
                    </div>
                  </Link>
                ))}
              </div>
            );
          })}
        </div>
      )}
      {sheet?.t === 'term' && <TermSheet folder={sheet.folder} onClose={() => setSheet(null)} />}
      {sheet?.t === 'folder' && <FolderSheet from={sheet.from} parent={sheet.parent} onClose={() => setSheet(null)} />}
      {sheet?.t === 'import' && <ImportSheet onClose={() => setSheet(null)} />}
      {sheet?.t === 'file' && (
        <FileImportSheet name={sheet.name} terms={sheet.terms} errors={sheet.errors} onClose={() => setSheet(null)} />
      )}
      {can && <Fab label="New" act="new-term" onClick={newMenu} />}
    </>
  );
}

/** Deleting a term that is still referenced: references become plain text, or move to another term. */
function DeleteSheet({ path, term, onClose, onDone }: { path: string; term: string; onClose: () => void; onDone: () => void }) {
  const S = useStore();
  const refs = S.referencesTo(term, path);
  const [mode, setMode] = useState<'unlink' | 'merge'>('unlink');
  const [into, setInto] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const others = S.termItems()
    .map((d) => parseTermFile(d.body)!.term)
    .filter((x) => x !== term)
    .sort();
  function go() {
    try {
      S.deleteTerm(path, mode, into);
      onClose();
      onDone();
      toast(`“${term}” deleted`);
    } catch (e: any) {
      setErr(e.message);
    }
  }
  return (
    <Sheet onClose={onClose}>
      <h2>Delete “{term}”?</h2>
      <p>
        {refs.length
          ? `${refs.reduce((n, r) => n + r.n, 0)} reference${refs.length === 1 && refs[0].n === 1 ? '' : 's'} in ${refs.length} item${refs.length === 1 ? '' : 's'} point to it.`
          : 'Nothing references it.'}
      </p>
      {refs.length > 0 && (
        <>
          <div className="card refs-card">
            {refs.slice(0, 6).map((r) => (
              <div key={r.item.id} className="mono">
                {isProposedPath(r.item.id) ? r.item.id : (parseTermFile(r.item.body)?.term ?? r.item.id)}
              </div>
            ))}
            {refs.length > 6 && <div className="muted">+{refs.length - 6} more</div>}
          </div>
          <div className="opts">
            <label className={`opt ${mode === 'unlink' ? 'on' : ''}`}>
              <input type="radio" name="delmode" checked={mode === 'unlink'} onChange={() => setMode('unlink')} />
              <span>
                Replace the links with plain text
                <small>
                  “#[{term}]” becomes “{term}”
                </small>
              </span>
            </label>
            <label className={`opt ${mode === 'merge' ? 'on' : ''}`}>
              <input type="radio" name="delmode" checked={mode === 'merge'} onChange={() => setMode('merge')} />
              <span>
                Merge into another term<small>Links point to it, “{term}” becomes a synonym</small>
              </span>
            </label>
          </div>
          {mode === 'merge' && (
            <>
              <label className="sr" htmlFor="del-into">
                Merge into
              </label>
              <select id="del-into" className="field" value={into} onChange={(e) => setInto(e.target.value)}>
                <option value="">Choose a term…</option>
                {others.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            </>
          )}
        </>
      )}
      <FormError msg={err} />
      <div className="btns">
        <button className="btn danger" data-act="do-delete-term" disabled={mode === 'merge' && !into} onClick={go}>
          Delete term
        </button>
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Sheet>
  );
}

/** A word-level comparison of two texts. */
function Diff({ a, b }: { a: string; b: string }) {
  const x = a.split(/(\s+)/),
    y = b.split(/(\s+)/);
  const n = x.length,
    m = y.length;
  if (n * m > 400_000)
    return (
      <div className="diff">
        <del>{a}</del> <ins>{b}</ins>
      </div>
    );
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: ReactElement[] = [];
  let i = 0,
    j = 0,
    k = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      out.push(<span key={k++}>{x[i]}</span>);
      i++;
      j++;
    } else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) {
      out.push(<ins key={k++}>{y[j]}</ins>);
      j++;
    } else {
      out.push(<del key={k++}>{x[i]}</del>);
      i++;
    }
  }
  return <div className="diff">{out}</div>;
}
function UpdateSheet({ path, g, onClose }: { path: string; g: any; onClose: () => void }) {
  const S = useStore();
  const cur = parseTermFile(S.get(path)?.body ?? '');
  const [mode, setMode] = useState<'take' | 'keep'>('take');
  if (!cur) return null;
  function go() {
    if (mode === 'take') S.updateFromGlobal(path, g);
    else S.keepLocalVersion(path, g);
    onClose();
    toast(mode === 'take' ? `“${g.term}” updated from the global glossary` : 'Your version stays');
  }
  return (
    <Sheet onClose={onClose} wide>
      <h2>Update “{g.term}”?</h2>
      <p>The global glossary has revision {g.rev}. Changes against your copy:</p>
      <Diff a={cur.body} b={g.definition} />
      {g.aliases.join(', ') !== cur.aliases.join(', ') && (
        <p className="note">
          Synonyms: {cur.aliases.join(', ') || '–'} → {g.aliases.join(', ') || '–'}
        </p>
      )}
      <div className="opts">
        <label className={`opt ${mode === 'take' ? 'on' : ''}`}>
          <input type="radio" name="updmode" checked={mode === 'take'} onChange={() => setMode('take')} />
          <span>
            Take revision {g.rev}
            <small>Words to avoid, distinctions and the folder stay yours</small>
          </span>
        </label>
        <label className={`opt ${mode === 'keep' ? 'on' : ''}`}>
          <input type="radio" name="updmode" checked={mode === 'keep'} onChange={() => setMode('keep')} />
          <span>
            Keep my version<small>No longer offered until the next revision</small>
          </span>
        </label>
      </div>
      <div className="btns">
        <button className="btn primary" data-act="do-gl-update" onClick={go}>
          {mode === 'take' ? 'Update' : 'Keep mine'}
        </button>
        <button className="btn ghost" onClick={onClose}>
          Not now
        </button>
      </div>
    </Sheet>
  );
}

function History({ path }: { path: string }) {
  const S = useStore();
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => {
    let on = true;
    if (S.state.online)
      S.teamApi('GET', `/doc-history?path=${encodeURIComponent(path)}`)
        .then((d: any) => on && setRows(d.history))
        .catch(() => on && setRows([]));
    return () => {
      on = false;
    };
  }, [path, S.state.online]); // eslint-disable-line react-hooks/exhaustive-deps
  const it = S.get(path);
  return (
    <section className="list-card" aria-label="Versions">
      {it && S.hasUnreleased(it) && (
        <div className="row">
          <div className="row-top">
            <span className="row-title">Seed</span>
          </div>
          <div className="row-meta">
            Edited {ago(Date.parse(it.updatedAt ?? '') || it.editedAt)}
            {it.updatedBy ? ` by ${it.updatedBy}` : ''} · not in bloom yet
          </div>
        </div>
      )}
      {rows?.map((r) => (
        <div className="row" key={r.commit}>
          <div className="row-top">
            <span className="row-title">{r.message}</span>
          </div>
          <div className="row-meta">
            {ago(Date.parse(r.at))} by {r.by} · commit <span className="mono">{r.commit}</span>
          </div>
        </div>
      ))}
      {rows === null && <div className="empty">{S.state.online ? 'Loading…' : 'Offline – the history loads when you are online.'}</div>}
      {rows?.length === 0 && !(it && S.hasUnreleased(it)) && <div className="empty">Not released yet.</div>}
    </section>
  );
}

function GlossaryDetail({ arg }: { arg: string }) {
  const S = useStore();
  const nav = useNavigate();
  const [edit, setEdit] = useState(false);
  const [define, setDefine] = useState(false);
  const [sheet, setSheet] = useState<null | 'delete' | 'update'>(null);
  const [tab, setTab] = useState<'def' | 'used' | 'history'>('def');
  const all = glossaryTerms(S);
  const idx = termIndex(all);
  const canon = idx.get(arg.toLowerCase());
  const t = canon ? all.find((x) => x.term.toLowerCase() === canon.toLowerCase()) : undefined;
  const can = S.can('write');
  useEffect(() => {
    setEdit(false);
    setTab('def');
  }, [arg]);
  if (!t)
    return (
      <div className="gdetail" id="glDetail">
        <header className="bar">
          <Link className="icon-btn back" to="/glossary" aria-label="Back">
            <Icon name="back" />
          </Link>
          <h1>{arg}</h1>
        </header>
        <div className="scroll">
          <div className="page">
            <div className="empty" style={{ padding: '24px 0' }}>
              “{arg}” is not defined in this glossary yet.
              {can && (
                <>
                  <br />
                  <br />
                  <button className="btn primary" onClick={() => setDefine(true)}>
                    <Icon name="plus" size={14} /> Define “{arg}”
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
        {define && <TermSheet initial={arg} onClose={() => setDefine(false)} />}
      </div>
    );
  const own = t.defs.find((d) => d.own);
  const aliases = [...new Set(t.defs.flatMap((d) => d.aliases))];
  const avoid = [...new Set(t.defs.flatMap((d) => d.avoid))];
  const distinct = [...new Set(t.defs.flatMap((d) => d.distinct))];
  const referencedBy = all
    .filter(
      (o) =>
        o !== t &&
        o.defs.some((d) =>
          [...d.see, ...d.refs, ...d.distinct].some((r) => (idx.get(r.toLowerCase()) ?? r).toLowerCase() === t.term.toLowerCase()),
        ),
    )
    .map((o) => o.term);
  const related = [...new Set(t.defs.flatMap((d) => [...d.see, ...d.refs]))].filter((r) => r.toLowerCase() !== t.term.toLowerCase());
  const used = usages(S, t, new Set(t.defs.map((d) => d.item.id)));
  const two = new Set(t.defs.map((d) => plain(d.definition))).size > 1;
  const f = own ? foundState(own.item, S) : null;
  const o = own && S.parseOrigin(own.origin);
  const g = o && (S.state.globalTerms as any[]).find((x) => x.id === o.id);

  if (edit && own && can)
    return (
      <TermEdit
        path={own.item.id}
        onDone={(next) => {
          setEdit(false);
          if (next && next !== t.term) nav(glossaryPath(next), { replace: true });
        }}
      />
    );
  return (
    <div className="gdetail" id="glDetail">
      <header className="bar">
        <Link className="icon-btn back" to="/glossary" aria-label="Back">
          <Icon name="back" />
        </Link>
        <h1>{t.term}</h1>
        {two && <span className="chip warn">2 definitions</span>}
        {own && can && (
          <>
            <button className="btn" data-act="gl-edit" onClick={() => setEdit(true)}>
              Edit
            </button>
            <button className="btn danger-ghost" data-act="gl-delete" onClick={() => setSheet('delete')}>
              Delete
            </button>
          </>
        )}
      </header>
      <div className="gd-meta">
        {own ? (
          <>
            {own.folder ? folderLabel(own.folder) : 'General'} · <span className="mono">{own.item.id}</span> · {f?.text}
            {own.item.updatedBy ? ` · edited by ${own.item.updatedBy}` : ''}
          </>
        ) : (
          <>Defined in {t.defs.map((d) => d.item.id).join(', ')}</>
        )}
        {own && f && !f.live && !S.state.items.get(own.item.id)?.approve && S.can('approve') && S.team()?.foundationAuto === false && (
          <button
            type="button"
            className="btn small"
            data-act="gl-release"
            onClick={() => {
              S.requestApprove(own.item.id);
              toast('Blooming…');
            }}
          >
            Let it bloom
          </button>
        )}
      </div>
      <Tabs
        label="Term"
        value={tab}
        onChange={(v) => setTab(v as typeof tab)}
        tabs={[
          { id: 'def', label: 'Definition' },
          { id: 'used', label: 'Used in', badge: used.length || undefined },
          ...(own ? [{ id: 'history', label: 'History' }] : []),
        ]}
      />
      <div className="scroll">
        <div className="page gd" id="tabpanel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
          {tab === 'def' && (
            <>
              {t.defs.map((d, i) => (
                <section className="gd-def" key={i}>
                  <Md text={d.definition} idx={idx} />
                  <div className="gd-src">
                    {(t.defs.length > 1 || !d.own) && (
                      <>
                        <span>Defined in</span>
                        <Link className="src" to={d.own ? glossaryPath(t.term) : `/${d.item.kind}/${encodeURIComponent(d.item.id)}`}>
                          {d.item.id}
                        </Link>
                      </>
                    )}
                    {d.origin && <span className="chip">Global</span>}
                    {d.own && g && o && g.rev > o.rev && (
                      <>
                        <span className="chip warn">Update available</span>
                        {can && (
                          <button type="button" className="btn small" data-act="gl-update" onClick={() => setSheet('update')}>
                            Review update
                          </button>
                        )}
                      </>
                    )}
                    {o && !g && S.state.globalTerms.length > 0 && d.own && <span className="chip">Removed from global glossary</span>}
                  </div>
                </section>
              ))}
              {!own && can && (
                <div className="card">
                  <p className="note">
                    This term is defined in a spec or document. Edit it there, or add it to the glossary to manage it here (the original
                    stays untouched).
                  </p>
                  <div className="btns">
                    <button
                      className="btn small"
                      data-act="gl-adopt"
                      onClick={() => {
                        const d = t.defs[0];
                        try {
                          S.saveTerm({ term: t.term, body: d.definition, aliases: d.aliases, see: d.see });
                          toast('Added to the glossary');
                        } catch (e: any) {
                          toast(e.message);
                        }
                      }}
                    >
                      Add to glossary
                    </button>
                  </div>
                </div>
              )}
              <div className="kvs">
                {aliases.length > 0 && (
                  <div className="relrow">
                    <span>Also known as</span>
                    {aliases.map((a) => (
                      <span key={a} className="gd-alias">
                        {a}
                      </span>
                    ))}
                  </div>
                )}
                {avoid.length > 0 && (
                  <div className="relrow">
                    <span>Avoid</span>
                    {avoid.map((a) => (
                      <span key={a} className="gd-alias avoid">
                        {a}
                      </span>
                    ))}
                    <small className="muted">flagged when a spec uses it</small>
                  </div>
                )}
                {distinct.length > 0 && (
                  <div className="relrow">
                    <span>Not to be confused with</span>
                    {distinct.map((r) => (
                      <TermRef key={r} name={r} idx={idx} />
                    ))}
                  </div>
                )}
                {related.length > 0 && (
                  <div className="relrow">
                    <span>See also</span>
                    {related.map((r) => (
                      <TermRef key={r} name={r} idx={idx} />
                    ))}
                  </div>
                )}
                {referencedBy.length > 0 && (
                  <div className="relrow">
                    <span>Referenced by</span>
                    {referencedBy.map((r) => (
                      <TermRef key={r} name={r} idx={idx} />
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
          {tab === 'used' && (
            <section className="list-card" aria-label="Used in">
              {used.map((u) => (
                <Link key={u.item.id} className="row" to={`/${u.item.kind}/${encodeURIComponent(u.item.id)}`}>
                  <div className="row-top">
                    <span className="row-title mono">{u.item.id}</span>
                    {u.item.kind === 'spec' && <span className="muted">{u.item.title}</span>}
                  </div>
                  <div className="row-meta">
                    <span className="gl-ex">{u.line}</span>
                  </div>
                </Link>
              ))}
              {!used.length && <div className="empty">No spec or document uses “{t.term}” yet.</div>}
            </section>
          )}
          {tab === 'history' && own && <History path={own.item.id} />}
        </div>
      </div>
      {sheet === 'delete' && own && (
        <DeleteSheet path={own.item.id} term={t.term} onClose={() => setSheet(null)} onDone={() => nav('/glossary')} />
      )}
      {sheet === 'update' && own && g && <UpdateSheet path={own.item.id} g={g} onClose={() => setSheet(null)} />}
    </div>
  );
}

/** Editing one term file: name, folder, the definition in the block editor, synonyms and related terms. A rename can rewrite every reference. */
function TermEdit({
  path,
  onDone,
  title = 'Edit term',
  proposal,
}: {
  path: string;
  onDone: (term?: string) => void;
  title?: string;
  proposal?: boolean;
}) {
  const S = useStore();
  const it = S.get(path)!;
  const orig = useMemo(() => parseTermFile(it.body)!, [path]); // eslint-disable-line react-hooks/exhaustive-deps
  const [term, setTerm] = useState(orig.term);
  const [folder, setFolder] = useState(proposal ? (orig.folder ?? '') : termFolder(path));
  const [body, setBody] = useState(orig.body);
  const [aliases, setAliases] = useState(orig.aliases);
  const [avoid, setAvoid] = useState(orig.avoid);
  const [distinct, setDistinct] = useState(orig.distinct);
  const [see, setSee] = useState(orig.see);
  const [updateRefs, setUpdateRefs] = useState(true);
  const [keepAlias, setKeepAlias] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  registerTermLookup(S);
  const names = glossaryTerms(S).map((t) => t.term);
  const renamed = !proposal && term.trim() && term.trim() !== orig.term;
  const refs = renamed ? S.referencesTo(orig.term, path) : [];
  const nRefs = refs.reduce((n, r) => n + r.n, 0);
  function save() {
    try {
      const t = { term, body, aliases, avoid, distinct, see, folder };
      if (proposal) {
        S.acceptProposed(path, folder, t);
        toast(`“${term.trim()}” accepted`);
      } else {
        S.saveTerm(t, { path, updateRefs: updateRefs && nRefs > 0, keepAlias });
        toast(renamed && updateRefs && nRefs ? `Term saved · ${nRefs} reference${nRefs === 1 ? '' : 's'} updated` : 'Term saved');
      }
      onDone(term.trim());
    } catch (e: any) {
      setErr(e.message);
    }
  }
  return (
    <div className="gdetail" id="glDetail">
      <header className="bar">
        <button className="icon-btn back" data-act="gl-cancel" aria-label="Cancel" onClick={() => onDone()}>
          <Icon name="back" />
        </button>
        <h1>{title}</h1>
        <button className="btn primary" data-act="gl-save" onClick={save}>
          {proposal ? 'Accept' : 'Done'}
        </button>
      </header>
      <div className="scroll">
        <div className="page">
          <form
            id="glEditForm"
            className="form term-form"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <div className="grid2">
              <div>
                <label className="field-lbl" htmlFor="gd-term">
                  Term
                </label>
                <input
                  id="gd-term"
                  name="term"
                  className="field"
                  value={term}
                  onChange={(e) => setTerm(e.target.value)}
                  required
                  maxLength={80}
                  autoComplete="off"
                />
              </div>
              <div>
                <label className="field-lbl" htmlFor="gd-folder">
                  Folder
                </label>
                <FolderSelect id="gd-folder" value={folder} onChange={setFolder} S={S} />
              </div>
            </div>
            {renamed && nRefs > 0 && (
              <div className="rename-note card" data-rename>
                <Icon name="link" size={18} />
                <div className="grow">
                  <b>Renamed from “{orig.term}”</b>
                  <span>
                    {nRefs} reference{nRefs === 1 ? '' : 's'} in {refs.length} item{refs.length === 1 ? '' : 's'} point
                    {nRefs === 1 ? 's' : ''} to the old name (
                    {refs
                      .slice(0, 4)
                      .map((r) => parseTermFile(r.item.body)?.term ?? r.item.id)
                      .join(', ')}
                    {refs.length > 4 ? ' …' : ''}).
                  </span>
                  <label className="chk">
                    <input type="checkbox" checked={updateRefs} onChange={(e) => setUpdateRefs(e.target.checked)} />
                    Update the {nRefs} reference{nRefs === 1 ? '' : 's'}
                  </label>
                  <label className="chk">
                    <input type="checkbox" checked={keepAlias} onChange={(e) => setKeepAlias(e.target.checked)} />
                    Keep “{orig.term}” as a synonym
                  </label>
                </div>
              </div>
            )}
            <DefinitionEditor docKey={`term|${path}`} value={body} onChange={setBody} terms={names.filter((n) => n !== orig.term)} />
            <div className="grid2">
              <TokenField id="gd-aliases" label="Also known as" value={aliases} onChange={setAliases} placeholder="Synonyms" />
              <TokenField
                id="gd-avoid"
                label="Avoid · flagged when a spec uses it"
                value={avoid}
                onChange={setAvoid}
                placeholder="Words not to use"
              />
              <TokenField
                id="gd-distinct"
                label="Not to be confused with"
                value={distinct}
                onChange={setDistinct}
                placeholder="Terms"
                suggest={names}
              />
              <TokenField id="gd-see" label="See also" value={see} onChange={setSee} placeholder="Related terms" suggest={names} />
            </div>
            <LookupPanel term={() => term} onUse={(text) => setBody((b) => (b.trim() ? `${b.trim()}\n\n${text}` : text))} />
            {orig.origin && (
              <p className="note">Imported from the global glossary. Your changes stay local; Health offers newer revisions.</p>
            )}
            <FormError msg={err} />
            <div className="btns only-phone">
              <button type="submit" className="btn primary">
                {proposal ? 'Accept' : 'Done'}
              </button>
              <button type="button" className="btn" onClick={() => onDone()}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

function ProposedDetail({ path }: { path: string }) {
  const S = useStore();
  const nav = useNavigate();
  const [editing, setEditing] = useState(false);
  const [folder, setFolder] = useState<string | null>(null);
  const it = S.get(path);
  const t = it && parseTermFile(it.body);
  const all = glossaryTerms(S);
  const idx = termIndex(all);
  if (!it || !t)
    return (
      <div className="gdetail" id="glDetail">
        <header className="bar">
          <Link className="icon-btn back" to="/glossary" aria-label="Back">
            <Icon name="back" />
          </Link>
          <h1>Not found</h1>
        </header>
        <div className="scroll">
          <div className="page">
            <p>This proposal was accepted or declined.</p>
          </div>
        </div>
      </div>
    );
  const approver = S.can('approve');
  const f = folder ?? t.folder ?? '';
  if (editing && approver)
    return (
      <TermEdit
        path={path}
        proposal
        title="Edit and accept"
        onDone={(term) => {
          setEditing(false);
          if (term) nav(glossaryPath(term));
        }}
      />
    );
  function accept() {
    try {
      S.acceptProposed(path, f);
      toast(`“${t!.term}” accepted`);
      nav(glossaryPath(t!.term));
    } catch (e: any) {
      toast(e.message);
    }
  }
  return (
    <div className="gdetail" id="glDetail">
      <header className="bar">
        <Link className="icon-btn back" to="/glossary" aria-label="Back">
          <Icon name="back" />
        </Link>
        <h1>{t.term}</h1>
        <span className="chip">
          <Icon name="agent" size={12} />
          Proposed{t.proposedBy ? ` by ${t.proposedBy}` : ''}
        </span>
      </header>
      <div className="gd-meta">
        {t.from ? (
          <>
            From <span className="mono">{t.from}</span> ·{' '}
          </>
        ) : null}
        {it.updatedAt ? ago(Date.parse(it.updatedAt)) : ''}
      </div>
      <div className="scroll">
        <div className="page gd">
          <section className="gd-def">
            <Md text={t.body} idx={idx} />
          </section>
          <div className="kvs">
            {t.aliases.length > 0 && (
              <div className="relrow">
                <span>Also known as</span>
                {t.aliases.map((a) => (
                  <span key={a} className="gd-alias">
                    {a}
                  </span>
                ))}
              </div>
            )}
            {t.avoid.length > 0 && (
              <div className="relrow">
                <span>Avoid</span>
                {t.avoid.map((a) => (
                  <span key={a} className="gd-alias avoid">
                    {a}
                  </span>
                ))}
              </div>
            )}
            {t.see.length > 0 && (
              <div className="relrow">
                <span>See also</span>
                {t.see.map((r) => (
                  <TermRef key={r} name={r} idx={idx} />
                ))}
              </div>
            )}
          </div>
          {approver ? (
            <>
              <div>
                <label className="field-lbl" htmlFor="pr-folder">
                  Accept into folder
                </label>
                <FolderSelect id="pr-folder" value={f} onChange={setFolder} S={S} />
              </div>
              <div className="btns">
                <button className="btn primary" data-act="pr-accept" onClick={accept}>
                  Accept
                </button>
                <button className="btn" data-act="pr-edit" onClick={() => setEditing(true)}>
                  Edit first
                </button>
                <button
                  className="btn ghost"
                  data-act="pr-decline"
                  onClick={() => {
                    S.declineProposed(path);
                    toast(`“${t.term}” declined`);
                    nav('/glossary');
                  }}
                >
                  Decline
                </button>
              </div>
            </>
          ) : (
            <p className="note">An approver accepts or declines proposed terms. Nothing reaches agents before that.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function HealthDetail({ id }: { id: string }) {
  const S = useStore();
  const nav = useNavigate();
  const [choice, setChoice] = useState('glossary');
  const [newName, setNewName] = useState('');
  const [sheet, setSheet] = useState<null | 'define' | 'update'>(null);
  const issue: Issue | undefined = glossaryIssues(S).find((i) => i.id === id);
  const all = glossaryTerms(S);
  const idx = termIndex(all);
  const head = (title: string, sub: string) => (
    <>
      <header className="bar">
        <Link className="icon-btn back" to="/glossary" aria-label="Back">
          <Icon name="back" />
        </Link>
        <h1>{title}</h1>
      </header>
      <div className="gd-meta">{sub}</div>
    </>
  );
  if (!issue)
    return (
      <div className="gdetail" id="glDetail">
        {head('Resolved', '')}
        <div className="scroll">
          <div className="page">
            <p>Nothing left to do here.</p>
            <div className="btns">
              <Link className="btn" to="/glossary">
                Back to the glossary
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  const t = issue.term ? all.find((x) => x.term.toLowerCase() === issue.term!.toLowerCase()) : undefined;
  const open = issue.item ? (
    <Link
      className="btn ghost"
      to={
        issue.item.kind === 'spec'
          ? `/spec/${encodeURIComponent(issue.item.id)}`
          : isProposedPath(issue.item.id) || !parseTermFile(issue.item.body)
            ? `/doc/${encodeURIComponent(issue.item.id)}`
            : glossaryPath(parseTermFile(issue.item.body)!.term)
      }
    >
      Open {issue.item.kind === 'spec' ? issue.item.id : (parseTermFile(issue.item.body)?.term ?? issue.item.id)}
    </Link>
  ) : null;
  let body: ReactElement | null = null;
  if (issue.kind === 'conflict' && t) {
    const own = t.defs.find((d) => d.own);
    const others = t.defs.filter((d) => d !== own);
    const resolve = () => {
      try {
        if (choice === 'glossary' || choice === 'spec') {
          if (choice === 'spec' && own)
            S.saveTerm(
              { term: t.term, body: others[0].definition, aliases: own.aliases, avoid: own.avoid, distinct: own.distinct, see: own.see },
              { path: own.item.id },
            );
          if (choice === 'spec' && !own)
            S.saveTerm({ term: t.term, body: others[0].definition, aliases: others[0].aliases, see: others[0].see });
          for (const d of others) S.edit(d.item.id, { body: S.dropDefinition(d.item.body, t.term) });
        } else {
          const name = newName.trim();
          if (!name) throw new Error('Name the other term');
          for (const d of others) S.edit(d.item.id, { body: S.renameDefinition(d.item.body, t.term, name) });
        }
        toast('Resolved');
        nav(glossaryPath(choice === 'two' ? newName.trim() : t.term));
      } catch (e: any) {
        toast(e.message);
      }
    };
    body = (
      <>
        <div className="cmp">
          {t.defs.map((d, i) => (
            <div key={i} className={`card ${(choice === 'glossary' && d.own) || (choice === 'spec' && !d.own) ? 'sel' : ''}`}>
              <span className="cap mono">
                {d.item.id}
                {d.own ? '' : ` · ${d.item.kind === 'spec' ? 'definition block' : 'document'}`}
              </span>
              <Md text={d.definition} idx={idx} />
            </div>
          ))}
        </div>
        <div className="card pad">
          <b>How to resolve</b>
          <div className="opts">
            {own && (
              <label className={`opt ${choice === 'glossary' ? 'on' : ''}`}>
                <input type="radio" name="res" checked={choice === 'glossary'} onChange={() => setChoice('glossary')} />
                <span>
                  Keep the glossary definition
                  <small>The other definition{others.length > 1 ? 's are' : ' is'} removed; the spec keeps using the term</small>
                </span>
              </label>
            )}
            <label className={`opt ${choice === 'spec' ? 'on' : ''}`}>
              <input type="radio" name="res" checked={choice === 'spec'} onChange={() => setChoice('spec')} />
              <span>
                Use the definition from {others[0].item.id}
                <small>It becomes the glossary’s definition and is removed from {others[0].item.id}</small>
              </span>
            </label>
            <label className={`opt ${choice === 'two' ? 'on' : ''}`}>
              <input type="radio" name="res" checked={choice === 'two'} onChange={() => setChoice('two')} />
              <span>
                They are two terms<small>Rename the other definition</small>
              </span>
            </label>
            {choice === 'two' && (
              <input
                className="field"
                aria-label="Name of the other term"
                placeholder="e.g. Payment finality"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            )}
          </div>
          <div className="btns">
            <button className="btn primary" data-act="health-resolve" onClick={resolve}>
              Resolve
            </button>
            {open}
          </div>
        </div>
      </>
    );
  } else if (issue.kind === 'broken') {
    body = (
      <div className="card pad">
        <p>
          “{issue.title}” is referenced {issue.detail.replace(/ – not defined$/, '')} but the glossary has no such term.
        </p>
        <div className="btns">
          <button className="btn primary" data-act="health-define" onClick={() => setSheet('define')}>
            Define “{issue.title}”
          </button>
          {open}
        </div>
      </div>
    );
  } else if (issue.kind === 'avoid' && issue.item) {
    const lines = issue.item.body
      .split('\n')
      .filter((l) => l.toLowerCase().includes(issue.word!.toLowerCase()))
      .slice(0, 4);
    body = (
      <div className="card pad">
        <p>
          {issue.item.id} uses “{issue.word}”, a word to avoid. The glossary’s word is <TermRef name={issue.term!} idx={idx} />.
        </p>
        {lines.map((l, i) => (
          <div key={i} className="quote-line">
            {plain(l)}
          </div>
        ))}
        <div className="btns">
          {S.can('write') && (
            <button
              className="btn primary"
              data-act="health-replace"
              onClick={() => {
                S.edit(issue.item!.id, { body: replaceWord(issue.item!.body, issue.word!, issue.term!) });
                toast(`Replaced with “${issue.term}”`);
              }}
            >
              Replace with “{issue.term}”
            </button>
          )}
          {open}
        </div>
      </div>
    );
  } else if (issue.kind === 'alias') {
    body = (
      <div className="card pad">
        <p>
          The synonym “{issue.title}” points to two terms: {issue.detail.replace(/ both use it$/, '')}. Agents cannot tell which one is
          meant. Remove it from one of them.
        </p>
        <div className="btns">
          {issue.detail
            .replace(/ both use it$/, '')
            .split(' and ')
            .map((n) => (
              <Link key={n} className="btn" to={glossaryPath(n)}>
                Open {n}
              </Link>
            ))}
        </div>
      </div>
    );
  } else if (issue.kind === 'update' && issue.item) {
    body = (
      <div className="card pad">
        <p>{issue.detail}.</p>
        <div className="btns">
          <button className="btn primary" data-act="health-update" onClick={() => setSheet('update')}>
            Review update
          </button>
          <Link className="btn ghost" to={glossaryPath(issue.title)}>
            Open {issue.title}
          </Link>
        </div>
      </div>
    );
  } else if (issue.kind === 'unused') {
    body = (
      <div className="card pad">
        <p>
          No spec or document mentions “{issue.title}” and no term refers to it. That is fine for reference terms; otherwise consider
          deleting it.
        </p>
        <div className="btns">
          <Link className="btn" to={glossaryPath(issue.title)}>
            Open {issue.title}
          </Link>
        </div>
      </div>
    );
  }
  return (
    <div className="gdetail" id="glDetail">
      {head(issue.title, ISSUE_GROUPS.find((g) => g.kind === issue.kind)!.label + ' · ' + issue.detail)}
      <div className="scroll">
        <div className="page gd">{body}</div>
      </div>
      {sheet === 'define' && <TermSheet initial={issue.title} onClose={() => setSheet(null)} />}
      {sheet === 'update' && issue.item && <UpdateSheet path={issue.item.id} g={issue.global} onClose={() => setSheet(null)} />}
    </div>
  );
}

export function GlossaryPage() {
  const { '*': rest } = useParams();
  const arg = rest ? decodeURIComponent(rest) : undefined;
  const detail = !arg ? undefined : arg.startsWith(PROPOSED) ? (
    <ProposedDetail key={arg} path={arg.slice(PROPOSED.length)} />
  ) : arg.startsWith(HEALTH) ? (
    <HealthDetail key={arg} id={arg.slice(HEALTH.length)} />
  ) : (
    <GlossaryDetail key={arg} arg={arg} />
  );
  return <Shell active="glossary" master={<GlossaryList arg={arg} />} detail={detail} />;
}
export type { Store };
