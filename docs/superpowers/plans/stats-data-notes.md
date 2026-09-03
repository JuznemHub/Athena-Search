# /stats Data Model — Design Notes (Task 4)

**Date:** 2026-08-29
**Branch:** `dev` (design-only)
**Scope:** `worker/schema.sql`, `worker/index_legacy.js:3798, 7769, 7975, 13387`, `server/pgdb.js`, `worker/pgcompat.js`
**Status:** No schema migration in this slice — read-only design.

## 1. Sources cataloged

| Store | Key columns | Creator | Notes |
|-------|-------------|---------|-------|
| `links` | `id, community_id, url, url_hash, created_at, transfer_id` | `ensureTransferColumns` adds `transfer_id TEXT` to `links, personal_links, uploaded_documents` | No `source_chat_id` — verified in `schema.sql` and `saveIndexedLinks` never writes it. |
| `personal_links` | `id, user_id, url, url_hash, created_at, transfer_id` | same | Same gap. |
| `uploaded_documents` | `id, scope, user_id, community_id, filename, content, created_at, source_chat_id, source_message_id, transfer_id` | `ensureDocumentsTable` + `ensureTransferColumns` | **Has** `source_chat_id/source_message_id` — dedup key used in `saveIndexedDocument` / `savePersonalIndexedDocument`. PG compat adds `IF NOT EXISTS` fallback. |
| `index_jobs` | `id, community_id, chat_id, thread_id, status, offset_id, processed, saved_links, saved_docs, saved_files, skipped_media, urls_seen, continuations, min_id, max_id, progress_chat_id, created_at, updated_at` | `ensureIndexTables` + inline `ALTER TABLE ADD COLUMN` in `startBackfillJob` | Per-chat history totals. `saved_links/saved_docs` are authoritative backfill counts. |
| `userbot_follows` | `chat_id PK, label, community_id, target, created_by, created_at` | `ensureUserbotTables` | Defines what is cloned. `chat_id` is `-100…` or `-100…:threadId` for forum topics. |
| `telegram_topic_bindings` | `id PK, chat_id, thread_id, community_id, target, created_by, created_at` | `ensureTopicBindingTable` | Unique on `(chat_id, thread_id)`. Forum decomposition. |
| `USERBOT_STATS` | `Map<string, {msgs, links, docs, lastAt}>` | in-memory `worker/index_legacy.js:13409` | Ephemeral — resets on restart. See §2. |
| `userbot_accounts` | `label PK, api_id, api_hash_enc, session_enc` | `ensureUserbotTables` | Used to resolve channel name via `USERBOT_ACCOUNTS.get(label).client.getEntity` fallback. |

```js
// worker/index_legacy.js:13409
const USERBOT_STATS = new Map(); // chat_id -> {msgs, links, docs, lastAt}
function userbotStat(chatId, field) {
  const s = USERBOT_STATS.get(chatId)||{msgs:0,links:0,docs:0,lastAt:0};
  if(field) s[field]++;
  s.lastAt=Date.now(); USERBOT_STATS.set(chatId,s);
}
```

## 2. Counters

For each cloned chat (`chat_id` from `userbot_follows`):

**Name resolution (best-effort, no DB name column):**
1. `telegramApi(token, 'getChat', {chat_id: chatId})` — bot API (works when bot is in chat).
2. Fallback: `USERBOT_ACCOUNTS.get(label).client.getEntity(normalizeTgChatId(chatId))` — gramjs session.
3. Fallback: raw `chatId` string.

**Total counts — current provenance (no migration):**
- Links (community sink): `SELECT COUNT(*) FROM links WHERE community_id=? OR transfer_id IN (SELECT id FROM index_jobs WHERE chat_id=?)` — covers channels bound to a community. For history, `transfer_id` is set; for live channel posts without `transferId` it is NULL, so they are counted via `community_id` only. Per-chat live split is therefore **not queryable** from `links` alone.
- Links (personal sink): same on `personal_links WHERE user_id=? OR transfer_id IN (…)`.
- Docs/files: `SELECT COUNT(*) FROM uploaded_documents WHERE scope='community' AND community_id=? AND source_chat_id=?` (or `scope='personal' AND user_id=? AND source_chat_id=?`). This **is** per-chat because `source_chat_id` exists.
- History truth: also `SELECT SUM(saved_links), SUM(saved_docs) FROM index_jobs WHERE chat_id=? AND community_id=?` (sum across jobs/topics). Matches transfer-derived counts but survives if transfer provenance missing.

**Gap and fallback (documented, not migrated):**
`links/personal_links` lack `source_chat_id`. Per-chat link count for live must rely on `transfer_id` (history) + `community_id/user_id` aggregate + ephemeral `USERBOT_STATS`. Documented as known limitation — see section 6.

**Photos / non-indexable media:**
- `MessageMediaPhoto` in backfill increments `skipped_media` and is **not** saved as a doc; similar non-allowlisted docs are vaulted but not indexed.
- Stats bucket `photos` should be reported from `index_jobs.saved_files/skipped_media` for history, and for live via media-class check if photo saving starts. Task 5 may start saving photos as docs — then they appear in `uploaded_documents` and `saved_docs`.

## 3. "Today" definition

