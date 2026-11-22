import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Sheet } from './dialogs';
import type { Item } from './store/types';
import { Icon, ago, toast, useStore } from './ui';
import { RuleSheet } from './guardrails';

export type Impl = {
  key: 'none' | 'outdated' | 'implemented' | 'partial' | 'blocked' | 'in_progress';
  cls: string;
  text: string;
  rank: number;
};
const met = (r: any) => {
  const c: any[] = r?.criteria ?? [];
  return c.length
    ? ` · ${c.filter((x) => x.status === 'met').length}/${c.length} criteria${r?.verification?.verified ? ` · ${r.verification.verified} verified` : ''}`
    : '';
};

/** Where the implementation of a released spec stands, judged from the newest report an agent filed. */
export function implState(spec: Item, r: any | null): Impl {
  if (!r) return { key: 'none', cls: '', text: 'Not started', rank: 4 };
  if (r.specVersion < spec.version)
    return { key: 'outdated', cls: 'warn', text: `Outdated · built v${r.specVersion}, in bloom v${spec.version}`, rank: 1 };
  if (r.status === 'implemented') return { key: 'implemented', cls: 'ok', text: `Implemented v${r.specVersion}${met(r)}`, rank: 5 };
  if (r.status === 'partial') return { key: 'partial', cls: 'warn', text: `Partly built${met(r)}`, rank: 2 };
  if (r.status === 'blocked') return { key: 'blocked', cls: 'bad', text: 'Blocked', rank: 0 };
  return { key: 'in_progress', cls: 'agent', text: 'In progress', rank: 3 };
}

export function ImplChip({ spec, always }: { spec: Item; always?: boolean }) {
  const S = useStore();
  if (spec.kind !== 'spec' || spec.status !== 'approved') return null;
  const r = S.latestReport(spec.id);
  if (!r && !always) return null;
  const st = implState(spec, r);
  return (
    <span className={`chip impl ${st.cls}`} data-impl={st.key} title="What the agent reported about building this spec">
      {st.text}
    </span>
  );
}

const STATUS: Record<string, string> = {
  implemented: 'Implemented',
  partial: 'Partly built',
  blocked: 'Blocked',
  in_progress: 'In progress',
};
const CRIT: Record<string, [string, string]> = { met: ['ok', 'Met'], deviating: ['warn', 'Deviates'], open: ['', 'Open'] };
const isUrl = (s: string) => /^https?:\/\/\S+$/.test(s);

const CHK: Record<string, [string, string]> = {
  passing: ['ok', 'Passing'],
  failing: ['bad', 'Failing'],
  stale: ['warn', 'Stale'],
  unverified: ['', 'Never ran'],
  retired: ['', 'Retired'],
};

