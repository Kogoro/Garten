// Audit log of security-relevant actions. Never put secrets (passwords, tokens, keys) into `detail`.
import { db } from './db.js';
import { AUDIT_RETENTION_DAYS } from './config.js';

const clip = (s, n) => (s == null ? null : String(s).replace(/[\r\n\0]+/g, ' ').slice(0, n));

/** audit(req, 'team.git.update', { team: id, target: 'SPEC', detail: { url } }) – `req` may be null (system actions); `actor` overrides req.user. */
export function audit(req, action, { team = null, target = null, detail = null, actor = null } = {}) {
  try {
    const u = actor ?? req?.user ?? null;
    db.prepare('INSERT INTO audit_log (at,actor_id,actor,team_id,action,target,ip,detail) VALUES (?,?,?,?,?,?,?,?)')
      .run(new Date().toISOString(), u?.id ?? null, clip(u?.email ?? null, 254), team, clip(action, 80), clip(target, 200), clip(req?.ip ?? null, 64), detail ? clip(JSON.stringify(detail), 1000) : null);
  } catch (e) { console.error('audit:', e.message); }
}

export function listAudit({ limit = 200, before, action, teamId } = {}) {
  const where = []; const args = [];
  if (before) { where.push('id < ?'); args.push(Number(before)); }
  if (action) { where.push('action LIKE ?'); args.push(`${String(action).replace(/[%_]/g, '')}%`); }
  if (teamId) { where.push('team_id = ?'); args.push(String(teamId)); }
  const rows = db.prepare(`SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).all(...args, Math.min(Math.max(Number(limit) || 200, 1), 1000));
  return rows.map((r) => ({ id: r.id, at: r.at, actorId: r.actor_id, actor: r.actor, teamId: r.team_id, action: r.action, target: r.target, ip: r.ip, detail: r.detail ? JSON.parse(r.detail) : null }));
}

export function pruneAudit() {
  const cutoff = new Date(Date.now() - AUDIT_RETENTION_DAYS * 86400_000).toISOString();
  db.prepare('DELETE FROM audit_log WHERE at < ?').run(cutoff);
}
