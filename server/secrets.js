// Encrypts team secrets (git tokens, SSH private keys, webhook tokens) at rest with AES-256-GCM.
// v2: the key is derived from SECRET_KEY with scrypt (v1 used a bare SHA-256 and can still be read).
import { createCipheriv, createDecipheriv, randomBytes, createHash, scryptSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, SECRET_KEY } from './config.js';

function loadKeys() {
  if (SECRET_KEY) return { v1: createHash('sha256').update(SECRET_KEY).digest(), v2: scryptSync(SECRET_KEY, 'garten/secrets/v2', 32) };
  const file = path.join(DATA_DIR, 'secret.key');
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* not ours to change */ }
  const raw = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64'); // already 32 random bytes: no derivation needed
  return { v1: raw, v2: raw };
}
const keys = loadKeys();

export function encrypt(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keys.v2, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v2.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}
export function decrypt(blob) {
  const [v, iv, tag, enc] = String(blob).split('.');
  if (v !== 'v1' && v !== 'v2') throw new Error('unknown secret format');
  const d = createDecipheriv('aes-256-gcm', v === 'v2' ? keys.v2 : keys.v1, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}
