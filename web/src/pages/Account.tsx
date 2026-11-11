import { useEffect, useState, type FormEvent } from 'react';
import { Bar, Shell } from '../Shell';
import { Tabs } from '../Tabs';
import { usePref } from '../prefs';
import { guard } from '../hooks';
import { CreateTeamSheet } from '../sheets';
import type { Me, TeamInfo } from '../store/types';
import { Icon, ago, copy, setTheme, themePref, toast, useStore } from '../ui';

export const RIGHTS: [string, string][] = [['read', 'Read specs & documents'], ['write', 'Write drafts'], ['drafts', 'Agent access to drafts (MCP)'], ['approve', 'Approve, revoke & push to Git'], ['admin', 'Manage members & Git connection']];
export const ROLES = ['viewer', 'editor', 'approver', 'admin'];
export const ROLE_RIGHTS: Record<string, string[]> = { viewer: ['read'], editor: ['read', 'write', 'drafts'], approver: ['read', 'write', 'drafts', 'approve'], admin: ['read', 'write', 'drafts', 'approve', 'admin'] };
export const scopesText = (s: string[]) => (s.includes('mcp:write') ? 'writes drafts' : s.includes('mcp:drafts') ? 'incl. drafts' : 'released only');
const themeLabel: Record<string, string> = { system: 'System', light: 'Light', dark: 'Dark' };

