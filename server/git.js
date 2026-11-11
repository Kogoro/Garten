import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, rm, readFile, access, readdir } from 'node:fs/promises';
import path from 'node:path';

const run = promisify(execFile);

/** Thin wrapper around the git CLI. All mutations are serialised. */
export class Repo {
  constructor(dir) {
    this.dir = dir;
    this.queue = Promise.resolve();
  }

  raw(env, ...args) {
    return run('git', args, { cwd: this.dir, maxBuffer: 32 * 1024 * 1024, timeout: 120000, killSignal: 'SIGKILL', env: { ...process.env, LC_ALL: 'C', LANGUAGE: 'C', ...env } }).then((r) => r.stdout);
  }

  /** git in the repo; initialises it on first use. */
  async git(...args) { await this.ensure(); return this.raw(null, ...args); }
  async gitWith(env, ...args) { await this.ensure(); return this.raw(env, ...args); }
  ensure() {
    // A failed init is not cached: the next call tries again.
    return (this.ready ??= this.init().catch((e) => { this.ready = null; throw e; }));
  }
  /** Run `fn` while no other mutation (commit, push) is in flight. */
  lock(fn) {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  safe(rel) {
    const abs = path.resolve(this.dir, rel);
    if (!abs.startsWith(this.dir + path.sep)) throw new Error(`unsafe path: ${rel}`);
    return abs;
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
    try {
      await access(path.join(this.dir, '.git'));
    } catch {
      await this.raw(null, 'init', '-b', 'main');
    }
    // A killed git leaves its lock behind; nothing else uses this repo, so it is stale. Drop whatever a crash left half done.
    await rm(path.join(this.dir, '.git', 'index.lock'), { force: true });
    await this.raw(null, 'config', 'user.name', 'Specs');
    await this.raw(null, 'config', 'user.email', 'specs@localhost');
    await this.raw(null, 'config', 'commit.gpgsign', 'false');
    await this.raw(null, 'config', 'tag.gpgsign', 'false');
  }

  /** Write/remove files, commit and optionally tag. Returns the commit sha or null if nothing changed. */
  commit({ write = {}, remove = [], message, tag, author, post }) {
    const job = async () => {
      await this.ensure();
      try {
        return await attempt();
      } catch (e) {
        // Never leave unreleased text in the working tree: agents read it and the next release would commit it.
        await rm(path.join(this.dir, '.git', 'index.lock'), { force: true }).catch(() => {});
        await this.raw(null, 'reset', '--hard', 'HEAD').catch(() => {});
        await this.raw(null, 'clean', '-fdq').catch(() => {});
        throw e;
      }
    };
    const attempt = async () => {
      for (const [rel, content] of Object.entries(write)) {
        const abs = this.safe(rel);
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, content);
      }
      for (const rel of remove) await rm(this.safe(rel), { force: true });
      if (post) await post(this); // e.g. regenerate GLOSSARY.md, tidy orphaned documents
      await this.git('add', '-A');
      const status = (await this.git('status', '--porcelain')).trim();
      if (!status) return null;
      const who = author?.name && author?.email
        ? ['--author', `${author.name.replace(/[<>\n]/g, '')} <${author.email.replace(/[<>\n]/g, '')}>`]
        : [];
      await this.git('commit', '-m', message, ...who);
      const sha = (await this.git('rev-parse', 'HEAD')).trim();
      if (tag) await this.git('tag', '-f', tag);
      return sha;
    };
    return this.lock(job);
  }

  /** For use inside a `post` hook: write / remove a file in the working tree before it is committed. */
  async commitWrite(rel, content) { const abs = this.safe(rel); await mkdir(path.dirname(abs), { recursive: true }); await writeFile(abs, content); }
  async commitRemove(rel) { await rm(this.safe(rel), { force: true }); }

  /** Tag a commit without creating a new one (used when an approval changes nothing in the tree). */
  tag(name) {
    return this.lock(() => this.git('tag', '-f', name));
  }

  async readFile(rel, ref) {
    if (ref) {
      this.safe(rel);
      return this.git('show', `${ref}:${rel}`);
    }
    return readFile(this.safe(rel), 'utf8');
  }

  async exists(rel) {
    try {
      await access(this.safe(rel));
      return true;
    } catch {
      return false;
    }
  }

  async tags(prefix) {
    const out = await this.git('tag', '-l', `${prefix}*`, '--sort=version:refname');
    return out.split('\n').filter(Boolean);
  }

  /** All files below `rel` (relative to the repo, '/' separated). */
  async walk(rel) {
    const out = [];
    const rec = async (r) => {
      let ents = [];
      try { ents = await readdir(this.safe(r), { withFileTypes: true }); } catch { return; }
      for (const e of ents) (e.isDirectory() ? await rec(`${r}/${e.name}`) : out.push(`${r}/${e.name}`));
    };
    await rec(rel);
    return out;
  }
}
