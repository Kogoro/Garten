import { useState, type FormEvent } from 'react';
import { Icon, useStore } from '../ui';

export function Login() {
  const S = useStore();
  const [err, setErr] = useState<string | null>(new URLSearchParams(location.search).get('login_error'));
  const cfg = S.state.authConfig;
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try { await S.login(String(f.get('email')), String(f.get('password'))); } catch (x: any) { setErr(x.message); }
  }
  return (
    <div className="login">
      <form className="login-card" id="loginForm" onSubmit={submit}>
        <span className="logo big"><Icon name="specs" size={28} /></span>
        <h1>Specs</h1>
        <p>Specifications for you and your AI agents. Works offline once you are signed in.</p>
        {err && <div className="err-text" role="alert">{err}</div>}
        <label className="sr" htmlFor="email">E-mail</label><input className="field" id="email" name="email" type="email" placeholder="E-mail" autoComplete="username" required />
        <label className="sr" htmlFor="password">Password</label><input className="field" id="password" name="password" type="password" placeholder="Password" autoComplete="current-password" required />
        <button className="btn primary" type="submit">Sign in</button>
        {cfg?.oidc && <a className="btn" href="/auth/oidc/login">{cfg.oidc.name}</a>}
        {!S.state.online && <p className="err-text">You are offline – sign in needs a connection the first time.</p>}
      </form>
    </div>
  );
}
