// Pushes a team's released specs to the team's own Git remote (the development project's repository).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DATA_DIR, GIT_ALLOW_HTTP, GIT_ALLOW_LOCAL, GIT_ALLOW_PRIVATE } from './config.js';
import { assertPublicRemote } from './netguard.js';
import { childEnv } from './env.js';
import { decrypt } from './secrets.js';
import { getTeam, recordPush, saveSshKey, TeamError } from './teams.js';
import { repoFor, events } from './store.js';

const run = promisify(execFile);
const protocols = ['https', 'ssh', ...(GIT_ALLOW_HTTP ? ['http'] : []), ...(GIT_ALLOW_LOCAL ? ['file'] : [])].join(':');

const knownHostsFile = (teamId) => path.join(DATA_DIR, 'known_hosts', teamId);

async function authEnv(team) {
  const r = team.row;
  const env = { GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: protocols, GIT_ASKPASS: 'true' };
  const cfg = [['http.followRedirects', 'false']]; // a remote must not redirect the request (with the token) to another host
  let cleanup = async () => {};
  if (r.git_auth === 'token' && r.git_secret) {
    const basic = Buffer.from(`${r.git_username || 'x-access-token'}:${decrypt(r.git_secret)}`).toString('base64');
    cfg.push(['http.extraHeader', `Authorization: Basic ${basic}`]);
  } else if (r.git_auth === 'ssh' && r.git_secret) {
    const dir = await mkdtemp(path.join(tmpdir(), 'specs-ssh-'));
    const keyFile = path.join(dir, 'id');
    await writeFile(keyFile, decrypt(r.git_secret).replace(/\r?\n?$/, '\n'), { mode: 0o600 });
    await mkdir(path.join(DATA_DIR, 'known_hosts'), { recursive: true, mode: 0o700 });
    env.GIT_SSH_COMMAND = `ssh -i ${keyFile} -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${knownHostsFile(team.id)}`;
    cleanup = () => rm(dir, { recursive: true, force: true });
  }
  env.GIT_CONFIG_COUNT = String(cfg.length);
  cfg.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
  return { env, cleanup };
}

const scrub = (team, msg) => {
  let s = String(msg ?? '');
  if (team.row.git_secret) { try { s = s.split(decrypt(team.row.git_secret)).join('***'); } catch { /* ignore */ } }
  s = s.replace(/(https?:\/\/)[^@/\s]+@/g, '$1***@').trim().split('\n').filter((l) => !/^\s*$/.test(l)).slice(0, 6).join('\n');
  // no address or port of the internal network in the message
  if (/Failed to connect|Could not resolve|Connection (refused|timed out|reset)|No route to host|Network is unreachable|Operation timed out|ssh: connect to host/i.test(s)) return 'The repository server could not be reached.';
  return s;
};
const fail = (team, e) => new TeamError(scrub(team, e.stderr || e.message) || 'git failed', 502);

/** Refuses remotes in private networks right before every network operation (the DNS answer may have changed since the URL was saved). */
async function guardRemote(url) {
  try { await assertPublicRemote(url, GIT_ALLOW_PRIVATE); } catch (e) { throw new TeamError(e.message, 400); }
}

/** SHA256 fingerprints of the host keys this server has learned for the team's remote. */
async function hostKeys(teamId) {
  try { return (await run('ssh-keygen', ['-l', '-f', knownHostsFile(teamId)], { env: childEnv(), timeout: 5000 })).stdout.split('\n').filter(Boolean).map((l) => l.trim()); } catch { return []; }
}
/** Forget the learned SSH host key (after the remote server really changed its key). */
export async function forgetHostKey(teamId) { await rm(knownHostsFile(teamId), { force: true }); }

export async function testRemote(teamId) {
  const team = getTeam(teamId);
  if (!team.row.git_url) throw new TeamError('No repository URL configured');
  await guardRemote(team.row.git_url);
  const { env, cleanup } = await authEnv(team);
  try {
    const out = (await run('git', ['ls-remote', '--heads', '--', team.row.git_url], { env: childEnv(env), timeout: 30000 })).stdout;
    const branch = team.row.git_branch;
    return { ok: true, branchExists: out.split('\n').some((l) => l.endsWith(`refs/heads/${branch}`)), ...(team.row.git_auth === 'ssh' ? { hostKeys: await hostKeys(teamId) } : {}) };
  } catch (e) {
    throw fail(team, e);
  } finally { await cleanup(); }
}

// Pushes of one team run one after the other, but only the local merge holds the repository lock: the network steps (fetch, push) can be slow or
// hang, and releases must not wait for them.
const pushChains = new Map();
export function pushTeam(teamId) {
  const run = (pushChains.get(teamId) ?? Promise.resolve()).catch(() => {}).then(() => pushNow(teamId));
  pushChains.set(teamId, run);
  return run;
}

