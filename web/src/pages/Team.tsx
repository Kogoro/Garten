import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { FormError, Sheet } from '../dialogs';
import { guard, useTeamInfo } from '../hooks';
import { Bar, Shell } from '../Shell';
import { Icon, ago, copy, toast, useStore } from '../ui';
import { FIELD_KINDS, KIND_LABELS } from '@shared/specForm.js';
import { ROLES, RIGHTS, ROLE_RIGHTS } from './Account';

type Store = ReturnType<typeof useStore>;

function TypeSheet({ type, onClose, onDone }: { type?: any; onClose: () => void; onDone: () => void }) {
  const S = useStore();
  const [err, setErr] = useState<string | null>(null);
  const [tpl, setTpl] = useState(type?.template ?? '');
  const [desc, setDesc] = useState(type?.description ?? '');
  const [useForm, setUseForm] = useState(!!type?.form);
  const [formView, setFormView] = useState(type?.view === 'form');
  const [tabsText, setTabsText] = useState((type?.form?.tabs ?? []).map((t: any) => t.label).join(', '));
  const [fields, setFields] = useState<any[]>(type?.form?.fields?.map((f: any) => ({ ...f, optionsText: (f.options ?? []).join(', ') })) ?? [{ label: '', kind: 'longtext' }]);
  const setField = (i: number, p: any) => setFields(fields.map((f, k) => (k === i ? { ...f, ...p } : f)));
  const moveField = (i: number, d: number) => { const j = i + d; if (j < 0 || j >= fields.length) return; const n = [...fields]; [n[i], n[j]] = [n[j], n[i]]; setFields(n); };
  const tabLabels = tabsText.split(',').map((t: string) => t.trim()).filter(Boolean);
  const tabKey = (l: string) => l.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
  function buildForm() {
    const tabs = tabLabels.map((l: string) => ({ key: tabKey(l), label: l }));
    return { tabs, fields: fields.filter((f) => f.label.trim()).map((f) => ({ key: f.key, label: f.label, kind: f.kind, help: f.help, tab: f.tab && tabs.some((t: any) => t.key === f.tab) ? f.tab : undefined, options: f.kind === 'select' ? f.optionsText : undefined, lang: f.lang })) };
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body: any = { label: f.get('label'), description: desc, template: tpl, form: useForm ? buildForm() : null, view: useForm && formView ? 'form' : 'editor' };
    try {
      if (type?.key) await S.teamApi('PATCH', `/spec-types/${type.key}`, body); else await S.teamApi('POST', '/spec-types', body);
      await S.refreshTypes(); onClose(); onDone(); toast(type?.key ? 'Type saved' : 'Type added');
    } catch (x: any) { setErr(x.message); }
  }
  function startFrom(key: string) {
    const t: any = S.specTypes().find((x) => x.key === key);
    if (!t) return;
    setTpl(t.template); if (!desc) setDesc(t.description);
    if (t.form) { setUseForm(true); setFormView(t.view === 'form'); setTabsText((t.form.tabs ?? []).map((x: any) => x.label).join(', ')); setFields(t.form.fields.map((f: any) => ({ ...f, optionsText: (f.options ?? []).join(', ') }))); } else setUseForm(false);
  }
  return (
    <Sheet onClose={onClose}>
      <h2>{type?.key ? 'Edit spec type' : 'New spec type'}</h2>
      <p>A type gives new specs their structure: either a <b>form</b> with fields, lists and tabs, or a free-form Markdown template for the block editor.</p>
      <form id="stypeForm" className="form" onSubmit={submit}>
        <label className="sr" htmlFor="st-label">Name</label><input id="st-label" name="label" className="field" placeholder="Name, e.g. Runbook" defaultValue={type?.label ?? ''} required maxLength={40} autoComplete="off" />
        <label className="sr" htmlFor="st-desc">Description</label><input id="st-desc" className="field" placeholder="One line: what is this type for?" value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={200} autoComplete="off" />
        {!type?.key && <><label className="sr" htmlFor="st-from">Start from</label><select id="st-from" className="field" defaultValue="" onChange={(e) => startFrom(e.target.value)}><option value="">Start from scratch</option>{S.specTypes().filter((x) => x.builtin).map((x) => <option key={x.key} value={x.key}>Start from: {x.label}</option>)}</select></>}
        <label className="check"><input type="checkbox" id="st-useform" checked={useForm} onChange={(e) => setUseForm(e.target.checked)} /> Describe this type as a form (fields, lists, tabs)</label>
        {useForm ? <>
          <label className="check"><input type="checkbox" id="st-formview" checked={formView} onChange={(e) => setFormView(e.target.checked)} /> Open specs as a form (no editor); people can still switch to blocks or Markdown</label>
          <label className="sr" htmlFor="st-tabs">Tabs</label><input id="st-tabs" className="field" placeholder="Tabs, comma separated (optional), e.g. Overview, Details" value={tabsText} onChange={(e) => setTabsText(e.target.value)} autoComplete="off" />
          <div className="fb-fields" aria-label="Form fields">
            {fields.map((f, i) => (
              <div className="fb-field" key={i}>
                <input className="field" aria-label={`Field ${i + 1} label`} placeholder="Field name, e.g. TARGETS" value={f.label} maxLength={60} onChange={(e) => setField(i, { label: e.target.value })} />
                <select className="field" aria-label={`Field ${i + 1} type`} value={f.kind} onChange={(e) => setField(i, { kind: e.target.value })}>{FIELD_KINDS.map((k: string) => <option key={k} value={k}>{(KIND_LABELS as any)[k]}</option>)}</select>
                {f.kind === 'select' && <input className="field wide" aria-label={`Field ${i + 1} choices`} placeholder="Choices, comma separated" value={f.optionsText ?? ''} onChange={(e) => setField(i, { optionsText: e.target.value })} />}
                {f.kind === 'code' && <input className="field wide" aria-label={`Field ${i + 1} language`} placeholder="Language, e.g. json, sql, yaml" value={f.lang ?? ''} onChange={(e) => setField(i, { lang: e.target.value })} />}
                <input className="field wide" aria-label={`Field ${i + 1} hint`} placeholder="Hint shown under the name (optional)" value={f.help ?? ''} maxLength={200} onChange={(e) => setField(i, { help: e.target.value })} />
                {tabLabels.length > 1 && <select className="field wide" aria-label={`Field ${i + 1} tab`} value={f.tab ?? ''} onChange={(e) => setField(i, { tab: e.target.value })}><option value="">First tab</option>{tabLabels.map((l: string) => <option key={l} value={tabKey(l)}>Tab: {l}</option>)}</select>}
                <div className="fb-acts"><button type="button" className="btn small" disabled={i === 0} onClick={() => moveField(i, -1)}>↑</button><button type="button" className="btn small" disabled={i === fields.length - 1} onClick={() => moveField(i, 1)}>↓</button><button type="button" className="btn small" onClick={() => setFields(fields.filter((_, k) => k !== i))}>Remove</button></div>
              </div>
            ))}
            <button type="button" className="btn small" id="st-addfield" onClick={() => setFields([...fields, { label: '', kind: 'longtext' }])}><Icon name="plus" size={14} /> Add field</button>
          </div>
        </> : <><label className="sr" htmlFor="st-tpl">Template</label><textarea id="st-tpl" className="field mono" style={{ height: 180, padding: 12, fontSize: 13 }} placeholder={'## SECTION\n\n## ANOTHER SECTION\n'} value={tpl} onChange={(e) => setTpl(e.target.value)} /></>}
        <FormError msg={err} /><button className="btn primary" type="submit">{type?.key ? 'Save' : 'Add type'}</button>
      </form>
    </Sheet>
  );
}

