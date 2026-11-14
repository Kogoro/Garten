import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { ic } from './icons';
import { initial } from './lib';
import { CreateTeamSheet } from './sheets';
import { openMenu, type MenuItem } from './state';
import { Icon, setTheme, themePref, toast, useStore } from './ui';
import { densityPref, setDensity } from './prefs';

export function SyncPill() {
  const S = useStore();
  const q = S.queue().length + S.fbPending(), c = S.conflicts().length, st = S.state;
  // green = everything is on the server · amber = waiting (offline, queued, syncing) · red = needs you (conflict, signed out, failed)
  let cls = 'ok', text = 'Synced';
  if (st.sessionExpired) [cls, text] = ['bad', 'Sign in to sync'];
  else if (c) [cls, text] = ['bad', `${c} conflict${c > 1 ? 's' : ''}`];
  else if (!st.online) [cls, text] = ['warn', `Offline${q ? ` · ${q}` : ''}`];
  else if (st.syncing) [cls, text] = ['warn', 'Syncing…'];
  else if (st.error) [cls, text] = ['bad', 'Sync failed'];
  else if (q) [cls, text] = ['warn', `${q} queued`];
  // phones show the dot (and a count while work is waiting); the sidebar on a desktop has room for the words
  return <Link className={`pill sync-${cls}`} data-pill to="/sync" title={text}><span className="dot" aria-hidden="true" /><span className="pill-text">{text}</span>{q > 0 && <span className="pill-n" aria-hidden="true">{q}</span>}</Link>;
}

/** Team switcher / account / "more" menus (bottom sheets) and what they do. */
export function useMenus() {
  const S = useStore(); const nav = useNavigate();
  const [createTeam, setCreateTeam] = useState(false);
  const invites: any[] = S.state.me?.invites ?? [];
  const teamName = S.team()?.name ?? S.state.project;
  const themeItems = (['system', 'light', 'dark'] as const).map((t): MenuItem => ({ key: `theme:${t}`, label: `Appearance: ${{ system: 'System', light: 'Light', dark: 'Dark' }[t]}`, current: themePref() === t }));
  const densityItems = (['comfortable', 'compact'] as const).map((d): MenuItem => ({ key: `density:${d}`, label: `Lists: ${d === 'compact' ? 'Compact' : 'Comfortable'}`, current: densityPref() === d }));
  const workspaceItems = (): MenuItem[] => {
    const others = Object.fromEntries(S.otherTeams().map((t: any) => [t.id, t]));
    return [
      ...S.state.me!.teams.map((t: any) => ({ key: `team:${t.id}`, label: `${t.name} · ${t.role}${others[t.id]?.pending ? ` · ${others[t.id].pending} unsynced` : ''}${others[t.id]?.conflicts ? ' · conflict' : ''}`, current: t.id === S.state.teamId })),
      ...invites.map((i) => ({ key: `invite:${i.id}`, label: `Join “${i.teamName}” as ${i.role} (invitation)` })),
      { key: 'create-team', label: 'Create a new team…' },
    ];
  };
  async function pick(key: string | null): Promise<void> {
    if (!key) return;
    if (key.startsWith('team:')) { const id = key.slice(5); if (id !== S.state.teamId) { S.switchTeam(id); nav('/'); } return; }
    if (key.startsWith('invite:')) { await S.acceptInvite(key.slice(7)); toast('Joined the team'); nav('/'); return; }
    if (key.startsWith('go:')) return void nav(`/${key.slice(3)}`);
    if (key.startsWith('theme:')) return setTheme(key.slice(6));
    if (key.startsWith('density:')) return setDensity(key.slice(8) as 'compact' | 'comfortable');
    if (key === 'create-team') return setCreateTeam(true);
    if (key === 'switch') return pick(await openMenu('Team', workspaceItems()));
    if (key === 'logout') {
      const n = [...S.state.maps.values()].reduce((a, m) => a + [...m.values()].filter(S.isPending).length, 0);
      if (n && !confirm(`${n} change(s) are not synced yet and will be lost. Sign out anyway?`)) return;
      await S.logout(); nav('/');
    }
  }
  return {
    workspace: async () => pick(await openMenu('Team', workspaceItems())),
    user: async () => pick(await openMenu(S.state.me!.name, [{ key: 'go:account', label: 'Account & agent access' }, ...themeItems, ...densityItems, { key: 'logout', label: 'Sign out', danger: true }])),
    more: async () => pick(await openMenu('More', [
      { key: 'go:glossary', label: 'Glossary' }, { key: 'go:sync', label: `Sync${S.queue().length + S.fbPending() + S.conflicts().length ? ` · ${S.queue().length + S.fbPending() + S.conflicts().length} waiting` : ''}` }, { key: 'go:team', label: 'Members & Git' },
      ...(S.isInstanceAdmin() ? [{ key: 'go:admin', label: 'Admin' }] : []), { key: 'go:account', label: 'Account & agent access' },
      ...invites.map((i) => ({ key: `invite:${i.id}`, label: `Join “${i.teamName}” as ${i.role} (invitation)` })),
      { key: 'switch', label: `Team: ${teamName} – switch or create…` }, ...themeItems, ...densityItems, { key: 'logout', label: 'Sign out', danger: true },
    ])),
    sheet: createTeam ? <CreateTeamSheet onClose={() => setCreateTeam(false)} /> : null,
    invites: invites.length, teamName,
  };
}

