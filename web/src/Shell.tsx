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
  const q = S.queue().length + S.fbPending(),
    c = S.conflicts().length,
    st = S.state;
  // green = everything is on the server · amber = waiting (offline, queued, syncing) · red = needs you (conflict, signed out, failed)
  let cls = 'ok',
    text = 'Synced';
  if (st.sessionExpired) [cls, text] = ['bad', 'Sign in to sync'];
  else if (c) [cls, text] = ['bad', `${c} conflict${c > 1 ? 's' : ''}`];
  else if (!st.online) [cls, text] = ['warn', `Offline${q ? ` · ${q}` : ''}`];
  else if (st.syncing) [cls, text] = ['warn', 'Syncing…'];
  else if (st.error) [cls, text] = ['bad', 'Sync failed'];
  else if (q) [cls, text] = ['warn', `${q} queued`];
  // phones show the dot (and a count while work is waiting); the sidebar on a desktop has room for the words
  return (
    <Link className={`pill sync-${cls}`} data-pill to="/sync" title={text}>
      <span className="dot" aria-hidden="true" />
      <span className="pill-text">{text}</span>
      {q > 0 && (
        <span className="pill-n" aria-hidden="true">
          {q}
        </span>
      )}
    </Link>
  );
}

/** Team switcher / account / "more" menus (bottom sheets) and what they do. */
export function useMenus() {
  const S = useStore();
  const nav = useNavigate();
  const [createTeam, setCreateTeam] = useState(false);
  const invites: any[] = S.state.me?.invites ?? [];
  const teamName = S.team()?.name ?? S.state.project;
  const themeItems = (['system', 'light', 'dark'] as const).map((t): MenuItem => ({
    key: `theme:${t}`,
    label: `Appearance: ${{ system: 'System', light: 'Light', dark: 'Dark' }[t]}`,
    current: themePref() === t,
  }));
  const densityItems = (['comfortable', 'compact'] as const).map((d): MenuItem => ({
    key: `density:${d}`,
    label: `Lists: ${d === 'compact' ? 'Compact' : 'Comfortable'}`,
    current: densityPref() === d,
  }));
  const workspaceItems = (): MenuItem[] => {
    const others = Object.fromEntries(S.otherTeams().map((t: any) => [t.id, t]));
    return [
      ...S.state.me!.teams.map((t: any) => ({
        key: `team:${t.id}`,
        label: `${t.name} · ${t.role}${others[t.id]?.pending ? ` · ${others[t.id].pending} unsynced` : ''}${others[t.id]?.conflicts ? ' · conflict' : ''}`,
        current: t.id === S.state.teamId,
      })),
      ...invites.map((i) => ({ key: `invite:${i.id}`, label: `Join “${i.teamName}” as ${i.role} (invitation)` })),
      { key: 'create-team', label: 'Create a new team…' },
    ];
  };
  async function pick(key: string | null): Promise<void> {
    if (!key) return;
    if (key.startsWith('team:')) {
      const id = key.slice(5);
      if (id !== S.state.teamId) {
        S.switchTeam(id);
        nav('/');
      }
      return;
    }
    if (key.startsWith('invite:')) {
      await S.acceptInvite(key.slice(7));
      toast('Joined the team');
      nav('/');
      return;
    }
    if (key.startsWith('go:')) return void nav(`/${key.slice(3)}`);
    if (key.startsWith('theme:')) return setTheme(key.slice(6));
    if (key.startsWith('density:')) return setDensity(key.slice(8) as 'compact' | 'comfortable');
    if (key === 'create-team') return setCreateTeam(true);
    if (key === 'tour') return void window.dispatchEvent(new Event('garten:tour'));
    if (key === 'switch') return pick(await openMenu('Team', workspaceItems()));
    if (key === 'logout') {
      const n = [...S.state.maps.values()].reduce((a, m) => a + [...m.values()].filter(S.isPending).length, 0);
      if (n && !confirm(`${n} change(s) are not synced yet and will be lost. Sign out anyway?`)) return;
      await S.logout();
      nav('/');
    }
  }
  return {
    workspace: async () => pick(await openMenu('Team', workspaceItems())),
    user: async () => {
      const waitingSync = S.queue().length + S.fbPending() + S.conflicts().length;
      return pick(
        await openMenu(S.state.me!.name, [
          { key: 'switch', label: `Team: ${teamName} – switch or create…` },
          ...invites.map((i) => ({ key: `invite:${i.id}`, label: `Join “${i.teamName}” as ${i.role} (invitation)` })),
          { key: 'go:activity', label: 'Agents' },
          { key: 'go:release', label: 'Connect an agent' },
          { key: 'go:team', label: 'Members & Git' },
          ...(S.isInstanceAdmin() ? [{ key: 'go:admin', label: 'Admin' }] : []),
          { key: 'go:sync', label: `Sync${waitingSync ? ` · ${waitingSync} waiting` : ''}` },
          { key: 'go:account', label: 'Account & agent access' },
          { key: 'tour', label: 'Take the tour' },
          ...themeItems,
          ...densityItems,
          { key: 'logout', label: 'Sign out', danger: true },
        ]),
      );
    },
    sheet: createTeam ? <CreateTeamSheet onClose={() => setCreateTeam(false)} /> : null,
    invites: invites.length,
    teamName,
  };
}

