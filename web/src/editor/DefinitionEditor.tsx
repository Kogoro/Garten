import { Suspense, lazy } from 'react';

const SpecEditor = lazy(() => import('./SpecEditor').then((m) => ({ default: m.SpecEditor })));

/** The block editor for a term's definition (Markdown in, Markdown out) with its label and the formatting hint. */
export function DefinitionEditor({
  docKey,
  value,
  onChange,
  terms,
  id = 'gd-def',
}: {
  docKey: string;
  value: string;
  onChange: (md: string) => void;
  terms?: string[];
  id?: string;
}) {
  return (
    <div>
      <span className="field-lbl" id={`${id}-lbl`}>
        Definition
      </span>
      <div className="blocks term-body" id={id} aria-labelledby={`${id}-lbl`}>
        <Suspense
          fallback={
            <div className="editor-skeleton" role="status" aria-label="Loading the editor">
              <i />
              <i />
            </div>
          }
        >
          <SpecEditor docKey={docKey} value={value} readOnly={false} onChange={onChange} terms={terms} />
        </Suspense>
      </div>
      <small className="muted">
        {terms && terms.length > 0 && (
          <>
            Type <kbd>#</kbd> to reference another term,{' '}
          </>
        )}
        <kbd>/</kbd> for lists, headings, code and tables. Select text to format it.
      </small>
    </div>
  );
}
