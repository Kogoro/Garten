// Guardrails: one file per rule (docs/guardrails/<folder>/<rule>.md). Rules are binding on every task; the details say why.
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { parseRuleFile, ruleFolder } from '@shared/guardrailFiles.js';
import { Bar, Shell } from '../Shell';
import { Sheet } from '../dialogs';
import { Tabs } from '../Tabs';
import { Md, glossaryTerms, termIndex } from '../glossaryLib';
import { enc, foundState } from '../lib';
import { usePref } from '../prefs';
import { GrowthIcon } from '../growth';
import { Icon, ago, toast, useStore } from '../ui';
import type { Item } from '../store/types';

const PROPOSED = 'guardrails/_proposed/';
const pathTo = (path: string) => `/${path.split('/').map(enc).join('/')}`;

function KindChip({ kind }: { kind: 'always' | 'never' }) {
  return <span className={`chip ${kind === 'never' ? 'warn' : 'ok'}`}>{kind === 'never' ? 'Never' : 'Always'}</span>;
}

/** New rule, edit a rule, or edit a proposal before accepting it. */
export function RuleFormSheet({
  item,
  initial,
  title,
  submit,
  onSave,
  onClose,
}: {
  item?: Item;
  initial?: { rule?: string; kind?: 'always' | 'never'; body?: string; folder?: string };
  title: string;
  submit: string;
  onSave: (r: { rule: string; kind: 'always' | 'never'; body: string; folder: string; requiredBy?: string | null }) => void;
  onClose: () => void;
}) {
  const S = useStore();
  const cur = item ? parseRuleFile(item.body) : null;
  const [rule, setRule] = useState(initial?.rule ?? cur?.rule ?? '');
  const [kind, setKind] = useState<'always' | 'never'>(initial?.kind ?? cur?.kind ?? 'always');
  const [body, setBody] = useState(initial?.body ?? cur?.body ?? '');
  const [folder, setFolder] = useState(initial?.folder ?? (item && !item.id.startsWith(PROPOSED) ? ruleFolder(item.id) : ''));
  const [requiredBy, setRequiredBy] = useState(cur?.requiredBy ?? '');
  const hasChildren = S.sharing().children.length > 0;
  function save() {
    try {
      onSave({ rule, kind, body, folder, ...(hasChildren || requiredBy ? { requiredBy: requiredBy || null } : {}) });
      onClose();
    } catch (e: any) {
      toast(e.message);
    }
  }
  return (
    <Sheet onClose={onClose} wide>
      <h2>{title}</h2>
      <p>A guardrail applies to every agent on every task, without being asked. Phrase it so it can be checked.</p>
      <label className="field-lbl" htmlFor="gr-rule">
        Rule
      </label>
      <textarea
        id="gr-rule"
        className="field"
        style={{ height: 90, padding: 12 }}
        value={rule}
        maxLength={400}
        onChange={(e) => setRule(e.target.value)}
        placeholder="e.g. Webhook signatures are always verified with a constant-time comparison."
      />
      <div className="filters" role="group" aria-label="Kind of rule">
        <button type="button" className="filter" data-act="gr-always" aria-pressed={kind === 'always'} onClick={() => setKind('always')}>
          Always
        </button>
        <button type="button" className="filter" data-act="gr-never" aria-pressed={kind === 'never'} onClick={() => setKind('never')}>
          Never
        </button>
      </div>
      <label className="field-lbl" htmlFor="gr-folder">
        Folder
      </label>
      <input
        id="gr-folder"
        className="field"
        list="gr-folders"
        value={folder}
        placeholder="none, or e.g. security"
        onChange={(e) => setFolder(e.target.value)}
      />
      <datalist id="gr-folders">
        {S.ruleFolders().map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
      <label className="field-lbl" htmlFor="gr-body">
        Details{' '}
        <small className="muted">why, what to do instead, exceptions (Markdown) – changing them does not ask agents to check again</small>
      </label>
      <textarea
        id="gr-body"
        className="field"
        style={{ height: 150, padding: 12 }}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={'**Why:** …\n\n**Instead:** …\n\n**Exceptions:** none.'}
      />
      {(hasChildren || requiredBy) && (
        <>
          <label className="field-lbl" htmlFor="gr-required">
            Required for child teams by{' '}
            <small className="muted">optional – after this date the rule applies to them even before they accept the update</small>
          </label>
          <input id="gr-required" className="field" type="date" value={requiredBy} onChange={(e) => setRequiredBy(e.target.value)} />
        </>
      )}
      <div className="btns">
        <button className="btn primary" data-act="gr-save" disabled={!rule.trim()} onClick={save}>
          {submit}
        </button>
      </div>
    </Sheet>
  );
}

function GuardrailList({ arg }: { arg?: string }) {
  const S = useStore();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [sheet, setSheet] = useState(false);
  const [pref, setPref] = usePref<'rules' | 'proposed'>('tab-guardrails', 'rules', ['rules', 'proposed']);
  const tab = arg?.startsWith(PROPOSED) ? 'proposed' : arg ? 'rules' : pref;
  const can = S.can('write');
  const ql = q.trim().toLowerCase();
  const rules = S.ruleItems()
    .map((item) => ({ item, r: parseRuleFile(item.body)! }))
    .filter(({ r }) => !ql || r.rule.toLowerCase().includes(ql) || r.body.toLowerCase().includes(ql) || r.id?.toLowerCase() === ql);
  const proposed = S.proposedRuleItems();
  const notes = S.guardrailNotes();
  const setTab = (t: string) => {
    setPref(t as typeof pref);
    if (arg) nav('/guardrails');
  };
  // a rule row: its id, its folder, the binding sentence. The group heading says Always or Never, so the row needs no mark;
  // a proposal carries the sprout.
  const row = (item: Item, r: NonNullable<ReturnType<typeof parseRuleFile>>, extra?: string) => (
    <Link key={item.id} className={`row ${arg === item.id ? 'active' : ''}`} to={`/guardrails${pathTo(item.id)}`} data-rule={r.id ?? ''}>
      <div className="row-top">
        {extra ? <GrowthIcon stage="sprout" size={14} /> : <span className="mono muted">{r.id}</span>}
        {extra && <span className="chip">{extra}</span>}
        {ruleFolder(item.id) && <span className="muted row-folder">{ruleFolder(item.id)}</span>}
      </div>
      <div className="row-title" style={{ whiteSpace: 'normal' }}>
        {r.rule}
      </div>
    </Link>
  );
  const byId = (a: { r: { id: string | null } }, b: { r: { id: string | null } }) =>
    (a.r.id ?? '').localeCompare(b.r.id ?? '', undefined, { numeric: true });
  return (
    <>
      <Bar title="Guardrails">
        {can && (
          <button className={`btn ${arg ? '' : 'primary'}`} data-act="gr-new" onClick={() => setSheet(true)}>
            <Icon name="plus" size={14} /> New rule
          </button>
        )}
      </Bar>
      <Tabs
        label="Guardrails views"
        controls={tab === 'rules' ? 'grList' : 'grProposed'}
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'rules', label: 'Rules' },
          { id: 'proposed', label: 'Proposed', badge: proposed.length || undefined },
        ]}
      />
      {tab === 'rules' ? (
        <>
          <div className="listtools">
            <div className="search">
              <Icon name="search" />
              <label className="sr" htmlFor="grsearch">
                Search rules
              </label>
              <input
                id="grsearch"
                type="search"
                placeholder="Search rules and their details"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
          </div>
          <div className="list" id="grList" role="tabpanel" aria-labelledby="tab-rules">
            {!S.ruleItems().length && !S.sharing().inherited.some((a) => a.rules.length) && (
              <div className="empty">
                No guardrails yet.
                <br />
                Rules every agent follows on every task, unasked: create one with “New rule”, or turn feedback into a rule.
              </div>
            )}
            {S.ruleItems().length > 0 && !rules.length && <div className="empty">No rules match.</div>}
            {(['always', 'never'] as const).map((k) => {
              const list = rules.filter(({ r }) => r.kind === k).sort(byId);
              if (!list.length) return null;
              return (
                <div key={k} className="kindgroup" data-kind={k}>
                  <div className="grouplabel">
                    {k === 'always' ? 'Always' : 'Never'} <small>{list.length}</small>
                  </div>
                  {list.map(({ item, r }) => row(item, r))}
                </div>
              );
            })}
            {[...S.sharing().inherited].reverse().map((a) => {
              const list = a.rules.filter(
                (r: any) =>
                  !ql ||
                  r.text.toLowerCase().includes(ql) ||
                  String(r.body ?? '')
                    .toLowerCase()
                    .includes(ql) ||
                  r.ref.toLowerCase() === ql,
              );
              if (!list.length) return null;
              return (
                <div key={a.team.id} className="kindgroup inherited" data-from={a.team.key}>
                  <div className="grouplabel">
                    From {a.team.name} <small>v{a.pinned}</small>
                    {a.update && (
                      <Link className="chip warn" to="/team?tab=sharing" style={{ marginLeft: 8 }}>
                        Update v{a.update.version} waits
                      </Link>
                    )}
                  </div>
                  {list.map((r: any) => (
                    <details key={r.ref} className="row inh-rule" data-rule={r.ref}>
                      <summary>
                        <div className="row-top">
                          <span className="mono muted">{r.ref}</span>
                          <span className="chip">{r.kind === 'never' ? 'Never' : 'Always'}</span>
                          {r.forced && <span className="chip warn">required</span>}
                        </div>
                        <div className="row-title" style={{ whiteSpace: 'normal' }}>
                          {r.text}
                        </div>
                      </summary>
                      {r.body ? <Md text={r.body} idx={termIndex(glossaryTerms(S))} /> : <p className="muted">No details.</p>}
                      <p className="note">Set by {a.team.name}. Your team cannot change or relax it – give feedback to them instead.</p>
                    </details>
                  ))}
                </div>
              );
            })}
            {notes.length > 0 && (
              <div className="note" style={{ margin: 16 }}>
                Also in this folder:{' '}
                {notes.map((n) => (
                  <Link key={n.id} to={`/doc${pathTo(n.id)}`} className="mono">
                    {n.id}{' '}
                  </Link>
                ))}
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="list" id="grProposed" role="tabpanel" aria-labelledby="tab-proposed">
          {!proposed.length && (
            <div className="empty">
              Nothing proposed.
              <br />
              Agents propose rules with propose_guardrail; an approver accepts or declines them here.
            </div>
          )}
          {proposed.map((item) => row(item, parseRuleFile(item.body)!, 'Proposed'))}
        </div>
      )}
      {sheet && (
        <RuleFormSheet
          title="New rule"
          submit="Add rule"
          onClose={() => setSheet(false)}
          onSave={(r) => {
            const p = S.saveRule(r);
            toast('Rule added – agents receive it shortly');
            nav(`/guardrails${pathTo(p)}`);
          }}
        />
      )}
    </>
  );
}

