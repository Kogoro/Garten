import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { FormError, Sheet } from './dialogs';
import { Icon, toast, useStore } from './ui';
import { useUi } from './state';
import { specBody, titleOf } from './derive';

type Done = () => void;

export function CreateTeamSheet({ onClose }: { onClose: Done }) {
  const S = useStore(); const nav = useNavigate();
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    try { await S.createTeam(String(new FormData(e.currentTarget).get('name'))); onClose(); nav('/'); toast('Team created'); } catch (x: any) { setErr(x.message); }
  }
  return (
    <Sheet onClose={onClose}>
      <h2>Create a team</h2>
      <p>A team has its own specs, documents, glossary, Git repository and agent access. You become its admin and can invite colleagues.</p>
      <form id="createTeamForm" className="form" onSubmit={submit}>
        <label className="sr" htmlFor="newteam">Team name</label><input id="newteam" name="name" className="field" placeholder="Team name, e.g. Payments" maxLength={80} required />
        <FormError msg={err} /><button className="btn primary" type="submit">Create team</button>
      </form>
    </Sheet>
  );
}

export function ReloginSheet({ onClose }: { onClose: Done }) {
  const S = useStore();
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try { await S.login(String(f.get('email')), String(f.get('password'))); onClose(); } catch (x: any) { setErr(x.message); }
  }
  const oidc = S.state.authConfig?.oidc;
  return (
    <Sheet onClose={onClose}>
      <h2>Sign in again</h2>
      <p>Your session expired. Your local changes are safe and will sync after you sign in.</p>
      <form id="reloginForm" className="form" onSubmit={submit}>
        <label className="sr" htmlFor="rl-email">E-mail</label><input id="rl-email" name="email" className="field" type="email" defaultValue={S.state.me?.email} autoComplete="username" required />
        <label className="sr" htmlFor="rl-pw">Password</label><input id="rl-pw" name="password" className="field" type="password" placeholder="Password" autoComplete="current-password" required />
        <FormError msg={err} /><button className="btn primary" type="submit">Sign in</button>
        {oidc && <a className="btn" href={`/auth/oidc/login?next=${encodeURIComponent(location.pathname + location.hash)}`}>{oidc.name}</a>}
      </form>
    </Sheet>
  );
}

export function NewSpecSheet({ onClose }: { onClose: Done }) {
  const S = useStore(); const nav = useNavigate();
  const { lastType, set } = useUi();
  const pick = (key: string) => { const s = S.createSpec(key); const { [s.id]: _drop, ...modes } = useUi.getState().modes; set({ lastType: key, modes }); onClose(); nav(`/spec/${encodeURIComponent(s.id)}`); setTimeout(() => document.getElementById('title')?.focus(), 80); };
  return (
    <Sheet onClose={onClose}>
      <h2>New spec</h2>
      <p>Pick a type – it decides the starting structure. You can change the type later; the content stays.</p>
      <div className="typelist">{S.specTypes().map((t) => <button key={t.key} type="button" className={`typeopt ${t.key === lastType ? 'current' : ''}`} onClick={() => pick(t.key)}><b>{t.label}</b><span>{t.description}</span></button>)}</div>
    </Sheet>
  );
}

/** New spec from a selection or a whole document: pick the type and the title, the text becomes the body (plus a SOURCE section). */
export function DeriveSpecSheet({ text, source, whole, onClose }: { text: string; source: string; whole: boolean; onClose: Done }) {
  const S = useStore(); const nav = useNavigate();
  const { lastType, set } = useUi();
  const [title, setTitle] = useState(() => titleOf(text, source));
  const pick = (key: string) => {
    const s = S.createSpec(key);
    S.edit(s.id, { title: title.trim(), body: specBody(text, source) });
    const { [s.id]: _drop, ...modes } = useUi.getState().modes; set({ lastType: key, modes: { ...modes, [s.id]: 'blocks' } });
    onClose(); nav(`/spec/${encodeURIComponent(s.id)}`); toast('Spec draft created – review it before approving');
  };
  return (
    <Sheet onClose={onClose}>
      <h2>New spec from {whole ? 'this document' : 'the selection'}</h2>
      <p>The text of <span className="mono">{source}</span> is copied into a new draft ({text.length > 400 ? `${Math.round(text.length / 100) / 10}k characters` : `${text.length} characters`}); the original stays unchanged. Pick a type.</p>
      <label className="sr" htmlFor="derivetitle">Title</label><input id="derivetitle" className="field" value={title} placeholder="Spec title" autoComplete="off" onChange={(e) => setTitle(e.target.value)} />
      <div className="typelist">{S.specTypes().map((t) => <button key={t.key} type="button" className={`typeopt ${t.key === lastType ? 'current' : ''}`} onClick={() => pick(t.key)}><b>{t.label}</b><span>{t.description}</span></button>)}</div>
    </Sheet>
  );
}

