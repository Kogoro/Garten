// Sharing between teams in the app (docs/SHARED-SPECS.md): parent and child teams, the inherited foundation and its updates,
// sharing documents, folders and specs with other teams, reading what other teams shared, pinned links with "Update available",
// specs that implement other specs, and adopting copies.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Sheet, FormError } from './dialogs';
import { guard } from './hooks';
import { Icon, ago, toast, useStore } from './ui';
import { Md } from './glossaryLib';
import { enc, CORE_LABEL } from './lib';
import type { Inherited, TeamBrief } from './store/core';
import type { Item } from './store/types';
import { specCriteria } from '@shared/criteria.js';

type Store = ReturnType<typeof useStore>;
const NO_TERMS = new Map<string, string>();
const when = (iso?: string | null) => (iso ? ago(Date.parse(iso)) : '');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Line diff (longest common subsequence) for the short files of a foundation update or a shared document. */
export function lineDiff(a: string, b: string): { t: ' ' | '+' | '-'; s: string }[] {
  const x = String(a ?? '').split('\n'),
    y = String(b ?? '').split('\n');
  if (x.length * y.length > 400_000) return [...x.map((s) => ({ t: '-' as const, s })), ...y.map((s) => ({ t: '+' as const, s }))];
  const m = x.length,
    n = y.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { t: ' ' | '+' | '-'; s: string }[] = [];
  let i = 0,
    j = 0;
  while (i < m && j < n) {
    if (x[i] === y[j]) {
      out.push({ t: ' ', s: x[i++] });
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: '-', s: x[i++] });
    else out.push({ t: '+', s: y[j++] });
  }
  while (i < m) out.push({ t: '-', s: x[i++] });
  while (j < n) out.push({ t: '+', s: y[j++] });
  return out;
}
export function Diff({ before, after }: { before: string; after: string }) {
  const lines = lineDiff(before, after);
  return (
    <pre className="diffview" aria-label="Changes">
      {lines.map((l, k) => (
        <span key={k} className={l.t === '+' ? 'add' : l.t === '-' ? 'del' : ''}>
          {l.t} {l.s}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

/** "From ACME" chip for inherited or shared content. */
export const FromChip = ({ team, title }: { team: string; title?: string }) => (
  <span className="chip from" title={title ?? `From team ${team}`}>
    <Icon name="link" size={11} /> {team}
  </span>
);

// ------------------------------------------------------------------ Members & Git → Sharing
/** How many things about sharing wait for this person (requests, shares to accept, foundation updates). */
export function sharingWaiting(S: Store) {
  const s = S.sharing();
  return (
    (S.can('admin') ? s.links.incoming.length : 0) +
    (S.can('approve') ? s.sharedWith.filter((x: any) => !x.accepted).length + s.inherited.filter((a) => a.update).length : 0)
  );
}

export function SharingTab() {
  const S = useStore();
  const s = S.sharing();
  const admin = S.can('admin');
  const approver = S.can('approve');
  const online = S.state.online && !S.state.sessionExpired;
  const [child, setChild] = useState('');
  const [err, setErr] = useState('');
  const [review, setReview] = useState<Inherited | null>(null);
  const [shareOf, setShareOf] = useState<null | { itemId: string; kind: string }>(null);
  useEffect(() => {
    if (online) S.loadSharing().catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const t = S.team()!;
  const candidates = s.teams.filter(
    (x) => x.id !== s.parent?.id && !s.children.some((c) => c.id === x.id) && !s.ancestors.some((a) => a.id === x.id),
  );
  return (
    <>
      <section className="card" id="treeCard">
        <div className="card-head">
          <h2>Parent and child teams</h2>
        </div>
        <p className="note">
          A child team inherits the vision, strategy, guardrails and glossary of its parent teams. Its agents follow the parent guardrails,
          which it cannot relax. Members and drafts are never shared.
        </p>
        <div className="kv">
          <span>Parent team</span>
          <span>
            {s.parent ? (
              <>
                <b>{s.parent.name}</b> <span className="mono muted">{s.parent.key}</span>
              </>
            ) : (
              <span className="muted">None</span>
            )}
          </span>
        </div>
        {s.ancestors.length > 1 && (
          <div className="kv">
            <span>Above that</span>
            <span>
              {s.ancestors
                .slice(1)
                .map((a) => a.name)
                .join(' › ')}
            </span>
          </div>
        )}
        {s.links.incoming.map((r) => (
          <div className="card soft notice-row" key={r.team.id} data-req={r.team.key}>
            <div className="grow">
              <b>{r.team.name}</b> wants to be your parent team{r.requestedBy ? ` (asked by ${r.requestedBy})` : ''}.
              <div className="muted">Your agents then follow its guardrails, and you inherit its vision, strategy and glossary.</div>
            </div>
            {admin && (
              <div className="btns">
                <button
                  className="btn primary"
                  data-act="accept-parent"
                  disabled={!online}
                  onClick={guard(async () => {
                    await S.acceptParent(r.team.id);
                    toast(`${r.team.name} is now your parent team`);
                  })}
                >
                  Accept
                </button>
                <button className="btn" disabled={!online} onClick={guard(() => S.declineParent(r.team.id))}>
                  Decline
                </button>
              </div>
            )}
          </div>
        ))}
        {s.parent && admin && (
          <div className="btns">
            <button
              className="btn small"
              data-act="unlink-parent"
              disabled={!online}
              onClick={guard(async () => {
                if (
                  !confirm(
                    `End the link to ${s.parent!.name}? Your agents no longer get its guardrails, vision and glossary. Adopt what you want to keep as your own documents first.`,
                  )
                )
                  return;
                await S.unlinkParent();
                toast('Link ended');
              })}
            >
              End link to parent team
            </button>
          </div>
        )}
        <div className="sect-title" style={{ margin: '12px 0 4px' }}>
          <span>Child teams</span>
          <small>{s.children.length}</small>
        </div>
        {s.children.length ? (
          s.children.map((c) => (
            <div className="kv" key={c.id}>
              <span>
                <b>{c.name}</b> <span className="mono muted">{c.key}</span>
              </span>
              {admin && (
                <button
                  className="btn small"
                  aria-label={`Remove ${c.name} as child team`}
                  disabled={!online}
                  onClick={guard(async () => {
                    if (!confirm(`${c.name} stops inheriting the foundation of ${t.name}. Continue?`)) return;
                    await S.removeChild(c.id);
                  })}
                >
                  Remove
                </button>
              )}
            </div>
          ))
        ) : (
          <p className="muted">No child teams.</p>
        )}
        {s.links.outgoing.map((r) => (
          <div className="kv" key={r.team.id}>
            <span>
              <b>{r.team.name}</b> <span className="chip">waiting for their admin</span>
            </span>
            {admin && (
              <button className="btn small" disabled={!online} onClick={guard(() => S.removeChild(r.team.id))}>
                Withdraw
              </button>
            )}
          </div>
        ))}
        {admin && (
          <form
            className="form"
            id="childForm"
            onSubmit={guard(async (e) => {
              e.preventDefault();
              setErr('');
              try {
                await S.requestChild(child);
                toast('Asked – their team admin accepts it');
                setChild('');
              } catch (x: any) {
                setErr(x.message);
              }
            })}
          >
            <label className="field-lbl" htmlFor="child-key">
              Add a child team
            </label>
            <div className="btns">
              <select id="child-key" className="field" value={child} onChange={(e) => setChild(e.target.value)} style={{ flex: 3 }}>
                <option value="">Choose a team…</option>
                {candidates.map((x) => (
                  <option key={x.id} value={x.key}>
                    {x.name} ({x.key})
                  </option>
                ))}
              </select>
              <button className="btn" type="submit" disabled={!online || !child}>
                Ask
              </button>
            </div>
            <FormError msg={err} />
          </form>
        )}
      </section>

      {s.inherited.length > 0 && (
        <section className="card" id="inheritCard">
          <div className="card-head">
            <h2>Inherited foundation</h2>
          </div>
          <p className="note">Your agents build against these versions. A newer version reaches them once an approver accepts it.</p>
          {s.inherited.map((a) => (
            <div className="inh" key={a.team.id} data-anc={a.team.key}>
              <div className="kv">
                <span>
                  <b>{a.team.name}</b> foundation <b>v{a.pinned}</b>
                </span>
                <span className="muted">
                  {plural(a.rules.length, 'rule')} · {plural(a.terms.length, 'word')} · {plural(a.docs.length, 'document')}
                </span>
              </div>
              {a.forced.length > 0 && (
                <p className="note warn-text">
                  Required by {a.team.key} and applied: {a.forced.map((f) => `${a.team.key}/${f}`).join(', ')}
                </p>
              )}
              {a.update && (
                <div className="card soft notice-row" data-act="foundation-update">
                  <div className="grow">
                    <b>Update available: v{a.update.version}</b> · {plural(a.update.changes.length, 'change')}
                    {a.update.since ? ` · waiting since ${when(a.update.since)}` : ''}
                    {a.update.required.length > 0 && (
                      <div className="muted">
                        Required: {a.update.required.map((r) => `${a.team.key}/${r.id} by ${r.requiredBy}`).join(', ')} – applied by itself
                        after that date.
                      </div>
                    )}
                  </div>
                  <button className="btn" data-act="review-foundation" onClick={() => setReview(a)}>
                    Review
                  </button>
                </div>
              )}
            </div>
          ))}
        </section>
      )}

      <section className="card" id="sharedWithCard">
        <div className="card-head">
          <h2>Shared with {t.name}</h2>
          <small className="muted">{s.sharedWith.length}</small>
        </div>
        {s.sharedWith.length ? (
          s.sharedWith.map((x: any) => (
            <div className="kv" key={`${x.owner.id}|${x.itemId}`} data-shared={`${x.owner.key}/${x.itemId}`}>
              <span>
                <FromChip team={x.owner.key} /> <span className="mono">{x.itemId}</span>{' '}
                <span className="muted">
                  {x.kind === 'folder' ? `folder · ${plural(x.items.length, 'document')}` : x.kind}
                  {!x.accepted && ' · waiting for you'}
                </span>
              </span>
              {approver && (
                <span className="btns">
                  {!x.accepted && (
                    <button
                      className="btn primary small"
                      data-act="accept-share"
                      disabled={!online}
                      onClick={guard(async () => {
                        await S.answerShare(x.owner.id, x.itemId, true);
                        toast(`${x.itemId} from ${x.owner.key} is available to your team and agents`);
                      })}
                    >
                      Accept
                    </button>
                  )}
                  <button
                    className="btn small"
                    disabled={!online}
                    onClick={guard(async () => {
                      if (x.accepted && !confirm(`End this share? Released specs that link a version keep reading it.`)) return;
                      await S.answerShare(x.owner.id, x.itemId, false);
                    })}
                  >
                    {x.accepted ? 'End' : 'Decline'}
                  </button>
                </span>
              )}
            </div>
          ))
        ) : (
          <p className="muted">Nothing yet. Other teams share documents, folders and specs from their pages.</p>
        )}
      </section>

      <section className="card" id="sharesCard">
        <div className="card-head">
          <h2>Shared by {t.name}</h2>
          <small className="muted">{s.shares.length}</small>
        </div>
        {s.shares.length ? (
          s.shares.map((x: any) => (
            <div className="share-row" key={x.itemId} data-share={x.itemId}>
              <div className="kv">
                <span>
                  <span className="mono">{x.itemId}</span>{' '}
                  <span className="muted">
                    with{' '}
                    {x.audience === 'children'
                      ? 'child teams'
                      : x.audience === 'descendants'
                        ? 'all teams below'
                        : x.teams.map((r: any) => `${r.key}${r.accepted ? '' : ' (not accepted yet)'}`).join(', ')}
                  </span>
                </span>
                {approver && (
                  <button className="btn small" onClick={() => setShareOf({ itemId: x.itemId, kind: x.kind })}>
                    Change
                  </button>
                )}
              </div>
              {x.usedBy.length > 0 && (
                <ul className="usedby">
                  {x.usedBy.map((u: any) => (
                    <li key={`${u.team.key}|${u.specId}|${u.itemId}`}>
                      {u.team.key} · {u.specId} {u.implements ? 'implements' : 'links'} {u.itemId} <b>v{u.version}</b>
                      {u.newest > u.version && <span className="muted"> (v{u.newest} is out)</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))
        ) : (
          <p className="muted">Share a document, a folder or a spec from its menu: “Share with teams…”.</p>
        )}
      </section>
      {review && <FoundationSheet a={review} onClose={() => setReview(null)} />}
      {shareOf && <ShareSheet itemId={shareOf.itemId} kind={shareOf.kind} onClose={() => setShareOf(null)} />}
    </>
  );
}

/** What changed in a newer foundation version of a parent team; an approver accepts it. */
export function FoundationSheet({ a, onClose }: { a: Inherited; onClose: () => void }) {
  const S = useStore();
  const [changes, setChanges] = useState<{ id: string; change: string; before?: string; after?: string }[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    S.foundationDiff(a.team.id, a.pinned, a.update!.version)
      .then(setChanges)
      .catch((e) => setErr(e.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Sheet onClose={onClose} wide>
      <h2>
        {a.team.name}: v{a.pinned} → v{a.update!.version}
      </h2>
      <p className="note">
        Accepting changes what your agents build against. New or reworded rules put built specs back on their work list.
      </p>
      <FormError msg={err} />
      {changes ? (
        changes.map((c) => (
          <details key={c.id} open={changes.length <= 3}>
            <summary>
              <span className={`chip ${c.change === 'removed' ? 'bad' : c.change === 'added' ? 'ok' : ''}`}>{c.change}</span>{' '}
              <span className="mono">{c.id}</span>
            </summary>
            <Diff before={c.before ?? ''} after={c.after ?? ''} />
          </details>
        ))
      ) : (
        <p className="muted">{err ? '' : 'Loading…'}</p>
      )}
      <div className="btns">
        <button className="btn" onClick={onClose}>
          Later
        </button>
        {S.can('approve') && (
          <button
            className="btn primary"
            data-act="accept-foundation"
            onClick={guard(async () => {
              await S.acceptFoundation(a.team.id, a.update!.version);
              toast(`Foundation v${a.update!.version} of ${a.team.key} accepted`);
              onClose();
            })}
          >
            Accept v{a.update!.version}
          </button>
        )}
      </div>
    </Sheet>
  );
}

/** An approver shares a document, a folder or a spec with other teams. */
export function ShareSheet({ itemId, kind, onClose }: { itemId: string; kind: string; onClose: () => void }) {
  const S = useStore();
  const s = S.sharing();
  const cur = s.shares.find((x: any) => x.itemId === itemId);
  const [audience, setAudience] = useState<'children' | 'descendants' | 'teams'>(
    cur?.audience ?? (s.children.length ? 'children' : 'teams'),
  );
  const [picked, setPicked] = useState<string[]>(cur?.audience === 'teams' ? cur.teams.map((t: any) => t.key) : []);
  const [err, setErr] = useState('');
  const others = s.teams;
  const toggle = (k: string) => setPicked(picked.includes(k) ? picked.filter((x) => x !== k) : [...picked, k]);
  return (
    <Sheet onClose={onClose}>
      <h2>Share {kind === 'folder' ? 'folder' : kind} with teams</h2>
      <p className="mono" style={{ marginTop: -6 }}>
        {itemId}
      </p>
      <p className="note">
        Other teams read only what bloomed, never drafts. They accept once, and each of their specs links one version: a newer version
        reaches them when they update the link.
        {kind === 'folder' ? ' Documents you add to the folder later are shared too.' : ''}
      </p>
      <fieldset className="radios">
        <legend className="sr">Share with</legend>
        {s.children.length > 0 && (
          <label className="check">
            <input type="radio" name="aud" checked={audience === 'children'} onChange={() => setAudience('children')} /> Child teams (
            {s.children.map((c) => c.key).join(', ')})
          </label>
        )}
        {s.children.length > 0 && (
          <label className="check">
            <input type="radio" name="aud" checked={audience === 'descendants'} onChange={() => setAudience('descendants')} /> All teams
            below this one
          </label>
        )}
        <label className="check">
          <input type="radio" name="aud" data-act="aud-teams" checked={audience === 'teams'} onChange={() => setAudience('teams')} /> Teams
          I choose
        </label>
      </fieldset>
      {audience === 'teams' && (
        <div className="pick-teams" id="shareTeams">
          {others.length ? (
            others.map((t: TeamBrief) => (
              <label className="check" key={t.id}>
                <input type="checkbox" data-team={t.key} checked={picked.includes(t.key)} onChange={() => toggle(t.key)} /> {t.name}{' '}
                <span className="mono muted">{t.key}</span>
              </label>
            ))
          ) : (
            <p className="muted">There is no other team on this server.</p>
          )}
        </div>
      )}
      <FormError msg={err} />
      <div className="btns">
        {cur && (
          <button
            className="btn ghost"
            onClick={guard(async () => {
              if (!confirm('Stop sharing? Released specs of other teams keep reading the version they link.')) return;
              await S.unshareItem(itemId);
              toast('No longer shared');
              onClose();
            })}
          >
            Stop sharing
          </button>
        )}
        <span className="grow" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          data-act="do-share"
          disabled={audience === 'teams' && !picked.length}
          onClick={async () => {
            setErr('');
            try {
              await S.shareItem(itemId, audience, picked);
              toast(audience === 'teams' ? `Shared – ${picked.join(', ')} accept${picked.length === 1 ? 's' : ''} it once` : 'Shared');
              onClose();
            } catch (e: any) {
              setErr(e.message);
            }
          }}
        >
          Share
        </button>
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ Documents and Specs: what other teams shared, what is inherited
/** List section below a team's own documents or specs: shared items of other teams, and (documents) the inherited foundation. */
export function SharedSection({ kind, selected }: { kind: 'doc' | 'spec'; selected?: string }) {
  const S = useStore();
  const items = S.sharedItems().filter((i: any) => (kind === 'spec' ? i.kind === 'spec' : i.kind !== 'spec'));
  const inherited = kind === 'doc' ? S.sharing().inherited.filter((a) => a.docs.length) : [];
  const waiting = S.sharing().sharedWith.filter((x: any) => !x.accepted).length;
  if (!items.length && !inherited.length && !waiting) return null;
  const byOwner = new Map<string, any[]>();
  for (const i of items) byOwner.set(i.owner.key, [...(byOwner.get(i.owner.key) ?? []), i]);
  const base = kind === 'spec' ? '/spec/' : '/doc/';
  return (
    <div className="shared-sect" id={`shared-${kind}`}>
      {inherited.map((a) => (
        <div key={a.team.id}>
          <div className="sect-title" style={{ marginTop: 14 }}>
            <span>Inherited from {a.team.name}</span>
            <small>v{a.pinned}</small>
          </div>
          {a.docs.map((d) => (
            <Link
              key={d.id}
              className={`row docrow ${selected === `~${a.team.key}/${d.id}` ? 'active' : ''}`}
              to={`${base}${enc(`~${a.team.key}/${d.id}`)}`}
            >
              <div className="row-top">
                <span className="row-title">{CORE_LABEL[d.id] ?? d.id}</span>
                <FromChip team={a.team.key} />
              </div>
              <div className="row-meta">
                <span>Read-only · every agent of your team reads it</span>
              </div>
            </Link>
          ))}
        </div>
      ))}
      {[...byOwner].map(([key, list]) => (
        <div key={key}>
          <div className="sect-title" style={{ marginTop: 14 }}>
            <span>From {list[0].owner.name}</span>
            <small>{list.length}</small>
          </div>
          {list.map((i: any) => {
            const pins = S.all('spec')
              .flatMap((s) => s.links.concat(s.implements ? [s.implements] : []))
              .map((l) => S.parseSharedRef(l))
              .filter((r) => r && r.key === key && r.id === i.id)
              .map((r) => r!.version ?? 0);
            const pinned = pins.length ? Math.max(...pins) : 0;
            return (
              <Link key={i.ref} className={`row docrow ${selected === i.ref ? 'active' : ''}`} to={`${base}${enc(i.ref)}`} data-ref={i.ref}>
                <div className="row-top">
                  <span className={`row-title ${kind === 'doc' ? 'mono' : ''}`} style={kind === 'doc' ? { fontSize: 13.5 } : undefined}>
                    {kind === 'spec' ? i.title : i.id}
                  </span>
                  <FromChip team={key} />
                </div>
                <div className="row-meta">
                  <span>
                    {kind === 'spec' ? <span className="mono">{i.id} · </span> : null}v{i.newest}
                    {pinned ? (pinned < i.newest ? ` · you link v${pinned}` : ' · linked') : ''}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      ))}
      {waiting > 0 && (
        <p className="note" style={{ padding: '8px 4px' }}>
          {plural(waiting, 'share')} from other teams wait{waiting === 1 ? 's' : ''} to be accepted:{' '}
          <Link to="/team?tab=sharing">Members &amp; Git → Sharing</Link>
        </p>
      )}
    </div>
  );
}

/** Read view of an item another team shared (@KEY/path): one version, its versions, where this team links it, Adopt. */
export function SharedView({ refId }: { refId: string }) {
  const S = useStore();
  const nav = useNavigate();
  const r = S.parseSharedRef(refId);
  const [version, setVersion] = useState<number | undefined>(r?.version ?? undefined);
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  const [compare, setCompare] = useState<string | null>(null);
  const known = S.sharedItems().find((i: any) => r && i.owner.key === r.key && i.id === r.id);
  useEffect(() => {
    setErr('');
    S.sharedItem(refId, version)
      .then(setData)
      .catch((e) => setErr(e.message));
  }, [refId, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const linkers = S.all('spec').filter((s) =>
    s.links.concat(s.implements ? [s.implements] : []).some((l) => {
      const x = S.parseSharedRef(l);
      return x && r && x.key === r.key && x.id === r.id;
    }),
  );
  const it = data?.item;
  const back = it?.kind === 'spec' || refId.match(/^@[^/]+\/[A-Za-z0-9_-]+$/) ? '/specs' : '/docs';
  return (
    <div className="gdetail" id="sharedView" data-ref={refId}>
      <header className="bar">
        <Link className="icon-btn back" to={back} aria-label="Back">
          <Icon name="back" />
        </Link>
        <h1 className={it?.kind === 'spec' ? '' : 'mono'} style={it?.kind === 'spec' ? undefined : { fontSize: 15 }}>
          {it ? (it.kind === 'spec' ? it.title : it.id) : (r?.id ?? refId)}
        </h1>
        {r && <FromChip team={r.key} />}
        {it && <span className="chip ok">Bloom v{it.version}</span>}
      </header>
      <div className="gd-meta">
        {it ? (
          <>
            {it.owner.name} · {it.by ? `${it.by} · ` : ''}
            {when(it.at)}
            {it.revoked ? ' · no longer shared or revoked by its owner' : ''}
          </>
        ) : null}
      </div>
      <div className="scroll">
        <div className="page gd">
          {err && <p className="bad-text">{err}</p>}
          {!err && !it && <p className="muted">{S.state.online ? 'Loading…' : 'Other teams’ items need a connection the first time.'}</p>}
          {it && (
            <>
              <div className="btns">
                {data.versions.length > 1 && (
                  <>
                    <label className="sr" htmlFor="sv-version">
                      Version
                    </label>
                    <select
                      id="sv-version"
                      className="field"
                      style={{ maxWidth: 160 }}
                      value={it.version}
                      onChange={(e) => setVersion(Number(e.target.value))}
                    >
                      {data.versions.map((v: any) => (
                        <option key={v.version} value={v.version}>
                          v{v.version} · {when(v.at)}
                        </option>
                      ))}
                    </select>
                  </>
                )}
                {S.can('write') && (
                  <button
                    className="btn"
                    data-act="adopt"
                    onClick={guard(async () => {
                      const as = prompt(
                        'Adopt as your own copy. Name of the copy in your team:',
                        it.kind === 'spec' ? '' : it.id.replace(/(\.[a-z]+)$/i, `-${it.owner.key.toLowerCase()}$1`),
                      );
                      if (as === null) return;
                      const copy = await S.adopt(it.ref, as || undefined);
                      toast(`Adopted as ${copy.id} – your own draft now`);
                      nav(copy.kind === 'spec' ? `/spec/${enc(copy.id)}` : `/doc/${enc(copy.id)}`);
                    })}
                  >
                    Adopt as own copy
                  </button>
                )}
                {it.kind === 'spec' && S.can('write') && (
                  <button
                    className="btn primary"
                    data-act="new-implementing"
                    onClick={() => {
                      const id = S.createSpec().id;
                      const crit = specCriteria(it.body)
                        .filter((c: any) => c.id.startsWith('AC'))
                        .map((c: any) => `- [ ] ${c.text} (→ ${c.id})`)
                        .join('\n');
                      S.edit(id, {
                        title: it.title,
                        body: `## Acceptance criteria\n${crit || '- [ ] '}\n`,
                        implements: `@${it.owner.key}/${it.id}@v${it.version}`,
                      });
                      toast(`New spec implementing ${it.owner.key}/${it.id} v${it.version}`);
                      nav(`/spec/${enc(id)}`);
                    }}
                  >
                    New spec implementing this…
                  </button>
                )}
                {data.versions.length > 1 && it.version > 1 && (
                  <button
                    className="btn ghost"
                    onClick={guard(async () => setCompare((await S.sharedItem(refId, it.version - 1)).item.body))}
                  >
                    Changes since v{it.version - 1}
                  </button>
                )}
              </div>
              {compare !== null && <Diff before={compare} after={it.body} />}
              {linkers.length > 0 && (
                <p className="note">
                  Your specs:{' '}
                  {linkers.map((s, k) => (
                    <span key={s.id}>
                      {k ? ', ' : ''}
                      <Link to={`/spec/${enc(s.id)}`}>{s.id}</Link>
                    </span>
                  ))}
                  {known && known.newest > (it.version ?? 0) ? ` · v${known.newest} is out` : ''}
                </p>
              )}
              <section className="gd-def shared-body">
                {/\.(ya?ml|json|txt)$/.test(it.id) ? (
                  <pre className="codeview">{it.body}</pre>
                ) : (
                  <Md text={it.body.replace(/^---\n[\s\S]*?\n---\n/, '')} idx={NO_TERMS} />
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Read view of a foundation document inherited from a parent team (~KEY/vision.md). */
export function InheritedView({ refId }: { refId: string }) {
  const S = useStore();
  const nav = useNavigate();
  const m = /^~([A-Z0-9]+)\/(.+)$/.exec(refId);
  const a = S.sharing().inherited.find((x) => x.team.key === m?.[1]);
  const d = a?.docs.find((x) => x.id === m?.[2]);
  return (
    <div className="gdetail" id="inheritedView">
      <header className="bar">
        <Link className="icon-btn back" to="/docs" aria-label="Back">
          <Icon name="back" />
        </Link>
        <h1>{d ? (CORE_LABEL[d.id] ?? d.id) : 'Not found'}</h1>
        {a && <FromChip team={a.team.key} />}
        {a && <span className="chip ok">Foundation v{a.pinned}</span>}
      </header>
      <div className="gd-meta">{a ? `Inherited from ${a.team.name} · read-only · your agents read it after your own` : ''}</div>
      <div className="scroll">
        <div className="page gd">
          {!d ? (
            <p>This team does not inherit it (any more).</p>
          ) : (
            <>
              {S.can('write') && (
                <div className="btns">
                  <button
                    className="btn"
                    data-act="adopt-inherited"
                    onClick={guard(async () => {
                      const copy = await S.adoptInherited(a!.team.key, d.id);
                      toast(`Copied to ${copy.id} – your own document now`);
                      nav(`/doc/${enc(copy.id)}`);
                    })}
                  >
                    Adopt as own copy
                  </button>
                </div>
              )}
              <section className="gd-def">
                <Md text={d.body} idx={NO_TERMS} />
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ the spec editor: links to other teams, implements, implemented by
/** Shown above a spec's content when it links items of other teams, implements a spec, or is implemented by others. */
export function SpecSharingStrip({ item }: { item: Item }) {
  const S = useStore();
  const [implSheet, setImplSheet] = useState(false);
  const shared = item.links.filter((l) => S.isSharedRef(l));
  const impl = item.implements;
  const by = S.sharing().implementedBy[item.id];
  const can = S.can('write');
  if (!shared.length && !impl && !by && !implSheet) return null;
  const implRef = impl && S.isSharedRef(impl) ? S.parseSharedRef(impl) : null;
  const newestImpl = impl && implRef ? S.newestShared(impl) : 0;
  return (
    <section className="share-strip" aria-label="Other teams" id="shareStrip">
      {impl && (
        <div className="kv" data-impl={impl}>
          <span>
            Implements{' '}
            {implRef ? (
              <Link to={`/spec/${enc(`@${implRef.key}/${implRef.id}`)}`}>
                <FromChip team={implRef.key} /> {implRef.id} v{implRef.version}
              </Link>
            ) : (
              <Link to={`/spec/${enc(impl.replace(/@v?\d+$/, ''))}`}>{impl.replace(/@v?(\d+)$/, ' v$1')}</Link>
            )}
            {newestImpl > (implRef?.version ?? 0) && <span className="chip warn">Update available: v{newestImpl}</span>}
          </span>
          {can && (
            <span className="btns">
              {newestImpl > (implRef?.version ?? 0) && (
                <button
                  className="btn small"
                  data-act="update-implements"
                  onClick={() => S.setImplements(item.id, `@${implRef!.key}/${implRef!.id}@v${newestImpl}`)}
                >
                  Update to v{newestImpl}
                </button>
              )}
              <button className="btn small ghost" onClick={() => setImplSheet(true)}>
                Change
              </button>
            </span>
          )}
        </div>
      )}
      {shared.map((l) => {
        const x = S.parseSharedRef(l)!;
        const newest = S.newestShared(l);
        return (
          <div className="kv" key={l} data-link={l}>
            <span>
              <Link to={`/doc/${enc(`@${x.key}/${x.id}`)}`}>
                <FromChip team={x.key} /> <span className="mono">{x.id}</span> v{x.version ?? '?'}
              </Link>
              {newest > (x.version ?? 0) && <span className="chip warn">Update available: v{newest}</span>}
            </span>
            {can && (
              <span className="btns">
                {newest > (x.version ?? 0) && (
                  <button className="btn small" data-act="update-link" onClick={() => S.updateSharedLink(item.id, l, newest)}>
                    Update link
                  </button>
                )}
                <button className="btn small ghost" aria-label={`Remove link to ${l}`} onClick={() => S.toggleLink(item.id, l)}>
                  <Icon name="close" size={12} />
                </button>
              </span>
            )}
          </div>
        );
      })}
      {by && <ImplementedBy by={by} />}
      {implSheet && <ImplementsSheet item={item} onClose={() => setImplSheet(false)} />}
    </section>
  );
}

function ImplementedBy({ by }: { by: { rows: any[]; done: boolean } }) {
  return (
    <div className="implby" id="implementedBy">
      <div className="sect-title" style={{ margin: '6px 0 2px' }}>
        <span>Implemented by</span>
        <small>
          {by.done
            ? 'all done'
            : `${by.rows.filter((r) => r.report?.status === 'implemented' && r.current).length} of ${by.rows.length} done`}
        </small>
      </div>
      {by.rows.map((r) => (
        <div className="kv" key={`${r.team.key}|${r.specId}`}>
          <span>
            <FromChip team={r.team.key} /> {r.specId} <span className="muted">{r.title}</span>
          </span>
          <span className="muted">
            {r.report ? r.report.status.replace('_', ' ') : 'no report yet'}
            {r.implementedVersion ? ` · against v${r.implementedVersion}` : ''}
            {!r.current ? ' · older version' : ''}
            {r.criteria.length > 0 &&
              ` · ${r.criteria.filter((c: any) => c.status === 'met').length}/${r.criteria.length} mapped criteria met`}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Says which spec this one implements: one of the team's own, or one another team shared. */
export function ImplementsSheet({ item, onClose }: { item: Item; onClose: () => void }) {
  const S = useStore();
  const own = S.all('spec').filter((s) => s.id !== item.id);
  const shared = S.sharedItems().filter((i: any) => i.kind === 'spec');
  const [v, setV] = useState(item.implements ? item.implements.replace(/@v?\d+$/, '') : '');
  const options = useMemo(
    () => [
      ...shared.map((i: any) => ({ value: `@${i.owner.key}/${i.id}`, label: `${i.owner.key} · ${i.id} – ${i.title} (v${i.newest})` })),
      ...own.map((s) => ({ value: s.id, label: `${s.id} – ${s.title || 'Untitled'}` })),
    ],
    [shared, own],
  );
  return (
    <Sheet onClose={onClose}>
      <h2>Implements</h2>
      <p className="note">
        The spec this one builds (part of). Its owner sees your reports rolled up. Mark criteria with “(→ AC4)” to map them to the owner’s
        criteria.
      </p>
      <label className="field-lbl" htmlFor="impl-pick">
        Spec
      </label>
      <select id="impl-pick" className="field" value={v} onChange={(e) => setV(e.target.value)}>
        <option value="">Nothing</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <div className="btns">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          data-act="save-implements"
          onClick={() => {
            const sh = S.isSharedRef(v) ? S.newestShared(v) : 0;
            const own1 = !S.isSharedRef(v) && v ? S.get(v) : null;
            S.setImplements(item.id, !v ? null : sh ? `${v}@v${sh}` : own1 ? `${v}@v${own1.version}` : v);
            onClose();
          }}
        >
          Save
        </button>
      </div>
    </Sheet>
  );
}

/** Rows for the "Linked documents" menu of a spec: documents other teams shared, linked at their newest version. */
export function SharedLinkRows({ item, S }: { item: Item; S: Store }): ReactNode {
  const docs = S.sharedItems().filter((i: any) => i.kind !== 'spec');
  if (!docs.length) return null;
  const can = S.can('write');
  return (
    <>
      <div className="dd-sep" />
      <div className="dd-title">From other teams · linked at one version</div>
      {docs.map((d: any) => {
        const on = item.links.find((l) => {
          const x = S.parseSharedRef(l);
          return x && x.key === d.owner.key && x.id === d.id;
        });
        return (
          <div className="ddrow" key={d.ref}>
            <button
              type="button"
              role="menuitemcheckbox"
              data-act="dd-link-shared"
              data-id={d.ref}
              aria-checked={!!on}
              disabled={!can}
              onClick={() => (on ? S.toggleLink(item.id, on) : S.addSharedLink(item.id, d.ref))}
            >
              <span className={`box ${on ? 'on' : ''}`}>{on && <Icon name="check" size={11} />}</span>
              <span className="mono">
                {d.owner.key}/{d.id}
              </span>
              <small className="muted">{on ? `v${S.parseSharedRef(on)?.version}` : `v${d.newest}`}</small>
            </button>
            <Link className="fbtn" to={`/doc/${enc(d.ref)}`} aria-label={`Open ${d.ref}`}>
              <Icon name="file" size={14} />
            </Link>
          </div>
        );
      })}
    </>
  );
}

/** May this item be shared (released content of the team, not part of the foundation that the tree passes on)? */
export const shareable = (i: Item | { id: string; kind: string }) =>
  i.kind === 'folder'
    ? !/^(glossary|guardrails)(\/|$)/.test(i.id)
    : i.kind === 'spec' || (i.kind === 'doc' && !/^(glossary|guardrails)\//.test(i.id) && !CORE_LABEL[i.id]);
