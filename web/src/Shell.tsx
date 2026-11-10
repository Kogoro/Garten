import { NavLink, Link, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { Icon, useStore } from './ui';
import { ic } from './icons';

const initial = (s?: string) => (s ?? '?').trim()[0]?.toUpperCase() ?? '?';

export function SyncPill() {
  const S = useStore();
  const q = S.queue().length, c = S.conflicts().length, st = S.state;
  let cls = 'ok', text = 'Synced', icon = ic.check(14);
  if (st.sessionExpired) [cls, text, icon] = ['bad', 'Sign in to sync', ic.warn(14)];
  else if (c) [cls, text, icon] = ['bad', `${c} conflict${c > 1 ? 's' : ''}`, ic.warn(14)];
  else if (!st.online) [cls, text, icon] = ['warn', `Offline${q ? ` · ${q}` : ''}`, ic.off()];
  else if (st.syncing) [cls, text, icon] = ['', 'Syncing…', ic.sync(14)];
  else if (st.error) [cls, text, icon] = ['bad', 'Sync failed', ic.warn(14)];
  else if (q) [cls, text, icon] = ['warn', `${q} queued`, ic.up(14)];
  return <Link className={`pill ${cls}`} to="/sync"><span dangerouslySetInnerHTML={{ __html: icon }} />{text}</Link>;
}

export function Bar({ title, children }: { title: string; children?: ReactNode }) {
  return <header className="bar"><h1>{title}</h1>{children}<SyncPill /></header>;
}

const nav: [string, string, keyof typeof ic][] = [['/', 'Specs', 'specs'], ['/docs', 'Documents', 'docs'], ['/glossary', 'Glossary', 'glossary']];

export function Shell({ master, detail, single }: { master: ReactNode; detail?: ReactNode; single?: boolean }) {
  const S = useStore();
  const { pathname } = useLocation();
  const me = S.state.me!, t = S.team();
  const teamName = t?.name ?? S.state.project;
  const link = (to: string, label: string, icon: keyof typeof ic) => (
    <NavLink key={to} to={to} end={to === '/'} className="navitem" aria-current={undefined}><Icon name={icon} size={18} /><span>{label}</span></NavLink>
  );
  return (
    <div className={`shell ${single ? 'single' : ''}`} data-pane={detail ? 'detail' : 'master'}>
      <aside className="sidebar" id="sidebar">
        <button type="button" className="ws" aria-label="Switch team"><span className="ws-av">{initial(teamName)}</span><b>{teamName}</b></button>
        <div className="navlabel">Content</div>
        {nav.map(([to, l, i]) => link(to, l, i))}
        <div className="navlabel">Publish</div>
        {link('/release', 'Release', 'release')}
        <div className="navlabel">Team</div>
        {link('/team', 'Members & Git', 'team')}
        {S.isInstanceAdmin() && <><div className="navlabel">Instance</div>{link('/admin', 'Admin', 'shield')}</>}
        <div className="sidefoot">
          <SyncPill />
          <button type="button" className="me" aria-label="Account menu" onClick={() => S.logout()}><span className="avatar">{initial(me.name)}</span><span className="who"><b>{me.name}</b><small>{t?.role ?? (me.admin ? 'instance admin' : '')}</small></span></button>
        </div>
      </aside>
      <div className="content" data-path={pathname}>
        <section className="master" id="master">{master}</section>
        {!single && <section className="detail" id="detail">{detail ?? <div className="placeholder"><Icon name="specs" size={40} /><p>Select a spec, or create one with “New”.</p></div>}</section>}
      </div>
      <nav className="tabbar" id="tabbar" aria-label="Main">
        {link('/', 'Specs', 'specs')}{link('/docs', 'Docs', 'docs')}{link('/release', 'Release', 'release')}{link('/sync', 'Sync', 'sync')}
      </nav>
    </div>
  );
}
