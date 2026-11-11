import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatDefinition, splitList } from '@shared/glossary.js';
import { parseGlossaryFile } from '@shared/glossaryImport.js';
import { FormError, Sheet } from '../dialogs';
import { guard } from '../hooks';
import { initial } from '../lib';
import { Bar, Shell } from '../Shell';
import { Tabs } from '../Tabs';
import { usePref } from '../prefs';
import { Icon, ago, toast, useStore } from '../ui';
import { scopesText } from './Account';

function GTermSheet({ term, onClose, onDone }: { term?: any; onClose: () => void; onDone: (terms: any[]) => void }) {
  const S = useStore();
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body = { term: f.get('term'), definition: f.get('def'), aliases: splitList(String(f.get('aliases'))), see: splitList(String(f.get('see'))) };
    try {
      const res = term?.id ? await S.api('PATCH', `/api/glossary/global/${term.id}`, body) : await S.api('POST', '/api/glossary/global', body);
      await S.loadGlobalGlossary(); onDone(res.terms); onClose(); toast(term?.id ? 'Global term updated' : 'Global term added');
    } catch (x: any) { setErr(x.message); }
  }
  return (
    <Sheet onClose={onClose}>
      <h2>{term?.id ? 'Edit global term' : 'New global term'}</h2>
      <form id="gtermForm" className="form" onSubmit={submit}>
        <label className="sr" htmlFor="gt-term">Term</label><input id="gt-term" name="term" className="field" placeholder="Term" defaultValue={term?.term ?? ''} required maxLength={80} autoComplete="off" />
        <label className="sr" htmlFor="gt-def">Definition</label><textarea id="gt-def" name="def" className="field" style={{ height: 110, padding: 12 }} placeholder="Definition – reference other terms with [[Term]]" required defaultValue={term?.definition ?? ''} />
        <label className="sr" htmlFor="gt-aliases">Also known as</label><input id="gt-aliases" name="aliases" className="field" placeholder="Also known as (comma separated)" defaultValue={(term?.aliases ?? []).join(', ')} autoComplete="off" />
        <label className="sr" htmlFor="gt-see">See also</label><input id="gt-see" name="see" className="field" placeholder="See also (comma separated terms)" defaultValue={(term?.see ?? []).join(', ')} autoComplete="off" />
        <FormError msg={err} /><button className="btn primary" type="submit">{term?.id ? 'Save' : 'Add term'}</button>
      </form>
    </Sheet>
  );
}

function GFileSheet({ name, parsed, existing, onClose, onDone }: { name: string; parsed: ReturnType<typeof parseGlossaryFile>; existing: any[]; onClose: () => void; onDone: (terms: any[]) => void }) {
  const S = useStore();
  const [mode, setMode] = useState('skip');
  const [err, setErr] = useState<string | null>(null);
  const have = new Set(existing.map((g) => g.term.toLowerCase()));
  const fresh = parsed.terms.filter((t: any) => !have.has(t.term.toLowerCase())).length;
  const n = parsed.terms.length;
  async function go() {
    try {
      const res = await S.api('POST', '/api/glossary/global/import', { terms: parsed.terms, mode });
      await S.loadGlobalGlossary(); onDone(res.terms); onClose();
      const r = res.result;
      toast(`${r.created} added${r.updated ? `, ${r.updated} updated` : ''}${r.skipped ? `, ${r.skipped} skipped` : ''}${r.errors.length ? `, ${r.errors.length} rejected` : ''}`);
    } catch (x: any) { setErr(x.message); }
  }
  return (
    <Sheet onClose={onClose}>
      <h2>Import “{name}”</h2>
      <p><b>{n}</b> term{n === 1 ? '' : 's'} found: <b>{fresh}</b> new, <b>{n - fresh}</b> already in the global glossary.</p>
      {parsed.errors.length > 0 && <div className="card warn"><div className="grow"><b>{parsed.errors.length} problem{parsed.errors.length === 1 ? '' : 's'}</b><span>{parsed.errors.slice(0, 4).map((e: string, i: number) => <span key={i}>{e}<br /></span>)}{parsed.errors.length > 4 && '…'}</span></div></div>}
      <div className="gi-list">{parsed.terms.slice(0, 8).map((t: any) => <div className="gi-row" key={t.term}><span className="gi-body"><b>{t.term}{t.aliases.length > 0 && <small className="muted"> also: {t.aliases.join(', ')}</small>}</b><span>{t.definition.length > 110 ? `${t.definition.slice(0, 110)}…` : t.definition}</span></span></div>)}{n > 8 && <p className="note" style={{ padding: '8px 4px' }}>…and {n - 8} more</p>}</div>
      <fieldset className="check-group"><legend className="sr">If a term already exists</legend>
        <label className="check"><input type="radio" name="gmode" value="skip" checked={mode === 'skip'} onChange={() => setMode('skip')} /> Keep existing terms (skip duplicates)</label>
        <label className="check"><input type="radio" name="gmode" value="update" checked={mode === 'update'} onChange={() => setMode('update')} /> Update existing terms from the file</label></fieldset>
      <FormError msg={err} /><button className="btn primary" data-act="do-gfile" disabled={!n} onClick={go}>Import {n} term{n === 1 ? '' : 's'}</button>
    </Sheet>
  );
}

