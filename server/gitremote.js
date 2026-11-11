// Pushes a team's released specs to the team's own Git remote (the development project's repository).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DATA_DIR, GIT_ALLOW_HTTP, GIT_ALLOW_LOCAL } from './config.js';
import { decrypt } from './secrets.js';
import { getTeam, recordPush, saveSshKey, TeamError } from './teams.js';
import { repoFor, events } from './store.js';

const run = promisify(execFile);
const protocols = ['https', 'ssh', ...(GIT_ALLOW_HTTP ? ['http'] : []), ...(GIT_ALLOW_LOCAL ? ['file'] : [])].join(':');

async function authEnv(team) {
  const r = team.row;
  const env = { GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: protocols, GIT_ASKPASS: 'true' };
  let cleanup = async () => {};
  if (r.git_auth === 'token' && r.git_secret) {
    const basic = Buffer.from(`${r.git_username || 'x-access-token'}:${decrypt(r.git_secret)}`).toString('base64');
    Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` });
  } else if (r.git_auth === 'ssh' && r.git_secret) {
    const dir = await mkdtemp(path.join(tmpdir(), 'specs-ssh-'));
    const keyFile = path.join(dir, 'id');
    await writeFile(keyFile, decrypt(r.git_secret).replace(/\r?\n?$/, '\n'), { mode: 0o600 });
    env.GIT_SSH_COMMAND = `ssh -i ${keyFile} -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${path.join(DATA_DIR, 'known_hosts')}`;
    cleanup = () => rm(dir, { recursive: true, force: true });
  }
  return { env, cleanup };
}

const scrub = (team, msg) => {
  let s = String(msg ?? '');
  if (team.row.git_secret) { try { s = s.split(decrypt(team.row.git_secret)).join('***'); } catch { /* ignore */ } }
  return s.replace(/(https?:\/\/)[^@/\s]+@/g, '$1***@').trim().split('\n').filter((l) => !/^\s*$/.test(l)).slice(0, 6).join('\n');
};
const fail = (team, e) => new TeamError(scrub(team, e.stderr || e.message) || 'git failed', 502);

export async function testRemote(teamId) {
  const team = getTeam(teamId);
  if (!team.row.git_url) throw new TeamError('No repository URL configured');
  const { env, cleanup } = await authEnv(team);
  try {
    const out = (await run('git', ['ls-remote', '--heads', '--', team.row.git_url], { env: { ...process.env, LC_ALL: 'C', LANGUAGE: 'C', ...env }, timeout: 30000 })).stdout;
    const branch = team.row.git_branch;
    return { ok: true, branchExists: out.split('\n').some((l) => l.endsWith(`refs/heads/${branch}`)) };
  } catch (e) {
    throw fail(team, e);
  } finally { await cleanup(); }
}

export async function pushTeam(teamId) {
  const team = getTeam(teamId);
  if (!team.row.git_url) throw new TeamError('No repository URL configured');
  const repo = repoFor(team);
  await repo.ensure();
  const branch = team.row.git_branch;
  const { env, cleanup } = await authEnv(team);
  try {
    const result = await repo.lock(async () => {
      const g = (...a) => repo.raw(env, ...a);
      await repo.raw(null, 'remote', 'remove', 'origin').catch(() => {});
      await repo.raw(null, 'remote', 'add', 'origin', '--', team.row.git_url);
      let remoteExists = true;
      try { await g('fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`); }
      catch (e) { if (/couldn't find remote ref/i.test(e.stderr ?? '')) remoteExists = false; else throw e; }
      if (remoteExists) {
        const anc = await repo.raw(null, 'merge-base', '--is-ancestor', `origin/${branch}`, 'HEAD').then(() => true, () => false);
        if (!anc) { // remote has work we do not have: merge it in, the Specs app wins conflicts on files it manages
          try { await repo.raw(null, 'merge', '--allow-unrelated-histories', '-X', 'ours', '--no-edit', '-m', `Merge ${branch} from remote`, `origin/${branch}`); }
          catch (e) { await repo.raw(null, 'merge', '--abort').catch(() => {}); throw e; }
        }
      }
      await g('push', 'origin', `HEAD:refs/heads/${branch}`);
      let warning;
      try { await g('push', 'origin', '--tags'); } catch (e) { warning = `Pushed, but some tags were rejected: ${scrub(team, e.stderr || e.message).split('\n')[0]}`; }
      return { sha: (await repo.raw(null, 'rev-parse', 'HEAD')).trim(), warning };
    });
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
    await run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', `specs-${team.key.toLowerCase()}`, '-f', file, '-q']);
    const pub = (await readFile(`${file}.pub`, 'utf8')).trim();
    saveSshKey(teamId, await readFile(file, 'utf8'), pub);
    return pub;
  } catch (e) {
    throw new TeamError(e.code === 'ENOENT' ? 'ssh-keygen is not installed on the server' : 'Could not generate a key', 500);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

// ---- auto push after every release/revoke (debounced, never blocks the request that caused it)
const timers = new Map();
export function initAutoPush() {
  events.on('committed', (teamId) => {
    const t = getTeam(teamId);
    if (!t?.row.git_url || !t.row.git_auto_push) return;
    clearTimeout(timers.get(teamId));
    timers.set(teamId, setTimeout(() => pushTeam(teamId).catch((e) => console.error(`auto-push ${t.key}:`, e.message)), 1500));
  });
}