/** The one page header: compact, same everywhere (team button on mobile, sync pill). */
const DetailOpen = createContext(false);
export function Bar({ title, children }: { title: string; children?: ReactNode }) {
  const m = useMenus();
  const H = useContext(DetailOpen) ? 'h2' : 'h1'; // an open spec/document has its own h1: one h1 per page
  return (
    <header className="bar"><H>{title}</H>{children}<SyncPill />
      <button type="button" className="ws-btn only-mobile" aria-label={`Team: ${m.teamName}`} onClick={m.workspace}><span className="ws-av">{initial(m.teamName)}</span>{m.invites > 0 && <span className="badge-dot" />}</button>
      {m.sheet}
    </header>
  );
}

const PLACEHOLDER: Record<string, [keyof typeof ic, string]> = {
  specs: ['specs', 'Select a spec, or create one with “New”.'], docs: ['docs', 'Select a document, or create one with “New”.'], glossary: ['glossary', 'Select a term to see its definition, synonyms and references.'],
};
const TITLES: Record<string, string> = { specs: 'Specs', docs: 'Documents', glossary: 'Glossary', release: 'Release', garden: 'Garden', sync: 'Sync', team: 'Members & Git', account: 'Account', admin: 'Admin' };
export function sectionOf(pathname: string) {
  const p = pathname.split('/')[1] ?? '';
  return p === '' || p === 'spec' ? 'specs' : p === 'doc' ? 'docs' : p;
}

export function Shell({ master, detail, single, active }: { master: ReactNode; detail?: ReactNode; single?: boolean; active?: string }) {
  const S = useStore();
  const { pathname } = useLocation();
  const m = useMenus();
  const act = active ?? sectionOf(pathname);
  const me = S.state.me!, t = S.team();
  const nSpecs = S.all('spec').length;
  const link = (to: string, label: string, icon: keyof typeof ic, extra?: ReactNode) => (
    <NavLink key={to} to={to} end={to === '/'} className="navitem" aria-current={act === (to === '/' ? 'specs' : to.slice(1)) ? 'page' : undefined}><Icon name={icon} size={18} /><span>{label}</span>{extra}</NavLink>
  );
  const [pi, ptext] = PLACEHOLDER[act] ?? PLACEHOLDER.specs;
  // one distinct window title per page (history, tabs, screen readers): "Spec title · Specs · Team"
  const openId = pathname.startsWith('/spec/') || pathname.startsWith('/doc/') ? decodeURIComponent(pathname.replace(/^\/(spec|doc)\//, '')) : null;
  const openTitle = openId ? (S.get(openId)?.title || openId) : null;
  useEffect(() => { document.title = [openTitle, TITLES[act] ?? 'Specs', t?.name].filter(Boolean).join(' · '); }, [openTitle, act, t?.name]);
  const needs = S.feedbackTotal();
  const moreBadge = m.invites + S.conflicts().length;
  return (
    <div className={`shell ${single ? 'single' : ''}`} data-pane={detail ? 'detail' : 'master'}>
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>Skip to content</a>
      <nav className="sidebar" id="sidebar" aria-label="Sections">
        <button type="button" className="ws" aria-label="Switch team" onClick={m.workspace}><span className="ws-av">{initial(m.teamName)}</span><b>{m.teamName}</b><Icon name="chevron" size={14} />{m.invites > 0 && <span className="navitem badge" style={{ marginLeft: 6 }}>{m.invites}</span>}</button>
        <div className="navgroup">
          {link('/garden', 'Garden', 'garden', needs > 0 ? <span className="badge" title="Decisions and feedback that wait for a person">{needs}</span> : null)}
          {link('/', 'Specs', 'specs', nSpecs ? <span className="count" style={{ marginLeft: 'auto' }}>{nSpecs}</span> : null)}{link('/docs', 'Documents', 'docs')}{link('/glossary', 'Glossary', 'glossary')}
          {link('/release', 'Release', 'release')}
        </div>
        <div className="navgroup">
          {link('/team', 'Members & Git', 'team')}
          {S.isInstanceAdmin() && link('/admin', 'Admin', 'shield')}
        </div>
        <div className="sidefoot">
          <SyncPill />
          <button type="button" className="me" data-act="user-menu" aria-label="Account menu" onClick={m.user}><span className="avatar">{initial(me.name)}</span><span className="who"><b>{me.name}</b><small>{t?.role ?? (me.admin ? 'instance admin' : '')}</small></span><Icon name="more" size={18} /></button>
        </div>
      </nav>
      <main className="content" id="main" tabIndex={-1}>
        <DetailOpen.Provider value={!!detail}><section className="master" id="master">{master}</section></DetailOpen.Provider>
        {!single && <section className="detail" id="detail">{detail ?? <div className="placeholder"><Icon name={pi} size={40} /><p>{ptext}</p></div>}</section>}
      </main>
      <nav className="tabbar" id="tabbar" aria-label="Main sections">
        {([['/garden', 'Garden', 'garden', 'garden'], ['/', 'Specs', 'specs', 'specs'], ['/docs', 'Docs', 'docs', 'docs'], ['/release', 'Release', 'release', 'release']] as const).map(([to, l, i, k]) => (
          <NavLink key={to} to={to} end={to === '/'} aria-current={act === k ? 'page' : undefined}><Icon name={i} />{<span>{l}</span>}{k === 'garden' && needs > 0 && <span className="badge">{needs}</span>}</NavLink>
        ))}
        <button type="button" data-act="more-menu" aria-label="More" aria-current={['glossary', 'sync', 'team', 'account', 'admin'].includes(act) ? 'page' : undefined} onClick={m.more}><Icon name="more" /><span>More</span>{moreBadge > 0 && <span className="badge">{moreBadge}</span>}</button>
      </nav>
      {m.sheet}
    </div>
  );
}