/** Proposed glossary terms and guardrails that wait for an approver (0 for everyone else: they cannot act on them). */
function proposalsWaiting(S: ReturnType<typeof useStore>) {
  if (!S.can('approve')) return { terms: 0, rules: 0 };
  return { terms: S.proposedItems().length, rules: S.proposedRuleItems().length };
}
/** The one page header: compact, same everywhere (team button on mobile, sync pill). */
const DetailOpen = createContext(false);
export function Bar({ title, children, quiet }: { title: string; children?: ReactNode; quiet?: boolean }) {
  const m = useMenus();
  const S = useStore();
  const H = useContext(DetailOpen) ? 'h2' : 'h1'; // an open spec/document has its own h1: one h1 per page
  return (
    <header className={`bar${quiet ? ' bar-quiet' : ''}`}>
      <H>{title}</H>
      {children}
      <SyncPill />
      <button
        type="button"
        className="ws-btn only-mobile"
        data-act="user-menu"
        aria-label={`You, team ${m.teamName} and settings`}
        onClick={m.user}
      >
        <span className="ws-av">{initial(S.state.me?.name)}</span>
        {m.invites > 0 && <span className="badge-dot" />}
      </button>
      {m.sheet}
    </header>
  );
}

const PLACEHOLDER: Record<string, [keyof typeof ic, string]> = {
  specs: ['specs', 'Select a spec, or create one with “New”.'],
  docs: ['docs', 'Select a document, or create one with “New”.'],
  glossary: ['glossary', 'Select a term to see its definition, synonyms and references.'],
  guardrails: ['rule', 'Select a rule to see why it exists, what to do instead and its exceptions.'],
};
const TITLES: Record<string, string> = {
  today: 'Today',
  activity: 'Agents',
  history: 'History',
  specs: 'Specs',
  docs: 'Documents',
  glossary: 'Glossary',
  guardrails: 'Guardrails',
  release: 'Connect an agent',
  sync: 'Sync',
  team: 'Members & Git',
  account: 'Account',
  admin: 'Admin',
};
export function sectionOf(pathname: string) {
  const p = pathname.split('/')[1] ?? '';
  return p === '' ? 'today' : p === 'spec' ? 'specs' : p === 'doc' ? 'docs' : p === 'garden' ? 'today' : p;
}
/** Which of the four tabs a section belongs to: specs and agents live under Today. */
const TAB_OF: Record<string, string> = {
  today: 'today',
  specs: 'today',
  activity: 'today',
  history: 'today',
  queue: 'today',
  docs: 'docs',
  glossary: 'glossary',
  guardrails: 'guardrails',
};

