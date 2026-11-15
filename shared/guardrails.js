// The rules of a team's guardrails.md: "- G1: text" lines below "## Always" or "## Never". Pure functions, shared by server and browser.
const RULE = /^\s*[-*]\s*(G\d+)\s*[:.)-]\s*(.+?)\s*$/;
const H2 = /^##\s+(.+?)\s*#*\s*$/;

/** [{ id: 'G1', kind: 'always' | 'never' | null, text }] in document order; a repeated id keeps its first text. */
export function parseRules(md) {
  const out = []; const seen = new Set();
  let kind = null; let fence = false;
  for (const line of String(md ?? '').replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*```/.test(line)) { fence = !fence; continue; }
    if (fence || /^\s*<!--/.test(line)) continue;
    let m;
    if ((m = H2.exec(line))) { kind = /^always/i.test(m[1]) ? 'always' : /^never/i.test(m[1]) ? 'never' : null; continue; }
    if ((m = RULE.exec(line)) && !seen.has(m[1])) { seen.add(m[1]); out.push({ id: m[1], kind, text: m[2] }); }
  }
  return out;
}

/** { G1: 'text', … } – what a report records about the rules it was built against. */
export const ruleSnapshot = (rules) => Object.fromEntries(rules.map((r) => [r.id, r.text]));

/** Rules that are new or reworded since a snapshot. Removed rules ask nothing of the code, so they do not count. */
export function rulesChanged(rules, snapshot) {
  if (!snapshot) return [];
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  return rules.filter((r) => norm(snapshot[r.id]) !== norm(r.text)).map((r) => ({ ...r, change: r.id in snapshot ? 'changed' : 'added' }));
}
