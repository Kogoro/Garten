export const GUARDRAILS = 'guardrails.md';

/** Adds "- G<n>: text" below "## Always" or "## Never" (sections are created when missing). Rule numbers keep counting. */
export function addRule(body: string, text: string, where: 'Always' | 'Never'): string {
  const clean = text.replace(/\s*\n\s*/g, ' ').trim();
  const max = Math.max(0, ...[...body.matchAll(/^\s*[-*]\s*G(\d+)\b/gm)].map((m) => Number(m[1])));
  const line = `- G${max + 1}: ${clean}`;
  const head = new RegExp(`^##\\s+${where}\\s*$`, 'm');
  const m = head.exec(body);
  if (!m) return `${body.replace(/\s+$/, '')}\n\n## ${where}\n\n${line}\n`;
  const after = m.index + m[0].length;
  const rest = body.slice(after);
  const next = /^##\s/m.exec(rest);
  const end = after + (next ? next.index : rest.length);
  return `${body.slice(0, end).replace(/\s+$/, '')}\n${line}\n${next ? `\n${body.slice(end)}` : ''}`;
}

