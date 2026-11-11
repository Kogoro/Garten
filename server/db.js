import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { chmodSync } from 'node:fs';
import { DATA_DIR } from './config.js';

const DB_FILE = path.join(DATA_DIR, 'specs.db');
export const db = new DatabaseSync(DB_FILE);
// databases of earlier versions were created world-readable
for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) { try { chmodSync(f, 0o600); } catch { /* does not exist (yet) */ } }
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
    try {
    db.exec('ALTER TABLE items RENAME TO items_v3');
    db.exec(ITEMS_SQL('items'));
    db.exec(`INSERT INTO items (team_id,id,deleted,kind,title,body,links,rev,seq,status,version,released_rev,released_at,released_by,updated_by,fetched_at,created_at,updated_at)
             SELECT team_id,id,deleted,kind,title,body,links,rev,seq,status,version,released_rev,released_at,released_by,updated_by,fetched_at,created_at,updated_at FROM items_v3`);
    db.exec('DROP TABLE items_v3');
    db.exec('CREATE INDEX IF NOT EXISTS items_seq ON items(team_id, seq)');
    db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  if (hasItems && !db.prepare("SELECT 1 FROM pragma_table_info('items') WHERE name='updated_via'").get()) db.exec('ALTER TABLE items ADD COLUMN updated_via TEXT');
  if (hasItems && !db.prepare("SELECT 1 FROM pragma_table_info('items') WHERE name='spec_type'").get()) {
    db.exec("ALTER TABLE items ADD COLUMN spec_type TEXT NOT NULL DEFAULT 'feature'");
  }
  const hasTeams = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='teams'").get();
  const hasCol = (table, col) => db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name=?`).get(col);
  if (hasTeams && !hasCol('teams', 'foundation_auto')) db.exec('ALTER TABLE teams ADD COLUMN foundation_auto INTEGER NOT NULL DEFAULT 1');
  if (hasTeams && !hasCol('teams', 'created_by')) db.exec('ALTER TABLE teams ADD COLUMN created_by TEXT');
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
    form TEXT,                                  -- JSON form schema (shared/specForm.js) or NULL for a free-form editor type
    view TEXT NOT NULL DEFAULT 'editor',        -- 'form' | 'editor': how specs of this type open by default
    created_at TEXT NOT NULL,
    PRIMARY KEY (team_id, key)
  );
  -- feedback on specs (left by agents or people, triaged by people); never changes the spec itself
  CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    spec_id TEXT NOT NULL,
    spec_version INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL,
    section TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    evidence TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    author TEXT,
    via TEXT,
    created_at TEXT NOT NULL,
    resolved_by TEXT,
    resolved_at TEXT,
    reply TEXT
  );
  CREATE INDEX IF NOT EXISTS feedback_spec ON feedback(team_id, spec_id, status);
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


// v0.8 -> v0.9: spec types can carry a form schema
for (const [col, ddl] of [['form', 'ALTER TABLE spec_types ADD COLUMN form TEXT'], ['view', "ALTER TABLE spec_types ADD COLUMN view TEXT NOT NULL DEFAULT 'editor'"]]) {
  if (!db.prepare("SELECT 1 FROM pragma_table_info('spec_types') WHERE name=?").get(col)) db.exec(ddl);
}

// v0.9: feedback author + team switch for feedback e-mails
if (!db.prepare("SELECT 1 FROM pragma_table_info('feedback') WHERE name='author_id'").get()) db.exec('ALTER TABLE feedback ADD COLUMN author_id TEXT');
if (!db.prepare("SELECT 1 FROM pragma_table_info('teams') WHERE name='feedback_mail'").get()) db.exec('ALTER TABLE teams ADD COLUMN feedback_mail INTEGER NOT NULL DEFAULT 1');

// v0.10: the gardener loop – implementation reports, decision requests (stored as feedback) and a webhook per team
db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    spec_id TEXT NOT NULL,
    spec_version INTEGER NOT NULL,
    status TEXT NOT NULL,                      -- implemented | partial | blocked | in_progress
    summary TEXT NOT NULL DEFAULT '',
    criteria TEXT NOT NULL DEFAULT '[]',       -- [{text, status: met|deviating|open, note}]
    evidence TEXT NOT NULL DEFAULT '[]',       -- [{kind: commit|pr|test|ci|url|other, ref, note}]
    deviations TEXT NOT NULL DEFAULT '',
    author TEXT,
    author_id TEXT,
    via TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS reports_spec ON reports(team_id, spec_id, created_at);
`);
const addColumn = (table, col, ddl) => { if (!db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name=?`).get(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`); };
addColumn('feedback', 'blocking', 'INTEGER NOT NULL DEFAULT 0'); // decision requests: the agent waits for the answer
addColumn('feedback', 'options', 'TEXT');                         // decision requests: JSON [{label, detail}]
addColumn('feedback', 'recommended', 'INTEGER');                  // index into options
addColumn('feedback', 'answer', 'INTEGER');                       // index of the chosen option, -1 = answered in the reply only
addColumn('teams', 'hook_url', 'TEXT');
addColumn('teams', 'hook_secret', 'TEXT');                        // encrypted bearer token
addColumn('teams', 'hook_headers', 'TEXT');                       // encrypted "Name: value" lines
addColumn('teams', 'hook_events', "TEXT NOT NULL DEFAULT 'release,answer'");
addColumn('teams', 'hook_format', "TEXT NOT NULL DEFAULT 'full'"); // full | text (only {"text": …})
addColumn('teams', 'hook_last_at', 'TEXT');
addColumn('teams', 'hook_last_ok', 'INTEGER');
addColumn('teams', 'hook_last_info', 'TEXT');
addColumn('teams', 'garden_rev', 'INTEGER NOT NULL DEFAULT 0');   // bumped whenever feedback, decisions or reports change

