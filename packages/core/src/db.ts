import { Database } from "bun:sqlite";

/**
 * Migrations run in order, once each; `user_version` records how far a
 * database has come. Append — never edit — so an existing midna.db upgrades
 * cleanly.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  -- The objective tree. Everything midna does should trace up to one of these.
  CREATE TABLE goals (
    id INTEGER PRIMARY KEY,
    parent_id INTEGER REFERENCES goals(id),
    title TEXT NOT NULL,
    why TEXT,
    horizon TEXT NOT NULL CHECK (horizon IN ('life','years','year','quarter','month','week')),
    success TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','done','abandoned')),
    target_at INTEGER,
    review_every_days INTEGER,
    last_reviewed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  -- Goals change by renegotiation, never silently: every change has a reason.
  CREATE TABLE goal_changes (
    id INTEGER PRIMARY KEY,
    goal_id INTEGER NOT NULL REFERENCES goals(id),
    change TEXT NOT NULL,
    reason TEXT NOT NULL,
    at INTEGER NOT NULL
  );

  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    goal_id INTEGER REFERENCES goals(id),
    title TEXT NOT NULL,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','waiting','done','dropped')),
    owner TEXT NOT NULL DEFAULT 'user' CHECK (owner IN ('user','midna')),
    priority INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 4),
    due_at INTEGER,
    estimate_min INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    done_at INTEGER
  );

  CREATE TABLE people (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    relation TEXT,
    notes TEXT,
    birthday TEXT,
    contact_every_days INTEGER,
    last_contact_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- Promises: 'mine' = the user owes someone, 'theirs' = someone owes the user.
  CREATE TABLE commitments (
    id INTEGER PRIMARY KEY,
    direction TEXT NOT NULL CHECK (direction IN ('mine','theirs')),
    person_id INTEGER REFERENCES people(id),
    counterparty TEXT,
    what TEXT NOT NULL,
    due_at INTEGER,
    goal_id INTEGER REFERENCES goals(id),
    source TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dropped')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    closed_at INTEGER
  );

  -- One merged calendar: midna's own events plus every connected source.
  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    starts_at INTEGER NOT NULL,
    ends_at INTEGER,
    all_day INTEGER NOT NULL DEFAULT 0,
    location TEXT,
    notes TEXT,
    source TEXT NOT NULL DEFAULT 'midna',
    external_id TEXT,
    goal_id INTEGER REFERENCES goals(id),
    status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('tentative','confirmed','cancelled')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (source, external_id)
  );
  CREATE INDEX events_starts ON events(starts_at);

  CREATE TABLE decisions (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    context TEXT,
    options TEXT,
    choice TEXT,
    reasoning TEXT,
    expected TEXT,
    confidence REAL,
    goal_id INTEGER REFERENCES goals(id),
    review_at INTEGER,
    outcome TEXT,
    lesson TEXT,
    decided_at INTEGER,
    reviewed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE notes (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    tags TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE VIRTUAL TABLE notes_fts USING fts5(title, body, tags, content='notes', content_rowid='id');
  CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
  END;
  CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
  END;
  CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
    INSERT INTO notes_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
  END;

  -- Semantic memory: small claims that decay unless they stay useful.
  CREATE TABLE facts (
    id INTEGER PRIMARY KEY,
    content TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('identity','preference','relationship','pattern','context','procedure','world')),
    importance INTEGER NOT NULL DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
    pinned INTEGER NOT NULL DEFAULT 0,
    source TEXT,
    superseded_by INTEGER REFERENCES facts(id),
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    use_count INTEGER NOT NULL DEFAULT 0,
    archived_at INTEGER,
    archive_reason TEXT
  );
  CREATE VIRTUAL TABLE facts_fts USING fts5(content, content='facts', content_rowid='id');
  CREATE TRIGGER facts_ai AFTER INSERT ON facts BEGIN
    INSERT INTO facts_fts(rowid, content) VALUES (new.id, new.content);
  END;
  CREATE TRIGGER facts_ad AFTER DELETE ON facts BEGIN
    INSERT INTO facts_fts(facts_fts, rowid, content) VALUES ('delete', old.id, old.content);
  END;
  CREATE TRIGGER facts_au AFTER UPDATE OF content ON facts BEGIN
    INSERT INTO facts_fts(facts_fts, rowid, content) VALUES ('delete', old.id, old.content);
    INSERT INTO facts_fts(rowid, content) VALUES (new.id, new.content);
  END;
  -- What a fact is about. A fact tied to something still alive keeps its strength.
  CREATE TABLE fact_links (
    fact_id INTEGER NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
    entity TEXT NOT NULL CHECK (entity IN ('goal','person','task','commitment','decision')),
    entity_id INTEGER NOT NULL,
    PRIMARY KEY (fact_id, entity, entity_id)
  );

  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    title TEXT,
    brain_model TEXT,
    brain_session TEXT,
    brain_started_at INTEGER,
    brain_turns INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL
  );
  -- The episodic log: every word exchanged, kept, searchable, never loaded whole.
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    role TEXT NOT NULL CHECK (role IN ('user','midna')),
    text TEXT NOT NULL,
    client TEXT,
    seen_by_brain INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX messages_conv ON messages(conversation_id, id);
  CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='id');
  CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
  END;

  CREATE TABLE episodes (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('chat','wakeup')),
    conversation_id TEXT,
    wakeup_id INTEGER,
    model TEXT,
    brain_session TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    cost_usd REAL,
    error TEXT
  );

  -- The audit log: every tool midna ran, always on, in every mode.
  CREATE TABLE actions (
    id INTEGER PRIMARY KEY,
    episode_id INTEGER REFERENCES episodes(id),
    tool TEXT NOT NULL,
    input TEXT,
    at INTEGER NOT NULL
  );

  -- midna's own future: follow-ups it scheduled, rituals, plain reminders.
  CREATE TABLE wakeups (
    id INTEGER PRIMARY KEY,
    due_at INTEGER NOT NULL,
    reason TEXT NOT NULL,
    cron TEXT,
    kind TEXT NOT NULL DEFAULT 'followup' CHECK (kind IN ('followup','ritual','reminder','system')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','cancelled','failed')),
    created_by TEXT NOT NULL DEFAULT 'midna',
    created_at INTEGER NOT NULL,
    fired_at INTEGER
  );
  CREATE INDEX wakeups_due ON wakeups(status, due_at);

  CREATE TABLE outbox (
    id INTEGER PRIMARY KEY,
    seq INTEGER UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('message','notification','question')),
    conversation_id TEXT,
    text TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent','normal','fyi')),
    options TEXT,
    deliver_after INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    answered_at INTEGER
  );

  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    revoked_at INTEGER
  );
  CREATE TABLE pairing_codes (code TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
  `,
  // Messages point at what they were delivered as, and at the question they answer,
  // so a client can redraw history with its questions and buttons intact.
  `
  ALTER TABLE messages ADD COLUMN outbox_id INTEGER REFERENCES outbox(id);
  ALTER TABLE messages ADD COLUMN reply_to INTEGER REFERENCES outbox(id);
  `,
  // Images and files sent with messages, kept with the conversation. An
  // attachment belongs to an outbox item (midna said it) or a message (the
  // user said it); a chat episode stages its reply's before the reply exists.
  `
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    data BLOB NOT NULL,
    source TEXT,
    episode_id INTEGER REFERENCES episodes(id),
    outbox_id INTEGER REFERENCES outbox(id),
    message_id INTEGER REFERENCES messages(id),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX attachments_outbox ON attachments(outbox_id);
  CREATE INDEX attachments_message ON attachments(message_id);
  CREATE INDEX attachments_episode ON attachments(episode_id);
  `,
  // The sender decides: where each attachment comes in its message, a caption
  // of its own, and whether an image goes as a file.
  `
  ALTER TABLE attachments ADD COLUMN position INTEGER;
  ALTER TABLE attachments ADD COLUMN caption TEXT;
  ALTER TABLE attachments ADD COLUMN kind TEXT CHECK (kind IN ('image','file'));
  `,
  // Events from other programs (ruri, a CI job, …) for midna to hear in the
  // background. Each is delivered by a wakeup; ext_id is the sender's id, so
  // the same event sent twice counts once; subject is what the rate limit
  // counts by within a source (ruri: the project).
  `
  CREATE TABLE inbound_events (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    ext_id TEXT,
    subject TEXT NOT NULL DEFAULT '',
    kind TEXT,
    title TEXT NOT NULL,
    data TEXT,
    wakeup_id INTEGER NOT NULL REFERENCES wakeups(id),
    received_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX inbound_events_ext ON inbound_events(source, ext_id) WHERE ext_id IS NOT NULL;
  CREATE INDEX inbound_events_subject ON inbound_events(source, subject);
  CREATE INDEX inbound_events_wakeup ON inbound_events(wakeup_id);
  `,
  // Device hands: the last hello of each device that offers its hands (state
  // updates folded in), and every command midna had one do — how it was
  // decided, and how it ended. Approvals come with fork 1.
  `
  CREATE TABLE hands_devices (
    device_id TEXT PRIMARY KEY REFERENCES devices(id),
    hello TEXT NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE TABLE device_commands (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES devices(id),
    episode_id INTEGER REFERENCES episodes(id),
    op TEXT NOT NULL,
    args TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('allowed','approved','denied','refused')),
    decided_by TEXT,
    reason TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    outcome TEXT CHECK (outcome IN ('ok','error','timeout','cancelled','disconnected')),
    summary TEXT,
    error_code TEXT,
    attachments TEXT
  );
  CREATE INDEX device_commands_device ON device_commands(device_id, started_at);
  `,
  // Device hands' approvals: what waited for the user's yes, who answered
  // and where — the first answer wins. "Allow for 10 min" is an answer
  // too: while it is fresh, that device and capability need no yes.
  `
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES devices(id),
    capability TEXT NOT NULL,
    op TEXT NOT NULL,
    summary TEXT NOT NULL,
    command_id TEXT NOT NULL,
    episode_id INTEGER REFERENCES episodes(id),
    outbox_id INTEGER REFERENCES outbox(id),
    requested_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','allowed','denied','expired','cancelled')),
    answer TEXT CHECK (answer IN ('allow','allow_10_min','deny')),
    answered_by TEXT,
    answered_via TEXT,
    answered_at INTEGER
  );
  CREATE INDEX approvals_grant ON approvals(device_id, capability, answer, answered_at);
  CREATE INDEX approvals_outbox ON approvals(outbox_id);
  ALTER TABLE device_commands ADD COLUMN approval_id TEXT;
  `,
  // Jobs: long work midna started from a turn, run detached so it outlives
  // the turn's process and the daemon's restarts. A wakeup reports how each
  // one ended (none when midna stopped it itself).
  `
  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY,
    label TEXT NOT NULL,
    command TEXT NOT NULL,
    cwd TEXT NOT NULL,
    dir TEXT NOT NULL,
    log_path TEXT NOT NULL,
    result_path TEXT,
    when_done TEXT,
    unit TEXT,
    pid INTEGER,
    pid_started TEXT,
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed','stopped','timeout')),
    exit_code INTEGER,
    reason TEXT,
    timeout_ms INTEGER NOT NULL,
    episode_id INTEGER REFERENCES episodes(id),
    wakeup_id INTEGER REFERENCES wakeups(id),
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE INDEX jobs_status ON jobs(status);
  CREATE INDEX jobs_wakeup ON jobs(wakeup_id);
  `,
];

export function openDatabase(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  const current = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
}