function RuleDetail({ path }: { path: string }) {
  const S = useStore();
  const nav = useNavigate();
  const [editing, setEditing] = useState(false);
  const it = S.get(path);
  const r = it ? parseRuleFile(it.body) : null;
  const idx = termIndex(glossaryTerms(S));
  if (!it || !r)
    return (
      <div className="gdetail">
        <header className="bar">
          <Link className="icon-btn back" to="/guardrails" aria-label="Back">
            <Icon name="back" />
          </Link>
          <h1>Not found</h1>
        </header>
        <div className="scroll">
          <div className="page">
            <p>This rule does not exist (any more).</p>
          </div>
        </div>
      </div>
    );
  const st = foundState(it, S);
  const can = S.can('write');
  return (
    <div className="gdetail" id="grDetail">
      <header className="bar">
        <Link className="icon-btn back" to="/guardrails" aria-label="Back">
          <Icon name="back" />
        </Link>
        <h1>{r.id ?? 'New rule'}</h1>
        <KindChip kind={r.kind} />
        <span className={`chip ${st.cls}`}>{st.text}</span>
      </header>
      <div className="gd-meta">
        {ruleFolder(it.id) ? (
          <>
            <Icon name="folder" size={12} /> {ruleFolder(it.id)} ·{' '}
          </>
        ) : null}
        {it.updatedBy ? `${it.updatedBy} · ` : ''}
        {it.updatedAt ? ago(Date.parse(it.updatedAt)) : ''}
      </div>
      <div className="scroll">
        <div className="page gd">
          <section className="gd-def">
            <p style={{ fontSize: 18, fontWeight: 600 }} data-rule-text>
              {r.rule}
            </p>
            {r.body ? (
              <Md text={r.body} idx={idx} />
            ) : (
              <p className="muted">
                No details yet: say why the rule exists, what to do instead and any exceptions – agents apply it better.
              </p>
            )}
          </section>
          {r.see.length > 0 && (
            <div className="kvs">
              <div className="relrow">
                <span>See also</span>
                {r.see.map((x) => (
                  <span key={x} className="gd-alias">
                    {x}
                  </span>
                ))}
              </div>
            </div>
          )}
          <p className="note">
            Binding on every task. Rewording the rule asks agents to check built specs again; changing the details does not.
          </p>
          {can && (
            <div className="btns">
              <button className="btn" data-act="gr-edit" onClick={() => setEditing(true)}>
                Edit
              </button>
              <button
                className="btn ghost"
                data-act="gr-delete"
                onClick={() => {
                  if (!confirm(`Delete ${r.id ?? 'this rule'}? Agents stop receiving it. Its id is not given again.`)) return;
                  S.deleteRule(it.id);
                  toast('Rule deleted');
                  nav('/guardrails');
                }}
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </div>
      {editing && (
        <RuleFormSheet
          item={it}
          title={`Edit ${r.id ?? 'rule'}`}
          submit="Save"
          onClose={() => setEditing(false)}
          onSave={(x) => {
            const p = S.saveRule(x, it.id);
            toast('Saved – agents receive it shortly');
            if (p !== it.id) nav(`/guardrails${pathTo(p)}`, { replace: true });
          }}
        />
      )}
    </div>
  );
}

function ProposedRuleDetail({ path }: { path: string }) {
  const S = useStore();
  const nav = useNavigate();
  const [editing, setEditing] = useState(false);
  const [folder, setFolder] = useState('');
  const it = S.get(path);
  const r = it ? parseRuleFile(it.body) : null;
  const idx = termIndex(glossaryTerms(S));
  if (!it || !r)
    return (
      <div className="gdetail">
        <header className="bar">
          <Link className="icon-btn back" to="/guardrails" aria-label="Back">
            <Icon name="back" />
          </Link>
          <h1>Proposal</h1>
        </header>
        <div className="scroll">
          <div className="page">
            <p>This proposal was accepted or declined.</p>
          </div>
        </div>
      </div>
    );
  const approver = S.can('approve');
  const accept = (patch = {}) => {
    try {
      const p = S.acceptProposedRule(path, { folder, ...patch });
      toast('Rule accepted – agents receive it shortly');
      nav(`/guardrails${pathTo(p)}`);
    } catch (e: any) {
      toast(e.message);
    }
  };
  return (
    <div className="gdetail" id="grDetail">
      <header className="bar">
        <Link className="icon-btn back" to="/guardrails" aria-label="Back">
          <Icon name="back" />
        </Link>
        <h1>Proposed rule</h1>
        <KindChip kind={r.kind} />
        <span className="chip">
          <Icon name="agent" size={12} />
          {r.proposedBy ? `by ${r.proposedBy}` : 'Proposed'}
        </span>
      </header>
      <div className="gd-meta">
        {r.from ? (
          <>
            From <span className="mono">{r.from}</span> ·{' '}
          </>
        ) : null}
        {it.updatedAt ? ago(Date.parse(it.updatedAt)) : ''}
      </div>
      <div className="scroll">
        <div className="page gd">
          <section className="gd-def">
            <p style={{ fontSize: 18, fontWeight: 600 }}>{r.rule}</p>
            {r.body && <Md text={r.body} idx={idx} />}
          </section>
          {approver ? (
            <>
              <label className="field-lbl" htmlFor="grp-folder">
                Accept into folder
              </label>
              <input
                id="grp-folder"
                className="field"
                list="grp-folders"
                value={folder}
                placeholder="none, or e.g. security"
                onChange={(e) => setFolder(e.target.value)}
              />
              <datalist id="grp-folders">
                {S.ruleFolders().map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
              <div className="btns">
                <button className="btn primary" data-act="grp-accept" onClick={() => accept()}>
                  Accept
                </button>
                <button className="btn" data-act="grp-edit" onClick={() => setEditing(true)}>
                  Edit first
                </button>
                <button
                  className="btn ghost"
                  data-act="grp-decline"
                  onClick={() => {
                    S.declineProposedRule(path);
                    toast('Proposal declined');
                    nav('/guardrails');
                  }}
                >
                  Decline
                </button>
              </div>
            </>
          ) : (
            <p className="note">An approver accepts or declines proposed rules. Nothing reaches agents before that.</p>
          )}
        </div>
      </div>
      {editing && (
        <RuleFormSheet
          item={it}
          initial={{ folder }}
          title="Edit and accept"
          submit="Accept"
          onClose={() => setEditing(false)}
          onSave={(x) => accept(x)}
        />
      )}
    </div>
  );
}

export function GuardrailsPage() {
  const { '*': rest } = useParams();
  const arg = rest ? decodeURIComponent(rest) : undefined;
  const detail = !arg ? undefined : arg.startsWith(PROPOSED) ? (
    <ProposedRuleDetail key={arg} path={arg} />
  ) : (
    <RuleDetail key={arg} path={arg} />
  );
  return <Shell active="guardrails" master={<GuardrailList arg={arg} />} detail={detail} />;
}
