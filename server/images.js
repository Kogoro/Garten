// Images in specs and documents: stored in the database by content hash while people write, written to <root>/images/ in the
// team's repository when a spec or document that shows them is released (see syncImages, called from every release commit).
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sql } from './db.js';
import { IMAGE_TYPES, IMAGE_MAX_BYTES, IMAGE_NAME, imageRefs, sniffImage } from '../shared/images.js';

export class ImageError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Stores an image for a team; the same bytes twice give the same name. Returns { name, src, mime, size }. */
export function saveImage(teamId, buf, by = null) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new ImageError('Send the image as the request body');
  if (buf.length > IMAGE_MAX_BYTES) throw new ImageError(`The image is larger than ${IMAGE_MAX_BYTES / 1024 / 1024} MB`, 413);
  const ext = sniffImage(buf);
  if (!ext) throw new ImageError('Only PNG, JPEG, GIF and WebP images can be uploaded', 415);
  const name = `${createHash('sha256').update(buf).digest('hex').slice(0, 32)}.${ext}`;
  sql('INSERT OR IGNORE INTO images (team_id,name,mime,size,data,created_by,created_at) VALUES (?,?,?,?,?,?,?)').run(
    teamId,
    name,
    IMAGE_TYPES[ext],
    buf.length,
    buf,
    by,
    new Date().toISOString(),
  );
  return { name, src: `images/${name}`, mime: IMAGE_TYPES[ext], size: buf.length };
}

/** { mime, data } of a team's image, or null. */
export function getImage(teamId, name) {
  if (!IMAGE_NAME.test(String(name))) return null;
  const r = sql('SELECT mime, data FROM images WHERE team_id=? AND name=?').get(teamId, name);
  return r ? { mime: String(r.mime), data: Buffer.from(/** @type {Uint8Array} */ (r.data)) } : null;
}

/**
 * Runs inside a release commit (store.js, tidy): every image the released files show is written to <root>/images/, images no
 * released file shows any more are removed. An image the database no longer has stays as it is in the repository.
 */
export async function syncImages(teamId, root, repo) {
  const prefix = root ? `${root}/` : '';
  const wanted = new Set();
  for (const f of await repo.walk(root || '.')) {
    const rel = f.slice(prefix.length);
    if (rel.startsWith('images/') || !/\.md$/i.test(rel)) continue;
    for (const n of imageRefs(await repo.readFile(f).catch(() => ''))) wanted.add(n);
  }
  const dir = `${prefix}images`;
  const have = new Set((await repo.walk(dir)).map((f) => f.slice(dir.length + 1)));
  for (const n of have) if (!wanted.has(n)) await repo.commitRemove(`${dir}/${n}`);
  for (const n of wanted) {
    if (have.has(n)) continue;
    const img = getImage(teamId, n);
    if (img) await repo.commitWrite(`${dir}/${n}`, img.data);
  }
}

/** Images no item of the team shows any more and that are older than `days` (an offline client may still hold a reference). */
export function pruneImages(days = 30) {
  const before = new Date(Date.now() - days * 86400_000).toISOString();
  const bodies = new Map();
  let n = 0;
  for (const r of sql('SELECT team_id, name FROM images WHERE created_at < ?').all(before)) {
    const t = String(r.team_id);
    if (!bodies.has(t))
      bodies.set(
        t,
        new Set(
          sql('SELECT body FROM items WHERE team_id=? AND deleted=0')
            .all(t)
            .flatMap((i) => imageRefs(String(i.body))),
        ),
      );
    if (!bodies.get(t).has(String(r.name))) n += Number(sql('DELETE FROM images WHERE team_id=? AND name=?').run(t, r.name).changes);
  }
  return n;
}

/**
 * An image as a team sees it: its own upload, else the released copy in its repository, else the image of a team that shares
 * items with it (shared specs and documents show their owner's images). `repoOf(team)` gives a team's repository.
 * @param {{ id: string, row: { git_root: string } }} team
 * @param {string} name
 * @param {(t: any) => any} repoOf
 * @param {any[]} owners teams whose shared items this team accepted
 */
export async function findImage(team, name, repoOf, owners = []) {
  if (!IMAGE_NAME.test(String(name))) return null;
  for (const t of [team, ...owners]) {
    const img = getImage(t.id, name);
    if (img) return img;
    const repo = repoOf(t);
    const rel = `${t.row.git_root}/images/${name}`;
    if (await repo.exists(rel)) return { mime: IMAGE_TYPES[name.split('.').pop()], data: await readFile(repo.safe(rel)) };
  }
  return null;
}
