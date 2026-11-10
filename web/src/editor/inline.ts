// Inline Markdown <-> BlockNote inline content. Specs store plain Markdown, so only the marks agents and Git can read
// are supported: **bold**, *italic*, ~~strike~~, `code` and [links](url). Everything else (incl. [[Term]] refs) stays literal text.
export type Styles = { bold?: true; italic?: true; strike?: true; code?: true };
export type Inline = { type: 'text'; text: string; styles: Styles } | { type: 'link'; href: string; content: Inline[] };

const TOKEN = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(~~[^~\n]+~~)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))/;

export function mdToInline(md: string, styles: Styles = {}): Inline[] {
  const out: Inline[] = [];
  let rest = md;
  while (rest) {
    const m = TOKEN.exec(rest);
    if (!m) { out.push({ type: 'text', text: rest, styles }); break; }
    if (m.index) out.push({ type: 'text', text: rest.slice(0, m.index), styles });
    const t = m[0];
    if (m[1]) out.push({ type: 'text', text: t.slice(1, -1), styles: { ...styles, code: true } });
    else if (m[2]) out.push(...mdToInline(t.slice(2, -2), { ...styles, bold: true }));
    else if (m[3]) out.push(...mdToInline(t.slice(2, -2), { ...styles, strike: true }));
    else if (m[4]) out.push(...mdToInline(t.slice(1, -1), { ...styles, italic: true }));
    else { const l = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t)!; out.push({ type: 'link', href: l[2], content: mdToInline(l[1], styles) }); }
    rest = rest.slice(m.index + t.length);
  }
  return out.length ? out : [];
}

const wrap = (t: string, s: Styles) => {
  if (!t) return t;
  if (s.code) return `\`${t}\``;
  let r = t;
  if (s.strike) r = `~~${r}~~`;
  if (s.italic) r = `*${r}*`;
  if (s.bold) r = `**${r}**`;
  return r;
};
export function inlineToMd(content: Inline[] | string | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content.map((c) => (c.type === 'link' ? `[${inlineToMd(c.content)}](${c.href})` : wrap(c.text, c.styles ?? {}))).join('');
}
