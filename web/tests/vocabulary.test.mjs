import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

// Retired words (see docs/UI-VOCABULARY.md). Code comments may use any word; only text that people read is checked.
const RETIRED = [/\bPublish(ing|ed)?\b/, /\bgo live\b/i, /\bsign[- ]off\b/i];
const files = (dir) => readdirSync(dir).flatMap((f) => { const p = path.join(dir, f); return statSync(p).isDirectory() ? files(p) : /\.tsx$/.test(p) ? [p] : []; });

describe('interface vocabulary', () => {
  it('uses no retired word in visible text', () => {
    const hits = [];
    for (const f of files(SRC)) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '').replace(/\{\/\*.*?\*\/\}/g, '');
        if (RETIRED.some((r) => r.test(code))) hits.push(`${path.relative(SRC, f)}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
