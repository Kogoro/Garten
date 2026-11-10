import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { MenuHost } from './dialogs';
import { ReloginSheet } from './sheets';
import { AccountPage } from './pages/Account';
import { AdminPage } from './pages/Admin';
import { DocsPage } from './pages/Docs';
import { GlossaryPage } from './pages/Glossary';
import { InvitePage } from './pages/Invite';
import { Login } from './pages/Login';
import { NoTeamPage } from './pages/NoTeam';
import { ReleasePage } from './pages/Release';
import { SpecsPage } from './pages/Specs';
import { SyncPage } from './pages/Sync';
import { TeamPage } from './pages/Team';
import { Toaster, useStore } from './ui';

export default function App() {
  const S = useStore();
  const loc = useLocation();
  const [relogin, setRelogin] = useState(false);
  useEffect(() => { window.scrollTo(0, 0); }, [loc.pathname]);
  const invite = loc.pathname.startsWith('/invite/');
  let body;
  if (invite) body = <Routes><Route path="/invite/:token" element={<InvitePage />} /></Routes>;
  else if (!S.state.me) body = <Login />;
  else if (!S.team() && !['/admin', '/account'].includes(loc.pathname)) body = <NoTeamPage />;
  else body = (
    <Routes>
      <Route path="/" element={<SpecsPage />} />
      <Route path="/spec/:id" element={<SpecsPage />} />
      <Route path="/docs" element={<DocsPage />} />
      <Route path="/doc/*" element={<DocsPage />} />
      <Route path="/glossary/*" element={<GlossaryPage />} />
      <Route path="/release" element={<ReleasePage />} />
      <Route path="/sync" element={<SyncPage />} />
      <Route path="/team" element={<TeamPage />} />
      <Route path="/account" element={<AccountPage />} />
      <Route path="/admin" element={<AdminPage />} />
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  );
  return <>{body}<MenuHost />{relogin && <ReloginSheet onClose={() => setRelogin(false)} />}<Toaster /></>;
}