async function pushNow(teamId) {
  const team = getTeam(teamId);
  if (!team.row.git_url) throw new TeamError('No repository URL configured');
  const repo = repoFor(team);
  await repo.ensure();
  const branch = team.row.git_branch;
  await guardRemote(team.row.git_url);
  const { env, cleanup } = await authEnv(team);
  try {
    const g = (...a) => repo.raw(env, ...a);
    await repo.lock(async () => {
      await repo.raw(null, 'remote', 'remove', 'origin').catch(() => {});
      await repo.raw(null, 'remote', 'add', 'origin', '--', team.row.git_url);
    });
    let remoteExists = true;
    try { await g('fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`); } // network, no lock
    catch (e) { if (/couldn't find remote ref/i.test(e.stderr ?? '')) remoteExists = false; else throw e; }
    const sha = await repo.lock(async () => { // local only: merge what the remote has, then name the commit that gets pushed
      if (remoteExists) {
        const anc = await repo.raw(null, 'merge-base', '--is-ancestor', `origin/${branch}`, 'HEAD').then(() => true, () => false);
        if (!anc) { // remote has work we do not have: merge it in, the Specs app wins conflicts on files it manages
          try { await repo.raw(null, 'merge', '--no-ff', '--allow-unrelated-histories', '-X', 'ours', '--no-edit', '-m', `Merge ${branch} from remote`, `origin/${branch}`); }
          catch (e) { await repo.raw(null, 'merge', '--abort').catch(() => {}); throw e; }
          // Text below the managed folder only counts when it was approved here: undo what the merge took from the remote there.
          const root = team.row.git_root;
          const changed = (await repo.raw(null, 'diff', '--name-only', 'HEAD^1', 'HEAD', '--', root)).split('\n').filter(Boolean);
          if (changed.length) {
            for (const f of changed) {
              const had = await repo.raw(null, 'cat-file', '-e', `HEAD^1:${f}`).then(() => true, () => false);
              if (had) await repo.raw(null, 'checkout', 'HEAD^1', '--', f); else await repo.raw(null, 'rm', '-q', '-f', '--', f);
            }
          }
          const dropped = await repo.dropLinks(); // symbolic links / submodules from the remote never enter the working tree
          if (changed.length || dropped.length) await repo.raw(null, 'commit', '--amend', '--no-edit', '--allow-empty');
        }
      }
      return (await repo.raw(null, 'rev-parse', 'HEAD')).trim();
    });
    await g('push', 'origin', `${sha}:refs/heads/${branch}`); // network, no lock; a commit made meanwhile is pushed by the next run
    let warning;
    try { await g('push', 'origin', '--tags'); } catch (e) { warning = `Pushed, but some tags were rejected: ${scrub(team, e.stderr || e.message).split('\n')[0]}`; }
    const result = { sha, warning };
    recordPush(teamId, { ok: true, sha: result.sha, error: result.warning });
    return result;
  } catch (e) {
    const err = e instanceof TeamError ? e : fail(team, e);
    recordPush(teamId, { ok: false, error: err.message });
    throw err;
  } finally { await cleanup(); }
}

export async function generateSshKey(teamId) {
  const team = getTeam(teamId);
  const dir = await mkdtemp(path.join(tmpdir(), 'specs-keygen-'));
  try {
    const file = path.join(dir, 'id');
    await run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', `specs-${team.key.toLowerCase()}`, '-f', file, '-q'], { env: childEnv() });
    const pub = (await readFile(`${file}.pub`, 'utf8')).trim();
    saveSshKey(teamId, await readFile(file, 'utf8'), pub);
    return pub;
  } catch (e) {
    throw new TeamError(e.code === 'ENOENT' ? 'ssh-keygen is not installed on the server' : 'Could not generate a key', 500);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

// ---- auto push after every release/revoke (debounced, never blocks the request that caused it)
// A failed push is tried again (1, 5, 30 minutes). After a restart, teams whose HEAD is not what was last pushed catch up.
const timers = new Map();
const RETRY_MS = [60_000, 300_000, 1_800_000];
function schedulePush(teamId, delay = 1500, attempt = 0) {
  clearTimeout(timers.get(teamId));
  const t = setTimeout(() => {
    const team = getTeam(teamId);
    if (!team?.row.git_url || !team.row.git_auto_push) return;
    pushTeam(teamId).catch((e) => {
      console.error(`auto-push ${team.key}:`, e.message);
      if (attempt < RETRY_MS.length) schedulePush(teamId, RETRY_MS[attempt], attempt + 1);
    });
  }, delay);
  t.unref?.();
  timers.set(teamId, t);
}
export function initAutoPush() {
  events.on('committed', (teamId) => {
    const t = getTeam(teamId);
    if (!t?.row.git_url || !t.row.git_auto_push) return;
    schedulePush(teamId);
  });
}
/** At startup: push whatever was released but not pushed before the server stopped. */
export async function catchUpPushes(teams) {
  for (const team of teams) {
    if (!team.row.git_url || !team.row.git_auto_push) continue;
    try {
      const head = (await repoFor(team).git('rev-parse', 'HEAD').catch(() => '')).trim();
      if (head && head !== team.row.git_last_sha) schedulePush(team.id, 5000);
    } catch (e) { console.error(`catch-up ${team.key}:`, e.message); }
  }
}