export type PathSheetKind = 'newdoc' | 'move' | 'newfolder' | 'renamefolder';
const TITLES = { newdoc: 'New document', move: 'Move / rename document', newfolder: 'New folder with README.md', renamefolder: 'Rename / move folder' };
/** One path dialog for documents and folders. `from` = existing id (move / rename), `linkTo` = spec to link a new document to. */
export function PathSheet({ kind, value = '', from, linkTo, onClose }: { kind: PathSheetKind; value?: string; from?: string; linkTo?: string; onClose: Done }) {
  const S = useStore(); const nav = useNavigate(); const ui = useUi();
  const [v, setV] = useState(value);
  const [err, setErr] = useState<string | null>(null);
  const folder = kind === 'newfolder' || kind === 'renamefolder';
  const folders = S.folderPaths();
  const help = folder
    ? kind === 'newfolder' ? <>Folder path, e.g. <span className="mono">adr</span> or <span className="mono">adr/2026</span>. A <span className="mono">README.md</span> is created inside, so the folder also exists in Git.</> : <>New folder path, e.g. <span className="mono">adr/2026</span>. Everything inside moves with it.</>
    : kind === 'move' ? <>New path, e.g. <span className="mono">adr/ADR-008.md</span>. Links in specs follow.</> : <>Path with folders, e.g. <span className="mono">adr/ADR-008.md</span> (md, yaml, yml, json or txt).</>;
  function go() {
    try {
      if (kind === 'newdoc') {
        const d = S.createDoc(v); ui.set({ lastFolder: S.folderOf(d.id) });
        if (linkTo) S.toggleLink(linkTo, d.id);
        onClose();
        if (!linkTo) nav(`/doc/${encodeURIComponent(d.id)}`); else toast(`${d.id} created and linked`);
      } else if (kind === 'move') { const d = S.moveDoc(from!, v); onClose(); nav(`/doc/${encodeURIComponent(d.id)}`); toast('Moved'); }
      else if (kind === 'newfolder') {
        const f = S.createFolder(v);
        const readme = S.createDoc(`${f.id}/README.md`, `# ${S.baseName(f.id)}\n\n`); // Git cannot hold empty folders
        ui.set({ openFolders: { ...ui.openFolders, [f.id]: true }, lastFolder: f.id }); onClose();
        nav(`/doc/${encodeURIComponent(readme.id)}`); toast(`Folder ${f.id} created with README.md`);
      } else { S.moveFolder(from!, v); onClose(); toast('Folder moved'); }
    } catch (x: any) { setErr(x.message); }
  }
  return (
    <Sheet onClose={onClose}>
      <h2>{TITLES[kind]}</h2>
      <p>{help}</p>
      <label className="sr" htmlFor="docname">Path</label>
      <input id="docname" className="field mono" autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder={folder ? 'folder/subfolder' : 'folder/name.md'} value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} />
      {folders.length > 0 && <div className="chips">{folders.map((f) => <button key={f} type="button" className="doc-chip" onClick={() => setV(folder ? `${f}/` : `${f}/${v.split('/').pop()}`)}><Icon name="folder" size={14} />&nbsp;{f}/</button>)}</div>}
      <FormError msg={err} />
      <button className="btn primary" data-act={{ newdoc: 'create-doc', move: 'do-move', newfolder: 'create-folder', renamefolder: 'do-rename-folder' }[kind]} onClick={go}>{kind === 'move' || kind === 'renamefolder' ? 'Move' : 'Create'}</button>
    </Sheet>
  );
}

/** Link documents to a spec (toggle) – also used for "@" references. */
export function LinkSheet({ specId, onClose, onPick }: { specId: string; onClose: Done; onPick?: (docId: string) => void }) {
  const S = useStore();
  const [newDoc, setNewDoc] = useState(false);
  const spec = S.get(specId);
  if (!spec) return null;
  if (newDoc) return <PathSheet kind="newdoc" linkTo={specId} onClose={onClose} />;
  const ref = !!onPick;
  const docs = S.all('doc').filter((d) => !d.pinned || ref || spec.links.includes(d.id)).sort((a, b) => a.id.localeCompare(b.id));
  return (
    <Sheet onClose={onClose}>
      <h2>{ref ? 'Reference a document' : 'Linked documents'}</h2>
      <p>{ref ? 'Inserts an @reference at the cursor and links the document to this spec.' : 'Linked documents are released together with this spec. Foundation documents (vision, strategy, glossary) are always available to agents and need no link.'}</p>
      {docs.length ? docs.map((d) => <button key={d.id} type="button" className="pick" aria-pressed={spec.links.includes(d.id)} onClick={() => { if (ref) { if (!spec.links.includes(d.id)) S.toggleLink(specId, d.id); onPick!(d.id); onClose(); } else S.toggleLink(specId, d.id); }}><span className="box">{spec.links.includes(d.id) ? '✓' : ''}</span>{d.id}</button>) : <p>No documents yet.</p>}
      <button className="btn" onClick={() => setNewDoc(true)}><Icon name="plus" size={14} /> New document</button>
    </Sheet>
  );
}

export function ConflictSheet({ id, onClose }: { id: string; onClose: Done }) {
  const S = useStore();
  const it = S.get(id) ?? S.state.items.get(id);
  const srv = it?.conflict;
  if (!it || !srv) return null;
  const pick = (c: 'mine' | 'server') => { S.resolveConflict(id, c); onClose(); toast(c === 'mine' ? 'Kept your version' : 'Server version restored'); };
  return (
    <Sheet onClose={onClose}>
      <h2>Conflict in {it.id}</h2>
      <p>{srv.deleted ? 'It was deleted on the server' : `This was changed on the server (revision ${srv.rev}${srv.updatedBy ? ` by ${srv.updatedBy}` : ''})`} and changed on this device. Choose which version to keep.</p>
      <div className="diff"><h3>This device</h3><pre>{(it.kind === 'spec' ? `${it.title}\n\n` : '') + it.body}</pre></div>
      {!srv.deleted && <div className="diff"><h3>Server</h3><pre>{(it.kind === 'spec' ? `${srv.title}\n\n` : '') + srv.body}</pre></div>}
      <div className="btns"><button className="btn primary" data-act="keep-mine" onClick={() => pick('mine')}>Keep mine</button><button className="btn" onClick={() => pick('server')}>{srv.deleted ? 'Discard (delete)' : 'Use server'}</button></div>
    </Sheet>
  );
}