export function AccountPage() {
  const S = useStore();
  const me = S.state.me as Me;
  const [acc, setAcc] = useState<any>(null);
  const [nt, setNt] = useState<any>(null);
  const [sheet, setSheet] = useState(false);
  const [tab, setTab] = usePref<'access' | 'teams' | 'settings'>('tab-account', 'access', ['access', 'teams', 'settings']);
  const load = async () => { try { setAcc(await S.api('GET', '/api/me/tokens')); } catch { setAcc({ tokens: [], connections: [] }); } };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const online = S.state.online && !S.state.sessionExpired;
  const teams: TeamInfo[] = me.teams;
  const anyDrafts = teams.some((t) => t.perms.includes('drafts'));
  const invites: any[] = me.invites ?? [];
  const t = S.team();
  const mcp = S.state.mcpUrl;

  const create = guard(async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setNt(await S.api('POST', '/api/me/tokens', { name: f.get('name'), teamId: f.get('team'), scopes: String(f.get('scope')).split(' '), days: Number(f.get('days')) }));
    await load();
  });
  const pw = guard(async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = e.currentTarget; const d = new FormData(f);
    await S.api('POST', '/api/me/password', { current: d.get('cur'), password: d.get('new') });
    f.reset(); toast('Password changed');
  });
  async function logout() {
    const n = [...S.state.maps.values()].reduce((a, m) => a + [...m.values()].filter(S.isPending).length, 0);
    if (n && !confirm(`${n} change(s) are not synced yet and will be lost. Sign out anyway?`)) return;
    await S.logout();
  }

  return (
    <Shell single master={<>
      <Bar title="Account" />
      <Tabs label="Account" value={tab} onChange={(v) => setTab(v as typeof tab)} tabs={[{ id: 'access', label: 'Agent access' }, { id: 'teams', label: 'Teams', badge: invites.length || '' }, { id: 'settings', label: 'Settings' }]} />
      <div className="scroll"><div className="page" id="tabpanel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        <p className="note" style={{ margin: 0 }}>{me.name} · {me.email}{me.admin ? ' · instance admin' : ''}</p>
        {invites.length > 0 && <section className="card"><h2>Invitations</h2>{invites.map((i) => <div className="rel" key={i.id}><div className="grow"><b>{i.teamName}</b><span>{i.invitedBy ? `${i.invitedBy} · ` : ''}role {i.role}</span></div>
          <button className="btn small" data-act="invite-decline" onClick={guard(async () => { await S.declineInvite(i.id); })}>Decline</button>
          <button className="btn primary small" data-act="invite-accept" onClick={guard(async () => { await S.acceptInvite(i.id); toast('Joined the team'); })}>Join</button></div>)}</section>}
        {tab === 'teams' && <><section className="card"><div className="card-head"><h2>Your teams &amp; roles</h2><button className="btn small" data-act="create-team-sheet" onClick={() => setSheet(true)}><Icon name="plus" size={14} /> New team</button></div>
          {teams.length ? teams.map((x) => <div className="kv" key={x.id}><span>{x.name} <span className="muted mono">{x.key}</span></span><span className="chip ok">{x.role}</span></div>) : <div className="muted">You are not a member of any team yet.</div>}
          {t && <><div className="rights">{RIGHTS.map(([k, l]) => <span key={k} className={`right ${t.perms.includes(k) ? 'yes' : 'no'}`}>{t.perms.includes(k) ? <Icon name="check" size={12} /> : '–'} {l}</span>)}</div><p className="note">Rights shown for {t.name}. Agents you connect act with exactly these rights in the team you choose.</p></>}</section></>}

        {tab === 'access' && <><section className="card"><div className="card-head"><h2>Agent access (MCP)</h2></div>
          <div className="mono" style={{ fontSize: 13, color: 'var(--soft)', wordBreak: 'break-all' }}>{mcp}</div>
          <p className="note"><b style={{ color: 'var(--text)' }}>OAuth (recommended):</b> <span className="mono">claude mcp add --transport http specs {mcp}</span>, then authenticate in the browser and pick the team.</p>
          {nt && <div className="card ok-card"><b>Token “{nt.pat.name}” for {nt.pat.teamName} — copy it now, it is shown only once.</b><div className="code">{nt.token}</div>
            <div className="code">claude mcp add --transport http specs-{nt.pat.teamName.toLowerCase().replace(/\W+/g, '-')} {mcp} --header "Authorization: Bearer {nt.token}"</div>
            <div className="btns"><button className="btn small" onClick={() => copy(nt.token)}>Copy token</button><button className="btn small" onClick={() => copy(`claude mcp add --transport http specs-${nt.pat.teamName.toLowerCase().replace(/\W+/g, '-')} ${mcp} --header "Authorization: Bearer ${nt.token}"`)}>Copy command</button><button className="btn small" onClick={() => setNt(null)}>Done</button></div></div>}
          <form id="tokenForm" className="form" onSubmit={create}>
            <div className="sect-title" style={{ margin: '4px 0 0' }}><span>Personal token</span></div>
            <label className="sr" htmlFor="tname">Token name</label><input className="field" id="tname" name="name" placeholder="Name, e.g. “Laptop – Claude Code”" required maxLength={60} disabled={!online} />
            <div className="grid2"><label className="sr" htmlFor="tteam">Team</label><select className="field" id="tteam" name="team" disabled={!online} defaultValue={S.state.teamId}>{teams.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.role})</option>)}</select>
              <label className="sr" htmlFor="tscope">Access</label><select className="field" id="tscope" name="scope" disabled={!online}><option value="mcp:read">Released specs only</option>{anyDrafts && <><option value="mcp:read mcp:drafts">Released + drafts</option><option value="mcp:read mcp:drafts mcp:write">Read &amp; write drafts (you approve)</option></>}</select></div>
            <label className="sr" htmlFor="tdays">Expires</label><select className="field" id="tdays" name="days" disabled={!online} defaultValue="90"><option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option></select>
            <button className="btn primary" type="submit" disabled={!online || !teams.length}><Icon name="key" size={16} /> Create token</button>
            {!online && <span className="muted" style={{ fontSize: 12 }}>Needs a connection to the server.</span>}
          </form>
          <div className="sect-title" style={{ margin: '6px 0 0' }}><span>Your tokens</span><small>{acc ? acc.tokens.length : '…'}</small></div>
          {acc ? (acc.tokens.length ? acc.tokens.map((k: any) => <div className="rel" style={{ padding: '10px 0' }} key={k.id}><div className="grow"><b>{k.name}</b><span className="mono">{k.teamName} · {k.prefix}… · {scopesText(k.scopes)} · {k.expired ? 'expired' : `expires ${new Date(k.expiresAt).toLocaleDateString()}`} · {k.lastUsedAt ? `used ${ago(Date.parse(k.lastUsedAt))}` : 'never used'}</span></div><button className="btn small" data-act="revoke-token" onClick={guard(async () => { await S.api('DELETE', `/api/me/tokens/${k.id}`); await load(); })}>Revoke</button></div>) : <div className="muted" style={{ fontSize: 13 }}>No personal tokens.</div>) : <div className="muted" style={{ fontSize: 13 }}>Loading…</div>}
          <div className="sect-title" style={{ margin: '6px 0 0' }}><span>Connected apps (OAuth)</span><small>{acc ? acc.connections.length : '…'}</small></div>
          {acc && (acc.connections.length ? acc.connections.map((c: any) => <div className="rel" style={{ padding: '10px 0' }} key={c.id}><div className="grow"><b>{c.clientName}</b><span>{c.teamName} · {scopesText(c.scopes)} · {c.lastUsedAt ? `used ${ago(Date.parse(c.lastUsedAt))}` : 'never used'}</span></div><button className="btn small" data-act="revoke-conn" onClick={guard(async () => { await S.api('DELETE', `/api/me/connections/${c.id}`); await load(); })}>Disconnect</button></div>) : <div className="muted" style={{ fontSize: 13 }}>No agents connected via OAuth.</div>)}
        </section></>}

        {tab === 'settings' && <><section className="card"><div className="card-head"><h2>Appearance</h2></div>
          <div className="seg" role="group" aria-label="Appearance" style={{ marginLeft: 0, alignSelf: 'flex-start' }}>{['system', 'light', 'dark'].map((x) => <button key={x} type="button" data-act="set-theme" data-v={x} aria-pressed={themePref() === x} onClick={() => { setTheme(x); setAcc((a: any) => ({ ...a })); }}>{themeLabel[x]}</button>)}</div></section></>}

        {tab === 'settings' && <><section className="card"><div className="card-head"><h2>Security</h2></div>
          <form id="pwForm" className="form" onSubmit={pw}><label className="sr" htmlFor="pwcur">Current password</label><input className="field" id="pwcur" name="cur" type="password" placeholder="Current password" autoComplete="current-password" disabled={!online} />
            <label className="sr" htmlFor="pwnew">New password</label><input className="field" id="pwnew" name="new" type="password" placeholder="New password (min. 10 characters)" autoComplete="new-password" minLength={8} disabled={!online} />
            <button className="btn" type="submit" disabled={!online}>Change password</button></form>
          <button className="btn danger" data-act="logout" onClick={logout}><Icon name="logout" size={16} /> Sign out &amp; remove local data</button>
        </section></>}
      </div></div>
      {sheet && <CreateTeamSheet onClose={() => setSheet(false)} />}
    </>} />
  );
}
