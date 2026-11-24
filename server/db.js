import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { chmodSync } from 'node:fs';
import { DATA_DIR } from './config.js';

const DB_FILE = path.join(DATA_DIR, 'specs.db');
export const db = new DatabaseSync(DB_FILE);
// databases of earlier versions were created world-readable
for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
  try {
    chmodSync(f, 0o600);
  } catch {
    /* does not exist (yet) */
  }
}
{
  const hasUsers = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").get();
  const old = hasUsers && db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name='role'").get();
  if (old)
    throw new Error(
      'This data directory was created by Specs v0.2 (no teams). v0.3 changes the schema – start with a fresh volume (docker compose down -v) or export your repo first.',
    );
}
// both are no-ops inside a transaction, so they come before the migrations
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

const statements = new Map();
/** A prepared statement, compiled once per SQL text and then reused. Only for fixed SQL texts – the cache is never pruned. */
export const sql = (text) => {
  let s = statements.get(text);
  if (!s) statements.set(text, (s = db.prepare(text)));
  return s;
};

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
const hasTable = (table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
const hasCol = (table, col) => !!db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name=?`).get(col);
const addColumn = (table, col, ddl) => {
  if (!hasCol(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
};

/**
 * The schema up to 0.11.0. Databases of those versions record no schema version, so every step here checks what is
 * there before it changes anything: it brings a database of any earlier state (v0.3 onwards) to the 0.11.0 schema.
 * Do not change it – new schema changes are new entries in MIGRATIONS.
 */
function baseline() {
  // ---- v0.3 -> v0.4 (folders as items, pinned documents, team settings)
  if (hasTable('items') && !hasCol('items', 'pinned')) {
    db.exec('ALTER TABLE items RENAME TO items_v3');
    db.exec(ITEMS_SQL('items'));
    db.exec(`INSERT INTO items (team_id,id,deleted,kind,title,body,links,rev,seq,status,version,released_rev,released_at,released_by,updated_by,fetched_at,created_at,updated_at)
             SELECT team_id,id,deleted,kind,title,body,links,rev,seq,status,version,released_rev,released_at,released_by,updated_by,fetched_at,created_at,updated_at FROM items_v3`);
    db.exec('DROP TABLE items_v3');
    db.exec('CREATE INDEX IF NOT EXISTS items_seq ON items(team_id, seq)');
  }
  if (hasTable('items')) {
    addColumn('items', 'updated_via', 'TEXT');
    addColumn('items', 'spec_type', "TEXT NOT NULL DEFAULT 'feature'");
  }
  if (hasTable('teams')) {
    addColumn('teams', 'foundation_auto', 'INTEGER NOT NULL DEFAULT 1');
    addColumn('teams', 'created_by', 'TEXT');
  }

  db.exec(`
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
  -- team-defined spec types (the built-in ones live in shared/spectypes.js)
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
  addColumn('spec_types', 'form', 'TEXT');
  addColumn('spec_types', 'view', "TEXT NOT NULL DEFAULT 'editor'");

  // v0.9: feedback author + team switch for feedback e-mails
  addColumn('feedback', 'author_id', 'TEXT');
  addColumn('teams', 'feedback_mail', 'INTEGER NOT NULL DEFAULT 1');

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
  addColumn('feedback', 'blocking', 'INTEGER NOT NULL DEFAULT 0'); // decision requests: the agent waits for the answer
  addColumn('feedback', 'options', 'TEXT'); // decision requests: JSON [{label, detail}]
  addColumn('feedback', 'recommended', 'INTEGER'); // index into options
  addColumn('feedback', 'answer', 'INTEGER'); // index of the chosen option, -1 = answered in the reply only
  addColumn('teams', 'hook_url', 'TEXT');
  addColumn('teams', 'hook_secret', 'TEXT'); // encrypted bearer token
  addColumn('teams', 'hook_headers', 'TEXT'); // encrypted "Name: value" lines
  addColumn('teams', 'hook_events', "TEXT NOT NULL DEFAULT 'release,answer'");
  addColumn('teams', 'hook_format', "TEXT NOT NULL DEFAULT 'full'"); // full | text (only {"text": …})
  addColumn('teams', 'hook_last_at', 'TEXT');
  addColumn('teams', 'hook_last_ok', 'INTEGER');
  addColumn('teams', 'hook_last_info', 'TEXT');
  addColumn('teams', 'garden_rev', 'INTEGER NOT NULL DEFAULT 0'); // bumped whenever feedback, decisions or reports change

  // Events for a team's webhook wait here until they were delivered, so a restart or a receiver that is briefly down loses nothing.
  db.exec(`CREATE TABLE IF NOT EXISTS hook_outbox (
    team_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    entry TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (team_id, kind, key)
  )`);
  addColumn('teams', 'agent_paused', 'INTEGER NOT NULL DEFAULT 0'); // a person paused the agents: empty work list, no webhook calls

  // 0.11: re-runnable evidence. A check says how a claim of an agent can be verified again (a test, a CI job, a metric, a command);
  // its runs are kept (the newest 50). Checks belong to a spec and survive new versions, so they can be run after every change.
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

  // 0.11 (security review): sessions record their last use, refresh tokens remember their predecessor (reuse detection), audit log
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

  // 0.11: who works on what. agent_activity: the last MCP call of every agent (one row per user, kind of access and client name);
  // claims: an agent says it is building a spec – a lease it renews while it works, so two runs do not build the same spec
  // and a crashed agent does not look busy forever.
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_activity (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      agent TEXT NOT NULL,                       -- "<user id>|<pat|oauth>|<client or token name>"
      name TEXT NOT NULL,                        -- what people see, e.g. "token: Builder agent"
      user_name TEXT,
      last_at TEXT NOT NULL,
      last_tool TEXT,
      calls INTEGER NOT NULL DEFAULT 0,
      token_expires_at INTEGER,                  -- personal tokens only (seconds); OAuth tokens are refreshed
      PRIMARY KEY (team_id, agent)
    );
    CREATE TABLE IF NOT EXISTS claims (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      spec_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      name TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      claimed_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (team_id, spec_id)
    );
  `);
  addColumn('checks', 'stale_notified', 'TEXT'); // id of the last run the agent trigger was told is stale (once per run)

  // 0.11: only results reported by CI prove a check (an agent's own "pass" then leaves it unverified)
  addColumn('teams', 'ci_required', 'INTEGER NOT NULL DEFAULT 0');

  // 0.11: the guardrails a report was built against ({ "G1": "text" }); NULL for reports made before this was recorded
  addColumn('reports', 'guardrails', 'TEXT');

  // 0.11: people steer the agents per spec: priority, hold (do not start or continue), dependencies (build after these specs)
  db.exec(`
    CREATE TABLE IF NOT EXISTS spec_steering (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      spec_id TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',   -- high | normal | low
      hold INTEGER NOT NULL DEFAULT 0,
      hold_note TEXT NOT NULL DEFAULT '',
      depends TEXT NOT NULL DEFAULT '[]',        -- JSON list of spec ids that must be implemented first
      updated_by TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (team_id, spec_id)
    );
  `);
}

/** How many implementation reports are kept per spec (the newest; listReports and the History view show at most this many). */
export const REPORTS_KEPT = 50;

/**
 * Schema migrations, in order. PRAGMA user_version holds how many of them a database has run; each runs once, in its own
 * transaction, together with the update of that number. To change the schema, append a function – never edit one that shipped.
 */
const MIGRATIONS = [
  /* 1 */ baseline,
  /* 2 */ () => {
    // fetched_at no longer moves an item in the sync sequence: clients ask for the changes since the newest fetched_at they know
    db.exec('CREATE INDEX IF NOT EXISTS items_fetched ON items(team_id, fetched_at)');
    // the report history is bounded per spec from now on; trim what grew before (reports_spec serves "newest per spec")
    db.prepare(
      `DELETE FROM reports WHERE rowid IN (SELECT rowid FROM (
      SELECT rowid, ROW_NUMBER() OVER (PARTITION BY team_id, spec_id ORDER BY created_at DESC, rowid DESC) AS n FROM reports) WHERE n > ?)`,
    ).run(REPORTS_KEPT);
  },
  /* 3 */ () => {
    // how long a team keeps closed feedback (days); 0 = forever, which is what every team starts with
    db.exec('ALTER TABLE teams ADD COLUMN feedback_keep_days INTEGER NOT NULL DEFAULT 0');
  },
  /* 4 */ () => {
    // guardrails are one file per rule; their ids (G1, G2 …) are given by the server and never twice: the highest number given so far
    db.exec('ALTER TABLE teams ADD COLUMN rule_seq INTEGER NOT NULL DEFAULT 0');
  },
  /* 5 */ () => {
    // Sharing between teams (docs/SHARED-SPECS.md). Teams form a tree: a child inherits the foundation of its ancestors, pinned
    // to one foundation version per ancestor. Any team can share released documents, folders and specs with other teams; links
    // in the receiving team point to one released version (a snapshot in shared_versions).
    db.exec(`
      ALTER TABLE teams ADD COLUMN parent_id TEXT;
      ALTER TABLE teams ADD COLUMN foundation_version INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE items ADD COLUMN implements TEXT;          -- "@PLAT/SPEC-012@3" or "SPEC-007@2" (inside the team)
      ALTER TABLE items ADD COLUMN origin TEXT;              -- adopted copies: "API/api/payments.yaml@4"
      ALTER TABLE feedback ADD COLUMN from_team_id TEXT;     -- feedback and decisions from a team the item is shared with
      CREATE TABLE team_links (                              -- parent link requests, waiting for the child team's admin
        parent_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        child_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        requested_by TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (parent_id, child_id)
      );
      CREATE TABLE foundation_versions (                     -- one row per foundation release of a team: the released foundation files
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        files TEXT NOT NULL,                                 -- JSON [{ id, body }]: vision, strategy, other foundation documents, rules, terms
        hash TEXT NOT NULL,
        at TEXT NOT NULL,
        by TEXT,
        PRIMARY KEY (team_id, version)
      );
      CREATE TABLE foundation_pins (                         -- which foundation version of each ancestor a team builds against
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        ancestor_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        accepted_by TEXT,
        accepted_at TEXT,
        PRIMARY KEY (team_id, ancestor_id)
      );
      CREATE TABLE forced_rules (                            -- rules applied to a team after their "required by" date passed
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        ancestor_id TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        version INTEGER NOT NULL,                            -- the ancestor's foundation version the rule was taken from
        applied_at TEXT NOT NULL,
        PRIMARY KEY (team_id, ancestor_id, rule_id)
      );
      CREATE TABLE shares (
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL,
        kind TEXT NOT NULL,                                  -- spec | doc | folder
        audience TEXT NOT NULL,                              -- children | descendants | teams
        created_by TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (team_id, item_id)
      );
      CREATE TABLE share_teams (                             -- audience = teams: who it is shared with, and who accepted
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL,
        to_team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        accepted_by TEXT,
        accepted_at TEXT,
        PRIMARY KEY (team_id, item_id, to_team_id)
      );
      CREATE TABLE shared_versions (                         -- released versions of shared documents and specs, as other teams read them
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL,
        at TEXT NOT NULL,
        by TEXT,
        PRIMARY KEY (team_id, item_id, version)
      );
      CREATE TABLE sharing_state (id INTEGER PRIMARY KEY CHECK (id = 1), rev INTEGER NOT NULL);
      INSERT INTO sharing_state (id, rev) VALUES (1, 1);
    `);
  },
  /* 6 */ () => {
    db.exec(`
      -- the links of the released version of a spec (JSON): pinned @KEY/… versions count from here, never from the working copy
      ALTER TABLE items ADD COLUMN released_links TEXT;
      -- 0 = the account was created from an invitation link the inviter could see: the e-mail address is not proven
      ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1;
      -- 1 = the invitation link went only to the invited mailbox, or an instance admin invited
      ALTER TABLE invites ADD COLUMN vouched INTEGER NOT NULL DEFAULT 0;
    `);
    // unchanged since the release: the working copy is the released state. Others are read from Git at startup (backfillReleasedLinks).
    db.exec("UPDATE items SET released_links = links WHERE kind='spec' AND deleted=0 AND status='approved' AND rev = released_rev");
  },
  /* 7 */ () => {
    // images uploaded into specs and documents, addressed by their content (server/images.js); released copies live in Git
    db.exec(`CREATE TABLE images (
      team_id TEXT NOT NULL,
      name TEXT NOT NULL,                                    -- <sha256, 32 hex>.<ext>, referenced in Markdown as images/<name>
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      data BLOB NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (team_id, name)
    )`);
  },
];
export const SCHEMA_VERSION = MIGRATIONS.length;

{
  const have = db.prepare('PRAGMA user_version').get().user_version;
  if (have > SCHEMA_VERSION)
    throw new Error(
      `This data directory was written by a newer version of Specs (schema ${have}, this server knows ${SCHEMA_VERSION}). Update the server, or restore a backup.`,
    );
  for (let v = have; v < SCHEMA_VERSION; v++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      MIGRATIONS[v]();
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`database migration ${v + 1} failed: ${e.message}`, { cause: e });
    }
  }
}
for (const f of [`${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
  try {
    chmodSync(f, 0o600);
  } catch {
    /* no WAL file */
  }
}