function GitForm({ g, S, reload, res, setRes }: { g: any; S: Store; reload: () => Promise<void>; res: { ok: boolean; text: string } | null; setRes: (r: { ok: boolean; text: string } | null) => void }) {
  const admin = S.can('admin');
  const online = S.state.online && !S.state.sessionExpired;
  const [auth, setAuth] = useState<string>(g.auth);
  const save = guard(async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body: any = { url: f.get('url'), branch: f.get('branch'), root: f.get('root'), auth, username: f.get('user'), autoPush: f.get('auto') === 'on' };
    if (f.get('token')) body.token = f.get('token');
    setRes(null); await S.teamApi('PUT', '/git', body); toast('Git connection saved'); await reload();
  });
  const test = guard(async () => { setRes(null); const r = await S.teamApi('POST', '/git/test'); setRes({ ok: true, text: r.branchExists ? 'Connection works – the branch exists and will be merged.' : 'Connection works – the branch does not exist yet and will be created.' }); });
  const push = guard(async () => {
    toast('Pushing…');
    try { const r = await S.teamApi('POST', '/git/push'); setRes({ ok: true, text: r.warning ?? 'Pushed to the remote.' }); toast('Pushed'); } catch (x: any) { setRes({ ok: false, text: x.message }); toast('Push failed'); }
    await reload();
  });
  const keygen = guard(async () => { if (g.sshPublicKey && !confirm('Replace the existing key? The old deploy key stops working.')) return; await S.teamApi('POST', '/git/ssh-key'); toast('Key generated – add the public key as a deploy key'); await reload(); });
  const ro = !admin;
  return (
    <form id="gitForm" className="form" onSubmit={save}>
      <label className="sr" htmlFor="g-url">Repository URL</label><input className="field mono" id="g-url" name="url" defaultValue={g.url} placeholder="https://github.com/org/product.git  or  git@github.com:org/product.git" autoComplete="off" autoCapitalize="off" readOnly={ro} />
      <div className="grid2"><label className="sr" htmlFor="g-branch">Branch</label><input className="field mono" id="g-branch" name="branch" defaultValue={g.branch} placeholder="Branch" readOnly={ro} />
        <label className="sr" htmlFor="g-root">Folder</label><input className="field mono" id="g-root" name="root" defaultValue={g.root} placeholder="Folder in the repo" readOnly={ro} /></div>
      <label className="sr" htmlFor="g-auth">Authentication</label>
      <select className="field" id="g-auth" value={auth} onChange={(e) => setAuth(e.target.value)} disabled={ro}><option value="none">No authentication (public / local)</option><option value="token">HTTPS access token</option><option value="ssh">SSH deploy key</option></select>
      <div className="grid2 g-token" hidden={auth !== 'token'}><label className="sr" htmlFor="g-user">Username</label><input className="field" id="g-user" name="user" defaultValue={g.username} placeholder="Username (e.g. x-access-token)" autoComplete="off" readOnly={ro} />
        <label className="sr" htmlFor="g-token">Access token</label><input className="field" id="g-token" name="token" type="password" placeholder={g.hasSecret && g.auth === 'token' ? '•••••••• saved – type to replace' : 'Access token (write access to the repo)'} autoComplete="new-password" readOnly={ro} /></div>
      <div className="g-ssh" hidden={auth !== 'ssh'}>
        {g.sshPublicKey ? <><div className="code" aria-label="Public deploy key">{g.sshPublicKey}</div><p className="note" style={{ marginTop: 6 }}>Add this public key as a <b style={{ color: 'var(--text)' }}>deploy key with write access</b> to the repository, then save and test.</p></> : <p className="note">No key yet. Generate one and add its public half as a deploy key.</p>}
        {admin && <div className="btns" style={{ marginTop: 8 }}><button type="button" className="btn small" data-act="git-keygen" disabled={!online} onClick={keygen}><Icon name="key" size={14} /> {g.sshPublicKey ? 'Generate a new key' : 'Generate key'}</button>{g.sshPublicKey && <button type="button" className="btn small" onClick={() => copy(g.sshPublicKey)}>Copy public key</button>}</div>}
      </div>
      <label className="check"><input type="checkbox" id="g-auto" name="auto" defaultChecked={g.autoPush} disabled={ro} /> Push automatically after every approval or revoke</label>
      {g.url && (g.lastOk === false ? <span className="err-text">Last push failed: {g.lastError ?? ''}</span> : g.lastPushAt ? <span className="muted" style={{ fontSize: 13 }}>Last push {ago(Date.parse(g.lastPushAt))}{g.lastSha ? ` · ${g.lastSha.slice(0, 7)}` : ''}{g.lastError ? ` · ${g.lastError}` : ''}</span> : <span className="muted" style={{ fontSize: 13 }}>Nothing pushed yet.</span>)}
      {res && <span className={res.ok ? '' : 'err-text'} style={{ fontSize: 13, ...(res.ok ? { color: 'var(--green)' } : {}) }}>{res.text}</span>}
      {admin ? <div className="btns"><button className="btn primary" type="submit" disabled={!online}>Save</button><button type="button" className="btn" data-act="git-test" disabled={!online || !g.url} onClick={test}>Test connection</button>{S.can('approve') && <button type="button" className="btn" data-act="git-push" disabled={!online || !g.url} onClick={push}>Push now</button>}</div> : S.can('approve') && g.url && <div className="btns"><button type="button" className="btn" data-act="git-push" onClick={push}>Push now</button></div>}
      <p className="note" style={{ fontSize: 12 }}>Specs writes only inside <span className="mono">{g.root}/</span> (<span className="mono">&lt;ID&gt;.md</span>, <span className="mono">docs/</span>, <span className="mono">GLOSSARY.md</span>); everything else in your repository is left alone. If the branch already has commits they are merged in first; on conflicts in files Specs manages, Specs wins. The folder is locked after the first release.</p>
    </form>
  );
}

