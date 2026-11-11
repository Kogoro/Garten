import { useState } from 'react';
import { Link } from 'react-router-dom';
import { hasContent } from '@shared/glossary.js';
import { Icon, useStore } from './ui';

const KEY = 'specs-onboarding-done';
const dismissed = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };

/** A short, honest checklist for a new team, worked out from the team's own data. It disappears when everything is done or when dismissed. */
export function Onboarding() {
  const S = useStore();
  const [gone, setGone] = useState(dismissed);
  if (gone || !S.can('write')) return null;
  const doc = (id: string) => S.get(id);
  const steps: { done: boolean; text: string; to: string }[] = [
    { done: hasContent(doc('vision.md')?.body ?? ''), text: 'Write the vision: where is the product heading, and why', to: '/doc/vision.md' },
    { done: S.all('spec').length > 0, text: 'Write a first spec', to: '/' },
    { done: hasContent(doc('glossary.md')?.body ?? ''), text: 'Add the words your team uses to the glossary', to: '/glossary' },
    { done: S.all('spec').some((s) => s.status === 'approved'), text: 'Approve a spec so it is released to agents', to: '/release' },
    ...(S.can('admin') ? [{ done: false, text: 'Connect Git and an agent (Members & Git → Agent setup)', to: '/team' }] : []),
  ];
  const pending = steps.filter((s) => !s.done);
  const auto = steps.filter((s) => s.to !== '/team').every((s) => s.done);
  if (auto) return null; // everything that can be seen from the data is done
  return (
    <section className="onb" aria-label="Getting started" data-onboarding>
      <header><b>Getting started</b><span className="muted">{steps.length - pending.length} of {steps.length}</span>
        <button type="button" className="btn small" data-act="onb-dismiss" onClick={() => { try { localStorage.setItem(KEY, '1'); } catch { /* private mode */ } setGone(true); }}>Hide</button></header>
      <ol>{steps.map((s) => <li key={s.text} className={s.done ? 'done' : ''}><Link to={s.to}><span className="onb-mark" aria-hidden="true">{s.done ? <Icon name="check" size={12} /> : null}</span><span>{s.text}<span className="sr">{s.done ? ' (done)' : ' (to do)'}</span></span></Link></li>)}</ol>
    </section>
  );
}