export function Shell({ master, detail, single, active }: { master: ReactNode; detail?: ReactNode; single?: boolean; active?: string }) {
  const S = useStore();
  const { pathname } = useLocation();
  const m = useMenus();
  const act = active ?? sectionOf(pathname);
  const tab = TAB_OF[act] ?? '';
  const me = S.state.me!,
    t = S.team();
  const [pi, ptext] = PLACEHOLDER[act] ?? PLACEHOLDER.specs;
  // one distinct window title per page (history, tabs, screen readers): "Spec title · Specs · Team"
  const openId =
    pathname.startsWith('/spec/') || pathname.startsWith('/doc/') ? decodeURIComponent(pathname.replace(/^\/(spec|doc)\//, '')) : null;
  const openTitle = openId ? S.get(openId)?.title || openId : null;
  useEffect(() => {
    document.title = [openTitle, TITLES[act] ?? 'Today', t?.name].filter(Boolean).join(' · ');
  }, [openTitle, act, t?.name]);
  const needs = S.feedbackTotal();
  const waiting = proposalsWaiting(S);
  const tabs: [string, string, string, keyof typeof ic, number][] = [
    ['today', '/', 'Today', 'garden', needs],
    ['docs', '/docs', 'Documents', 'docs', 0],
    ['guardrails', '/guardrails', 'Guardrails', 'shield', waiting.rules],
    ['glossary', '/glossary', 'Glossary', 'glossary', waiting.terms],
  ];
  return (
    <div className={`shell ${single ? 'single' : ''}`} data-pane={detail ? 'detail' : 'master'}>
      <a
        className="skip"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main')?.focus();
        }}
      >
        Skip to content
      </a>
      <header className="topnav" id="topnav">
        <Link to="/" className="brand" aria-label="Garten, Today">
          <span className="brand-dot" aria-hidden="true" />
          garten
        </Link>
        <button type="button" className="ws" aria-label={`Switch team (now ${m.teamName})`} onClick={m.workspace}>
          <b>{m.teamName}</b>
          {m.invites > 0 && <span className="badge">{m.invites}</span>}
        </button>
        <nav className="toptabs" aria-label="Sections">
          {tabs.map(([k, to, label, , n]) => (
            <NavLink key={k} to={to} end={to === '/'} className="toptab" aria-current={tab === k ? 'page' : undefined}>
              {label}
              {n > 0 && (
                <span
                  className="badge"
                  title={k === 'today' ? 'Decisions and feedback that wait for a person' : `${n} proposed, waiting for an approver`}
                >
                  {n}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
        <span className="spacer" />
        <button type="button" className="findbox" data-act="palette" onClick={() => window.dispatchEvent(new Event('garten:palette'))}>
          <Icon name="search" size={16} />
          <span>Find anything</span>
          <kbd>Ctrl K</kbd>
        </button>
        <span className="me-wrap">
          <button type="button" className="me" data-act="user-menu" aria-label={`You (${me.name}), team and settings`} onClick={m.user}>
            <span className="avatar">{initial(me.name)}</span>
          </button>
          <SyncPill />
        </span>
      </header>
      <main className="content" id="main" tabIndex={-1}>
        <DetailOpen.Provider value={!!detail}>
          <section className="master" id="master">
            {master}
          </section>
        </DetailOpen.Provider>
        {!single && (
          <section className="detail" id="detail">
            {detail ?? (
              <div className="placeholder">
                <Icon name={pi} size={40} />
                <p>{ptext}</p>
              </div>
            )}
          </section>
        )}
      </main>
      <nav className="tabbar" id="tabbar" aria-label="Main sections">
        {tabs.map(([k, to, label, icon, n]) => (
          <NavLink key={k} to={to} end={to === '/'} aria-current={tab === k ? 'page' : undefined}>
            <Icon name={icon} />
            <span>{label}</span>
            {n > 0 && <span className="badge">{n}</span>}
          </NavLink>
        ))}
      </nav>
      {m.sheet}
    </div>
  );
}
