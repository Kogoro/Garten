import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Icon, useStore } from '../ui';

export function InvitePage() {
  const S = useStore(); const nav = useNavigate();
  const { token = '' } = useParams();
  const [v, setV] = useState<{ info?: any; error?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { S.api('GET', `/api/invites/${encodeURIComponent(token)}`).then((r: any) => setV({ info: r.invite })).catch((e: any) => setV({ error: e.message })); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  const me = S.state.me, cfg = S.state.authConfig;
  const logo = <span className="logo big"><Icon name="mail" size={28} /></span>;
  async function enter(teamId?: string) { history.replaceState(null, '', location.pathname); if (teamId) S.switchTeam(teamId); nav('/'); }
  if (!v) return <div className="login"><div className="login-card">{logo}<h1>Invitation</h1><p>Checking your invitation…</p></div></div>;
  if (v.error) return <div className="login"><div className="login-card">{logo}<h1>Invitation</h1><p className="err-text">{v.error}</p><a className="btn" href="#/">Open Specs</a></div></div>;
  const i = v.info;
  const head = <>{logo}<h1>Join {i.teamName}</h1><p>{i.invitedBy ? `${i.invitedBy} invited ` : 'You are invited: '}<b>{i.email}</b> as <b>{i.role}</b>.</p>{err && <div className="err-text" role="alert">{err}</div>}</>;
  const accept = async (body: any) => S.api('POST', `/api/invites/${encodeURIComponent(token)}/accept`, body);
  if (me) {
    return me.email.toLowerCase() === i.email.toLowerCase()
      ? <div className="login"><div className="login-card">{head}<button className="btn primary" data-act="accept-link" onClick={async () => { try { const r = await accept({}); await S.refreshMe(r.teamId); await enter(r.teamId); } catch (x: any) { setErr(x.message); } }}>Join {i.teamName}</button></div></div>
      : <div className="login"><div className="login-card">{head}<p className="err-text">You are signed in as {me.email}. Sign out to use this invitation.</p><button className="btn danger" onClick={() => S.logout()}>Sign out</button></div></div>;
  }
  const sso = cfg?.oidc ? <a className="btn" href={`/auth/oidc/login?next=${encodeURIComponent(`/#/invite/${token}`)}`}>{cfg.oidc.name}</a> : null;
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget); setErr(null);
    try {
      let r;
      if (i.userExists) { await S.login(i.email, String(f.get('pw'))); r = await accept({}); await S.refreshMe(r.teamId); }
      else { r = await accept({ name: f.get('name'), password: f.get('pw') }); await S.adoptLogin(r.me); }
      await enter(r.teamId);
    } catch (x: any) { setErr(x.message); }
  }
  return i.userExists
    ? <div className="login"><form className="login-card" id="inviteLogin" onSubmit={submit}>{head}<label className="sr" htmlFor="iv-pw">Password</label><input className="field" id="iv-pw" name="pw" type="password" placeholder="Your password" autoComplete="current-password" required /><button className="btn primary" type="submit">Sign in &amp; join</button>{sso}</form></div>
    : <div className="login"><form className="login-card" id="inviteRegister" onSubmit={submit}>{head}<label className="sr" htmlFor="iv-name">Your name</label><input className="field" id="iv-name" name="name" placeholder="Your name" autoComplete="name" required /><label className="sr" htmlFor="iv-pw">Password</label><input className="field" id="iv-pw" name="pw" type="password" placeholder="Choose a password (min. 10 characters)" autoComplete="new-password" minLength={10} required /><button className="btn primary" type="submit">Create account &amp; join</button>{sso}</form></div>;
}
