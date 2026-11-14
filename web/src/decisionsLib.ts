// A person's decision, written into the spec it belongs to. Pure functions (no DOM, no store), so they can be tested on their own.

/** One line that records a person's decision in the spec, so the next version carries it and no agent asks again. */
export function decisionLine(d: { text: string; options?: { label: string }[] }, answer: number, note: string, by?: string | null, at?: string | null): string {
  const flat = (x: string) => x.replace(/\s*\n\s*/g, ' ').trim();
  const chosen = answer >= 0 ? d.options?.[answer]?.label ?? '' : '';
  const said = [chosen, flat(note ?? '')].filter(Boolean).join(' – ');
  const who = [by, at ? at.slice(0, 10) : null].filter(Boolean).join(', ');
  return `- ${flat(d.text)} → ${said || 'see note'}${who ? ` (${who})` : ''}`;
}
/** Whether the spec already records this question (any answer): the question text is the key. */
export const hasDecision = (body: string, question: string) => body.includes(`- ${question.replace(/\s*\n\s*/g, ' ').trim()} → `);
/** Adds the decision under "## DECISIONS" (created when missing); an earlier line for the same question is replaced. */
export function addDecisionToSpec(body: string, d: { text: string; options?: { label: string }[] }, answer: number, note: string, by?: string | null, at?: string | null): string {
  const line = decisionLine(d, answer, note, by, at);
  const prefix = `- ${d.text.replace(/\s*\n\s*/g, ' ').trim()} → `;
  const lines = body.split('\n');
  const old = lines.findIndex((l) => l.startsWith(prefix));
  if (old >= 0) { lines[old] = line; return lines.join('\n'); }
  const m = /^##\s+DECISIONS\s*$/m.exec(body);
  if (!m) return `${body.replace(/\s+$/, '')}\n\n## DECISIONS\n\n${line}\n`;
  const rest = body.slice(m.index + m[0].length);
  const next = /^##\s/m.exec(rest);
  const end = m.index + m[0].length + (next ? next.index : rest.length);
  return `${body.slice(0, end).replace(/\s+$/, '')}\n${line}\n${next ? `\n${body.slice(end)}` : ''}`;
}
