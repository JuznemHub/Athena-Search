-- Athena / Group Search — D1 schema (auth + communities + moderation)

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL DEFAULT 'oauth',
    display_name TEXT,
    avatar_url TEXT,
    provider TEXT,
    provider_id TEXT,
    telegram_api_id TEXT,
    created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_provider ON users(provider, provider_id);
-- telegram_api_id added for Bot API id mapping
-- ALTER TABLE users ADD COLUMN telegram_api_id TEXT;
-- ALTER TABLE users ADD COLUMN display_name TEXT;

CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS communities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    creator_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(creator_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS community_members (
    community_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    joined_at INTEGER NOT NULL,
    PRIMARY KEY(community_id, user_id),
    FOREIGN KEY(community_id) REFERENCES communities(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
);
-- Live DBs created before role: ALTER TABLE community_members ADD COLUMN role TEXT DEFAULT 'member';
-- Live DBs: ALTER TABLE users ADD COLUMN telegram_api_id TEXT;

-- External platform admin IDs (Telegram/Discord user IDs) for notifications
CREATE TABLE IF NOT EXISTS community_admins (
    id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    platform_user_id TEXT NOT NULL,
    label TEXT,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(community_id) REFERENCES communities(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_community_admins_unique
  ON community_admins(community_id, platform, platform_user_id);

-- Bot ↔ chat bindings (same bot works for personal OR community; switchable)
CREATE TABLE IF NOT EXISTS community_bots (
    id TEXT PRIMARY KEY,
    community_id TEXT,
    platform TEXT NOT NULL,
    bot_username TEXT NOT NULL,
    group_id TEXT NOT NULL,
    group_name TEXT,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    scope TEXT NOT NULL DEFAULT 'community',
    user_id TEXT,
    bot_token TEXT,
    dump_link_mode TEXT DEFAULT 'smart',
    topic_id TEXT,
    log_channel_id TEXT,
    FOREIGN KEY(created_by) REFERENCES users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_community_bots_platform_group
  ON community_bots(platform, group_id);
CREATE INDEX IF NOT EXISTS idx_community_bots_community
  ON community_bots(community_id);
CREATE INDEX IF NOT EXISTS idx_community_bots_user
  ON community_bots(user_id);

CREATE TABLE IF NOT EXISTS links (
    id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    url TEXT NOT NULL,
    url_hash TEXT NOT NULL,
    title TEXT,
    notes TEXT,
    tags TEXT,
    added_by TEXT NOT NULL,
    added_by_user_id TEXT,
    added_by_provider TEXT,
    added_by_name TEXT,
    upvotes INTEGER NOT NULL DEFAULT 0,
    downvotes INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    image_url TEXT,
    site_name TEXT,
    metadata_version INTEGER NOT NULL DEFAULT 0,
    search_blob TEXT,
    FOREIGN KEY(community_id) REFERENCES communities(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_community_url_hash ON links(community_id, url_hash);

CREATE TABLE IF NOT EXISTS link_votes (
    link_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    vote INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(link_id, user_id)
);

CREATE TABLE IF NOT EXISTS link_reports (
    id TEXT PRIMARY KEY,
    link_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    reporter_id TEXT NOT NULL,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    community_id TEXT,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    payload TEXT,
    read INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read, created_at);

CREATE TABLE IF NOT EXISTS personal_links (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    url TEXT NOT NULL,
    url_hash TEXT NOT NULL,
    title TEXT,
    notes TEXT,
    tags TEXT,
    created_at INTEGER NOT NULL,
    image_url TEXT,
    site_name TEXT,
    metadata_version INTEGER NOT NULL DEFAULT 0,
    search_blob TEXT
);

CREATE INDEX IF NOT EXISTS idx_personal_user ON personal_links(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_personal_user_url_hash ON personal_links(user_id, url_hash);

-- Safe replay of retried CLI batch uploads after an ambiguous timeout.
CREATE TABLE IF NOT EXISTS batch_uploads (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    request_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'processing',
    result TEXT,
    created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_batch_uploads_request
  ON batch_uploads(user_id, scope, scope_key, request_key);

CREATE TABLE IF NOT EXISTS uploaded_documents (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    user_id TEXT,
    community_id TEXT,
    filename TEXT NOT NULL,
    content TEXT NOT NULL,
    uploaded_by TEXT NOT NULL,
    github_path TEXT,
    created_at INTEGER NOT NULL,
    search_blob TEXT,
    source_chat_id TEXT,
    source_message_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_documents_personal
  ON uploaded_documents(scope, user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_documents_community
  ON uploaded_documents(scope, community_id, created_at);

-- Short-lived server-side state for Telegram /search pagination. The query and
-- scope stay here instead of in callback_data, which is size-limited and user-editable.
CREATE TABLE IF NOT EXISTS telegram_search_sessions (
    id TEXT PRIMARY KEY,
    tg_user_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    query TEXT NOT NULL,
    page INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tg_search_sessions_expiry
  ON telegram_search_sessions(expires_at);

CREATE TABLE IF NOT EXISTS oauth_states (
    state TEXT PRIMARY KEY,
    code_verifier TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_bots (
    bot_token TEXT PRIMARY KEY,
    telegram_group_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    FOREIGN KEY(community_id) REFERENCES communities(id)
);

-- Document chunks for paragraph-level TUI Advanced search (pgvector + tsv hybrid)
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS document_chunks (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  chunk_idx INTEGER NOT NULL,
  page INTEGER,
  para_idx INTEGER,
  content TEXT NOT NULL,
  token_count INTEGER,
  embedding VECTOR(1536),
  tsv TSVECTOR,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_doc ON document_chunks(doc_id, chunk_idx);
CREATE INDEX IF NOT EXISTS idx_chunks_scope ON document_chunks(scope, scope_key, para_idx);
CREATE INDEX IF NOT EXISTS idx_chunks_tsv ON document_chunks USING gin(tsv);
-- idx_chunks_embedding (ivfflat) is created in ensureChunksTable, which first
-- upgrades a TEXT fallback column to VECTOR once the pgvector extension exists.
-- Keeping it here crashes startup when the column is still TEXT.

-- pending clone confirmations (preview → yes) - added for clone preview feature
CREATE TABLE IF NOT EXISTS pending_clones (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  thread_id TEXT,
  community_id TEXT,
  target TEXT,
  requester_tg_id TEXT NOT NULL,
  requester_user_id TEXT NOT NULL,
  stats_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_clones_expiry ON pending_clones(expires_at);