export function AdminPage() {
  const S = useStore(); const nav = useNavigate();
  const [users, setUsers] = useState<any[] | null>(null);
  const [teams, setTeams] = useState<any[] | null>(null);
  const [mail, setMail] = useState<any>(null);
  const [tab, setTab] = usePref<'teams' | 'accounts' | 'glossary' | 'email'>('tab-admin', 'teams', ['teams', 'accounts', 'glossary', 'email']);
  const [gl, setGl] = useState<any[] | null>(null);
  const [open, setOpen] = useState<Record<string, any>>({});
  const [sheet, setSheet] = useState<null | { t: 'gterm'; term?: any } | { t: 'gfile'; name: string; parsed: any }>(null);
  const file = useRef<HTMLInputElement>(null);
  const me = S.state.me!;
  const load = async () => {
    try {
      const [u, t, g] = await Promise.all([S.api('GET', '/api/users'), S.api('GET', '/api/admin/teams'), S.api('GET', '/api/glossary/global')]);
      setUsers(u.users); setTeams(t.teams); setMail(t.mail); setGl(g.terms);
    } catch (e: any) { setUsers([]); setTeams([]); toast(e.message); }
  };
  useEffect(() => { if (!S.isInstanceAdmin()) { nav('/account'); return; } load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const reloadTokens = async (id: string) => setOpen({ ...open, [id]: await S.api('GET', `/api/users/${id}/tokens`) });
  const danger = { color: 'var(--red)', borderColor: 'var(--red-line)' };

  async function pickFile(f?: File | null) {
    if (!f) return;
    if (f.size > 1_000_000) return toast('The file is larger than 1 MB');
    setSheet({ t: 'gfile', name: f.name, parsed: parseGlossaryFile(f.name, await f.text()) });
  }
  function exportMd() {
    const md = (gl ?? []).map((g) => formatDefinition(g.term, g.definition, { aliases: g.aliases, see: g.see })).join('\n\n') + '\n';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' })); a.download = 'global-glossary.md'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  return (
    <Shell single master={<>
      <Bar title="Admin" />
      <Tabs label="Instance administration" value={tab} onChange={(v) => setTab(v as typeof tab)} tabs={[{ id: 'teams', label: 'Teams', badge: teams ? teams.length : '' }, { id: 'accounts', label: 'Accounts', badge: users ? users.length : '' }, { id: 'glossary', label: 'Glossary' }, { id: 'email', label: 'E-mail' }]} />
      <div className="scroll"><div className="page" id="tabpanel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        <p className="note" style={{ margin: 0 }}>People join teams by invitation from a team admin. Here you manage teams and accounts across the whole instance.</p>
        {tab === 'email' && <><section className="card"><div className="card-head"><h2>E-mail</h2>{mail && <span className={`chip ${mail.enabled ? 'ok' : 'warn'}`}>{mail.enabled ? 'configured' : 'not configured'}</span>}</div>
          <p className="note">{mail?.enabled ? <>Invitations are sent from <span className="mono">{mail.from}</span> via <span className="mono">{mail.host}</span>.</> : <>Set <span className="mono">SMTP_URL</span> (and <span className="mono">SMTP_FROM</span>) on the server to send invitations by e-mail. Until then team admins copy the invitation link.</>}</p>
          {mail?.enabled && <div className="btns"><button className="btn small" data-act="mail-test" onClick={guard(async () => { await S.api('POST', '/api/admin/mail/test'); toast(`Test e-mail sent to ${me.email}`); })}>Send test e-mail to {me.email}</button></div>}</section></>}
        {tab === 'glossary' && <><section className="card"><div className="card-head"><h2>Global glossary</h2>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}><button className="btn small" data-act="gfile-pick" onClick={() => file.current?.click()}>Import file…</button><button className="btn small" data-act="gterm-export" disabled={!gl?.length} onClick={exportMd}>Export</button><button className="btn small" data-act="gterm-new" onClick={() => setSheet({ t: 'gterm' })}><Icon name="plus" size={14} /> New term</button></div>
          <input type="file" id="gfile" ref={file} accept=".csv,.tsv,.json,.md,.markdown,.txt" hidden aria-label="Glossary file" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; pickFile(f); }} /></div>
          <p className="note">Terms every team can import into its own glossary. Teams keep their own copy and see “Update available” when you change a term here. Import a file with <span className="mono">term, definition, aliases, see</span> columns (CSV), a JSON list, or a Markdown definition list.</p>
          {gl ? (gl.length ? gl.map((g) => <div className="rel" style={{ padding: '10px 0' }} key={g.id}><div className="grow"><b>{g.term}{g.aliases.length > 0 && <small className="muted"> also: {g.aliases.join(', ')}</small>} <span className="chip">rev {g.rev}</span></b><span>{g.definition.length > 160 ? `${g.definition.slice(0, 160)}…` : g.definition}</span></div>
            <button className="btn small" data-act="gterm-edit" onClick={() => setSheet({ t: 'gterm', term: g })}>Edit</button>
            <button className="btn small" data-act="gterm-delete" style={danger} onClick={guard(async () => { if (!confirm(`Delete “${g.term}” from the global glossary? Copies in team glossaries stay as they are.`)) return; const r = await S.api('DELETE', `/api/glossary/global/${g.id}`); setGl(r.terms); await S.loadGlobalGlossary(); })}>Delete</button></div>) : <div className="muted" style={{ fontSize: 13 }}>No global terms yet.</div>) : <div className="muted">Loading…</div>}</section></>}
        {tab === 'teams' && <><section className="card"><div className="card-head"><h2>Teams</h2><small className="muted">{teams ? teams.length : '…'}</small></div>
          {teams ? teams.map((t) => <div className="user" key={t.id}><div className="user-main"><span className="ws-av">{initial(t.name)}</span><div className="grow"><b>{t.name} <span className="chip">{t.key}</span></b><span className="muted">{t.members} member{t.members === 1 ? '' : 's'} · {t.items} item{t.items === 1 ? '' : 's'}{t.gitUrl ? ' · git connected' : ''}{t.createdBy ? ` · created by ${t.createdBy}` : ''}</span></div></div>
            <div className="user-actions">
              <button className="btn small" data-act="admin-open-team" onClick={guard(async () => { await S.refreshMe(t.id); nav('/'); })}>Open</button>
              <button className="btn small" data-act="admin-rename-team" onClick={guard(async () => { const n = prompt('New team name'); if (!n) return; await S.api('PATCH', `/api/teams/${t.id}`, { name: n }); await S.refreshMe(); await load(); })}>Rename</button>
              <button className="btn small" data-act="admin-delete-team" style={danger} onClick={guard(async () => { const key = prompt(`Delete this team with all its specs, documents, Git repository and agent tokens?\nType the team key (${t.key}) to confirm.`); if (!key) return; await S.api('DELETE', `/api/teams/${t.id}`, { confirmKey: key }); S.state.maps.delete(t.id); await S.refreshMe(); toast('Team deleted'); await load(); })}>Delete…</button></div></div>) : <div className="muted">Loading…</div>}</section></>}
        {tab === 'accounts' && <><section><div className="sect-title"><span>Accounts</span><small>{users ? users.length : '…'}</small></div>
          {users ? users.map((u) => (
            <div className={`user ${u.disabled ? 'off' : ''}`} key={u.id}>
              <div className="user-main"><span className="avatar">{u.name[0].toUpperCase()}</span><div className="grow"><b>{u.name}{u.id === me.id && <> <span className="chip">you</span></>}{u.admin && <> <span className="chip ok">instance admin</span></>}{u.sso && <> <span className="chip">SSO</span></>}{u.disabled && <> <span className="chip warn">disabled</span></>}</b><span className="muted">{u.email}</span>
                <span className="muted">{u.teams.length ? u.teams.map((t: any) => `${t.name} (${t.role})`).join(' · ') : 'no team'}</span></div></div>
              <div className="user-actions">
                <button className="btn small" data-act="user-tokens" onClick={guard(async () => { if (open[u.id]) { const n = { ...open }; delete n[u.id]; setOpen(n); } else await reloadTokens(u.id); })}><Icon name="key" size={14} /> {u.tokens} token{u.tokens === 1 ? '' : 's'} · {u.connections} app{u.connections === 1 ? '' : 's'}</button>
                <button className="btn small" data-act="user-admin" onClick={guard(async () => { await S.api('PATCH', `/api/users/${u.id}`, { admin: !u.admin }); await load(); })}>{u.admin ? 'Remove admin' : 'Make admin'}</button>
                <button className="btn small" data-act="user-pw" onClick={guard(async () => { const pw = prompt('New password for this user (min. 10 characters)'); if (!pw) return; await S.api('PATCH', `/api/users/${u.id}`, { password: pw }); toast('Password reset'); })}>Reset password</button>
                <button className="btn small" data-act="user-toggle" onClick={guard(async () => { await S.api('PATCH', `/api/users/${u.id}`, { disabled: !u.disabled }); await load(); })}>{u.disabled ? 'Enable' : 'Disable'}</button>
                {u.id !== me.id && <button className="btn small" data-act="user-delete" style={danger} onClick={guard(async () => { if (!confirm(`Delete the account ${u.email}? Their sessions, tokens and team memberships are removed.`)) return; await S.api('DELETE', `/api/users/${u.id}`); toast('Account deleted'); await load(); })}>Delete</button>}</div>
              {open[u.id] && <div className="user-tokens">
                {open[u.id].tokens.map((k: any) => <div className="rel" style={{ padding: '8px 0' }} key={k.id}><div className="grow"><b>{k.name}</b><span className="mono">{k.teamName} · {k.prefix}… · {scopesText(k.scopes)} · {k.lastUsedAt ? `used ${ago(Date.parse(k.lastUsedAt))}` : 'never used'}</span></div><button className="btn small" onClick={guard(async () => { await S.api('DELETE', `/api/users/${u.id}/tokens/${k.id}`); await reloadTokens(u.id); await load(); })}>Revoke</button></div>)}
                {open[u.id].connections.map((c: any) => <div className="rel" style={{ padding: '8px 0' }} key={c.id}><div className="grow"><b>{c.clientName}</b><span>OAuth · {c.teamName} · {scopesText(c.scopes)}</span></div><button className="btn small" onClick={guard(async () => { await S.api('DELETE', `/api/users/${u.id}/connections/${c.id}`); await reloadTokens(u.id); await load(); })}>Disconnect</button></div>)}
                {!open[u.id].tokens.length && !open[u.id].connections.length && <div className="muted" style={{ fontSize: 13 }}>No tokens or connected apps.</div>}</div>}
            </div>)) : <div className="muted">Loading…</div>}</section></>}
      </div></div>
      {sheet?.t === 'gterm' && <GTermSheet term={sheet.term} onClose={() => setSheet(null)} onDone={setGl} />}
      {sheet?.t === 'gfile' && <GFileSheet name={sheet.name} parsed={sheet.parsed} existing={gl ?? []} onClose={() => setSheet(null)} onDone={setGl} />}
    </>} />
  );
}
