// Free definition lookup for the glossary: Wikipedia and Wiktionary (Wikimedia REST APIs) and dictionaryapi.dev. No keys, no cost.
// The browser asks this server, the server asks the fixed hosts below – nothing user-supplied becomes a host or a path outside the query.
// Only the search term leaves the instance. The client name is generic (no e-mail address); results carry source, link and licence.
import { LOOKUP_ENABLED } from './config.js';
import { Limiter } from './ratelimit.js';

const UA = 'Garten-Specs/1.0 (self-hosted glossary lookup; +https://github.com/Kogoro/Garten)';
const LANGS = new Set(['en', 'de', 'fr', 'es', 'it', 'nl', 'pt']);
const TIMEOUT = 6000;

export class LookupError extends Error { constructor(m, status = 502) { super(m); this.status = status; } }

async function getJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT), redirect: 'follow' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
const httpsOr = (url, fallback) => { try { const u = new URL(String(url)); if (u.protocol === 'https:') return u.href; } catch { /* not a URL */ } return fallback; };
const strip = (s) => String(s ?? '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const cut = (s, n = 600) => (s.length > n ? `${s.slice(0, s.lastIndexOf(' ', n) > 200 ? s.lastIndexOf(' ', n) : n).trim()} …` : s);

async function wikipedia(q, lang) {
  const found = await getJson(`https://${lang}.wikipedia.org/w/rest.php/v1/search/title?q=${encodeURIComponent(q)}&limit=3`);
  const out = [];
  for (const p of found?.pages ?? []) {
    const sum = await getJson(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(p.title.replace(/ /g, '_'))}`);
    if (!sum?.extract || sum.type === 'disambiguation') continue;
    out.push({ source: 'Wikipedia', title: sum.title, text: cut(strip(sum.extract)), url: httpsOr(sum.content_urls?.desktop?.page, `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(p.title)}`), license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/' });
    if (out.length >= 2) break;
  }
  return out;
}

async function wiktionary(q, lang) {
  const data = await getJson(`https://${lang}.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(q)}`);
  const out = [];
  for (const [code, entries] of Object.entries(data ?? {})) {
    if (code !== lang && code !== 'en' && Object.keys(data).length > 1) continue;
    for (const e of entries) {
      const defs = (e.definitions ?? []).map((d) => strip(d.definition)).filter(Boolean).slice(0, 3);
      if (defs.length) out.push({ source: 'Wiktionary', title: `${q} (${e.partOfSpeech ?? code})`, text: cut(defs.join(' · ')), url: `https://${lang}.wiktionary.org/wiki/${encodeURIComponent(q)}`, license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/' });
      if (out.length >= 2) return out;
    }
  }
  return out;
}

async function dictionaryApi(q) {
  const data = await getJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(q)}`);
  const out = [];
  for (const e of Array.isArray(data) ? data : []) {
    for (const m of e.meanings ?? []) {
      const defs = (m.definitions ?? []).map((d) => strip(d.definition)).filter(Boolean).slice(0, 2);
      if (defs.length) out.push({ source: 'dictionaryapi.dev', title: `${e.word} (${m.partOfSpeech ?? ''})`.replace(' ()', ''), text: cut(defs.join(' · ')), url: httpsOr(e.sourceUrls?.[0], `https://en.wiktionary.org/wiki/${encodeURIComponent(q)}`), license: 'CC BY-SA 3.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/' });
      if (out.length >= 2) return out;
    }
  }
  return out;
}

const limiter = new Limiter({ windowMs: 60_000, max: 20 }); // a lookup fans out to several hosts: keep it modest
function throttle(userId) { if (!limiter.hit(userId)) throw new LookupError('Too many lookups – wait a minute.', 429); }

export async function lookupDefinitions(rawQuery, rawLang, userId) {
  if (!LOOKUP_ENABLED) throw new LookupError('Online lookup is switched off on this server (LOOKUP=0).', 404);
  const q = String(rawQuery ?? '').replace(/\s+/g, ' ').trim();
  if (q.length < 2 || q.length > 80) throw new LookupError('Enter a term of 2 to 80 characters.', 400);
  const lang = LANGS.has(String(rawLang)) ? String(rawLang) : 'en';
  throttle(userId);
  const jobs = [wikipedia(q, lang), wiktionary(q, lang), ...(lang === 'en' ? [dictionaryApi(q)] : [])];
  const settled = await Promise.allSettled(jobs);
  const results = settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
  if (!results.length && settled.every((s) => s.status === 'rejected')) throw new LookupError('No source could be reached. Online lookup needs internet access from the server.');
  return { query: q, lang, results };
}
