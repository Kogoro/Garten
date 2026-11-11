// Hourly cleanup: expired sessions, OAuth requests/codes/tokens, old invitations, unused dynamic clients, old audit entries.
import { db } from './db.js';
import { pruneAudit } from './audit.js';

export function sweepExpired() {
  const t = Math.floor(Date.now() / 1000);
  const old = new Date(Date.now() - 30 * 86400_000).toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(t);
  db.prepare('DELETE FROM oauth_requests WHERE expires_at < ?').run(t);
  db.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').run(t);
  db.prepare('DELETE FROM oauth_tokens WHERE revoked=1 OR refresh_expires_at < ?').run(t);
  db.prepare('DELETE FROM pats WHERE revoked=1 OR expires_at < ?').run(t - 30 * 86400);
  db.prepare('DELETE FROM invites WHERE expires_at < ?').run(t - 30 * 86400);
  db.prepare(`DELETE FROM oauth_clients WHERE created_at < ? AND client_id NOT IN (SELECT client_id FROM oauth_tokens)
              AND client_id NOT IN (SELECT client_id FROM oauth_requests) AND client_id NOT IN (SELECT client_id FROM oauth_codes)`).run(old);
  pruneAudit();
}

export function startJanitor() {
  const run = () => { try { sweepExpired(); } catch (e) { console.error('cleanup:', e.message); } };
  run();
  setInterval(run, 3600_000).unref();
}
