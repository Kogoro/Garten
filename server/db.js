import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const db = new DatabaseSync(path.join(DATA_DIR, 'specs.db'));
{
  const hasUsers = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").get();
  const old = hasUsers && db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name='role'").get();
  if (old) throw new Error('This data directory was created by Specs v0.2 (no teams). v0.3 changes the schema – start with a fresh volume (docker compose down -v) or export your repo first.');
}
const ITEMS_SQL = (name) => `CREATE TABLE IF NOT EXISTS ${name} (
    team_id TEXT NOT NULL,
    id TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL CHECK (kind IN ('spec','doc','folder')),
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    links TEXT NOT NULL DEFAULT '[]',
    pinned INTEGER NOT NULL DEFAULT 0,          -- documents only: foundation document, always available to agents
    updated_via TEXT,                           -- set when an AI agent made the last change (e.g. "Claude Code"); cleared by human edits
    spec_type TEXT NOT NULL DEFAULT 'feature',  -- specs only: feature, api, ui, … or a team-defined type
    rev INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    version INTEGER NOT NULL DEFAULT 0,
    released_rev INTEGER NOT NULL DEFAULT 0,
    released_at TEXT,
    released_by TEXT,
    updated_by TEXT,
    fetched_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (team_id, id)
  );`;

// ---- migration v0.3 -> v0.4 (folders as items, pinned documents, team settings)
{
  const hasItems = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='items'").get();
  const hasPinned = hasItems && db.prepare("SELECT 1 FROM pragma_table_info('items') WHERE name='pinned'").get();
  if (hasItems && !hasPinned) {
    db.exec('BEGIN');
    db.exec('ALTER TABLE items RENAME TO items_v3');
    db.exec(ITEMS_SQL('items'));
    db.exec(`INSERT INTO items (team_id,id,deleted,kind,title,body,links,rev,seq,status,version,released_rev,released_at,released_by,updated_by,fetched_at,created_at,updated_at)
             SELECT team_id,id,deleted,kind,title,body,links,rev,seq,status,version,released_rev,released_at,released_by,updated_by,fetched_at,created_at,updated_at FROM items_v3`);
    db.exec('DROP TABLE items_v3');
    db.exec('CREATE INDEX IF NOT EXISTS items_seq ON items(team_id, seq)');
    db.exec('COMMIT');
  }
  if (hasItems && !db.prepare("SELECT 1 FROM pragma_table_info('items') WHERE name='updated_via'").get()) db.exec('ALTER TABLE items ADD COLUMN updated_via TEXT');
  if (hasItems && !db.prepare("SELECT 1 FROM pragma_table_info('items') WHERE name='spec_type'").get()) {
    db.exec("ALTER TABLE items ADD COLUMN spec_type TEXT NOT NULL DEFAULT 'feature'");
  }
  const hasTeams = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='teams'").get();
  if (hasTeams && !db.prepare("SELECT 1 FROM pragma_table_info('teams') WHERE name='foundation_auto'").get()) {
    db.exec('ALTER TABLE teams ADD COLUMN foundation_auto INTEGER NOT NULL DEFAULT 1');
    db.exec('ALTER TABLE teams ADD COLUMN created_by TEXT');
  }
}

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    git_url TEXT,
    git_branch TEXT NOT NULL DEFAULT 'main',
    git_root TEXT NOT NULL DEFAULT 'specs',
    git_auth TEXT NOT NULL DEFAULT 'none',      -- none | token | ssh
    git_username TEXT,
    git_secret TEXT,                            -- encrypted token or SSH private key
    git_ssh_public TEXT,
    git_auto_push INTEGER NOT NULL DEFAULT 1,
    git_last_push_at TEXT,
    git_last_ok INTEGER,
    git_last_error TEXT,
    git_last_sha TEXT,
    foundation_auto INTEGER NOT NULL DEFAULT 1, -- vision/strategy/glossary go live automatically after edits
    created_by TEXT
  );
  CREATE TABLE IF NOT EXISTS memberships (
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    PRIMARY KEY (team_id, user_id)
  );

  ${ITEMS_SQL('items')}
  CREATE INDEX IF NOT EXISTS items_seq ON items(team_id, seq);

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    admin INTEGER NOT NULL DEFAULT 0,          -- instance administrator
    password_hash TEXT,
    oidc_sub TEXT UNIQUE,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_login_at TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,            -- sha256 of the cookie value
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    user_agent TEXT
  );
  -- personal access tokens for MCP (shown once, stored hashed)
  CREATE TABLE IF NOT EXISTS pats (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    team_id TEXT NOT NULL,
    name TEXT NOT NULL,
    prefix TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE,
    scopes TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    expires_at INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS oauth_requests (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    data TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS oauth_codes (
    hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    team_id TEXT NOT NULL,
    challenge TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    scopes TEXT NOT NULL,
    resource TEXT,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS oauth_tokens (
    id TEXT PRIMARY KEY,
    access_hash TEXT NOT NULL UNIQUE,
    refresh_hash TEXT NOT NULL UNIQUE,
    client_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    team_id TEXT NOT NULL,
    scopes TEXT NOT NULL,
    resource TEXT,
    expires_at INTEGER NOT NULL,
    refresh_expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked INTEGER NOT NULL DEFAULT 0
  );

  -- instance-wide glossary maintained by instance admins; teams import terms as copies (with a source marker)
  CREATE TABLE IF NOT EXISTS global_terms (
    id TEXT PRIMARY KEY,
    term TEXT NOT NULL UNIQUE COLLATE NOCASE,
    definition TEXT NOT NULL,
    aliases TEXT NOT NULL DEFAULT '[]',
    see TEXT NOT NULL DEFAULT '[]',
    rev INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,
    updated_by TEXT
  );
  -- team-defined spec types (the built-in ones live in public/spectypes.js)
  CREATE TABLE IF NOT EXISTS spec_types (
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    label TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    template TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    PRIMARY KEY (team_id, key)
  );
  CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    email TEXT NOT NULL COLLATE NOCASE,
    role TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    invited_by TEXT,
    created_at TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    accepted_at TEXT
  );
`);

