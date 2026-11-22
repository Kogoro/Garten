import { useState } from 'react';
import { Sheet } from './dialogs';
import { toast, useStore } from './ui';

/** "Make it a rule": word it, choose Always / Never, and it becomes a rule file every agent receives (live after the usual short delay). */
export function RuleSheet({ initial, source, onClose }: { initial: string; source?: string; onClose: () => void }) {
  const S = useStore();
  const [text, setText] = useState(initial.replace(/\s+/g, ' ').trim());
  const [where, setWhere] = useState<'always' | 'never'>('always');
  const can = S.can('write');
  function add() {
    if (!text.trim()) return;
    try {
      S.saveRule({ rule: text, kind: where, body: source ? `**Why:** came up in ${source}.` : '' });
      toast('Added to the guardrails – agents receive it shortly');
      onClose();
    } catch (e: any) {
      toast(e.message);
    }
  }
  return (
    <Sheet onClose={onClose}>
      <h2>Make it a rule</h2>
      <p>
        A guardrail applies to every agent on every task, without being asked. Phrase it so it can be checked.
        {source ? ` From ${source}.` : ''}
      </p>
      <label className="sr" htmlFor="rule-text">
        Rule
      </label>
      <textarea
        id="rule-text"
        className="field"
        style={{ height: 110, padding: 12 }}
        value={text}
        maxLength={400}
        onChange={(e) => setText(e.target.value)}
        placeholder="e.g. Webhook signatures are always verified with a constant-time comparison."
      />
      <div className="filters" role="group" aria-label="Kind of rule">
        <button type="button" className="filter" aria-pressed={where === 'always'} onClick={() => setWhere('always')}>
          Always
        </button>
        <button type="button" className="filter" aria-pressed={where === 'never'} onClick={() => setWhere('never')}>
          Never
        </button>
      </div>
      <p className="muted">Add the reasons and exceptions later on the Guardrails page.</p>
      <div className="btns">
        <button className="btn primary" data-act="rule-add" disabled={!can || !text.trim()} onClick={add}>
          Add to guardrails
        </button>
      </div>
    </Sheet>
  );
}
