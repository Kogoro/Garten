import { Suspense, lazy, useEffect, useState, type ComponentType } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { MenuHost } from './dialogs';
import { ReloginSheet } from './sheets';
import { InvitePage } from './pages/Invite';
import { Login } from './pages/Login';
import { NoTeamPage } from './pages/NoTeam';
import { SpecsPage } from './pages/Specs';
import { Palette } from './Palette';
import { Shell } from './Shell';
import { Toaster, useStore } from './ui';

// The first screens (sign-in, invitation, specs with the editor shell) are in the entry chunk; every other section loads when it
// is opened. Those chunks are in the service-worker precache, so they open offline just like the first screen.
const page = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) => lazy(() => load().then((m) => ({ default: m[name] })));
const AccountPage = page(() => import('./pages/Account'), 'AccountPage');
const AdminPage = page(() => import('./pages/Admin'), 'AdminPage');
const DocsPage = page(() => import('./pages/Docs'), 'DocsPage');
const GardenPage = page(() => import('./pages/Garden'), 'GardenPage');
const GlossaryPage = page(() => import('./pages/Glossary'), 'GlossaryPage');
const ReleasePage = page(() => import('./pages/Release'), 'ReleasePage');
const SyncPage = page(() => import('./pages/Sync'), 'SyncPage');
const TeamPage = page(() => import('./pages/Team'), 'TeamPage');
/** While a section loads: sidebar and tab bar stay, the page shows the same skeleton as the editor. */
const PageLoading = () => <Shell single master={<div className="scroll"><div className="page"><div className="editor-skeleton" role="status" aria-label="Loading"><i /><i /><i /></div></div></div>} />;

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
    <Suspense fallback={<PageLoading />}><Routes>
      <Route path="/" element={<SpecsPage />} />
      <Route path="/spec/:id" element={<SpecsPage />} />
      <Route path="/docs" element={<DocsPage />} />
      <Route path="/doc/*" element={<DocsPage />} />
      <Route path="/glossary/*" element={<GlossaryPage />} />
      <Route path="/release" element={<ReleasePage />} />
      <Route path="/garden" element={<GardenPage />} />
      <Route path="/sync" element={<SyncPage />} />
      <Route path="/team" element={<TeamPage />} />
      <Route path="/account" element={<AccountPage />} />
      <Route path="/admin" element={<AdminPage />} />
      <Route path="*" element={<Navigate to="/" />} />
    </Routes></Suspense>
  );
  return <>{body}<Palette /><MenuHost />{relogin && <ReloginSheet onClose={() => setRelogin(false)} />}<Toaster /></>;
}
