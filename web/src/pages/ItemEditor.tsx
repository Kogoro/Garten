import { GrowthIcon, stageOf } from '../growth';
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Dropdown, Sheet, MenuHost } from '../dialogs';
import { glossaryTerms, registerTermLookup, specSuggestions, type Suggestion } from '../glossaryLib';
import { isGlossaryPath, replaceWord, linkFirst } from '@shared/glossaryFiles.js';
import type { EditorApi } from '../editor/SpecEditor';
import { BLOCK_MENU } from '../editor/blockTypes';
import { Hint } from '../Hint';
import { useMedia } from '../prefs';
import { CORE_LABEL, enc, foundState, hasContent, rawMode } from '../lib';
import { ConflictSheet, DeriveSpecSheet, LinkSheet, PathSheet } from '../sheets';
import { newDefinitions, termPrefill } from '../derive';
import { openMenu, useUi } from '../state';
import type { Item } from '../store/types';
import { FeedbackBody } from '../feedback';
import { ImplChip, ReportBody, implState } from '../reports';
import { Tabs } from '../Tabs';
import { Icon, ago, toast, touched, useStore } from '../ui';

// The editor (BlockNote, Mermaid …) is the bulk of the code: it loads when a spec or document is opened, not with the first screen.
// The service worker precaches it, so opening works offline as before.
const SpecEditor = lazy(() => import('../editor/SpecEditor').then((m) => ({ default: m.SpecEditor })));
const SpecForm = lazy(() => import('../form/SpecForm').then((m) => ({ default: m.SpecForm })));
// "Define as term" opens the glossary's sheet – it comes with the (lazily loaded) glossary page, so the specs screen does not carry it.
const TermSheet = lazy(() => import('./Glossary').then((m) => ({ default: m.TermSheet })));
const EditorFallback = () => (
  <div className="editor-skeleton" role="status" aria-label="Loading the editor">
    <i />
    <i />
    <i />
  </div>
);

type Store = ReturnType<typeof useStore>;

