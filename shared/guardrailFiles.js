// Guardrails are a folder of rule files: one Markdown file per rule under docs/guardrails/ (sub-folders group rules).
//
//   ---
//   id: G7
//   rule: "Never store card numbers, not even truncated or encrypted."
//   kind: never
//   see: ["G3", "[[Card token]]"]
//   ---
//   **Why:** PCI DSS scope. …
//
// `id`, `rule` and `kind` are binding: a new or reworded rule puts implemented specs back on the work list. The body explains the
// rule (why, what to do instead, exceptions) and changes nothing for code that was built already. Ids are given by the server,
// never reused, and do not depend on the file name. Rules an agent proposes live in guardrails/_proposed/ (never released, no id)
// until an approver accepts them. Pure functions: shared by the server (migration, GUARDRAILS.md, MCP) and the browser.
import { FM, unquote, parseList, slugify, folderSegment } from './glossaryFiles.js';
import { parseRules } from './guardrails.js';

export const GUARDRAILS_DIR = 'guardrails';
export const PROPOSED_RULES_DIR = 'guardrails/_proposed';
export const isGuardrailsPath = (id) => id === GUARDRAILS_DIR || String(id).startsWith(`${GUARDRAILS_DIR}/`);
export const isProposedRulePath = (id) => id === PROPOSED_RULES_DIR || String(id).startsWith(`${PROPOSED_RULES_DIR}/`);
/** A path where a live rule file may sit (the body still has to carry front matter with `rule:`). */
export const isRulePath = (id) => String(id).startsWith(`${GUARDRAILS_DIR}/`) && String(id).endsWith('.md') && !isProposedRulePath(id);
export const RULE_ID = /^G[1-9]\d{0,5}$/;
export const KINDS = ['always', 'never'];

/**
 * @typedef {{ id: string|null, rule: string, kind: 'always'|'never', see: string[], requiredBy: string|null, proposedBy: string|null, from: string|null, body: string }} RuleFile
 */
/** @param {string} md @returns {RuleFile|null} Front matter + body, or null when this is not a rule file. */
export function parseRuleFile(md) {
  const text = String(md ?? '').replace(/^﻿/, '');
  const m = FM.exec(text);
  if (!m) return null;
  /** @type {Record<string, any>} */
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const k = kv[1].toLowerCase();
    meta[k] = k === 'see' ? parseList(kv[2]) : unquote(kv[2]);
  }
  const rule = String(meta.rule ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!rule) return null;
  const id = String(meta.id ?? '')
    .trim()
    .toUpperCase();
  return {
    id: RULE_ID.test(id) ? id : null,
    rule,
    kind: String(meta.kind ?? '').toLowerCase() === 'never' ? 'never' : 'always',
    see: meta.see ?? [],
    // parent teams only: after this date (YYYY-MM-DD) the rule applies to child teams even before they accept the foundation update
    requiredBy: /^\d{4}-\d{2}-\d{2}$/.test(String(meta.required_by ?? '').trim()) ? String(meta.required_by).trim() : null,
    proposedBy: meta.proposed_by ?? null,
    from: meta.from ?? null,
    body: text
      .slice(m[0].length)
      .replace(/^\s*\n/, '')
      .trimEnd(),
  };
}

const q = (s) =>
  JSON.stringify(
    String(s ?? '')
      .replace(/[\r\n]+/g, ' ')
      .trim(),
  );
/** { id?, rule, kind, see?, requiredBy?, proposedBy?, from?, body? } -> Markdown with front matter */
export function formatRuleFile(r) {
  const lines = [];
  if (r.id) lines.push(`id: ${r.id}`);
  lines.push(`rule: ${q(String(r.rule ?? '').replace(/\s+/g, ' '))}`, `kind: ${r.kind === 'never' ? 'never' : 'always'}`);
  const see = (r.see ?? [])
    .map((x) =>
      String(x)
        .replace(/[\r\n]+/g, ' ')
        .trim(),
    )
    .filter(Boolean);
  if (see.length) lines.push(`see: [${see.map((x) => JSON.stringify(x)).join(', ')}]`);
  if (r.requiredBy && /^\d{4}-\d{2}-\d{2}$/.test(r.requiredBy)) lines.push(`required_by: ${r.requiredBy}`);
  if (r.proposedBy) lines.push(`proposed_by: ${q(r.proposedBy)}`);
  if (r.from) lines.push(`from: ${q(r.from)}`);
  const body = String(r.body ?? '').trim();
  return `---\n${lines.join('\n')}\n---\n${body ? `\n${body}\n` : ''}`;
}

