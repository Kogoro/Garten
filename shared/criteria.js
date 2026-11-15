// What a spec asks for, as a list the server can hold an implementation report against: every requirement ("R1 text")
// and every item under an acceptance-criteria heading ("- [ ] text" or "- text"). Pure functions, shared by server and browser.

const FENCE = /^\s*```/;
const H2 = /^##\s+(.+?)\s*#*\s*$/;
const REQ = /^(R\d+)\s+(.+)$/;
const ITEM = /^\s*[-*+]\s+(?:\[[ xX]\]\s*)?(.+)$/;
/** Sections whose list items are acceptance criteria. */
export const isCriteriaHeading = (h) => /accept|criteri|definition of done/i.test(String(h ?? ''));
export const CRITERION_ID = /^(?:R|AC)\d+$/;

/** Strips Markdown decoration so the same criterion matches however it was quoted. */
export const normCriterion = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s.;:]+$/, '')
    .trim();

/** [{ id: 'R1' | 'AC1', text, section }] in the order of the spec. Requirement ids come from the spec, acceptance criteria are numbered AC1, AC2 … */
export function specCriteria(md) {
  const body = String(md ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/^---\n[\s\S]*?\n---\n/, '');
  const out = [];
  const seen = new Set();
  let section = '';
  let fence = false;
  let ac = 0;
  for (const line of body.split('\n')) {
    if (FENCE.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    let m;
    if ((m = H2.exec(line))) {
      section = m[1];
      continue;
    }
    if ((m = REQ.exec(line.trim()))) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        out.push({ id: m[1], text: m[2].trim(), section });
      }
    } else if (isCriteriaHeading(section) && (m = ITEM.exec(line)) && m[1].trim()) {
      const id = `AC${++ac}`;
      seen.add(id);
      out.push({ id, text: m[1].trim(), section });
    }
  }
  return out;
}

/** The spec criterion a reported one refers to: by id, by a leading "R2"/"AC1", or by its text. */
export function findCriterion(list, reported) {
  const id = String(reported?.id ?? '')
    .trim()
    .toUpperCase();
  if (id) return list.find((c) => c.id === id) ?? null;
  const text = String(reported?.text ?? '').trim();
  const lead = /^((?:R|AC)\d+)\b/i.exec(text)?.[1]?.toUpperCase();
  if (lead) {
    const hit = list.find((c) => c.id === lead);
    if (hit) return hit;
  }
  const n = normCriterion(text);
  if (!n) return null;
  return (
    list.find((c) => normCriterion(c.text) === n) ??
    list.find((c) => {
      const k = normCriterion(c.text);
      return k.length >= 8 && n.includes(k);
    }) ??
    null
  );
}
