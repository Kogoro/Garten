// Keeps server-side requests (webhooks, git remotes) away from the machine's own network: loopback, private, link-local and metadata ranges.
import dns from 'node:dns';
import net from 'node:net';

const blocked = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) blocked.addSubnet(a, p, 'ipv6');

/** True for private/local addresses – and for anything that is not an IP address at all. */
export const isPrivate = (address) => {
  let a = String(address);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a); // IPv4-mapped IPv6
  if (mapped) a = mapped[1];
  const fam = net.isIP(a);
  return fam === 0 || blocked.check(a, fam === 6 ? 'ipv6' : 'ipv4');
};

/** Host names that can never be public. */
export const isLocalName = (host) => host === 'localhost' || /\.(localhost|local|internal|lan|home|localdomain)$/.test(host) || !host.includes('.') && net.isIP(host) === 0;

/** Static check of a host name or literal IP (no DNS). */
export function isPrivateHostLiteral(rawHost) {
  const host = String(rawHost ?? '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return true;
  if (net.isIP(host)) return isPrivate(host);
  return isLocalName(host);
}

/** dns.lookup replacement for http(s).request: refuses private results unless allowLocal. Checked at connection time (no DNS rebinding). */
export const makeSafeLookup = (allowLocal) => (host, opts, cb) => {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  dns.lookup(host, { ...opts, all: true }, (err, list) => {
    if (err) return cb(err);
    if (!allowLocal && list.some((a) => isPrivate(a.address))) return cb(new Error('the address is private or local – not allowed'));
    if (opts.all) cb(null, list); else cb(null, list[0].address, list[0].family);
  });
};

/** The host a git remote URL points to (https://, http://, ssh://, user@host:path), or null for a local path. */
export function gitHost(url) {
  const u = String(url ?? '').trim();
  if (!u || u.startsWith('/')) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) { try { return new URL(u).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return ''; } }
  const m = /^[\w.-]+@([\w.-]+):/.exec(u);
  return m ? m[1].toLowerCase() : '';
}

/** Resolves the host of a git remote and refuses private addresses. Called right before every network operation. */
export async function assertPublicRemote(url, allowPrivate) {
  const host = gitHost(url);
  if (host === null || allowPrivate) return;
  const refuse = () => { const e = new Error('This repository address points into a private or local network. Set GIT_ALLOW_PRIVATE=1 on the server to allow that.'); e.status = 400; e.guard = true; return e; };
  if (!host || isPrivateHostLiteral(host)) throw refuse();
  if (net.isIP(host)) return;
  let list;
  try { list = await dns.promises.lookup(host, { all: true }); } catch { return; } // unresolvable: git reports it
  if (list.some((a) => isPrivate(a.address))) throw refuse();
}
