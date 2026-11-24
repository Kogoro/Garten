// Images in specs and documents. An uploaded image is addressed by its content: images/<first 32 hex of its SHA-256>.<ext>.
// The Markdown keeps that relative path (![caption](images/….png)); the server stores the bytes, and a release writes them to
// <root>/images/ in the team's repository next to the spec files.

export const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
/** The largest image the server accepts, in bytes. */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** A file name of an uploaded image (without the images/ folder). */
export const IMAGE_NAME = /^[a-f0-9]{32}\.(?:png|jpg|gif|webp)$/;
/** images/<name> as written in Markdown. */
export const IMAGE_REF = /^images\/([a-f0-9]{32}\.(?:png|jpg|gif|webp))$/;
const IN_MARKDOWN = /!\[[^\]\n]*\]\(images\/([a-f0-9]{32}\.(?:png|jpg|gif|webp))(?:\s+"[^"\n]*")?\)/g;

/** The names of all uploaded images a Markdown text shows. */
export function imageRefs(md) {
  return [...String(md ?? '').matchAll(IN_MARKDOWN)].map((m) => m[1]);
}

/** The image type of some bytes, by their signature – never by what the client claims. Returns the extension or null. */
export function sniffImage(buf) {
  const b = buf;
  if (!b || b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
  if (
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  )
    return 'webp';
  return null;
}