**Rolling 24 h**, not calendar day — avoids timezone.
- Cutoff: `const todayCutoff = Date.now() - 86400000`.
- Queries: `WHERE created_at > ?` on `links`, `personal_links`, `uploaded_documents`.
- Photos: bucket under `photos` via media class check; history photos counted via `index_jobs.saved_docs` once photos are saved (Task 5 note — currently in `skipped_media`, so today-photos is 0 until then).
- Live "today" from `USERBOT_STATS` is inherently rolling (lastAt within 24 h); stats reset on restart (note staleness).

## 4. Topic model

Forum groups detected via `isForumEnabled(token, chatId, env)` (bot `getChat.is_forum` or userbot entity `forum` flag) **or** existence of rows in `telegram_topic_bindings` for that `chatId`.

Stats nesting:
1. Fetch topics: `SELECT thread_id, community_id, target FROM telegram_topic_bindings WHERE chat_id=? ORDER BY thread_id`.
2. For each thread: clone entry is `userbot_follows.chat_id = chatId + ':' + threadId` (created in `doCloneAfterConfirm` for forums) and `index_jobs` rows carry `thread_id`.
3. Per-thread counts:
   - History: `SELECT SUM(saved_links), SUM(saved_docs) FROM index_jobs WHERE chat_id=? AND thread_id=?`
   - Live: `USERBOT_STATS.get(chatId + ':' + threadId)` — **requires extending stat keys** from bare `chatId` to colon-joined `chatId:threadId` (matching `userbot_follows` convention). Current code only keys by bare `chatId`.
4. Chat-level rollup still shown (sum of topics + non-topic job).

**Decision:** Key stats as `chatId:threadId` (colon-joined string).

## 5. Helper signature

```js
// worker/index_legacy.js (read-only design — implementation in Task 5)
export async function buildStatsReport(env, token) {
  // token: Telegram bot token for getChat name resolution (optional — fallback to userbot)
  // env: Worker env with env.DB (D1/PG shim)
  // returns: { chats: ChatStat[], generatedAt: number, truncated?: boolean }
}

// Shapes:
type ChatStat = {
  id: string;                // normalized -100… chat_id
  name: string;              // via getChat / getEntity / raw id
  type: 'channel' | 'group' | 'forum' | 'unknown';
  target: 'community' | 'personal' | 'both';
  communityId: string | null;
  live: boolean;             // USERBOT_STATS.has(id) && lastAt within 10 min
  isForum: boolean;
  total: { links: number; docs: number; files: number; skippedMedia: number; photos: number };
  today: { links: number; docs: number; photos: number };
  topics?: TopicStat[];      // only when isForum && bindings exist
  jobs: { running: number; done: number; error: number };
};

type TopicStat = {
  id: string;                // thread_id
  title: string | null;      // from getForumTopicsViaUserbot if available
  total: { links: number; docs: number };
  today: { links: number; docs: number };
  live: { msgs: number; links: number; docs: number; lastAt: number | null };
};
```

Rendering in Task 5: merge shim `worker/index.js:stats` (currently 2-line table) into legacy helper, reuse `/userbot_status` + `/index_status` logic, render topic-wise cards with HTML escaping and 4096-char chunking.

## 6. No schema migration — decision + fallback

**Decision:** Do **not** add `links.source_chat_id` / `personal_links.source_chat_id` in this slice. Would require touching `saveIndexedLinks` / `savePersonalIndexedLinks` (add col, set on insert), updating `pgcompat PRIMARY_KEYS` if upsert changes, and backfilling existing rows — out of scope for a design-only task.

**Fallback provenance (this task):**
- History per-chat links: via `transfer_id -> index_jobs.chat_id`.
- Live per-chat links: via `community_id` aggregate (imperfect) + ephemeral `USERBOT_STATS`.
- Docs/files per-chat: already correct via `uploaded_documents.source_chat_id`.
- Future follow-up (recorded, not implemented): `ALTER TABLE links ADD COLUMN source_chat_id TEXT`, set in `saveIndexedLinks` from channel context, backfill `UPDATE links SET source_chat_id = (SELECT chat_id FROM index_jobs WHERE id = transfer_id) WHERE transfer_id IS NOT NULL`. Then per-chat link counts become `WHERE source_chat_id=?`.

**pgcompat note:** No `PRIMARY_KEYS` change needed this slice.

## 7. Verified reads

- `worker/schema.sql` — no `source_chat_id` on `links`/`personal_links`; has it on `uploaded_documents`.
- `worker/index_legacy.js:3798` — `ensureDocumentsTable` confirms `source_chat_id/source_message_id`.
- `worker/index_legacy.js:7769` — `telegram_topic_bindings` + `saveIndexedDocument` dedup on `(scope, community_id, source_chat_id, source_message_id)`.
- `worker/index_legacy.js:7975+` — `ensureIndexTables` (`index_jobs`) + `collectClonePreview` thread/userbot columns.
- `worker/index_legacy.js:13387+` — `ensureUserbotTables`, `USERBOT_STATS` Map, `userbotStat`, `USERBOT_ACCOUNTS`.
- `server/pgdb.js` / `worker/pgcompat.js` — D1 to PG shim, `INTEGER to BIGINT`, missing-column idempotency.

---
*Addendum target for Task 5 if anything changes: append here, do not rewrite history.*