/** File name of a rule: its first words ("Never store card numbers, not even …" -> never-store-card-numbers-not-even). */
export const ruleSlug = (rule) =>
  slugify(
    String(rule ?? '')
      .split(/\s+/)
      .slice(0, 6)
      .join(' '),
  ).replace(/^term$/, 'rule');

/**
 * Path for a rule in a folder ("" = top level); `taken(path)` says whether a path is used already.
 * @param {string} folder @param {string} rule @param {(p: string) => boolean} [taken] @param {string} [dir]
 */
export function rulePath(folder, rule, taken = (_p) => false, dir = GUARDRAILS_DIR) {
  const base = `${dir}${folder ? `/${folder}` : ''}/${ruleSlug(rule)}`;
  let p = `${base}.md`;
  for (let n = 2; taken(p); n++) p = `${base}-${n}.md`;
  return p;
}
/** guardrails/security/x.md -> "security"; guardrails/x.md -> "" */
export const ruleFolder = (path) => String(path).split('/').slice(1, -1).join('/');

/** The number of a rule id (G12 -> 12), 0 for anything else. */
export const ruleNumber = (id) => (RULE_ID.test(String(id ?? '')) ? Number(String(id).slice(1)) : 0);

/**
 * The rules of a set of files: [{ id, kind, text, path, folder, body, see, requiredBy }], sorted by number. Files without a valid id or with an id
 * an earlier file already has are left out (the server gives every saved rule a unique id, so this only happens to hand-made files).
 * @param {{ id: string, body: string }[]} files
 */
export function rulesOf(files) {
  const out = [];
  const seen = new Set();
  for (const f of [...files].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!isRulePath(f.id)) continue;
    const r = parseRuleFile(f.body);
    if (!r?.id || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({
      id: r.id,
      kind: r.kind,
      text: r.rule,
      path: f.id,
      folder: ruleFolder(f.id),
      body: r.body,
      see: r.see,
      requiredBy: r.requiredBy,
    });
  }
  return out.sort((a, b) => ruleNumber(a.id) - ruleNumber(b.id));
}

/** GUARDRAILS.md: every rule on one line under "## Always" / "## Never" (the format the old guardrails.md had, so parseRules reads it). */
export function guardrailsMarkdown(rules) {
  let md =
    '# Guardrails\n\n<!-- Generated from the rule files in docs/guardrails/ (one file per rule, with the reasons). Binding on every task. -->\n';
  for (const kind of KINDS) {
    const list = rules.filter((r) => r.kind === kind);
    if (!list.length) continue;
    md += `\n## ${kind === 'always' ? 'Always' : 'Never'}\n\n${list.map((r) => `- ${r.id}: ${r.text}`).join('\n')}\n`;
  }
  return md;
}

/**
 * The old single guardrails.md -> { rules: [{ id, kind, text, folder }], rest }. Rules under "## Always" / "## Never" take that kind;
 * rules under any other "##" heading go into a folder of that name and take their kind from the wording ("Never …", "Do not …").
 * `rest` is any text that is neither a heading, a comment nor a rule (kept by the migration as a note so nothing is lost).
 */
export function splitGuardrailsMd(md) {
  const text = String(md ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '');
  const rules = [];
  const restLines = [];
  let folder = '';
  let fence = false;
  const parsed = new Map(parseRules(text).map((r) => [r.id, r]));
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence;
    const h = !fence && /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      if (h[1].length === 2) folder = /^(always|never)\b/i.test(h[2]) ? '' : folderSegment(h[2]);
      continue;
    }
    const rm = !fence && /^\s*[-*]\s*(G\d+)\s*[:.)-]\s*(.+?)\s*$/.exec(line);
    const r = rm && parsed.get(rm[1]);
    if (r && !rules.some((x) => x.id === r.id)) {
      const kind = r.kind ?? (/^\s*(never|do not|don't|no)\b/i.test(r.text) ? 'never' : 'always');
      rules.push({ id: r.id, kind, text: r.text, folder });
      continue;
    }
    if (rm) continue;
    restLines.push(line);
  }
  return {
    rules,
    rest: restLines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  };
}
