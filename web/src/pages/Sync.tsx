import { useState } from 'react';
import { Bar, Shell } from '../Shell';
import { ConflictSheet, ReloginSheet } from '../sheets';
import { Icon, ago, toast, useStore } from '../ui';

export function SyncPage() {
  const S = useStore();
  const [sheet, setSheet] = useState<null | { t: 'relogin' } | { t: 'conflict'; id: string }>(null);
  const st = S.state, q = S.queue(), conf = S.conflicts(), answers = S.fbPending();
  const others = S.otherTeams().filter((t: any) => t.pending || t.conflicts);
  const t = S.team();
  return (
    <Shell single master={<>
      <Bar title="Sync" />
      <div className="scroll"><div className="page">
        <section className="card">
          <div className="card-head"><h2>{st.sessionExpired ? 'Signed out' : !st.online ? 'Offline' : st.syncing ? 'Syncing…' : 'Online'}</h2><span className="muted" style={{ fontSize: 12 }}>{st.lastSync ? `Last sync ${ago(st.lastSync)}` : 'Never synced'}</span></div>
          <p className="note">Everything is saved on this device and syncs when your server is reachable. Approved specs reach your agent after the next sync.</p>
          <span className="mono" style={{ fontSize: 13, color: 'var(--soft)' }}>{location.origin}</span>
          <span className="muted" style={{ fontSize: 13 }}>Signed in as {st.me?.name}{t ? ` · ${t.name} (${t.role})` : ''}</span>
          {st.error && <span className="err-text">{st.error}</span>}
          <div className="btns"><button className="btn primary" data-act="retry" disabled={st.syncing} onClick={async () => { await S.sync(); toast(S.state.error ?? 'Synced'); }}>Retry now</button>{st.sessionExpired && <button className="btn" data-act="relogin" onClick={() => setSheet({ t: 'relogin' })}>Sign in</button>}</div>
        </section>
        <section>
          <div className="sect-title"><span>Waiting to sync · {t?.name}</span><small style={{ color: q.length + answers ? 'var(--amber)' : 'var(--muted)' }}>{q.length + answers} change{q.length + answers === 1 ? '' : 's'}</small></div>
          {answers > 0 && <div className="q"><div className="l"><span>{answers} answer{answers === 1 ? '' : 's'} / triage action{answers === 1 ? '' : 's'} in the Garden</span></div></div>}
          {q.length ? q.map((c) => <div className="q" key={c.id}><div className="l"><span>{c.what}</span><span>{c.id}</span>{c.error && <span className="err">{c.error}</span>}</div><span className="r">{ago(c.at)}</span></div>) : answers > 0 ? null : <div className="kv" style={{ borderBottom: '1px solid var(--line)' }}><span className="muted">Nothing waiting — all changes are on the server.</span></div>}
          {others.map((o: any) => <div className="kv" key={o.id}><span>{o.name}</span><span style={{ color: 'var(--amber)' }}>{o.pending} pending{o.conflicts ? ` · ${o.conflicts} conflict(s)` : ''}</span></div>)}
        </section>
        {conf.map((c) => <section className="card bad" key={c.id}><span style={{ color: 'var(--red)' }}><Icon name="warn" size={20} /></span><div className="grow"><b>Conflict in {c.id}</b><span>Changed on the server and on this device.</span></div><button className="btn danger" onClick={() => setSheet({ t: 'conflict', id: c.id })}>Review</button></section>)}
        <section><div className="sect-title"><span>Storage</span></div>
          <div className="kv"><span>Format</span><span>Markdown files in a Git repo per team</span></div>
          <div className="kv"><span>On this device</span><span>{S.all('spec').length} specs · {S.all('doc').length} documents</span></div>
          <div className="kv"><span>Offline app</span><span>{'serviceWorker' in navigator && navigator.serviceWorker.controller ? 'Installed' : isSecureContext ? 'Installing…' : 'Needs HTTPS'}</span></div></section>
      </div></div>
      {sheet?.t === 'relogin' && <ReloginSheet onClose={() => setSheet(null)} />}
      {sheet?.t === 'conflict' && <ConflictSheet id={sheet.id} onClose={() => setSheet(null)} />}
    </>} />
  );
}