function FeedbackMailToggle({ t, S, mailEnabled }: { t: any; S: Store; mailEnabled: boolean }) {
  const [on, setOn] = useState(!!t.feedbackMail);
  useEffect(() => setOn(!!t.feedbackMail), [t.feedbackMail]);
  return (
    <label className="check"><input type="checkbox" id="fb-mail" disabled={!mailEnabled} checked={on} onChange={guard(async (e) => { const v = e.target.checked; setOn(v); await S.teamApi('PATCH', '', { feedbackMail: v }); await S.refreshMe(); toast(v ? 'Approvers and admins get an e-mail about new feedback' : 'Feedback e-mails are off'); })} /> E-mail approvers and admins when agents leave new feedback (one digest after a quiet period){!mailEnabled ? ' – needs a mail server' : ''}</label>
  );
}

export function TeamPage() {
  const S = useStore(); const nav = useNavigate();
  const { info: d, reload, setInfo } = useTeamInfo();
  const [invite, setInvite] = useState<any>(null);
  const [gitRes, setGitRes] = useState<{ ok: boolean; text: string } | null>(null);
  const [tsheet, setTsheet] = useState<null | { type?: any }>(null);
  const t = S.team();
  const admin = S.can('admin');
  const online = S.state.online && !S.state.sessionExpired;
  const me = S.state.me!;
  if (!t) return <Shell single master={<><Bar title="Team" /><div className="scroll"><div className="page"><p className="muted">You are not a member of any team yet.</p></div></div></>} />;
  const sendInvite = async (email: string, role: string, again = false) => {
    const res = await S.teamApi('POST', '/invites', { email, role });
    setInvite({ email: res.invite.email, link: res.link, userExists: res.userExists, emailed: res.emailed, emailError: res.emailError });
    setInfo({ ...d, invites: res.invites });
    if (again) toast(res.emailed ? `Invitation sent again to ${res.invite.email}` : res.emailError ? 'E-mail failed – copy the link' : 'New link created');
    else toast(res.emailed ? `Invitation sent to ${res.invite.email}` : res.emailError ? 'E-mail failed – copy the link' : 'Invitation created');
  };
  return (
    <Shell single master={<>
      <Bar title="Members & Git" />
      <div className="scroll"><div className="page">
        <section className="card"><div className="card-head"><h2>{t.name}</h2><span className="chip ok">{t.role}</span></div>
          <div className="kv"><span>Key <span className="muted">(prefix of spec ids)</span></span><span className="mono">{t.key}</span></div>
          {admin && <>
            <form id="teamNameForm" className="form" onSubmit={guard(async (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); await S.teamApi('PATCH', '', { name: new FormData(e.currentTarget).get('name') }); await S.refreshMe(); toast('Renamed'); })}><label className="sr" htmlFor="tm-name">Team name</label><div className="btns"><input className="field" id="tm-name" name="name" defaultValue={t.name} key={t.name} maxLength={80} style={{ flex: 3 }} /><button className="btn" type="submit" disabled={!online}>Rename</button></div></form>
            <label className="check"><input type="checkbox" id="found-auto" checked={!!t.foundationAuto} onChange={guard(async (e) => { await S.teamApi('PATCH', '', { foundationAuto: e.target.checked }); await S.refreshMe(); toast(e.target.checked ? 'Foundation documents go live automatically' : 'Foundation documents now need approval'); })} /> Publish foundation documents (vision, strategy, glossary …) automatically after edits</label>
            <p className="note" style={{ marginTop: -6 }}>Off: they reach agents only after an approver presses “Publish now”.</p>
            <FeedbackMailToggle t={t} S={S} mailEnabled={!!d?.mailEnabled} /></>}
          <div className="btns"><button className="btn small" data-act="leave-team" onClick={guard(async () => { if (!confirm(`Leave ${t.name}? You lose access to its specs and your agent tokens for it stop working.`)) return; await S.leaveTeam(); nav('/'); toast('You left the team'); })}>Leave team</button></div></section>

        <section className="card"><div className="card-head"><h2>Members</h2><small className="muted">{d ? d.members.length : '…'}</small></div>
          {d ? d.members.map((m: any) => <div className="user-main" style={{ padding: '6px 0', borderTop: '1px solid var(--line)' }} key={m.id}><span className="avatar">{m.name[0].toUpperCase()}</span><div className="grow"><b>{m.name}{m.id === me.id && <> <span className="chip">you</span></>}{m.disabled && <> <span className="chip warn">disabled</span></>}</b><span className="muted">{m.email}</span></div>
            {admin ? <><label className="sr" htmlFor={`m-${m.id}`}>Role of {m.name}</label><select className="field role" id={`m-${m.id}`} data-act="member-role" value={m.role} disabled={!online} onChange={guard(async (e) => { await S.teamApi('PATCH', `/members/${m.id}`, { role: e.target.value }); toast('Role updated – tokens of this member follow immediately'); await reload(); S.refreshMe(); })}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select>
              <button className="btn small" aria-label={`Remove ${m.name}`} onClick={guard(async () => { if (!confirm('Remove this member from the team? Their tokens for this team stop working.')) return; await S.teamApi('DELETE', `/members/${m.id}`); await reload(); S.refreshMe(); })}>Remove</button></> : <span className="chip ok">{m.role}</span>}</div>) : <div className="muted">Loading…</div>}
          {admin && <>
            <div className="sect-title" style={{ margin: '10px 0 0' }}><span>Invite people</span></div>
            <form id="inviteForm" className="form" onSubmit={guard(async (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = new FormData(e.currentTarget); await sendInvite(String(f.get('email')), String(f.get('role'))); })}>
              <div className="grid2"><label className="sr" htmlFor="inv-email">E-mail</label><input className="field" id="inv-email" name="email" type="email" placeholder="colleague@company.com" required /><label className="sr" htmlFor="inv-role">Role</label><select className="field" id="inv-role" name="role" defaultValue="editor">{ROLES.map((r) => <option key={r}>{r}</option>)}</select></div>
              <button className="btn primary" type="submit" disabled={!online}><Icon name="mail" size={16} /> {d?.mailEnabled ? 'Send invitation' : 'Create invitation'}</button>
              <p className="note">{d?.mailEnabled ? 'The invitation is sent by e-mail. You also get the one-time link in case it does not arrive.' : 'No mail server is configured: you get a one-time link to send yourself (ask an instance admin to set up e-mail).'}</p></form>
            {invite && <div className="card ok-card"><b>{invite.emailed ? `Invitation e-mailed to ${invite.email}` : `Invitation for ${invite.email}`}</b>{invite.emailError && <p className="err-text" role="alert">{invite.emailError}</p>}<p className="note" style={{ color: 'var(--soft)' }}>{invite.userExists ? 'They already have an account and will also see the invitation after signing in. ' : ''}{invite.emailed ? 'You can also send them this one-time link yourself' : 'Send them this one-time link'} (valid 7 days):</p><div className="code">{invite.link}</div><div className="btns"><button className="btn small" onClick={() => copy(invite.link)}>Copy link</button><button className="btn small" onClick={() => setInvite(null)}>Done</button></div></div>}
            {d?.invites?.length > 0 && <><div className="sect-title" style={{ margin: '6px 0 0' }}><span>Pending invitations</span><small>{d.invites.length}</small></div>{d.invites.map((i: any) => <div className="rel" style={{ padding: '8px 0' }} key={i.id}><div className="grow"><b>{i.email}</b><span>{i.role} · invited by {i.invitedBy ?? '?'} · expires {new Date(i.expiresAt).toLocaleDateString()}</span></div>
              {d.mailEnabled && <button className="btn small" data-act="invite-resend" onClick={guard(() => sendInvite(i.email, i.role, true))}>Resend</button>}
              <button className="btn small" onClick={guard(async () => { const r = await S.teamApi('DELETE', `/invites/${i.id}`); setInfo({ ...d, invites: r.invites }); })}>Revoke</button></div>)}</>}
          </>}
        </section>

        <section className="card"><div className="card-head"><h2>Spec types</h2>{admin && <button className="btn small" data-act="stype-new" onClick={() => setTsheet({})}><Icon name="plus" size={14} /> New type</button>}</div>
          <p className="note">A type gives a new spec its starting structure and tells agents what kind of specification they are reading (<span className="mono">list_specs(type: "api")</span>). Built-in types are fixed; add your own for your team.</p>
          {d?.types ? d.types.map((x: any) => <div className="typerow" key={x.key}><div><b>{x.label}</b> <small className="muted mono">{x.key}{x.builtin ? ' · built-in' : ''}{x.form ? (x.view === 'form' ? ' · form' : ' · form optional') : ''}</small><p className="muted">{x.description}</p></div>
            {admin && !x.builtin && <div className="typeacts"><button className="btn small" data-act="stype-edit" onClick={() => setTsheet({ type: x })}>Edit</button><button className="btn small" data-act="stype-delete" style={{ color: 'var(--red)', borderColor: 'var(--red-line)' }} onClick={guard(async () => { if (!confirm(`Delete the spec type “${x.key}”?`)) return; await S.teamApi('DELETE', `/spec-types/${x.key}`); await S.refreshTypes(); await reload(); })}>Delete</button></div>}</div>) : <div className="muted">Loading…</div>}</section>

        <section className="card"><div className="card-head"><h2><Icon name="git" size={16} /> Git connection</h2></div>{d?.git ? <GitForm key={JSON.stringify(d.git)} g={d.git} S={S} reload={reload} res={gitRes} setRes={setGitRes} /> : <div className="muted">Loading…</div>}</section>

        <section className="card"><h2>Roles &amp; rights</h2>
          <div className="table-wrap"><table className="matrix"><thead><tr><th></th>{ROLES.map((r) => <th key={r}>{r}</th>)}</tr></thead><tbody>
            {RIGHTS.map(([k, l]) => <tr key={k}><th scope="row">{l}</th>{ROLES.map((r) => <td key={r}>{ROLE_RIGHTS[r].includes(k) ? <span className="yes">✓</span> : <span className="no">–</span>}</td>)}</tr>)}
          </tbody></table></div></section>
      </div></div>
      {tsheet && <TypeSheet type={tsheet.type} onClose={() => setTsheet(null)} onDone={reload} />}
    </>} />
  );
}
