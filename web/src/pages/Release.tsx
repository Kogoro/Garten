import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Bar, Shell } from '../Shell';
import { CORE_LABEL, enc, foundState } from '../lib';
import { guard, useTeamInfo } from '../hooks';
import { Icon, ago, copy, toast, useStore } from '../ui';
import { TypeChip } from './ItemEditor';

export function ReleasePage() {
  const S = useStore();
  const { info, reload } = useTeamInfo();
  const [, setR] = useState(0);
  const st = S.state;
  const pending = S.all('spec').filter((s) => s.approve);
  const released = S.all('spec').filter((s) => s.status === 'approved').sort((a, b) => a.id.localeCompare(b.id));
  const online = st.online && !st.error && !st.sessionExpired;
  const url = st.mcpUrl;
  const g = info?.git;
  const gitLine = !g ? '' : !g.url ? 'No Git remote connected for this team.' : g.lastOk === false ? `Last push failed: ${g.lastError ?? ''}` : g.lastPushAt ? `Pushed ${ago(Date.parse(g.lastPushAt))}${g.lastError ? ` – ${g.lastError}` : ''}` : 'Connected, nothing pushed yet.';
  const teamName = S.team()?.name ?? '';
  const push = guard(async () => {
    toast('Pushing…');
    try { await S.teamApi('POST', '/git/push'); toast('Pushed'); } catch (e: any) { toast('Push failed'); }
    await reload(); setR((x) => x + 1);
  });
  return (
    <Shell single master={<>
      <Bar title="Release" />
      <div className="scroll"><div className="page">
        <section className="card">
          <div className="card-head"><h2>Agent endpoint</h2><span className="st" style={{ color: online ? 'var(--text)' : 'var(--amber)', fontWeight: 600 }}>● {online ? 'Server online' : 'Server unreachable'}</span></div>
          <div className="mono" style={{ fontSize: 13, color: 'var(--soft)', wordBreak: 'break-all' }}>{url}</div>
          <div className="code">claude mcp add --transport http specs-{(S.team()?.key ?? 'team').toLowerCase()} {url}</div>
          <p className="note">Claude opens a browser to sign in; choose <b style={{ color: 'var(--text)' }}>{teamName}</b> on the consent screen. Without OAuth: <Link to="/account" style={{ color: 'var(--text)' }}>create a token</Link>. Agents act with the rights of the person who connected them.</p>
          <div className="btns"><button className="btn small" onClick={() => copy(url)}>Copy URL</button><Link className="btn small" to="/account">Manage tokens</Link></div>
        </section>
        <section className="card"><div className="card-head"><h2>Always available to agents</h2></div>
          {S.foundationDocs().map((d) => { const f = foundState(d, S); return <div className="kv" key={d.id}><Link to={d.id === 'glossary.md' ? '/glossary' : `/doc/${enc(d.id)}`}>{CORE_LABEL[d.id] ?? d.id}</Link><span><span className={`chip ${f.cls}`}>{f.text}</span></span></div>; })}
          <p className="note">Served via <span className="mono">get_team_context</span> as soon as they contain something{S.team()?.foundationAuto === false ? ' and have been approved' : ' – they are released automatically after edits'}.</p></section>
        <section className="card"><div className="card-head"><h2><Icon name="git" size={16} /> Git repository</h2>{g?.url && <span className={`st ${g.lastOk === false ? 'bad' : ''}`}><Icon name={g.lastOk === false ? 'warn' : 'check'} size={12} /> {g.lastOk === false ? 'Failed' : g.lastPushAt ? 'Pushed' : 'Connected'}</span>}</div>
          <p className="note">{g?.url && <><span className="mono">{g.url}</span> · branch <span className="mono">{g.branch}</span> · folder <span className="mono">{g.root}/</span><br /></>}{gitLine}</p>
          <div className="btns">{g?.url && S.can('approve') && <button className="btn small" data-act="git-push" onClick={push}>Push now</button>}<Link className="btn small" to="/team">{S.can('admin') ? 'Git settings' : 'Team'}</Link></div>
        </section>
        {pending.map((s) => <section className="card warn" key={s.id}><span style={{ color: 'var(--amber)' }}><Icon name="up" size={20} /></span><div className="grow"><b>{s.id} approved on this device</b><span>Available to your agent after sync.</span></div></section>)}
        <section>
          <div className="sect-title"><span>Released specs</span><small>{released.length} approved</small></div>
          {released.length ? released.map((s) => (
            <div className="rel" key={s.id}><div className="grow"><b><TypeChip s={s} S={S} /> {s.title}{S.hasUnreleased(s) && <span className="chip warn" style={{ marginLeft: 4 }}>edited since release</span>}</b>
              <span><span className="mono">{s.id}</span>{S.feedbackCount(s.id) > 0 && <> · <b style={{ color: 'var(--amber)' }}>{S.feedbackCount(s.id)} open feedback</b></>} · v{s.version}{s.releasedBy ? ` by ${s.releasedBy}` : ''} · {s.links.length} document{s.links.length === 1 ? '' : 's'} · {s.fetchedAt ? `fetched ${ago(Date.parse(s.fetchedAt))}` : 'never fetched'}</span></div>
              {S.can('approve') && (s.revoke ? <button className="btn small" onClick={() => S.cancelRevoke(s.id)}>Undo revoke</button> : <button className="btn small" data-act="revoke" onClick={() => { if (confirm(`Revoke ${s.id}? Agents will no longer see it.`)) S.requestRevoke(s.id); }}>Revoke</button>)}
            </div>)) : <div className="empty" style={{ padding: '16px 0' }}>Nothing released yet. Approve a spec in the editor.</div>}
        </section>
        <section><div className="sect-title"><span>What the agent can call</span></div>
          <div className="code">{'get_team_context()            # vision, strategy, glossary\nlist_specs()\nget_spec("SPEC-012", version?)\nlist_documents(folder?)\nget_document("adr/ADR-007.md")\nget_glossary(term?)\n# tokens with draft access also get: include_drafts / draft=true\n# tokens with write access can also leave feedback (add_feedback, list_feedback) and create and update DRAFTS (create_draft_spec, update_draft_spec,\n#   create_draft_document, update_draft_document) – a person approves them here'}</div></section>
      </div></div>
    </>} />
  );
}
