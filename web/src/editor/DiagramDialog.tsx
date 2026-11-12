import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Sheet } from '../dialogs';
import { CODE_KINDS, KINDS, codeKindOf, kindOf } from './diagramKinds';
import { MermaidView } from './schema';

/** Pop-out editor for a Mermaid diagram: form or code on the left, the rendered diagram (with zoom) on the right. Nothing changes until "Apply". */
export function DiagramDialog({ text, readOnly, onApply, onClose }: { text: string; readOnly?: boolean; onApply: (next: string) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(text);
  const kind = kindOf(draft), codeKind = codeKindOf(draft);
  const [tab, setTab] = useState<'form' | 'code'>(kindOf(text) ? 'form' : 'code');
  const typeKey = kind?.key ?? codeKind?.key ?? 'custom';
  const dirty = draft !== text;
  const templates = [...KINDS.map((k) => k.template), ...CODE_KINDS.map((k) => k.template)];
  const switchType = (key: string) => {
    const t = KINDS.find((k) => k.key === key)?.template ?? CODE_KINDS.find((k) => k.key === key)?.template;
    if (t === undefined || key === typeKey) return;
    if (draft.trim() && !templates.includes(draft) && !confirm('Replace the diagram with an example of the new type? The current code is lost.')) return;
    setDraft(t);
    setTab(KINDS.some((k) => k.key === key) ? 'form' : 'code');
  };
  const Form = kind?.Form;
  return createPortal(
    <Sheet xl onClose={onClose}>
      <h2>Diagram editor</h2>
      <div className="dge">
        <section className="dge-left" aria-label="Edit">
          <div className="dge-bar">
            <label htmlFor="dd-type" className="sr">Diagram type</label>
            <select id="dd-type" className="field" disabled={readOnly} value={typeKey} onChange={(e) => switchType(e.target.value)}>
              {typeKey === 'custom' && <option value="custom">Other / unknown</option>}
              <optgroup label="With a form">{KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}</optgroup>
              <optgroup label="Code only">{CODE_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}</optgroup>
            </select>
            <div className="seg sm" role="group" aria-label="Editor">
              <button type="button" data-act="dd-form" aria-pressed={tab === 'form'} onClick={() => setTab('form')}>Form</button>
              <button type="button" data-act="dd-code" aria-pressed={tab === 'code'} onClick={() => setTab('code')}>Code</button>
            </div>
          </div>
          <div className="dge-pane">
            {tab === 'form'
              ? (Form ? <Form text={draft} onChange={setDraft} readOnly={readOnly} /> : <p className="fe-unsupported">{draft.trim() ? 'There is no form for this diagram type – edit it as code.' : 'Pick a diagram type above to start from an example, or write Mermaid code.'}</p>)
              : <textarea className="blk-in mono dge-code" aria-label="Mermaid source" spellCheck={false} readOnly={readOnly} value={draft} onChange={(e) => setDraft(e.target.value)} />}
          </div>
        </section>
        <section className="dge-right" aria-label="Preview"><MermaidView text={draft} /></section>
      </div>
      <div className="btns dge-foot">
        <button type="button" className="btn" data-act="dd-cancel" onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</button>
        {!readOnly && <button type="button" className="btn primary" data-act="dd-apply" disabled={!dirty} onClick={() => { onApply(draft); onClose(); }}>Apply</button>}
      </div>
    </Sheet>,
    document.body,
  );
}
