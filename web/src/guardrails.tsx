import { useState } from 'react';
import { Sheet } from './dialogs';
import { toast, useStore } from './ui';
import { GUARDRAILS, addRule } from './guardrailsLib';

/** "Make it a rule": word it, choose Always / Never, and it goes to the guardrails every agent receives (live after the usual short delay). */
export function RuleSheet({ initial, source, onClose }: { initial: string; source?: string; onClose: () => void }) {
  const S = useStore();
  const [text, setText] = useState(initial);
  const [where, setWhere] = useState<'Always' | 'Never'>('Always');
  const doc = S.get(GUARDRAILS);
  const can = S.can('write');
  function add() {
    if (!doc || !text.trim()) return;
    S.edit(GUARDRAILS, { body: addRule(doc.body, text, where) });
    toast('Added to the guardrails – agents receive it shortly');
    onClose();
  }
  return (
    <Sheet onClose={onClose}>
      <h2>Make it a rule</h2>
      <p>A guardrail applies to every agent on every task, without being asked. Phrase it so it can be checked.{source ? ` From ${source}.` : ''}</p>
      <label className="sr" htmlFor="rule-text">Rule</label>
      <textarea id="rule-text" className="field" style={{ height: 110, padding: 12 }} value={text} maxLength={400} onChange={(e) => setText(e.target.value)} placeholder="e.g. Webhook signatures are always verified with a constant-time comparison." />
      <div className="filters" role="group" aria-label="Kind of rule">
        <button type="button" className="filter" aria-pressed={where === 'Always'} onClick={() => setWhere('Always')}>Always</button>
        <button type="button" className="filter" aria-pressed={where === 'Never'} onClick={() => setWhere('Never')}>Never</button>
      </div>
      {!doc && <p className="muted">The guardrails document is not on this device yet – sync once.</p>}
      <div className="btns"><button className="btn primary" data-act="rule-add" disabled={!can || !doc || !text.trim()} onClick={add}>Add to guardrails</button></div>
    </Sheet>
  );
}
