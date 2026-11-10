import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bar, Shell } from '../Shell';
import { guard } from '../hooks';
import { Icon, toast, useStore } from '../ui';

export function NoTeamPage() {
  const S = useStore(); const nav = useNavigate();
  const [err, setErr] = useState<string | null>(null);
  const invites: any[] = S.state.me?.invites ?? [];
  async function create(e: FormEvent<HTMLFormElement>) { e.preventDefault(); try { await S.createTeam(String(new FormData(e.currentTarget).get('name'))); nav('/'); toast('Team created'); } catch (x: any) { setErr(x.message); } }
  return (
    <Shell single active="account" master={<>
      <Bar title="Welcome" />
      <div className="scroll"><div className="page">
        <section className="card"><h2>Create your team</h2><p className="note">A team has its own specs, documents, glossary, Git repository and agent access. You become its admin and can invite colleagues.</p>
          <form id="createTeamForm" className="form" onSubmit={create}><label className="sr" htmlFor="newteam">Team name</label><input className="field" id="newteam" name="name" placeholder="Team name, e.g. Payments" required maxLength={80} />{err && <span className="err-text">{err}</span>}<button className="btn primary" type="submit"><Icon name="plus" size={16} /> Create team</button></form></section>
        {invites.length ? <section className="card"><h2>Invitations</h2>{invites.map((i) => <div className="rel" key={i.id}><div className="grow"><b>{i.teamName}</b><span>{i.invitedBy ? `${i.invitedBy} · ` : ''}role {i.role}</span></div><button className="btn small" data-act="invite-decline" onClick={guard(() => S.declineInvite(i.id))}>Decline</button><button className="btn primary small" data-act="invite-accept" style={{ color: 'var(--on-green)' }} onClick={guard(async () => { await S.acceptInvite(i.id); toast('Joined the team'); nav('/'); })}>Join</button></div>)}</section> : <p className="note">Or ask a team admin to invite you – you will see the invitation here.</p>}
      </div></div>
    </>} />
  );
}