// Events for a team's webhook wait here until they were delivered, so a restart or a receiver that is briefly down loses nothing.
db.exec(`CREATE TABLE IF NOT EXISTS hook_outbox (
  team_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  entry TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (team_id, kind, key)
)`);

// v0.12: re-runnable evidence. A check says how a claim of an agent can be verified again (a test, a CI job, a metric, a command);
// every run of it is kept. Checks belong to a spec and survive new versions, so they can be run after every change.
db.exec(`
  CREATE TABLE IF NOT EXISTS checks (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    spec_id TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,                        -- test | ci | metric | command | url | manual
    how TEXT NOT NULL,                         -- the command, the CI job URL, the metric query, the test selector
    expect TEXT NOT NULL DEFAULT '',           -- what counts as passing ("exit 0", "p95 < 200 ms", "coverage >= 80 %")
    criterion TEXT NOT NULL DEFAULT '',        -- the acceptance criterion it proves (quoted from the spec)
    max_age_days INTEGER NOT NULL DEFAULT 14,  -- a passing result older than this is stale and must be repeated
    retired INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,
    via TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (team_id, spec_id, name)
  );
  CREATE TABLE IF NOT EXISTS check_runs (
    id TEXT PRIMARY KEY,
    check_id TEXT NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
    team_id TEXT NOT NULL,
    spec_id TEXT NOT NULL,
    spec_version INTEGER NOT NULL,
    status TEXT NOT NULL,                      -- pass | fail | error
    value TEXT NOT NULL DEFAULT '',            -- measured value, e.g. "182 ms", "47 passed"
    detail TEXT NOT NULL DEFAULT '',
    ref TEXT NOT NULL DEFAULT '',              -- URL of the CI run / log
    commit_sha TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL,                      -- agent | ci (reported by a pipeline with its own token)
    run_by TEXT,
    at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS check_runs_check ON check_runs(check_id, at);
`);

// v0.12 (security review): sessions record their last use, refresh tokens remember their predecessor (reuse detection), audit log
addColumn('sessions', 'last_seen_at', 'INTEGER');
addColumn('oauth_tokens', 'prev_refresh_hash', 'TEXT');
db.exec(`CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor_id TEXT,
  actor TEXT,
  team_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  ip TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS audit_at ON audit_log(at);`);
for (const f of [`${DB_FILE}-wal`, `${DB_FILE}-shm`]) { try { chmodSync(f, 0o600); } catch { /* no WAL file */ } }