/** Versions of a spec: the draft being written and every released version (a Git tag with its commit). */
function HistoryPanel({ item }: { item: Item }) {
  const S = useStore();
  const released = item.status === 'approved';
  const [remote, setRemote] = useState<{ version: number; commit: string; at: string; by: string }[] | null>(null);
  useEffect(() => {
    let on = true;
    if (S.state.online)
      S.teamApi('GET', `/versions?spec=${encodeURIComponent(item.id)}`)
        .then((d: any) => on && setRemote(d.versions))
        .catch(() => {
          /* offline: only the current release is known on this device */
        });
    return () => {
      on = false;
    };
  }, [item.id, item.version, item.releasedAt, S.state.online]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows: { key: string; title: string; meta: string }[] = [];
  if (!released || S.hasUnreleased(item))
    rows.push({
      key: 'draft',
      title: `v${item.version + 1} · Draft`,
      meta: `Edited ${ago(touched(item))}${item.updatedBy ? ` by ${item.updatedBy}` : ''} · only your team sees it`,
    });
  if (remote?.length)
    for (const v of remote)
      rows.push({
        key: `v${v.version}`,
        title: `v${v.version} · Released`,
        meta: `${ago(Date.parse(v.at))} by ${v.by} · commit ${v.commit}, tag ${item.id}/v${v.version}`,
      });
  else if (released)
    rows.push({
      key: 'cur',
      title: `v${item.version} · Released`,
      meta: `${item.releasedAt ? ago(Date.parse(item.releasedAt)) : ''}${item.releasedBy ? ` by ${item.releasedBy}` : ''} · commit and tag in the team repository`,
    });
  return (
    <>
      <section className="list-card" aria-label="Versions">
        {rows.map((r) => (
          <div className="row" key={r.key}>
            <div className="row-top">
              <span className="row-title mono">{r.title}</span>
            </div>
            <div className="row-meta">{r.meta}</div>
          </div>
        ))}
        {!rows.length && <div className="hint-empty empty">Nothing released yet. Approve the spec to create v1.</div>}
      </section>
      {remote === null && !S.state.online && <p className="note">Offline – older versions load when you are online.</p>}
      <p className="note">
        Every release is one commit and one tag in the team repository. <Link to="/release">Release</Link> shows what reaches agents.
      </p>
    </>
  );
}

export const TypeChip = ({ s, S }: { s: Item; S: Store }) => {
  const t = S.specType(s.specType);
  return (
    <span className="chip type" title={t.label}>
      {t.short ?? t.label}
    </span>
  );
};
export const AgentChip = ({ s, S }: { s: Item; S: Store }) =>
  s.updatedVia && S.hasUnreleased(s) ? (
    <span className="chip agent" title={s.updatedVia}>
      Agent draft
    </span>
  ) : null;
export const StatusChip = ({ i, S }: { i: Item; S: Store }) => {
  if (i.kind === 'doc') {
    if (!i.pinned) return null;
    const f = foundState(i, S);
    return (
      <>
        <span className="chip">Foundation</span>
        <span className={`chip ${f.cls}`}>{f.text}</span>
      </>
    );
  }
  const st = stageOf(S, i);
  return i.approve ? (
    <span className="chip warn stage">
      <GrowthIcon stage="sprout" size={14} />
      Approval queued
    </span>
  ) : i.status === 'approved' ? (
    <span className="chip ok stage">
      <GrowthIcon stage={st} size={14} />
      Approved v{i.version}
      {S.hasUnreleased(i) ? ' · edited' : ''}
    </span>
  ) : (
    <span className="chip stage">
      <GrowthIcon stage={st} size={14} />
      Draft
    </span>
  );
};

/** Sync state of one item. `quiet` (lists): say nothing while everything is fine, so only the exceptions stand out. */
export const ItemSync = ({ i, S, quiet }: { i: Item; S: Store; quiet?: boolean }) =>
  i.conflict ? (
    <span className="st bad">
      <Icon name="warn" size={12} />
      Conflict
    </span>
  ) : S.isPending(i) ? (
    <span className="st warn">
      <Icon name="up" />
      Not synced
    </span>
  ) : quiet ? null : (
    <span className="st">
      <Icon name="check" />
      Synced
    </span>
  );

/** An address that leads nowhere (deleted item, old link): say so and offer the way back – never a blank screen. */
export function NotFound({ what, to, back }: { what: string; to: string; back: string }) {
  return (
    <div className="notfound">
      <header className="bar">
        <Link className="icon-btn back" to={to} aria-label={`Back to ${back}`}>
          <Icon name="back" />
        </Link>
        <h1>Not found</h1>
      </header>
      <div className="scroll">
        <div className="page">
          <p>This {what} does not exist (anymore). It may have been deleted, or the link is from another team.</p>
          <div className="btns">
            <Link className="btn primary" to={to}>
              Back to {back}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

export function saveState(i: Item, S: Store) {
  if (!S.can('write')) return 'ro';
  if (i.conflict) return 'conflict';
  if (i.syncError) return 'error';
  return S.isPending(i) ? 'dirty' : 'synced';
}
export function SaveInd({ i, S }: { i: Item; S: Store }) {
  const st = saveState(i, S);
  const txt = (
    {
      ro: `View only · your role (${S.team()?.role}) cannot edit`,
      conflict: 'Conflict with server',
      error: i.syncError ?? '',
      dirty: 'Saved on device · not synced',
      synced: 'Synced',
    } as Record<string, string>
  )[st];
  const icon = ({ ro: 'file', conflict: 'warn', error: 'warn', dirty: 'phone', synced: 'check' } as const)[st as 'ro'];
  return (
    <span
      className={`save-ind ${st === 'dirty' ? 'dirty' : ''} ${st === 'conflict' || st === 'error' ? 'bad' : ''}`}
      id="saveInd"
      data-state={st}
      role="status"
      title={txt}
    >
      <Icon name={icon} size={14} />
      <span className="lbl">{txt}</span>
    </span>
  );
}

const avoided = (S: Store, body: string) => specSuggestions(S, body).filter((x) => x.kind === 'avoid');
const replaceAll = (body: string, hits: Suggestion[]) => hits.reduce((b, h) => replaceWord(b, h.word, h.term), body);
const hitText = (hits: Suggestion[]) =>
  hits.map((h) => `“${h.word}” – the glossary says “${h.term}”${h.line ? ` (line ${h.line})` : ''}`).join('\n');
/** Words to avoid in a spec: a dialog that offers to replace them. Resolves false when the person cancels. */
async function checkWords(i: Item, S: Store, go: string, keep: string): Promise<boolean> {
  const hits = i.kind === 'spec' ? avoided(S, i.body) : [];
  if (!hits.length) return true;
  const k = await openMenu(
    `${hits.length === 1 ? 'A word' : `${hits.length} words`} to avoid in ${i.id}`,
    [
      { key: 'replace', label: `Replace with the glossary’s word${hits.length === 1 ? '' : 's'} and ${go}` },
      { key: 'keep', label: keep },
    ],
    hitText(hits),
  );
  if (!k) return false;
  if (k === 'replace') {
    S.edit(i.id, { body: replaceAll(i.body, hits) });
    toast(`${hits.length} word${hits.length === 1 ? '' : 's'} replaced`);
  }
  return true;
}

async function approve(i: Item, S: Store) {
  if (i.kind === 'spec' && !i.title.trim()) return toast('Add a title first');
  if (!(await checkWords(i, S, 'approve', 'Approve anyway'))) return;
  S.requestApprove(i.id);
  toast(S.state.online && !S.state.sessionExpired ? (i.kind === 'doc' ? 'Releasing…' : 'Approving…') : 'Queued — released after next sync');
}

export function ApproveButton({ i, S }: { i: Item; S: Store }) {
  if (i.kind === 'doc' && i.pinned) {
    const auto = S.team()?.foundationAuto !== false;
    if (!S.can('approve'))
      return <span className="muted hint">{auto ? 'Goes live automatically after you stop typing' : 'An approver publishes this'}</span>;
    if (i.approve)
      return (
        <button
          className="approve queued"
          type="button"
          aria-label="Approval queued"
          data-act="cancel-approve"
          onClick={() => S.cancelApprove(i.id)}
        >
          <Icon name="clock" />
          Release queued
        </button>
      );
    if (foundState(i, S).live || !hasContent(i.body))
      return <span className="muted hint">{hasContent(i.body) ? `Live v${i.version}` : 'Empty – not published'}</span>;
    return (
      <button className="approve" type="button" data-act="approve" onClick={() => approve(i, S)}>
        Release now
        <Icon name="check" size={16} />
      </button>
    );
  }
  if (i.kind !== 'spec') return <span className="muted hint">Released with the specs that link it</span>;
  if (!S.can('approve'))
    return <span className="muted hint">{i.status === 'approved' ? `Approved v${i.version}` : 'An approver releases this'}</span>;
  if (i.approve)
    return (
      <button
        className="approve queued"
        type="button"
        aria-label="Approval queued"
        data-act="cancel-approve"
        onClick={() => S.cancelApprove(i.id)}
      >
        <Icon name="clock" />
        <span className="lbl">Approval queued</span>
      </button>
    );
  if (i.status === 'approved' && !S.hasUnreleased(i))
    return (
      <button className="approve done" disabled type="button">
        Approved v{i.version}
        <Icon name="check" size={16} />
      </button>
    );
  return (
    <button className="approve" type="button" data-act="approve" onClick={() => approve(i, S)}>
      {i.status === 'approved' ? `Approve v${i.version + 1}` : 'Approve'}
      <Icon name="check" size={16} />
    </button>
  );
}

/** Linked documents of a spec as a dropdown in the bar (documents show who uses them instead). */
function DocsDd({ i, S, onNew }: { i: Item; S: Store; onNew: () => void }) {
  if (i.kind !== 'spec') {
    if (i.pinned) return null;
    const used = S.usedBy(i.id);
    return (
      <span className="muted hint docinfo">{used.length ? `Used by ${used.map((s) => s.id).join(', ')}` : 'Not linked to a spec yet'}</span>
    );
  }
  const n = i.links.length;
  const docs = S.all('doc')
    .filter((d) => !isGlossaryPath(d.id) && (!d.pinned || i.links.includes(d.id)))
    .sort((a, b) => a.id.localeCompare(b.id));
  const can = S.can('write');
  return (
    <Dropdown
      id="docsDd"
      className="docsbtn"
      ariaLabel="Linked documents"
      menuClass="docs-menu"
      buttonProps={{ 'aria-label': `Linked documents: ${n}` }}
      label={
        <>
          <Icon name="file" size={15} />
          <span className="lbl">
            {n} document{n === 1 ? '' : 's'}
          </span>
          <span className="cnt">{n}</span>
          <Icon name="chevron" size={14} />
        </>
      }
    >
      {(close) => (
        <>
          <div className="dd-title">Linked documents · released with this spec</div>
          {docs.length ? (
            docs.map((d) => {
              const on = i.links.includes(d.id);
              return (
                <div className="ddrow" key={d.id}>
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    data-act="dd-link"
                    data-id={d.id}
                    aria-checked={on}
                    disabled={!can}
                    onClick={() => S.toggleLink(i.id, d.id)}
                  >
                    <span className={`box ${on ? 'on' : ''}`}>{on && <Icon name="check" size={11} />}</span>
                    <span className="mono">{d.id}</span>
                  </button>
                  <Link className="fbtn" to={`/doc/${enc(d.id)}`} aria-label={`Open ${d.id}`}>
                    <Icon name="file" size={14} />
                  </Link>
                </div>
              );
            })
          ) : (
            <div className="dd-empty">No documents yet.</div>
          )}
          {can && (
            <>
              <div className="dd-sep" />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  close();
                  onNew();
                }}
              >
                <Icon name="plus" size={14} />
                <span>New document…</span>
              </button>
            </>
          )}
        </>
      )}
    </Dropdown>
  );
}

/** What the glossary suggests for this spec: words to avoid and defined terms that are mentioned but not referenced. Quiet, at the end of the content. */
function GlossarySuggestions({ item, S }: { item: Item; S: Store }) {
  const list = specSuggestions(S, item.body);
  if (!list.length) return null;
  const apply = (x: Suggestion) =>
    S.edit(item.id, { body: x.kind === 'avoid' ? replaceWord(item.body, x.word, x.term) : linkFirst(item.body, x.word, x.term) });
  return (
    <section className="card sugg" id="glossarySugg" aria-label="Glossary suggestions">
      <div className="sugg-head">
        <Icon name="book" size={16} />
        <b>
          Glossary · {list.length} suggestion{list.length === 1 ? '' : 's'}
        </b>
        {list.length > 1 && (
          <button
            type="button"
            className="btn ghost small"
            data-act="sugg-all"
            onClick={() =>
              S.edit(item.id, {
                body: list.reduce(
                  (b, x) => (x.kind === 'avoid' ? replaceWord(b, x.word, x.term) : linkFirst(b, x.word, x.term)),
                  item.body,
                ),
              })
            }
          >
            Apply all
          </button>
        )}
      </div>
      {list.map((x) => (
        <div className="sugg-row" key={`${x.kind}:${x.word}`}>
          <div className="grow">
            <span>{x.kind === 'avoid' ? <>“{x.word}” is a word to avoid</> : <>“{x.word}” is defined in the glossary</>}</span>
            <small className="muted">
              {x.kind === 'avoid' ? (
                <>
                  use {x.term} instead{x.line ? ` · line ${x.line}` : ''}
                </>
              ) : (
                <>link it so agents get the definition{x.word !== x.term ? ` of ${x.term}` : ''}</>
              )}
            </small>
          </div>
          <button type="button" className="btn small" data-act={x.kind === 'avoid' ? 'sugg-replace' : 'sugg-link'} onClick={() => apply(x)}>
            {x.kind === 'avoid' ? 'Replace' : 'Link term'}
          </button>
        </div>
      ))}
    </section>
  );
}

export function ItemEditor({ item }: { item: Item }) {
  const S = useStore();
  const nav = useNavigate();
  const ui = useUi();
  const api = useRef<EditorApi | null>(null);
  const [derive, setDerive] = useState<null | { kind: 'spec' | 'term'; text: string; whole: boolean }>(null);
  const [sheet, setSheet] = useState<null | 'link' | 'ref' | 'newdoc' | 'move' | 'conflict'>(null);
  const isSpec = item.kind === 'spec';
  const ro = !S.can('write');
  const raw = rawMode(item);
  const stype = isSpec ? S.specType(item.specType) : null;
  const form = stype && !stype.missing && stype.form ? stype.form : null;
  const mode: 'form' | 'blocks' | 'markdown' = raw
    ? 'markdown'
    : (ui.modes[item.id] ?? (form && stype!.view === 'form' ? 'form' : ui.mode));
  const blocks = mode === 'blocks';
  const asForm = mode === 'form' && !!form;
  const path = isSpec ? `${S.team()!.key}/${item.id}.md` : `docs/${item.id}`;
  const back = isSpec ? '/' : isGlossaryPath(item.id) ? '/glossary' : '/docs';

  /** What the user marked in this item (blocks editor, Markdown view or read view); empty = nothing selected. */
  function selected(): string {
    const ta = document.getElementById('body') as HTMLTextAreaElement | null;
    if (ta && ta.selectionEnd > ta.selectionStart) return ta.value.slice(ta.selectionStart, ta.selectionEnd).trim();
    return api.current?.getSelection() ?? '';
  }
  async function itemMenu() {
    const sel = selected(); // read before the menu opens: opening it may clear the selection
    const src = sel || item.body.trim();
    const canDerive = S.can('write') && hasContent(src);
    const what = sel ? 'selection' : item.kind === 'spec' ? 'this spec' : 'this document';
    const inGlossary = (t: string) => !!S.termByName(t);
    const defs = !sel && !isGlossaryPath(item.id) ? newDefinitions(item.body, inGlossary) : [];
    const deriveItems = canDerive
      ? [
          { key: 'derive:spec', label: `New spec from ${what}…` },
          ...(isGlossaryPath(item.id) ? [] : [{ key: 'derive:term', label: `Glossary term from ${what}…` }]),
          ...(defs.length
            ? [
                {
                  key: 'derive:defs',
                  label: `Add ${defs.length} definition${defs.length === 1 ? '' : 's'} of this ${isSpec ? 'spec' : 'document'} to the glossary`,
                },
              ]
            : []),
        ]
      : [];
    const info = [
      {
        key: 'info',
        label: `${path}${item.version ? ` · v${item.version}` : ''}${item.updatedBy ? ` · edited by ${item.updatedBy}` : ''}`,
        disabled: true,
      },
    ];
    const typeItem = isSpec && S.can('write') ? [{ key: 'type', label: `Type: ${S.specType(item.specType).label} – change…` }] : [];
    const modeItems = raw
      ? []
      : [
          ...(form ? [{ key: 'mode:form', label: 'Editor: Form', current: asForm }] : []),
          { key: 'mode:blocks', label: 'Editor: Blocks', current: blocks },
          { key: 'mode:markdown', label: 'Editor: Markdown', current: mode === 'markdown' },
        ];
    const actions = !S.can('write')
      ? []
      : isSpec
        ? [{ key: 'delete', label: 'Delete spec', danger: true }]
        : item.core
          ? [{ key: 'none', label: 'Foundation document – every team has it', disabled: true }]
          : [
              { key: 'move', label: 'Move / rename…' },
              { key: 'pin', label: item.pinned ? 'Unpin: no longer always available to agents' : 'Pin: always available to agents' },
              { key: 'delete', label: 'Delete document', danger: true },
            ];
    const impl =
      isSpec && item.status === 'approved'
        ? [{ key: 'report', label: `Implementation: ${implState(item, S.latestReport(item.id)).text}` }]
        : [];
    const phoneItems =
      phone && isSpec
        ? [
            { key: 'feedback', label: `Feedback: ${S.feedbackCount(item.id)} open` },
            { key: 'docs', label: `Linked documents: ${item.links.length}` },
          ]
        : [];
    const key = await openMenu(item.id, [...info, ...phoneItems, ...impl, ...deriveItems, ...modeItems, ...typeItem, ...actions]);
    if (key === 'derive:spec' || key === 'derive:term')
      return setDerive({ kind: key === 'derive:spec' ? 'spec' : 'term', text: src, whole: !sel });
    if (key === 'derive:defs') {
      const r = S.importTerms(defs.map((d) => ({ term: d.term, body: d.definition, aliases: d.aliases, see: d.see })));
      return toast(`${r.added} term${r.added === 1 ? '' : 's'} added to the glossary`);
    }
    if (key === 'feedback') return setTab('feedback');
    if (key === 'docs') return setSheet('link');
    if (key === 'report') return setTab('report');
    if (key === 'type') {
      const k = await openMenu(
        'Spec type',
        S.specTypes().map((t) => ({ key: t.key, label: t.label, current: t.key === item.specType })),
      );
      if (k && k !== item.specType) {
        S.edit(item.id, { specType: k });
        toast('Type changed – the content stays as it is');
      }
    } else if (key?.startsWith('mode:')) {
      const m = key.slice(5) as 'form' | 'blocks' | 'markdown';
      ui.set({ modes: { ...ui.modes, [item.id]: m }, ...(m === 'form' ? {} : { mode: m }) });
    } else if (key === 'move') setSheet('move');
    else if (key === 'pin') {
      S.setPinned(item.id, !item.pinned);
      toast(item.pinned ? 'Unpinned' : 'Pinned – goes live for agents');
    } else if (key === 'delete') {
      if (!confirm(`Delete ${item.id}? ${item.baseRev === 0 ? '' : 'It is removed for everyone in the team after sync.'}`)) return;
      S.deleteItem(item.id);
      nav(back);
      toast(`${item.id} deleted`);
    }
  }
  async function addBlock() {
    const k = await openMenu(
      'Add block at cursor',
      BLOCK_MENU.filter((b) => isSpec || !['requirement'].includes(b.key)).map((b) => ({ key: b.key, label: b.label })),
    );
    if (k) api.current?.insert(k);
  }
  const insertRef = (id: string) => api.current?.insertText(`@${id} `);

  const phone = useMedia('(max-width: 700px)');
  registerTermLookup(S); // the term chips in the editor show the current glossary
  // Leaving a spec that was edited here and now uses words to avoid: say so once, with a way to fix it.
  const latest = useRef(item);
  latest.current = item;
  const startBody = useRef(item.body);
  useEffect(
    () => () => {
      const it = latest.current;
      if (it.kind !== 'spec' || it.body === startBody.current || !S.can('write')) return;
      const hits = avoided(S, it.body).filter(
        (h) => !avoided(S, startBody.current).some((o) => o.word.toLowerCase() === h.word.toLowerCase()),
      );
      if (hits.length)
        toast(
          `${it.id} now uses ${hits.map((h) => `“${h.word}”`).join(', ')} – the glossary says ${[...new Set(hits.map((h) => `“${h.term}”`))].join(', ')}`,
          {
            label: 'Replace',
            run: () => {
              const cur = S.get(it.id);
              if (cur) S.edit(it.id, { body: replaceAll(cur.body, hits) });
            },
          },
        );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [item.id],
  );
  // On a phone an item opens to read first (status, feedback, documents, what the agent did) and switches to editing on purpose.
  // A brand-new, empty item opens ready to type.
  const [editing, setEditing] = useState(() => !phone || (!item.title.trim() && !hasContent(item.body)));
  const locked = ro || (phone && !editing);
  const [tab, setTab] = useState<'content' | 'report' | 'feedback' | 'history'>('content'); // specs: the prototype's four tabs
  const metaLine = [
    isSpec ? S.specType(item.specType).label : item.core ? 'Foundation document' : 'Document',
    item.approve
      ? 'Approval queued'
      : item.status === 'approved'
        ? `Approved v${item.version}${S.hasUnreleased(item) ? ' · edited since' : ''}`
        : 'Draft',
    ...(saveState(item, S) === 'synced' || saveState(item, S) === 'ro'
      ? []
      : [
          saveState(item, S) === 'dirty'
            ? 'Saved on device, not synced'
            : saveState(item, S) === 'conflict'
              ? 'Conflict with server'
              : 'Sync problem',
        ]),
  ].join(' · ');
  const approveLine =
    isSpec && S.can('approve') && !item.approve && (item.status !== 'approved' || S.hasUnreleased(item))
      ? `Becomes v${item.version + 1} · ${S.feedbackCount(item.id)} open feedback · ${item.links.length} document${item.links.length === 1 ? '' : 's'}`
      : '';
  const titleEl = (
    <>
      {isSpec ? (
        phone && locked ? (
          <h1 className="ed-title view" title={path}>
            {item.title || <span className="muted">Untitled spec</span>}
          </h1>
        ) : (
          <>
            <label className="sr" htmlFor="title">
              Title
            </label>
            <input
              id="title"
              className="ed-title"
              placeholder="Spec title"
              value={item.title}
              autoComplete="off"
              title={path}
              readOnly={locked}
              onChange={(e) => S.edit(item.id, { title: e.target.value })}
            />
          </>
        )
      ) : (
        <h1 className="ed-title" title={path} style={item.core ? undefined : { fontFamily: 'var(--mono)', fontSize: 15 }}>
          {CORE_LABEL[item.id] ?? item.id}
        </h1>
      )}
    </>
  );
  return (
    <div className="editor" data-editor={item.id} data-locked={phone && locked ? '' : undefined}>
      <header className="bar ed-bar">
        {isSpec && !(phone && locked) && <h1 className="sr">{item.title || item.id}</h1>}
        <Link className="icon-btn back" to={back} aria-label="Back">
          <Icon name="back" />
        </Link>
        {phone ? (
          <div className="ed-titlebox">
            {titleEl}
            <div className="ed-meta" id="edMeta">
              {metaLine}
            </div>
          </div>
        ) : (
          titleEl
        )}
        {!phone && (
          <>
            <span className="ed-break" aria-hidden="true" />
            <span id="chips" className="barchips">
              {isSpec && <TypeChip s={item} S={S} />}
              <StatusChip i={item} S={S} />
              <AgentChip s={item} S={S} />
              {isSpec && item.status === 'approved' && (
                <button type="button" className="chipbtn" data-act="report" onClick={() => setTab('report')}>
                  <ImplChip spec={item} always />
                </button>
              )}
            </span>
            <span id="docsSlot">
              <DocsDd i={item} S={S} onNew={() => setSheet('newdoc')} />
            </span>
            <SaveInd i={item} S={S} />
          </>
        )}
        {!phone && (
          <span id="approveSlot">
            <ApproveButton i={item} S={S} />
          </span>
        )}
        {phone && editing && !ro && (
          <button
            type="button"
            className="ed-done"
            data-act="edit-done"
            onClick={async () => {
              if (await checkWords(item, S, 'save', 'Keep my words')) setEditing(false);
            }}
          >
            Done
          </button>
        )}
        <button type="button" className="icon-btn" data-act="item-menu" aria-label="More actions" aria-haspopup="menu" onClick={itemMenu}>
          <Icon name="more" />
        </button>
      </header>
      {phone && locked && isSpec && tab === 'content' && (
        <section className="sumstrip" aria-label="Overview">
          <button type="button" className="sumcell" data-act="link-docs" onClick={() => setSheet('link')}>
            <small>Documents</small>
            <span>{item.links.length} linked</span>
          </button>
        </section>
      )}
      {phone && locked && !isSpec && (
        <section className="sumstrip" aria-label="Overview">
          <div className="sumcell">
            <small>{item.pinned ? 'Reaches' : 'Used by'}</small>
            <span>
              {item.pinned
                ? 'every agent'
                : S.usedBy(item.id).length
                  ? S.usedBy(item.id)
                      .map((x) => x.id)
                      .join(', ')
                  : 'no spec yet'}
            </span>
          </div>
          <div className="sumcell">
            <small>Edited</small>
            <span>{ago(touched(item))}</span>
          </div>
        </section>
      )}
      {item.conflict && (
        <div id="banner">
          <div className="card bad banner">
            <div className="grow">
              <b>Changed on the server</b>
              <span>Your edits and the server version differ.</span>
            </div>
            <button className="btn danger" data-act="conflict" onClick={() => setSheet('conflict')}>
              Review
            </button>
          </div>
        </div>
      )}
      {isSpec && (
        <Tabs
          label="Spec sections"
          value={tab}
          onChange={(t) => setTab(t as typeof tab)}
          tabs={[
            { id: 'content', label: 'Content' },
            { id: 'report', label: 'Report' },
            { id: 'feedback', label: 'Feedback', badge: S.feedbackCount(item.id) || undefined },
            { id: 'history', label: 'History' },
          ]}
        />
      )}
      {isSpec && tab !== 'content' && (
        <div className="ed-scroll">
          <div className="page" id="tabpanel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
            {tab === 'report' && <ReportBody specId={item.id} />}
            {tab === 'feedback' && <FeedbackBody specId={item.id} version={item.version} />}
            {tab === 'history' && <HistoryPanel item={item} />}
          </div>
        </div>
      )}
      <div
        id={isSpec && tab === 'content' ? 'tabpanel' : 'editorBody'}
        className="ed-scroll"
        role={isSpec ? 'tabpanel' : undefined}
        aria-labelledby={isSpec ? 'tab-content' : undefined}
        hidden={isSpec && tab !== 'content'}
      >
        {!asForm && !locked && (
          <Hint id="editor-links">
            Type <kbd>/</kbd> for blocks, <kbd>@</kbd> to link a document and <kbd>#</kbd> to link a glossary term.
          </Hint>
        )}
        {asForm ? (
          <div className="blocks" id="form">
            <Suspense fallback={<EditorFallback />}>
              <SpecForm
                docKey={`${item.team}|${item.id}|${item.specType}`}
                schema={form!}
                value={item.body}
                readOnly={locked}
                onChange={(md) => S.edit(item.id, { body: md })}
              />
            </Suspense>
          </div>
        ) : blocks ? (
          <div className="blocks" id="blocks">
            <Suspense fallback={<EditorFallback />}>
              <SpecEditor
                terms={glossaryTerms(S).map((t) => t.term)}
                docKey={`${item.team}|${item.id}`}
                value={item.body}
                readOnly={locked}
                onChange={(md) => S.edit(item.id, { body: md })}
                onReady={(a) => (api.current = a)}
                refs={
                  isSpec
                    ? S.all('doc')
                        .filter((d) => !d.pinned && !isGlossaryPath(d.id))
                        .map((d) => d.id)
                    : undefined
                }
                onRef={(id) => !item.links.includes(id) && S.toggleLink(item.id, id)}
              />
            </Suspense>
          </div>
        ) : (
          <>
            <label className="sr" htmlFor="body">
              Content
            </label>
            <textarea
              id="body"
              className="ed-body"
              spellCheck={false}
              placeholder="Write Markdown…"
              readOnly={locked}
              value={item.body}
              onChange={(e) => S.edit(item.id, { body: e.target.value })}
            />
          </>
        )}
        {isSpec && !ro && <GlossarySuggestions item={item} S={S} />}
      </div>
      {!locked && !asForm && (!isSpec || tab === 'content') && (
        <div className="toolbar">
          <div className="tools" id="tools" onPointerDown={(e) => (e.target as HTMLElement).closest('button') && e.preventDefault()}>
            {blocks ? (
              <>
                <button type="button" data-act="t-add" aria-label="Add block" title="Add block at cursor" onClick={addBlock}>
                  <Icon name="plus" size={20} />
                </button>
                <button type="button" data-act="t-h2" aria-label="Heading" title="Heading" onClick={() => api.current?.insert('h2')}>
                  H
                </button>
                {isSpec && (
                  <button
                    type="button"
                    data-act="t-req"
                    aria-label="Requirement"
                    title="Requirement"
                    onClick={() => api.current?.insert('requirement')}
                  >
                    R+
                  </button>
                )}
                <button
                  type="button"
                  data-act="t-task"
                  aria-label="Checklist item"
                  title="Checklist item"
                  onClick={() => api.current?.insert('task')}
                >
                  <Icon name="box" />
                </button>
                <button
                  type="button"
                  data-act="t-def"
                  aria-label="Definition"
                  title="Definition (glossary term)"
                  onClick={() => api.current?.insert('definition')}
                >
                  <Icon name="book" size={20} />
                </button>
                {isSpec && item.specType === 'api' && (
                  <button
                    type="button"
                    data-act="t-endpoint"
                    aria-label="API endpoint"
                    title="API endpoint"
                    onClick={() => api.current?.insert('endpoint')}
                  >
                    <Icon name="api" />
                  </button>
                )}
                <button
                  type="button"
                  data-act="t-diagram"
                  aria-label="Diagram"
                  title="Diagram"
                  onClick={() => api.current?.insert('diagram')}
                >
                  <Icon name="diagram" />
                </button>
                {isSpec && (
                  <button
                    type="button"
                    className="at"
                    data-act="t-ref"
                    aria-label="Reference a document"
                    title="Reference a document"
                    onClick={() => setSheet('ref')}
                  >
                    @
                  </button>
                )}
              </>
            ) : (
              isSpec && (
                <button type="button" className="at" data-act="t-ref" aria-label="Reference a document" onClick={() => setSheet('ref')}>
                  @
                </button>
              )
            )}
          </div>
        </div>
      )}
      {phone && locked && (
        <footer className="approve-bar">
          {approveLine && <span className="approve-line">{approveLine}</span>}
          {!ro && (
            <button type="button" className="btn ghost" data-act="edit" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
          <span id="approveSlot">
            <ApproveButton i={item} S={S} />
          </span>
        </footer>
      )}
      {derive?.kind === 'spec' && (
        <DeriveSpecSheet text={derive.text} source={item.id} whole={derive.whole} onClose={() => setDerive(null)} />
      )}
      {derive?.kind === 'term' &&
        (() => {
          const p = termPrefill(derive.text, item.id, derive.whole);
          return (
            <Suspense fallback={null}>
              <TermSheet initial={p.term} definition={p.definition} from={item.id} onClose={() => setDerive(null)} />
            </Suspense>
          );
        })()}
      {sheet === 'ref' && (
        <LinkSheet
          specId={item.id}
          onClose={() => setSheet(null)}
          onPick={(id) =>
            blocks
              ? insertRef(id)
              : (() => {
                  const t = document.getElementById('body') as HTMLTextAreaElement | null;
                  if (t) S.edit(item.id, { body: `${item.body}${item.body.endsWith('\n') || !item.body ? '' : ' '}@${id} ` });
                })()
          }
        />
      )}
      {sheet === 'link' && <LinkSheet specId={item.id} onClose={() => setSheet(null)} />}
      {sheet === 'newdoc' && <PathSheet kind="newdoc" linkTo={item.id} onClose={() => setSheet(null)} />}
      {sheet === 'move' && <PathSheet kind="move" from={item.id} value={item.id} onClose={() => setSheet(null)} />}
      {sheet === 'conflict' && <ConflictSheet id={item.id} onClose={() => setSheet(null)} />}
    </div>
  );
}
export { Sheet, MenuHost };