function Checks({ specId, latest }: { specId: string; latest: boolean }) {
  const S = useStore();
  const list: any[] = S.specChecks(specId);
  if (!list.length || !latest) return null;
  const n = (k: string) => list.filter((c) => c.state === k).length;
  return (
    <>
      <div className="sect-title">
        <span>Checks – run again any time</span>
        <small>
          {n('passing')} of {list.length} passing{n('failing') ? ` · ${n('failing')} failing` : ''}
          {n('stale') ? ` · ${n('stale')} stale` : ''}
        </small>
      </div>
      <ul className="rp-chk">
        {list.map((c) => (
          <li key={c.name} data-check={c.name} data-state={c.state}>
            <span className={`chip ${CHK[c.state]?.[0] ?? ''}`}>{CHK[c.state]?.[1] ?? c.state}</span>
            <span className="rp-ref">
              <b>{c.name}</b> <span className="chip">{c.kind}</span>
              <small className="mono">{c.how}</small>
              {c.expect && <small>Passes when: {c.expect}</small>}
              {c.last ? (
                <small>
                  {c.last.status === 'pass' ? 'Passed' : c.last.status === 'fail' ? 'Failed' : 'Errored'}
                  {c.last.value ? ` · ${c.last.value}` : ''} · v{c.last.specVersion} · {ago(Date.parse(c.last.at))} ·{' '}
                  {c.last.source === 'ci' ? 'reported by CI' : 'reported by the agent'}
                  {c.last.ref && /^https?:\/\//.test(c.last.ref) ? (
                    <>
                      {' '}
                      ·{' '}
                      <a href={c.last.ref} target="_blank" rel="noreferrer noopener">
                        run
                      </a>
                    </>
                  ) : (
                    ''
                  )}
                </small>
              ) : (
                <small>Not run yet.</small>
              )}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function Report({ r, latest }: { r: any; latest: boolean }) {
  const S = useStore();
  const [rule, setRule] = useState(false);
  const v = r.verification;
  return (
    <div className="rp">
      <p className="rp-sum">{r.summary}</p>
      {r.criteria?.length > 0 && (
        <>
          <div className="sect-title">
            <span>Acceptance criteria</span>
            <small>
              {r.criteria.filter((c: any) => c.status === 'met').length} of {r.criteria.length} met
              {v ? ` · ${v.verified} verified by checks${v.claimed ? ` · ${v.claimed} only claimed` : ''}` : ''}
            </small>
          </div>
          <ul className="rp-crit">
            {r.criteria.map((c: any, i: number) => (
              <li key={i} data-status={c.status}>
                <span className={`rp-mark ${CRIT[c.status]?.[0] ?? ''}`} title={CRIT[c.status]?.[1]}>
                  {c.status === 'met' ? <Icon name="check" size={12} /> : c.status === 'deviating' ? <Icon name="warn" size={12} /> : null}
                </span>
                <span className="rp-ctext">
                  {c.id && !String(c.text).startsWith(c.id) && <span className="mono rp-cid">{c.id}</span>}
                  {c.text}
                  {c.status !== 'met' && <span className={`chip ${CRIT[c.status]?.[0] ?? ''}`}>{CRIT[c.status]?.[1] ?? c.status}</span>}
                  {c.status === 'met' &&
                    (c.verified ? (
                      <span className="chip ok" title="Every check named for this criterion passes right now">
                        Verified
                      </span>
                    ) : c.checkStates?.some((x: any) => x.state === 'failing') ? (
                      <span className="chip bad">Check failing</span>
                    ) : c.checkStates?.some((x: any) => x.state === 'retired') ? (
                      <span className="chip warn" title="A check named for this criterion was retired since the report">
                        Check retired
                      </span>
                    ) : c.checkStates?.length ? (
                      <span className="chip warn">Check stale</span>
                    ) : (
                      <span className="chip" title="The agent says so, but no check can prove it">
                        Claimed only
                      </span>
                    ))}
                  {c.note && <small>{c.note}</small>}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {r.deviations && (
        <>
          <div className="sect-title">
            <span>Deviations from the spec</span>
          </div>
          <p className="rp-dev">{r.deviations}</p>
          {S.can('write') && (
            <button type="button" className="btn small" data-act="dev-rule" onClick={() => setRule(true)}>
              Make it a rule
            </button>
          )}
          {rule && <RuleSheet initial={r.deviations} source={`the report on ${r.specId}`} onClose={() => setRule(false)} />}
        </>
      )}
      {r.evidence?.length > 0 && (
        <>
          <div className="sect-title">
            <span>Evidence</span>
            <small>{r.evidence.length}</small>
          </div>
          <ul className="rp-ev">
            {r.evidence.map((e: any, i: number) => (
              <li key={i}>
                <span className="chip">{e.kind}</span>
                <span className="rp-ref">
                  {isUrl(e.ref) ? (
                    <a href={e.ref} target="_blank" rel="noreferrer noopener">
                      {e.ref}
                    </a>
                  ) : (
                    <span className="mono">{e.ref}</span>
                  )}
                  {e.note && <small>{e.note}</small>}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <Checks specId={r.specId} latest={latest} />
    </div>
  );
}

/** What an agent reported about building a spec: status, every acceptance criterion, evidence and deviations. Read-only for people. */
export function ReportBody({ specId }: { specId: string }) {
  const S = useStore();
  const spec = S.get(specId);
  const latest = S.latestReport(specId);
  const [history, setHistory] = useState<any[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    S.teamApi('GET', `/reports?spec=${encodeURIComponent(specId)}`)
      .then((d: any) => on && setHistory(d.reports))
      .catch(() => {
        /* offline: only the newest report is on this device */
      });
    return () => {
      on = false;
    };
  }, [specId, latest?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const all: any[] = history ?? (latest ? [latest] : []);
  const r = all.find((x) => x.id === sel) ?? latest ?? all[0] ?? null;
  const st = spec ? implState(spec, latest) : null;
  if (!r)
    return (
      <p className="muted rp-empty">
        No agent has reported on this spec yet.{' '}
        {spec?.status === 'approved'
          ? `v${spec.version} is in bloom – it is on the agent's work list as “new”.`
          : 'Agents only build specs in bloom.'}
      </p>
    );
  return (
    <>
      <div className="rp-head">
        <span className={`chip ${r.id === latest?.id && st ? st.cls : ''}`}>
          {r.id === latest?.id && st ? st.text : `${STATUS[r.status] ?? r.status} v${r.specVersion}`}
        </span>
        <span className="muted">
          {r.via ?? r.author} · {ago(Date.parse(r.createdAt))}
        </span>
      </div>
      {r.id === latest?.id && st?.key === 'outdated' && (
        <p className="note rp-warn">
          This report is about v{r.specVersion}. v{spec!.version} bloomed since – the agent sees the spec as “changed” in its work list.
        </p>
      )}
      <Report r={r} latest={r.id === latest?.id} />
      {all.length > 1 && (
        <>
          <div className="sect-title">
            <span>History</span>
            <small>{all.length} reports</small>
          </div>
          <div className="rp-hist">
            {all.map((x) => (
              <button type="button" key={x.id} className="filter" aria-pressed={x.id === r.id} onClick={() => setSel(x.id)}>
                v{x.specVersion} · {STATUS[x.status] ?? x.status} · {ago(Date.parse(x.createdAt))}
              </button>
            ))}
          </div>
        </>
      )}
      {history === null && !S.state.online && (
        <p className="muted fb-offline">Offline – the newest report is stored on this device; older ones load when you are online.</p>
      )}
    </>
  );
}

/** The same report in a dialog (Agents). */
const PRIO: [string, string][] = [
  ['high', 'High'],
  ['normal', 'Normal'],
  ['low', 'Low'],
];
/** Chips for a spec's steering: priority, hold, dependencies that are not built yet. */
export function SteerChips({ specId }: { specId: string }) {
  const S = useStore();
  const st = S.specSteering(specId);
  return (
    <>
      {st.priority !== 'normal' && (
        <span className={`chip ${st.priority === 'high' ? 'warn' : ''}`} data-steer="priority">
          {st.priority === 'high' ? 'High priority' : 'Low priority'}
        </span>
      )}
      {st.hold && (
        <span className="chip warn" data-steer="hold" title={st.holdNote || 'Agents do not start or continue it'}>
          On hold
        </span>
      )}
      {st.depends.length > 0 && (
        <span className="chip" data-steer="depends">
          After {st.depends.join(', ')}
        </span>
      )}
    </>
  );
}

/** Approvers decide what the agents build next: priority, hold, and which specs come first. Needs a connection. */
function Steering({ specId }: { specId: string }) {
  const S = useStore();
  const st = S.specSteering(specId);
  const [deps, setDeps] = useState(st.depends.join(', '));
  const [note, setNote] = useState(st.holdNote ?? '');
  const [err, setErr] = useState('');
  // shown at once; the server's answer (or a refusal) puts it right afterwards
  const [view, setView] = useState({ priority: st.priority, hold: st.hold });
  useEffect(() => setView({ priority: st.priority, hold: st.hold }), [st.priority, st.hold]);
  if (!S.can('approve')) return null;
  const save = async (patch: any, msg: string) => {
    setErr('');
    setView((v) => ({
      ...v,
      ...('priority' in patch ? { priority: patch.priority } : {}),
      ...('hold' in patch ? { hold: patch.hold } : {}),
    }));
    try {
      await S.steer(specId, patch);
      toast(msg);
    } catch (e: any) {
      setView({ priority: st.priority, hold: st.hold });
      setErr(e instanceof TypeError ? 'Steering needs a connection to the server.' : e.message);
    }
  };
  const depList = deps
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  return (
    <section className="rp-steer" id="rp-steer">
      <div className="sect-title">
        <span>Steering</span>
        <small>what the agents build next</small>
      </div>
      <div className="seg" role="group" aria-label="Priority">
        {PRIO.map(([k, l]) => (
          <button
            key={k}
            type="button"
            className="filter"
            data-prio={k}
            aria-pressed={view.priority === k}
            onClick={() => save({ priority: k }, `Priority: ${l.toLowerCase()}`)}
          >
            {l}
          </button>
        ))}
      </div>
      <label className="check">
        <input
          type="checkbox"
          data-act="steer-hold"
          checked={view.hold}
          onChange={(e) =>
            save(
              { hold: e.target.checked, holdNote: note.trim() },
              e.target.checked ? 'On hold – agents leave it alone' : 'No longer on hold',
            )
          }
        />{' '}
        On hold: agents do not start or continue it
      </label>
      {view.hold && (
        <input
          className="field"
          aria-label="Why it is on hold"
          placeholder="Why (agents see it)"
          value={note}
          maxLength={300}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => note.trim() !== (st.holdNote ?? '') && save({ holdNote: note.trim() }, 'Saved')}
        />
      )}
      <div className="rp-steer-deps">
        <input
          className="field mono"
          aria-label="Build after these specs"
          placeholder="Build after (spec ids, e.g. SPEC-012)"
          value={deps}
          onChange={(e) => setDeps(e.target.value)}
        />
        <button
          type="button"
          className="btn small"
          data-act="steer-deps"
          disabled={depList.join() === st.depends.join()}
          onClick={() => save({ depends: depList }, depList.length ? `Built after ${depList.join(', ')}` : 'No dependencies')}
        >
          Save
        </button>
      </div>
      {err && (
        <p className="note bad" role="alert">
          {err}
        </p>
      )}
    </section>
  );
}

export function ReportSheet({ specId, onClose, link }: { specId: string; onClose: () => void; link?: boolean }) {
  const S = useStore();
  const spec = S.get(specId);
  return (
    <Sheet onClose={onClose}>
      <h2>Implementation of {specId}</h2>
      {spec?.title && <p>{spec.title}</p>}
      <ReportBody specId={specId} />
      {spec?.status === 'approved' && <Steering specId={specId} />}
      {link && (
        <div className="btns" style={{ marginTop: 12 }}>
          <Link className="btn small" to={`/spec/${encodeURIComponent(specId)}`} onClick={onClose}>
            Open spec
          </Link>
        </div>
      )}
    </Sheet>
  );
}
