import { Navigate, Route, Routes } from 'react-router-dom';
import { Login } from './pages/Login';
import { SpecsPage } from './pages/Specs';
import { Shell, Bar } from './Shell';
import { Toaster, useStore } from './ui';

const Todo = ({ name }: { name: string }) => <Shell single master={<><Bar title={name} /><div className="scroll"><div className="page"><p className="muted">“{name}” is not ported to React yet.</p></div></div></>} />;

export default function App() {
  const S = useStore();
  return (
    <>
      {!S.state.me ? <Login /> : (
        <Routes>
          <Route path="/" element={<SpecsPage />} />
          <Route path="/spec/:id" element={<SpecsPage />} />
          {['docs', 'doc/*', 'glossary', 'glossary/*', 'release', 'sync', 'team', 'account', 'admin'].map((p) => <Route key={p} path={`/${p}`} element={<Todo name={p.split('/')[0]} />} />)}
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      )}
      <Toaster />
    </>
  );
}
