/**
 * Cloudflare Worker: Athena (auth + API + static)
 * Telegram + Discord OAuth, session-gated APIs, community bot bindings
 */

import {
  GitHubStore, readAll, appendLink, appendLinks, rewriteAll, rewriteFileContaining, folderFor, LISTING_TTL_MS,
} from './storage.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PUBLIC_API = new Set([
  '/api/health',
  '/api/auth/config',
  '/api/auth/telegram',
  '/api/auth/telegram/callback',
  '/api/auth/telegram/webapp',
  '/api/auth/discord',
  '/api/auth/discord/callback',
  '/api/telegram-webhook',
  // Read-only instance defaults; the login page needs these before auth.
  '/api/instance/config',
]);

/**
 * Security headers added to every response (API + static).
 * No X-Frame-Options: it cannot express an allowlist, and Telegram Web runs the
 * Mini App inside an iframe — frame-ancestors covers framing for every browser
 * that matters and keeps that login path working.
 */
function securityHeaders() {
  return {
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self' https://telegram.org 'unsafe-inline'; connect-src 'self' https:; frame-ancestors https://web.telegram.org https://telegram.org; base-uri 'self'",
  };
}

/**
 * In-memory sliding-window rate limiter (per worker instance; resets on
 * redeploy). `limit` events per `windowMs` per key. Callers pass an explicit
 * key (IP + user id where available). Not a substitute for an edge rate limit,
 * but closes the obvious abuse paths: paid upstream calls (/api/ai/chat),
 * outbound fetch amplification (link scraper), and OAuth state churn.
 */
const RATE_WINDOWS = new Map();
const RATE_MAX_KEYS = 10_000;
const RATE_SWEEP_MS = 60_000;
let rateSweptAt = 0;
function rateLimit(key, limit, windowMs) {
  if (!key) return false;
  const now = Date.now();
  // Keys are per-IP, so an unbounded map is a slow leak on a long-lived
  // self-host process. Sweep expired windows once the map gets large, at most
  // once a minute so a flood of live keys cannot make every call a full scan.
  if (RATE_WINDOWS.size > RATE_MAX_KEYS && now - rateSweptAt > RATE_SWEEP_MS) {
    rateSweptAt = now;
    for (const [k, v] of RATE_WINDOWS) {
      if (v.windowEnd < now) RATE_WINDOWS.delete(k);
    }
  }
  let w = RATE_WINDOWS.get(key);
  if (!w || w.windowEnd < now) {
    w = { windowEnd: now + windowMs, count: 0 };
    RATE_WINDOWS.set(key, w);
  }
  w.count += 1;
  return w.count > limit;
}
function clientIp(request) {
  const cf = request?.headers?.get('CF-Connecting-IP');
  if (cf) return cf;
  const fwd = request?.headers?.get('X-Forwarded-For') || '';
  if (fwd) return fwd.split(',')[0].trim();
  return '';
}

/**
 * Allowed cross-origin callers for API responses. Wildcard is not usable with
 * credentialed requests and lets any origin read public endpoints. Restrict to
 * the configured frontend + the request's own origin; the self-hosted backend
 * is reached cross-origin, so its configured frontend must stay allowed.
 */
function corsAllowedOrigin(env, request) {
  const own = request?.url ? new URL(request.url).origin : '';
  const configured = [env.ATHENA_FRONTEND_URL, env.ATHENA_ALLOWED_ORIGINS]
    .flatMap(value => String(value || '').split(/[\s,]+/))
    .map(value => value.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  const allowed = new Set();
  if (own) allowed.add(own);
  for (const origin of configured) allowed.add(origin);
  const origin = (request?.headers?.get('Origin') || '').trim();
  if (origin && allowed.has(origin)) return origin;
  return allowed.size ? [...allowed][0] : own;
}

export default {
  async fetch(request, env, ctx) {
    // Background work (batch enrichment, …): Cloudflare keeps the promise alive
    // via waitUntil; the self-host shim runs it with a no-op waitUntil, which
    // still executes it asynchronously after the response.
    env.__ctx = ctx || { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
    const url = new URL(request.url);
    // Tolerate // and /// in paths (e.g. instance URLs saved with a trailing
    // slash joined to '/api/...') — route matching is exact below.
    const pathname = url.pathname.replace(/\/{2,}/g, '/');

    const corsHeaders = {
      'Access-Control-Allow-Origin': corsAllowedOrigin(env, request),
      // The allowed origin now varies per request; without this a cache can hand
      // one origin's response (and its ACAO) to another.
      'Vary': 'Origin',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-User-Id',
      ...securityHeaders(),
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // ---- Public auth + webhooks ----
      if (pathname === '/api/health') {
        const selfHosted = isSelfHosted(env);
        const engine = selfHosted ? selfHostedEngine(env) : 'Cloudflare D1';
        return Response.json({
          status: 'ok',
          worker: 'athena-worker',
          version: '1.0.8',
          runtime: selfHosted ? 'selfhost' : 'cloudflare',
          database: engine,
          // true once a webhook secret is resolvable; false means the bot endpoint
          // is still accepting unsigned (forgeable) updates.
          webhook_auth: !!(await webhookSecret(env)),
          features: ['oidc-telegram', 'oauth-discord', 'session-auth', 'instance-owners', 'elevated-admins', 'member-community-join', 'join-requires-tg-group', 'group-presence-ban', 'personal-wipe', 'community-delete-confirm', 'tg-ban-sync', 'ai-all-ranks', 'god-ai-config', 'rank-acl', 'clear-demote', 'bot-ban-gate', 'multi-community-ban', 'live-group-scan', 'miniapp-login', 'session-cookie', 'dm-ai-search', 'live-sync', 'topic-lock-all-cmds', 'link-scrape-universal', 'bot-smart-multi-link', 'bot-topic', 'bot-edit', 'bot-token-verify', 'bot-ai', 'bot-search-delete', 'bot-personal-community-switch', 'community-verify', 'community-list', 'community-delete', 'bot-admin', 'forum-thread-replies', 'help-menu', 'tg-split-messages', 'votes-reports', 'notifications', 'd1-sync', 'telegram-bot', 'instance-default-backend', 'scoped-backups', 'rich-formatting', 'file-upload', 'accent-colors']
        }, { headers: corsHeaders });
      }

      if (pathname === '/api/auth/config' && request.method === 'GET') {
        return handleAuthConfig(env, corsHeaders);
      }

      // Telegram OAuth (redirect to oauth.telegram.org → callback)
      if (pathname === '/api/auth/telegram' && request.method === 'GET') {
        if (rateLimit(`oauth:${clientIp(request)}`, 10, 60_000)) {
          return Response.json({ success: false, error: 'Too many login attempts', code: 'RATE_LIMITED' }, { status: 429, headers: corsHeaders });
        }
        return handleTelegramStart(url, env, corsHeaders);
      }
      if (pathname === '/api/auth/telegram/callback' && request.method === 'GET') {
        return await handleTelegramCallback(url, env, corsHeaders, request);
      }
      if (pathname === '/api/auth/telegram/webapp' && request.method === 'POST') {
        if (rateLimit(`webapp:${clientIp(request)}`, 10, 60_000)) {
          return Response.json({ success: false, error: 'Too many login attempts', code: 'RATE_LIMITED' }, { status: 429, headers: corsHeaders });
        }
        return await handleTelegramWebAppAuth(request, env, corsHeaders, url);
      }

      // Discord OAuth (redirect → callback)
      if (pathname === '/api/auth/discord' && request.method === 'GET') {
        if (rateLimit(`oauth:${clientIp(request)}`, 10, 60_000)) {
          return Response.json({ success: false, error: 'Too many login attempts', code: 'RATE_LIMITED' }, { status: 429, headers: corsHeaders });
        }
        return await handleDiscordStart(url, env, corsHeaders);
      }
      if (pathname === '/api/auth/discord/callback' && request.method === 'GET') {
        return await handleDiscordCallback(url, env, request);
      }

      if (pathname === '/api/telegram-webhook' && request.method === 'POST') {
        // Telegram signs every delivery with the secret we registered via setWebhook.
        // Without this check the endpoint is an unauthenticated RPC into every bot
        // command — anyone could forge `from.id` and act as GOD.
        if (!(await webhookRequestIsAuthentic(request, env))) {
          return new Response('Forbidden', { status: 403, headers: corsHeaders });
        }
        if (rateLimit(`webhook:${clientIp(request)}`, 600, 60_000)) {
          return new Response('Too Many Requests', { status: 429, headers: corsHeaders });
        }
        const update = await request.json().catch(() => null);
        if (!update) {
          return new Response('Bad Request', { status: 400, headers: corsHeaders });
        }
        return await handleTelegramWebhook(update, env, corsHeaders);
      }

      // ---- Session for all other /api ----
      let user = null;
      if (pathname.startsWith('/api/')) {
        user = await requireUser(request, env);
        if (!user && !PUBLIC_API.has(pathname)) {
          return Response.json(
            { success: false, error: 'Login required', code: 'AUTH_REQUIRED' },
            { status: 401, headers: corsHeaders }
          );
        }
      }

      if (pathname === '/api/auth/me' && request.method === 'GET') {
        const owner = await isInstanceOwnerUserAsync(user, env); // GOD rank
        const elevated = owner || (await isElevatedUser(user, env)); // admin/owner or god
        if (owner) {
          try { await syncInstanceOwnerCommunities(user, env); } catch (e) { console.error('sync communities', e); }
        }
        // Fully banned only if no remaining unbanned memberships (multi-community)
        if (!owner && await isUserFullySiteBanned(env, user)) {
          await destroyUserSessions(env, user.id);
          return deny(corsHeaders, BANNED_SITE_MSG, 'SITE_BANNED', 403);
        }
        return Response.json({ success: true, user: publicUser(user, { god: owner, elevated }) }, { headers: corsHeaders });
      }

      if (pathname === '/api/auth/session-token' && request.method === 'GET') {
        // For the CLI: an already-logged-in browser never re-runs the OAuth
        // redirect, so there is no fresh ?session= URL to copy. Hand back the
        // current session token instead — same one the HttpOnly cookie holds.
        return Response.json({ success: true, token: getBearerToken(request) }, { headers: corsHeaders });
      }

      if (pathname === '/api/auth/logout' && request.method === 'POST') {
        await destroySession(request, env);
        // The session row is gone either way, but JS cannot clear an HttpOnly
        // cookie — expire it here so the browser stops sending a dead token.
        return Response.json({ success: true }, {
          headers: { ...corsHeaders, 'Set-Cookie': sessionCookieHeader(url, '', 0) }
        });
      }

      if (pathname === '/api/account/wipe' && request.method === 'POST') {
        if (!(await isInstanceOwnerUserAsync(user, env))) {
          return deny(corsHeaders, 'Wipe personal is for GOD rank (instance host) only', 'GOD_ONLY');
        }
        return await handleWipePersonalAccount(request, user, env, corsHeaders);
      }

      // Communities
      if (pathname === '/api/communities') {
        if (request.method === 'GET') {
          return await handleListCommunities(user, env, corsHeaders);
        }
        if (request.method === 'POST') {
          return await handleCreateCommunity(request, user, env, corsHeaders);
        }
      }
      if (pathname === '/api/communities/join' && request.method === 'POST') {
        return await handleJoinCommunity(request, user, env, corsHeaders);
      }
      if (pathname === '/api/communities/info' && request.method === 'GET') {
        return await handleCommunityInfo(url, user, env, corsHeaders);
      }

      // Bot bindings — visible to all ranks; mutate GOD only
      if (pathname === '/api/bot-bindings') {
        if (request.method === 'GET') {
          return await handleListBotBindings(url, user, env, corsHeaders);
        }
        if (!(await isInstanceOwnerUserAsync(user, env))) {
          return deny(corsHeaders, 'Bot settings can only be changed by GOD rank (instance host)', 'GOD_ONLY');
        }
        if (request.method === 'POST') {
          return await handleUpsertBotBinding(request, user, env, corsHeaders);
        }
        if (request.method === 'PATCH') {
          return await handleSwitchBotScope(request, user, env, corsHeaders);
        }
        if (request.method === 'DELETE') {
          return await handleDeleteCommunityBot(request, user, env, corsHeaders);
        }
      }

      // Community links — members only (join required before dump)
      if (pathname === '/api/links') {
        if (request.method === 'GET') {
          return await handleGetCommunityLinks(url, user, env, corsHeaders);
        }
        if (request.method === 'POST') {
          if (rateLimit(`scrape:${user?.id || clientIp(request)}`, 60, 60_000)) {
            return Response.json({ success: false, error: 'Too many saves — slow down', code: 'RATE_LIMITED' }, { status: 429, headers: corsHeaders });
          }
          return await handlePostCommunityLink(request, user, env, corsHeaders);
        }
        if (request.method === 'PATCH') {
          return await handlePatchCommunityLink(request, user, env, corsHeaders);
        }
        if (request.method === 'DELETE') {
          return await handleDeleteCommunityLink(request, user, env, corsHeaders);
        }
      }

      // Whole-corpus search for the website. The browser only holds the most
      // recent slice of links, so client-side filtering silently missed older
      // ones once a brain grew past that. This scans every row server-side.
      if (pathname === '/api/links/search' && request.method === 'GET') {
        return await handleSearchLinks(url, user, env, corsHeaders);
      }

      if (pathname === '/api/documents') {
        if (request.method === 'GET') return await handleGetDocuments(url, user, env, corsHeaders);
        if (request.method === 'POST') return await handlePostDocument(request, user, env, corsHeaders);
        if (request.method === 'DELETE') return await handleDeleteDocument(request, user, env, corsHeaders);
      }

      if (pathname === '/api/links/vote' && request.method === 'POST') {
        return await handleVoteLink(request, user, env, corsHeaders);
      }
      if (pathname === '/api/links/report' && request.method === 'POST') {
        return await handleReportLink(request, user, env, corsHeaders);
      }

      // Notifications
      if (pathname === '/api/notifications') {
        if (request.method === 'GET') {
          return await handleListNotifications(user, env, corsHeaders);
        }
        if (request.method === 'POST') {
          return await handleNotificationAction(request, user, env, corsHeaders);
        }
      }

      // AI chat — all ranks; credentials (config) GOD only
      if (pathname === '/api/ai/chat' && request.method === 'POST') {
        if (rateLimit(`ai:${user?.id || clientIp(request)}`, 30, 60_000)) {
          return Response.json({ success: false, error: 'Too many AI requests — slow down', code: 'RATE_LIMITED' }, { status: 429, headers: corsHeaders });
        }
        return await handleAiChatProxy(request, user, env, corsHeaders);
      }
      if (pathname === '/api/ai/config') {
        if (request.method === 'GET') {
          return await handleGetAiConfig(user, env, corsHeaders);
        }
        if (!(await isInstanceOwnerUserAsync(user, env))) {
          return deny(corsHeaders, 'AI credentials are set by GOD rank only', 'GOD_ONLY');
        }
        if (request.method === 'POST') {
          return await handleSaveAiConfig(request, user, env, corsHeaders);
        }
        if (request.method === 'DELETE') {
          return await handleClearAiConfig(user, env, corsHeaders);
        }
      }

      // Instance defaults. The READ is public on purpose: the login page must
      // learn which backend to talk to before anyone is authenticated, and
      // every visitor needs the same answer or members end up on different
      // databases from the owner.
      if (pathname === '/api/instance/config') {
        if (request.method === 'GET') {
          return await handleGetInstanceConfig(env, corsHeaders);
        }
        if (!(await isInstanceOwnerUserAsync(user, env))) {
          return deny(corsHeaders, 'Instance defaults are set by GOD rank only', 'GOD_ONLY');
        }
        if (request.method === 'POST') {
          return await handleSetInstanceConfig(request, env, corsHeaders, url.origin);
        }
      }

      // Storage backend — readable by all ranks, writable by GOD only
      if (pathname === '/api/storage/config') {
        if (request.method === 'GET') {
          return await handleGetStorageConfig(env, corsHeaders);
        }
        if (!(await isInstanceOwnerUserAsync(user, env))) {
          return deny(corsHeaders, 'Storage backend is set by GOD rank only', 'GOD_ONLY');
        }
        if (request.method === 'POST') {
          return await handleSaveStorageConfig(request, env, corsHeaders);
        }
      }
      if (pathname === '/api/storage/sync' && request.method === 'POST') {
        if (!(await isInstanceOwnerUserAsync(user, env))) {
          return deny(corsHeaders, 'Storage sync is GOD rank only', 'GOD_ONLY');
        }
        return await handleStorageSync(user, env, corsHeaders);
      }

      // Community admins (platform IDs)
      if (pathname === '/api/community-admins') {
        if (request.method === 'GET') {
          return await handleListAdmins(url, user, env, corsHeaders);
        }
        if (request.method === 'POST') {
          return await handleUpsertAdmin(request, user, env, corsHeaders);
        }
        if (request.method === 'DELETE') {
          return await handleDeleteAdmin(request, user, env, corsHeaders);
        }
      }

      // Bulk bookmark dumps from the CLI — ONE request for the whole batch.
      if (pathname === '/api/personal-links/batch' && request.method === 'POST') {
        if (!(await isInstanceOwnerUserAsync(user, env))) {
          return deny(corsHeaders, 'Personal mode is for GOD rank (instance host) only. Join a community with /community_join <id>', 'PERSONAL_LOCKED');
        }
        if (rateLimit(`batch:${user?.id || clientIp(request)}`, 200, 60_000)) {
          return Response.json({ success: false, error: 'Too many saves — slow down', code: 'RATE_LIMITED' }, { status: 429, headers: corsHeaders });
        }
        return await handlePostPersonalLinksBatch(request, user.id, env, corsHeaders);
      }
      if (pathname === '/api/links/batch' && request.method === 'POST') {
        if (rateLimit(`batch:${user?.id || clientIp(request)}`, 200, 60_000)) {
          return Response.json({ success: false, error: 'Too many saves — slow down', code: 'RATE_LIMITED' }, { status: 429, headers: corsHeaders });
        }
        return await handlePostCommunityLinksBatch(request, user, env, corsHeaders);
      }

      // Personal links — GOD rank only
      if (pathname === '/api/personal-links') {
        if (!(await isInstanceOwnerUserAsync(user, env))) {
          return deny(corsHeaders, 'Personal mode is for GOD rank (instance host) only. Join a community with /community_join <id>', 'PERSONAL_LOCKED');
        }
        if (request.method === 'GET') {
          return await handleGetPersonalLinks(user.id, env, corsHeaders);
        }
        if (request.method === 'POST') {
          if (rateLimit(`scrape:${user?.id || clientIp(request)}`, 60, 60_000)) {
            return Response.json({ success: false, error: 'Too many saves — slow down', code: 'RATE_LIMITED' }, { status: 429, headers: corsHeaders });
          }
          return await handlePostPersonalLink(request, user.id, env, corsHeaders);
        }
        if (request.method === 'PATCH') {
          return await handlePatchPersonalLink(request, user.id, env, corsHeaders);
        }
        if (request.method === 'DELETE') {
          return await handleDeletePersonalLink(request, user.id, env, corsHeaders);
        }
      }

      // NOTE: the R2 file/backup routes (/api/files*, /api/export, /api/import,
      // /api/backups) were removed. R2 was never enabled on this account, so every
      // one of them returned 503, no UI ever called them, and handleDownloadFile /
      // handleDeleteFile took an object key straight from user input with no
      // ownership check (IDOR). Re-add them properly — keys scoped to
      // files/<userId>/ and validated on read/delete — once R2 is enabled and an
      // `r2_buckets` binding exists in wrangler.toml.
      // /api/personal-links/sync was also removed: nothing called it, and it did an
      // unguarded DELETE-then-batch-insert that could wipe a user's entire personal
      // brain if the insert failed.

      // Unmatched /api/* must not fall through to the SPA asset handler: with
      // not_found_handling = "single-page-application" that returns index.html with
      // HTTP 200, so a client gets a web page where it expects JSON.
      if (pathname.startsWith('/api/')) {
        return Response.json(
          { success: false, error: 'Not found', code: 'NOT_FOUND' },
          { status: 404, headers: corsHeaders }
        );
      }

      if (env.ASSETS) {
        const res = await env.ASSETS.fetch(request);
        // Never cache HTML: index.html is the entry point whose ?v= stamps
        // decide which JS/CSS the browser loads. A stale index.html means a
        // stale frontend no matter how often we bump the assets.
        if (res.ok && (pathname === '/' || /\.html?$/.test(pathname))) {
          return new Response(res.body, {
            status: res.status,
            headers: { ...Object.fromEntries(res.headers), 'Cache-Control': 'no-cache' },
          });
        }
        return res;
      }

      return new Response('Athena API', { status: 200, headers: corsHeaders });
    } catch (err) {
      return Response.json({ success: false, error: err.message }, { status: 500, headers: corsHeaders });
    }
  }
};


// ============================================================
// Auth helpers
// ============================================================

/**
 * Shared secret registered with setWebhook and echoed back by Telegram in
 * X-Telegram-Bot-Api-Secret-Token. Explicit env var wins; otherwise it is derived
 * deterministically from the bot token so existing installs need no new config.
 */
async function webhookSecret(env) {
  const explicit = String(env.TELEGRAM_WEBHOOK_SECRET || '').trim();
  if (explicit) return explicit;
  const base = String(env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_CLIENT_SECRET || '').trim();
  if (!base) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`athena-webhook:${base}`));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 48);
}

/** Constant-time string compare (avoids leaking the secret via response timing). */
function safeEqual(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

async function webhookRequestIsAuthentic(request, env) {
  const expected = await webhookSecret(env);
  if (!expected) return false;
  const got = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  return safeEqual(got, expected);
}

function parseIdList(raw) {
  return String(raw || '')
    .split(/[,;\s]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

/** Empty TG+Discord owner lists → everyone is full owner (self-host). */
function ownerListsConfigured(env) {
  return parseIdList(env.TG_OWNER_IDS).length > 0 || parseIdList(env.DISCORD_OWNER_IDS).length > 0;
}

function isLikelyTelegramBotApiId(id) {
  const s = String(id || '');
  return /^\d{5,15}$/.test(s);
}

function isInstanceOwnerUser(user, env) {
  if (!user) return false;
  if (!ownerListsConfigured(env)) return true;
  const ownersTg = parseIdList(env.TG_OWNER_IDS);
  const ownersDc = parseIdList(env.DISCORD_OWNER_IDS);
  const pid = String(user.provider_id || '');
  const tgApi = user.telegram_api_id ? String(user.telegram_api_id) : '';
  if (user.provider === 'telegram') {
    if (ownersTg.includes(pid) || (tgApi && ownersTg.includes(tgApi))) return true;
    // OIDC sub sometimes equals Bot API id
    if (isLikelyTelegramBotApiId(pid) && ownersTg.includes(pid)) return true;
  }
  if (user.provider === 'discord') {
    if (ownersDc.includes(pid)) return true;
  }
  return false;
}

/** Enrich owner check with personal-bot DM chat id (= Telegram Bot API user id). */
async function isInstanceOwnerUserAsync(user, env) {
  if (isInstanceOwnerUser(user, env)) return true;
  if (!user || !ownerListsConfigured(env) || user.provider !== 'telegram') return false;
  const owners = parseIdList(env.TG_OWNER_IDS);
  try {
    const row = await env.DB.prepare(
      `SELECT group_id FROM community_bots
       WHERE platform = 'telegram'
         AND (user_id = ? OR created_by = ?)
         AND COALESCE(scope, 'personal') = 'personal'
       ORDER BY created_at DESC LIMIT 5`
    ).bind(user.id, user.id).all();
    for (const b of (row.results || [])) {
      if (b.group_id && owners.includes(String(b.group_id))) {
        // Persist for next time
        try {
          await env.DB.prepare('UPDATE users SET telegram_api_id = ? WHERE id = ?')
            .bind(String(b.group_id), user.id).run();
        } catch (_) {}
        return true;
      }
    }
  } catch (_) {}
  return false;
}

/**
 * Elevated = instance owner OR community admin (role admin/owner in members,
 * or community_admins platform id set via /admin). Regular members are not elevated.
 * Personal mode + AI + bot personal features require elevated access.
 */
async function isCommunityAdminUser(user, env) {
  if (!user?.id) return false;
  await ensureCommunityMembersColumns(env);
  try {
    const m = await env.DB.prepare(
      `SELECT 1 FROM community_members
       WHERE user_id = ? AND role IN ('owner', 'admin')
       LIMIT 1`
    ).bind(user.id).first();
    if (m) return true;
  } catch (_) {}
  try {
    const creator = await env.DB.prepare(
      `SELECT 1 FROM communities WHERE creator_id = ? AND id != 'default' LIMIT 1`
    ).bind(user.id).first();
    if (creator) return true;
  } catch (_) {}
  // Platform admin IDs from /admin (telegram user id)
  const tgId = user.telegram_api_id || (isLikelyTelegramBotApiId(user.provider_id) ? user.provider_id : null);
  if (tgId) {
    try {
      const a = await env.DB.prepare(
        `SELECT 1 FROM community_admins
         WHERE platform = 'telegram' AND platform_user_id = ?
         LIMIT 1`
      ).bind(String(tgId)).first();
      if (a) return true;
    } catch (_) {}
  }
  if (user.provider === 'discord' && user.provider_id) {
    try {
      const a = await env.DB.prepare(
        `SELECT 1 FROM community_admins
         WHERE platform = 'discord' AND platform_user_id = ?
         LIMIT 1`
      ).bind(String(user.provider_id)).first();
      if (a) return true;
    } catch (_) {}
  }
  return false;
}

async function isElevatedUser(user, env) {
  if (!user) return false;
  if (await isInstanceOwnerUserAsync(user, env)) return true;
  if (!ownerListsConfigured(env)) return true; // self-host: all elevated
  return await isCommunityAdminUser(user, env);
}

/** GOD = TG_OWNER_IDS / DISCORD_OWNER_IDS host. */
async function isGodUserAsync(user, env) {
  return isInstanceOwnerUserAsync(user, env);
}
function isGodTgId(tgUserId, env) {
  return isInstanceOwnerTgId(tgUserId, env);
}

/** Rank in one community: god | owner | admin | member | none */
async function getCommunityMemberRole(env, communityId, user) {
  if (!communityId || !user?.id) return null;
  await ensureCommunityMembersColumns(env);
  try {
    const c = await env.DB.prepare('SELECT creator_id FROM communities WHERE id = ?').bind(communityId).first();
    if (c?.creator_id === user.id) return 'owner';
  } catch (_) {}
  try {
    const m = await env.DB.prepare(
      'SELECT role FROM community_members WHERE community_id = ? AND user_id = ?'
    ).bind(communityId, user.id).first();
    if (m?.role) return m.role;
  } catch (_) {}
  return null;
}

async function resolveUserRank(env, user, tgUserId, communityId = null) {
  const god = (user && await isGodUserAsync(user, env)) || isGodTgId(tgUserId, env);
  if (god) return { rank: 'god', label: 'GOD', communityRole: null };
  if (!user) return { rank: 'none', label: 'not logged in', communityRole: null };
  let communityRole = communityId ? await getCommunityMemberRole(env, communityId, user) : null;
  if (!communityRole && !communityId) {
    // best community role across memberships
    try {
      const m = await env.DB.prepare(
        `SELECT role FROM community_members
         WHERE user_id = ? AND role IN ('owner','admin','member')
         ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END LIMIT 1`
      ).bind(user.id).first();
      communityRole = m?.role || null;
    } catch (_) {}
  }
  if (communityRole === 'owner') return { rank: 'owner', label: 'owner', communityRole };
  if (communityRole === 'admin') return { rank: 'admin', label: 'admin', communityRole };
  // platform admin table counts as admin for that community
  if (communityId && tgUserId) {
    try {
      const a = await env.DB.prepare(
        `SELECT 1 FROM community_admins WHERE community_id = ? AND platform = 'telegram' AND platform_user_id = ?`
      ).bind(communityId, String(tgUserId)).first();
      if (a) return { rank: 'admin', label: 'admin', communityRole: 'admin' };
    } catch (_) {}
  }
  if (communityRole === 'member') return { rank: 'member', label: 'member', communityRole };
  return { rank: 'none', label: 'not a member', communityRole: null };
}

function rankAtLeast(rank, min) {
  const order = { none: 0, member: 1, admin: 2, owner: 3, god: 4 };
  return (order[rank] || 0) >= (order[min] || 0);
}

/**
 * Live scan: for every community with a real TG group (group_id starts with '-'),
 * ask Telegram if this user is currently a member. Source of truth for login access.
 */
async function scanTgPresenceAcrossCommunities(env, tgUserId) {
  if (!tgUserId) return [];
  await ensureBotBindingColumns(env);
  let rows;
  try {
    const r = await env.DB.prepare(
      `SELECT c.id, c.name, b.group_id, b.bot_token
       FROM communities c
       INNER JOIN community_bots b
         ON b.community_id = c.id AND b.platform = 'telegram' AND b.group_id IS NOT NULL
       WHERE c.id != 'default'
       ORDER BY c.created_at DESC`
    ).all();
    rows = r.results || [];
  } catch (_) {
    return [];
  }
  // Dedupe community; only real groups (negative chat ids), skip personal DM bindings
  const byId = new Map();
  for (const row of rows) {
    if (!row.id || !row.group_id) continue;
    const gid = String(row.group_id);
    if (!gid.startsWith('-')) continue;
    if (!byId.has(row.id)) byId.set(row.id, row);
  }
  const out = [];
  for (const row of byId.values()) {
    let inGroup;
    try {
      inGroup = await isTelegramUserInCommunityGroup(env, row.id, tgUserId);
    } catch (_) {
      // Unknown, not absent — do not let an exception cost this user their membership.
      inGroup = PRESENCE_UNKNOWN;
    }
    out.push({
      id: row.id,
      name: row.name || row.id,
      group_id: String(row.group_id),
      inGroup
    });
  }
  return out;
}

/**
 * Sync D1 bans with live Telegram presence:
 * - in group → clear ban for that community
 * - not in group + was member → ban
 * Returns { inAnyGroup, presence[] }
 */
async function syncLivePresenceForUser(env, user, tgUserId) {
  const tid = tgUserId || (user && await resolveTgApiIdForUser(user));
  if (!tid) return { inAnyGroup: false, presence: [] };
  const presence = await scanTgPresenceAcrossCommunities(env, tid);
  let inAnyGroup = false;
  let anyUnknown = false;
  for (const p of presence) {
    if (p.inGroup === true) {
      inAnyGroup = true;
      await unbanUserFromCommunity(env, p.id, {
        platform: 'telegram',
        platformUserId: String(tid),
        userId: user?.id || null
      });
    } else if (p.inGroup === PRESENCE_UNKNOWN) {
      // Telegram did not answer. Leave existing state untouched: no ban, no unban.
      anyUnknown = true;
    } else if (user?.id) {
      // Definitively left/kicked: record the ban. Membership is intentionally kept so
      // the ban stays reversible and the user's role survives a later rejoin.
      try {
        const mem = await env.DB.prepare(
          'SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?'
        ).bind(p.id, user.id).first();
        if (mem) {
          await banUserFromCommunity(env, p.id, {
            platform: 'telegram',
            platformUserId: String(tid),
            userId: user.id,
            reason: 'not_in_telegram_group'
          });
        }
      } catch (_) {}
    }
  }
  return { inAnyGroup, anyUnknown, presence, tgUserId: String(tid) };
}

/**
 * Fully site-banned ONLY if user is not in ANY community Telegram group right now
 * AND has at least one ban (left/kicked everywhere).
 * First-time users (no bans, not in groups yet) can always login.
 * Banned from PZP but still in Athoo TG group → can login.
 */
async function isUserFullySiteBanned(env, user) {
  if (!user) return false;
  if (await isGodUserAsync(user, env)) return false;
  await ensureBanTable(env);
  await ensureCommunityMembersColumns(env);

  const tgId = await resolveTgApiIdForUser(user);
  // No Bot API id yet → allow login (they need to auth first)
  if (!tgId) return false;

  const { inAnyGroup, anyUnknown } = await syncLivePresenceForUser(env, user, tgId);
  if (inAnyGroup) return false;
  // Telegram was unreachable for at least one community — we cannot prove the user
  // is out of everything, so we must not lock them out of the whole site.
  if (anyUnknown) return false;

  // The documented rule is "fully banned only when no unbanned membership remains".
  // Communities without a linked TG group never appear in the presence scan, so a
  // membership there must still count as access.
  try {
    if (user.id) {
      const alive = await env.DB.prepare(
        `SELECT 1 FROM community_members m
         INNER JOIN communities c ON c.id = m.community_id
         WHERE m.user_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM community_bans b
             WHERE b.community_id = m.community_id AND b.user_id = m.user_id
           )
         LIMIT 1`
      ).bind(user.id).first();
      if (alive) return false;
    }
  } catch (_) {}

  // Not in any group and no unbanned membership left — block only if a ban exists.
  try {
    if (user.id) {
      const b = await env.DB.prepare(
        `SELECT 1 FROM community_bans b
         INNER JOIN communities c ON c.id = b.community_id
         WHERE b.user_id = ? LIMIT 1`
      ).bind(user.id).first();
      if (b) return true;
    }
    const b2 = await env.DB.prepare(
      `SELECT 1 FROM community_bans b
       INNER JOIN communities c ON c.id = b.community_id
       WHERE b.platform = 'telegram' AND b.platform_user_id = ? LIMIT 1`
    ).bind(String(tgId)).first();
    if (b2) return true;
  } catch (_) {}
  return false;
}

/**
 * /rank + /community_list: live TG presence + D1 roles.
 * Format ranks: owner | admin | member | banned | in-group (in TG but not /community_join yet)
 */
async function listUserCommunityStatuses(env, user, tgUserId) {
  const tid = tgUserId || (user && await resolveTgApiIdForUser(user));
  const { presence } = tid
    ? await syncLivePresenceForUser(env, user, tid)
    : { presence: [] };

  // Presence for every community, kept separate from what we actually display.
  const presenceById = new Map(presence.map(p => [p.id, p.inGroup]));

  const byId = new Map();
  // Only seed communities the user is CONFIRMED to be in the Telegram group of.
  // Seeding from the full scan listed every community on the instance to every
  // user — and labelled the ones they simply had no relationship with as "banned",
  // which is both wrong and a disclosure of every community's id and name.
  for (const p of presence) {
    if (p.inGroup === true) {
      byId.set(p.id, { id: p.id, name: p.name, rank: 'in-group', inGroup: true });
    }
  }

  // Overlay DB memberships / creator
  if (user?.id) {
    try {
      const { results } = await env.DB.prepare(
        `SELECT c.id, c.name, m.role
         FROM community_members m
         JOIN communities c ON c.id = m.community_id
         WHERE m.user_id = ?`
      ).bind(user.id).all();
      for (const r of (results || [])) {
        // Only a definitive "not in group" demotes a member to banned. Unknown
        // (Telegram unreachable) keeps their real role rather than scaring them.
        const live = presenceById.get(r.id);
        if (live === false) {
          byId.set(r.id, { id: r.id, name: r.name, rank: 'banned', inGroup: false });
        } else {
          byId.set(r.id, { id: r.id, name: r.name, rank: r.role || 'member', inGroup: true });
        }
      }
    } catch (_) {}
    try {
      const { results } = await env.DB.prepare(
        `SELECT id, name FROM communities WHERE creator_id = ? AND id != 'default'`
      ).bind(user.id).all();
      for (const r of (results || [])) {
        const live = presenceById.get(r.id);
        if (live === false) {
          byId.set(r.id, { id: r.id, name: r.name, rank: 'banned', inGroup: false });
        } else {
          byId.set(r.id, { id: r.id, name: r.name, rank: 'owner', inGroup: true });
        }
      }
    } catch (_) {}
  }

  // DB bans for communities not already listed
  await ensureBanTable(env);
  try {
    const banRows = [];
    if (user?.id) {
      const { results } = await env.DB.prepare(
        `SELECT b.community_id, c.name FROM community_bans b
         INNER JOIN communities c ON c.id = b.community_id WHERE b.user_id = ?`
      ).bind(user.id).all();
      for (const r of (results || [])) banRows.push(r);
    }
    if (tid) {
      const { results } = await env.DB.prepare(
        `SELECT b.community_id, c.name FROM community_bans b
         INNER JOIN communities c ON c.id = b.community_id
         WHERE b.platform = 'telegram' AND b.platform_user_id = ?`
      ).bind(String(tid)).all();
      for (const r of (results || [])) banRows.push(r);
    }
    for (const b of banRows) {
      if (!b.community_id) continue;
      const cur = byId.get(b.community_id);
      if (cur && cur.inGroup) continue; // live in group wins (already unbanned)
      byId.set(b.community_id, {
        id: b.community_id,
        name: b.name || b.community_id,
        rank: 'banned',
        inGroup: false
      });
    }
  } catch (_) {}

  return [...byId.values()];
}

function bannedFromCommunityBotMsg(communityId, communityName) {
  const label = communityName
    ? (communityName + ' | ' + (communityId || ''))
    : (communityId || 'this community');
  return [
    '🚫 You are banned from this community.',
    label,
    '',
    'You left or were removed from its Telegram group.',
    'You cannot dump/search/join THIS community until you rejoin.',
    '',
    'Other communities you still belong to are unaffected.',
    'After rejoin: /community_join ' + (communityId || '<id>')
  ].join('\n');
}

const BANNED_SITE_MSG = 'You are not in any community Telegram group (or banned from all). Join at least one community group, then login and /community_join <id>.';

async function destroyUserSessions(env, userId) {
  if (!userId) return;
  try {
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
  } catch (_) {}
}

/** Live getChatMember: if not in linked group → ban (GOD exempt). */
async function enforceGroupPresenceOrBan(env, communityId, tgUserId, athenaUser) {
  if (!communityId || !tgUserId) return { banned: false, inGroup: true };
  if (isGodTgId(tgUserId, env) || (athenaUser && await isGodUserAsync(athenaUser, env))) {
    return { banned: false, inGroup: true };
  }
  let inGroup;
  try {
    inGroup = await isTelegramUserInCommunityGroup(env, communityId, tgUserId);
  } catch (_) {
    inGroup = PRESENCE_UNKNOWN;
  }
  if (inGroup === PRESENCE_UNKNOWN) {
    // Unproven — leave ban state exactly as it is.
    return { banned: false, inGroup: true, unknown: true };
  }
  if (inGroup === true) {
    // still in group → clear the automatic presence ban (moderator bans persist)
    await unbanUserFromCommunity(env, communityId, {
      platform: 'telegram',
      platformUserId: tgUserId,
      userId: athenaUser?.id || null,
      onlyPresenceBans: true
    });
    return { banned: false, inGroup: true };
  }
  await banUserFromCommunity(env, communityId, {
    platform: 'telegram',
    platformUserId: tgUserId,
    userId: athenaUser?.id || null,
    reason: 'not_in_telegram_group'
  });
  return { banned: true, inGroup: false };
}

async function resolveTgUserByUsernameOrId(env, query) {
  const q = String(query || '').trim().replace(/^@/, '');
  if (!q) return null;
  if (/^\d{5,15}$/.test(q)) {
    let u = await env.DB.prepare(
      `SELECT * FROM users WHERE provider = 'telegram' AND (provider_id = ? OR telegram_api_id = ?)`
    ).bind(q, q).first();
    if (u) return u;
    return { id: null, telegram_api_id: q, username: q, provider: 'telegram', provider_id: q, _synthetic: true };
  }
  const u = await env.DB.prepare(
    `SELECT * FROM users WHERE provider = 'telegram' AND lower(username) = lower(?)`
  ).bind(q).first();
  return u || null;
}

async function clearCommunityLinksOnly(env, communityId) {
  if (!communityId || communityId === 'default') return { ok: false, error: 'Cannot clear this community' };
  const c = await env.DB.prepare('SELECT id, name FROM communities WHERE id = ?').bind(communityId).first();
  if (!c) return { ok: false, error: 'Community not found' };
  const { results: linkRows } = await env.DB.prepare('SELECT id FROM links WHERE community_id = ?').bind(communityId).all();
  for (const row of (linkRows || [])) {
    try { await env.DB.prepare('DELETE FROM link_votes WHERE link_id = ?').bind(row.id).run(); } catch (_) {}
    try { await env.DB.prepare('DELETE FROM link_reports WHERE link_id = ?').bind(row.id).run(); } catch (_) {}
  }
  try { await env.DB.prepare('DELETE FROM links WHERE community_id = ?').bind(communityId).run(); } catch (_) {}
  try { await env.DB.prepare('DELETE FROM telegram_pending WHERE community_id = ?').bind(communityId).run(); } catch (_) {}
  // Only the ACTIVE store is cleared. In GitHub mode that means the Markdown
  // too; the parked Cloudflare copy is deliberately left alone, and vice versa.
  await clearActiveStoreFolder(env, 'community', communityId);
  return { ok: true, name: c.name, id: c.id, cleared: (linkRows || []).length };
}


/**
 * Reasons written by the automatic Telegram-presence sync. Only these may be lifted
 * automatically when a user is seen back in the group; a moderator's ban must survive
 * the fact that the user is still sitting in the Telegram group.
 */
const PRESENCE_BAN_REASONS = ['not_in_telegram_group', 'tg_kicked', 'tg_left', 'tg_banned'];

async function unbanUserFromCommunity(env, communityId, { platform, platformUserId, userId = null, onlyPresenceBans = false } = {}) {
  await ensureBanTable(env);
  const reasonFilter = onlyPresenceBans
    ? ` AND reason IN (${PRESENCE_BAN_REASONS.map(() => '?').join(',')})`
    : '';
  const extra = onlyPresenceBans ? PRESENCE_BAN_REASONS : [];
  try {
    await env.DB.prepare(
      `DELETE FROM community_bans WHERE community_id = ? AND platform = ? AND platform_user_id = ?${reasonFilter}`
    ).bind(communityId, platform, String(platformUserId), ...extra).run();
  } catch (_) {}
  if (userId) {
    try {
      await env.DB.prepare(
        `DELETE FROM community_bans WHERE community_id = ? AND user_id = ?${reasonFilter}`
      ).bind(communityId, userId, ...extra).run();
    } catch (_) {}
  }
}

/** If user is not in linked TG group → ban + strip membership. If in group → clear ban. */
async function syncCommunityGroupPresence(env, communityId, user) {
  if (!communityId || !user) return { ok: true, inGroup: true };
  const tgId = await resolveTgApiIdForUser(user);
  if (!tgId) return { ok: true, inGroup: true }; // can't check yet
  let inGroup;
  try {
    inGroup = await isTelegramUserInCommunityGroup(env, communityId, tgId);
  } catch (_) {
    inGroup = PRESENCE_UNKNOWN;
  }
  if (inGroup === PRESENCE_UNKNOWN) {
    // Telegram unreachable — do not ban, do not unban, do not block. Fall back to
    // whatever ban state is already recorded (the caller still checks that).
    return { ok: true, inGroup: true, unknown: true };
  }
  if (inGroup === false) {
    await banUserFromCommunity(env, communityId, {
      platform: 'telegram',
      platformUserId: tgId,
      userId: user.id,
      reason: 'not_in_telegram_group'
    });
    return { ok: false, inGroup: false };
  }
  // Confirmed back in the group → lift only the automatic presence ban.
  await unbanUserFromCommunity(env, communityId, {
    platform: 'telegram',
    platformUserId: tgId,
    userId: user.id,
    onlyPresenceBans: true
  });
  return { ok: true, inGroup: true };
}

/**
 * After login wipe, bot still has group→community bindings but users lost membership.
 * Instance owners re-claim all non-default communities + bot bindings so site == bot.
 */
async function syncInstanceOwnerCommunities(user, env) {
  if (!user?.id) return;
  await ensureCommunityMembersColumns(env);
  await ensureBotBindingColumns(env);

  const { results: communities } = await env.DB.prepare(
    `SELECT id, creator_id FROM communities WHERE id != 'default'`
  ).all();

  for (const c of (communities || [])) {
    // Re-attach owner membership so website listCommunities sees it
    await upsertCommunityMember(env, c.id, user.id, 'owner');
    // Reclaim creator if it was system / orphan after wipe
    if (!c.creator_id || c.creator_id === 'system') {
      try {
        await env.DB.prepare(
          'UPDATE communities SET creator_id = ? WHERE id = ?'
        ).bind(user.id, c.id).run();
      } catch (_) {}
    }
  }

  // Point community bot bindings at this owner (so bot + site share ownership)
  try {
    await env.DB.prepare(
      `UPDATE community_bots
       SET created_by = ?, user_id = ?
       WHERE platform = 'telegram'
         AND community_id IS NOT NULL
         AND community_id != ''
         AND (created_by = 'system' OR created_by IS NULL OR user_id = 'system' OR user_id IS NULL)`
    ).bind(user.id, user.id).run();
  } catch (_) {}

  // Also claim any personal bot row that has no owner / system owner if this user is TG owner by api id
  if (user.telegram_api_id) {
    try {
      await env.DB.prepare(
        `UPDATE community_bots
         SET created_by = ?, user_id = ?
         WHERE platform = 'telegram'
           AND group_id = ?
           AND COALESCE(scope, 'personal') = 'personal'`
      ).bind(user.id, user.id, String(user.telegram_api_id)).run();
    } catch (_) {}
  }
}

function isInstanceOwnerTgId(tgUserId, env) {
  if (!tgUserId) return false;
  if (!ownerListsConfigured(env)) return true;
  return parseIdList(env.TG_OWNER_IDS).includes(String(tgUserId));
}

/**
 * Third presence state: "Telegram did not tell us". Distinct from false ("Telegram
 * said this user is not in the group"). Only a definitive false may trigger a ban —
 * treating unknown as false turns any Telegram outage, rate limit, or rotated bot
 * token into a mass ban of the entire member base.
 */
const PRESENCE_UNKNOWN = 'unknown';

/** true | false | PRESENCE_UNKNOWN — is this Telegram user currently in the linked group? */
async function isTelegramUserInCommunityGroup(env, communityId, tgUserId) {
  if (!communityId || !tgUserId) return false;
  // Prefer real group chat ids (negative); ignore personal DM bindings (positive user ids)
  let bot = await env.DB.prepare(
    `SELECT group_id, bot_token FROM community_bots
     WHERE community_id = ? AND platform = 'telegram' AND group_id IS NOT NULL
       AND CAST(group_id AS TEXT) LIKE '-%'
     ORDER BY created_at DESC LIMIT 1`
  ).bind(communityId).first();
  if (!bot?.group_id) {
    bot = await env.DB.prepare(
      `SELECT group_id, bot_token FROM community_bots
       WHERE community_id = ? AND platform = 'telegram' AND group_id IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`
    ).bind(communityId).first();
  }
  if (!bot?.group_id) {
    // No group linked — allow join by id only (web-only communities)
    return true;
  }
  // Personal DM id is not a community group
  if (!String(bot.group_id).startsWith('-')) {
    return false;
  }
  const token = (await decryptBotToken(env, bot.bot_token)) || env.TELEGRAM_BOT_TOKEN;
  if (!token) return PRESENCE_UNKNOWN;
  let data;
  try {
    data = await telegramApi(token, 'getChatMember', {
      chat_id: bot.group_id,
      user_id: Number(tgUserId) || tgUserId
    });
  } catch (_) {
    // Network/DNS/TLS failure — we learned nothing about this user.
    return PRESENCE_UNKNOWN;
  }
  if (!data || !data.ok) {
    const desc = String(data?.description || '').toLowerCase();
    // Only a definitive "this user is not in this chat" may cost someone their access.
    if (desc.includes('user not found') || desc.includes('participant')) {
      return false;
    }
    // Everything else (429 rate limit, 5xx, "chat not found", "Unauthorized",
    // "bot was kicked", unparseable body) is an infrastructure problem, NOT evidence
    // about the user. Failing closed here mass-bans real members. See PRESENCE_UNKNOWN.
    return PRESENCE_UNKNOWN;
  }
  const st = data.result?.status || '';
  if (['left', 'kicked'].includes(st)) return false;
  if (['creator', 'administrator', 'member', 'restricted'].includes(st)) return true;
  return PRESENCE_UNKNOWN;
}

async function resolveTgApiIdForUser(user) {
  if (!user) return null;
  if (user.telegram_api_id && isLikelyTelegramBotApiId(user.telegram_api_id)) {
    return String(user.telegram_api_id);
  }
  // Bot API ids are short numerics; OIDC sub is often a huge number — never pass sub to getChatMember
  if (user.provider === 'telegram' && isLikelyTelegramBotApiId(user.provider_id)) {
    return String(user.provider_id);
  }
  return null;
}

function publicUser(user, flags = null) {
  if (!user) return null;
  const god = !!flags?.god;
  const elevated = !!flags?.elevated;
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name || user.username,
    avatarUrl: user.avatar_url || null,
    provider: user.provider,
    providerId: user.provider_id || null,
    telegramApiId: user.telegram_api_id || null,
    is_god: god,
    is_elevated: elevated,
    can_ai_config: god
  };
}

function deny(corsHeaders, msg, code = 'FORBIDDEN', status = 403) {
  return Response.json({ success: false, error: msg, code }, { status, headers: corsHeaders });
}

async function ensureBanTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS community_bans (
      community_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      platform_user_id TEXT NOT NULL,
      user_id TEXT,
      reason TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (community_id, platform, platform_user_id)
    )`
  ).run();
}

async function ensurePendingDeletesTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS pending_community_deletes (
      token TEXT PRIMARY KEY,
      community_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      chat_id TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`
  ).run();
}

async function isBannedFromCommunity(env, communityId, user) {
  if (!communityId || !user) return false;
  // GOD is the instance host — never bannable from their own instance.
  if (await isGodUserAsync(user, env)) return false;
  await ensureBanTable(env);
  // Live TG presence can lift an automatic presence ban, but never a moderator ban.
  const tgId = user.telegram_api_id
    || (user.provider === 'telegram' && isLikelyTelegramBotApiId(user.provider_id) ? user.provider_id : null);
  if (tgId) {
    try {
      const inGroup = await isTelegramUserInCommunityGroup(env, communityId, tgId);
      if (inGroup === true) {
        await unbanUserFromCommunity(env, communityId, {
          platform: 'telegram',
          platformUserId: String(tgId),
          userId: user.id || null,
          onlyPresenceBans: true
        });
        // fall through to the ban lookup: a moderator ban may still stand
      }
    } catch (_) {}
  }
  if (user.id) {
    const byUser = await env.DB.prepare(
      'SELECT 1 FROM community_bans WHERE community_id = ? AND user_id = ?'
    ).bind(communityId, user.id).first();
    if (byUser) return true;
  }
  if (user.provider && user.provider_id) {
    const byPid = await env.DB.prepare(
      'SELECT 1 FROM community_bans WHERE community_id = ? AND platform = ? AND platform_user_id = ?'
    ).bind(communityId, user.provider, String(user.provider_id)).first();
    if (byPid) return true;
  }
  if (user.telegram_api_id) {
    const byApi = await env.DB.prepare(
      `SELECT 1 FROM community_bans WHERE community_id = ? AND platform = 'telegram' AND platform_user_id = ?`
    ).bind(communityId, String(user.telegram_api_id)).first();
    if (byApi) return true;
  }
  return false;
}

async function banUserFromCommunity(env, communityId, { platform, platformUserId, userId = null, reason = '' }) {
  await ensureBanTable(env);
  if (isGodTgId(platformUserId, env)) return; // never ban the instance host
  let uid = userId || null;
  if (!uid) {
    const u = await env.DB.prepare(
      `SELECT id FROM users WHERE provider = ? AND (provider_id = ? OR telegram_api_id = ?)`
    ).bind(platform, String(platformUserId), String(platformUserId)).first();
    if (u) uid = u.id;
  }
  if (uid) {
    const target = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(uid).first();
    if (target && await isGodUserAsync(target, env)) return;
  }
  await env.DB.prepare(
    `INSERT OR REPLACE INTO community_bans (community_id, platform, platform_user_id, user_id, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(communityId, platform, String(platformUserId), uid, reason || 'banned', Date.now()).run();
  // NOTE: the membership row is deliberately preserved. Deleting it made every ban
  // irreversible (unban never restored it) and silently destroyed owner/admin roles,
  // so a brief Telegram hiccup permanently demoted staff. Access is gated on the ban
  // row itself, which unbanUserFromCommunity can undo.
  if (uid) {
    // Kill website sessions immediately so the ban takes effect at once.
    await destroyUserSessions(env, uid);
  }
}

async function handleWipePersonalAccount(request, user, env, corsHeaders) {
  if (!user?.id) {
    return deny(corsHeaders, 'Login required', 'AUTH_REQUIRED', 401);
  }
  if (!(await isGodUserAsync(user, env))) {
    return deny(corsHeaders, 'Wipe personal is for GOD rank only', 'GOD_ONLY');
  }
  const body = await request.json().catch(() => ({}));
  if (body.confirm !== 'WIPE_PERSONAL' || body.confirm2 !== 'DELETE_MY_DATA') {
    return deny(corsHeaders,
      'Double confirmation required: { "confirm": "WIPE_PERSONAL", "confirm2": "DELETE_MY_DATA" }',
      'CONFIRM_REQUIRED', 400);
  }
  const uid = user.id;
  try {
    await env.DB.prepare('DELETE FROM personal_links WHERE user_id = ?').bind(uid).run();
  } catch (_) {}
  try {
    await ensureDocumentsTable(env);
    await clearActiveDocumentFolder(env, 'personal', uid);
    await env.DB.prepare("DELETE FROM uploaded_documents WHERE scope = 'personal' AND user_id = ?").bind(uid).run();
  } catch (_) {}
  try {
    await env.DB.prepare('DELETE FROM user_ai_config WHERE user_id = ?').bind(uid).run();
  } catch (_) {}
  try {
    await env.DB.prepare('DELETE FROM notifications WHERE user_id = ?').bind(uid).run();
  } catch (_) {}
  try {
    await env.DB.prepare(
      `DELETE FROM community_bots WHERE (created_by = ? OR user_id = ?) AND COALESCE(scope,'personal') = 'personal'`
    ).bind(uid, uid).run();
  } catch (_) {}
  try {
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(uid).run();
  } catch (_) {}
  // keep user row so OAuth identity remains; strip personal data only
  return Response.json({ success: true, wiped: true }, { headers: corsHeaders });
}

function getBearerToken(request) {
  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/(?:^|;\s*)athena_session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

async function requireUser(request, env) {
  const token = getBearerToken(request);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ?`
  ).bind(token, Date.now()).first();
  return row || null;
}

async function destroySession(request, env) {
  const token = getBearerToken(request);
  if (token) {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
  }
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function createSession(userId, env) {
  const token = randomToken();
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'
  ).bind(token, userId, now + SESSION_TTL_MS, now).run();
  return token;
}

/** HttpOnly+Secure session cookie. Secure is skipped on plain-http origins so
 *  local dev / self-host behind a proxy still works; SameSite=Lax everywhere. */
function sessionCookieHeader(url, token, cookieMaxAge) {
  const proto = String(url?.protocol || 'https:').toLowerCase();
  const secure = proto === 'https:' ? '; Secure' : '';
  return `athena_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${cookieMaxAge}${secure}`;
}

/**
 * One-time cookie that binds an OAuth flow to the browser that started it.
 * A stored `oauth_states` row alone proves only that *some* browser started a
 * login here — an attacker can mint one, complete the provider step with their
 * own account and force the resulting code+state onto a victim (login CSRF).
 * The callback additionally requires this cookie to match.
 */
const OAUTH_STATE_COOKIE = 'athena_oauth_state';

function oauthStateCookie(url, state, maxAgeSec = 1800) {
  const secure = String(url?.protocol || 'https:').toLowerCase() === 'https:' ? '; Secure' : '';
  return `${OAUTH_STATE_COOKIE}=${state ? encodeURIComponent(state) : ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${state ? maxAgeSec : 0}${secure}`;
}

function readOauthStateCookie(request) {
  const cookie = request?.headers?.get('Cookie') || '';
  const m = cookie.match(/(?:^|;\s*)athena_oauth_state=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Response.redirect() cannot carry Set-Cookie, so build the 302 by hand. */
function redirectWithCookie(location, cookie) {
  const headers = { Location: location };
  if (cookie) headers['Set-Cookie'] = cookie;
  return new Response(null, { status: 302, headers });
}

async function allocateUniqueUsername(env, preferred, providerId) {
  const base = String(preferred || 'user')
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40) || 'user';
  const tryNames = [
    base,
    `${base}_${String(providerId).slice(-6)}`,
    `${base}_${String(providerId).slice(-10)}`,
    `${base}_${Date.now().toString(36)}`,
    `u_${randomToken().slice(0, 12)}`
  ];
  for (const name of tryNames) {
    const hit = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(name).first();
    if (!hit) return name;
  }
  return `u_${randomToken().slice(0, 16)}`;
}

async function upsertOAuthUser({ provider, providerId, username, displayName, avatarUrl }, env) {
  const pid = String(providerId);
  let existing = await env.DB.prepare(
    'SELECT * FROM users WHERE provider = ? AND provider_id = ?'
  ).bind(provider, pid).first();

  // Same physical Telegram account can get different OIDC subs across clients — prefer stable row by id
  if (!existing) {
    const byId = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(`${provider}_${pid}`).first();
    if (byId) existing = byId;
  }

  if (existing) {
    // Never fail login on username UNIQUE: keep current username if preferred is taken
    let nextUser = existing.username;
    const want = String(username || '').trim();
    if (want && want !== existing.username) {
      const taken = await env.DB.prepare(
        'SELECT id FROM users WHERE username = ? AND id != ?'
      ).bind(want, existing.id).first();
      if (!taken) nextUser = want;
    }
    try {
      await env.DB.prepare(
        'UPDATE users SET username = ?, display_name = ?, avatar_url = ? WHERE id = ?'
      ).bind(nextUser, displayName || nextUser, avatarUrl || null, existing.id).run();
    } catch (_) {
      // username race — update display only
      await env.DB.prepare(
        'UPDATE users SET display_name = ?, avatar_url = ? WHERE id = ?'
      ).bind(displayName || existing.display_name, avatarUrl || null, existing.id).run();
      nextUser = existing.username;
    }
    return {
      ...existing,
      username: nextUser,
      display_name: displayName || nextUser,
      avatar_url: avatarUrl || existing.avatar_url || null
    };
  }

  const id = `${provider}_${pid}`;
  const now = Date.now();
  const safeUser = await allocateUniqueUsername(env, username || `${provider}_${pid.slice(-8)}`, pid);
  try {
    await env.DB.prepare(
      `INSERT INTO users (id, username, password_hash, display_name, avatar_url, provider, provider_id, created_at)
       VALUES (?, ?, 'oauth', ?, ?, ?, ?, ?)`
    ).bind(id, safeUser, displayName || safeUser, avatarUrl || null, provider, pid, now).run();
  } catch {
    // Concurrent insert or leftover id — re-fetch
    const again = await env.DB.prepare(
      'SELECT * FROM users WHERE provider = ? AND provider_id = ?'
    ).bind(provider, pid).first();
    if (again) return again;
    const byId = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    if (byId) return byId;
    // Last resort: force unique username
    const force = await allocateUniqueUsername(env, `u_${pid.slice(-8)}`, pid + Date.now());
    await env.DB.prepare(
      `INSERT INTO users (id, username, password_hash, display_name, avatar_url, provider, provider_id, created_at)
       VALUES (?, ?, 'oauth', ?, ?, ?, ?, ?)`
    ).bind(id + '_' + force.slice(-4), force, displayName || force, avatarUrl || null, provider, pid, now).run();
    return await env.DB.prepare('SELECT * FROM users WHERE provider = ? AND provider_id = ?').bind(provider, pid).first();
  }
  return await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
}

function handleAuthConfig(env, corsHeaders) {
  return Response.json({
    success: true,
    telegramEnabled: !!(env.TELEGRAM_CLIENT_ID && env.TELEGRAM_CLIENT_SECRET),
    discordEnabled: !!(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET)
  }, { headers: corsHeaders });
}

function base64UrlEncode(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecodeToBytes(str) {
  const pad = '='.repeat((4 - (str.length % 4)) % 4);
  const b64 = (str + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pkceChallengeS256(verifier) {
  const dig = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(dig);
}

async function ensureOAuthStatesTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      code_verifier TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )`
  ).run();
  // Drop expired rows so table stays small
  try {
    await env.DB.prepare('DELETE FROM oauth_states WHERE expires_at < ?').bind(Date.now()).run();
  } catch (_) {}
}

/** Telegram OpenID Connect — authorize (code + PKCE). */
/** Telegram Mini App initData login (HMAC with bot token). */
function hexFromBuffer(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256(keyBytes, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    typeof keyBytes === 'string' ? enc.encode(keyBytes) : keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const msg = typeof message === 'string' ? enc.encode(message) : message;
  return await crypto.subtle.sign('HMAC', key, msg);
}

/**
 * Validate Telegram initData.
 *
 * Two things vary in the wild and both have to be tolerated, or logins fail with
 * a bogus "invalid signature":
 *
 *  - `signature` (Bot API 7.10+) is present for third-party Ed25519 validation.
 *    Telegram clients differ on whether it belongs in the HMAC data-check-string,
 *    so both orderings are tried. Each is still a full HMAC against the bot
 *    token, so accepting either does not weaken the check.
 *  - Mini App uses secret = HMAC("WebAppData", token); the older Login Widget
 *    uses secret = SHA256(token).
 */
async function verifyTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;

  const build = (dropSignature) => {
    const p = new URLSearchParams(initData);
    p.delete('hash');
    if (dropSignature) p.delete('signature');
    return [...p.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
  };

  const enc = new TextEncoder();
  const webAppSecret = await hmacSha256('WebAppData', botToken);
  const widgetSecret = await crypto.subtle.digest('SHA-256', enc.encode(botToken));

  for (const dropSignature of [true, false]) {
    const dcs = build(dropSignature);
    for (const secret of [webAppSecret, widgetSecret]) {
      const calc = hexFromBuffer(await hmacSha256(secret, dcs));
      if (calc === hash) {
        const out = new URLSearchParams(initData);
        out.delete('hash');
        return { ok: true, params: out };
      }
    }
  }
  return null;
}

async function handleTelegramWebAppAuth(request, env, corsHeaders, url) {
  try {
    const body = await request.json().catch(() => ({}));
    const initData = body.initData || body.init_data || '';
    if (!initData) {
      return Response.json({
        success: false,
        error: 'initData required — open Athena as a Telegram Mini App, or use Continue with Telegram'
      }, { status: 400, headers: corsHeaders });
    }
    let botToken = env.TELEGRAM_BOT_TOKEN || null;
    if (!botToken) {
      try {
        const row = await env.DB.prepare(
          `SELECT bot_token FROM community_bots WHERE platform = 'telegram' AND bot_token IS NOT NULL AND bot_token != ''
           ORDER BY created_at DESC LIMIT 1`
        ).first();
        botToken = row?.bot_token ? await decryptBotToken(env, row.bot_token) : null;
      } catch (_) {}
    }
    if (!botToken) {
      return Response.json({
        success: false,
        error: 'TELEGRAM_BOT_TOKEN missing (GOD: Settings → Bot, or wrangler secret put TELEGRAM_BOT_TOKEN)'
      }, { status: 503, headers: corsHeaders });
    }
    const verified = await verifyTelegramInitData(initData, botToken);
    if (!verified) {
      return Response.json({
        success: false,
        error: 'Invalid Telegram signature (bot token must match the Mini App bot)'
      }, { status: 401, headers: corsHeaders });
    }
    const params = verified.params;
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    if (authDate && (Date.now() / 1000 - authDate) > 86400 * 2) {
      return Response.json({ success: false, error: 'Telegram login expired — reopen the Mini App' }, { status: 401, headers: corsHeaders });
    }
    let tgUser = {};
    try { tgUser = JSON.parse(params.get('user') || '{}'); } catch (_) { tgUser = {}; }
    const tgId = String(tgUser.id || params.get('id') || '');
    if (!tgId) {
      return Response.json({ success: false, error: 'No Telegram user in initData' }, { status: 400, headers: corsHeaders });
    }
    const username = tgUser.username || params.get('username') || (`tg_${tgId}`);
    const displayName = [tgUser.first_name || params.get('first_name'), tgUser.last_name || params.get('last_name')]
      .filter(Boolean).join(' ') || username;
    const avatarUrl = tgUser.photo_url || params.get('photo_url') || null;
    // Telegram gives two different identifiers for the same human: the OIDC
    // `sub` in the browser flow and the Bot API id here. Keying purely on
    // provider_id therefore created a SECOND account for the same person, and
    // their personal links, memberships and bans split across the two. Adopt an
    // existing row that already carries this Bot API id before creating one.
    let user = null;
    try {
      user = await env.DB.prepare(
        `SELECT * FROM users
         WHERE provider = 'telegram' AND (provider_id = ? OR telegram_api_id = ?)
         ORDER BY CASE WHEN telegram_api_id = ? THEN 0 ELSE 1 END, created_at ASC
         LIMIT 1`
      ).bind(tgId, tgId, tgId).first();
    } catch (_) {}

    if (!user) {
      user = await upsertOAuthUser({
        provider: 'telegram',
        providerId: tgId,
        username,
        displayName,
        avatarUrl
      }, env);
    }
    try {
      await env.DB.prepare('UPDATE users SET telegram_api_id = ? WHERE id = ?').bind(tgId, user.id).run();
      user.telegram_api_id = tgId;
    } catch (_) {}
    if (await isUserFullySiteBanned(env, user)) {
      await destroyUserSessions(env, user.id);
      return Response.json({ success: false, error: BANNED_SITE_MSG, code: 'SITE_BANNED' }, { status: 403, headers: corsHeaders });
    }
    const sessionToken = await createSession(user.id, env);
     // Notify GOD rank about website login (Telegram + website notification)
     try {
       const ownerIds = parseIdList(env.TG_OWNER_IDS || '');
       const loginLabel = user.username ? `@${user.username}` : (user.display_name || user.id);
       const loginTgId = user.telegram_api_id || '';
       const loginMsg = `🌐 ${loginLabel}${loginTgId ? ` | ${loginTgId}` : ''} logged in to website`;
       // Website notification for GOD users
       const { results: godUsers } = await env.DB.prepare(
         `SELECT id FROM users WHERE telegram_api_id IN (${ownerIds.map(() => '?').join(',') || "''"})`
       ).bind(...ownerIds.map(String)).all().catch(() => ({ results: [] }));
       for (const god of (godUsers || [])) {
         await createNotification(env, { userId: god.id, type: 'login', title: 'Website Login', body: loginMsg }).catch(() => {});
       }
       // Telegram notification: send to log channel if set, otherwise to GOD DMs
       const logChannelId = await getLogChannelId(env, godUsers?.[0]?.id);
       const notifyText = `🌐 ${boldHtml(loginLabel)}${loginTgId ? ` | ${codeHtml(String(loginTgId))}` : ''} logged in to website`;
       if (logChannelId && env.TELEGRAM_BOT_TOKEN) {
         await sendTelegramFormatted(env.TELEGRAM_BOT_TOKEN, logChannelId, notifyText).catch(() => {});
       } else {
         for (const ownerId of ownerIds) {
           if (ownerId && env.TELEGRAM_BOT_TOKEN) {
             await sendTelegramFormatted(env.TELEGRAM_BOT_TOKEN, ownerId, notifyText).catch(() => {});
           }
         }
       }
     } catch (_) {}
     const owner = await isInstanceOwnerUserAsync(user, env);
    const elevated = owner || (await isElevatedUser(user, env));
    const cookieMaxAge = Math.floor(SESSION_TTL_MS / 1000);
    return Response.json({
      success: true,
      session: sessionToken,
      user: publicUser(user, { god: owner, elevated })
    }, { headers: { ...corsHeaders, 'Set-Cookie': sessionCookieHeader(url, sessionToken, cookieMaxAge) } });
  } catch (err) {
    console.error('webapp auth', err);
    return Response.json({ success: false, error: err.message || 'WebApp login failed' }, { status: 500, headers: corsHeaders });
  }
}


/**
 * The redirect_uri handed to Telegram.
 *
 * Telegram only accepts a redirect on the ONE domain registered for the bot via
 * BotFather. A self-hosted backend on a different hostname is rejected with the
 * confusing "redirect_uri required". Rather than force a choice between the two
 * deployments, point the redirect at the registered domain and let that origin
 * relay the callback back here — see the relay in handleTelegramCallback.
 */
function telegramRedirectUri(env, url) {
  const base = String(env.TELEGRAM_OAUTH_REDIRECT_BASE || '').trim().replace(/\/+$/, '');
  return `${base || url.origin}/api/auth/telegram/callback`;
}

async function handleTelegramStart(url, env, corsHeaders) {
  const clientId = env.TELEGRAM_CLIENT_ID;
  if (!clientId || !env.TELEGRAM_CLIENT_SECRET) {
    return Response.json({ success: false, error: 'Telegram OIDC not configured' }, { status: 503, headers: corsHeaders });
  }

  await ensureOAuthStatesTable(env);
  const state = randomToken().slice(0, 32);
  const codeVerifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const codeChallenge = await pkceChallengeS256(codeVerifier);
  // 30 min window — Telegram login UI can sit open a while
  const expires = Date.now() + 30 * 60 * 1000;
  try {
    await env.DB.prepare(
      'INSERT OR REPLACE INTO oauth_states (state, code_verifier, expires_at) VALUES (?, ?, ?)'
    ).bind(state, codeVerifier, expires).run();
  } catch (e) {
    console.error('oauth_states insert failed', e);
    return Response.redirect(`${frontendOrigin(env, url)}/?auth_error=telegram_state_store`, 302);
  }
  // Verify write is readable (guards rare D1 write issues)
  const check = await env.DB.prepare(
    'SELECT state FROM oauth_states WHERE state = ?'
  ).bind(state).first();
  if (!check) {
    return Response.redirect(`${frontendOrigin(env, url)}/?auth_error=telegram_state_store`, 302);
  }

  const redirectUri = telegramRedirectUri(env, url);
  const authUrl = new URL('https://oauth.telegram.org/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid profile');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  return redirectWithCookie(authUrl.toString(), oauthStateCookie(url, state));
}

function decodeJwtPayload(jwt) {
  const parts = String(jwt || '').split('.');
  if (parts.length < 2) return null;
  try {
    const json = new TextDecoder().decode(base64UrlDecodeToBytes(parts[1]));
    return JSON.parse(json);
  } catch (_) {
    return null;
  }
}

async function verifyTelegramIdToken(idToken, clientId) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  let header;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecodeToBytes(headerB64)));
  } catch (_) {
    return null;
  }
  if (header.alg !== 'RS256') return null;

  const jwksRes = await fetch('https://oauth.telegram.org/.well-known/jwks.json');
  const jwks = await jwksRes.json();
  const jwk = (jwks.keys || []).find(k => k.kid === header.kid) || (jwks.keys || [])[0];
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = base64UrlDecodeToBytes(sigB64);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
  if (!ok) return null;

  const claims = decodeJwtPayload(idToken);
  if (!claims) return null;
  if (claims.iss !== 'https://oauth.telegram.org') return null;
  if (String(claims.aud) !== String(clientId) && !(Array.isArray(claims.aud) && claims.aud.map(String).includes(String(clientId)))) {
    return null;
  }
  if (!claims.exp || claims.exp * 1000 < Date.now() - 30_000) return null;
  return claims;
}

/** Telegram OIDC callback: code → tokens → session. */
async function handleTelegramCallback(url, env, corsHeaders, request) {
  const code = url.searchParams.get('code');
  // Telegram may return state with extra encoding; normalize
  let state = url.searchParams.get('state');
  if (state) {
    try { state = decodeURIComponent(state).trim(); } catch (_) { state = String(state).trim(); }
  }
  const err = url.searchParams.get('error');
  if (err) {
    return Response.redirect(`${frontendOrigin(env, url)}/?auth_error=telegram_${encodeURIComponent(err)}`, 302);
  }
  if (!code || !state) {
    return Response.redirect(`${frontendOrigin(env, url)}/?auth_error=telegram_missing`, 302);
  }
  if (!env.TELEGRAM_CLIENT_ID || !env.TELEGRAM_CLIENT_SECRET) {
    return Response.redirect(`${frontendOrigin(env, url)}/?auth_error=telegram_config`, 302);
  }

  await ensureOAuthStatesTable(env);
  // Read state first — do NOT delete until login succeeds (avoids double-callback / retry → telegram_state)
  let row = await env.DB.prepare(
    'SELECT code_verifier, expires_at FROM oauth_states WHERE state = ?'
  ).bind(state).first();
  if (!row) {
    // one retry after brief pause in case of write lag (rare)
    await new Promise(r => setTimeout(r, 150));
    row = await env.DB.prepare(
      'SELECT code_verifier, expires_at FROM oauth_states WHERE state = ?'
    ).bind(state).first();
  }
  if (!row) {
    // Unknown state: this login was started by a different backend that had to
    // borrow this domain's registered redirect_uri. Hand the code over to it.
    // The target is a fixed config value, never taken from the query string —
    // otherwise this would be an open redirect leaking authorization codes.
    const relayBase = String(env.OAUTH_RELAY_BACKEND || '').trim().replace(/\/+$/, '');
    if (relayBase) {
      const onward = new URL(`${relayBase}/api/auth/telegram/callback`);
      onward.searchParams.set('code', code);
      onward.searchParams.set('state', state);
      return Response.redirect(onward.toString(), 302);
    }
    return Response.redirect(`${frontendOrigin(env, url)}/?auth_error=telegram_state`, 302);
  }
  const exp = Number(row.expires_at);
  if (!exp || exp < Date.now()) {
    try {
      await env.DB.prepare('DELETE FROM oauth_states WHERE state = ?').bind(state).run();
    } catch (_) {}
    return Response.redirect(`${frontendOrigin(env, url)}/?auth_error=telegram_state_expired`, 302);
  }
  // Bind the flow to the browser that started it. Skipped only when the
  // registered redirect_uri lives on another origin — there the start cookie was
  // set elsewhere and cannot be presented here; that topology relays above.
  const ownRedirect = telegramRedirectUri(env, url).startsWith(`${url.origin}/`);
  if (ownRedirect && readOauthStateCookie(request) !== state) {
    return redirectWithCookie(`${frontendOrigin(env, url)}/?auth_error=telegram_state`, oauthStateCookie(url, ''));
  }

  const redirectUri = telegramRedirectUri(env, url);
  const basic = btoa(`${env.TELEGRAM_CLIENT_ID}:${env.TELEGRAM_CLIENT_SECRET}`);
  const tokenRes = await fetch('https://oauth.telegram.org/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: env.TELEGRAM_CLIENT_ID,
      code_verifier: row.code_verifier
    })
  });
  const tokens = await tokenRes.json().catch(() => ({}));
  if (!tokens.id_token) {
    // Keep state so a single UI retry within TTL can still work if Telegram reuses nothing;
    // usually user must click Login again for a fresh code.
    console.error('telegram token exchange failed', tokenRes.status, tokens);
    return Response.redirect(`${frontendOrigin(env, url)}/?auth_error=telegram_token`, 302);
  }

  const claims = await verifyTelegramIdToken(tokens.id_token, env.TELEGRAM_CLIENT_ID);
  if (!claims) {
    return Response.redirect(`${frontendOrigin(env, url)}/?auth_error=telegram_jwt`, 302);
  }

  const providerId = String(claims.sub || claims.id || '');
  if (!providerId) {
    return Response.redirect(`${frontendOrigin(env, url)}/?auth_error=telegram_user`, 302);
  }
  const username = claims.preferred_username || claims.username || `tg_${providerId}`;
  const displayName = claims.name || [claims.given_name, claims.family_name].filter(Boolean).join(' ') || username;
  const avatarUrl = claims.picture || claims.photo_url || null;
  // Prefer real Telegram user id for TG_OWNER_IDS matching
  let telegramApiId = null;
  for (const key of ['id', 'user_id', 'telegram_id', 'tg_id']) {
    const v = claims[key];
    if (v != null && isLikelyTelegramBotApiId(v)) {
      telegramApiId = String(v);
      break;
    }
  }
  if (!telegramApiId && isLikelyTelegramBotApiId(providerId)) telegramApiId = providerId;

  let user = await upsertOAuthUser({
    provider: 'telegram',
    providerId,
    username,
    displayName,
    avatarUrl
  }, env);

  if (user && telegramApiId) {
    try {
      await env.DB.prepare('UPDATE users SET telegram_api_id = ? WHERE id = ?')
        .bind(telegramApiId, user.id).run();
      user.telegram_api_id = telegramApiId;
    } catch (_) {}
  }

  // Fully banned only if no remaining unbanned memberships
  if (await isUserFullySiteBanned(env, user)) {
    try {
      await env.DB.prepare('DELETE FROM oauth_states WHERE state = ?').bind(state).run();
    } catch (_) {}
    await destroyUserSessions(env, user.id);
    return Response.redirect(`${frontendOrigin(env, url)}/?auth_error=banned`, 302);
  }

   const sessionToken = await createSession(user.id, env);
   // Notify GOD rank about website login (Telegram OAuth + website notification)
   try {
     const ownerIds = parseIdList(env.TG_OWNER_IDS || '');
     const loginLabel = user.username ? `@${user.username}` : (user.display_name || user.id);
     const loginTgId = user.telegram_api_id || telegramApiId || '';
     const loginMsg = `🌐 ${loginLabel}${loginTgId ? ` | ${loginTgId}` : ''} logged in to website (Telegram)`;
     // Website notification for GOD users
     const { results: godUsers } = await env.DB.prepare(
       `SELECT id FROM users WHERE telegram_api_id IN (${ownerIds.map(() => '?').join(',') || "''"})`
     ).bind(...ownerIds.map(String)).all().catch(() => ({ results: [] }));
     for (const god of (godUsers || [])) {
       await createNotification(env, { userId: god.id, type: 'login', title: 'Website Login', body: loginMsg }).catch(() => {});
     }
     // Telegram notification: send to log channel if set, otherwise to GOD DMs
     const logChannelId = await getLogChannelId(env, godUsers?.[0]?.id);
     const notifyText = `🌐 ${boldHtml(loginLabel)}${loginTgId ? ` | ${codeHtml(String(loginTgId))}` : ''} logged in to website (Telegram)`;
     if (logChannelId && env.TELEGRAM_BOT_TOKEN) {
       await sendTelegramFormatted(env.TELEGRAM_BOT_TOKEN, logChannelId, notifyText).catch(() => {});
     } else {
       for (const ownerId of ownerIds) {
         if (ownerId && env.TELEGRAM_BOT_TOKEN) {
           await sendTelegramFormatted(env.TELEGRAM_BOT_TOKEN, ownerId, notifyText).catch(() => {});
         }
       }
     }
   } catch (_) {}
   // Consume state only after success
  try {
    await env.DB.prepare('DELETE FROM oauth_states WHERE state = ?').bind(state).run();
  } catch (_) {}
  const cookieMaxAge = Math.floor(SESSION_TTL_MS / 1000);
  // The session token must reach terminal clients too — the TUI cannot read the
  // HttpOnly cookie, so the token always rides in the query string (cookie kept
  // for the website UX). Referer leakage is covered by Referrer-Policy; the
  // token expires after SESSION_TTL_MS anyway.
  const redirectUrl = `${frontendOrigin(env, url)}/?session=${encodeURIComponent(sessionToken)}`;
  const headers = new Headers(corsHeaders);
  headers.set('Location', redirectUrl);
  headers.append('Set-Cookie', sessionCookieHeader(url, sessionToken, cookieMaxAge));
  headers.append('Set-Cookie', oauthStateCookie(url, ''));
  return new Response(null, { status: 302, headers });
}

async function handleDiscordStart(url, env, corsHeaders) {
  if (!env.DISCORD_CLIENT_ID) {
    return Response.json({ success: false, error: 'Discord OAuth not configured' }, { status: 503, headers: corsHeaders });
  }
  const redirectUri = `${url.origin}/api/auth/discord/callback`;
  const state = randomToken().slice(0, 16);
  // Persist the state so the callback can reject logins that never started here
  // (login CSRF: an attacker's own ?code= forced onto a victim's browser would
  // otherwise mint a session for the attacker's account). Mirror the Telegram
  // flow: store + verify + consume.
  await ensureOAuthStatesTable(env);
  const expires = Date.now() + 30 * 60 * 1000;
  try {
    await env.DB.prepare(
      'INSERT OR REPLACE INTO oauth_states (state, code_verifier, expires_at) VALUES (?, ?, ?)'
    ).bind(state, '', expires).run();
  } catch (e) {
    console.error('oauth_states insert failed (discord)', e);
    return Response.redirect(`${frontendOrigin(env, url)}/?auth_error=discord_state_store`, 302);
  }
  const authUrl = new URL('https://discord.com/api/oauth2/authorize');
  authUrl.searchParams.set('client_id', env.DISCORD_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'identify');
  authUrl.searchParams.set('state', state);

  return redirectWithCookie(authUrl.toString(), oauthStateCookie(url, state));
}

async function handleDiscordCallback(url, env, request) {
  const code = url.searchParams.get('code');
  const state = (url.searchParams.get('state') || '').trim();
  const clearState = oauthStateCookie(url, '');
  if (!code || !env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) {
    return Response.redirect(`${frontendOrigin(env, url)}/?auth_error=discord`, 302);
  }
  if (!state) {
    return Response.redirect(`${frontendOrigin(env, url)}/?auth_error=discord_state`, 302);
  }
  // redirect_uri is always this origin, so the start cookie is always presented.
  if (readOauthStateCookie(request) !== state) {
    return redirectWithCookie(`${frontendOrigin(env, url)}/?auth_error=discord_state`, clearState);
  }

  await ensureOAuthStatesTable(env);
  const row = await env.DB.prepare(
    'SELECT expires_at FROM oauth_states WHERE state = ?'
  ).bind(state).first();
  if (!row || !Number(row.expires_at) || Number(row.expires_at) < Date.now()) {
    // Consume unknown/expired states so a replayed ?code= cannot be retried.
    if (row) {
      try { await env.DB.prepare('DELETE FROM oauth_states WHERE state = ?').bind(state).run(); } catch (_) {}
    }
    return redirectWithCookie(`${frontendOrigin(env, url)}/?auth_error=discord_state`, clearState);
  }

  const redirectUri = `${url.origin}/api/auth/discord/callback`;
  const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri
    })
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    return Response.redirect(`${frontendOrigin(env, url)}/?auth_error=discord_token`, 302);
  }

  const meRes = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` }
  });
  const me = await meRes.json();
  if (!me.id) {
    return Response.redirect(`${frontendOrigin(env, url)}/?auth_error=discord_user`, 302);
  }

  const username = me.username || `discord_${me.id}`;
  const displayName = me.global_name || username;
  const avatarUrl = me.avatar
    ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png`
    : null;

  const user = await upsertOAuthUser({
    provider: 'discord',
    providerId: me.id,
    username,
    displayName,
    avatarUrl
  }, env);

  if (await isUserFullySiteBanned(env, user)) {
    await destroyUserSessions(env, user.id);
    return Response.redirect(`${frontendOrigin(env, url)}/?auth_error=banned`, 302);
  }

   const sessionToken = await createSession(user.id, env);
   // Notify GOD rank about website login (Discord + website notification)
   try {
     const ownerIds = parseIdList(env.TG_OWNER_IDS || '');
     const loginLabel = user.username ? `@${user.username}` : (user.display_name || user.id);
     const loginMsg = `🌐 ${loginLabel} logged in to website (Discord)`;
     // Website notification for GOD users
     const { results: godUsers } = await env.DB.prepare(
       `SELECT id FROM users WHERE telegram_api_id IN (${ownerIds.map(() => '?').join(',') || "''"})`
     ).bind(...ownerIds.map(String)).all().catch(() => ({ results: [] }));
     for (const god of (godUsers || [])) {
       await createNotification(env, { userId: god.id, type: 'login', title: 'Website Login', body: loginMsg }).catch(() => {});
     }
     // Telegram notification: send to log channel if set, otherwise to GOD DMs
     const logChannelId = await getLogChannelId(env, godUsers?.[0]?.id);
     const notifyText = `🌐 ${boldHtml(loginLabel)} logged in to website (Discord)`;
     if (logChannelId && env.TELEGRAM_BOT_TOKEN) {
       await sendTelegramFormatted(env.TELEGRAM_BOT_TOKEN, logChannelId, notifyText).catch(() => {});
     } else {
       for (const ownerId of ownerIds) {
         if (ownerId && env.TELEGRAM_BOT_TOKEN) {
           await sendTelegramFormatted(env.TELEGRAM_BOT_TOKEN, ownerId, notifyText).catch(() => {});
         }
       }
     }
   } catch (_) {}
   // Consume the state on success (single-use).
   try { await env.DB.prepare('DELETE FROM oauth_states WHERE state = ?').bind(state).run(); } catch (_) {}
   const sameOrigin = frontendOrigin(env, url) === url.origin;
   const redirectUrl = sameOrigin
     ? `${frontendOrigin(env, url)}/`
     : `${frontendOrigin(env, url)}/?session=${encodeURIComponent(sessionToken)}`;
   return new Response(null, {
     status: 302,
     headers: [
       ['Location', redirectUrl],
       ['Set-Cookie', sessionCookieHeader(url, sessionToken, Math.floor(SESSION_TTL_MS / 1000))],
       ['Set-Cookie', clearState]
     ]
   });
}

// ============================================================
// Communities + bots
// ============================================================

/**
 * Membership + not-banned, the standard gate for acting inside a community.
 * Bans no longer delete the membership row, so every route that used to rely on
 * `ensureMember` alone must also consult the ban table.
 * Returns null when allowed, or a ready-to-return error Response.
 */
async function requireActiveMember(env, communityId, user, corsHeaders) {
  if (!communityId || !user?.id) {
    return Response.json({ success: false, error: 'Forbidden' }, { status: 403, headers: corsHeaders });
  }
  if (await isBannedFromCommunity(env, communityId, user)) {
    return deny(corsHeaders, 'You are banned from this community', 'BANNED');
  }
  if (!(await ensureMember(communityId, user.id, env))) {
    return Response.json({ success: false, error: 'Forbidden' }, { status: 403, headers: corsHeaders });
  }
  return null;
}

async function ensureMember(communityId, userId, env) {
  const m = await env.DB.prepare(
    'SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?'
  ).bind(communityId, userId).first();
  return !!m;
}

async function handleListCommunities(user, env, corsHeaders) {
  await ensureBotBindingColumns(env);
  await ensureCommunityMembersColumns(env);
  if (await isInstanceOwnerUserAsync(user, env)) {
    try { await syncInstanceOwnerCommunities(user, env); } catch (_) {}
  }
  let results;
  try {
    const r = await env.DB.prepare(
      `SELECT c.*, m.role AS member_role
       FROM communities c
       INNER JOIN community_members m ON m.community_id = c.id
       WHERE m.user_id = ?
       ORDER BY c.created_at DESC`
    ).bind(user.id).all();
    results = r.results || [];
  } catch (_) {
    // role column missing — fall back
    const r = await env.DB.prepare(
      `SELECT c.* FROM communities c
       INNER JOIN community_members m ON m.community_id = c.id
       WHERE m.user_id = ?
       ORDER BY c.created_at DESC`
    ).bind(user.id).all();
    results = (r.results || []).map(c => ({ ...c, member_role: c.creator_id === user.id ? 'owner' : 'member' }));
  }
  // Also include communities created by user without member row
  const owned = await env.DB.prepare(
    `SELECT * FROM communities WHERE creator_id = ? ORDER BY created_at DESC`
  ).bind(user.id).all();
  for (const c of (owned.results || [])) {
    if (!results.find(x => x.id === c.id)) {
      results.push({ ...c, member_role: 'owner' });
    }
  }
  const communities = [];
  for (const c of results) {
    const role = c.member_role || (c.creator_id === user.id ? 'owner' : 'member');
    const isStaff = role === 'owner' || role === 'admin' || c.creator_id === user.id;
    const bot = await env.DB.prepare(
      `SELECT group_id, group_name, bot_username, topic_id, platform
       FROM community_bots WHERE community_id = ? AND COALESCE(scope,'community') = 'community'
       ORDER BY created_at DESC LIMIT 1`
    ).bind(c.id).first();
    const linkCount = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM links WHERE community_id = ?'
    ).bind(c.id).first();
    const adminCount = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM community_admins WHERE community_id = ?'
    ).bind(c.id).first();
    communities.push({
      ...c,
      role,
      is_staff: !!isStaff,
      group_id: bot?.group_id || null,
      group_name: bot?.group_name || null,
      bot_username: bot?.bot_username || null,
      topic_id: bot?.topic_id || null,
      platform: bot?.platform || null,
      link_count: linkCount?.n || 0,
      admin_count: adminCount?.n || 0
    });
  }
  return Response.json({ success: true, communities }, { headers: corsHeaders });
}

async function handleCreateCommunity(request, user, env, corsHeaders) {
  if (!(await isInstanceOwnerUserAsync(user, env))) {
    return deny(corsHeaders, 'Only instance owners create communities (use /community_verify in Telegram)', 'OWNER_ONLY');
  }
  const body = await request.json().catch(() => ({}));
  const name = (body.name || '').trim();
  if (!name) {
    return Response.json({ success: false, error: 'Name required' }, { status: 400, headers: corsHeaders });
  }
  if (name.length > 80) {
    return Response.json({ success: false, error: 'Name too long (max 80)' }, { status: 400, headers: corsHeaders });
  }
  const id = 'c_' + Date.now().toString(36) + '_' + randomToken().slice(0, 4);
  const now = Date.now();
  try {
    await ensureCommunityMembersColumns(env);
    await env.DB.prepare(
      'INSERT INTO communities (id, name, creator_id, created_at) VALUES (?, ?, ?, ?)'
    ).bind(id, name, user.id, now).run();
    await upsertCommunityMember(env, id, user.id, 'owner');
  } catch (err) {
    return Response.json({ success: false, error: err.message || 'Failed to create community' }, { status: 500, headers: corsHeaders });
  }
  return Response.json({
    success: true,
    community: { id, name, creator_id: user.id, created_at: now, role: 'owner', is_staff: true }
  }, { headers: corsHeaders });
}

async function handleCommunityInfo(url, user, env, corsHeaders) {
  const id = (url.searchParams.get('id') || '').trim();
  if (!id) {
    return Response.json({ success: false, error: 'id required' }, { status: 400, headers: corsHeaders });
  }
  const c = await env.DB.prepare(
    'SELECT id, name, creator_id, created_at FROM communities WHERE id = ?'
  ).bind(id).first();
  if (!c) {
    return Response.json({ success: false, error: 'Community not found' }, { status: 404, headers: corsHeaders });
  }
  const member = await env.DB.prepare(
    'SELECT role FROM community_members WHERE community_id = ? AND user_id = ?'
  ).bind(id, user.id).first();
  return Response.json({
    success: true,
    community: {
      id: c.id,
      name: c.name,
      created_at: c.created_at,
      is_member: !!member,
      role: member?.role || null
    }
  }, { headers: corsHeaders });
}

async function handleJoinCommunity(request, user, env, corsHeaders) {
  const body = await request.json().catch(() => ({}));
  const communityId = (body.community_id || body.id || '').trim();
  if (!communityId) {
    return Response.json({ success: false, error: 'community_id required' }, { status: 400, headers: corsHeaders });
  }
  const c = await env.DB.prepare(
    'SELECT id, name, creator_id, created_at FROM communities WHERE id = ?'
  ).bind(communityId).first();
  if (!c) {
    return Response.json({ success: false, error: 'Community not found (invalid invite)' }, { status: 404, headers: corsHeaders });
  }
  if (await isBannedFromCommunity(env, communityId, user)) {
    return deny(corsHeaders, 'You are banned from this community', 'BANNED');
  }
  // Must be in the Telegram group linked to this community (members; owners skip)
  if (!(await isInstanceOwnerUserAsync(user, env)) && c.creator_id !== user.id) {
    const tgId = await resolveTgApiIdForUser(user);
    if (!tgId) {
      return deny(corsHeaders,
        'Open the Athena bot in Telegram and send /start once (links your Telegram user id), join the community group, then /community_join again',
        'NEED_TG_API_ID');
    }
    const inGroup = await isTelegramUserInCommunityGroup(env, communityId, tgId);
    if (!inGroup) {
      return deny(corsHeaders, 'First join the Telegram group for this community, then /community_join again', 'NOT_IN_GROUP');
    }
  }
  await ensureCommunityMembersColumns(env);
  let existing;
  try {
    existing = await env.DB.prepare(
      'SELECT user_id, role FROM community_members WHERE community_id = ? AND user_id = ?'
    ).bind(communityId, user.id).first();
  } catch (_) {
    existing = await env.DB.prepare(
      'SELECT user_id FROM community_members WHERE community_id = ? AND user_id = ?'
    ).bind(communityId, user.id).first();
  }
  if (existing) {
    const role = existing.role || 'member';
    return Response.json({
      success: true,
      already_member: true,
      community: { ...c, role, is_staff: role === 'owner' || role === 'admin' || c.creator_id === user.id }
    }, { headers: corsHeaders });
  }
   const role = c.creator_id === user.id ? 'owner' : 'member';
   await upsertCommunityMember(env, communityId, user.id, role);
   // Notify GOD rank about new member joining via website
   try {
     const ownerIds = parseIdList(env.TG_OWNER_IDS || '');
     const joinerLabel = user.username ? `@${user.username}` : (user.display_name || user.id);
     const joinerTgId = user.telegram_api_id || '';
     const notifyMsg = `👤 ${joinerLabel}${joinerTgId ? ` | ${joinerTgId}` : ''} joined ${c.name} community`;
     // Website notification for GOD users
     const { results: godUsers } = await env.DB.prepare(
       `SELECT id FROM users WHERE telegram_api_id IN (${ownerIds.map(() => '?').join(',') || "''"})`
     ).bind(...ownerIds.map(String)).all().catch(() => ({ results: [] }));
     for (const god of (godUsers || [])) {
       await createNotification(env, { userId: god.id, type: 'community_join', title: 'New Community Member', body: notifyMsg }).catch(() => {});
     }
     // Telegram notification: send to log channel if set, otherwise to GOD DMs
     const logChannelId = await getLogChannelId(env, godUsers?.[0]?.id);
     const notifyText = `👤 ${boldHtml(joinerLabel)}${joinerTgId ? ` | ${codeHtml(String(joinerTgId))}` : ''} joined ${boldHtml(c.name)} community`;
     if (logChannelId && env.TELEGRAM_BOT_TOKEN) {
       await sendTelegramFormatted(env.TELEGRAM_BOT_TOKEN, logChannelId, notifyText).catch(() => {});
     } else {
       for (const ownerId of ownerIds) {
         if (ownerId && env.TELEGRAM_BOT_TOKEN) {
           await sendTelegramFormatted(env.TELEGRAM_BOT_TOKEN, ownerId, notifyText).catch(() => {});
         }
       }
     }
   } catch (_) {}
   return Response.json({
     success: true,
     already_member: false,
     community: { ...c, role, is_staff: role === 'owner' }
   }, { headers: corsHeaders });
  }

async function ensureBotBindingColumns(env) {
  try {
    await env.DB.prepare(`ALTER TABLE community_bots ADD COLUMN scope TEXT DEFAULT 'community'`).run();
  } catch (_) {}
  try {
    await env.DB.prepare(`ALTER TABLE community_bots ADD COLUMN user_id TEXT`).run();
  } catch (_) {}
  try {
    await env.DB.prepare(`ALTER TABLE community_bots ADD COLUMN bot_token TEXT`).run();
  } catch (_) {}
  try {
    await env.DB.prepare(`ALTER TABLE community_bots ADD COLUMN dump_link_mode TEXT DEFAULT 'smart'`).run();
  } catch (_) {}
  try {
    await env.DB.prepare(`ALTER TABLE community_bots ADD COLUMN topic_id TEXT`).run();
  } catch (_) {}
  try {
    await env.DB.prepare(`ALTER TABLE community_bots ADD COLUMN log_channel_id TEXT`).run();
  } catch (_) {}
}

/** Live D1 may predate role column — migrate safely. */
async function ensureCommunityMembersColumns(env) {
  try {
    await env.DB.prepare(
      `ALTER TABLE community_members ADD COLUMN role TEXT DEFAULT 'member'`
    ).run();
  } catch (_) {}
  // users.telegram_api_id bridges OIDC sub vs Bot API numeric id
  try {
    await env.DB.prepare(`ALTER TABLE users ADD COLUMN telegram_api_id TEXT`).run();
  } catch (_) {}
}

async function upsertCommunityMember(env, communityId, userId, role = 'member') {
  await ensureCommunityMembersColumns(env);
  const existing = await env.DB.prepare(
    'SELECT user_id FROM community_members WHERE community_id = ? AND user_id = ?'
  ).bind(communityId, userId).first();
  if (existing) {
    try {
      await env.DB.prepare(
        'UPDATE community_members SET role = ? WHERE community_id = ? AND user_id = ?'
      ).bind(role, communityId, userId).run();
    } catch (_) {}
    return;
  }
  try {
    await env.DB.prepare(
      'INSERT INTO community_members (community_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
    ).bind(communityId, userId, role, Date.now()).run();
  } catch (_) {
    // column role missing mid-flight — insert without role
    await env.DB.prepare(
      'INSERT INTO community_members (community_id, user_id, joined_at) VALUES (?, ?, ?)'
    ).bind(communityId, userId, Date.now()).run();
  }
}

async function telegramApi(token, method, payload = null) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const opts = payload
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
    : { method: 'GET' };
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  return data;
}

async function verifyTelegramBotToken(token, expectedUsername) {
  const data = await telegramApi(token, 'getMe');
  if (!data.ok || !data.result?.username) {
    return { ok: false, error: data.description || 'Invalid bot token (getMe failed)' };
  }
  const uname = String(data.result.username).replace(/^@/, '').toLowerCase();
  if (expectedUsername) {
    const want = String(expectedUsername).replace(/^@/, '').toLowerCase();
    if (uname !== want) {
      return {
        ok: false,
        error: `Token belongs to @${uname}, not @${want}`
      };
    }
  }
  return {
    ok: true,
    bot: {
      id: String(data.result.id),
      username: data.result.username,
      first_name: data.result.first_name
    }
  };
}

async function ensureTelegramWebhook(token, workerOrigin, env) {
  const hook = `${workerOrigin.replace(/\/$/, '')}/api/telegram-webhook`;
  const payload = {
    url: hook,
    allowed_updates: ['message', 'edited_message', 'channel_post', 'callback_query', 'chat_member', 'my_chat_member']
  };
  const secret = env ? await webhookSecret(env) : null;
  if (secret) payload.secret_token = secret;
  const data = await telegramApi(token, 'setWebhook', payload);
  return { ok: !!data.ok, description: data.description || '', url: hook, signed: !!secret, raw: data };
}

async function handleListBotBindings(url, user, env, corsHeaders) {
  await ensureBotBindingColumns(env);
  const communityId = url.searchParams.get('community_id');
  const scopeFilter = url.searchParams.get('scope'); // personal | community | all
  const isGod = await isGodUserAsync(user, env);

  let results;
  if (communityId) {
    if (!(await ensureMember(communityId, user.id, env)) && !isGod) {
      return Response.json({ success: false, error: 'Not a member of this community' }, { status: 403, headers: corsHeaders });
    }
    const r = await env.DB.prepare(
      `SELECT id, community_id, platform, bot_username, group_id, group_name, created_by, created_at,
              COALESCE(scope, 'community') AS scope, user_id, bot_token
       FROM community_bots WHERE community_id = ?`
    ).bind(communityId).all();
    results = r.results || [];
  } else if (isGod) {
    const r = await env.DB.prepare(
      `SELECT id, community_id, platform, bot_username, group_id, group_name, created_by, created_at,
              COALESCE(scope, 'community') AS scope, user_id, bot_token
       FROM community_bots
       WHERE created_by = ? OR user_id = ?
       ORDER BY created_at DESC`
    ).bind(user.id, user.id).all();
    results = r.results || [];
  } else {
    // Non-GOD: read-only view of instance personal bot(s) + communities they belong to
    const r = await env.DB.prepare(
      `SELECT id, community_id, platform, bot_username, group_id, group_name, created_by, created_at,
              COALESCE(scope, 'community') AS scope, user_id, bot_token
       FROM community_bots
       WHERE COALESCE(scope, 'personal') = 'personal'
          OR community_id IN (SELECT community_id FROM community_members WHERE user_id = ?)
       ORDER BY created_at DESC`
    ).bind(user.id).all();
    results = r.results || [];
  }

  if (scopeFilter === 'personal' || scopeFilter === 'community') {
    results = results.filter(b => (b.scope || 'community') === scopeFilter);
  }

  const safe = results.map(b => {
    const { bot_token, ...rest } = b;
    return { ...rest, has_token: !!(bot_token) };
  });

  return Response.json({ success: true, bots: safe, read_only: !isGod }, { headers: corsHeaders });
}

async function handleUpsertBotBinding(request, user, env, corsHeaders) {
  await ensureBotBindingColumns(env);
  const body = await request.json();
  // Website only registers personal bot; communities are created via /community_verify in Telegram groups
  const scope = 'personal';
  const communityId = null;
  const platform = (body.platform || 'telegram').trim().toLowerCase();
  let botUsername = (body.bot_username || '').replace(/^@/, '').trim();
  const groupId = String(body.group_id || '').trim();
  const groupName = (body.group_name || '').trim() || null;
  const botToken = (body.bot_token || body.token || '').trim() || null;
  const origin = new URL(request.url).origin;

  if (!platform || !groupId) {
    return Response.json(
      { success: false, error: 'platform and chat id required (open bot DM → /id)' },
      { status: 400, headers: corsHeaders }
    );
  }
  if (!['telegram', 'discord'].includes(platform)) {
    return Response.json({ success: false, error: 'platform must be telegram or discord' }, { status: 400, headers: corsHeaders });
  }

  let webhook = null;
  let verifiedBot = null;

  // Telegram: require token for verification (or use platform secret if username matches env bot)
  if (platform === 'telegram') {
    const tokenToUse = botToken || env.TELEGRAM_BOT_TOKEN || null;
    if (!tokenToUse) {
      return Response.json({
        success: false,
        error: 'Bot token required. Paste the HTTP API token from @BotFather (looks like 123456:ABC…).'
      }, { status: 400, headers: corsHeaders });
    }

    const verified = await verifyTelegramBotToken(tokenToUse, botUsername || null);
    if (!verified.ok) {
      return Response.json({ success: false, error: verified.error }, { status: 400, headers: corsHeaders });
    }
    verifiedBot = verified.bot;
    botUsername = verified.bot.username;

    // Point this bot's webhook at Athena so /start works
    webhook = await ensureTelegramWebhook(tokenToUse, origin, env);

    // Probe: send a confirmation message to the personal chat
    const probe = await sendTelegramMessage(tokenToUse, groupId,
      'Athena personal bot linked.\n\n• Paste links here → personal brain\n• Add this bot to a Telegram group → send /community_verify (bot owner only) to create a community\n• /community_list · /help');
    if (!probe.ok) {
      return Response.json({
        success: false,
        error: `Token OK (@${botUsername}) but cannot message chat ${groupId}: ${probe.error || 'send failed'}. Open a private chat with the bot, press Start, then use /id and paste that Chat ID.`,
        bot: verifiedBot,
        webhook
      }, { status: 400, headers: corsHeaders });
    }
  } else if (!botUsername) {
    return Response.json({ success: false, error: 'bot_username required' }, { status: 400, headers: corsHeaders });
  }

  const storeToken = platform === 'telegram' ? (botToken || env.TELEGRAM_BOT_TOKEN || null) : botToken;

  const existing = await env.DB.prepare(
    'SELECT id, bot_token FROM community_bots WHERE platform = ? AND group_id = ?'
  ).bind(platform, groupId).first();

  if (existing) {
    await env.DB.prepare(
      `UPDATE community_bots SET community_id = ?, bot_username = ?, group_name = ?, created_by = ?,
        scope = ?, user_id = ?, bot_token = COALESCE(?, bot_token) WHERE id = ?`
    ).bind(
      scope === 'community' ? communityId : null,
      botUsername,
      groupName,
      user.id,
      scope,
      user.id,
      storeToken ? await encryptSecret(env, storeToken) : null,
      existing.id
    ).run();
    return Response.json({
      success: true,
      id: existing.id,
      updated: true,
      scope,
      bot: verifiedBot,
      webhook,
      message: 'Bot linked and verified'
    }, { headers: corsHeaders });
  }

  const id = 'bot_' + Date.now().toString(36);
  await env.DB.prepare(
    `INSERT INTO community_bots (id, community_id, platform, bot_username, group_id, group_name, created_by, created_at, scope, user_id, bot_token)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    scope === 'community' ? communityId : null,
    platform,
    botUsername,
    groupId,
    groupName,
    user.id,
    Date.now(),
    scope,
    user.id,
    storeToken ? await encryptSecret(env, storeToken) : null
  ).run();

  return Response.json({
    success: true,
    id,
    updated: false,
    scope,
    bot: verifiedBot,
    webhook,
    message: 'Bot linked and verified'
  }, { headers: corsHeaders });
}

/** Switch binding dump target: personal ↔ community (same bot/group). */
async function handleSwitchBotScope(request, user, env, corsHeaders) {
  await ensureBotBindingColumns(env);
  const body = await request.json();
  const id = body.id;
  const scope = (body.scope || '').toLowerCase();
  const communityId = (body.community_id || '').trim() || null;

  if (!id || !['personal', 'community'].includes(scope)) {
    return Response.json({ success: false, error: 'id and scope (personal|community) required' }, { status: 400, headers: corsHeaders });
  }
  const row = await env.DB.prepare('SELECT * FROM community_bots WHERE id = ?').bind(id).first();
  if (!row) {
    return Response.json({ success: false, error: 'Not found' }, { status: 404, headers: corsHeaders });
  }
  if (row.created_by !== user.id && row.user_id !== user.id) {
    return Response.json({ success: false, error: 'Forbidden' }, { status: 403, headers: corsHeaders });
  }
  if (scope === 'community') {
    if (!communityId) {
      return Response.json({ success: false, error: 'community_id required when switching to community' }, { status: 400, headers: corsHeaders });
    }
    if (!(await ensureMember(communityId, user.id, env))) {
      return Response.json({ success: false, error: 'Not a member of this community' }, { status: 403, headers: corsHeaders });
    }
  }

  await env.DB.prepare(
    `UPDATE community_bots SET scope = ?, community_id = ?, user_id = ? WHERE id = ?`
  ).bind(scope, scope === 'community' ? communityId : null, user.id, id).run();

  return Response.json({ success: true, id, scope, community_id: scope === 'community' ? communityId : null }, { headers: corsHeaders });
}

async function handleDeleteCommunityBot(request, user, env, corsHeaders) {
  const body = await request.json();
  const id = body.id;
  if (!id) {
    return Response.json({ success: false, error: 'id required' }, { status: 400, headers: corsHeaders });
  }
  const row = await env.DB.prepare('SELECT * FROM community_bots WHERE id = ?').bind(id).first();
  if (!row) {
    return Response.json({ success: false, error: 'Not found' }, { status: 404, headers: corsHeaders });
  }
  const ok =
    row.created_by === user.id ||
    row.user_id === user.id ||
    (row.community_id && (await ensureMember(row.community_id, user.id, env)));
  if (!ok) {
    return Response.json({ success: false, error: 'Forbidden' }, { status: 403, headers: corsHeaders });
  }
  await env.DB.prepare('DELETE FROM community_bots WHERE id = ?').bind(id).run();
  return Response.json({ success: true }, { headers: corsHeaders });
}

// ============================================================
// Community Links
// ============================================================

async function ensureOwnerOrAdmin(communityId, userId, env) {
  await ensureCommunityMembersColumns(env);
  const c = await env.DB.prepare('SELECT creator_id FROM communities WHERE id = ?').bind(communityId).first();
  if (!c) return false;
  if (c.creator_id === userId) return true;
  try {
    const m = await env.DB.prepare(
      `SELECT role FROM community_members WHERE community_id = ? AND user_id = ?`
    ).bind(communityId, userId).first();
    return m && (m.role === 'owner' || m.role === 'admin');
  } catch (_) {
    return false;
  }
}

async function createNotification(env, { userId, communityId, type, title, body, payload }) {
  const id = 'n_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  await env.DB.prepare(
    `INSERT INTO notifications (id, user_id, community_id, type, title, body, payload, read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).bind(id, userId, communityId || null, type, title, body || '', JSON.stringify(payload || {}), Date.now()).run();
  return id;
}

async function notifyCommunityStaff(env, communityId, { type, title, body, payload }) {
  const c = await env.DB.prepare('SELECT * FROM communities WHERE id = ?').bind(communityId).first();
  if (!c) return;
  const targets = new Set([c.creator_id]);
  const { results: members } = await env.DB.prepare(
    `SELECT user_id FROM community_members WHERE community_id = ? AND role IN ('owner','admin')`
  ).bind(communityId).all();
  for (const m of members || []) targets.add(m.user_id);

  for (const uid of targets) {
    await createNotification(env, { userId: uid, communityId, type, title, body, payload });
  }

  // Telegram/Discord group notify via bound bots
  const { results: bots } = await env.DB.prepare(
    'SELECT * FROM community_bots WHERE community_id = ?'
  ).bind(communityId).all();
  for (const b of bots || []) {
    if (b.platform === 'telegram' && env.TELEGRAM_BOT_TOKEN) {
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, b.group_id, `🔔 ${title}\n${body || ''}`);
    }
  }

  // Platform admin IDs (DM if telegram user id)
  const { results: admins } = await env.DB.prepare(
    'SELECT * FROM community_admins WHERE community_id = ?'
  ).bind(communityId).all();
  for (const a of admins || []) {
    if (a.platform === 'telegram' && env.TELEGRAM_BOT_TOKEN) {
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, a.platform_user_id, `🔔 ${title}\n${body || ''}`);
    }
  }
}

async function handleGetCommunityLinks(url, user, env, corsHeaders) {
  const communityId = url.searchParams.get('community_id');
  if (!communityId) {
    return Response.json({ success: false, error: 'community_id required' }, { status: 400, headers: corsHeaders });
  }
  // Sync ban with live Telegram group membership (left/kicked → ban; rejoined → unban)
  if (!(await isInstanceOwnerUserAsync(user, env))) {
    const presence = await syncCommunityGroupPresence(env, communityId, user);
    if (!presence.inGroup) {
      return deny(corsHeaders, 'You left or were removed from the Telegram group — access revoked. Rejoin the group to restore access.', 'NOT_IN_GROUP');
    }
  }
  if (await isBannedFromCommunity(env, communityId, user)) {
    return deny(corsHeaders, 'You are banned from this community', 'BANNED');
  }
  if (!(await ensureMember(communityId, user.id, env))) {
    return Response.json({ success: false, error: 'Not a member — join with /community_join ' + communityId, code: 'NOT_MEMBER' }, { status: 403, headers: corsHeaders });
  }
  await ensureFresh(env, 'community', communityId);
  await ensureLinkMetaColumns(env);
  const { results } = await env.DB.prepare(
    'SELECT * FROM links WHERE community_id = ? ORDER BY created_at DESC LIMIT 500'
  ).bind(communityId).all();
  const seen = dedupeLinkRows(results || []);
  const enrichmentPending = queueMissingLinkEnrichment(env, 'community', communityId, seen);

  // attach my vote
  const links = [];
  for (const row of seen) {
    const my = await env.DB.prepare(
      'SELECT vote FROM link_votes WHERE link_id = ? AND user_id = ?'
    ).bind(row.id, user.id).first();
    links.push({
      ...row,
      my_vote: my ? my.vote : 0,
      upvotes: row.upvotes || 0,
      downvotes: row.downvotes || 0
    });
  }
  return Response.json({ success: true, links, enrichment_pending: enrichmentPending }, { headers: corsHeaders });
}

async function handlePostCommunityLink(request, user, env, corsHeaders) {
  const body = await request.json();
  const communityId = body.community_id;
  const rawUrl = body.url;
  if (!communityId || !rawUrl) {
    return Response.json({ success: false, error: 'community_id and url required' }, { status: 400, headers: corsHeaders });
  }
  if (!(await isInstanceOwnerUserAsync(user, env))) {
    const presence = await syncCommunityGroupPresence(env, communityId, user);
    if (!presence.inGroup) {
      return deny(corsHeaders, 'You left or were removed from the Telegram group — rejoin to dump links', 'NOT_IN_GROUP');
    }
  }
  if (await isBannedFromCommunity(env, communityId, user)) {
    return deny(corsHeaders, 'You are banned from this community', 'BANNED');
  }
  if (!(await ensureMember(communityId, user.id, env))) {
    return Response.json({
      success: false,
      error: 'Join this community first: login on the website, then /community_join ' + communityId,
      code: 'NOT_MEMBER'
    }, { status: 403, headers: corsHeaders });
  }

  const urlHash = generateUrlHash(rawUrl);
  const existing = await findExistingLink(env, 'links', 'community_id', communityId, rawUrl);

  if (existing) {
    return Response.json(
      {
        success: false,
        duplicate: true,
        error: 'Website is already added',
        code: 'DUPLICATE_URL',
        existing_id: existing.id,
        existing_title: existing.title
      },
      { status: 409, headers: corsHeaders }
    );
  }

  await ensureLinkMetaColumns(env);
  const meta = await enrichLinkFields(env, rawUrl, { title: body.title, notes: body.notes });
  const id = 'link_' + Date.now().toString(36);
  const displayName = user.display_name || user.username || user.id;
  const now = Date.now();

  // Commit to GitHub first when it is the source of truth. appendLink retries on
  // conflict, which matters here: several members can dump into the same
  // community from Telegram at the same moment.
  const gh = await storeAddLink(env, 'community', communityId, {
    id, url: rawUrl, url_hash: urlHash, title: meta.title, notes: meta.notes,
    tags: body.tags || [], created_at: now, added_by_name: displayName,
    added_by_user_id: user.id, image_url: meta.image_url, site_name: meta.site_name,
  });
  if (gh.handled && !gh.ok) {
    return Response.json({ success: false, error: `GitHub write failed: ${gh.error}` }, { status: 502, headers: corsHeaders });
  }

  try {
    await env.DB.prepare(
      `INSERT INTO links (id, community_id, url, url_hash, title, notes, tags, added_by,
        added_by_user_id, added_by_provider, added_by_name, upvotes, downvotes, created_at, image_url, site_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`
    ).bind(
      id, communityId, rawUrl, urlHash, meta.title, meta.notes,
      JSON.stringify(body.tags || []), displayName, user.id, user.provider || null, displayName,
      now, meta.image_url || null, meta.site_name || null
    ).run();
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return Response.json(
        { success: false, duplicate: true, error: 'Website is already added', code: 'DUPLICATE_URL' },
        { status: 409, headers: corsHeaders }
      );
    }
    if (!isMissingLinkMetaColumnError(error)) {
      return Response.json({ success: false, error: error.message || 'Database insert failed', code: 'DB_INSERT_FAILED' }, { status: 500, headers: corsHeaders });
    }
    await env.DB.prepare(
      `INSERT INTO links (id, community_id, url, url_hash, title, notes, tags, added_by,
        added_by_user_id, added_by_provider, added_by_name, upvotes, downvotes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`
    ).bind(
      id, communityId, rawUrl, urlHash, meta.title, meta.notes,
      JSON.stringify(body.tags || []), displayName, user.id, user.provider || null, displayName, now
    ).run();
  }

  return Response.json({
    success: true,
    id,
    title: meta.title,
    notes: meta.notes,
    image_url: meta.image_url,
    site_name: meta.site_name,
    added_by_name: displayName,
    added_by_provider: user.provider || null,
    created_at: now
  }, { headers: corsHeaders });
}

async function handleDeleteCommunityLink(request, user, env, corsHeaders) {
  const body = await request.json();
  const { id, community_id: communityId, url: rawUrl } = body;

  let link = null;
  if (id) {
    link = await env.DB.prepare('SELECT * FROM links WHERE id = ?').bind(id).first();
  } else if (communityId && rawUrl) {
    link = await findExistingLink(env, 'links', 'community_id', communityId, rawUrl);
  }

  if (!link) {
    return Response.json({ success: false, error: 'Not found', not_found: true }, { status: 404, headers: corsHeaders });
  }
  const gate = await requireActiveMember(env, link.community_id, user, corsHeaders);
  if (gate) return gate;

  // Community delete mode: owner/admin only
  const isStaff = await ensureOwnerOrAdmin(link.community_id, user.id, env);
  if (!isStaff) {
    return Response.json(
      { success: false, error: 'Only community owner or admins can delete links' },
      { status: 403, headers: corsHeaders }
    );
  }

  await env.DB.prepare('DELETE FROM links WHERE id = ?').bind(link.id).run();
  await env.DB.prepare('DELETE FROM link_votes WHERE link_id = ?').bind(link.id).run();
  const gh = await storeMutateLink(env, 'community', link.community_id, link.id, null);
  if (gh.handled && !gh.ok) {
    return Response.json({ success: false, error: `GitHub write failed: ${gh.error}` }, { status: 502, headers: corsHeaders });
  }
  return Response.json({ success: true, deleted: link.id }, { headers: corsHeaders });
}

/**
 * GET /api/links/search?q=&scope=personal|community&community_id=
 * Same rank rules as everywhere else: personal is GOD-only, community requires
 * an unbanned membership. Scans the whole store, not a recency window.
 */
async function handleSearchLinks(url, user, env, corsHeaders) {
  const q = (url.searchParams.get('q') || '').trim();
  const scope = (url.searchParams.get('scope') || 'community').toLowerCase();
  if (!q) return Response.json({ success: true, links: [], query: '' }, { headers: corsHeaders });

  if (scope === 'personal') {
    if (!(await isInstanceOwnerUserAsync(user, env))) {
      return deny(corsHeaders, 'Personal mode is for GOD rank (instance host) only', 'PERSONAL_LOCKED');
    }
    await ensureFresh(env, 'personal', user.id);
    await ensureLinkMetaColumns(env);
    const rows = await candidateLinks(env, 'personal', user.id, q);
    const links = rankLinks(dedupeLinkRows(rows), q);
    const enrichmentPending = queueMissingLinkEnrichment(env, 'personal', user.id, links);
    return Response.json(
      { success: true, query: q, scope, links, enrichment_pending: enrichmentPending },
      { headers: corsHeaders }
    );
  }

  const communityId = url.searchParams.get('community_id');
  if (!communityId) {
    return Response.json({ success: false, error: 'community_id required' }, { status: 400, headers: corsHeaders });
  }
  const gate = await requireActiveMember(env, communityId, user, corsHeaders);
  if (gate) return gate;
  await ensureFresh(env, 'community', communityId);
  await ensureLinkMetaColumns(env);
  const rows = await candidateLinks(env, 'community', communityId, q);
  const links = rankLinks(dedupeLinkRows(rows), q);
  const enrichmentPending = queueMissingLinkEnrichment(env, 'community', communityId, links);
  return Response.json(
    { success: true, query: q, scope, links, enrichment_pending: enrichmentPending },
    { headers: corsHeaders }
  );
}

/** Rank candidates by how well they match, best first. */
function rankLinks(rows, query, limit = 100) {
  const q = String(query || '').toLowerCase().trim();
  const qa = q.replace(/[^a-z0-9]/g, '');
  if (!q) return rows.slice(0, limit);
  const scored = [];
  for (const r of rows) {
    const title = String(r.title || '').toLowerCase();
    const urlStr = String(r.url || '').toLowerCase();
    const bag = [r.title, r.url, r.notes, r.tags].join(' ').toLowerCase();
    const ba = bag.replace(/[^a-z0-9]/g, '');
    let score = 0;
    if (title === q) score += 100;
    if (title.startsWith(q)) score += 50;
    if (title.includes(q)) score += 30;
    if (urlStr.includes(q)) score += 20;
    if (bag.includes(q)) score += 10;
    if (qa.length >= 2 && ba.includes(qa)) score += 8;
    if (score > 0) scored.push({ r, score });
  }
  scored.sort((a, b) => b.score - a.score || (b.r.created_at || 0) - (a.r.created_at || 0));
  return scored.slice(0, limit).map(s => s.r);
}

const DOCUMENT_MAX_BYTES = 512 * 1024;
const DOCUMENT_EXTENSIONS = new Set([
  'md', 'markdown', 'txt', 'py', 'js', 'ts', 'jsx', 'tsx', 'sh', 'bash', 'zsh', 'fish',
  'css', 'html', 'htm', 'json', 'yaml', 'yml', 'toml', 'xml', 'csv', 'sql', 'go', 'rs',
  'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'php', 'swift', 'kt', 'kts', 'lua', 'r',
  'dart', 'vue', 'svelte', 'ini', 'cfg', 'conf', 'env', 'log',
]);

async function ensureDocumentsTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS uploaded_documents (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, user_id TEXT, community_id TEXT,
      filename TEXT NOT NULL, content TEXT NOT NULL, uploaded_by TEXT NOT NULL,
      github_path TEXT, created_at INTEGER NOT NULL
    )`
  ).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_documents_personal ON uploaded_documents(scope, user_id, created_at)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_documents_community ON uploaded_documents(scope, community_id, created_at)').run();
}

function documentFolder(scope, key) {
  return scope === 'personal' ? `documents/personal/${key}` : `documents/communities/${key}`;
}

function validateDocumentInput(body) {
  const scope = String(body.scope || '').toLowerCase();
  const filename = String(body.filename || '').normalize('NFC').trim();
  if (scope !== 'personal' && scope !== 'community') return { error: 'scope must be personal or community' };
  if (!filename || filename.length > 180 || filename === '.' || filename === '..' || /[\\/\x00-\x1f\x7f]/.test(filename)) {
    return { error: 'Invalid filename' };
  }
  const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
  if (!DOCUMENT_EXTENSIONS.has(ext)) return { error: 'File extension is not allowed' };
  if (typeof body.content !== 'string') return { error: 'content must be UTF-8 text' };
  const content = body.content;
  const encoded = new TextEncoder().encode(content);
  if (/\x00/.test(content) || new TextDecoder().decode(encoded) !== content) return { error: 'content must be valid UTF-8 text' };
  const bytes = encoded.length;
  if (bytes > DOCUMENT_MAX_BYTES) return { error: 'Document exceeds 512 KiB' };
  const controls = (content.match(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g) || []).length;
  if (controls / Math.max(content.length, 1) > 0.01) return { error: 'Binary or control-heavy content is not allowed' };
  return { scope, filename, content, bytes };
}

function documentAsLink(row) {
  return {
    ...row,
    type: 'document',
    title: row.filename,
    notes: row.content,
    url: null,
    tags: 'document',
  };
}

async function documentScopeGate(scope, communityId, user, env, corsHeaders) {
  if (scope === 'personal') {
    return (await isInstanceOwnerUserAsync(user, env))
      ? null
      : deny(corsHeaders, 'Personal mode is for GOD rank (instance host) only', 'PERSONAL_LOCKED');
  }
  if (!communityId) {
    return Response.json({ success: false, error: 'community_id required' }, { status: 400, headers: corsHeaders });
  }
  return requireActiveMember(env, communityId, user, corsHeaders);
}

async function handleGetDocuments(url, user, env, corsHeaders) {
  const scope = String(url.searchParams.get('scope') || 'community').toLowerCase();
  const communityId = url.searchParams.get('community_id');
  if (scope !== 'personal' && scope !== 'community') {
    return Response.json({ success: false, error: 'scope must be personal or community' }, { status: 400, headers: corsHeaders });
  }
  const gate = await documentScopeGate(scope, communityId, user, env, corsHeaders);
  if (gate) return gate;
  await ensureDocumentsTable(env);
  const query = scope === 'personal'
    ? env.DB.prepare("SELECT * FROM uploaded_documents WHERE scope = 'personal' AND user_id = ? ORDER BY created_at DESC").bind(user.id)
    : env.DB.prepare("SELECT * FROM uploaded_documents WHERE scope = 'community' AND community_id = ? ORDER BY created_at DESC").bind(communityId);
  const { results } = await query.all();
  return Response.json({ success: true, documents: results || [] }, { headers: corsHeaders });
}

async function handlePostDocument(request, user, env, corsHeaders) {
  const body = await request.json().catch(() => null);
  if (!body) return Response.json({ success: false, error: 'Invalid JSON' }, { status: 400, headers: corsHeaders });
  const doc = validateDocumentInput(body);
  if (doc.error) return Response.json({ success: false, error: doc.error }, { status: 400, headers: corsHeaders });
  const communityId = doc.scope === 'community' ? String(body.community_id || '') : null;
  const gate = await documentScopeGate(doc.scope, communityId, user, env, corsHeaders);
  if (gate) return gate;
  await ensureDocumentsTable(env);

  const id = `doc_${crypto.randomUUID()}`;
  const key = doc.scope === 'personal' ? user.id : communityId;
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_');
  const pathFilename = doc.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const githubPath = `${documentFolder(doc.scope, key)}/${safeId}--${pathFilename}`;
  const store = await githubStoreFor(env);
  if (store) {
    const written = await store.writeFile(githubPath, doc.content, { message: `athena: upload ${doc.filename}` });
    if (!written.ok) {
      return Response.json({ success: false, error: `GitHub write failed: ${written.body?.message || `HTTP ${written.status}`}` }, { status: 502, headers: corsHeaders });
    }
  }

  try {
    await env.DB.prepare(
      `INSERT INTO uploaded_documents
       (id, scope, user_id, community_id, filename, content, uploaded_by, github_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, doc.scope, doc.scope === 'personal' ? user.id : null, communityId, doc.filename,
      doc.content, user.id, store ? githubPath : null, Date.now()).run();
  } catch (err) {
    if (store) {
      const written = await store.readFile(githubPath).catch(() => null);
      if (written) await store.deleteFile(githubPath, written.sha, `athena: rollback ${doc.filename}`).catch(() => null);
    }
    throw err;
  }
  const row = await env.DB.prepare('SELECT * FROM uploaded_documents WHERE id = ?').bind(id).first();
  return Response.json({ success: true, document: row }, { status: 201, headers: corsHeaders });
}

async function handleDeleteDocument(request, user, env, corsHeaders) {
  const body = await request.json().catch(() => ({}));
  if (!body.id) return Response.json({ success: false, error: 'id required' }, { status: 400, headers: corsHeaders });
  await ensureDocumentsTable(env);
  const row = await env.DB.prepare('SELECT * FROM uploaded_documents WHERE id = ?').bind(String(body.id)).first();
  if (!row) return Response.json({ success: false, error: 'Not found' }, { status: 404, headers: corsHeaders });
  const gate = await documentScopeGate(row.scope, row.community_id, user, env, corsHeaders);
  if (gate) return gate;
  if (row.scope === 'personal' && row.user_id !== user.id) {
    return Response.json({ success: false, error: 'Not found' }, { status: 404, headers: corsHeaders });
  }
  if (row.scope === 'community' && row.uploaded_by !== user.id && !(await ensureOwnerOrAdmin(row.community_id, user.id, env))) {
    return Response.json({ success: false, error: 'Only community staff or the uploader can delete documents' }, { status: 403, headers: corsHeaders });
  }
  if (row.github_path) {
    const store = await githubStoreFor(env);
    if (store) {
      const got = await store.readFile(row.github_path).catch(() => null);
      if (got) {
        const deleted = await store.deleteFile(row.github_path, got.sha, `athena: delete ${row.filename}`);
        if (!deleted.ok) return Response.json({ success: false, error: `GitHub delete failed: ${deleted.body?.message || `HTTP ${deleted.status}`}` }, { status: 502, headers: corsHeaders });
      }
    }
  }
  await env.DB.prepare('DELETE FROM uploaded_documents WHERE id = ?').bind(row.id).run();
  return Response.json({ success: true, deleted: row.id }, { headers: corsHeaders });
}

async function handleVoteLink(request, user, env, corsHeaders) {
  const body = await request.json();
  const linkId = body.link_id;
  const vote = parseInt(body.vote, 10); // 1, -1, or 0 clear
  if (!linkId || ![-1, 0, 1].includes(vote)) {
    return Response.json({ success: false, error: 'link_id and vote (-1|0|1) required' }, { status: 400, headers: corsHeaders });
  }
  const link = await env.DB.prepare('SELECT * FROM links WHERE id = ?').bind(linkId).first();
  if (!link) {
    return Response.json({ success: false, error: 'Not found' }, { status: 404, headers: corsHeaders });
  }
  const gate = await requireActiveMember(env, link.community_id, user, corsHeaders);
  if (gate) return gate;

  const prev = await env.DB.prepare(
    'SELECT vote FROM link_votes WHERE link_id = ? AND user_id = ?'
  ).bind(linkId, user.id).first();
  const prevVote = prev ? prev.vote : 0;

  let up = link.upvotes || 0;
  let down = link.downvotes || 0;
  if (prevVote === 1) up = Math.max(0, up - 1);
  if (prevVote === -1) down = Math.max(0, down - 1);

  if (vote === 0) {
    await env.DB.prepare('DELETE FROM link_votes WHERE link_id = ? AND user_id = ?').bind(linkId, user.id).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO link_votes (link_id, user_id, vote, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(link_id, user_id) DO UPDATE SET vote = excluded.vote, created_at = excluded.created_at`
    ).bind(linkId, user.id, vote, Date.now()).run();
    if (vote === 1) up += 1;
    if (vote === -1) down += 1;
  }

  try {
    await env.DB.prepare('UPDATE links SET upvotes = ?, downvotes = ? WHERE id = ?').bind(up, down, linkId).run();
  } catch (_) { /* columns may not exist yet */ }

  return Response.json({ success: true, upvotes: up, downvotes: down, my_vote: vote }, { headers: corsHeaders });
}

async function handleReportLink(request, user, env, corsHeaders) {
  const body = await request.json();
  const linkId = body.link_id;
  const reason = (body.reason || '').trim() || 'Reported by user';
  if (!linkId) {
    return Response.json({ success: false, error: 'link_id required' }, { status: 400, headers: corsHeaders });
  }
  const link = await env.DB.prepare('SELECT * FROM links WHERE id = ?').bind(linkId).first();
  if (!link) {
    return Response.json({ success: false, error: 'Not found' }, { status: 404, headers: corsHeaders });
  }
  const gate = await requireActiveMember(env, link.community_id, user, corsHeaders);
  if (gate) return gate;

  const reportId = 'rep_' + Date.now().toString(36);
  await env.DB.prepare(
    `INSERT INTO link_reports (id, link_id, community_id, reporter_id, reason, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?)`
  ).bind(reportId, linkId, link.community_id, user.id, reason, Date.now()).run();

  const title = 'Link reported';
  const nbody = `${user.display_name || user.username} reported: ${link.title || link.url}\nReason: ${reason}`;
  await notifyCommunityStaff(env, link.community_id, {
    type: 'link_report',
    title,
    body: nbody,
    payload: {
      report_id: reportId,
      link_id: link.id,
      community_id: link.community_id,
      url: link.url,
      title: link.title,
      reason,
      can_delete: true
    }
  });

  return Response.json({ success: true, report_id: reportId }, { headers: corsHeaders });
}

async function handleListNotifications(user, env, corsHeaders) {
  try {
    const { results } = await env.DB.prepare(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
    ).bind(user.id).all();
    const list = (results || []).map(n => ({
      ...n,
      payload: (() => { try { return JSON.parse(n.payload || '{}'); } catch (_) { return {}; } })()
    }));
    const unread = list.filter(n => !n.read).length;
    return Response.json({ success: true, notifications: list, unread }, { headers: corsHeaders });
  } catch {
    return Response.json({ success: true, notifications: [], unread: 0 }, { headers: corsHeaders });
  }
}

async function handleNotificationAction(request, user, env, corsHeaders) {
  const body = await request.json();
  const { id, action } = body; // action: read | delete_link | dismiss | read_all | delete_all
  if (!action) {
    return Response.json({ success: false, error: 'action required' }, { status: 400, headers: corsHeaders });
  }

  // Bulk actions
  if (action === 'read_all') {
    await env.DB.prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0').bind(user.id).run();
    return Response.json({ success: true }, { headers: corsHeaders });
  }
  if (action === 'delete_all') {
    await env.DB.prepare('DELETE FROM notifications WHERE user_id = ?').bind(user.id).run();
    return Response.json({ success: true }, { headers: corsHeaders });
  }

  // Single notification actions
  if (!id) {
    return Response.json({ success: false, error: 'id required for this action' }, { status: 400, headers: corsHeaders });
  }
  const n = await env.DB.prepare('SELECT * FROM notifications WHERE id = ? AND user_id = ?').bind(id, user.id).first();
  if (!n) {
    return Response.json({ success: false, error: 'Not found' }, { status: 404, headers: corsHeaders });
  }

  let payload = {};
  try { payload = JSON.parse(n.payload || '{}'); } catch (_) {}

  if (action === 'delete_link' && payload.link_id) {
    if (!(await ensureOwnerOrAdmin(payload.community_id || n.community_id, user.id, env))) {
      return Response.json({ success: false, error: 'Only owner/admin can delete from report' }, { status: 403, headers: corsHeaders });
    }
    await env.DB.prepare('DELETE FROM links WHERE id = ?').bind(payload.link_id).run();
    await env.DB.prepare('DELETE FROM link_votes WHERE link_id = ?').bind(payload.link_id).run();
    if (payload.report_id) {
      await env.DB.prepare(`UPDATE link_reports SET status = 'deleted' WHERE id = ?`).bind(payload.report_id).run();
    }
  }

  if (action === 'read' || action === 'dismiss' || action === 'delete_link') {
    await env.DB.prepare('UPDATE notifications SET read = 1 WHERE id = ?').bind(id).run();
  }

  return Response.json({ success: true }, { headers: corsHeaders });
}

async function handleListAdmins(url, user, env, corsHeaders) {
  const communityId = url.searchParams.get('community_id');
  if (!communityId) {
    return Response.json({ success: false, error: 'community_id required' }, { status: 400, headers: corsHeaders });
  }
  if (!(await ensureOwnerOrAdmin(communityId, user.id, env))) {
    return Response.json({ success: false, error: 'Owner/admin only' }, { status: 403, headers: corsHeaders });
  }
  const { results } = await env.DB.prepare(
    'SELECT * FROM community_admins WHERE community_id = ? ORDER BY created_at DESC'
  ).bind(communityId).all();
  return Response.json({ success: true, admins: results || [] }, { headers: corsHeaders });
}

async function handleUpsertAdmin(request, user, env, corsHeaders) {
  const body = await request.json();
  const communityId = (body.community_id || '').trim();
  const platform = (body.platform || '').trim().toLowerCase();
  const platformUserId = String(body.platform_user_id || '').trim();
  const label = (body.label || '').trim() || null;
  if (!communityId || !platform || !platformUserId) {
    return Response.json({ success: false, error: 'community_id, platform, platform_user_id required' }, { status: 400, headers: corsHeaders });
  }
  if (!(await ensureOwnerOrAdmin(communityId, user.id, env))) {
    return Response.json({ success: false, error: 'Owner/admin only' }, { status: 403, headers: corsHeaders });
  }
  const id = 'adm_' + Date.now().toString(36);
  await env.DB.prepare(
    `INSERT INTO community_admins (id, community_id, platform, platform_user_id, label, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, communityId, platform, platformUserId, label, user.id, Date.now()).run();
  return Response.json({ success: true, id }, { headers: corsHeaders });
}

async function handleDeleteAdmin(request, user, env, corsHeaders) {
  const body = await request.json();
  const row = await env.DB.prepare('SELECT * FROM community_admins WHERE id = ?').bind(body.id).first();
  if (!row) {
    return Response.json({ success: false, error: 'Not found' }, { status: 404, headers: corsHeaders });
  }
  if (!(await ensureOwnerOrAdmin(row.community_id, user.id, env))) {
    return Response.json({ success: false, error: 'Forbidden' }, { status: 403, headers: corsHeaders });
  }
  await env.DB.prepare('DELETE FROM community_admins WHERE id = ?').bind(body.id).run();
  return Response.json({ success: true }, { headers: corsHeaders });
}

// ============================================================
// AI chat proxy (OpenAI-compatible + Anthropic)
// ============================================================

async function ensureAiConfigTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS user_ai_config (
      user_id TEXT PRIMARY KEY,
      base_url TEXT NOT NULL,
      api_key TEXT NOT NULL,
      model TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'openai',
      updated_at INTEGER NOT NULL
    )`
  ).run();
}

async function getInstanceAiConfig(env) {
  await ensureAiConfigTable(env);
  // Prefer dedicated instance row; fall back to any GOD user's config
  let row = await env.DB.prepare(
    "SELECT base_url, model, mode, updated_at, api_key FROM user_ai_config WHERE user_id = '__instance__'"
  ).first();
  if (!row) {
    const owners = parseIdList(env.TG_OWNER_IDS);
    for (const oid of owners) {
      const u = await env.DB.prepare(
        `SELECT id FROM users WHERE provider = 'telegram' AND (provider_id = ? OR telegram_api_id = ?)`
      ).bind(String(oid), String(oid)).first();
      if (u) {
        row = await env.DB.prepare(
          'SELECT base_url, model, mode, updated_at, api_key FROM user_ai_config WHERE user_id = ?'
        ).bind(u.id).first();
        if (row) break;
      }
    }
  }
  if (!row) {
    // self-host / no owners: most recently updated config
    row = await env.DB.prepare(
      'SELECT base_url, model, mode, updated_at, api_key FROM user_ai_config ORDER BY updated_at DESC LIMIT 1'
    ).first();
  }
  if (row && row.api_key) {
    try { row.api_key = await decryptSecret(env, row.api_key); } catch (_) {}
  }
  return row || null;
}

async function handleGetAiConfig(user, env, corsHeaders) {
  await ensureAiConfigTable(env);
  const isGod = await isGodUserAsync(user, env);
  const row = await getInstanceAiConfig(env);
  if (!row) {
    return Response.json({ success: true, configured: false, read_only: !isGod }, { headers: corsHeaders });
  }
  return Response.json({
    success: true,
    configured: true,
    baseUrl: row.base_url,
    model: row.model,
    mode: row.mode,
    hasKey: !!row.api_key,
    updatedAt: row.updated_at,
    read_only: !isGod
  }, { headers: corsHeaders });
}

async function handleSaveAiConfig(request, user, env, corsHeaders) {
  await ensureAiConfigTable(env);
  const body = await request.json();
  const baseUrl = cleanApiBase(body.baseUrl || body.base_url || '');
  const apiKey = (body.apiKey || body.api_key || '').trim();
  const model = normalizeModelId(body.model, baseUrl);
  const mode = (body.mode || 'openai').toLowerCase();
  if (!baseUrl || !apiKey || !model) {
    return Response.json({ success: false, error: 'baseUrl, apiKey, model required' }, { status: 400, headers: corsHeaders });
  }
  // Instance-wide config under __instance__ + mirror on GOD user for legacy bot /ai
  const encKey = await encryptSecret(env, apiKey);
  for (const uid of ['__instance__', user.id]) {
    await env.DB.prepare(
      `INSERT INTO user_ai_config (user_id, base_url, api_key, model, mode, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         base_url = excluded.base_url,
         api_key = excluded.api_key,
         model = excluded.model,
         mode = excluded.mode,
         updated_at = excluded.updated_at`
    ).bind(uid, baseUrl, encKey, model, mode, Date.now()).run();
  }
  return Response.json({ success: true }, { headers: corsHeaders });
}

async function handleClearAiConfig(user, env, corsHeaders) {
  await ensureAiConfigTable(env);
  await env.DB.prepare("DELETE FROM user_ai_config WHERE user_id = '__instance__'").run();
  await env.DB.prepare('DELETE FROM user_ai_config WHERE user_id = ?').bind(user.id).run();
  return Response.json({ success: true }, { headers: corsHeaders });
}

// ============================================================
// Pluggable link storage (D1 default · GitHub Markdown optional)
//
// When the GitHub provider is active the Markdown files are the source of
// truth and D1 is only a cache, so every existing D1 read path keeps working
// unchanged — we just revalidate the cache against GitHub before reading and
// write through GitHub first on every mutation.
// ============================================================

async function ensureStorageTables(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS instance_storage_config (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT 'd1',
      repo TEXT, branch TEXT, token TEXT,
      updated_at INTEGER NOT NULL
    )`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS storage_sync (
      scope_key TEXT PRIMARY KEY,
      sig TEXT,
      checked_at INTEGER NOT NULL
    )`
  ).run();
  // Parsed contents per Markdown file, keyed by its git sha, so a refresh only
  // re-reads the files that actually changed.
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS storage_file_cache (
      scope_key TEXT NOT NULL,
      file_name TEXT NOT NULL,
      sha TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope_key, file_name)
    )`
  ).run();
}

/** Per-file parse cache for readAll(), keyed by git sha. */
function fileCacheFor(env, scopeKey) {
  return {
    async get(name, sha) {
      try {
        const row = await env.DB.prepare(
          'SELECT payload FROM storage_file_cache WHERE scope_key = ? AND file_name = ? AND sha = ?'
        ).bind(scopeKey, name, sha).first();
        return row ? JSON.parse(row.payload) : null;
      } catch (_) { return null; }
    },
    async put(name, sha, links) {
      try {
        await env.DB.prepare(
          `INSERT OR REPLACE INTO storage_file_cache (scope_key, file_name, sha, payload, updated_at)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(scopeKey, name, sha, JSON.stringify(links), Date.now()).run();
      } catch (_) {}
    },
  };
}

/**
 * The storage token is a real credential sitting in a database row, so anyone
 * who can read D1 could otherwise walk off with it. Encrypt it at rest with a
 * key that lives only in Worker secrets (env.STORAGE_KEY), so D1 access alone
 * is not enough to recover it.
 *
 * With no STORAGE_KEY configured we fall back to plaintext rather than locking
 * the instance out — the value is still never returned by any API.
 */
async function storageCryptoKey(env) {
  const secret = String(env.STORAGE_KEY || '').trim();
  if (!secret) return null;
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function encryptSecret(env, plain) {
  if (!plain) return plain;
  const key = await storageCryptoKey(env);
  if (!key) return plain;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain))
  );
  return `enc:v1:${bytesToB64(iv)}:${bytesToB64(ct)}`;
}

async function decryptSecret(env, stored) {
  const s = String(stored || '');
  if (!s.startsWith('enc:v1:')) return stored; // legacy plaintext row
  const key = await storageCryptoKey(env);
  if (!key) return null;
  try {
    const [, , ivB64, ctB64] = s.split(':');
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(ivB64) }, key, b64ToBytes(ctB64)
    );
    return new TextDecoder().decode(plain);
  } catch (_) {
    return null; // wrong/rotated key
  }
}

// ---------------------------------------------------------------------------
// Two independent stores
//
// The live tables (links / personal_links) always hold whichever store is
// ACTIVE. The other store's rows are parked in mirror tables, untouched, so a
// delete or edit in one mode can never reach the other. Switching provider
// swaps the two sets. Every existing query keeps reading the live tables, so
// mode-scoping is automatic rather than bolted onto 60+ call sites.
// ---------------------------------------------------------------------------

const LINK_COLS = 'id, community_id, url, url_hash, title, notes, tags, added_by, added_by_user_id, added_by_provider, added_by_name, upvotes, downvotes, created_at, image_url, site_name';
const PERSONAL_COLS = 'id, user_id, url, url_hash, title, notes, tags, created_at, image_url, site_name';

async function ensureParkingTables(env) {
  await ensureLinkMetaColumns(env);
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS parked_links (
      store TEXT NOT NULL, ${LINK_COLS.split(', ').map(c => `${c} TEXT`).join(', ')}
    )`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS parked_personal_links (
      store TEXT NOT NULL, ${PERSONAL_COLS.split(', ').map(c => `${c} TEXT`).join(', ')}
    )`
  ).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_parked_links_store ON parked_links(store)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_parked_personal_store ON parked_personal_links(store)').run();
}

/** Move the live rows out to parking, tagged as belonging to `storeName`. */
async function parkActiveStore(env, storeName) {
  await ensureParkingTables(env);
  await env.DB.prepare(`DELETE FROM parked_links WHERE store = ?`).bind(storeName).run();
  await env.DB.prepare(`DELETE FROM parked_personal_links WHERE store = ?`).bind(storeName).run();
  await env.DB.prepare(
    `INSERT INTO parked_links (store, ${LINK_COLS}) SELECT ?, ${LINK_COLS} FROM links`
  ).bind(storeName).run();
  await env.DB.prepare(
    `INSERT INTO parked_personal_links (store, ${PERSONAL_COLS}) SELECT ?, ${PERSONAL_COLS} FROM personal_links`
  ).bind(storeName).run();
  await env.DB.prepare('DELETE FROM links').run();
  await env.DB.prepare('DELETE FROM personal_links').run();
}

/** Bring `storeName`'s parked rows back into the live tables. */
async function restoreStore(env, storeName) {
  await ensureParkingTables(env);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO links (${LINK_COLS}) SELECT ${LINK_COLS} FROM parked_links WHERE store = ?`
  ).bind(storeName).run();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO personal_links (${PERSONAL_COLS}) SELECT ${PERSONAL_COLS} FROM parked_personal_links WHERE store = ?`
  ).bind(storeName).run();
  await env.DB.prepare('DELETE FROM parked_links WHERE store = ?').bind(storeName).run();
  await env.DB.prepare('DELETE FROM parked_personal_links WHERE store = ?').bind(storeName).run();
}

/**
 * Wipe a scope's Markdown folder, but only when GitHub is the ACTIVE store.
 * In Cloudflare mode a /clear_db must not reach into the GitHub copy.
 */
async function clearActiveStoreFolder(env, scope, key) {
  const store = await githubStoreFor(env); // null unless github is active
  if (!store) return { handled: false };
  try {
    const folder = folderFor(scope, key);
    const { files } = await readAll(store, folder);
    for (const f of files) {
      const got = await store.readFile(f.path);
      if (got) await store.deleteFile(f.path, got.sha, `athena: clear ${folder}`);
    }
    await markCacheTrusted(env, scope, key);
    return { handled: true, ok: true, files: files.length };
  } catch (err) {
    return { handled: true, ok: false, error: err.message };
  }
}

async function clearActiveDocumentFolder(env, scope, key) {
  const store = await githubStoreFor(env);
  if (!store) return { handled: false };
  const folder = documentFolder(scope, key);
  try {
    const files = await store.listDirectFiles(folder);
    for (const file of files) {
      const deleted = await store.deleteFile(file.path, file.sha, `athena: clear ${folder}`);
      if (!deleted.ok) return { handled: true, ok: false, error: deleted.body?.message || `HTTP ${deleted.status}` };
    }
    return { handled: true, ok: true, files: files.length };
  } catch (err) {
    return { handled: true, ok: false, error: err.message };
  }
}

/** Rows belonging to the store that is NOT currently active. */
async function parkedLinksFor(env, storeName, scope, key) {
  await ensureParkingTables(env);
  const rows = scope === 'personal'
    ? (await env.DB.prepare(
        `SELECT ${PERSONAL_COLS} FROM parked_personal_links WHERE store = ? AND user_id = ?`
      ).bind(storeName, key).all()).results
    : (await env.DB.prepare(
        `SELECT ${LINK_COLS} FROM parked_links WHERE store = ? AND community_id = ?`
      ).bind(storeName, key).all()).results;
  return (rows || []).map(r => ({
    ...r,
    created_at: Number(r.created_at) || Date.now(),
    tags: (() => { try { return JSON.parse(r.tags || '[]'); } catch (_) { return []; } })(),
  }));
}

async function getStorageConfig(env) {
  try {
    await ensureStorageTables(env);
    const row = await env.DB.prepare(
      "SELECT * FROM instance_storage_config WHERE id = '__instance__'"
    ).first();
    if (!row) return null;
    return { ...row, token: await decryptSecret(env, row.token) };
  } catch (_) { return null; }
}

/**
 * Self-hosted instances run on their own database, which is faster than GitHub
 * and has no API rate limit, and they already back up to Telegram/Drive. A live
 * GitHub store there would add latency and failure modes for no benefit, so the
 * provider is simply not offered.
 */
function isSelfHosted(env) {
  if (String(env.ATHENA_RUNTIME || '').toLowerCase() === 'selfhost') return true;
  // Detect PostgreSQL adapter even without explicit ATHENA_RUNTIME flag
  if (env.DB && env.DB.pool) return true;
  const dsn = String(env.DATABASE_URL || '').toLowerCase();
  if (dsn.startsWith('postgres') || dsn.startsWith('mysql')) return true;
  return false;
}

/** Name the database a self-hosted backend is actually talking to. */
function selfHostedEngine(env) {
  // Check if the DB object is a PostgresD1 adapter (has a pool property)
  if (env.DB && env.DB.pool) return 'PostgreSQL';
  const dsn = String(env.DATABASE_URL || '').toLowerCase();
  if (dsn.startsWith('postgres')) return 'PostgreSQL';
  if (dsn.startsWith('mysql')) return 'MySQL';
  if (dsn) return 'SQL database';
  return 'local database';
}

/**
 * Where to send the browser back to after an OAuth round trip.
 *
 * A self-hosted backend is an API, not a website — the user is looking at the
 * Cloudflare-hosted page. Redirecting to this backend's own origin would drop
 * them on the wrong site (or nothing at all when assets are not served here),
 * so ATHENA_FRONTEND_URL points home. Unset, behaviour is unchanged: the
 * backend and the site are the same origin.
 */
function frontendOrigin(env, url) {
  const configured = String(env.ATHENA_FRONTEND_URL || '')
    .split(/[\s,]+/)
    .map(value => value.trim().replace(/\/+$/, ''))
    .find(Boolean) || '';
  if (configured) return configured;
  return url.origin;
}

/** Live GitHubStore for the instance, or null when local SQL is the store. */
async function githubStoreFor(env) {
  const cfg = await getStorageConfig(env);
  if (!cfg || cfg.provider !== 'github' || !cfg.repo || !cfg.token) return null;
  const store = new GitHubStore({ repo: cfg.repo, branch: cfg.branch || 'main', token: cfg.token });
  return store.valid ? store : null;
}

function scopeKeyFor(scope, key) {
  return scope === 'personal' ? `personal:${key}` : `community:${key}`;
}

/**
 * Make the D1 cache match GitHub before a read. Cheap in the steady state: one
 * directory listing, and we skip entirely inside the TTL window.
 */
async function ensureFresh(env, scope, key, { force = false } = {}) {
  const store = await githubStoreFor(env);
  if (!store || !key) return { provider: 'd1' };
  const sk = scopeKeyFor(scope, key);
  const now = Date.now();
  await ensureStorageTables(env);

  let prev = null;
  try {
    prev = await env.DB.prepare('SELECT * FROM storage_sync WHERE scope_key = ?').bind(sk).first();
  } catch (_) {}
  if (!force && prev && now - (prev.checked_at || 0) < LISTING_TTL_MS) {
    return { provider: 'github', cached: true };
  }

  let snapshot;
  try {
    snapshot = await readAll(store, folderFor(scope, key), fileCacheFor(env, sk));
  } catch (err) {
    // GitHub unreachable: serve the last known cache rather than showing an
    // empty brain. Never destructive.
    console.error('storage readAll', err);
    return { provider: 'github', stale: true, error: err.message };
  }

  if (!force && prev && prev.sig === snapshot.sig) {
    try {
      await env.DB.prepare('UPDATE storage_sync SET checked_at = ? WHERE scope_key = ?').bind(now, sk).run();
    } catch (_) {}
    return { provider: 'github', unchanged: true };
  }

  await replaceCachedLinks(env, scope, key, snapshot.links);
  try {
    await env.DB.prepare(
      'INSERT OR REPLACE INTO storage_sync (scope_key, sig, checked_at) VALUES (?, ?, ?)'
    ).bind(sk, snapshot.sig, now).run();
  } catch (_) {}
  return { provider: 'github', synced: snapshot.links.length, files: snapshot.files.length };
}

/** Rebuild the D1 rows for one scope from the authoritative Markdown. */
async function replaceCachedLinks(env, scope, key, links) {
  await ensureLinkMetaColumns(env);
  if (scope === 'personal') {
    await env.DB.prepare('DELETE FROM personal_links WHERE user_id = ?').bind(key).run();
    for (const l of links) {
      try {
        await env.DB.prepare(
          `INSERT OR REPLACE INTO personal_links
             (id, user_id, url, url_hash, title, notes, tags, created_at, image_url, site_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          l.id, key, l.url, l.url_hash || generateUrlHash(l.url), l.title || '', l.notes || '',
          JSON.stringify(l.tags || []), l.created_at || Date.now(), l.image_url || null, l.site_name || null
        ).run();
      } catch (_) {}
    }
    return;
  }
  await env.DB.prepare('DELETE FROM links WHERE community_id = ?').bind(key).run();
  for (const l of links) {
    try {
      await env.DB.prepare(
        `INSERT OR REPLACE INTO links
           (id, community_id, url, url_hash, title, notes, tags, added_by, added_by_user_id,
            added_by_name, upvotes, downvotes, created_at, image_url, site_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`
      ).bind(
        l.id, key, l.url, l.url_hash || generateUrlHash(l.url), l.title || '', l.notes || '',
        JSON.stringify(l.tags || []), l.added_by_name || 'athena', l.added_by_user_id || null,
        l.added_by_name || null, l.created_at || Date.now(), l.image_url || null, l.site_name || null
      ).run();
    } catch (_) {}
  }
}

function storageHeadingFor(scope, key) {
  return scope === 'personal' ? 'Athena — personal brain' : `Athena — community ${key}`;
}

/**
 * Write a new link through to GitHub. Returns {handled} — false means the D1
 * provider is active and the caller should do its normal INSERT.
 */
async function storeAddLink(env, scope, key, link) {
  const store = await githubStoreFor(env);
  if (!store) return { handled: false };
  const res = await appendLink(store, folderFor(scope, key), link, {
    heading: storageHeadingFor(scope, key),
  });
  if (!res.ok) return { handled: true, ok: false, error: res.error };
  await markCacheTrusted(env, scope, key);
  return { handled: true, ok: true };
}

/** Batch variant: all links land in ONE commit per folder. */
async function storeAddLinks(env, scope, key, links) {
  const store = await githubStoreFor(env);
  if (!store) return { handled: false };
  const res = await appendLinks(store, folderFor(scope, key), links, {
    heading: storageHeadingFor(scope, key),
  });
  if (!res.ok) return { handled: true, ok: false, error: res.error };
  await markCacheTrusted(env, scope, key);
  return { handled: true, ok: true };
}

/**
 * Delete or edit one link, touching only the file that holds it.
 * `replacement` null removes the entry; an object swaps it in place.
 */
async function storeMutateLink(env, scope, key, linkId, replacement) {
  const store = await githubStoreFor(env);
  if (!store) return { handled: false };
  const res = await rewriteFileContaining(
    store, folderFor(scope, key), linkId,
    (links) => replacement
      ? links.map(l => (l.id === linkId ? { ...l, ...replacement } : l))
      : links.filter(l => l.id !== linkId),
    { heading: storageHeadingFor(scope, key) }
  );
  if (!res.ok) return { handled: true, ok: false, error: res.error };
  await markCacheTrusted(env, scope, key);
  return { handled: true, ok: true };
}

/**
 * Called right after we commit to GitHub ourselves.
 *
 * It is tempting to invalidate the cache here, but that is actively harmful:
 * GitHub's directory listing lags a commit by up to ~1s, so the very next read
 * can come back WITHOUT the link we just wrote, and replaceCachedLinks would
 * then delete the D1 row — the link visibly vanishes until the next sync.
 *
 * We just wrote both sides, so D1 is correct by construction. Mark it trusted
 * for one TTL. The empty sig guarantees the next check after the TTL still
 * compares unequal and does a real re-pull, so external edits are not missed.
 */
async function markCacheTrusted(env, scope, key) {
  try {
    await ensureStorageTables(env);
    await env.DB.prepare(
      'INSERT OR REPLACE INTO storage_sync (scope_key, sig, checked_at) VALUES (?, ?, ?)'
    ).bind(scopeKeyFor(scope, key), '', Date.now()).run();
  } catch (_) {}
}

/** Current D1 rows for a scope, shaped for the Markdown writer. */
async function cachedLinksFor(env, scope, key) {
  const rows = scope === 'personal'
    ? (await env.DB.prepare(
        'SELECT * FROM personal_links WHERE user_id = ? ORDER BY created_at DESC'
      ).bind(key).all()).results
    : (await env.DB.prepare(
        'SELECT * FROM links WHERE community_id = ? ORDER BY created_at DESC'
      ).bind(key).all()).results;
  return (rows || []).map(r => ({
    ...r,
    tags: (() => { try { return JSON.parse(r.tags || '[]'); } catch (_) { return []; } })(),
  }));
}

// ---------------------------------------------------------------------------
// Instance defaults
//
// The backend URL used to live only in each visitor's localStorage, so every
// member picked their own — and a member on a different backend is on a
// different database, seeing different links and different ranks. GOD sets it
// once here and everyone inherits it, the same way AI and storage settings
// already work. An individual can still override locally for testing.
// ---------------------------------------------------------------------------

async function ensureInstanceSettings(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS instance_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER NOT NULL
    )`
  ).run();
}

async function getInstanceSetting(env, key) {
  try {
    await ensureInstanceSettings(env);
    const row = await env.DB.prepare('SELECT value FROM instance_settings WHERE key = ?').bind(key).first();
    return row?.value || '';
  } catch (_) { return ''; }
}

async function handleGetInstanceConfig(env, corsHeaders) {
  return Response.json({
    success: true,
    default_backend: await getInstanceSetting(env, 'default_backend'),
    runtime: isSelfHosted(env) ? 'selfhost' : 'cloudflare',
  }, { headers: corsHeaders });
}

async function handleSetInstanceConfig(request, env, corsHeaders, siteOrigin) {
  const body = await request.json().catch(() => ({}));
  let backend = String(body.default_backend ?? '').trim().replace(/\/+$/, '');

  if (backend) {
    let origin;
    try { origin = new URL(backend); } catch (_) {
      return Response.json({ success: false, error: 'default_backend must be a full URL' }, { status: 400, headers: corsHeaders });
    }
    if (origin.protocol !== 'https:') {
      // The site is served over HTTPS; a plain-HTTP backend is blocked by the
      // browser as mixed content, which would lock every member out at once.
      return Response.json({ success: false, error: 'Backend must be https://' }, { status: 400, headers: corsHeaders });
    }
    backend = origin.origin;

    // The site's own Worker is already executing this request. Fetching itself
    // through workers.dev is unreliable and adds no validation value.
    if (backend !== siteOrigin) {
      // Never publish a backend that is not actually answering — this value is
      // pushed to every visitor, so a typo takes the whole instance down.
      try {
        const probe = await fetch(`${backend}/api/health`, { signal: AbortSignal.timeout(12000) });
        const j = await probe.json().catch(() => ({}));
        if (!probe.ok || j.status !== 'ok' || !j.worker) throw new Error('not an Athena backend');
      } catch (err) {
        return Response.json(
          { success: false, error: `Backend check failed: ${err.message}. Nothing was changed.` },
          { status: 400, headers: corsHeaders }
        );
      }
    }
  }

  await ensureInstanceSettings(env);
  await env.DB.prepare(
    'INSERT OR REPLACE INTO instance_settings (key, value, updated_at) VALUES (?, ?, ?)'
  ).bind('default_backend', backend, Date.now()).run();

  return Response.json({ success: true, default_backend: backend }, { headers: corsHeaders });
}

async function handleGetStorageConfig(env, corsHeaders) {
  const cfg = await getStorageConfig(env);
  const provider = cfg?.provider || 'd1';
  const selfHosted = isSelfHosted(env);
  const out = {
    success: true,
    provider: provider,
    runtime: selfHosted ? 'selfhost' : 'cloudflare',
    // Always show all storage options - let GOD choose
    github_available: true,
    postgres_available: selfHosted,
    store_label: provider === 'github' ? 'GitHub Markdown' : (provider === 'local' ? `${selfHostedEngine(env)} (self-hosted)` : 'Cloudflare D1'),
    db_engine: selfHosted ? selfHostedEngine(env) : 'Cloudflare D1',
    repo: cfg?.repo || '',
    branch: cfg?.branch || 'main',
    has_token: !!cfg?.token,
    token_encrypted: !!(await storageCryptoKey(env)),
  };
  if (provider === 'github' && cfg?.token) {
    try {
      const store = new GitHubStore({ repo: cfg.repo, branch: cfg.branch || 'main', token: cfg.token });
      const files = await store.listFolder('brain');
      out.file_count = files.length;
      const sync = await env.DB.prepare("SELECT COUNT(*) AS n FROM personal_links").first();
      out.link_count = sync?.n || 0;
    } catch (_) {}
  }
  return Response.json(out, { headers: corsHeaders });
}

async function handleSaveStorageConfig(request, env, corsHeaders) {
  const body = await request.json().catch(() => ({}));
  const provider = String(body.provider || 'd1').toLowerCase();
  const selfHosted = isSelfHosted(env);
  // Allow local, d1, or github - let GOD choose
  if (!['d1', 'github', 'local'].includes(provider)) {
    return Response.json({ success: false, error: 'provider must be d1, github, or local' }, { status: 400, headers: corsHeaders });
  }
  // If selecting local, require self-hosted environment
  if (provider === 'local' && !selfHosted) {
    return Response.json({ success: false, error: 'Local database only available on self-hosted instances' }, { status: 400, headers: corsHeaders });
  }
  await ensureStorageTables(env);
  const prev = await getStorageConfig(env);

  const wasProvider = prev?.provider || 'd1';

  // Handle local database provider
  if (provider === 'local') {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO instance_storage_config (id, provider, repo, branch, token, updated_at)
       VALUES ('__instance__', 'local', ?, ?, ?, ?)`
    ).bind(null, null, null, Date.now()).run();
    return Response.json({
      success: true, provider: 'local', switched_from: wasProvider,
      engine: selfHostedEngine(env),
    }, { headers: corsHeaders });
  }

  if (provider === 'd1') {
    // Park the GitHub mirror and bring the Cloudflare store back untouched.
    if (wasProvider === 'github') {
      await parkActiveStore(env, 'github');
      await restoreStore(env, 'd1');
    }
    await env.DB.prepare(
      `INSERT OR REPLACE INTO instance_storage_config (id, provider, repo, branch, token, updated_at)
       VALUES ('__instance__', 'd1', ?, ?, ?, ?)`
    ).bind(prev?.repo || null, prev?.branch || null, await encryptSecret(env, prev?.token || null), Date.now()).run();
    const n = await env.DB.prepare(
      'SELECT (SELECT COUNT(*) FROM links) a, (SELECT COUNT(*) FROM personal_links) b'
    ).first();
    return Response.json({
      success: true, provider: 'd1', switched_from: wasProvider,
      live_links: (n?.a || 0) + (n?.b || 0),
    }, { headers: corsHeaders });
  }

  const repo = String(body.repo || prev?.repo || '').trim();
  const branch = String(body.branch || prev?.branch || 'main').trim() || 'main';
  const token = String(body.token || '').trim() || prev?.token || '';
  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    return Response.json({ success: false, error: 'repo must look like owner/repo' }, { status: 400, headers: corsHeaders });
  }
  if (!token) {
    return Response.json({ success: false, error: 'A GitHub token is required the first time' }, { status: 400, headers: corsHeaders });
  }
  // Never store credentials we have not proven work.
  const check = await new GitHubStore({ repo, branch, token }).verify();
  if (!check.ok) {
    return Response.json({ success: false, error: `GitHub check failed: ${check.error}` }, { status: 400, headers: corsHeaders });
  }
  await env.DB.prepare(
    `INSERT OR REPLACE INTO instance_storage_config (id, provider, repo, branch, token, updated_at)
     VALUES ('__instance__', 'github', ?, ?, ?, ?)`
  ).bind(repo, branch, await encryptSecret(env, token), Date.now()).run();

  // Park the Cloudflare store so it survives untouched, then let the live
  // tables become the GitHub mirror. No merging happens here — the two stores
  // stay independent until an explicit sync.
  if (wasProvider !== 'github') {
    await parkActiveStore(env, 'd1');
    await restoreStore(env, 'github');
    try {
      await env.DB.prepare('DELETE FROM storage_sync').run();
    } catch (_) {}
  }

  return Response.json({
    success: true, provider: 'github', repo: check.repo, private: check.private,
    token_encrypted: !!(await storageCryptoKey(env)),
    switched_from: wasProvider,
    note: wasProvider !== 'github'
      ? 'Cloudflare links parked and untouched. Use Sync to reconcile the two stores.'
      : undefined,
  }, { headers: corsHeaders });
}

/**
 * Reconcile one scope between D1 and GitHub, keeping the union of both.
 *
 * A one-way push is not safe in either direction:
 *  - overwriting GitHub with D1 destroys links added or hand-written on GitHub;
 *  - letting a GitHub read replace D1 destroys links captured while the
 *    instance was running on the D1 provider.
 * Merging on canonical URL keeps everything. GitHub wins only when both stores
 * contain the same URL because it is the declared source of truth.
 */
async function mergeScope(env, store, scope, key) {
  const folder = folderFor(scope, key);
  const provider = (await getStorageConfig(env))?.provider || 'd1';
  let ghLinks;
  try {
    ghLinks = (await readAll(store, folder)).links;
  } catch (err) {
    return { ok: false, error: err.message };
  }

  // Whichever store is live sits in the live tables; the other sits in parking.
  const liveLinks = await cachedLinksFor(env, scope, key);
  const parkedD1 = provider === 'github' ? await parkedLinksFor(env, 'd1', scope, key) : liveLinks;
  const cloudflareLinks = provider === 'github' ? parkedD1 : liveLinks;

  const keyOf = (l) => {
    try { return canonicalUrlForHash(l.url || ''); } catch (_) { return String(l.url_hash || l.url || ''); }
  };

  // Union both stores, de-duplicated on canonical URL. Query parameters remain
  // meaningful, so two pages under one path are not silently collapsed.
  const union = new Map();
  for (const l of cloudflareLinks) union.set(keyOf(l), l);
  let addedToGitHub = 0;
  for (const l of ghLinks) {
    const k = keyOf(l);
    if (!union.has(k)) union.set(k, l);
  }
  const ghKeys = new Set(ghLinks.map(keyOf));
  const cfKeys = new Set(cloudflareLinks.map(keyOf));
  for (const k of union.keys()) if (!ghKeys.has(k)) addedToGitHub++;
  const addedToCloudflare = [...union.keys()].filter(k => !cfKeys.has(k)).length;

  const all = [...union.values()].sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

  // Push the union to GitHub.
  const res = await rewriteAll(store, folder, all, {
    heading: storageHeadingFor(scope, key),
    message: `athena: sync ${folder}`,
  });
  if (!res.ok) return { ok: false, error: res.error };

  // ...and into the Cloudflare store, wherever it currently lives.
  if (provider === 'github') {
    await replaceParkedLinks(env, 'd1', scope, key, all);
    await replaceCachedLinks(env, scope, key, all); // live mirror = GitHub
  } else {
    await replaceCachedLinks(env, scope, key, all); // live = Cloudflare store
  }
  await markCacheTrusted(env, scope, key);

  return {
    ok: true, total: all.length,
    github_before: ghLinks.length, cloudflare_before: cloudflareLinks.length,
    added_to_github: addedToGitHub, added_to_cloudflare: addedToCloudflare,
    files: res.files,
  };
}

/** Replace one scope's rows inside the parking area for an inactive store. */
async function replaceParkedLinks(env, storeName, scope, key, links) {
  await ensureParkingTables(env);
  if (scope === 'personal') {
    await env.DB.prepare('DELETE FROM parked_personal_links WHERE store = ? AND user_id = ?')
      .bind(storeName, key).run();
    for (const l of links) {
      try {
        await env.DB.prepare(
          `INSERT INTO parked_personal_links (store, ${PERSONAL_COLS})
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          storeName, l.id, key, l.url, l.url_hash || generateUrlHash(l.url), l.title || '',
          l.notes || '', JSON.stringify(l.tags || []), l.created_at || Date.now(),
          l.image_url || null, l.site_name || null
        ).run();
      } catch (_) {}
    }
    return;
  }
  await env.DB.prepare('DELETE FROM parked_links WHERE store = ? AND community_id = ?')
    .bind(storeName, key).run();
  for (const l of links) {
    try {
      await env.DB.prepare(
        `INSERT INTO parked_links (store, ${LINK_COLS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        storeName, l.id, key, l.url, l.url_hash || generateUrlHash(l.url), l.title || '',
        l.notes || '', JSON.stringify(l.tags || []), l.added_by_name || 'athena',
        l.added_by_user_id || null, l.added_by_provider || null, l.added_by_name || null,
        l.upvotes || 0, l.downvotes || 0, l.created_at || Date.now(),
        l.image_url || null, l.site_name || null
      ).run();
    } catch (_) {}
  }
}

/** Merge every scope. Used by the sync button and on switching to GitHub. */
async function mergeAllScopes(env, store, godUserId) {
  const detail = [];
  let total = 0;

  const p = await mergeScope(env, store, 'personal', godUserId);
  if (!p.ok) return { ok: false, error: p.error };
  if (p.total) { detail.push({ scope: 'personal', ...p }); total += p.total; }

  const { results: comms } = await env.DB.prepare('SELECT id FROM communities').all();
  for (const c of (comms || [])) {
    const r = await mergeScope(env, store, 'community', c.id);
    if (!r.ok) return { ok: false, error: r.error };
    if (r.total) { detail.push({ scope: c.id, ...r }); total += r.total; }
  }
  return { ok: true, total, detail };
}

/** Reconcile D1 and GitHub in both directions. */
async function handleStorageSync(user, env, corsHeaders) {
  if (isSelfHosted(env)) {
    return Response.json({
      success: false,
      error: 'Nothing to sync — self-hosted mode stores links locally. Use the Telegram/Drive backups.',
      code: 'SELFHOST_LOCAL_ONLY',
    }, { status: 400, headers: corsHeaders });
  }
  // Sync is a cross-store operation, so it must work from EITHER mode — not
  // only while GitHub happens to be the active provider.
  const cfg = await getStorageConfig(env);
  if (!cfg?.repo || !cfg?.token) {
    return Response.json(
      { success: false, error: 'Set a GitHub repo and token first (Settings → Storage backend)' },
      { status: 400, headers: corsHeaders }
    );
  }
  const store = new GitHubStore({ repo: cfg.repo, branch: cfg.branch || 'main', token: cfg.token });
  if (!store.valid) {
    return Response.json({ success: false, error: 'GitHub credentials are incomplete' }, { status: 400, headers: corsHeaders });
  }
  const merged = await mergeAllScopes(env, store, user.id);
  if (!merged.ok) {
    return Response.json({ success: false, error: merged.error }, { status: 502, headers: corsHeaders });
  }
  return Response.json({ success: true, pushed: merged.total, detail: merged.detail }, { headers: corsHeaders });
}

function cleanApiBase(baseUrl) {
  let root = String(baseUrl || '').trim();
  // strip quotes, trailing junk users paste by accident
  root = root.replace(/^['"]|['"]$/g, '');
  root = root.replace(/[.,;]+$/g, '');
  root = root.replace(/\/+$/g, '');
  // drop accidental path suffixes
  root = root.replace(/\/chat\/completions$/i, '');
  root = root.replace(/\/messages$/i, '');
  root = root.replace(/\/+$/g, '');
  // OpenCode Zen / Go: ensure /v1 (saved as .../zen/go without /v1 → 404)
  if (/opencode\.ai\/zen(\/go)?$/i.test(root)) root = `${root}/v1`;
  return root;
}

const PRIVATE_HOST_RE =
  /(^|\.)(local|localhost|localdomain|internal|test|example|invalid|onion)$/i;

// A scrape resolves the same handful of hosts repeatedly (api.github.com is hit
// 2-4 times per repo), and every miss is two DoH round trips. Short TTL so a
// legitimately changed record is picked up quickly.
const DNS_VERDICTS = new Map();
const DNS_TTL_MS = 5 * 60 * 1000;

/**
 * DNS-rebinding-safe SSRF guard. True only for hosts that resolve to public,
 * non-loopback, non-private addresses. On Cloudflare there is no internal
 * network to protect, so this only restricts when self-hosted — the one place
 * 127.0.0.1 / RFC1918 / link-local / cloud metadata are reachable.
 *
 * Resolves all A/AAAA; on mixed public/private results we err closed. Fails
 * closed if DoH itself is unreachable, so a box that cannot reach dns.google
 * scrapes nothing — see docs/self-hosting notes.
 */
async function isSafeExternalUrl(u, env) {
  try {
    if (!u) return false;
    if (!isSelfHosted(env)) return true; // Workers: no internal network
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const host = (u.hostname || '').trim().toLowerCase();
    if (!host) return false;
    if (PRIVATE_HOST_RE.test(host)) return false;
    let ip = host;
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
    if (!isIp) {
      const cached = DNS_VERDICTS.get(host);
      if (cached && cached.until > Date.now()) return cached.safe;
      let safe;
      try {
        const [j, j6] = await Promise.all(
          ['A', 'AAAA'].map(t =>
            fetch(`https://dns.google/resolve?name=${encodeURIComponent(host)}&type=${t}`)
              .then(r => r.json())
              .catch(() => ({}))
          )
        );
        const addrs = (j.Answer || []).filter(a => a.type === 1).map(a => String(a.data));
        addrs.push(...(j6.Answer || []).filter(a => a.type === 28).map(a => String(a.data)));
        // No records is NXDOMAIN or a DoH failure — either way, err closed and
        // do not cache, so a transient outage does not blackhole the host.
        if (!addrs.length) return false;
        safe = addrs.every(isPublicIp);
      } catch (_) {
        return false;
      }
      if (DNS_VERDICTS.size > 1000) DNS_VERDICTS.clear();
      DNS_VERDICTS.set(host, { safe, until: Date.now() + DNS_TTL_MS });
      return safe;
    }
    return isPublicIp(ip);
  } catch (_) {
    return false;
  }
}

function isPublicIp(ip) {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o.some(x => x > 255)) return false;
    if (o[0] === 0 || o[0] === 10) return false;
    if (o[0] === 127) return false;
    if (o[0] === 169 && o[1] === 254) return false;
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return false;
    if (o[0] === 192 && o[1] === 168) return false;
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return false; // 100.64/10 CGNAT
    if (o[0] === 198 && (o[1] === 18 || o[1] === 19)) return false; // 198.18/15 benchmark
    if (o[0] >= 224) return false; // multicast + reserved
    return true;
  }
  // IPv6: expand, then flag loopback (::1), link-local (fe8/fe9/fea/feb),
  // ULA (fc/fd), and the IPv4-mapped v4-in-v6 forms handled via v4 rules.
  let norm = ip.toLowerCase();
  // IPv4-mapped (::ffff:a.b.c.d) — classify the embedded IPv4.
  if (norm.includes('.')) {
    const m = norm.match(/(\d{1,3}(\.\d{1,3}){3})$/);
    if (m) return isPublicIp(m[1]);
    return false;
  }
  const v6 = norm.match(/^[0-9a-f:]+$/);
  if (!v6) return false;
  if (!norm.includes('::')) {
    const need = 8 - norm.split(':').length;
    if (need > 0) norm += ':'.repeat(need + 1);
  }
  const first = norm.split(':')[0];
  if (first === '' || first === '0') return false; // ::/128, ::1, compat
  const hext = norm.split(':').map(h => h || '0');
  const head = (hext[0] || '').padStart(4, '0');
  if (head.startsWith('fe')) {
    const nib = head[2];
    if (['8', '9', 'a', 'b'].includes(nib)) return false; // fe80::/10
  }
  if (/^f[cd]/.test(head)) return false; // fc00::/7 ULA
  return true;
}

function resolveChatEndpoint(baseUrl, mode) {
  let root = cleanApiBase(baseUrl);
  if (!root) return null;
  if (!/^https?:\/\//i.test(root)) root = `https://${root}`;

  if (mode === 'anthropic') {
    if (/\/messages$/i.test(root)) return root;
    if (/\/v1$/i.test(root)) return `${root}/messages`;
    return `${root}/v1/messages`;
  }

  if (/\/chat\/completions$/i.test(root)) return root;
  // any .../v1 base (incl. zen/go/v1, zen/v1, api.openai.com/v1)
  if (/\/v1$/i.test(root)) return `${root}/chat/completions`;
  // OpenAI-compatible without /v1: append it
  return `${root}/v1/chat/completions`;
}

function normalizeModelId(model, baseUrl) {
  let m = String(model || '').trim().replace(/^['"]|['"]$/g, '');
  // OpenCode config uses opencode-go/deepseek-v4-flash; API wants deepseek-v4-flash
  if (/opencode\.ai/i.test(baseUrl || '') || /^opencode/i.test(m)) {
    m = m.replace(/^opencode-go\//i, '').replace(/^opencode\//i, '');
  }
  return m;
}

/** Time-to-first-byte budget for the upstream model call; a cold model is slow. */
const AI_PROXY_TIMEOUT_MS = 30_000;

async function handleAiChatProxy(request, user, env, corsHeaders) {
  if (!user) {
    return Response.json({ success: false, error: 'Login required', code: 'AUTH_REQUIRED' }, { status: 401, headers: corsHeaders });
  }
  const body = await request.json().catch(() => ({}));
  // Prefer instance (GOD) credentials; client may still send overrides for GOD testing
  const inst = await getInstanceAiConfig(env);
  const bodyBase = cleanApiBase(body.baseUrl || body.base_url || '');
  const bodyKey = (body.apiKey || body.api_key || '').trim();
  const bodyMode = (body.mode || '').toLowerCase();
  const bodyModel = (body.model || '').trim();
  const hasOverride = !!(bodyBase || bodyKey || bodyMode || bodyModel);
  // Per-request overrides are a paired set, allowed only for GOD. Mixing a
  // request's baseUrl with the instance's key would hand the stored secret to
  // an arbitrary host (exfiltration). Non-GOD users always use the instance
  // config for both URL and key.
  if (hasOverride && !(await isInstanceOwnerUserAsync(user, env))) {
    return Response.json(
      { success: false, error: 'Per-request AI overrides are GOD rank only' },
      { status: 403, headers: corsHeaders }
    );
  }
  // A partial override is the same exfiltration: baseUrl alone would inherit
  // inst.api_key and ship it to the caller's host.
  if (hasOverride && !(bodyBase && bodyKey)) {
    return deny(corsHeaders, 'Per-request AI overrides must supply both baseUrl and apiKey', 'AI_OVERRIDE_INCOMPLETE');
  }
  const baseUrl = cleanApiBase(bodyBase || inst?.base_url || '');
  const apiKey = (bodyKey || inst?.api_key || '').trim();
  const mode = (bodyMode || inst?.mode || 'openai').toLowerCase();
  let model = normalizeModelId(bodyModel || inst?.model, baseUrl);
    const system = body.system || '';
    const userMsg = body.user || body.prompt || '';
    const messages = Array.isArray(body.messages) ? body.messages : null;
    // Only stream to clients that opt in (new frontends). Older frontends that
    // expect a plain JSON answer would otherwise get an SSE body and fail to
    // parse it, showing "Empty response from model".
    const wantStream = body.stream === true ||
      (request.headers.get('accept') || '').toLowerCase().includes('text/event-stream');

  if (!baseUrl || !apiKey || !model) {
    return Response.json(
      { success: false, error: 'No AI credentials. GOD: Settings → AI → Save (syncs for website + bot /ai)' },
      { status: 400, headers: corsHeaders }
    );
  }

  // Only allow https endpoints; reject private hosts on self-host (SSRF)
  try {
    const u = new URL(baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`);
    if (u.protocol !== 'https:') {
      return Response.json({ success: false, error: 'Only HTTPS API bases allowed' }, { status: 400, headers: corsHeaders });
    }
    if (!(await isSafeExternalUrl(u, env))) {
      return Response.json({ success: false, error: 'API base must be a public HTTPS host' }, { status: 400, headers: corsHeaders });
    }
  } catch (_) {
    return Response.json({ success: false, error: 'Invalid baseUrl' }, { status: 400, headers: corsHeaders });
  }

  const endpoint = resolveChatEndpoint(baseUrl, mode);
  if (!endpoint) {
    return Response.json({ success: false, error: 'Could not resolve chat endpoint' }, { status: 400, headers: corsHeaders });
  }
  const ep = new URL(endpoint);
  if (ep.protocol !== 'https:' || !(await isSafeExternalUrl(ep, env))) {
    return Response.json({ success: false, error: 'API base must be a public HTTPS host' }, { status: 400, headers: corsHeaders });
  }

  try {
      const maxTok = Math.min(parseInt(body.max_tokens, 10) || 500, 8192);
      let upstreamRes;
      // fetchWithTimeout, not fetch: it never follows a redirect blindly. Here
      // redirect:'error' refuses them outright — the request carries the API key
      // and the prompt, and a public-but-hostile hop passes isSafeExternalUrl.
      // Checking upstreamRes.url afterwards would be too late. Time-to-headers
      // only; the timer is cleared before the SSE body streams.
      if (mode === 'anthropic') {
        upstreamRes = await fetchWithTimeout(endpoint, {
          method: 'POST',
          env,
          redirect: 'error',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTok,
            system: system || undefined,
            messages: messages || [{ role: 'user', content: userMsg }],
            stream: true
          })
        }, AI_PROXY_TIMEOUT_MS);
      } else {
        const msgs = messages || [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: userMsg }
        ];
        upstreamRes = await fetchWithTimeout(endpoint, {
          method: 'POST',
          env,
          redirect: 'error',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model,
            messages: msgs,
            temperature: body.temperature ?? 0.2,
            max_tokens: maxTok,
            stream: true
          })
        }, AI_PROXY_TIMEOUT_MS);
      }

      if (!upstreamRes.ok) {
        const text = await upstreamRes.text();
        let data = {};
        try { data = JSON.parse(text); } catch (_) { data = { raw: text.slice(0, 500) }; }
        let msg =
          data.error?.message ||
          data.message ||
          data.error?.type ||
          (typeof data.error === 'string' ? data.error : null) ||
          null;
        if (!msg) {
          if (/^\s*</.test(text) || /<!DOCTYPE/i.test(text)) {
            msg = `Provider returned HTML (HTTP ${upstreamRes.status}) — check base URL. Expected OpenAI chat endpoint.`;
          } else {
            msg = text.slice(0, 200) || upstreamRes.statusText;
          }
        }
        return Response.json({
          success: false,
          error: msg,
          status: upstreamRes.status,
          endpoint,
          model
        }, { status: 502, headers: corsHeaders });
      }

      // Client that can't consume a stream (older frontends) gets a classic
      // JSON answer: we still ask the model to stream, then collect it here.
      if (!wantStream) {
        const text = await upstreamRes.text();
        let contentBuf = '';
        let reasonBuf = '';
        for (const line of text.split('\n')) {
          if (!line.startsWith('data:') || !line.includes('{')) continue;
          const p = line.slice(5).trim();
          if (!p || p === '[DONE]') continue;
          let j; try { j = JSON.parse(p); } catch (_) { continue; }
          const d = j.choices?.[0]?.delta || {};
          if (d.content) contentBuf += d.content;
          if (d.reasoning_content) reasonBuf += d.reasoning_content;
        }
        // Prefer the model's clean answer; fall back to reasoning only if the
        // model put everything there (reasoning models sometimes do this).
        let content = contentBuf || reasonBuf;
        let thinkingOut = reasonBuf || null;
        if (!content) {
          // Non-streamed JSON (provider ignored stream:true) — use directly.
          let data = {};
          try { data = JSON.parse(text); } catch (_) {}
          if (mode === 'anthropic') content = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
          else content = data.choices?.[0]?.message?.content || data.choices?.[0]?.text || data.output_text || '';
        }
        return Response.json({ success: true, content, thinking: thinkingOut, endpoint, model, usage: null }, { headers: corsHeaders });
      }

      // Stream the upstream SSE back as normalized SSE so the browser renders
      // the answer token-by-token (matches the feel of web-chat UIs).
      const reader = upstreamRes.body.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let buf = '';
      const out = new ReadableStream({
        async start(controller) {
          let contentSeen = '';
          let reasonBuf = '';
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              let nl;
              while ((nl = buf.indexOf('\n')) !== -1) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line.startsWith('data:')) continue;
                const payload = line.slice(5).trim();
                if (!payload || payload === '[DONE]') continue;
                let j;
                try { j = JSON.parse(payload); } catch (_) { continue; }
                let delta = '';
                if (mode === 'anthropic') {
                  if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'text_delta') {
                    delta = j.delta.text || '';
                    if (delta) {
                      contentSeen += delta;
                      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`));
                    }
                  }
                } else {
                  const d = j.choices?.[0]?.delta || {};
                  // Forward content as normal answer deltas.
                  if (d.content) {
                    contentSeen += d.content;
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta: d.content })}\n\n`));
                  }
                  // Forward reasoning as a separate "thinking" stream so the
                  // frontend can show it in a collapsible block.
                  if (d.reasoning_content) {
                    reasonBuf += d.reasoning_content;
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ thinking: d.reasoning_content })}\n\n`));
                  }
                  // Some providers use choices[0].text instead of delta.content.
                  if (!d.content && !d.reasoning_content) {
                    const text = j.choices?.[0]?.text || '';
                    if (text) {
                      contentSeen += text;
                      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta: text })}\n\n`));
                    }
                  }
                }
              }
            }
            // Fallback: if the model only produced reasoning (no content answer),
            // forward the reasoning so the user gets *something*.
            if (!contentSeen && reasonBuf) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta: reasonBuf })}\n\n`));
            }
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          } catch (err) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: String((err && err.message) || err) })}\n\n`));
          } finally {
            controller.close();
          }
        }
      });
      return new Response(out, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
          ...corsHeaders
        }
      });
  } catch (err) {
    return Response.json({
      success: false,
      error: err.message || 'Proxy request failed',
      endpoint,
      model
    }, { status: 502, headers: corsHeaders });
  }
}

// ============================================================
// Personal Links
// ============================================================

async function handleGetPersonalLinks(userId, env, corsHeaders) {
  await ensureFresh(env, 'personal', userId);
  await ensureLinkMetaColumns(env);
  const { results } = await env.DB.prepare(
    'SELECT * FROM personal_links WHERE user_id = ? ORDER BY created_at DESC LIMIT 1000'
  ).bind(userId).all();
  const links = dedupeLinkRows(results || []);
  const enrichmentPending = queueMissingLinkEnrichment(env, 'personal', userId, links);
  return Response.json({ success: true, links, enrichment_pending: enrichmentPending }, { headers: corsHeaders });
}

function isUniqueConstraintError(error) {
  const code = String(error?.code || error?.cause?.code || '').toUpperCase();
  const message = String(error?.message || error || '').toLowerCase();
  return code === '23505' || /unique constraint|duplicate key|already exists|constraint failed/.test(message);
}

function isMissingLinkMetaColumnError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return /no such column|column .* does not exist|undefined column/.test(message) &&
    /(image_url|site_name)/.test(message);
}

function batchLinkId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${randomToken().slice(0, 10)}`;
}

async function ensureBatchUploadsTable(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS batch_uploads (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      request_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'processing',
      result TEXT,
      created_at INTEGER NOT NULL
    )
  `).run().catch(() => {});
  await env.DB.prepare(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_batch_uploads_request ON batch_uploads(user_id, scope, scope_key, request_key)'
  ).run().catch(() => {});
}

function batchRequestKey(request) {
  const key = String(request.headers.get('X-Athena-Batch-Key') || '').trim();
  return /^[A-Za-z0-9._:-]{16,128}$/.test(key) ? key : null;
}

async function beginBatchUpload(env, userId, scope, scopeKey, requestKey) {
  if (!requestKey) return { id: null };
  await ensureBatchUploadsTable(env);
  const old = await env.DB.prepare(
    'SELECT id, status, result, created_at FROM batch_uploads WHERE user_id = ? AND scope = ? AND scope_key = ? AND request_key = ?'
  ).bind(userId, scope, scopeKey, requestKey).first();
  if (old) {
    if (old.status === 'complete' && old.result) {
      try { return { replay: JSON.parse(old.result) }; } catch (_) {}
    }
    if (Date.now() - Number(old.created_at || 0) < 10 * 60 * 1000) return { inProgress: true };
    await env.DB.prepare('DELETE FROM batch_uploads WHERE id = ?').bind(old.id).run().catch(() => {});
  }

  const id = `batch_${Date.now().toString(36)}_${randomToken().slice(0, 10)}`;
  try {
    await env.DB.prepare(
      'INSERT INTO batch_uploads (id, user_id, scope, scope_key, request_key, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, userId, scope, scopeKey, requestKey, 'processing', Date.now()).run();
    return { id };
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const raced = await env.DB.prepare(
      'SELECT id, status, result FROM batch_uploads WHERE user_id = ? AND scope = ? AND scope_key = ? AND request_key = ?'
    ).bind(userId, scope, scopeKey, requestKey).first();
    if (raced?.status === 'complete' && raced.result) {
      try { return { replay: JSON.parse(raced.result) }; } catch (_) {}
    }
    return { inProgress: true };
  }
}

async function finishBatchUpload(env, id, result) {
  if (!id) return;
  if (!result?.success) {
    await env.DB.prepare('DELETE FROM batch_uploads WHERE id = ?').bind(id).run().catch(() => {});
    return;
  }
  await env.DB.prepare('UPDATE batch_uploads SET status = ?, result = ? WHERE id = ?')
    .bind('complete', JSON.stringify(result), id).run().catch(() => {});
}

async function abortBatchUpload(env, id) {
  if (!id) return;
  await env.DB.prepare('DELETE FROM batch_uploads WHERE id = ?').bind(id).run().catch(() => {});
}

async function handlePostPersonalLinksBatch(request, userId, env, corsHeaders) {
  const body = await request.json();
  const items = Array.isArray(body.links) ? body.links.slice(0, 500) : [];
  if (!items.length) {
    return Response.json({ success: false, error: 'links[] required' }, { status: 400, headers: corsHeaders });
  }
  const replayState = await beginBatchUpload(env, userId, 'personal', userId, batchRequestKey(request));
  if (replayState.replay) return Response.json({ ...replayState.replay, replayed: true }, { headers: corsHeaders });
  if (replayState.inProgress) {
    return Response.json({ success: false, error: 'Batch upload already in progress', code: 'BATCH_IN_PROGRESS' }, { status: 409, headers: corsHeaders });
  }
  try {
    await ensureLinkMetaColumns(env);

  const now = Date.now();
  const displayName = 'athena-tui';
  const inserted = [];
  const dupes = [];
  const failed = [];
  const seenHashes = new Set();
  for (const raw of items) {
    const rawUrl = typeof raw?.url === 'string' ? raw.url.trim() : '';
    if (!/^https?:\/\//i.test(rawUrl)) { failed.push({ url: rawUrl || '(empty)', error: 'BAD_URL' }); continue; }
    const urlHash = generateUrlHash(rawUrl);
    if (seenHashes.has(urlHash)) { dupes.push(rawUrl); continue; }
    seenHashes.add(urlHash);
    const existing = await findExistingLink(env, 'personal_links', 'user_id', userId, rawUrl);
    if (existing) { dupes.push(rawUrl); continue; }
    // Dump payloads already carry real titles — title-only fast path, no scrape.
    const title = String(raw.title || '').trim().slice(0, 300);
    inserted.push({
      id: batchLinkId('pl'),
      url: rawUrl, url_hash: urlHash, title,
      notes: '', tags: Array.isArray(raw.tags) ? raw.tags.slice(0, 10) : [],
      created_at: now, added_by_user_id: userId, added_by_name: displayName,
    });
  }

  if (inserted.length) {
    const stored = [];
    for (const l of inserted) {
      try {
        await env.DB.prepare(
          `INSERT INTO personal_links (id, user_id, url, url_hash, title, notes, tags, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(l.id, userId, l.url, l.url_hash, l.title, l.notes, JSON.stringify(l.tags), l.created_at).run();
        stored.push(l);
      } catch (error) {
        if (isUniqueConstraintError(error)) dupes.push(l.url);
        else failed.push({ url: l.url, error: 'DB_INSERT_FAILED' });
      }
    }
    inserted.splice(0, inserted.length, ...stored);
    if (stored.length) {
      const gh = await storeAddLinks(env, 'personal', userId, stored);
      if (gh.handled && !gh.ok) {
        for (const l of stored) await env.DB.prepare('DELETE FROM personal_links WHERE id = ? AND user_id = ?').bind(l.id, userId).run().catch(() => {});
        const failure = {
          success: false,
          total: items.length,
          added: 0,
          dupes: dupes.length,
          failed: [...failed.map((f) => f.url), ...stored.map((l) => l.url)],
          error: `GitHub write failed: ${gh.error}`,
          code: 'STORAGE_WRITE_FAILED',
        };
        await finishBatchUpload(env, replayState.id, failure);
        return Response.json(failure, { status: 502, headers: corsHeaders });
      }
      // Dump was fast by design; enrich the fresh links in the background so
      // they carry descriptions/site names/images like Telegram saves do.
      runInBackground(env, enrichLinksInBackground(env, 'personal', userId, stored));
    }
  }

  const result = {
    success: true,
    total: items.length,
    added: inserted.length,
    dupes: dupes.length,
    failed: failed.map((f) => f.url),
  };
  await finishBatchUpload(env, replayState.id, result);
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    await abortBatchUpload(env, replayState.id);
    throw error;
  }
}

async function handlePostCommunityLinksBatch(request, user, env, corsHeaders) {
  const body = await request.json();
  const communityId = body.community_id;
  const items = Array.isArray(body.links) ? body.links.slice(0, 500) : [];
  if (!communityId || !items.length) {
    return Response.json({ success: false, error: 'community_id and links[] required' }, { status: 400, headers: corsHeaders });
  }
  if (!(await isInstanceOwnerUserAsync(user, env))) {
    const presence = await syncCommunityGroupPresence(env, communityId, user);
    if (!presence.inGroup) {
      return deny(corsHeaders, 'You left or were removed from the Telegram group — rejoin to dump links', 'NOT_IN_GROUP');
    }
  }
  if (await isBannedFromCommunity(env, communityId, user)) {
    return deny(corsHeaders, 'You are banned from this community', 'BANNED');
  }
  if (!(await ensureMember(communityId, user.id, env))) {
    return Response.json({
      success: false,
      error: 'Join this community first: login on the website, then /community_join ' + communityId,
      code: 'NOT_MEMBER'
    }, { status: 403, headers: corsHeaders });
  }
  const replayState = await beginBatchUpload(env, user.id, 'community', communityId, batchRequestKey(request));
  if (replayState.replay) return Response.json({ ...replayState.replay, replayed: true }, { headers: corsHeaders });
  if (replayState.inProgress) {
    return Response.json({ success: false, error: 'Batch upload already in progress', code: 'BATCH_IN_PROGRESS' }, { status: 409, headers: corsHeaders });
  }

  try {
    await ensureLinkMetaColumns(env);
  const now = Date.now();
  const displayName = user.display_name || user.username || user.id;
  const inserted = [];
  const dupes = [];
  const failed = [];
  const seenHashes = new Set();
  for (const raw of items) {
    const rawUrl = typeof raw?.url === 'string' ? raw.url.trim() : '';
    if (!/^https?:\/\//i.test(rawUrl)) { failed.push({ url: rawUrl || '(empty)', error: 'BAD_URL' }); continue; }
    const urlHash = generateUrlHash(rawUrl);
    if (seenHashes.has(urlHash)) { dupes.push(rawUrl); continue; }
    seenHashes.add(urlHash);
    const existing = await findExistingLink(env, 'links', 'community_id', communityId, rawUrl);
    if (existing) { dupes.push(rawUrl); continue; }
    const title = String(raw.title || '').trim().slice(0, 300);
    inserted.push({
      id: batchLinkId('link'),
      community_id: communityId, url: rawUrl, url_hash: urlHash, title,
      notes: '', tags: Array.isArray(raw.tags) ? raw.tags.slice(0, 10) : [],
      created_at: now, added_by_name: displayName, added_by_user_id: user.id,
    });
  }

  if (inserted.length) {
    const stored = [];
    for (const l of inserted) {
      try {
        await env.DB.prepare(
          `INSERT INTO links (id, community_id, url, url_hash, title, notes, tags, added_by,
             added_by_user_id, added_by_provider, added_by_name, upvotes, downvotes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`
        ).bind(
          l.id, communityId, l.url, l.url_hash, l.title, l.notes, JSON.stringify(l.tags),
          displayName, user.id, user.provider || null, displayName, l.created_at
        ).run();
        stored.push(l);
      } catch (error) {
        if (isUniqueConstraintError(error)) dupes.push(l.url);
        else failed.push({ url: l.url, error: 'DB_INSERT_FAILED' });
      }
    }
    inserted.splice(0, inserted.length, ...stored);
    if (stored.length) {
      const gh = await storeAddLinks(env, 'community', communityId, stored);
      if (gh.handled && !gh.ok) {
        for (const l of stored) await env.DB.prepare('DELETE FROM links WHERE id = ? AND community_id = ?').bind(l.id, communityId).run().catch(() => {});
        const failure = {
          success: false,
          total: items.length,
          added: 0,
          dupes: dupes.length,
          failed: [...failed.map((f) => f.url), ...stored.map((l) => l.url)],
          error: `GitHub write failed: ${gh.error}`,
          code: 'STORAGE_WRITE_FAILED',
        };
        await finishBatchUpload(env, replayState.id, failure);
        return Response.json(failure, { status: 502, headers: corsHeaders });
      }
      runInBackground(env, enrichLinksInBackground(env, 'community', communityId, stored));
    }
  }

  const result = {
    success: true,
    total: items.length,
    added: inserted.length,
    dupes: dupes.length,
    failed: failed.map((f) => f.url),
  };
  await finishBatchUpload(env, replayState.id, result);
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    await abortBatchUpload(env, replayState.id);
    throw error;
  }
}

async function handlePostPersonalLink(request, userId, env, corsHeaders) {
  const body = await request.json();
  const rawUrl = body.url;
  if (!rawUrl) {
    return Response.json({ success: false, error: 'url required' }, { status: 400, headers: corsHeaders });
  }
  // notes without real http links skip scrape
  const isNote = rawUrl.startsWith('note://') || !/^https?:\/\//i.test(rawUrl);
  const urlHash = generateUrlHash(rawUrl);
  const existing = await findExistingLink(env, 'personal_links', 'user_id', userId, rawUrl);

  if (existing) {
    return Response.json(
      { success: false, duplicate: true, error: 'Website is already added', code: 'DUPLICATE_URL' },
      { status: 409, headers: corsHeaders }
    );
  }

  await ensureLinkMetaColumns(env);
  const meta = isNote
    ? { title: body.title || 'Note', notes: body.notes || '', image_url: '', site_name: '' }
    : await enrichLinkFields(env, rawUrl, { title: body.title, notes: body.notes });

  const id = 'pl_' + Date.now().toString(36);
  const now = Date.now();

  // GitHub is the source of truth when enabled: commit first, and surface a
  // failure instead of silently keeping a link that only exists in the cache.
  const gh = await storeAddLink(env, 'personal', userId, {
    id, url: rawUrl, url_hash: urlHash, title: meta.title, notes: meta.notes,
    tags: body.tags || [], created_at: now,
    image_url: meta.image_url, site_name: meta.site_name,
  });
  if (gh.handled && !gh.ok) {
    return Response.json({ success: false, error: `GitHub write failed: ${gh.error}` }, { status: 502, headers: corsHeaders });
  }

  try {
    await env.DB.prepare(
      `INSERT INTO personal_links (id, user_id, url, url_hash, title, notes, tags, created_at, image_url, site_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, userId, rawUrl, urlHash, meta.title, meta.notes, JSON.stringify(body.tags || []), now, meta.image_url || null, meta.site_name || null).run();
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return Response.json(
        { success: false, duplicate: true, error: 'Website is already added', code: 'DUPLICATE_URL' },
        { status: 409, headers: corsHeaders }
      );
    }
    if (!isMissingLinkMetaColumnError(error)) {
      return Response.json({ success: false, error: error.message || 'Database insert failed', code: 'DB_INSERT_FAILED' }, { status: 500, headers: corsHeaders });
    }
    await env.DB.prepare(
      'INSERT INTO personal_links (id, user_id, url, url_hash, title, notes, tags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, userId, rawUrl, urlHash, meta.title, meta.notes, JSON.stringify(body.tags || []), now).run();
  }

  return Response.json({
    success: true,
    id,
    title: meta.title,
    notes: meta.notes,
    image_url: meta.image_url,
    site_name: meta.site_name
  }, { headers: corsHeaders });
}

async function handleDeletePersonalLink(request, userId, env, corsHeaders) {
  const body = await request.json();
  await env.DB.prepare(
    'DELETE FROM personal_links WHERE id = ? AND user_id = ?'
  ).bind(body.id, userId).run();
  // Entries live inside shared Markdown files, so removal means rewriting the folder.
  const gh = await storeMutateLink(env, 'personal', userId, body.id, null);
  if (gh.handled && !gh.ok) {
    return Response.json({ success: false, error: `GitHub write failed: ${gh.error}` }, { status: 502, headers: corsHeaders });
  }
  return Response.json({ success: true }, { headers: corsHeaders });
}

async function handlePatchPersonalLink(request, userId, env, corsHeaders) {
  const body = await request.json();
  const id = body.id;
  if (!id) {
    return Response.json({ success: false, error: 'id required' }, { status: 400, headers: corsHeaders });
  }
  const existing = await env.DB.prepare(
    'SELECT * FROM personal_links WHERE id = ? AND user_id = ?'
  ).bind(id, userId).first();
  if (!existing) {
    return Response.json({ success: false, error: 'Not found' }, { status: 404, headers: corsHeaders });
  }

  let url = existing.url;
  let urlHash = existing.url_hash;
  let title = existing.title;
  let notes = existing.notes;
  let tags = existing.tags;
  let imageUrl = existing.image_url;
  let siteName = existing.site_name;

  if (body.url != null && String(body.url).trim()) {
    url = String(body.url).trim();
    urlHash = generateUrlHash(url);
    // prevent collision with another personal link
    const clash = await findExistingLink(env, 'personal_links', 'user_id', userId, url, id);
    if (clash) {
      return Response.json({ success: false, error: 'Another link already uses that URL' }, { status: 409, headers: corsHeaders });
    }
  }
  if (body.title != null) title = String(body.title).trim().slice(0, 300);
  if (body.notes != null) notes = String(body.notes).trim().slice(0, 2500);
  if (body.tags != null) tags = JSON.stringify(Array.isArray(body.tags) ? body.tags : body.tags);
  if (body.image_url != null) imageUrl = String(body.image_url).trim().slice(0, 500);
  if (body.site_name != null) siteName = String(body.site_name).trim().slice(0, 120);

  await ensureLinkMetaColumns(env);
  try {
    await env.DB.prepare(
      `UPDATE personal_links SET url = ?, url_hash = ?, title = ?, notes = ?, tags = ?, image_url = ?, site_name = ?
       WHERE id = ? AND user_id = ?`
    ).bind(url, urlHash, title, notes, tags, imageUrl || null, siteName || null, id, userId).run();
  } catch (_) {
    await env.DB.prepare(
      `UPDATE personal_links SET url = ?, url_hash = ?, title = ?, notes = ?, tags = ?
       WHERE id = ? AND user_id = ?`
    ).bind(url, urlHash, title, notes, tags, id, userId).run();
  }

  const ghPatch = await storeMutateLink(env, 'personal', userId, id, {
    url, url_hash: urlHash, title, notes,
    tags: (() => { try { return JSON.parse(tags || '[]'); } catch (_) { return []; } })(),
    image_url: imageUrl || null, site_name: siteName || null,
  });
  if (ghPatch.handled && !ghPatch.ok) {
    return Response.json({ success: false, error: `GitHub write failed: ${ghPatch.error}` }, { status: 502, headers: corsHeaders });
  }

  return Response.json({
    success: true,
    id,
    url,
    title,
    notes,
    image_url: imageUrl || '',
    site_name: siteName || ''
  }, { headers: corsHeaders });
}

async function handlePatchCommunityLink(request, user, env, corsHeaders) {
  const body = await request.json();
  const id = body.id;
  if (!id) {
    return Response.json({ success: false, error: 'id required' }, { status: 400, headers: corsHeaders });
  }
  const existing = await env.DB.prepare('SELECT * FROM links WHERE id = ?').bind(id).first();
  if (!existing) {
    return Response.json({ success: false, error: 'Not found' }, { status: 404, headers: corsHeaders });
  }
  const gate = await requireActiveMember(env, existing.community_id, user, corsHeaders);
  if (gate) return gate;
  // author or staff can edit. Links dumped by the bot before the sender was linked to
  // an Athena account have added_by_user_id = NULL — those are staff-only, not open
  // season for every member.
  const staff = await ensureOwnerOrAdmin(existing.community_id, user.id, env);
  if (!staff && existing.added_by_user_id !== user.id) {
    return Response.json({ success: false, error: 'Only author or admin can edit' }, { status: 403, headers: corsHeaders });
  }

  let url = existing.url;
  let urlHash = existing.url_hash;
  let title = existing.title;
  let notes = existing.notes;
  let tags = existing.tags;
  let imageUrl = existing.image_url;
  let siteName = existing.site_name;

  if (body.url != null && String(body.url).trim()) {
    url = String(body.url).trim();
    urlHash = generateUrlHash(url);
    const clash = await findExistingLink(env, 'links', 'community_id', existing.community_id, url, id);
    if (clash) {
      return Response.json({ success: false, error: 'Another link already uses that URL' }, { status: 409, headers: corsHeaders });
    }
  }
  if (body.title != null) title = String(body.title).trim().slice(0, 300);
  if (body.notes != null) notes = String(body.notes).trim().slice(0, 2500);
  if (body.tags != null) tags = JSON.stringify(Array.isArray(body.tags) ? body.tags : body.tags);
  if (body.image_url != null) imageUrl = String(body.image_url).trim().slice(0, 500);
  if (body.site_name != null) siteName = String(body.site_name).trim().slice(0, 120);

  await ensureLinkMetaColumns(env);
  try {
    await env.DB.prepare(
      `UPDATE links SET url = ?, url_hash = ?, title = ?, notes = ?, tags = ?, image_url = ?, site_name = ?
       WHERE id = ?`
    ).bind(url, urlHash, title, notes, tags, imageUrl || null, siteName || null, id).run();
  } catch (_) {
    await env.DB.prepare(
      `UPDATE links SET url = ?, url_hash = ?, title = ?, notes = ?, tags = ? WHERE id = ?`
    ).bind(url, urlHash, title, notes, tags, id).run();
  }

  const ghPatch = await storeMutateLink(env, 'community', existing.community_id, id, {
    url, url_hash: urlHash, title, notes,
    tags: (() => { try { return JSON.parse(tags || '[]'); } catch (_) { return []; } })(),
    image_url: imageUrl || null, site_name: siteName || null,
  });
  if (ghPatch.handled && !ghPatch.ok) {
    return Response.json({ success: false, error: `GitHub write failed: ${ghPatch.error}` }, { status: 502, headers: corsHeaders });
  }

  return Response.json({
    success: true,
    id,
    url,
    title,
    notes,
    image_url: imageUrl || '',
    site_name: siteName || ''
  }, { headers: corsHeaders });
}

// ============================================================
// Telegram Webhook — personal/community dump, search, delete, approve
// ============================================================

async function ensurePendingTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS telegram_pending (
      id TEXT PRIMARY KEY,
      community_id TEXT NOT NULL,
      url TEXT NOT NULL,
      url_hash TEXT NOT NULL,
      title TEXT,
      notes TEXT,
      proposed_by TEXT,
      proposed_by_tg TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL
    )`
  ).run();
}

async function findTelegramBinding(env, chatId, tgUserId) {
  await ensureBotBindingColumns(env);
  const cid = String(chatId);
  // Exact chat match first (group or DM)
  const binding = await env.DB.prepare(
    `SELECT * FROM community_bots WHERE platform = 'telegram' AND group_id = ?`
  ).bind(cid).first();
  if (binding) {
    if (!binding.dump_link_mode) binding.dump_link_mode = 'smart';
    return binding;
  }

  // Private chats only: fall back to owner's personal bot (groups must use /community_verify)
  const isPrivate = !cid.startsWith('-');
  if (isPrivate && tgUserId) {
    const byUser = await env.DB.prepare(
      `SELECT b.* FROM community_bots b
       JOIN users u ON (u.id = b.user_id OR u.id = b.created_by)
       WHERE b.platform = 'telegram'
         AND COALESCE(b.scope, 'personal') = 'personal'
         AND u.provider = 'telegram' AND u.provider_id = ?
       ORDER BY b.created_at DESC LIMIT 1`
    ).bind(String(tgUserId)).first();
    if (byUser) {
      if (!byUser.dump_link_mode) byUser.dump_link_mode = 'smart';
      return byUser;
    }
  }

  const legacy = await env.DB.prepare(
    'SELECT community_id FROM telegram_bots WHERE telegram_group_id = ?'
  ).bind(cid).first();
  if (legacy?.community_id) {
    return { scope: 'community', community_id: legacy.community_id, user_id: null, created_by: null };
  }
  return null;
}

/** Find personal bot binding owned by this Athena user (any token match optional). */
async function findPersonalBotForOwner(env, ownerUserId) {
  if (!ownerUserId) return null;
  return await env.DB.prepare(
    `SELECT * FROM community_bots
     WHERE platform = 'telegram'
       AND COALESCE(scope, 'personal') = 'personal'
       AND (created_by = ? OR user_id = ?)
     ORDER BY created_at DESC LIMIT 1`
  ).bind(ownerUserId, ownerUserId).first();
}

/** Get the log_channel_id from the personal bot binding for the given owner. */
async function getLogChannelId(env, ownerUserId) {
  if (!ownerUserId) return null;
  try {
    const binding = await env.DB.prepare(
      `SELECT log_channel_id FROM community_bots
       WHERE platform = 'telegram'
         AND COALESCE(scope, 'personal') = 'personal'
         AND (created_by = ? OR user_id = ?)
         AND log_channel_id IS NOT NULL AND log_channel_id != ''
       ORDER BY created_at DESC LIMIT 1`
    ).bind(ownerUserId, ownerUserId).first();
    return binding?.log_channel_id || null;
  } catch (_) { return null; }
}

async function isBotOwnerTg(env, binding, tgUserId, athenaUser) {
  if (!binding) return false;
  if (athenaUser && (binding.created_by === athenaUser.id || binding.user_id === athenaUser.id)) return true;
  if (!tgUserId) return false;
  const ownerId = binding.created_by || binding.user_id;
  if (!ownerId) return false;
  const owner = await env.DB.prepare('SELECT provider, provider_id FROM users WHERE id = ?').bind(ownerId).first();
  return owner && owner.provider === 'telegram' && String(owner.provider_id) === String(tgUserId);
}

async function resolveCommunityByIdOrName(env, ownerUserId, query) {
  const q = String(query || '').trim();
  if (!q) return null;
  // Exact id (member or creator)
  let c = await env.DB.prepare(
    `SELECT c.* FROM communities c
     LEFT JOIN community_members m ON m.community_id = c.id AND m.user_id = ?
     WHERE c.id = ? AND (m.user_id IS NOT NULL OR c.creator_id = ?)`
  ).bind(ownerUserId, q, ownerUserId).first();
  if (c) return c;
  c = await env.DB.prepare('SELECT * FROM communities WHERE id = ? AND creator_id = ?').bind(q, ownerUserId).first();
  if (c) return c;
  // Name match (case-insensitive)
  c = await env.DB.prepare(
    `SELECT c.* FROM communities c
     INNER JOIN community_members m ON m.community_id = c.id
     WHERE m.user_id = ? AND lower(c.name) = lower(?)
     ORDER BY c.created_at DESC LIMIT 1`
  ).bind(ownerUserId, q).first();
  if (c) return c;
  c = await env.DB.prepare(
    `SELECT * FROM communities WHERE creator_id = ? AND lower(name) = lower(?)
     ORDER BY created_at DESC LIMIT 1`
  ).bind(ownerUserId, q).first();
  if (c) return c;
  // Partial name
  c = await env.DB.prepare(
    `SELECT c.* FROM communities c
     INNER JOIN community_members m ON m.community_id = c.id
     WHERE m.user_id = ? AND lower(c.name) LIKE ?
     ORDER BY c.created_at DESC LIMIT 1`
  ).bind(ownerUserId, `%${q.toLowerCase()}%`).first();
  if (c) return c;
  c = await env.DB.prepare(
    `SELECT * FROM communities WHERE creator_id = ? AND lower(name) LIKE ?
     ORDER BY created_at DESC LIMIT 1`
  ).bind(ownerUserId, `%${q.toLowerCase()}%`).first();
  return c || null;
}

/** Fully remove a community and related rows (owner only). Keeps personal bot bindings. */
async function deleteCommunityFully(env, communityId) {
  if (!communityId || communityId === 'default') {
    return { ok: false, error: 'Cannot delete this community' };
  }
  const c = await env.DB.prepare('SELECT id, name FROM communities WHERE id = ?').bind(communityId).first();
  if (!c) return { ok: false, error: 'Community not found' };

  // Collect link ids for vote/report cleanup
  const { results: linkRows } = await env.DB.prepare(
    'SELECT id FROM links WHERE community_id = ?'
  ).bind(communityId).all();
  for (const row of (linkRows || [])) {
    try { await env.DB.prepare('DELETE FROM link_votes WHERE link_id = ?').bind(row.id).run(); } catch (_) {}
    try { await env.DB.prepare('DELETE FROM link_reports WHERE link_id = ?').bind(row.id).run(); } catch (_) {}
  }
  try { await env.DB.prepare('DELETE FROM links WHERE community_id = ?').bind(communityId).run(); } catch (_) {}
  try {
    await ensureDocumentsTable(env);
    await clearActiveDocumentFolder(env, 'community', communityId);
    await env.DB.prepare("DELETE FROM uploaded_documents WHERE scope = 'community' AND community_id = ?").bind(communityId).run();
  } catch (_) {}
  try { await env.DB.prepare('DELETE FROM link_reports WHERE community_id = ?').bind(communityId).run(); } catch (_) {}
  try { await env.DB.prepare('DELETE FROM community_admins WHERE community_id = ?').bind(communityId).run(); } catch (_) {}
  try { await env.DB.prepare('DELETE FROM community_members WHERE community_id = ?').bind(communityId).run(); } catch (_) {}
  try { await env.DB.prepare('DELETE FROM notifications WHERE community_id = ?').bind(communityId).run(); } catch (_) {}
  try { await env.DB.prepare('DELETE FROM telegram_pending WHERE community_id = ?').bind(communityId).run(); } catch (_) {}
  try { await env.DB.prepare('DELETE FROM telegram_bots WHERE community_id = ?').bind(communityId).run(); } catch (_) {}
  try { await ensureBanTable(env); await env.DB.prepare('DELETE FROM community_bans WHERE community_id = ?').bind(communityId).run(); } catch (_) {}
  try { await ensurePendingDeletesTable(env); await env.DB.prepare('DELETE FROM pending_community_deletes WHERE community_id = ?').bind(communityId).run(); } catch (_) {}

  // Remove group bot bindings for this community (not personal bots)
  try {
    await env.DB.prepare(
      `DELETE FROM community_bots WHERE community_id = ? AND COALESCE(scope, 'community') = 'community'`
    ).bind(communityId).run();
  } catch (_) {
    await env.DB.prepare('DELETE FROM community_bots WHERE community_id = ?').bind(communityId).run();
  }
  // Clear community_id on any leftover rows
  try {
    await env.DB.prepare(
      `UPDATE community_bots SET community_id = NULL, scope = 'personal' WHERE community_id = ?`
    ).bind(communityId).run();
  } catch (_) {}

  // Same rule as /clear_db: remove the Markdown only when GitHub is active.
  await clearActiveStoreFolder(env, 'community', communityId);
  try {
    await ensureParkingTables(env);
    await env.DB.prepare('DELETE FROM parked_links WHERE community_id = ?').bind(communityId).run();
  } catch (_) {}

  await env.DB.prepare('DELETE FROM communities WHERE id = ?').bind(communityId).run();
  return { ok: true, name: c.name, id: c.id };
}

async function saveCommunityUrlDirect(env, token, binding, rawUrl, senderName, athenaUser, chatId, userNotes = '', titleHint = '', threadId = null) {
  const communityId = binding.community_id;
  if (!communityId) {
    await sendTelegramMessage(token, chatId, 'Group not linked as community. Owner: /community_verify', threadId);
    return;
  }
  if (!athenaUser) {
    await sendTelegramMessage(token, chatId,
      'Login on the website with Telegram, then /community_join ' + communityId, threadId);
    return;
  }
  // Left/kicked/banned from group → ban; rejoined → unban
  if (!(isInstanceOwnerUser(athenaUser, env))) {
    const presence = await syncCommunityGroupPresence(env, communityId, athenaUser);
    if (!presence.inGroup) {
      await sendTelegramMessage(token, chatId,
        'You are not in this Telegram group — access revoked. Rejoin the group, then dump again.', threadId);
      return;
    }
  }
  if (await isBannedFromCommunity(env, communityId, athenaUser)) {
    await sendTelegramMessage(token, chatId, 'You are banned from this community.', threadId);
    return;
  }
  if (!(await ensureMember(communityId, athenaUser.id, env))) {
    await sendTelegramMessage(token, chatId,
      `Join first: /community_join ${communityId}\n(Login on website, then run this command.)`, threadId);
    return;
  }
  const urlHash = generateUrlHash(rawUrl);
  const existing = await findExistingLink(env, 'links', 'community_id', communityId, rawUrl);
  if (existing) {
    await sendTelegramMessage(token, chatId, `Already in community: ${rawUrl}`, threadId);
    return;
  }
  const meta = await enrichLinkFields(env, rawUrl, { title: titleHint || '', notes: userNotes || '' });
  if (titleHint && isWeakTitle(meta.title, rawUrl)) meta.title = titleHint;
  const id = 'tg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  await ensureLinkMetaColumns(env);

  // Busiest write path in the app — many members dumping into one group. The
  // append helper retries on commit conflicts so links are not silently dropped.
  const ghDump = await storeAddLink(env, 'community', communityId, {
    id, url: rawUrl, url_hash: urlHash, title: meta.title, notes: meta.notes || '',
    tags: ['telegram', 'community'], created_at: Date.now(),
    added_by_name: senderName, added_by_user_id: athenaUser?.id || null,
    image_url: meta.image_url, site_name: meta.site_name,
  });
  if (ghDump.handled && !ghDump.ok) {
    await sendTelegramMessage(token, chatId, `Could not save to GitHub: ${ghDump.error}`, threadId);
    return;
  }

  try {
    await env.DB.prepare(
      `INSERT INTO links (id, community_id, url, url_hash, title, notes, tags, added_by,
        added_by_user_id, added_by_provider, added_by_name, upvotes, downvotes, created_at, image_url, site_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'telegram', ?, 0, 0, ?, ?, ?)`
    ).bind(
      id, communityId, rawUrl, urlHash, meta.title, meta.notes || '',
      JSON.stringify(['telegram', 'community']),
      senderName, athenaUser?.id || null, senderName,
      Date.now(), meta.image_url || null, meta.site_name || null
    ).run();
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      await sendTelegramMessage(token, chatId, `Already in community: ${rawUrl}`, threadId);
      return;
    }
    if (!isMissingLinkMetaColumnError(error)) {
      await sendTelegramMessage(token, chatId, `Could not save link: ${error.message || 'database insert failed'}`, threadId);
      return;
    }
    await env.DB.prepare(
      'INSERT INTO links (id, community_id, url, url_hash, title, notes, tags, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, communityId, rawUrl, urlHash, meta.title, meta.notes || '', JSON.stringify(['telegram']), senderName, Date.now()).run();
  }
  let reply;
  try {
    const vocab = await recentTagsForScope(env, 'community', communityId);
    const ai = await aiDescribeAndTag(env, rawUrl, meta, vocab);
    if (ai) {
      const merged = ai.tags?.length
        ? [...new Set([...['telegram', 'community'], ...ai.tags])].slice(0, 8)
        : ['telegram', 'community'];
      try {
        await env.DB.prepare('UPDATE links SET tags = ?, notes = ?, metadata_version = 2 WHERE id = ?')
          .bind(JSON.stringify(merged), ai.description || meta.notes || '', id).run();
        await storeMutateLink(env, 'community', communityId, id, { notes: ai.description || '', tags: merged });
      } catch (_) {}
      reply = formatSavedLinkReply('community', meta.title, rawUrl, ai);
    } else {
      reply = formatSavedLinkReply('community', meta.title, rawUrl, null, meta.notes);
    }
  } catch (_) {
    reply = formatSavedLinkReply('community', meta.title, rawUrl, null, meta.notes);
  }
  await sendTelegramMessage(token, chatId, reply, threadId);
}

/** Decrypt a stored bot_token (enc:v1:...) for use; plaintext rows pass through.
 *  Null on a wrong/missing STORAGE_KEY — callers fall back to env.TELEGRAM_BOT_TOKEN. */
async function decryptBotToken(env, stored) {
  if (!stored) return stored;
  return await decryptSecret(env, stored);
}

/** tokenForBinding variant that decrypts the stored token before returning. */
async function tokenForBindingAsync(binding, env) {
  const raw = (binding && binding.bot_token) || env.TELEGRAM_BOT_TOKEN || null;
  if (!raw) return null;
  if (binding?.bot_token) return await decryptBotToken(env, raw);
  return raw;
}

async function resolveAthenaUserFromTg(env, tgUserId) {
  await ensureCommunityMembersColumns(env);
  const tid = tgUserId ? String(tgUserId) : null;
  if (!tid) return null;
  // OIDC sub (provider_id) OR stored Bot API id — sender only, never binding owner
  let u = await env.DB.prepare(
    `SELECT * FROM users WHERE provider = 'telegram' AND (provider_id = ? OR telegram_api_id = ?)`
  ).bind(tid, tid).first();
  if (u) return u;
  // Personal bot DM chat id = Bot API user id (OIDC sub often differs) — only that owner
  u = await env.DB.prepare(
    `SELECT u.* FROM community_bots b
     JOIN users u ON (u.id = b.created_by OR u.id = b.user_id)
     WHERE b.platform = 'telegram'
       AND COALESCE(b.scope, 'personal') = 'personal'
       AND b.group_id = ?
     ORDER BY b.created_at DESC LIMIT 1`
  ).bind(tid).first();
  if (u) {
    try {
      await env.DB.prepare('UPDATE users SET telegram_api_id = ? WHERE id = ?').bind(tid, u.id).run();
    } catch (_) {}
    return u;
  }
  return null;
}

async function isTgUserCommunityStaff(env, communityId, tgUserId, athenaUser) {
  if (athenaUser && (await ensureOwnerOrAdmin(communityId, athenaUser.id, env))) return true;
  // platform admin IDs table
  if (tgUserId) {
    const adm = await env.DB.prepare(
      `SELECT 1 FROM community_admins WHERE community_id = ? AND platform = 'telegram' AND platform_user_id = ?`
    ).bind(communityId, String(tgUserId)).first();
    if (adm) return true;
  }
  return false;
}

function extractUrls(text) {
  const m = String(text || '').match(/https?:\/\/[^\s<>"')\]]+/gi);
  return m ? m.map(u => u.replace(/[),.;]+$/g, '')) : [];
}

/**
 * Telegram stores hyperlinks as message entities (text_link / url), especially
 * in photo captions and formatted posts — plain text may omit the real URL.
 */
function extractUrlsFromTelegramMessage(msg, { includeReply = false } = {}) {
  const urls = new Set();
  const texts = [msg?.text, msg?.caption].filter(Boolean);
  for (const t of texts) {
    for (const u of extractUrls(t)) urls.add(u);
  }

  function collectFrom(entities, source) {
    if (!entities || !entities.length) return;
    for (const ent of entities) {
      if (ent.type === 'text_link' && ent.url) {
        urls.add(String(ent.url).replace(/[),.;]+$/g, ''));
      } else if (ent.type === 'url' && source && typeof ent.offset === 'number') {
        try {
          let raw = source.substr(ent.offset, ent.length);
          if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
          urls.add(raw.replace(/[),.;]+$/g, ''));
        } catch (_) {}
      }
    }
  }

  collectFrom(msg?.entities, msg?.text || '');
  collectFrom(msg?.caption_entities, msg?.caption || '');
  // Only when explicitly requested (e.g. /delete reply) — never for plain dumps
  if (includeReply && msg?.reply_to_message) {
    const r = msg.reply_to_message;
    collectFrom(r.entities, r.text || '');
    collectFrom(r.caption_entities, r.caption || '');
    for (const u of extractUrls(r.text || r.caption || '')) urls.add(u);
  }

  return [...urls].filter(u => /^https?:\/\//i.test(u));
}

/** Full caption/body for multi-link posts (keep structure, trim noise) */
function telegramFullPostText(msg) {
  // Own message only — never pull replied-to content into dump notes
  return (msg?.text || msg?.caption || '').trim();
}

/** Caption / body text excluding URLs — used as user-provided detail */
function telegramUserNotes(msg) {
  let t = telegramFullPostText(msg);
  // strip bare urls so leftover is the written detail
  t = t.replace(/https?:\/\/[^\s<>"')\]]+/gi, ' ').replace(/\s+/g, ' ').trim();
  return t;
}

/**
 * Score a URL as primary resource for a multi-link channel post.
 * Higher = better candidate for the single brain entry.
 */
function scoreUrlAsPrimary(rawUrl, fullText = '') {
  let score = 0;
  let host;
  let path;
  let segs;
  try {
    const u = new URL(rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`);
    host = u.hostname.replace(/^www\./, '').toLowerCase();
    path = (u.pathname || '/').replace(/\/$/, '') || '/';
    segs = path.split('/').filter(Boolean);
  } catch (_) {
    return { score: 0, kind: 'unknown' };
  }

  const lower = fullText.toLowerCase();
  const pathL = path.toLowerCase();

  // Host class
  if (host === 'github.com' || host === 'gitlab.com' || host === 'codeberg.org') {
    score += 40;
    if (segs.length === 2) {
      score += 50; // user/repo root — best
      return { score, kind: 'repo' };
    }
    if (segs.length >= 3 && /^(releases|tags|download)/i.test(segs[2])) {
      score += 30; // downloadable release
      return { score, kind: 'release' };
    }
    if (segs.length === 1) {
      score += 5; // profile only
      return { score, kind: 'profile' };
    }
    if (/issues|pull|wiki|actions|commit|tree|blob/i.test(pathL)) score -= 10;
    return { score: score + 15, kind: 'repo-sub' };
  }

  if (/npmjs\.com|pypi\.org|crates\.io|packagist/i.test(host)) {
    score += 55;
    return { score, kind: 'package' };
  }
  if (/play\.google\.com|apps\.apple\.com|f-droid\.org/i.test(host)) {
    score += 50;
    return { score, kind: 'store' };
  }
  if (/youtube\.com|youtu\.be|vimeo\.com/i.test(host)) {
    score += 35;
    return { score, kind: 'video' };
  }
  if (/t\.me|telegram\.me|telegram\.dog/i.test(host)) {
    score -= 20; // channel/internal links — rarely the “product”
    return { score, kind: 'telegram' };
  }
  if (/twitter\.com|x\.com|instagram\.com|facebook\.com|discord\.gg/i.test(host)) {
    score -= 15;
    return { score, kind: 'social' };
  }
  if (/buymeacoffee|ko-fi|patreon|paypal/i.test(host)) {
    score -= 25;
    return { score, kind: 'donate' };
  }

  // Label hints near URL in caption
  if (/source\s*code|github|repo|repository|official/i.test(lower)) score += 8;
  if (/download|release|apk|install/i.test(lower) && /github\.com.*release/i.test(rawUrl)) score += 5;

  score += 20; // generic web
  return { score, kind: 'web' };
}

/**
 * From a multi-link Telegram post, pick 1 primary URL (optionally keep related list).
 * Prefer: package/store/repo root > release > other > telegram/social/profile/donate.
 */
function selectPrimaryLinks(urls, fullText = '') {
  const unique = [...new Set((urls || []).map(u => u.trim()).filter(Boolean))];
  if (unique.length <= 1) {
    return { primary: unique, related: [], mode: 'single' };
  }

  const ranked = unique.map(url => {
    const { score, kind } = scoreUrlAsPrimary(url, fullText);
    return { url, score, kind };
  }).sort((a, b) => b.score - a.score);

  // Prefer repo root over release when both for same project
  const repo = ranked.find(r => r.kind === 'repo');
  const release = ranked.find(r => r.kind === 'release');
  let primary = ranked[0];

  if (repo && release) {
    // same owner/name?
    try {
      const r1 = new URL(repo.url);
      const r2 = new URL(release.url);
      const s1 = r1.pathname.split('/').filter(Boolean).slice(0, 2).join('/');
      const s2 = r2.pathname.split('/').filter(Boolean).slice(0, 2).join('/');
      if (s1 && s1 === s2) primary = repo; // keep source as main
    } catch (_) {
      primary = repo.score >= release.score ? repo : ranked[0];
    }
  } else if (repo) {
    primary = repo;
  } else if (release) {
    primary = release;
  }

  // Drop near-duplicates of same project (releases/profile of same github project)
  const related = ranked
    .filter(r => r.url !== primary.url)
    .filter(r => {
      if (r.kind === 'donate' || r.kind === 'social') return true; // list but don't save
      if (r.kind === 'telegram') return true;
      if (r.kind === 'profile') return true;
      if (primary.kind === 'repo' && r.kind === 'release') {
        try {
          const a = new URL(primary.url).pathname.split('/').filter(Boolean).slice(0, 2).join('/');
          const b = new URL(r.url).pathname.split('/').filter(Boolean).slice(0, 2).join('/');
          return a === b; // related only
        } catch (_) { return true; }
      }
      return true;
    })
    .map(r => r.url);

  return {
    primary: [primary.url],
    related,
    mode: 'smart',
    ranking: ranked
  };
}

/**
 * Clean multi-link channel captions into readable notes.
 * Keep: title + description (+ optional special thanks).
 * Drop: Links block, support/donate fluff, hashtags.
 */
function buildMultiLinkNotes(fullText) {
  let body = String(fullText || '').trim();

  // Hard-stop before thanks / support / social fluff (keep only title + description)
  body = body.replace(/\n\s*🫂[\s\S]*$/u, '');
  body = body.replace(/\n\s*A special thanks[\s\S]*$/i, '');
  body = body.replace(/\n\s*(?:❤️\s*)?Support the Project[\s\S]*$/i, '');
  body = body.replace(/\n\s*(?:⭐️|⭐)\s*Star the (?:repo|app)[\s\S]*$/i, '');
  body = body.replace(/\n\s*tags:\s*#.*$/im, '');
  body = body.replace(/\n\s*(?:#\w[\w-]*\s*){2,}\s*$/im, '');

  // Remove entire "Links:" sections
  body = body.replace(
    /🔗\s*Links?:[\s\S]*?(?=\n\s*\n\s*🫂|\n\s*🫂|\n\s*A special thanks|\n\s*❤️|\n\s*tags:|$)/gi,
    '\n'
  );
  body = body.replace(
    /^Links?:\s*$[\s\S]*?(?=\n\s*\n|\n\s*🫂|\n\s*A special thanks|\n\s*tags:|$)/gim,
    '\n'
  );

  const dropLine =
    /^\s*[-•*]?\s*(Download|Screenshots?|Features?|Source\s*code|Demo|Docs?|Website|Homepage|Mirror|APK|Play\s*Store|App\s*Store|Developer)\s*[:.]?\s*.*$/i;

  const lines = body.split('\n');
  const kept = [];
  for (const line of lines) {
    const L = line.trim();
    if (!L) {
      if (kept.length && kept[kept.length - 1] !== '') kept.push('');
      continue;
    }
    if (/^https?:\/\//i.test(L)) continue;
    if (dropLine.test(L)) continue;
    if (/^tags:/i.test(L) || /^(?:#\w[\w-]*\s*)+$/i.test(L)) continue;
    if (/^❤️|^⭐️|^⭐|^☕️|^🛠|^☕|^🫂/.test(L)) continue;
    if (/special thanks|buy a coffee|contribute code|star the repo|show some love/i.test(L)) continue;
    if (/^if this project makes/i.test(L)) continue;
    if (/^support the project/i.test(L)) continue;
    if (/^developer:/i.test(L)) continue;

    let cleaned = L.replace(/\(https?:\/\/[^)]+\)/g, '').trim();
    cleaned = cleaned.replace(/https?:\/\/[^\s<>"')\]]+/gi, '').trim();
    cleaned = cleaned.replace(/\s{2,}/g, ' ').replace(/\s+([,.;:])/g, '$1');
    if (!cleaned || /^[-•*]\s*$/.test(cleaned)) continue;
    if (/^🔗/.test(cleaned)) continue;
    kept.push(cleaned);
  }

  let notes = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  // Keep full caption notes (send layer splits at Telegram 4096)
  if (notes.length > 8000) notes = notes.slice(0, 7990) + '…';

  // Title hint: first short non-tag line (e.g. "Stride")
  let titleHint = '';
  for (const line of notes.split(/\n+/)) {
    const L = line.trim();
    if (!L || /^tags:/i.test(L) || /^#\w/.test(L)) continue;
    if (L.length >= 2 && L.length <= 80) {
      titleHint = L.replace(/^[*_]+|[*_]+$/g, '').trim();
      break;
    }
  }
  return { notes, titleHint };
}

/** Clean display title = host/path only (no "Link from Telegram…") */
function titleFromUrl(rawUrl) {
  try {
    const u = new URL(rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`);
    const host = u.hostname.replace(/^www\./, '');
    let path = u.pathname.replace(/\/$/, '');
    if (path === '/') path = '';
    return (host + path) || rawUrl;
  } catch (_) {
    return rawUrl;
  }
}

// ---------------------------------------------------------------------------
// Whole-corpus search
//
// Search and AI used to pull the newest 200-300 rows and match inside that
// window, so anything older was invisible no matter how good the match. These
// helpers push the filter into SQL so every row is considered, however many
// Markdown files the corpus spans.
//
// search_blob holds a lowercased, alphanumeric-only copy of title+url+notes+tags
// so a collapsed query ("ytdlp") still matches "yt-dlp" — the same trick
// fuzzyMatchLinks does in JS, but done where the whole table can be scanned.
// ---------------------------------------------------------------------------

async function ensureSearchColumns(env) {
  for (const sql of [
    'ALTER TABLE personal_links ADD COLUMN search_blob TEXT',
    'ALTER TABLE links ADD COLUMN search_blob TEXT',
  ]) {
    try { await env.DB.prepare(sql).run(); } catch (_) {}
  }
}

function buildSearchBlob(row) {
  let tags = row.tags;
  if (typeof tags === 'string') { try { tags = JSON.parse(tags); } catch (_) { /* keep raw */ } }
  const bag = [row.title, row.url, row.notes, Array.isArray(tags) ? tags.join(' ') : tags]
    .filter(Boolean).join(' ').toLowerCase();
  return bag.replace(/[^a-z0-9]/g, '');
}

/** Fill in search_blob for rows that do not have one yet. Incremental. */
async function backfillSearchBlobs(env, table, whereCol, whereVal, batch = 400) {
  await ensureSearchColumns(env);
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, title, url, notes, tags FROM ${table}
       WHERE ${whereCol} = ? AND (search_blob IS NULL OR search_blob = '')
       LIMIT ${batch}`
    ).bind(whereVal).all();
    for (const r of (results || [])) {
      await env.DB.prepare(`UPDATE ${table} SET search_blob = ? WHERE id = ?`)
        .bind(buildSearchBlob(r), r.id).run();
    }
    return (results || []).length;
  } catch (_) { return 0; }
}

/**
 * Candidate rows for a query across the ENTIRE store — no recency window.
 * Returns [] for an empty query so callers can fall back to "recent".
 */
async function searchAllLinks(env, scope, key, query, limit = 200) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return [];
  const table = scope === 'personal' ? 'personal_links' : 'links';
  const col = scope === 'personal' ? 'user_id' : 'community_id';
  await backfillSearchBlobs(env, table, col, key);

  const collapsed = q.replace(/[^a-z0-9]/g, '');
  const like = `%${q}%`;
  const likeCollapsed = `%${collapsed}%`;
  try {
    const { results } = await env.DB.prepare(
      `SELECT * FROM ${table}
       WHERE ${col} = ?
         AND ( lower(COALESCE(title,'')) LIKE ?
            OR lower(COALESCE(url,'')) LIKE ?
            OR lower(COALESCE(notes,'')) LIKE ?
            OR (LENGTH(?) >= 2 AND COALESCE(search_blob,'') LIKE ?) )
       ORDER BY created_at DESC
       LIMIT ${limit}`
    ).bind(key, like, like, like, collapsed, likeCollapsed).all();
    await ensureDocumentsTable(env);
    const docCol = scope === 'personal' ? 'user_id' : 'community_id';
    const { results: documents } = await env.DB.prepare(
      `SELECT * FROM uploaded_documents
       WHERE scope = ? AND ${docCol} = ?
         AND (lower(filename) LIKE ? OR lower(content) LIKE ?)
       ORDER BY created_at DESC LIMIT ${limit}`
    ).bind(scope, key, like, like).all();
    return [...(results || []), ...(documents || []).map(documentAsLink)];
  } catch (_) { return []; }
}

/**
 * Rows to search over: every match in the store, plus the recent tail as a
 * fallback so an empty or unmatched query still has something to show.
 */
async function candidateLinks(env, scope, key, query, recentLimit = 300) {
  const matches = await searchAllLinks(env, scope, key, query);
  const table = scope === 'personal' ? 'personal_links' : 'links';
  const col = scope === 'personal' ? 'user_id' : 'community_id';
  const { results: recent } = await env.DB.prepare(
    `SELECT * FROM ${table} WHERE ${col} = ? ORDER BY created_at DESC LIMIT ${recentLimit}`
  ).bind(key).all();
  await ensureDocumentsTable(env);
  const { results: recentDocuments } = await env.DB.prepare(
    `SELECT * FROM uploaded_documents WHERE scope = ? AND ${col} = ? ORDER BY created_at DESC LIMIT ${recentLimit}`
  ).bind(scope, key).all();

  const byId = new Map();
  for (const r of matches) byId.set(r.id, r);
  for (const r of (recent || [])) if (!byId.has(r.id)) byId.set(r.id, r);
  for (const r of (recentDocuments || []).map(documentAsLink)) if (!byId.has(r.id)) byId.set(r.id, r);
  return [...byId.values()];
}

function fuzzyMatchLinks(rows, query) {
  const q = String(query || '').toLowerCase().trim();
  const qa = q.replace(/[^a-z0-9]/g, '');
  if (!q) return rows.slice(0, 8);
  return rows.filter(r => {
    const bag = [r.title, r.url, r.notes, r.tags].join(' ').toLowerCase();
    const ba = bag.replace(/[^a-z0-9]/g, '');
    return bag.includes(q) || (qa.length >= 2 && ba.includes(qa));
  }).slice(0, 8);
}

async function savePersonalUrl(env, userId, rawUrl, senderName, userNotes = '', titleHint = '') {
  const urlHash = generateUrlHash(rawUrl);
  const existing = await findExistingLink(env, 'personal_links', 'user_id', userId, rawUrl);
  if (existing) return { duplicate: true, existing };
  await ensureLinkMetaColumns(env);
  // Detailed caption/post text → keep as notes, skip scrape overwrite
  const meta = await enrichLinkFields(env, rawUrl, {
    title: titleHint || '',
    notes: userNotes || ''
  });
  // Prefer caption title when it's a short project name
  if (titleHint && titleHint.length >= 2 && titleHint.length <= 80 && isWeakTitle(meta.title, rawUrl)) {
    meta.title = titleHint;
  } else if (titleHint && titleHint.length >= 2 && titleHint.length <= 60 && meta.title && !meta.title.toLowerCase().includes(titleHint.toLowerCase())) {
    // keep scraped title if richer (e.g. GitHub full name)
  }
  const id = 'tgpl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const ghPersonal = await storeAddLink(env, 'personal', userId, {
    id, url: rawUrl, url_hash: urlHash, title: meta.title, notes: meta.notes,
    tags: ['telegram', 'dump'], created_at: Date.now(),
    added_by_name: senderName, image_url: meta.image_url, site_name: meta.site_name,
  });
  if (ghPersonal.handled && !ghPersonal.ok) {
    return { duplicate: false, error: `GitHub write failed: ${ghPersonal.error}` };
  }
  try {
    await env.DB.prepare(
      `INSERT INTO personal_links (id, user_id, url, url_hash, title, notes, tags, created_at, image_url, site_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, userId, rawUrl, urlHash, meta.title, meta.notes, JSON.stringify(['telegram', 'dump']), Date.now(), meta.image_url || null, meta.site_name || null).run();
  } catch (error) {
    if (isUniqueConstraintError(error)) return { duplicate: true, existing: { url: rawUrl } };
    if (!isMissingLinkMetaColumnError(error)) return { duplicate: false, error: `Database write failed: ${error.message || 'insert failed'}` };
    await env.DB.prepare(
      `INSERT INTO personal_links (id, user_id, url, url_hash, title, notes, tags, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, userId, rawUrl, urlHash, meta.title, meta.notes, JSON.stringify(['telegram', 'dump']), Date.now()).run();
  }
  return { duplicate: false, id, title: meta.title, url: rawUrl, notes: meta.notes, scraped: meta.scraped };
}

async function deletePersonalUrl(env, userId, rawUrl) {
  const existing = await findExistingLink(env, 'personal_links', 'user_id', userId, rawUrl);
  if (!existing) return { found: false };
  await env.DB.prepare('DELETE FROM personal_links WHERE id = ? AND user_id = ?').bind(existing.id, userId).run();
  return { found: true, id: existing.id };
}

async function deleteCommunityUrl(env, communityId, rawUrl) {
  const existing = await findExistingLink(env, 'links', 'community_id', communityId, rawUrl);
  if (!existing) return { found: false };
  await env.DB.prepare('DELETE FROM links WHERE id = ?').bind(existing.id).run();
  await env.DB.prepare('DELETE FROM link_votes WHERE link_id = ?').bind(existing.id).run();
  return { found: true, id: existing.id };
}

/** Telegram sendMessage hard limit is 4096 UTF-16 code units. */
const TG_MSG_MAX = 4096;

/** Split long text into ≤4096 chunks at newlines (prefer) or spaces. */
function chunkTelegramText(text, maxLen = TG_MSG_MAX) {
  const s = String(text || '');
  if (s.length <= maxLen) return s ? [s] : [];
  const chunks = [];
  let rest = s;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf('\n', maxLen);
    if (cut < Math.floor(maxLen * 0.5)) cut = rest.lastIndexOf(' ', maxLen);
    if (cut < Math.floor(maxLen * 0.4)) cut = maxLen;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.trim()) chunks.push(rest);
  return chunks;
}

function helpMenuKeyboard() {
  return {
    inline_keyboard: [[
      { text: '🌐 Global', callback_data: 'help:global' },
      { text: '👤 Personal', callback_data: 'help:personal' },
      { text: '👥 Community', callback_data: 'help:community' }
    ]]
  };
}

function helpBackKeyboard() {
  return {
    inline_keyboard: [[
      { text: '« Help menu', callback_data: 'help:menu' }
    ], [
      { text: '🌐 Global', callback_data: 'help:global' },
      { text: '👤 Personal', callback_data: 'help:personal' },
      { text: '👥 Community', callback_data: 'help:community' }
    ]]
  };
}

function helpTextForSection(section) {
  if (section === 'global') {
    return [
      '🌐 Global',
      '',
      '/start — welcome / status',
      '/help — this menu',
      '/id — chat id · your user id · topic id',
      '/rank — your ranks across communities (incl. banned)',
      '',
      'Ranks',
      'GOD — instance host (TG_OWNER_IDS): personal, bot settings, AI credentials',
      'owner — community creator (/community_verify)',
      'admin — promoted with /admin',
      'member — after login + join TG group + /community_join',
      'banned — left/kicked from that community\'s TG group (other communities OK)',
      '',
      'Tip: open a forum topic and /id shows topic id for /topic.'
    ].join('\n');
  }
  if (section === 'personal') {
    return [
      '👤 Personal (GOD rank only)',
      '',
      'Mode (dual dump target)',
      '/personal — dump → your personal brain',
      '/community — dump → community brain (DM or group)',
      '/mode — show current dump mode',
      '/mode personal | community — switch',
      '',
      'In bot DM after /community: paste URLs → community DB',
      'In bot DM after /personal: paste URLs → personal DB',
      '',
      'Links',
      'Paste a URL (or forward) in the active mode',
      '/search <query> — search active brain',
      '/ai <question> — AI over brain (all ranks community; personal GOD-only)',
      '/delete <url> — delete (or add if missing); or reply /delete',
      '/edit <url or title> | <new description>',
      '  /edit … | title: New | notes: …',
      '',
      'Multi-link posts',
      '/dumpall on — save every URL',
      '/dumpall off — SMART primary only (default)',
      '/dumpall — show multi-link mode',
      '/dumpsmart — same as /dumpall off',
      '',
      '/clear_personal_db — wipe your personal links (GOD)',
      '',
      'Setup: website Settings → Bot (GOD: token + DM /id).'
    ].join('\n');
  }
  if (section === 'community') {
    return [
      '👥 Community',
      '',
      'Setup',
      '/community_verify — link this group (creates community; you = owner)',
      '/community — switch dump → community brain',
      '/personal — switch dump → personal brain (GOD)',
      '/mode — show dump mode · /mode personal|community',
      '',
      'Members (login + in TG group + join)',
      '1) Join the Telegram group',
      '2) Login on website (same Telegram)',
      '3) /community_join <id>',
      'Paste URL in group/topic to dump',
      '/community_list — name | id',
      '/community_list <id|name> — details',
      '/search <query> · /ai <question> · /rank',
      'Leave/kick/ban from group → site+bot access revoked until rejoin + /community_join',
      '',
      'Admin + owner',
      '/delete <url> · reply /delete — remove link (staff)',
      '/edit <url|title> | notes… — edit link',
      '/topic <id> — lock bot to that forum topic only',
      '/topic off — whole group · /topic — show lock',
      '/topic here — lock to current topic',
      '/dumpall on|off · /dumpsmart — multi-link mode',
      '/clear <@user|id> — remove member (can rejoin); reply /clear',
      '  Admin: members only · Owner/GOD: members+admins',
      '',
      'Owner only',
      '/admin — reply to user → promote admin',
      '/demote — reply or /demote <@user|id> → member',
      '/clear_db <id> — wipe community links only (keep community)',
      '/community_delete <id> — wipe community + all data',
      '  then reply YES_DELETE_<token> to confirm',
      '',
      'File uploads: send .md/.txt/.json/.py etc in group → community brain',
      'GOD: /personal · /clear_personal_db · /sync · /backup · /db · website bot + AI credentials',
      '/setlogchannel <id|off> — set log channel for login/join notifications',
      '/restart — restart Athena service (GOD only)'
    ].join('\n');
  }
  return [
    'Athena help',
    '',
    'Pick a category:',
    '🌐 Global — /start · /help · /id · /rank',
    '👤 Personal — dual mode, dump, search, AI, edit… (GOD)',
    '👥 Community — verify, join, list, admin, topic, clear…',
    '',
    'Dual mode: /personal and /community switch where links go',
    '(DM or group). Members dump in the linked group after join.',
    '',
    'Member cmds: /start /help /id /rank /community_join /search /ai /community_list + dump',
    'Other cmds → admin/owner/GOD only.'
  ].join('\n');
}

async function editTelegramMessage(token, chatId, messageId, text, replyMarkup, threadId = null) {
  if (!token || !chatId || !messageId) return { ok: false };
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    // editMessageText is single-message only — prefer full text when short, else truncate cleanly
    text: chunkTelegramText(text, TG_MSG_MAX)[0] || String(text).slice(0, TG_MSG_MAX),
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  if (threadId != null && threadId !== '' && !Number.isNaN(Number(threadId))) {
    payload.message_thread_id = Number(threadId);
  }
  return await telegramApi(token, 'editMessageText', payload);
}

async function handleTelegramCallbackQuery(cq, env, corsHeaders) {
  const data = cq.data || '';
  const tgUserId = cq.from?.id ? String(cq.from.id) : null;
  const chatId = cq.message?.chat?.id ? String(cq.message.chat.id) : null;
  const msgId = cq.message?.message_id;
  const threadId = cq.message?.message_thread_id != null ? Number(cq.message.message_thread_id) : null;
  const binding = chatId ? await findTelegramBinding(env, chatId, tgUserId) : null;
  let token = (await tokenForBindingAsync(binding, env)) || env.TELEGRAM_BOT_TOKEN;
  if (!token && tgUserId) {
    const u = await resolveAthenaUserFromTg(env, tgUserId);
    const personal = u ? await findPersonalBotForOwner(env, u.id) : null;
    if (personal?.bot_token) token = await decryptBotToken(env, personal.bot_token);
  }

  // ---- Help menu buttons ----
  if (data.startsWith('help:')) {
    await telegramApi(token, 'answerCallbackQuery', { callback_query_id: cq.id });
    const section = data.slice(5); // menu | global | personal | community
    if (section === 'menu') {
      await editTelegramMessage(token, chatId, msgId, helpTextForSection('menu'), helpMenuKeyboard(), threadId);
    } else if (section === 'global' || section === 'personal' || section === 'community') {
      await editTelegramMessage(token, chatId, msgId, helpTextForSection(section), helpBackKeyboard(), threadId);
    }
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  // ---- Backup buttons ----
  if (data.startsWith('backup:')) {
    const action = data.slice(7);
    await telegramApi(token, 'answerCallbackQuery', { callback_query_id: cq.id });

    if (action === 'cancel') {
      await editTelegramMessage(token, chatId, msgId, `${boldHtml('❌ Backup cancelled.')}`, null, threadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }

    if (!isGodTgId(tgUserId, env)) {
      await editTelegramMessage(token, chatId, msgId, `${boldHtml('🔒 GOD rank only')}`, null, threadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }

    if (!env.runBackup) {
      await editTelegramMessage(token, chatId, msgId, `${boldHtml('⚠️')} Backup not available on this instance.`, null, threadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }

    const destLabel = action === 'telegram' ? 'Telegram' : action === 'drive' ? 'Google Drive' : 'Telegram + Drive';
    await editTelegramMessage(token, chatId, msgId, `${boldHtml('🔄 Backing up to')} ${codeHtml(destLabel)}…\n\n${italicHtml('This may take a moment for large databases.')}`, null, threadId);

    try {
      // Set env vars to control backup destination
      const origEnv = { ...process.env };
      if (action === 'telegram') {
        process.env.GDRIVE_CLIENT_ID = ''; // disable drive
      } else if (action === 'drive') {
        process.env.BACKUP_TELEGRAM_TOKEN = ''; // disable telegram
        process.env.BACKUP_TELEGRAM_CHAT_ID = '';
      }
      // 'both' uses whatever is configured

      const result = await env.runBackup();

      // Restore env
      Object.assign(process.env, origEnv);

      if (result.ok) {
        const sizeMB = (result.size / 1e6).toFixed(2);
        await editTelegramMessage(token, chatId, msgId, [
          boldHtml('✅ Backup Complete'),
          '',
          `${boldHtml('File:')} ${codeHtml(result.name)}`,
          `${boldHtml('Size:')} ${codeHtml(sizeMB + ' MB')}`,
          `${boldHtml('Parts:')} ${result.files}`,
          `${boldHtml('Destination:')} ${codeHtml(destLabel)}`,
          '',
          italicHtml('Restore: gunzip -c file.sql.gz | psql "$DATABASE_URL"')
        ].join('\n'), null, threadId);
      } else {
        await editTelegramMessage(token, chatId, msgId, `${boldHtml('❌ Backup failed:')} ${escHtml(result.error)}`, null, threadId);
      }
    } catch (err) {
      await editTelegramMessage(token, chatId, msgId, `${boldHtml('❌ Backup failed:')} ${escHtml(err.message)}`, null, threadId);
    }
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  await telegramApi(token, 'answerCallbackQuery', { callback_query_id: cq.id });

  if (!data.startsWith('ca:') && !data.startsWith('cr:')) {
    return new Response('OK', { status: 200, headers: corsHeaders });
  }
  const approve = data.startsWith('ca:');
  const pendingId = data.slice(3);
  await ensurePendingTable(env);
  const pend = await env.DB.prepare('SELECT * FROM telegram_pending WHERE id = ?').bind(pendingId).first();
  if (!pend || pend.status !== 'pending') {
    if (chatId) await sendTelegramMessage(token, chatId, 'Already handled or not found.');
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  const athenaUser = await resolveAthenaUserFromTg(env, tgUserId);
  const staff = await isTgUserCommunityStaff(env, pend.community_id, tgUserId, athenaUser);
  if (!staff) {
    await telegramApi(token, 'answerCallbackQuery', {
      callback_query_id: cq.id,
      text: 'Only owner/admins can approve or reject',
      show_alert: true
    });
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  if (approve) {
    const again = await findExistingLink(env, 'links', 'community_id', pend.community_id, pend.url);
    if (!again) {
      const id = 'tg_' + Date.now().toString(36);
      try {
        const meta = await enrichLinkFields(env, pend.url, { title: pend.title, notes: pend.notes });
        await ensureLinkMetaColumns(env);
        try {
          await env.DB.prepare(
            `INSERT INTO links (id, community_id, url, url_hash, title, notes, tags, added_by,
              added_by_user_id, added_by_provider, added_by_name, upvotes, downvotes, created_at, image_url, site_name)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'telegram', ?, 0, 0, ?, ?, ?)`
          ).bind(
            id, pend.community_id, pend.url, pend.url_hash, meta.title, meta.notes,
            JSON.stringify(['telegram', 'approved']),
            pend.proposed_by_tg || 'telegram', pend.proposed_by, pend.proposed_by_tg || 'telegram',
            Date.now(), meta.image_url || null, meta.site_name || null
          ).run();
        } catch (_) {
          await env.DB.prepare(
            `INSERT INTO links (id, community_id, url, url_hash, title, notes, tags, added_by,
              added_by_user_id, added_by_provider, added_by_name, upvotes, downvotes, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'telegram', ?, 0, 0, ?)`
          ).bind(
            id, pend.community_id, pend.url, pend.url_hash, meta.title, meta.notes,
            JSON.stringify(['telegram', 'approved']),
            pend.proposed_by_tg || 'telegram', pend.proposed_by, pend.proposed_by_tg || 'telegram', Date.now()
          ).run();
        }
      } catch (_) {
        const cleanTitle = titleFromUrl(pend.url);
        await env.DB.prepare(
          'INSERT INTO links (id, community_id, url, url_hash, title, notes, tags, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(id, pend.community_id, pend.url, pend.url_hash, cleanTitle, '', JSON.stringify(['telegram']), pend.proposed_by_tg || 'tg', Date.now()).run();
      }
    }
    await env.DB.prepare(`UPDATE telegram_pending SET status = 'approved' WHERE id = ?`).bind(pendingId).run();
    if (chatId && msgId) {
      await telegramApi(token, 'editMessageText', {
        chat_id: chatId,
        message_id: msgId,
        text: `Approved by ${cq.from?.first_name || 'admin'}\n${pend.url}`
      });
    }
  } else {
    await env.DB.prepare(`UPDATE telegram_pending SET status = 'rejected' WHERE id = ?`).bind(pendingId).run();
    if (chatId && msgId) {
      await telegramApi(token, 'editMessageText', {
        chat_id: chatId,
        message_id: msgId,
        text: `Rejected by ${cq.from?.first_name || 'admin'}\n${pend.url}`
      });
    }
  }
  return new Response('OK', { status: 200, headers: corsHeaders });
}

async function handleTelegramWebhook(update, env, corsHeaders) {
  await ensureBotBindingColumns(env);
  await ensureCommunityMembersColumns(env);

  // Ban sync: kicked/banned from linked group → ban on website
  const cm = update.chat_member || update.my_chat_member;
  if (cm) {
    try {
      const chatIdBan = cm.chat?.id != null ? String(cm.chat.id) : null;
      const newStatus = cm.new_chat_member?.status || '';
      const bannedUser = cm.new_chat_member?.user;
      if (chatIdBan && bannedUser && !bannedUser.is_bot) {
        const b = await env.DB.prepare(
          `SELECT community_id FROM community_bots WHERE platform = 'telegram' AND group_id = ? AND community_id IS NOT NULL`
        ).bind(chatIdBan).first();
        if (b?.community_id) {
          // Not in group (kick/ban/voluntary leave) → ban on site
          if (['kicked', 'left', 'banned'].includes(newStatus)) {
            await banUserFromCommunity(env, b.community_id, {
              platform: 'telegram',
              platformUserId: String(bannedUser.id),
              reason: `tg_${newStatus}`
            });
          }
          // Rejoined group → unban (can login again; still need /community_join)
          if (['member', 'administrator', 'creator', 'restricted'].includes(newStatus)) {
            let reUid = null;
            try {
              const u = await env.DB.prepare(
                `SELECT id FROM users WHERE provider = 'telegram' AND (provider_id = ? OR telegram_api_id = ?)`
              ).bind(String(bannedUser.id), String(bannedUser.id)).first();
              if (u) reUid = u.id;
            } catch (_) {}
            await unbanUserFromCommunity(env, b.community_id, {
              platform: 'telegram',
              platformUserId: String(bannedUser.id),
              userId: reUid
            });
          }
        }
      }
    } catch (e) {
      console.error('ban sync', e);
    }
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  // Inline button callbacks (approve / reject)
  if (update.callback_query) {
    return await handleTelegramCallbackQuery(update.callback_query, env, corsHeaders);
  }

  const msg = update.message || update.edited_message || update.channel_post;
  if (!msg) return new Response('OK', { status: 200, headers: corsHeaders });

  let text = (msg.text || msg.caption || '').trim();
  // Photo / media posts may only have caption_entities (hyperlinks) — still process
  const entityUrlsEarly = extractUrlsFromTelegramMessage(msg);
  // /delete as reply — only bare /delete (not random messages that mention delete)
  {
    const t0 = (text || '').trim().toLowerCase().replace(/@\w+$/, '');
    const bareDelete = t0 === '/delete' || t0.startsWith('/delete@') || t0 === '';
    if (bareDelete && msg.reply_to_message && (t0.startsWith('/delete') || t0 === '')) {
      if (t0.startsWith('/delete')) {
        const replyUrls = extractUrlsFromTelegramMessage(msg.reply_to_message, { includeReply: false });
        // also entities on the replied message itself
        const more = extractUrlsFromTelegramMessage({ ...msg.reply_to_message, reply_to_message: null });
        const urls = [...new Set([...replyUrls, ...more])];
        if (urls.length) text = `/delete ${urls.join(' ')}`;
        // else leave as bare /delete → usage message (do NOT treat caption as delete target blindly)
      }
    }
  }
  // Captionless document uploads have no text and no entity URLs — let them reach the doc handler
  if (!text && !entityUrlsEarly.length && !msg.document?.file_id) return new Response('OK', { status: 200, headers: corsHeaders });
  // synthetic command text for media-only with links
  if (!text && entityUrlsEarly.length) text = entityUrlsEarly.join(' ');

  const chatId = String(msg.chat.id);
  const from = msg.from || {};
  const senderName = from.first_name || from.username || msg.sender_chat?.title || 'Telegram User';
  const tgUserId = from.id ? String(from.id) : null;
  const isAnonymousAdmin = tgUserId === '1087968824' || (
    msg.sender_chat?.id != null && String(msg.sender_chat.id) === chatId &&
    ['group', 'supergroup', 'channel'].includes(String(msg.sender_chat.type || '').toLowerCase())
  );
  const captionNotes = telegramUserNotes(msg);
  // Keep bot replies in the same forum topic as the user message (not General/#)
  const forumThreadId = msg.message_thread_id != null ? Number(msg.message_thread_id) : null;

  const parts = text.split(/\s+/);
  let cmd = (parts[0] || '').toLowerCase().replace(/@\w+$/, '');
  // typos
  if (cmd === '/perosnal') cmd = '/personal';
  // if first token is a URL, not a command
  if (cmd.startsWith('http')) cmd = '';
  const rest = cmd.startsWith('/') ? text.slice(parts[0].length).trim() : text;

  let binding = await findTelegramBinding(env, chatId, tgUserId);
  let token = (await tokenForBindingAsync(binding, env)) || env.TELEGRAM_BOT_TOKEN;
  let athenaUser = await resolveAthenaUserFromTg(env, tgUserId);
  // Persist Bot API id whenever we see a logged-in Telegram user (needed for join + owner match)
  if (athenaUser?.id && tgUserId && isLikelyTelegramBotApiId(tgUserId)) {
    try {
      await env.DB.prepare('UPDATE users SET telegram_api_id = ? WHERE id = ?')
        .bind(String(tgUserId), athenaUser.id).run();
      athenaUser.telegram_api_id = String(tgUserId);
    } catch (_) {}
  }

  // Topic lock: whole bot in this group (commands + dumps + ban checks). Only
  // /topic can run outside the locked topic. This gate MUST run before the
  // presence/ban block — otherwise a message in the wrong topic still gets a
  // "you are banned" reply, which looks like the bot is broken.
  // In forum General, message_thread_id is often missing — treat as "not locked topic".
  const isGroupChatEarly = String(msg.chat?.type || '').includes('group') || chatId.startsWith('-');
  if (isGroupChatEarly && binding?.topic_id) {
    const locked = String(binding.topic_id);
    const here = forumThreadId != null ? String(forumThreadId) : null;
    const isTopicCmd = cmd === '/topic';
    if (here !== locked && !isTopicCmd) {
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
  }

  // Telegram's "Anonymous Admin" (id 1087968824, @GroupAnonymousBot) posts as a
  // special account that can break getChatMember presence lookups. It is an
  // administrator by definition — never ban-reply its messages.
  // Live presence + ban: THIS community only (multi-community: ban on X does not lock Y)
  if (binding?.community_id && tgUserId && !isGodTgId(tgUserId, env) && !isAnonymousAdmin) {
    try {
      const pres = await enforceGroupPresenceOrBan(env, binding.community_id, tgUserId, athenaUser);
      const bannedHere = pres.banned
        || (athenaUser && await isBannedFromCommunity(env, binding.community_id, athenaUser))
        || await isBannedFromCommunity(env, binding.community_id, {
          id: athenaUser?.id || null,
          provider: 'telegram',
          provider_id: tgUserId,
          telegram_api_id: tgUserId
        });
      if (bannedHere || !pres.inGroup) {
        if (token) {
          let cname = binding.group_name || null;
          try {
            const c = await env.DB.prepare('SELECT name FROM communities WHERE id = ?').bind(binding.community_id).first();
            if (c?.name) cname = c.name;
          } catch (_) {}
          await sendTelegramMessage(token, chatId, bannedFromCommunityBotMsg(binding.community_id, cname), forumThreadId);
        }
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
    } catch (e) {
      console.error('presence ban', e);
    }
  }

  // Fully site-banned = not in ANY community TG group + has bans → block bot
  // (still allow /start /help /id /rank /community_list /community_join so they can recover)
  if (tgUserId && !isGodTgId(tgUserId, env) && !isAnonymousAdmin && athenaUser && await isUserFullySiteBanned(env, athenaUser)) {
    const allowWhenFullyBanned = new Set([
      '/start', '/help', '/id', '/rank', '/community_list', '/communities', '/clist',
      '/community_join', '/cjoin', '/join_community', '/db'
    ]);
    const cmd0 = (text.split(/\s+/)[0] || '').toLowerCase().replace(/@\w+$/, '');
    if (!allowWhenFullyBanned.has(cmd0) && !cmd0.startsWith('http') && cmd0.startsWith('/')) {
      if (token) await sendTelegramMessage(token, chatId, BANNED_SITE_MSG, forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
  }

  // Unverified group: use owner's personal bot token so replies work
  if (!binding && athenaUser && (String(msg.chat?.type || '').includes('group') || chatId.startsWith('-'))) {
    const personalBot = await findPersonalBotForOwner(env, athenaUser.id);
    if (personalBot?.bot_token) token = await decryptBotToken(env, personalBot.bot_token);
  }
  // Prefer binding token, else any personal bot of this user, else env
  if (!token && athenaUser) {
    const pb = await findPersonalBotForOwner(env, athenaUser.id);
    if (pb?.bot_token) token = await decryptBotToken(env, pb.bot_token);
  }

  // Rank context for this chat. Must precede document handling, which reads isGod.
  const communityIdForRank = binding?.community_id || null;
  const userRankInfo = await resolveUserRank(env, athenaUser, tgUserId, communityIdForRank);
  const userRank = userRankInfo.rank;
  const isGod = userRank === 'god';
  const isCommOwner = userRank === 'owner' || isGod;
  const isCommAdmin = userRank === 'admin' || isCommOwner;
  const isMemberPlus = rankAtLeast(userRank, 'member');

  // ---- Document/file handling ----
  // When a user sends a .md or supported file, save it to the active scope.
  // In groups: always community scope. In DMs: respect /personal or /community mode.
  const doc = msg.document;
  if (doc && doc.file_id && athenaUser) {
    let filename = doc.file_name || 'document.txt';
    const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
    if (DOCUMENT_EXTENSIONS.has(ext)) {
      const isGroup = String(msg.chat?.type || '').includes('group') || chatId.startsWith('-');
      // Determine scope: in groups always community, in DMs use binding mode
      let docScope = 'community';
      let docCommunityId = binding?.community_id || null;
      if (!isGroup) {
        docScope = binding?.scope || (binding?.community_id ? 'community' : 'personal');
        docCommunityId = binding?.community_id || null;
      }
      // Personal scope: GOD only
      if (docScope === 'personal' && !isGod) {
        docScope = 'community';
        docCommunityId = binding?.community_id || null;
      }
      // Community scope requires a community
      if (docScope === 'community' && !docCommunityId) {
        // Try to find user's first community
        if (athenaUser) {
          const c = await env.DB.prepare(
            `SELECT c.id FROM communities c
             INNER JOIN community_members m ON m.community_id = c.id
             WHERE m.user_id = ? ORDER BY c.created_at DESC LIMIT 1`
          ).bind(athenaUser.id).first();
          if (c) docCommunityId = c.id;
        }
      }
      if (docScope === 'community' && !docCommunityId) {
        await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} No community linked. ${codeHtml('/community_verify')} in a group or ${codeHtml('/community_join <id>')}.`, forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
      // Community uploads are member+ only — a non-member in the group must not write to its brain
      if (docCommunityId && !isMemberPlus) {
        await sendTelegramFormatted(token, chatId, `${boldHtml('⛔')} Members only. ${codeHtml('/community_join ' + docCommunityId)} first.`, forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
      // Download file from Telegram
      try {
        const botToken = token || env.TELEGRAM_BOT_TOKEN;
        const fileInfo = await telegramApi(botToken, 'getFile', { file_id: doc.file_id });
        if (!fileInfo?.ok || !fileInfo.result?.file_path) {
          await sendTelegramFormatted(token, chatId, `${boldHtml('❌')} Could not download file.`, forumThreadId);
          return new Response('OK', { status: 200, headers: corsHeaders });
        }
        const fileUrl = `https://api.telegram.org/file/bot${botToken}/${fileInfo.result.file_path}`;
        const fileRes = await fetch(fileUrl);
        if (!fileRes.ok) throw new Error(`Download failed: ${fileRes.status}`);
        // Same validator as the API path — byte-accurate size cap, filename and UTF-8 checks
        const valid = validateDocumentInput({ scope: docScope, filename, content: await fileRes.text() });
        if (valid.error) {
          await sendTelegramFormatted(token, chatId, `${boldHtml('❌')} ${escHtml(valid.error)}`, forumThreadId);
          return new Response('OK', { status: 200, headers: corsHeaders });
        }
        const content = valid.content;
        filename = valid.filename;
        await ensureDocumentsTable(env);
        const id = 'doc_' + Date.now().toString(36) + '_' + randomToken().slice(0, 4);
        const now = Date.now();
        if (docScope === 'personal') {
          await env.DB.prepare(
            `INSERT INTO uploaded_documents (id, scope, user_id, filename, content, uploaded_by, created_at)
             VALUES (?, 'personal', ?, ?, ?, ?, ?)`
          ).bind(id, athenaUser.id, filename, content, athenaUser.id, now).run();
          // Also save to GitHub if configured
          const storeCfg = await getStorageConfig(env);
          if (storeCfg?.provider === 'github' && storeCfg?.token && storeCfg?.repo) {
            try {
              const store = new GitHubStore({ repo: storeCfg.repo, branch: storeCfg.branch || 'main', token: storeCfg.token });
              const safeId = id.replace(/[^a-z0-9_]/g, '');
              const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
              const ghPath = `documents/personal/${athenaUser.id}/${safeId}--${safeFilename}`;
              await store.writeFile(ghPath, content, { message: `athena: upload ${filename} via bot` });
              await env.DB.prepare('UPDATE uploaded_documents SET github_path = ? WHERE id = ?').bind(ghPath, id).run();
            } catch (_) {}
          }
          await sendTelegramFormatted(token, chatId, `${boldHtml('✅')} Saved to personal brain: ${codeHtml(filename)}`, forumThreadId);
        } else {
          await env.DB.prepare(
            `INSERT INTO uploaded_documents (id, scope, community_id, filename, content, uploaded_by, created_at)
             VALUES (?, 'community', ?, ?, ?, ?, ?)`
          ).bind(id, docCommunityId, filename, content, athenaUser.id, now).run();
          // Also save to GitHub if configured
          const storeCfg = await getStorageConfig(env);
          if (storeCfg?.provider === 'github' && storeCfg?.token && storeCfg?.repo) {
            try {
              const store = new GitHubStore({ repo: storeCfg.repo, branch: storeCfg.branch || 'main', token: storeCfg.token });
              const safeId = id.replace(/[^a-z0-9_]/g, '');
              const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
              const ghPath = `documents/communities/${docCommunityId}/${safeId}--${safeFilename}`;
              await store.writeFile(ghPath, content, { message: `athena: upload ${filename} via bot` });
              await env.DB.prepare('UPDATE uploaded_documents SET github_path = ? WHERE id = ?').bind(ghPath, id).run();
            } catch (_) {}
          }
          const communityName = binding?.group_name || docCommunityId;
          await sendTelegramFormatted(token, chatId, `${boldHtml('✅')} Saved to community brain (${escHtml(communityName)}): ${codeHtml(filename)}`, forumThreadId);
        }
      } catch (err) {
        await sendTelegramFormatted(token, chatId, `${boldHtml('❌')} File upload failed: ${escHtml(err.message)}`, forumThreadId);
      }
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
  }

  // Per-chat preference: dump all links vs smart primary (stored on binding)
  async function setDumpLinkMode(mode) {
    if (!binding?.id) return false;
    try {
      await ensureBotBindingColumns(env);
      // reuse scope column? better: encode in group_name prefix no — use notes via SQL extra col
      await env.DB.prepare(`ALTER TABLE community_bots ADD COLUMN dump_link_mode TEXT DEFAULT 'smart'`).run().catch(() => {});
      await env.DB.prepare(`UPDATE community_bots SET dump_link_mode = ? WHERE id = ?`).bind(mode, binding.id).run();
      binding.dump_link_mode = mode;
      return true;
    } catch (_) {
      binding.dump_link_mode = mode;
      return true;
    }
  }
  const dumpLinkMode = (binding?.dump_link_mode || 'smart').toLowerCase();

  const STAFF_OR_ABOVE = new Set([
    '/delete', '/edit', '/topic', '/dumpall', '/dumpsmart', '/admin', '/demote', '/clear',
    '/personal', '/community', '/mode', '/community_verify', '/verify_community', '/communityverify',
    '/community_delete', '/delete_community', '/cdelete',
    // every /clear_db alias must be listed, or the alias skips this gate entirely
    '/clear_db', '/cleardb', '/clear_community_db',
    '/clear_personal_db', '/clear_perosnal_db', '/clearpersonal',
    '/sync', '/backup'
  ]);
  if (cmd && cmd.startsWith('/') && STAFF_OR_ABOVE.has(cmd) && !isCommAdmin && !isGod) {
    await sendTelegramMessage(token, chatId,
      'Admin/owner only command.\nYour rank: ' + userRankInfo.label + '\nAllowed: /start /help /id /rank /community_join /search /ai /community_list + dump links',
      forumThreadId);
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  // ---- /rank ----
  if (cmd === '/rank') {
    const statuses = await listUserCommunityStatuses(env, athenaUser, tgUserId);
    const hereBan = communityIdForRank && statuses.find(s => s.id === communityIdForRank && s.rank === 'banned');
    let hereLabel = userRankInfo.label || 'none';
    if (hereBan) hereLabel = 'banned';
    else if (isGod) hereLabel = 'GOD';
    const rankColors = { god: '👑', owner: '⭐', admin: '🛡', member: '👤', 'in-group': '👥', banned: '🚫', none: '❓' };
    const lines = [
      boldHtml('📊 Your Rank'),
      '',
      `${boldHtml('Here:')} ${rankColors[hereLabel] || ''} ${codeHtml(String(hereLabel).toUpperCase())}`,
      athenaUser ? `${boldHtml('Account:')} @${escHtml(athenaUser.username || athenaUser.display_name || athenaUser.id)}` : `${boldHtml('Account:')} ${italicHtml('Not logged in')}`,
      tgUserId ? `${boldHtml('Telegram ID:')} ${codeHtml(tgUserId)}` : null,
      communityIdForRank ? `${boldHtml('This chat:')} ${escHtml(binding?.group_name || communityIdForRank)}` : `${boldHtml('Chat:')} DM / no community`,
      '',
      boldHtml('Your communities:')
    ];
    if (!statuses.length) {
      lines.push(italicHtml('(none — login + join TG group + /community_join <id>)'));
    } else {
      for (const st of statuses) {
        const icon = rankColors[st.rank] || '';
        lines.push(`${icon} ${escHtml(st.name)} | ${codeHtml(st.id)} | ${boldHtml(String(st.rank).toUpperCase())}`);
      }
    }
    lines.push('', `${boldHtml('Ranks:')} GOD · owner · admin · member · in-group · banned`);
    lines.push(italicHtml('in-group = in TG group, still need /community_join <id>'));
    await sendTelegramFormatted(token, chatId, lines.filter(v => v != null).join('\n'), forumThreadId);
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  // ---- /start (welcome) vs /help (commands) ----
  if (cmd === '/start') {
    const isPriv = !(String(msg.chat?.type || '').includes('group') || chatId.startsWith('-'));
    if (!athenaUser && isPriv) {
      await sendTelegramMessage(token, chatId, [
        'Welcome to Athena.',
        '',
        '1) Login on the website with Telegram',
        '2) Join the community Telegram group',
        '3) /community_join <id>',
        '',
        'Then: dump links in the group · /search · /ai · /rank',
        'Personal mode is GOD rank only (instance host).'
      ].join('\n'), forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    const scope = binding?.scope || (binding?.community_id ? 'community' : null);
    let roleLine = 'Rank: not a member yet — /community_join <id>';
    if (isGod) roleLine = 'Rank: GOD (instance host — personal + bot + AI credentials).';
    else if (userRank === 'owner') roleLine = 'Rank: owner (community creator).';
    else if (userRank === 'admin') roleLine = 'Rank: admin (community staff).';
    else if (userRank === 'member') roleLine = 'Rank: member (community dump/search/ai).';
    await sendTelegramMessage(token, chatId, [
      'Welcome to Athena Search bot.',
      '',
      roleLine,
      binding
        ? ('Linked · dump mode: ' + (scope || 'personal') + (binding.community_id ? (' · community ' + (binding.group_name || binding.community_id)) : ''))
        : (isGod ? 'Not linked — Settings → Bot on the website (token + /id).' : 'Join: /community_join <id>'),
      '',
      isGod
        ? 'GOD: /personal · group /community_verify · /community · /search · /ai · /help'
        : (isMemberPlus
          ? 'Member+: dump in group · /search · /ai · /community_list · /rank · /help'
          : 'Login on website → join TG group → /community_join <id>'),
      '',
      'Send /help for command menus. /rank shows your rank.'
    ].join('\n'), forumThreadId);
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

// ---- /community_join <id> (must already be in the TG group) ----
  if (cmd === '/community_join' || cmd === '/cjoin' || cmd === '/join_community') {
    const cid = rest.trim().split(/\s+/)[0] || '';
    if (!cid) {
      await sendTelegramMessage(token, chatId, 'Usage: /community_join <community_id>\nGet id from owner: /community_list', forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    if (!athenaUser) {
      await sendTelegramMessage(token, chatId,
        'Login on the website with Telegram first, then send /community_join ' + cid, forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    const c = await env.DB.prepare('SELECT id, name FROM communities WHERE id = ?').bind(cid).first();
    if (!c) {
      await sendTelegramMessage(token, chatId, `Community not found: ${cid}`, forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    if (await isBannedFromCommunity(env, cid, athenaUser)) {
      await sendTelegramMessage(token, chatId, [
        bannedFromCommunityBotMsg(cid, c.name),
        '',
        'Other communities: /community_join <other_id> still works if you are a member there.'
      ].join('\n'), forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    // Must be a member of the linked Telegram group first (instance owners skip)
    const isInstOwner = isInstanceOwnerUser(athenaUser, env) || isInstanceOwnerTgId(tgUserId, env);
    if (!isInstOwner) {
      const tgCheckId = tgUserId || (await resolveTgApiIdForUser(athenaUser));
      const inGroup = await isTelegramUserInCommunityGroup(env, cid, tgCheckId);
      if (!inGroup) {
        await sendTelegramMessage(token, chatId, [
          'First join the Telegram group for this community.',
          'Then come back and send:',
          `/community_join ${cid}`
        ].join('\n'), forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
    }
    if (tgUserId) {
      try {
        await env.DB.prepare('UPDATE users SET telegram_api_id = ? WHERE id = ?').bind(String(tgUserId), athenaUser.id).run();
      } catch (_) {}
    }
    await ensureCommunityMembersColumns(env);
    const existing = await env.DB.prepare(
      'SELECT role FROM community_members WHERE community_id = ? AND user_id = ?'
    ).bind(cid, athenaUser.id).first();
    if (existing) {
      await sendTelegramMessage(token, chatId,
        `Already a member of ${c.name} | ${c.id}\nOpen the website → Communities.`, forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    await upsertCommunityMember(env, cid, athenaUser.id, 'member');
     // Notify GOD rank about new member joining (Telegram + website notification)
     try {
       const ownerIds = parseIdList(env.TG_OWNER_IDS || '');
       const joinerLabel = athenaUser.username ? `@${athenaUser.username}` : (athenaUser.display_name || athenaUser.id);
       const joinerTgId = tgUserId || '';
       const notifyMsg = `👤 ${joinerLabel}${joinerTgId ? ` | ${joinerTgId}` : ''} joined ${c.name} community`;
       // Website notification for GOD users
       const { results: godUsers } = await env.DB.prepare(
         `SELECT id FROM users WHERE telegram_api_id IN (${ownerIds.map(() => '?').join(',') || "''"})`
       ).bind(...ownerIds.map(String)).all().catch(() => ({ results: [] }));
       for (const god of (godUsers || [])) {
         await createNotification(env, { userId: god.id, type: 'community_join', title: 'New Community Member', body: notifyMsg }).catch(() => {});
       }
       // Telegram notification: send to log channel if set, otherwise to GOD DMs
       const logChannelId = await getLogChannelId(env, godUsers?.[0]?.id);
       const notifyText = `👤 ${boldHtml(joinerLabel)}${joinerTgId ? ` | ${codeHtml(String(joinerTgId))}` : ''} joined ${boldHtml(c.name)} community`;
       if (logChannelId && env.TELEGRAM_BOT_TOKEN) {
         await sendTelegramFormatted(env.TELEGRAM_BOT_TOKEN, logChannelId, notifyText).catch(() => {});
       } else {
         for (const ownerId of ownerIds) {
           if (ownerId && env.TELEGRAM_BOT_TOKEN) {
             await sendTelegramFormatted(env.TELEGRAM_BOT_TOKEN, ownerId, notifyText).catch(() => {});
           }
         }
       }
     } catch (_) {}
     await sendTelegramMessage(token, chatId, [
      `Joined community: ${c.name}`,
      `id: ${c.id}`,
      '',
      'Open the website → Communities to see it and dump links.',
      'AI & /search: all ranks (community). Personal brain: GOD only. Settings: GOD only.'
    ].join('\n'), forumThreadId);
     return new Response('OK', { status: 200, headers: corsHeaders });
   }

   // ---- /setlogchannel (GOD sets log channel for notifications) ----
   if (cmd === '/setlogchannel' || cmd === '/setlog') {
     if (!isGod) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('🔒')} Only GOD rank can set log channel.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     if (!athenaUser) {
       await sendTelegramFormatted(token, chatId, 'Login on the website with Telegram first.', forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     // If replying to a forwarded message from a channel, use that channel ID
     const channelId = rest.trim() || (msg.reply_to_message?.sender_chat?.id ? String(msg.reply_to_message.sender_chat.id) : '');
     if (!channelId) {
       await sendTelegramFormatted(token, chatId, [
         `${boldHtml('📢 Set Log Channel')}`,
         '',
         'Usage: /setlogchannel <channel_id>',
         'Or: Forward a message from the channel, then reply to it with /setlogchannel',
         '',
         'To get channel ID: Forward a message from the channel to @userinfobot',
         '',
         'To remove: /setlogchannel off'
       ].join('\n'), forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     await ensureBotBindingColumns(env);
     // Find personal bot binding for this user
     const personalBot = await findPersonalBotForOwner(env, athenaUser.id);
     if (!personalBot) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} No personal bot registered. Save bot on website first.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     if (channelId.toLowerCase() === 'off' || channelId.toLowerCase() === 'remove') {
       await env.DB.prepare('UPDATE community_bots SET log_channel_id = NULL WHERE id = ?').bind(personalBot.id).run();
       await sendTelegramFormatted(token, chatId, `${boldHtml('✅')} Log channel removed.`, forumThreadId);
     } else {
       await env.DB.prepare('UPDATE community_bots SET log_channel_id = ? WHERE id = ?').bind(channelId, personalBot.id).run();
       await sendTelegramFormatted(token, chatId, `${boldHtml('✅')} Log channel set to: ${codeHtml(channelId)}\nLogin and community join notifications will be sent there.`, forumThreadId);
     }
     return new Response('OK', { status: 200, headers: corsHeaders });
   }

   // ---- /restart (GOD restarts the service) ----
   if (cmd === '/restart') {
     if (!isGod) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('🔒')} Only GOD rank can restart the service.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     await sendTelegramFormatted(token, chatId, `${boldHtml('🔄')} Restarting Athena… Back in ~5 seconds.\nSend /start to check.`, forumThreadId);
      // Restart is a self-host-only capability. Cloudflare Workers cannot
      // access the host process, so expose it through the Node adapter instead
      // of bundling node:child_process into the Worker.
      if (env.ATHENA_RUNTIME !== 'selfhost' || typeof env.restartService !== 'function') {
        await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} Restart is only available on the self-hosted backend.`, forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
      env.restartService();
      return new Response('OK', { status: 200, headers: corsHeaders });
   }

   if (cmd === '/help') {
    await sendTelegramMessageWithKeyboard(
      token,
      chatId,
      helpTextForSection('menu'),
      helpMenuKeyboard(),
      forumThreadId
    );
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  // ---- /community_verify (owner links this group → website community) ----
  if (cmd === '/community_verify' || cmd === '/verify_community' || cmd === '/communityverify') {
    try {
      await ensureCommunityMembersColumns(env);
      await ensureBotBindingColumns(env);
      const isGroup = String(msg.chat?.type || '').includes('group') || chatId.startsWith('-');
      if (!isGroup) {
        await sendTelegramMessage(token, chatId, 'Run /community_verify inside a Telegram group (after adding the bot).', forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }

      // Resolve owner: OIDC user, personal-bot DM match, or any bot they own
      let owner = athenaUser;
      if (!owner && tgUserId) {
        owner = await resolveAthenaUserFromTg(env, tgUserId);
      }
      // Prefer personal bot whose group_id is this user's Bot API id
      let personal = owner ? await findPersonalBotForOwner(env, owner.id) : null;
      if (!personal && tgUserId) {
        personal = await env.DB.prepare(
          `SELECT * FROM community_bots WHERE platform = 'telegram' AND group_id = ? ORDER BY created_at DESC LIMIT 1`
        ).bind(String(tgUserId)).first();
        if (personal) {
          owner = await env.DB.prepare('SELECT * FROM users WHERE id = ?')
            .bind(personal.created_by || personal.user_id).first();
        }
      }
      if (!personal && owner) {
        personal = await env.DB.prepare(
          `SELECT * FROM community_bots WHERE platform = 'telegram' AND (created_by = ? OR user_id = ?)
           ORDER BY created_at DESC LIMIT 1`
        ).bind(owner.id, owner.id).first();
      }

      if (!owner) {
        await sendTelegramMessage(token || env.TELEGRAM_BOT_TOKEN, chatId, 'Could not match your Telegram account.\n1) Login with Telegram on the website\n2) Settings → Bot: paste token + your DM /id (from this bot)\n3) Retry /community_verify here', forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
      if (!personal) {
        await sendTelegramMessage(token || env.TELEGRAM_BOT_TOKEN, chatId, 'No bot registered on the website yet.\nSettings → Bot: token + DM /id → Verify & save, then /community_verify here.', forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }

      // Remember Bot API id for future resolves (OIDC sub often differs)
      if (tgUserId) {
        try {
          await env.DB.prepare('UPDATE users SET telegram_api_id = ? WHERE id = ?').bind(String(tgUserId), owner.id).run();
        } catch (_) {}
      }

      const replyToken = (await decryptBotToken(env, personal.bot_token)) || token || env.TELEGRAM_BOT_TOKEN;
      if (!replyToken) {
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, 'Bot token missing. Re-save bot on website with full token.', forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }

      // Already linked group?
      const existingGroup = await env.DB.prepare(
        `SELECT * FROM community_bots WHERE platform = 'telegram' AND group_id = ?`
      ).bind(chatId).first();
      if (existingGroup?.community_id) {
        await upsertCommunityMember(env, existingGroup.community_id, owner.id, 'owner');
        const c = await env.DB.prepare('SELECT id, name FROM communities WHERE id = ?').bind(existingGroup.community_id).first();
        await sendTelegramMessage(replyToken, chatId, `Already linked.\n${c?.name || 'Community'} | ${existingGroup.community_id}\nDump mode: ${existingGroup.scope || 'community'}\n/personal or /community · /community_list`, forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }

      const chatTitle = (msg.chat?.title || 'Telegram group').slice(0, 80);
      const id = 'c_' + Date.now().toString(36) + '_' + randomToken().slice(0, 4);
      const now = Date.now();
      await env.DB.prepare(
        'INSERT INTO communities (id, name, creator_id, created_at) VALUES (?, ?, ?, ?)'
      ).bind(id, chatTitle, owner.id, now).run();
      await upsertCommunityMember(env, id, owner.id, 'owner');

      const storeToken = (await decryptBotToken(env, personal.bot_token)) || replyToken || null;
      const botUname = personal.bot_username || 'bot';
      const encStore = storeToken ? await encryptSecret(env, storeToken) : null;
      if (existingGroup) {
        await env.DB.prepare(
          `UPDATE community_bots SET community_id = ?, scope = 'community', group_name = ?, created_by = ?, user_id = ?, bot_token = COALESCE(?, bot_token), bot_username = COALESCE(?, bot_username) WHERE id = ?`
        ).bind(id, chatTitle, owner.id, owner.id, encStore, botUname, existingGroup.id).run();
        binding = await env.DB.prepare('SELECT * FROM community_bots WHERE id = ?').bind(existingGroup.id).first();
      } else {
        const botId = 'bot_' + Date.now().toString(36);
        await env.DB.prepare(
          `INSERT INTO community_bots (id, community_id, platform, bot_username, group_id, group_name, created_by, created_at, scope, user_id, bot_token)
           VALUES (?, ?, 'telegram', ?, ?, ?, ?, ?, 'community', ?, ?)`
        ).bind(botId, id, botUname, chatId, chatTitle, owner.id, now, owner.id, encStore).run();
        binding = await env.DB.prepare('SELECT * FROM community_bots WHERE id = ?').bind(botId).first();
      }

      await sendTelegramMessage(replyToken, chatId, [
        'Community linked to Athena ✓',
        `${chatTitle} | ${id}`,
        '',
        'Members must:',
        '1) Login on the website',
        '2) DM bot → /community_join ' + id,
        'Then they can dump links (group or site).',
        '',
        'You: /community to dump · /personal · /admin · /topic · /community_list',
        'AI & /search: all ranks (community). Personal brain: GOD only. Settings: GOD only.'
      ].join('\n'), forumThreadId);
    } catch (err) {
      console.error('community_verify failed', err);
      const t = token || env.TELEGRAM_BOT_TOKEN;
      if (t) {
        await sendTelegramMessage(t, chatId, `Verify failed: ${err.message || err}\nTry again or re-save bot on website.`, forumThreadId);
      }
    }
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  // ---- confirm community delete: reply YES_DELETE_<token> ----
  if (/^YES_DELETE_[a-f0-9]{8,}$/i.test(text.replace(/\s/g, '')) || /^YES_DELETE_[a-f0-9]{8,}$/i.test(rest.replace(/\s/g, ''))) {
    const tok = (text.match(/YES_DELETE_([a-f0-9]+)/i) || rest.match(/YES_DELETE_([a-f0-9]+)/i) || [])[1];
    if (tok && athenaUser) {
      await ensurePendingDeletesTable(env);
      const pend = await env.DB.prepare(
        'SELECT * FROM pending_community_deletes WHERE token = ? AND owner_user_id = ?'
      ).bind(tok, athenaUser.id).first();
      if (!pend || pend.expires_at < Date.now()) {
        await sendTelegramMessage(token, chatId, 'Delete confirmation expired or invalid. Run /community_delete <id> again.', forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
      const result = await deleteCommunityFully(env, pend.community_id);
      await env.DB.prepare('DELETE FROM pending_community_deletes WHERE token = ?').bind(tok).run();
      if (!result.ok) {
        await sendTelegramMessage(token, chatId, result.error || 'Delete failed', forumThreadId);
      } else {
        if (binding?.community_id === pend.community_id) {
          binding.community_id = null;
          binding.scope = 'personal';
        }
        await sendTelegramMessage(token, chatId,
          `Deleted community:\n${result.name} | ${result.id}\nAll community data wiped.`, forumThreadId);
      }
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
  }

  // ---- /community_delete <id|name> (step 1: ask confirmation) ----
  if (cmd === '/community_delete' || cmd === '/delete_community' || cmd === '/cdelete') {
    if (!athenaUser) {
      await sendTelegramMessage(token, chatId, 'Login with Telegram on the website first.', forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    const arg = rest.trim();
    if (!arg) {
      if (binding?.community_id) {
        await sendTelegramMessage(token, chatId,
          `Usage: /community_delete ${binding.community_id}\nYou will get a confirmation code to reply with.`, forumThreadId);
      } else {
        await sendTelegramMessage(token, chatId, 'Usage: /community_delete <id>\n/community_list to see ids.', forumThreadId);
      }
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    const c = await resolveCommunityByIdOrName(env, athenaUser.id, arg);
    if (!c) {
      await sendTelegramMessage(token, chatId, `Community not found: ${arg}\n/community_list`, forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    // Community owner (creator) or GOD — not admins
    if (c.creator_id !== athenaUser.id && !isGod) {
      await sendTelegramMessage(token, chatId, 'Only the community owner (or GOD) can delete it (not admins).', forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    if (c.id === 'default') {
      await sendTelegramMessage(token, chatId, 'Cannot delete the default system community.', forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    await ensurePendingDeletesTable(env);
    const confTok = randomToken().slice(0, 12);
    const expires = Date.now() + 10 * 60 * 1000;
    await env.DB.prepare(
      `INSERT INTO pending_community_deletes (token, community_id, owner_user_id, chat_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(confTok, c.id, athenaUser.id, chatId, expires, Date.now()).run();
    await sendTelegramMessage(token, chatId, [
      '⚠️ Confirm community wipe',
      `${c.name} | ${c.id}`,
      'This deletes ALL links, members, admins, and the group link.',
      '',
      'Reply exactly with this message to confirm:',
      `YES_DELETE_${confTok}`,
      '',
      'Expires in 10 minutes. Ignore to cancel.'
    ].join('\n'), forumThreadId);
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  // ---- /clear_db <community id> — wipe links only (owner rank) ----
  if (cmd === '/clear_db' || cmd === '/cleardb' || cmd === '/clear_community_db') {
    if (!athenaUser) {
      await sendTelegramMessage(token, chatId, 'Login with Telegram on the website first.', forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    const arg = rest.trim().split(/\s+/)[0] || binding?.community_id || '';
    if (!arg) {
      await sendTelegramMessage(token, chatId, 'Usage: /clear_db <community_id>\n/community_list for ids.', forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    const c = await resolveCommunityByIdOrName(env, athenaUser.id, arg);
    if (!c) {
      await sendTelegramMessage(token, chatId, 'Community not found: ' + arg, forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    const role = await getCommunityMemberRole(env, c.id, athenaUser);
    const allow = isGod || role === 'owner' || c.creator_id === athenaUser.id;
    if (!allow) {
      await sendTelegramMessage(token, chatId, 'Only community owner (or GOD) can /clear_db.', forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    const r = await clearCommunityLinksOnly(env, c.id);
    if (!r.ok) {
      await sendTelegramMessage(token, chatId, r.error || 'Failed', forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    await sendTelegramMessage(token, chatId,
      'Cleared community DB (links only).\n' + r.name + ' | ' + r.id + '\nRemoved ~' + (r.cleared || 0) + ' links.\nCommunity + members kept.',
      forumThreadId);
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  // ---- /clear_personal_db (GOD only) ----
  if (cmd === '/clear_personal_db' || cmd === '/clear_perosnal_db' || cmd === '/clearpersonal') {
    if (!isGod) {
      await sendTelegramMessage(token, chatId, 'GOD rank only (instance host).', forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    if (!athenaUser) {
      await sendTelegramMessage(token, chatId, 'Login on website first.', forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    try {
      await env.DB.prepare('DELETE FROM personal_links WHERE user_id = ?').bind(athenaUser.id).run();
    } catch (_) {}
    await sendTelegramMessage(token, chatId, 'Personal DB cleared for your GOD account.', forumThreadId);
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  // ---- /community_list ----
  if (cmd === '/community_list' || cmd === '/communities' || cmd === '/clist') {
    if (!athenaUser) {
      await sendTelegramFormatted(token, chatId, 'Login with Telegram on the website first.', forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    const arg = rest.trim();
    if (!arg) {
      const statuses = await listUserCommunityStatuses(env, athenaUser, tgUserId);
      if (!statuses.length) {
        await sendTelegramFormatted(token, chatId,
          `${boldHtml('No communities yet.')}\nOwner: ${codeHtml('/community_verify')} in a group\nMember: ${codeHtml('/community_join <id>')}`, forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
      const rankIcons = { god: '👑', owner: '⭐', admin: '🛡', member: '👤', 'in-group': '👥', banned: '🚫' };
      const lines = statuses.map(c => {
        const icon = rankIcons[c.rank] || '';
        return `${icon} ${escHtml(c.name)} | ${codeHtml(c.id)} | ${boldHtml(String(c.rank).toUpperCase())}`;
      });
      await sendTelegramFormatted(token, chatId,
        `${boldHtml('📋 Your Communities')}\n\n${lines.join('\n')}\n\n${codeHtml('/community_list <id>')} for details\n${italicHtml('Ranks: GOD · owner · admin · member · in-group · banned')}`,
        forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    const c = await resolveCommunityByIdOrName(env, athenaUser.id, arg);
    if (!c) {
      await sendTelegramFormatted(token, chatId, `Not found: ${boldHtml(arg)}`, forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    const bot = await env.DB.prepare(
      `SELECT group_id, group_name, topic_id, bot_username FROM community_bots WHERE community_id = ? LIMIT 1`
    ).bind(c.id).first();
    const links = await env.DB.prepare('SELECT COUNT(*) AS n FROM links WHERE community_id = ?').bind(c.id).first();
    const members = await env.DB.prepare('SELECT COUNT(*) AS n FROM community_members WHERE community_id = ?').bind(c.id).first();
    const admins = await env.DB.prepare(
      `SELECT platform, platform_user_id, label FROM community_admins WHERE community_id = ?`
    ).bind(c.id).all();
    const staff = await env.DB.prepare(
      `SELECT u.display_name, u.username, m.role FROM community_members m
       JOIN users u ON u.id = m.user_id
       WHERE m.community_id = ? AND m.role IN ('owner','admin')`
    ).bind(c.id).all();
    const adminLines = [
      ...(staff.results || []).map(a => `• ${a.role}: ${a.display_name || a.username}`),
      ...(admins.results || []).map(a => `• tg admin: ${a.label || a.platform_user_id}`)
    ];
    await sendTelegramFormatted(token, chatId, [
      boldHtml(c.name),
      `${boldHtml('ID:')} ${codeHtml(c.id)}`,
      `${boldHtml('Links:')} ${links?.n || 0}`,
      `${boldHtml('Members:')} ${members?.n || 0}`,
      `${boldHtml('Group:')} ${escHtml(bot?.group_name || '—')} (${codeHtml(bot?.group_id || '—')})`,
      `${boldHtml('Topic lock:')} ${bot?.topic_id || 'OFF'}`,
      `${boldHtml('Bot:')} @${escHtml(bot?.bot_username || '—')}`,
      '',
      boldHtml('Admins:'),
      adminLines.length ? adminLines.join('\n') : italicHtml('(owner only)')
    ].join('\n'), forumThreadId);
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  // ---- /admin (owner replies to user) ----
  if (cmd === '/admin') {
    const isGroup = String(msg.chat?.type || '').includes('group') || chatId.startsWith('-');
    if (!isGroup || !binding?.community_id) {
      await sendTelegramMessage(token, chatId, 'Use /admin as a reply to a user inside a verified community group.', forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    {
      const creator = await env.DB.prepare('SELECT creator_id FROM communities WHERE id = ?').bind(binding.community_id).first();
      const isCreator = athenaUser && creator?.creator_id === athenaUser.id;
      const isBotOwner = await isBotOwnerTg(env, binding, tgUserId, athenaUser);
      if (!isCreator && !isBotOwner) {
        await sendTelegramMessage(token, chatId, 'Only the community owner can /admin.', forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
    }
    const target = msg.reply_to_message?.from;
    if (!target?.id) {
      await sendTelegramMessage(token, chatId, 'Reply to a user\'s message with /admin', forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    const targetTg = String(target.id);
    const targetName = target.first_name || target.username || targetTg;
    const adminId = 'adm_' + Date.now().toString(36);
    // upsert platform admin
    const exists = await env.DB.prepare(
      `SELECT id FROM community_admins WHERE community_id = ? AND platform = 'telegram' AND platform_user_id = ?`
    ).bind(binding.community_id, targetTg).first();
    if (!exists) {
      await env.DB.prepare(
        `INSERT INTO community_admins (id, community_id, platform, platform_user_id, label, created_by, created_at)
         VALUES (?, ?, 'telegram', ?, ?, ?, ?)`
      ).bind(adminId, binding.community_id, targetTg, targetName, athenaUser?.id || binding.created_by, Date.now()).run();
    }
    // if they have Athena account, set member role admin
    const targetUser = await env.DB.prepare(
      `SELECT id FROM users WHERE provider = 'telegram' AND provider_id = ?`
    ).bind(targetTg).first();
    if (targetUser) {
      const mem = await env.DB.prepare(
        'SELECT role FROM community_members WHERE community_id = ? AND user_id = ?'
      ).bind(binding.community_id, targetUser.id).first();
      if (!mem) {
        await env.DB.prepare(
          'INSERT INTO community_members (community_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
        ).bind(binding.community_id, targetUser.id, 'admin', Date.now()).run();
      } else if (mem.role !== 'owner') {
        await env.DB.prepare(
          'UPDATE community_members SET role = ? WHERE community_id = ? AND user_id = ?'
        ).bind('admin', binding.community_id, targetUser.id).run();
      }
    }
    await sendTelegramMessage(token, chatId, `Admin set: ${targetName} (${targetTg})\nThey can /delete · /edit · /topic in this community.`, forumThreadId);
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  
  // ---- /demote (owner: reply or @user/id) ----
  if (cmd === '/demote') {
    const isGroup = String(msg.chat?.type || '').includes('group') || chatId.startsWith('-');
    if (!isGroup || !binding?.community_id) {
      await sendTelegramMessage(token, chatId, 'Use /demote in a verified community group (reply or /demote <id|@user>).', forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    {
      const creator = await env.DB.prepare('SELECT creator_id FROM communities WHERE id = ?').bind(binding.community_id).first();
      const isCreator = athenaUser && creator?.creator_id === athenaUser.id;
      if (!isCreator && !isGod) {
        await sendTelegramMessage(token, chatId, 'Only community owner (or GOD) can /demote.', forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
    }
    let targetTg;
    let targetName;
    const targetMsg = msg.reply_to_message?.from;
    if (targetMsg?.id) {
      targetTg = String(targetMsg.id);
      targetName = targetMsg.first_name || targetMsg.username || targetTg;
    } else {
      const arg = rest.trim().split(/\s+/)[0] || '';
      if (!arg) {
        await sendTelegramMessage(token, chatId, 'Reply to an admin with /demote, or /demote <@username|id>', forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
      const tu = await resolveTgUserByUsernameOrId(env, arg);
      if (!tu) {
        await sendTelegramMessage(token, chatId, 'User not found: ' + arg, forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
      targetTg = String(tu.telegram_api_id || tu.provider_id || '');
      targetName = tu.username || tu.display_name || targetTg;
      // demote member role if Athena user
      if (tu.id && !tu._synthetic) {
        const mem = await env.DB.prepare(
          'SELECT role FROM community_members WHERE community_id = ? AND user_id = ?'
        ).bind(binding.community_id, tu.id).first();
        if (mem?.role === 'owner') {
          await sendTelegramMessage(token, chatId, 'Cannot demote community owner.', forumThreadId);
          return new Response('OK', { status: 200, headers: corsHeaders });
        }
        if (mem) {
          await env.DB.prepare(
            'UPDATE community_members SET role = ? WHERE community_id = ? AND user_id = ?'
          ).bind('member', binding.community_id, tu.id).run();
        }
      }
    }
    if (targetMsg?.id) {
      const tu = await env.DB.prepare(
        `SELECT * FROM users WHERE provider = 'telegram' AND (provider_id = ? OR telegram_api_id = ?)`
      ).bind(targetTg, targetTg).first();
      if (tu) {
        const mem = await env.DB.prepare(
          'SELECT role FROM community_members WHERE community_id = ? AND user_id = ?'
        ).bind(binding.community_id, tu.id).first();
        if (mem?.role === 'owner') {
          await sendTelegramMessage(token, chatId, 'Cannot demote community owner.', forumThreadId);
          return new Response('OK', { status: 200, headers: corsHeaders });
        }
        if (mem) {
          await env.DB.prepare(
            'UPDATE community_members SET role = ? WHERE community_id = ? AND user_id = ?'
          ).bind('member', binding.community_id, tu.id).run();
        }
      }
    }
    try {
      await env.DB.prepare(
        `DELETE FROM community_admins WHERE community_id = ? AND platform = 'telegram' AND platform_user_id = ?`
      ).bind(binding.community_id, targetTg).run();
    } catch (_) {}
    await sendTelegramMessage(token, chatId, 'Demoted to member: ' + targetName + ' (' + targetTg + ')', forumThreadId);
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  // ---- /clear <@user|id> — remove from community (admin+; admin cannot clear owner/god/admin) ----
  if (cmd === '/clear') {
    const cid = binding?.community_id;
    if (!cid) {
      await sendTelegramMessage(token, chatId, 'Use /clear in a verified community group (or with community linked).', forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    if (!isCommAdmin && !isGod) {
      await sendTelegramMessage(token, chatId, 'Admin/owner only.', forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    let targetTg;
    let targetUser;
    let targetName;
    if (msg.reply_to_message?.from?.id) {
      targetTg = String(msg.reply_to_message.from.id);
      targetName = msg.reply_to_message.from.first_name || msg.reply_to_message.from.username || targetTg;
      targetUser = await env.DB.prepare(
        `SELECT * FROM users WHERE provider = 'telegram' AND (provider_id = ? OR telegram_api_id = ?)`
      ).bind(targetTg, targetTg).first();
    } else {
      const arg = rest.trim().split(/\s+/)[0] || '';
      if (!arg) {
        await sendTelegramMessage(token, chatId, 'Usage: /clear <@username|telegram_id>\nOr reply to their message with /clear', forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
      targetUser = await resolveTgUserByUsernameOrId(env, arg);
      if (!targetUser) {
        await sendTelegramMessage(token, chatId, 'User not found: ' + arg, forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
      targetTg = String(targetUser.telegram_api_id || targetUser.provider_id || arg.replace(/^@/, ''));
      targetName = targetUser.username || targetUser.display_name || targetTg;
      if (targetUser._synthetic) targetUser = null;
    }
    // Protect GOD
    if (isGodTgId(targetTg, env) || (targetUser && await isGodUserAsync(targetUser, env))) {
      await sendTelegramMessage(token, chatId, 'Cannot /clear GOD rank.', forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    const targetRole = targetUser ? await getCommunityMemberRole(env, cid, targetUser) : null;
    // Admin cannot clear owner or other admins; owner/god can clear admin+member
    if (!isGod && userRank === 'admin') {
      if (targetRole === 'owner' || targetRole === 'admin') {
        await sendTelegramMessage(token, chatId, 'Admins can only /clear member rank (not owner/admin).', forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
      // platform admin ids
      const padm = await env.DB.prepare(
        `SELECT 1 FROM community_admins WHERE community_id = ? AND platform = 'telegram' AND platform_user_id = ?`
      ).bind(cid, targetTg).first();
      if (padm) {
        await sendTelegramMessage(token, chatId, 'Admins can only /clear member rank (not admin).', forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
    }
    if (targetRole === 'owner' && !isGod) {
      // only god can clear owner? actually owner clearing self weird; other owners N/A
      const creator = await env.DB.prepare('SELECT creator_id FROM communities WHERE id = ?').bind(cid).first();
      if (targetUser && creator?.creator_id === targetUser.id) {
        await sendTelegramMessage(token, chatId, 'Cannot /clear community owner.', forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
    }
    if (targetUser?.id) {
      try {
        await env.DB.prepare('DELETE FROM community_members WHERE community_id = ? AND user_id = ?')
          .bind(cid, targetUser.id).run();
      } catch (_) {}
    }
    try {
      await env.DB.prepare(
        `DELETE FROM community_admins WHERE community_id = ? AND platform = 'telegram' AND platform_user_id = ?`
      ).bind(cid, targetTg).run();
    } catch (_) {}
    // not a ban — can rejoin via /community_join
    await sendTelegramMessage(token, chatId,
      'Removed from community: ' + targetName + ' (' + targetTg + ')\nThey can /community_join ' + cid + ' again after login.',
      forumThreadId);
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

// ---- /topic <id> | off | (show) — simple lock for this community ----
  if (cmd === '/topic') {
    const args = rest.trim().split(/\s+/).filter(Boolean);
    const msgThreadId = msg.message_thread_id != null ? String(msg.message_thread_id) : null;
    const isGroup = String(msg.chat?.type || '').includes('group') || chatId.startsWith('-');

    // Resolve target binding: group binding or DM + community id/name
    let targetBinding = null;
    let topicArg = '';

    if (isGroup && binding?.community_id) {
      targetBinding = binding;
      topicArg = args[0] || '';
    } else if (!isGroup && athenaUser) {
      // DM: /topic <community> <topicId>  OR  /topic <topicId> if only one community
      if (args.length >= 2) {
        const c = await resolveCommunityByIdOrName(env, athenaUser.id, args[0]);
        if (!c) {
          await sendTelegramMessage(token, chatId, `Community not found: ${args[0]}`, forumThreadId);
          return new Response('OK', { status: 200, headers: corsHeaders });
        }
        targetBinding = await env.DB.prepare(
          `SELECT * FROM community_bots WHERE community_id = ? AND COALESCE(scope,'community') = 'community' LIMIT 1`
        ).bind(c.id).first();
        topicArg = args[1];
      } else if (args.length === 1 && !/^\d+$/.test(args[0]) && !['off', 'clear', 'here', 'this'].includes(args[0].toLowerCase())) {
        // show status for named community
        const c = await resolveCommunityByIdOrName(env, athenaUser.id, args[0]);
        if (!c) {
          await sendTelegramMessage(token, chatId, `Not found: ${args[0]}`, forumThreadId);
          return new Response('OK', { status: 200, headers: corsHeaders });
        }
        targetBinding = await env.DB.prepare(
          `SELECT * FROM community_bots WHERE community_id = ? LIMIT 1`
        ).bind(c.id).first();
        topicArg = '';
      } else {
        const { results } = await env.DB.prepare(
          `SELECT b.* FROM community_bots b
           INNER JOIN communities c ON c.id = b.community_id
           WHERE (b.created_by = ? OR b.user_id = ?) AND COALESCE(b.scope,'community') = 'community'
           ORDER BY b.created_at DESC`
        ).bind(athenaUser.id, athenaUser.id).all();
        const list = results || [];
        if (list.length === 1) {
          targetBinding = list[0];
          topicArg = args[0] || '';
        } else if (!args.length) {
          const lines = list.map(b => `${b.group_name || b.community_id} | topic=${b.topic_id || 'OFF'}`);
          await sendTelegramMessage(token, chatId,
            lines.length
              ? `Topics:\n${lines.join('\n')}\n\n/topic <community id|name> <topic_id>`
              : 'No communities. /community_verify in a group first.', forumThreadId);
          return new Response('OK', { status: 200, headers: corsHeaders });
        } else {
          await sendTelegramMessage(token, chatId, 'Usage (DM): /topic <community id|name> <topic_id>\nOr /topic off for a community.', forumThreadId);
          return new Response('OK', { status: 200, headers: corsHeaders });
        }
      }
    } else if (isGroup && !binding?.community_id) {
      await sendTelegramMessage(token, chatId, 'Group not verified. Owner: /community_verify first.', forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }

    if (!targetBinding?.id) {
      await sendTelegramMessage(token, chatId, 'No community bot binding found.', forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }

    const canManage = await isBotOwnerTg(env, targetBinding, tgUserId, athenaUser)
      || (targetBinding.community_id && await isTgUserCommunityStaff(env, targetBinding.community_id, tgUserId, athenaUser));
    const currentTopic = targetBinding.topic_id ? String(targetBinding.topic_id) : null;

    if (!topicArg) {
      await sendTelegramMessage(token, chatId,
        currentTopic
          ? `Topic lock ON: ${currentTopic}\n/topic off to clear`
          : `Topic lock OFF (whole group).\n/topic <id> to lock${msgThreadId ? `\nThis topic id: ${msgThreadId}` : ''}`, forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }

    if (!canManage) {
      await sendTelegramMessage(token, chatId, 'Only owner/admins can set /topic.', forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }

    if (['off', 'clear', '0', 'none', 'disable'].includes(topicArg.toLowerCase())) {
      await env.DB.prepare(`UPDATE community_bots SET topic_id = NULL WHERE id = ?`).bind(targetBinding.id).run();
      await sendTelegramMessage(token, chatId, 'Topic lock cleared — whole group.', forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }

    let topicId = ['here', 'this', 'current'].includes(topicArg.toLowerCase())
      ? msgThreadId
      : topicArg.replace(/[^\d]/g, '');
    if (!topicId) {
      await sendTelegramMessage(token, chatId, 'Usage: /topic <topic_id> | /topic here | /topic off', forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    await env.DB.prepare(`UPDATE community_bots SET topic_id = ? WHERE id = ?`).bind(topicId, targetBinding.id).run();
    await sendTelegramMessage(token, chatId, `Topic lock set: ${topicId}\nOnly links in that topic are saved for this community.`, forumThreadId);
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  // /dumpall on|off|status   /dumpsmart = off
  if (cmd === '/dumpsmart' || cmd === '/dumpall') {
    if (!binding?.id) {
      await sendTelegramMessage(token, chatId, 'Link this chat first (Settings → Bot).', forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    if (!isCommAdmin && !isGod) {
      await sendTelegramMessage(token, chatId, 'Admin/owner only.', forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    const arg = (rest.split(/\s+/)[0] || '').toLowerCase();
    let mode;
    if (cmd === '/dumpsmart') mode = 'smart';
    else if (['on', 'all', '1', 'true', 'yes'].includes(arg)) mode = 'all';
    else if (['off', 'smart', '0', 'false', 'no'].includes(arg)) mode = 'smart';
    else if (!arg) {
      const cur = (binding.dump_link_mode || dumpLinkMode || 'smart').toLowerCase();
      await sendTelegramMessage(token, chatId,
        `Multi-link dump mode: ${cur === 'all' ? 'ON (save every URL)' : 'OFF (SMART — primary only)'}\n\n/dumpall on — save every URL\n/dumpall off — SMART (default)`, forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    } else {
      await sendTelegramMessage(token, chatId, 'Usage: /dumpall on | /dumpall off | /dumpall', forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }

    await setDumpLinkMode(mode);
    await sendTelegramMessage(token, chatId,
      mode === 'all'
        ? 'dumpall ON — every URL in a multi-link post is saved separately.\n/dumpall off to return to SMART.'
        : 'dumpall OFF (SMART) — multi-link posts save the main project URL once; caption cleaned into notes.', forumThreadId);
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  if (cmd === '/id') {
    const threadId = msg.message_thread_id != null ? String(msg.message_thread_id) : null;
    const isGroup = String(msg.chat?.type || '').includes('group') || chatId.startsWith('-');
    await sendTelegramMessage(token, chatId, [
      `Chat ID: ${chatId}`,
      `Your user ID: ${tgUserId || 'n/a'}`,
      threadId ? `Topic ID: ${threadId}` : null,
      binding?.community_id ? `Community: ${binding.group_name || ''} | ${binding.community_id}` : null,
      '',
      isGroup
        ? 'Owner links group with /community_verify'
        : 'Personal: paste Chat ID + bot token on website Settings → Bot'
    ].filter(Boolean).join('\n'), forumThreadId);
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  // ---- mode switch: personal ↔ community (owner-controlled dual mode) ----
  if (cmd === '/personal' || cmd === '/community' || cmd === '/mode') {
    if (!binding?.id) {
      await sendTelegramMessage(token, chatId, 'Chat not linked. Settings → Bot: token + chat ID. Groups: /community_verify first.', forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    if (cmd === '/personal') {
      if (!isGod) {
        await sendTelegramMessage(token, chatId,
          'Personal mode is GOD rank only (instance host).\n/community_join <id> for community dumps.', forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
    }
    let scope = binding.scope || (binding.community_id ? 'community' : 'personal');
    if (cmd === '/personal') scope = 'personal';
    else if (cmd === '/community') {
      if (!binding.community_id) {
        // try first community of user (website-linked or previously verified)
        if (athenaUser) {
          const c = await env.DB.prepare(
            `SELECT c.id, c.name FROM communities c
             INNER JOIN community_members m ON m.community_id = c.id
             WHERE m.user_id = ? ORDER BY c.created_at DESC LIMIT 1`
          ).bind(athenaUser.id).first();
          if (c) {
            await env.DB.prepare(
              `UPDATE community_bots SET community_id = ?, group_name = COALESCE(group_name, ?) WHERE id = ?`
            ).bind(c.id, c.name, binding.id).run();
            binding.community_id = c.id;
          }
        }
        if (!binding.community_id) {
          await sendTelegramMessage(token, chatId,
            'No community on this chat yet.\nIn a group: bot owner runs /community_verify\nThen /community to dump into it.', forumThreadId);
          return new Response('OK', { status: 200, headers: corsHeaders });
        }
      }
      scope = 'community';
    } else if (cmd === '/mode') {
      const arg = (rest.split(/\s+/)[0] || '').toLowerCase();
      if (arg === 'personal' || arg === 'community') {
        if (arg === 'community' && !binding.community_id) {
          await sendTelegramMessage(token, chatId, 'No community linked. /community_verify in a group first.', forumThreadId);
          return new Response('OK', { status: 200, headers: corsHeaders });
        }
        scope = arg;
      } else {
        await sendTelegramMessage(token, chatId,
          `Current dump mode: ${scope}${binding.community_id ? `\nCommunity: ${binding.group_name || binding.community_id}` : ''}\n/personal or /community to switch.`, forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
    }
    await env.DB.prepare(`UPDATE community_bots SET scope = ? WHERE id = ?`).bind(scope, binding.id).run();
    binding.scope = scope;
    await sendTelegramMessage(token, chatId,
      scope === 'personal'
        ? 'Mode: PERSONAL. Links you paste save to your personal brain. /search → personal.'
        : `Mode: COMMUNITY. Links save to community brain${binding.group_name ? ` (${binding.group_name})` : ''}. Members can paste links. /search → community.`, forumThreadId);
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  // ---- /search ----
  if (cmd === '/search') {
    const q = rest || '';
    // Determine scope: use binding if available, else personal for DMs
    let scope = 'personal';
    let searchCommunityId = null;
    if (binding) {
      scope = binding.scope || (binding.community_id ? 'community' : 'personal');
      searchCommunityId = binding.community_id;
    } else {
      const isDm = !String(chatId).startsWith('-');
      if (!isDm) {
        await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} Not linked. Bot owner: /community_verify in the group first.`, forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
    }
    // Personal mode: GOD rank only
    if (scope === 'personal') {
      if (!isGod) {
        await sendTelegramFormatted(token, chatId, `${boldHtml('🔒')} Personal search is GOD rank only. Use /search in a community group, or /community_join to join one.`, forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
      if (!athenaUser) {
        await sendTelegramFormatted(token, chatId, 'Login with Telegram on the website first so personal search works.', forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
      await ensureFresh(env, 'personal', athenaUser.id);
      const rows = await candidateLinks(env, 'personal', athenaUser.id, q);
      const hits = fuzzyMatchLinks(rows, q);
      if (!hits.length) {
        await sendTelegramFormatted(token, chatId, q ? `No personal results for: ${boldHtml(q)}` : 'No personal links yet.', forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
      const lines = hits.map((h) => {
        const t = (h.title && !/^link from telegram/i.test(h.title)) ? h.title : titleFromUrl(h.url || '');
        const d = (h.notes || '').trim();
        const isDoc = h.isDocument || h.type === 'document';
        const prefix = isDoc ? '📄' : '🔗';
        let line = `${prefix} ${boldHtml(t)}`;
        if (h.url) line += `\n${linkHtml(h.url, h.url)}`;
        else if (isDoc) line += `\n${italicHtml('(document)')}`;
        if (d) line += `\n${escHtml(d.slice(0, 150))}`;
        return line;
      }).join('\n\n');
      await sendTelegramFormatted(token, chatId, `${boldHtml('🔍 Personal Search')} (${hits.length} results)\n\n${lines}`, forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    // Community mode: all ranks
    if (!searchCommunityId) {
      await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} Community not set. /community after linking community on website.`, forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    if (athenaUser && await isBannedFromCommunity(env, searchCommunityId, athenaUser)) {
      await sendTelegramFormatted(token, chatId, `${boldHtml('🚫')} You are banned from this community.`, forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    const isElevatedSearch = (athenaUser && await isElevatedUser(athenaUser, env)) || isInstanceOwnerTgId(tgUserId, env);
    if (athenaUser && !isElevatedSearch) {
      const presence = await syncCommunityGroupPresence(env, searchCommunityId, athenaUser);
      if (!presence.inGroup) {
        await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} Not in the Telegram group — rejoin to search this community.`, forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
    }
    if (athenaUser && !(await ensureMember(searchCommunityId, athenaUser.id, env)) && !isElevatedSearch) {
      await sendTelegramFormatted(token, chatId, `Join first: ${codeHtml('/community_join ' + searchCommunityId)}`, forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    await ensureFresh(env, 'community', searchCommunityId);
    const rows = await candidateLinks(env, 'community', searchCommunityId, q);
    const hits = fuzzyMatchLinks(rows, q);
    if (!hits.length) {
      await sendTelegramFormatted(token, chatId, q ? `No results for: ${boldHtml(q)}` : 'No links in this community brain yet.', forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    const lines = hits.map((h) => {
      const t = (h.title && !/^link from telegram/i.test(h.title)) ? h.title : titleFromUrl(h.url || '');
      const d = (h.notes || '').trim();
      const isDoc = h.isDocument || h.type === 'document';
      const prefix = isDoc ? '📄' : '🔗';
      let line = `${prefix} ${boldHtml(t)}`;
      if (h.url) line += `\n${linkHtml(h.url, h.url)}`;
      else if (isDoc) line += `\n${italicHtml('(document)')}`;
      if (d) line += `\n${escHtml(d.slice(0, 150))}`;
      return line;
    }).join('\n\n');
    await sendTelegramFormatted(token, chatId, `${boldHtml('🔍 Community Search')} (${hits.length} results)\n\n${lines}`, forumThreadId);
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

   // ---- /ai (same RAG + proxy as website, with thinking blocks) ----
   if (cmd === '/ai') {
     const q = rest || '';
     if (!q) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('🧠 Usage:')} ${codeHtml('/ai your question about your brain')}\nExample: ${codeHtml('/ai how do I download youtube videos')}`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     if (!athenaUser) {
       await sendTelegramFormatted(token, chatId, 'Login with Telegram on the website first.', forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     await ensureAiConfigTable(env);
     const cfg = await getInstanceAiConfig(env);
     if (!cfg || !cfg.api_key) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} No AI credentials synced yet.\nGOD: open website → Settings → AI → paste key → Save\n${italicHtml('(that writes the instance default used by all ranks on site + /ai)')}`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }

     // Determine scope: use binding if available, else personal for DMs
     let scope = 'personal';
     let aiCommunityId = null;
     if (binding) {
       scope = binding.scope || (binding.community_id ? 'community' : 'personal');
       aiCommunityId = binding.community_id;
     } else {
       const isDm = !String(chatId).startsWith('-');
       if (!isDm) {
         await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} Not linked. Bot owner: ${codeHtml('/community_verify')} in the group first.`, forumThreadId);
         return new Response('OK', { status: 200, headers: corsHeaders });
       }
     }
     // Personal mode: GOD rank only
     if (scope === 'personal') {
       if (!isGod) {
         await sendTelegramFormatted(token, chatId, `${boldHtml('🔒')} Personal AI is GOD rank only. Use ${codeHtml('/ai')} in a community group, or ${codeHtml('/community_join')} to join one.`, forumThreadId);
         return new Response('OK', { status: 200, headers: corsHeaders });
       }
     } else {
       // Community mode: all ranks, with ban + membership checks
       if (!aiCommunityId) {
         await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} Community not set. ${codeHtml('/community')} after linking community on website.`, forumThreadId);
         return new Response('OK', { status: 200, headers: corsHeaders });
       }
       if (!isGod && await isBannedFromCommunity(env, aiCommunityId, athenaUser)) {
         await sendTelegramFormatted(token, chatId, `${boldHtml('🚫')} You are banned from this community.`, forumThreadId);
         return new Response('OK', { status: 200, headers: corsHeaders });
       }
       if (!(await ensureMember(aiCommunityId, athenaUser.id, env)) && !isGod) {
         await sendTelegramFormatted(token, chatId, `Join first: ${codeHtml('/community_join ' + aiCommunityId)}`, forumThreadId);
         return new Response('OK', { status: 200, headers: corsHeaders });
       }
     }

     // RAG retrieval — same logic as website (candidateLinks + fuzzyMatchLinks)
     const scopeKey = scope === 'personal' ? athenaUser.id : aiCommunityId;
     await ensureFresh(env, scope, scopeKey);
     const rows = await candidateLinks(env, scope, scopeKey, q);
     let docs = fuzzyMatchLinks(rows, q);
     if (docs.length < 3 && rows.length) {
       const recent = rows.slice(0, 10);
       for (const it of recent) { if (!docs.find(d => d.id === it.id)) docs.push(it); }
       docs = docs.slice(0, 10);
     }
     if (!docs.length && rows.length) docs = rows.slice(0, 8);

     // Build context — same format as website (includes document content)
     const formatDoc = (item, i) => {
       const notes = (item.notes || '').slice(0, 800);
       const content = (item.content || '').slice(0, 60000);
       const parts = [`[#${i + 1}]`, `Title: ${item.title || 'Untitled'}`];
       if (item.filename) parts.push(`Document: ${item.filename}`);
       if (item.url) parts.push(`URL: ${item.url}`);
       if (notes) parts.push(`Notes: ${notes}`);
       if (content) parts.push(`Content:\n${content}`);
       return parts.join('\n');
     };
     let used = 0;
     const ctx = docs.length
       ? docs.map((d, i) => {
         const remaining = Math.max(0, 30000 - used);
         const formatted = formatDoc(d, i).slice(0, remaining);
         used += formatted.length;
         return formatted;
       }).filter(Boolean).join('\n\n')
       : '(no saved items)';

     // Same system prompt as website
     const systemPrompt = `You are Athena, a second-brain assistant. You ONLY use BRAIN CONTEXT below (the user's saved links, notes, and uploaded documents).

Rules:
1. NEVER say the brain is empty if BRAIN CONTEXT lists any items — use them.
2. By default give concise, direct answers. When the user says "in detail", "detailed", "explain", or asks for more depth, be thorough and comprehensive.
3. Answer DIRECTLY. NEVER include "Thinking", numbered analysis steps, evaluation of items, or meta-commentary about your reasoning. Start immediately with the answer.
4. When an uploaded DOCUMENT answers the question, read its relevant sections and present them clearly. Cite as [#n].
5. Recommend saved URLs when applicable. Cite as [#n].
6. Stay strictly grounded in BRAIN CONTEXT; never invent facts not present in it.

BRAIN has ${rows.length} saved item(s). Retrieved for this question:

${ctx}`;

     const thinkMsg = await sendTelegramFormatted(token, chatId, `${boldHtml('🧠')} Thinking with your${scope === 'personal' ? ' personal' : ''} brain…`, forumThreadId);
     const thinkMsgId = thinkMsg.message_id;

     const endpoint = resolveChatEndpoint(cfg.base_url, cfg.mode || 'openai');
     const model = normalizeModelId(cfg.model, cfg.base_url);
     const aiMode = (cfg.mode || 'openai').toLowerCase();

     try {
       let content = '';

       if (aiMode === 'anthropic') {
         const res = await fetch(endpoint, {
           method: 'POST',
           headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.api_key, 'anthropic-version': '2023-06-01' },
           body: JSON.stringify({ model, max_tokens: 3000, system: systemPrompt, messages: [{ role: 'user', content: q }] })
         });
         if (!res.ok) {
           const errText = await res.text().catch(() => '');
           throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
         }
         const data = await res.json().catch(() => ({}));
         content = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
       } else {
         const res = await fetch(endpoint, {
           method: 'POST',
           headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.api_key}` },
           body: JSON.stringify({ model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: q }], temperature: 0.2, max_tokens: 3000 })
         });
         if (!res.ok) {
           const errText = await res.text().catch(() => '');
           throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
         }
         const data = await res.json().catch(() => ({}));
         content = data.choices?.[0]?.message?.content || data.choices?.[0]?.text || '';
       }

       // Convert markdown-style links to Telegram HTML: [text](url) → <a href="url">text</a>
       const aiHtml = escHtml(content || '(empty)')
         .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>')
         .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
         .replace(/`([^`]+)`/g, '<code>$1</code>')
         .replace(/\[#(\d+)\]/g, '<b>[#$1]</b>')
         .replace(/\[(\d+)\]/g, '<b>[$1]</b>');
       let msg = `${boldHtml('🧠 AI Answer')}\n\n${aiHtml}`;

       // Find cited sources in the answer (e.g., [#1], [#2])
       const citedIndices = new Set();
       const citeRegex = /\[#(\d+)\]/g;
       let citeMatch;
       while ((citeMatch = citeRegex.exec(content || '')) !== null) {
         citedIndices.add(parseInt(citeMatch[1], 10) - 1); // 0-based index
       }
       // Also check for [#n] without brackets
       const citeRegex2 = /\[(\d+)\]/g;
       while ((citeMatch = citeRegex2.exec(content || '')) !== null) {
         citedIndices.add(parseInt(citeMatch[1], 10) - 1);
       }

       // Separate main cited sources from other sources
       const mainSources = [];
       const otherSources = [];
       docs.slice(0, 5).forEach((d, i) => {
         const t = d.title || titleFromUrl(d.url || '');
         const isDoc = d.isDocument || d.type === 'document';
         const sourceLine = isDoc ? `📄 ${t}` : (d.url ? `🔗 ${t}\n${d.url}` : null);
         if (!sourceLine) return;
         if (citedIndices.has(i)) {
           mainSources.push(sourceLine);
         } else {
           otherSources.push(sourceLine);
         }
       });

       // Main source (cited in answer) — shown prominently
       if (mainSources.length) {
         msg += `\n\n${mainSources.join('\n')}`;
       }
       // Other sources — shown below
       if (otherSources.length) {
         msg += `\n\n${boldHtml('📚 Other Sources:')}\n${otherSources.join('\n')}`;
       } else if (!mainSources.length && docs.length) {
         // Fallback: if no citations found, show all as Sources
         const allSources = docs.slice(0, 5).map(d => {
           const t = d.title || titleFromUrl(d.url || '');
           const isDoc = d.isDocument || d.type === 'document';
           return isDoc ? `📄 ${t}` : (d.url ? `🔗 ${t}\n${d.url}` : null);
         }).filter(Boolean);
         if (allSources.length) msg += `\n\n${boldHtml('📚 Sources:')}\n${allSources.join('\n')}`;
       }

        await editTelegramMessage(token, chatId, thinkMsgId, msg, null, forumThreadId);
      } catch (err) {
        await editTelegramMessage(token, chatId, thinkMsgId, `${boldHtml('❌ AI failed:')} ${escHtml(err.message)}`, null, forumThreadId);
      }
     return new Response('OK', { status: 200, headers: corsHeaders });
   }

  // ---- /db — show storage backend (all ranks) ----
  if (cmd === '/db') {
    const cfg = await getStorageConfig(env);
    const provider = cfg?.provider || 'd1';
    const selfHosted = isSelfHosted(env);
    const scope = binding?.scope || (binding?.community_id ? 'community' : 'personal');
    const lines = [
      boldHtml('🗄 Storage Backend'),
      '',
    ];
    // Read from instance_storage_config to show the selected provider
    if (provider === 'local') {
      lines.push(
        `${boldHtml('Engine:')} ${codeHtml(selfHostedEngine(env))}`,
        `${boldHtml('Active:')} ${codeHtml('local')} (source of truth)`,
        `${boldHtml('Mode:')} self-hosted (${selfHostedEngine(env)})`,
        `${boldHtml('Runtime:')} Node.js`,
      );
    } else if (provider === 'github') {
      lines.push(
        `${boldHtml('Engine:')} ${codeHtml('GitHub Markdown')}`,
        `${boldHtml('Active:')} ${codeHtml('github')} (source of truth)`,
        `${boldHtml('Runtime:')} Cloudflare Workers`,
      );
      if (cfg?.repo) {
        lines.push(`${boldHtml('Repo:')} ${codeHtml(cfg.repo + '@' + (cfg.branch || 'main'))}`);
      }
      lines.push(
        `${boldHtml('Reads:')} from GitHub (cached in D1 for speed)`,
        `${boldHtml('Writes:')} to GitHub + D1 cache`,
      );
    } else {
      lines.push(
        `${boldHtml('Engine:')} ${codeHtml('Cloudflare D1')}`,
        `${boldHtml('Active:')} ${codeHtml('d1')} (source of truth)`,
        `${boldHtml('Runtime:')} Cloudflare Workers`,
      );
      if (cfg?.repo) {
        lines.push(
          `${boldHtml('GitHub:')} ${codeHtml(cfg.repo + '@' + (cfg.branch || 'main'))} (configured, inactive)`,
          '',
          italicHtml('GitHub is not used until you switch. /sync pushes D1 → GitHub.'),
        );
      } else {
        lines.push('', italicHtml('No GitHub configured. D1 is the only store.'));
      }
    }
    lines.push('', `${boldHtml('Your dump mode:')} ${codeHtml(scope)}`);
    if (binding?.community_id) {
      lines.push(`${boldHtml('Community:')} ${escHtml(binding.group_name || binding.community_id)}`);
    }
    if (selfHosted) {
      lines.push('', `${codeHtml('/backup')} ${italicHtml('for instant Telegram/Drive backup')}`);
    } else if (cfg?.repo) {
      lines.push('', `${codeHtml('/sync')} ${italicHtml('to sync D1 ↔ GitHub (GOD only)')}`);
    } else {
      lines.push('', italicHtml('No GitHub configured. /sync unavailable.'));
    }
    await sendTelegramFormatted(token, chatId, lines.join('\n'), forumThreadId);
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  // ---- /sync — sync between D1 and GitHub (GOD only) ----
  if (cmd === '/sync') {
    if (!isGod) {
      await sendTelegramFormatted(token, chatId, `${boldHtml('🔒 GOD rank only')}\n/sync syncs links between D1 and GitHub (Cloudflare) or shows backup status (self-hosted).`, forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    if (!athenaUser) {
      await sendTelegramFormatted(token, chatId, 'Login on the website first.', forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    if (isSelfHosted(env)) {
      const engine = selfHostedEngine(env);
      await sendTelegramFormatted(token, chatId, [
        boldHtml('ℹ️ Self-Hosted Mode'),
        '',
        `${boldHtml('Engine:')} ${codeHtml(engine)}`,
        `${boldHtml('Runtime:')} Node.js`,
        '',
        'Your data lives in your own database.',
        'No GitHub sync needed — use /backup for Telegram/Drive backups.',
        '',
        italicHtml('Website → Settings → Storage for backup options.')
      ].join('\n'), forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    const cfg = await getStorageConfig(env);
    if (!cfg?.repo || !cfg?.token) {
      await sendTelegramFormatted(token, chatId, [
        boldHtml('⚠️ No GitHub repo configured'),
        '',
        'Sync requires a GitHub repo + token.',
        'Website → Settings → Storage → set repo + token first.',
        '',
        italicHtml('Current storage: Cloudflare D1 only')
      ].join('\n'), forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    const provider = cfg?.provider || 'd1';
    await sendTelegramFormatted(token, chatId, `${boldHtml('🔄 Syncing')} D1 ↔ GitHub…`, forumThreadId);
    try {
      const store = new GitHubStore({ repo: cfg.repo, branch: cfg.branch || 'main', token: cfg.token });
      if (!store.valid) throw new Error('GitHub credentials incomplete');
      const merged = await mergeAllScopes(env, store, athenaUser.id);
      if (!merged.ok) throw new Error(merged.error);
      const lines = [
        boldHtml('✅ Sync Complete'),
        '',
        `${boldHtml('Direction:')} ${codeHtml('D1 ↔ GitHub')} (bidirectional)`,
        `${boldHtml('Pushed:')} ${codeHtml(String(merged.total))} link(s)`,
        merged.detail ? `${boldHtml('Detail:')} ${escHtml(merged.detail)}` : null,
        '',
        'D1 and GitHub are now in sync.',
        '',
        `${boldHtml('Active:')} ${codeHtml(provider === 'github' ? 'GitHub (source of truth)' : 'D1')}`,
        `${boldHtml('Mirror:')} ${codeHtml(provider === 'github' ? 'D1 (cache)' : 'GitHub (backup)')}`,
        '',
        italicHtml('Website → Settings → Storage to switch active backend.')
      ].filter(Boolean);
      await sendTelegramFormatted(token, chatId, lines.join('\n'), forumThreadId);
    } catch (err) {
      await sendTelegramFormatted(token, chatId, `${boldHtml('❌ Sync failed:')} ${escHtml(err.message)}`, forumThreadId);
    }
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  // ---- /backup (GOD only, self-hosted) ----
  if (cmd === '/backup') {
    if (!isGod) {
      await sendTelegramFormatted(token, chatId, `${boldHtml('🔒 GOD rank only')}\n/backup triggers an immediate database backup.`, forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    if (!athenaUser) {
      await sendTelegramFormatted(token, chatId, 'Login on the website first.', forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    if (!isSelfHosted(env)) {
      await sendTelegramFormatted(token, chatId, [
        boldHtml('ℹ️ Cloudflare Mode'),
        '',
        'Backups are managed by Cloudflare D1.',
        'Use the website → Settings → Storage for export.',
        '',
        italicHtml('/backup is only available on self-hosted instances.')
      ].join('\n'), forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    // Check if backup function is available
    if (!env.runBackup) {
      await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} Backup function not available. Check server configuration.`, forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    // Show inline keyboard for backup destination
    const backupKeyboard = {
      inline_keyboard: [
        [
          { text: '📤 Backup to Telegram', callback_data: 'backup:telegram' },
          { text: '☁️ Backup to Drive', callback_data: 'backup:drive' }
        ],
        [
          { text: '📦 Backup to Both', callback_data: 'backup:both' },
          { text: '❌ Cancel', callback_data: 'backup:cancel' }
        ]
      ]
    };
    await sendTelegramMessageWithKeyboard(token, chatId, [
      boldHtml('📦 Database Backup'),
      '',
      `${boldHtml('Engine:')} ${codeHtml(selfHostedEngine(env))}`,
      `${boldHtml('Runtime:')} Node.js`,
      '',
      'Choose backup destination:',
      '• Telegram — sends .sql.gz to this chat',
      '• Drive — uploads to Google Drive (if configured)',
      '• Both — sends to both destinations',
      '',
      italicHtml('This creates a full database dump you can restore later.')
    ].join('\n'), backupKeyboard, forumThreadId);
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  // ---- /edit ----
  if (cmd === '/edit') {
    if (!binding) {
      await sendTelegramMessage(token, chatId, 'Not linked.', forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    // /edit query | new notes   OR  /edit query | title: X | notes: Y
    let payload = rest;
    if ((!payload || !payload.includes('|')) && msg.reply_to_message) {
      const ru = extractUrlsFromTelegramMessage(msg.reply_to_message);
      const rt = (msg.reply_to_message.text || msg.reply_to_message.caption || '').trim();
      const left = ru[0] || rt.split(/\s+/)[0] || '';
      if (left && rest) payload = `${left} | ${rest}`;
      else if (left) payload = left;
    }
    if (!payload || !payload.includes('|')) {
      await sendTelegramMessage(token, chatId,
        'Usage:\n/edit <url or title words> | <new description>\n/edit <url> | title: New Title | notes: New notes\nOr reply to a saved-link message: /edit | new description', forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    const pipe = payload.indexOf('|');
    const queryPart = payload.slice(0, pipe).trim();
    const editPart = payload.slice(pipe + 1).trim();
    if (!queryPart || !editPart) {
      await sendTelegramMessage(token, chatId, 'Need both search side and edit side, separated by |', forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }

    let newTitle = null;
    let newNotes = null;
    if (/title\s*:/i.test(editPart) || /notes\s*:/i.test(editPart)) {
      const tm = editPart.match(/title\s*:\s*([\s\S]*?)(?=\|\s*notes\s*:|$)/i);
      const nm = editPart.match(/notes\s*:\s*([\s\S]*?)$/i);
      if (tm) newTitle = tm[1].replace(/\|\s*$/, '').trim();
      if (nm) newNotes = nm[1].trim();
      if (newTitle == null && newNotes == null) newNotes = editPart;
    } else {
      newNotes = editPart;
    }

    const scope = binding.scope || (binding.community_id ? 'community' : 'personal');
    let rows;
    if (scope === 'personal') {
      if (!isGod) {
        await sendTelegramMessage(token, chatId, 'Personal /edit is GOD rank only.', forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
      if (!athenaUser) {
        await sendTelegramMessage(token, chatId, 'Login with Telegram on the website once.', forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
      await ensureFresh(env, 'personal', athenaUser.id);
      rows = await candidateLinks(env, 'personal', athenaUser.id, queryPart);
    } else {
      if (!binding.community_id) {
        await sendTelegramMessage(token, chatId, 'No community linked.', forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
      const staff = isCommAdmin || await isTgUserCommunityStaff(env, binding.community_id, tgUserId, athenaUser);
      if (!staff) {
        await sendTelegramMessage(token, chatId, 'Only owner/admins can /edit community links.', forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
      await ensureFresh(env, 'community', binding.community_id);
      rows = await candidateLinks(env, 'community', binding.community_id, queryPart);
    }

    // Match by exact url first, then fuzzy
    const qUrls = extractUrls(queryPart);
    let hit = null;
    if (qUrls.length) {
      const want = qUrls[0].toLowerCase().replace(/\/$/, '');
      hit = rows.find(r => String(r.url || '').toLowerCase().replace(/\/$/, '') === want)
        || rows.find(r => String(r.url || '').toLowerCase().includes(want));
    }
    if (!hit) {
      const hits = fuzzyMatchLinks(rows, queryPart);
      hit = hits[0] || null;
    }
    if (!hit) {
      await sendTelegramMessage(token, chatId, `No matching link for: ${queryPart}`, forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }

    const title = newTitle != null ? newTitle : hit.title;
    const notes = newNotes != null ? newNotes : hit.notes;
    if (scope === 'personal') {
      await env.DB.prepare(
        'UPDATE personal_links SET title = ?, notes = ? WHERE id = ? AND user_id = ?'
      ).bind(title, notes, hit.id, athenaUser.id).run();
    } else {
      await env.DB.prepare(
        'UPDATE links SET title = ?, notes = ? WHERE id = ?'
      ).bind(title, notes, hit.id).run();
    }
    await sendTelegramMessage(token, chatId,
      `Updated:\n${title || hit.url}\n${hit.url}\n${String(notes || '')}`, forumThreadId);
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  // ---- /delete ----
  if (cmd === '/delete') {
    if (!binding) {
      await sendTelegramMessage(token, chatId, 'Not linked.', forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    let urls = extractUrls(rest);
    if (!urls.length) urls = extractUrlsFromTelegramMessage(msg);
    if (!urls.length && msg.reply_to_message) urls = extractUrlsFromTelegramMessage(msg.reply_to_message);
    if (!urls.length) {
      await sendTelegramMessage(token, chatId, 'Usage: /delete https://…\nOr reply /delete to a message with a link (incl. photo captions).', forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    const scope = binding.scope || (binding.community_id ? 'community' : 'personal');
    for (const rawUrl of urls) {
      if (scope === 'personal') {
        if (!isGod) {
          await sendTelegramMessage(token, chatId, 'Personal /delete is GOD rank only.', forumThreadId);
          continue;
        }
        if (!athenaUser) {
          await sendTelegramMessage(token, chatId, 'Login with Telegram on the site for personal delete.', forumThreadId);
          continue;
        }
        const del = await deletePersonalUrl(env, athenaUser.id, rawUrl);
        if (del.found) {
          await sendTelegramMessage(token, chatId, `Deleted from personal: ${rawUrl}`, forumThreadId);
        } else {
          const add = await savePersonalUrl(env, athenaUser.id, rawUrl, senderName);
          if (add.duplicate) await sendTelegramMessage(token, chatId, `Website is already added: ${rawUrl}`, forumThreadId);
          else await sendTelegramMessage(token, chatId, `Was not in DB — added to personal: ${rawUrl}`, forumThreadId);
        }
      } else {
        if (!binding.community_id) {
          await sendTelegramMessage(token, chatId, 'No community linked.', forumThreadId);
          continue;
        }
        const staff = isCommAdmin || await isTgUserCommunityStaff(env, binding.community_id, tgUserId, athenaUser);
        if (!staff) {
          await sendTelegramMessage(token, chatId, 'Only community owner/admins can /delete in community mode.', forumThreadId);
          continue;
        }
        const del = await deleteCommunityUrl(env, binding.community_id, rawUrl);
        if (del.found) {
          await sendTelegramMessage(token, chatId, `Deleted from community: ${rawUrl}`, forumThreadId);
        } else {
          // not present → propose as community dump (approve flow) or direct add for staff?
          // User said same as website: if not present add it. Staff can add directly.
          const urlHash = generateUrlHash(rawUrl);
          const id = 'tg_' + Date.now().toString(36);
          const meta = await enrichLinkFields(env, rawUrl, {});
          await ensureLinkMetaColumns(env);
          try {
            await env.DB.prepare(
              `INSERT INTO links (id, community_id, url, url_hash, title, notes, tags, added_by,
                added_by_user_id, added_by_provider, added_by_name, upvotes, downvotes, created_at, image_url, site_name)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'telegram', ?, 0, 0, ?, ?, ?)`
            ).bind(id, binding.community_id, rawUrl, urlHash, meta.title, meta.notes, JSON.stringify(['telegram']), senderName, athenaUser?.id || null, senderName, Date.now(), meta.image_url || null, meta.site_name || null).run();
          } catch (_) {
            await env.DB.prepare(
              'INSERT INTO links (id, community_id, url, url_hash, title, notes, tags, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
            ).bind(id, binding.community_id, rawUrl, urlHash, meta.title, meta.notes, JSON.stringify(['telegram']), senderName, Date.now()).run();
          }
          await sendTelegramMessage(token, chatId, `Was not in DB — added to community: ${rawUrl}`, forumThreadId);
        }
      }
    }
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  // ---- plain URL dump (current mode) — also photo captions + text_link entities ----
  let urls = extractUrlsFromTelegramMessage(msg);
  if (!urls.length) urls = extractUrls(text);
  if (!urls.length) {
    if (cmd && cmd.startsWith('/')) {
      await sendTelegramMessage(token, chatId, 'Unknown command. Try /help', forumThreadId);
    }
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  const isGroupChat = String(msg.chat?.type || '').includes('group') || chatId.startsWith('-');
  if (!binding) {
    await sendTelegramMessage(token, chatId,
      isGroupChat
        ? 'Group not linked. Bot owner: /community_verify then /community or /personal.'
        : 'Not linked. Website Settings → Bot: token + /id from this chat.', forumThreadId);
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  // Dump target: dual mode for elevated; regular members in a linked group always dump to community
  let scope = binding.scope || (binding.community_id ? 'community' : 'personal');
  const isElevatedDump = isGod;
  if (isGroupChat && binding.community_id && !isElevatedDump) {
    scope = 'community';
  }
  if (scope === 'community' && !binding.community_id) {
    await sendTelegramMessage(token, chatId, 'Community mode but no community linked. /community_verify in group, or /personal.', forumThreadId);
    return new Response('OK', { status: 200, headers: corsHeaders });
  }
  // Topic lock already applied early for all group traffic
  const fullPost = telegramFullPostText(msg);
  const linkMode = (binding.dump_link_mode || dumpLinkMode || 'smart').toLowerCase();

  let toSave = urls;
  let titleHint = '';
  let notesForSave;

  if (urls.length > 1 && linkMode !== 'all') {
    const picked = selectPrimaryLinks(urls, fullPost);
    toSave = picked.primary;
    const built = buildMultiLinkNotes(fullPost);
    notesForSave = built.notes;
    titleHint = built.titleHint;
  } else if (urls.length > 1 && linkMode === 'all') {
    notesForSave = captionNotes || fullPost;
  } else {
    notesForSave = isDetailedNotes(fullPost) ? fullPost : captionNotes;
    const built = buildMultiLinkNotes(fullPost);
    if (built.titleHint) titleHint = built.titleHint;
    if (isDetailedNotes(fullPost)) notesForSave = fullPost;
  }

  for (const rawUrl of toSave) {
    if (scope === 'community') {
      await saveCommunityUrlDirect(env, token, binding, rawUrl, senderName, athenaUser, chatId, notesForSave, titleHint, forumThreadId);
    } else {
      if (!athenaUser) {
        await sendTelegramMessage(token, chatId, 'Personal dump needs Telegram login on the website once.', forumThreadId);
        continue;
      }
      if (!isElevatedDump) {
        await sendTelegramMessage(token, chatId,
          'Personal mode is GOD rank only.\n/community_join <id> to use a community.', forumThreadId);
        continue;
      }
      const r = await savePersonalUrl(env, athenaUser.id, rawUrl, senderName, notesForSave, titleHint);
      if (r.duplicate) {
        await sendTelegramMessage(token, chatId, `Website is already added: ${rawUrl}`, forumThreadId);
      } else {
        let reply;
        try {
          const vocab = await recentTagsForScope(env, 'personal', athenaUser.id);
          const ai = await aiDescribeAndTag(env, rawUrl, { title: r.title, notes: r.notes }, vocab);
          if (ai && r.id) {
            const merged = ai.tags?.length
              ? [...new Set([...['telegram', 'personal'], ...ai.tags])].slice(0, 8)
              : ['telegram', 'personal'];
            try {
              await env.DB.prepare('UPDATE personal_links SET tags = ?, notes = ?, metadata_version = 2 WHERE id = ?')
                .bind(JSON.stringify(merged), ai.description || r.notes || '', r.id).run();
              await storeMutateLink(env, 'personal', athenaUser.id, r.id, { notes: ai.description || '', tags: merged });
            } catch (_) {}
          }
          reply = formatSavedLinkReply('personal', r.title, rawUrl, ai, r.notes);
        } catch (_) {
          reply = formatSavedLinkReply('personal', r.title, rawUrl, null, r.notes);
        }
        await sendTelegramMessage(token, chatId, reply, forumThreadId);
      }
    }
  }

  return new Response('OK', { status: 200, headers: corsHeaders });
}

/**
 * @param {string|null} token
 * @param {string|number} chatId
 * @param {string} text
 * @param {string|number|null} [threadId] — forum topic (message_thread_id); keep replies in-topic
 */
async function sendTelegramMessage(token, chatId, text, threadId = null, parseMode = null) {
  if (!token) return { ok: false, error: 'No bot token' };
  try {
    const parts = chunkTelegramText(text, TG_MSG_MAX);
    if (!parts.length) return { ok: true };
    let last = { ok: true };
    for (let i = 0; i < parts.length; i++) {
      const payload = {
        chat_id: chatId,
        text: parts[i],
        disable_web_page_preview: true
      };
      if (parseMode) payload.parse_mode = parseMode;
      if (threadId != null && threadId !== '' && !Number.isNaN(Number(threadId))) {
        payload.message_thread_id = Number(threadId);
      }
      const data = await telegramApi(token, 'sendMessage', payload);
      if (!data.ok) return { ok: false, error: data.description || 'sendMessage failed', raw: data };
      last = { ok: true, message_id: data.result?.message_id };
    }
    return last;
  } catch (err) {
    console.error('Telegram send failed:', err);
    return { ok: false, error: err.message };
  }
}

async function sendTelegramFormatted(token, chatId, htmlText, threadId = null) {
  return sendTelegramMessage(token, chatId, htmlText, threadId, 'HTML');
}

async function sendTelegramMessageWithKeyboard(token, chatId, text, replyMarkup, threadId = null, parseMode = null) {
  if (!token) return { ok: false, error: 'No bot token' };
  try {
    // Keyboard only on first chunk if we must split
    const parts = chunkTelegramText(text, TG_MSG_MAX);
    if (!parts.length) return { ok: true };
    for (let i = 0; i < parts.length; i++) {
      const payload = {
        chat_id: chatId,
        text: parts[i],
        disable_web_page_preview: true
      };
      if (parseMode) payload.parse_mode = parseMode;
      if (i === 0 && replyMarkup) payload.reply_markup = replyMarkup;
      if (threadId != null && threadId !== '' && !Number.isNaN(Number(threadId))) {
        payload.message_thread_id = Number(threadId);
      }
      const data = await telegramApi(token, 'sendMessage', payload);
      if (!data.ok) return { ok: false, error: data.description || 'sendMessage failed', raw: data };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---- Telegram HTML formatting helpers ----
function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function boldHtml(str) { return `<b>${escHtml(str)}</b>`; }
function codeHtml(str) { return `<code>${escHtml(str)}</code>`; }
function linkHtml(url, text) { return `<a href="${escHtml(url)}">${escHtml(text || url)}</a>`; }
function italicHtml(str) { return `<i>${escHtml(str)}</i>`; }

function canonicalUrlForHash(rawUrl) {
  const parsed = new URL(rawUrl);
  const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
  const port = parsed.port ? `:${parsed.port}` : '';
  const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  // Fragments never reach the server and should not create a second bookmark;
  // query parameters can change the resource, so they remain part of identity.
  return `${parsed.protocol}//${host}${port}${pathname}${parsed.search}`;
}

function hashUrlIdentity(value) {
  let hash = 1469598103934665603n;
  for (let i = 0; i < value.length; i++) {
    hash ^= BigInt(value.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return hash.toString(36);
}

function legacyUrlHash(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const normalized = (parsed.hostname.replace(/^www\./, '') + parsed.pathname.replace(/\/$/, '')).toLowerCase();
    let hash = 0;
    for (let i = 0; i < normalized.length; i++) {
      hash = ((hash << 5) - hash) + normalized.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  } catch (_) {
    return hashUrlIdentity(`raw:${String(rawUrl)}`);
  }
}

function generateUrlHash(rawUrl) {
  try {
    // 64-bit FNV-1a avoids the frequent collisions of the old signed 32-bit
    // Java-style hash while remaining synchronous for all existing call sites.
    return hashUrlIdentity(canonicalUrlForHash(rawUrl));
  } catch (_) {
    return hashUrlIdentity(`raw:${String(rawUrl)}`);
  }
}

async function findExistingLink(env, table, scopeColumn, scopeKey, rawUrl, excludeId = null) {
  const currentHash = generateUrlHash(rawUrl);
  const oldHash = legacyUrlHash(rawUrl);
  let sql = `SELECT * FROM ${table} WHERE ${scopeColumn} = ? AND (url_hash = ? OR url_hash = ? OR url = ?)`;
  const params = [scopeKey, currentHash, oldHash, rawUrl];
  if (excludeId) { sql += ' AND id != ?'; params.push(excludeId); }
  const { results } = await env.DB.prepare(sql).bind(...params).all();
  let target;
  try { target = canonicalUrlForHash(rawUrl); } catch (_) { target = `raw:${String(rawUrl)}`; }
  return (results || []).find((row) => {
    try { return canonicalUrlForHash(row.url) === target; } catch (_) { return String(row.url) === String(rawUrl); }
  }) || null;
}

/**
 * Defensive de-dupe of read results. Inserts check url_hash first, but a bot
 * share and a TUI dump can still race past the EXISTS check — or an older
 * sync can leave two rows for one URL. Use the canonical URL here so query
 * parameters remain distinct and legacy hashes cannot collapse unrelated URLs.
 */
function dedupeLinkRows(rows) {
  const seen = new Map();
  for (const r of rows || []) {
    let key;
    try { key = canonicalUrlForHash(r.url || ''); } catch (_) { key = `hash:${r.url_hash || r.url || ''}`; }
    const cur = seen.get(key);
    if (!cur || Number(r.created_at || 0) >= Number(cur.created_at || 0)) seen.set(key, r);
  }
  return [...seen.values()];
}

function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function metaContent(html, names) {
  for (const name of names) {
    const re1 = new RegExp(
      `<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)["']`,
      'i'
    );
    const re2 = new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${name}["']`,
      'i'
    );
    const m = html.match(re1) || html.match(re2);
    if (m?.[1]) return decodeHtmlEntities(m[1]);
  }
  return '';
}

function isWeakTitle(title, url) {
  const t = String(title || '').trim();
  if (!t) return true;
  if (t === url) return true;
  if (/^https?:\/\//i.test(t)) return true;
  if (/^link from telegram/i.test(t)) return true;
  if (t.startsWith('Telegram ·')) return true;
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    const hostPath = (u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, '')).toLowerCase();
    if (t.toLowerCase() === hostPath) return true;
  } catch (_) {}
  return false;
}

/** User already wrote a real summary — do not overwrite with scrape */
function isDetailedNotes(notes) {
  const n = String(notes || '').trim();
  if (n.length < 80) return false;
  if (/^telegram/i.test(n) || /^shared by /i.test(n) || /^proposed by /i.test(n)) return false;
  // at least ~12 words or structured detail
  const words = n.split(/\s+/).filter(Boolean);
  if (words.length >= 12) return true;
  if (n.length >= 120) return true;
  return false;
}

function stripTags(html) {
  return decodeHtmlEntities(
    String(html || '')
      .replace(/<script\b[\s\S]*?<\/script(?:\s+[^>]*)?\s*>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style(?:\s+[^>]*)?\s*>/gi, ' ')
      .replace(/<noscript\b[\s\S]*?<\/noscript(?:\s+[^>]*)?\s*>/gi, ' ')
      .replace(/<!--[\s\S]*?--!?>/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function firstMatch(html, re) {
  const m = html.match(re);
  return m ? decodeHtmlEntities(m[1] || m[0]) : '';
}

function isUiNoiseText(text) {
  const t = String(text || '');
  if (!t || t.length < 12) return true;
  return /Contribute to .+ development by creating an account/i.test(t)
    || /To see all available qualifiers/i.test(t)
    || /Sign in|Sign up|Skip to content|Log in|Register/i.test(t)
    || /Name Query|Pull requests|Actions|Projects|Security|Insights/i.test(t)
    || /Base64 encoded string|link you clicked leads/i.test(t)
    || /^\d+\s*\/\s*\d+\b/.test(t) // "1 / 5"
    || /Top categories|Featured servers|Hand-picked|production-ready/i.test(t)
    || /cookie|privacy policy|terms of service|accept all/i.test(t)
    || /copyright|all rights reserved|newsletter|subscribe/i.test(t)
    || /^(home|about|contact|blog|docs|pricing|login)\b/i.test(t.trim());
}

function isGithubUiNoise(text) {
  return isUiNoiseText(text);
}

function scoreDescriptionCandidate(text) {
  const t = cleanGenericSummary(text);
  if (!t || isUiNoiseText(t)) return -100;
  let s = 0;
  const len = t.length;
  if (len >= 40 && len <= 280) s += 40;
  else if (len > 280 && len <= 500) s += 30;
  else if (len > 20 && len < 40) s += 15;
  else if (len > 500) s += 10;
  // sentence-like
  if (/[.!?]/.test(t)) s += 15;
  // purpose words
  if (/\b(is|are|helps|provides|collection|discover|connect|tool|app|platform|library|server|free)\b/i.test(t)) s += 12;
  // penalty for nav-ish stacks
  const commas = (t.match(/,/g) || []).length;
  if (commas >= 4 && len < 200) s -= 20;
  if ((t.match(/&/g) || []).length >= 3) s -= 15;
  if (/\b(Developer Tools|Cloud &|Media & Design)\b/i.test(t)) s -= 25;
  return s;
}

function pickBestDescription(candidates) {
  let best = { text: '', score: -999 };
  for (const c of candidates) {
    const text = cleanGenericSummary(c);
    const score = scoreDescriptionCandidate(text);
    if (score > best.score) best = { text, score };
  }
  return best.score >= 10 ? best.text : '';
}

function extractReadableBlurb(html) {
  const chunks = [];
  // Prefer hero / lead paragraphs
  const leadRe = /<(?:p|h2|h3)[^>]*(?:class|id)=["'][^"']*(?:hero|lead|subtitle|tagline|description|intro|about)[^"']*["'][^>]*>([\s\S]*?)<\/(?:p|h2|h3)>/gi;
  let m;
  while ((m = leadRe.exec(html)) && chunks.length < 5) {
    const t = stripTags(m[1]);
    if (!isUiNoiseText(t) && t.length >= 25) chunks.push(t);
  }
  const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  while ((m = pRe.exec(html)) && chunks.length < 10) {
    const t = stripTags(m[1]);
    if (isUiNoiseText(t)) continue;
    if (t.length >= 40 && t.length < 500) chunks.push(t);
  }
  if (!chunks.length) {
    const article = firstMatch(html, /<article[^>]*>([\s\S]{80,4000}?)<\/article>/i);
    if (article) {
      const t = stripTags(article).slice(0, 500);
      if (t.length >= 40 && !isUiNoiseText(t)) chunks.push(t);
    }
  }
  const readme = firstMatch(html, /class=["'][^"']*markdown-body[^"']*["'][^>]*>([\s\S]{50,3000}?)<\/div>/i);
  if (readme) {
    const t = stripTags(readme).slice(0, 500);
    if (t.length >= 40 && !isUiNoiseText(t)) chunks.unshift(t);
  }
  // score and take top 1-2
  const ranked = chunks
    .map(t => ({ t, s: scoreDescriptionCandidate(t) }))
    .filter(x => x.s >= 10)
    .sort((a, b) => b.s - a.s);
  if (!ranked.length) return '';
  return ranked.slice(0, 2).map(x => x.t).join('\n').replace(/[ \t]+/g, ' ').trim().slice(0, 500);
}

function cleanSiteTitle(title, siteName, host) {
  let t = String(title || '').trim();
  if (!t) return '';
  // "Welcome • freemediaheckyeah" → freemediaheckyeah or siteName
  if (/^welcome\b/i.test(t) && siteName) return siteName;
  if (/^welcome\b/i.test(t) && host) {
    const base = host.split('.')[0];
    if (base && base.length > 2) return base;
  }
  // "MCP.so - MCP Marketplace" keep as-is if informative
  t = t.replace(/\s*[|•·\-–—]\s*Home\s*$/i, '').trim();
  t = t.replace(/\s*[|•·]\s*Official\s*Site\s*$/i, '').trim();
  if (t.includes(' · GitHub')) t = t.split(' · GitHub')[0].trim();
  if (t.includes(' | ')) {
    // keep left if short product name
    const left = t.split(' | ')[0].trim();
    if (left.length >= 2 && left.length <= 40) t = left;
  }
  return t.slice(0, 160);
}

/** Parse README markdown/HTML into clean title + description */
function parseReadmeIntro(md) {
  let text = String(md || '');
  // strip HTML tags but keep line breaks for structure
  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  // strip markdown images/badges/links syntax noise
  text = text
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/[^\s)]+/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*\|.*\|\s*$/gm, '')
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
  let title = '';
  const descLines = [];
  for (const line of lines) {
    if (isGithubUiNoise(line)) continue;
    if (/^license|^badges?$|^download|^install|^features?$/i.test(line)) break;
    if (!title && line.length <= 60 && !/[.!?]$/.test(line) && line.split(/\s+/).length <= 6) {
      title = line.replace(/^[*_]+|[*_]+$/g, '').trim();
      continue;
    }
    // skip badge-y short tokens
    if (line.length < 12 && !/[.!]/.test(line)) continue;
    descLines.push(line.replace(/^[*_]+|[*_]+$/g, '').trim());
    if (descLines.join(' ').length >= 220) break;
    if (descLines.length >= 4) break;
  }
  return {
    title: title || '',
    description: descLines.join('\n').trim().slice(0, 700)
  };
}

const SCRAPE_TIMEOUT_MS = 9000;

/**
 * fetch that aborts instead of hanging a link-enrichment request forever.
 * When self-hosted, every destination (including each redirect hop) must be a
 * public host, so the scraper cannot be turned into an SSRF oracle against
 * localhost / RFC1918 / metadata endpoints.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = SCRAPE_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let u = url;
    let hops = 0;
    const redirect = (options.redirect === undefined) ? 'follow' : options.redirect;
    while (true) {
      const target = new URL(u);
      if (!(await isSafeExternalUrl(target, options.env))) {
        const err = new Error(`blocked: ${target.hostname} is not a public host`);
        err.code = 'SSRF_BLOCKED';
        throw err;
      }
      const res = await fetch(u, { ...options, env: undefined, redirect: 'manual', signal: ctrl.signal });
      if ([301, 302, 303, 307, 308].includes(res.status) && redirect === 'error') {
        const err = new Error(`redirect refused: ${target.hostname} -> ${res.headers.get('location') || 'unknown'}`);
        err.code = 'REDIRECT_REFUSED';
        throw err;
      }
      if ([301, 302, 303, 307, 308].includes(res.status) && redirect === 'follow') {
        const loc = res.headers.get('location');
        if (!loc) return res;
        u = new URL(loc, u).toString();
        if (++hops > 5) {
          const err = new Error('too many redirects');
          err.code = 'SSRF_BLOCKED';
          throw err;
        }
        continue;
      }
      return res;
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Forge hosts (GitHub / Codeberg / GitLab / Gitea-style) via API + README.
 */
async function scrapeForgeMetadata(rawUrl, env) {
  try {
    const u = new URL(rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (!(await isSafeExternalUrl(u, env))) return null;
    const segs = u.pathname.split('/').filter(Boolean);
    if (segs.length < 2) return null;
    const owner = segs[0];
    const repo = segs[1].replace(/\.git$/i, '');
    if (!owner || !repo || /^(settings|explore|orgs|users|login)$/i.test(owner)) return null;

    // GitHub
    if (host === 'github.com') {
      const headers = {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'AthenaBot/1.3 (+link-preview)'
      };
      const repoRes = await fetchWithTimeout(`https://api.github.com/repos/${owner}/${repo}`, { headers, env });
      if (!repoRes.ok) return null;
      const data = await repoRes.json();
      if (!data?.name) return null;
      let title = data.name || repo;
      let description = (data.description || '').trim();
      let image = data.owner?.avatar_url || '';
      let content = '';
      try {
        const readmeRes = await fetchWithTimeout(`https://api.github.com/repos/${owner}/${repo}/readme`, {
          headers: { ...headers, Accept: 'application/vnd.github.raw' }, env
        });
        if (readmeRes.ok) {
          content = (await readmeRes.text()).slice(0, 12000);
          const intro = parseReadmeIntro(content.slice(0, 8000));
          if (intro.title) title = intro.title;
          if (intro.description && intro.description.length >= 20) description = intro.description;
          else if (description && intro.description) {
            description = `${description}\n${intro.description}`.slice(0, 700);
          }
        }
      } catch (_) {}
      if (/^GitHub\s*-/i.test(title)) title = data.name || repo;
      description = cleanGenericSummary(description);
      if (!description) description = `Open-source project ${owner}/${repo} on GitHub.`;
      return {
        title: String(title).slice(0, 120),
        description: description.slice(0, 900),
        content,
        image: String(image).slice(0, 500),
        siteName: 'GitHub'
      };
    }

    // Codeberg / Gitea API
    if (host === 'codeberg.org' || host === 'gitea.com' || host.endsWith('.gitea.io')) {
      const apiBase = `https://${host}/api/v1`;
      const headers = { Accept: 'application/json', 'User-Agent': 'AthenaBot/1.3 (+link-preview)' };
      const repoRes = await fetchWithTimeout(`${apiBase}/repos/${owner}/${repo}`, { headers, env });
      if (!repoRes.ok) return null;
      const data = await repoRes.json();
      if (!data?.name) return null;
      let title = data.name || repo;
      let description = (data.description || '').trim();
      let image = data.owner?.avatar_url || data.avatar_url || '';
      let content = '';
      try {
        // raw README candidates
        for (const name of ['README.md', 'readme.md', 'README.MD']) {
          const rr = await fetchWithTimeout(`https://${host}/${owner}/${repo}/raw/branch/${data.default_branch || 'main'}/${name}`, {
            headers: { 'User-Agent': 'AthenaBot/1.3' }, env
          });
          if (rr.ok) {
            content = (await rr.text()).slice(0, 12000);
            const intro = parseReadmeIntro(content.slice(0, 8000));
            if (intro.title) title = intro.title;
            if (intro.description && intro.description.length >= 20) {
              description = intro.description;
              break;
            }
          }
        }
      } catch (_) {}
      description = cleanGenericSummary(description);
      if (!description) description = `Open-source project ${owner}/${repo} on ${host}.`;
      return {
        title: String(title).slice(0, 120),
        description: description.slice(0, 900),
        content,
        image: String(image).slice(0, 500),
        siteName: host === 'codeberg.org' ? 'Codeberg' : host
      };
    }

    // GitLab.com
    if (host === 'gitlab.com') {
      const project = encodeURIComponent(`${owner}/${repo}`);
      const headers = { Accept: 'application/json', 'User-Agent': 'AthenaBot/1.3 (+link-preview)' };
      const repoRes = await fetchWithTimeout(`https://gitlab.com/api/v4/projects/${project}`, { headers, env });
      if (!repoRes.ok) return null;
      const data = await repoRes.json();
      if (!data?.name) return null;
      let title = data.name || repo;
      let description = (data.description || '').trim();
      let image = data.avatar_url || data.namespace?.avatar_url || '';
      let content = '';
      try {
        const rr = await fetchWithTimeout(
          `https://gitlab.com/api/v4/projects/${project}/repository/files/README.md/raw?ref=${encodeURIComponent(data.default_branch || 'main')}`,
          { headers, env }
        );
        if (rr.ok) {
          content = (await rr.text()).slice(0, 12000);
          const intro = parseReadmeIntro(content.slice(0, 8000));
          if (intro.title) title = intro.title;
          if (intro.description && intro.description.length >= 20) description = intro.description;
        }
      } catch (_) {}
      description = cleanGenericSummary(description);
      if (!description) description = `Open-source project ${owner}/${repo} on GitLab.`;
      return {
        title: String(title).slice(0, 120),
        description: description.slice(0, 900),
        content,
        image: String(image || '').slice(0, 500),
        siteName: 'GitLab'
      };
    }

    return null;
  } catch (_) {
    return null;
  }
}

function cleanGenericSummary(text) {
  return String(text || '')
    .replace(/Contribute to .+ development by creating an account on GitHub\.?/gi, '')
    .replace(/To see all available qualifiers[\s\S]*?(?=\.|$)/gi, '')
    .replace(/The link you clicked leads to a Base64 encoded string\.?/gi, '')
    .replace(/Name Query/gi, '')
    .replace(/Skip to content/gi, '')
    .replace(/\b\d+\s*\/\s*\d+\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractReadableContent(html) {
  const source = firstMatch(html, /<(?:article|main)[^>]*>([\s\S]{100,20000}?)<\/(?:article|main)>/i) || html;
  const chunks = [];
  const re = /<(?:h1|h2|h3|p|li|pre|blockquote)[^>]*>([\s\S]*?)<\/(?:h1|h2|h3|p|li|pre|blockquote)>/gi;
  let match;
  while ((match = re.exec(source)) && chunks.length < 80) {
    const text = stripTags(match[1]);
    if (text.length >= 30 && !isUiNoiseText(text)) chunks.push(text.slice(0, 1200));
  }
  return [...new Set(chunks)].join('\n\n').slice(0, 12000);
}

async function scrapeRedditMetadata(rawUrl, env) {
  try {
    const page = new URL(rawUrl);
    const host = page.hostname.replace(/^www\./, '').toLowerCase();
    if (host !== 'reddit.com' && !host.endsWith('.reddit.com')) return null;
    if (!/^\/r\/[^/]+\/comments\//i.test(page.pathname)) return null;
    const subreddit = page.pathname.match(/^\/r\/([^/]+)/i)?.[1] || 'unknown';
    const endpoint = `https://www.reddit.com${page.pathname.replace(/\/+$/, '')}.json?raw_json=1`;
    const response = await fetchWithTimeout(endpoint, {
      env,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'AthenaBot/1.3 (bookmark metadata)'
      }
    });
    if (!response.ok) {
      const embed = await fetchWithTimeout(
        `https://www.reddit.com/oembed?url=${encodeURIComponent(rawUrl)}`,
        { env, headers: { Accept: 'application/json', 'User-Agent': 'AthenaBot/1.3 (bookmark metadata)' } }
      );
      if (!embed.ok) return null;
      const data = await embed.json();
      if (!data?.title) return null;
      return {
        title: String(data.title).slice(0, 160),
        description: `Reddit discussion in r/${subreddit} by ${data.author_name || 'the community'}.`,
        content: `Subreddit: r/${subreddit}\nReddit title: ${data.title}\nAuthor: ${data.author_name || 'unknown'}`,
        image: '',
        siteName: 'Reddit'
      };
    }
    const data = await response.json();
    const post = data?.[0]?.data?.children?.find(child => child?.data)?.data;
    if (!post?.title) return null;
    const comments = (data?.[1]?.data?.children || [])
      .map(child => child?.data)
      .filter(comment => comment?.body)
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
      .slice(0, 5)
      .map(comment => `Comment (${comment.score || 0} points): ${comment.body}`);
    const content = [
      `Subreddit: r/${post.subreddit || 'unknown'}`,
      `Title: ${post.title}`,
      post.selftext ? `Post: ${post.selftext}` : '',
      comments.length ? `Top comments:\n${comments.join('\n\n')}` : ''
    ].filter(Boolean).join('\n\n').slice(0, 12000);
    const image = post.preview?.images?.[0]?.source?.url
      ? decodeHtmlEntities(post.preview.images[0].source.url)
      : '';
    return {
      title: String(post.title).slice(0, 160),
      description: cleanGenericSummary(post.selftext || `Reddit discussion in r/${post.subreddit || 'unknown'}.`),
      content,
      image: image.slice(0, 500),
      siteName: 'Reddit'
    };
  } catch (_) {
    return null;
  }
}

async function scrapeGistMetadata(rawUrl, env) {
  try {
    const page = new URL(rawUrl);
    const host = page.hostname.replace(/^www\./, '').toLowerCase();
    if (host !== 'gist.github.com') return null;
    const parts = page.pathname.split('/').filter(Boolean);
    const gistId = parts.at(-1);
    if (!gistId || !/^[a-f0-9]+$/i.test(gistId)) return null;
    const response = await fetchWithTimeout(`https://api.github.com/gists/${gistId}`, {
      env,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'AthenaBot/1.3 (+gist)' }
    });
    if (!response.ok) return null;
    const data = await response.json();
    const files = Object.values(data.files || {});
    const fileText = files.map(file => `File: ${file.filename}\n${file.content || ''}`).join('\n\n').slice(0, 12000);
    const description = String(data.description || '').trim() || fileText.split('\n').find(Boolean) || 'GitHub Gist';
    return {
      title: description.slice(0, 160),
      description: description.slice(0, 900),
      content: [description, fileText].filter(Boolean).join('\n\n').slice(0, 12000),
      image: data.owner?.avatar_url || '',
      siteName: 'GitHub Gist'
    };
  } catch (_) {
    return null;
  }
}

/**
 * Scrape: forge APIs first; else prefer clean meta description over noisy body.
 */
async function scrapeLinkMetadata(rawUrl, env) {
  const fallback = {
    title: titleFromUrl(rawUrl),
    description: '',
    content: '',
    image: '',
    siteName: ''
  };
  try {
    if (!/^https?:\/\//i.test(rawUrl) || rawUrl.startsWith('note://')) return fallback;

    const reddit = await scrapeRedditMetadata(rawUrl, env);
    if (reddit) return reddit;
    const gist = await scrapeGistMetadata(rawUrl, env);
    if (gist) return gist;

    // Fast path: GitHub / Codeberg / GitLab
    const forge = await scrapeForgeMetadata(rawUrl, env);
    if (forge && (forge.description || forge.title)) {
      return {
          title: forge.title || fallback.title,
          description: forge.description || '',
          content: forge.content || '',
        image: forge.image || '',
        siteName: forge.siteName || ''
      };
    }

    const res = await fetchWithTimeout(rawUrl, {
      method: 'GET',
      redirect: 'follow',
      env,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; AthenaBot/1.3)',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    if (!res.ok) return fallback;

    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    if (!ctype.includes('html') && !ctype.includes('text') && !ctype.includes('xml')) {
      return fallback;
    }

    const buf = await res.arrayBuffer();
    const slice = buf.byteLength > 280000 ? buf.slice(0, 280000) : buf;
    const html = new TextDecoder('utf-8', { fatal: false }).decode(slice);

    const siteName = metaContent(html, ['og:site_name', 'application-name']) || '';
    let host = '';
    try { host = new URL(rawUrl).hostname.replace(/^www\./, ''); } catch (_) {}

    let title =
      metaContent(html, ['og:title', 'twitter:title']) ||
      (() => {
        const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        return m ? decodeHtmlEntities(m[1]) : '';
      })();
    title = cleanSiteTitle(title, siteName, host);

    // Prefer meta description (usually written for humans) over scraped body noise
    const metaDesc = cleanGenericSummary(
      metaContent(html, ['description', 'og:description', 'twitter:description']) || ''
    );
    const ogDesc = cleanGenericSummary(metaContent(html, ['og:description', 'twitter:description']) || '');
    const blurb = cleanGenericSummary(extractReadableBlurb(html));
    const content = extractReadableContent(html);

    // Rank: prefer short clean meta over long body mashups
    let description = pickBestDescription([
      metaDesc,
      ogDesc,
      // only use first sentence-ish of blurb
      blurb ? blurb.split(/(?<=[.!?])\s+/)[0] : '',
      blurb,
      content.slice(0, 1200)
    ]);

    // If meta is good and short, prefer it alone (mcp.so / fmhy case)
    if (metaDesc && scoreDescriptionCandidate(metaDesc) >= 40) {
      description = metaDesc;
    } else if (ogDesc && scoreDescriptionCandidate(ogDesc) >= 40 && scoreDescriptionCandidate(ogDesc) >= scoreDescriptionCandidate(description)) {
      description = ogDesc;
    }

    let image = metaContent(html, ['og:image', 'twitter:image', 'twitter:image:src']) || '';
    try {
      if (image && !/^https?:\/\//i.test(image)) image = new URL(image, rawUrl).href;
    } catch (_) {
      image = '';
    }

    if (!title || isWeakTitle(title, rawUrl) || /^welcome$/i.test(title)) {
      title = siteName || (host ? host.replace(/\.(com|net|org|io|so|app|dev)$/i, '') : fallback.title);
      // capitalize simple host brands
      if (title && title === title.toLowerCase() && title.length <= 24) {
        title = title.charAt(0).toUpperCase() + title.slice(1);
      }
    }

    // Final cleanup: never keep multi-category nav soup
    if (description && (description.match(/,/g) || []).length >= 5 && description.length < 220) {
      description = metaDesc || ogDesc || description.split(',')[0].trim();
    }
    description = cleanGenericSummary(description).slice(0, 2500);

    return {
      title: String(title || fallback.title).slice(0, 160),
      description,
      content,
      image: image.slice(0, 500),
      siteName: (siteName || host || '').slice(0, 120)
    };
  } catch (_) {
    return fallback;
  }
}

async function ensureLinkMetaColumns(env) {
  for (const sql of [
    `ALTER TABLE personal_links ADD COLUMN image_url TEXT`,
    `ALTER TABLE personal_links ADD COLUMN site_name TEXT`,
    `ALTER TABLE personal_links ADD COLUMN metadata_version INTEGER DEFAULT 0`,
    `ALTER TABLE links ADD COLUMN image_url TEXT`,
    `ALTER TABLE links ADD COLUMN site_name TEXT`,
    `ALTER TABLE links ADD COLUMN metadata_version INTEGER DEFAULT 0`
  ]) {
    try { await env.DB.prepare(sql).run(); } catch (_) {}
  }
}

/** Merge user-provided fields with scraped page meta. Skip scrape if notes already detailed. */
async function enrichLinkFields(env, rawUrl, { title, notes } = {}) {
  const userTitle = String(title || '').trim();
  const userNotes = String(notes || '').trim();
  const detailed = isDetailedNotes(userNotes);
  const strongTitle = userTitle && !isWeakTitle(userTitle, rawUrl);

  const NOTES_MAX = 8000; // full captions; Telegram send splits at 4096

  // Fully detailed post: keep as-is, no network scrape
  if (detailed && strongTitle) {
    return {
      title: userTitle.slice(0, 300),
      notes: userNotes.slice(0, NOTES_MAX),
      content: userNotes.slice(0, 12000),
      image_url: '',
      site_name: '',
      scraped: false
    };
  }
  if (detailed && !strongTitle) {
    // keep notes, only fill title/image lightly
    const meta = await scrapeLinkMetadata(rawUrl, env);
    return {
      title: (isWeakTitle(userTitle, rawUrl) ? meta.title : userTitle).slice(0, 300),
      notes: userNotes.slice(0, NOTES_MAX),
      content: meta.content || userNotes.slice(0, 12000),
      image_url: meta.image || '',
      site_name: meta.siteName || '',
      scraped: true
    };
  }

  const meta = await scrapeLinkMetadata(rawUrl, env);
  const useScrapedTitle = isWeakTitle(userTitle, rawUrl);
  // Keep short user caption as prefix when present
  let finalNotes = meta.description || '';
  if (userNotes && !/^telegram/i.test(userNotes) && !/^shared by /i.test(userNotes)) {
    if (finalNotes && !finalNotes.includes(userNotes)) {
      finalNotes = `${userNotes}\n\n${finalNotes}`.slice(0, NOTES_MAX);
    } else if (!finalNotes) {
      finalNotes = userNotes.slice(0, NOTES_MAX);
    }
  }

  return {
    title: (useScrapedTitle ? meta.title : userTitle).slice(0, 300),
    notes: finalNotes.slice(0, NOTES_MAX),
    content: meta.content || finalNotes.slice(0, 12000),
    image_url: meta.image || '',
    site_name: meta.siteName || '',
    scraped: true
  };
}

/**
 * Bulk dumps must not block on a server-side fetch per URL, but they should
 * still END UP enriched like Telegram saves do. The batch handlers insert the
 * dump immediately (title as given), then this pass runs in the background:
 * scrape → UPDATE the row → and for GitHub-backed instances rewrite the
 * Markdown entry too. Bounded concurrency; one bad site only costs its own
 * 9s timeout.
 */
async function enrichLinksInBackground(env, scope, key, links) {
  const CONCURRENCY = 4;
  const vocab = await recentTagsForScope(env, scope, key);
  let aiConfig = null;
  try { aiConfig = await getInstanceAiConfig(env); } catch (_) {}
  let next = 0;
  const run = async () => {
    while (next < links.length) {
      const link = links[next++];
      try {
        const meta = await scrapeLinkMetadata(link.url, env);
        const title = (isWeakTitle(link.title, link.url) && meta.title) ? meta.title : link.title;
        const update = {
          title,
          notes: meta.description || '',
          image_url: meta.image || '',
          site_name: meta.siteName || '',
        };
        // AI describe + tag (karakeep-style); stable tags because the prompt
        // is seeded with the vocabulary already in use for this scope.
        const ai = await aiDescribeAndTag(env, link.url, {
          title,
          notes: meta.description,
          content: meta.content
        }, vocab, aiConfig);
        if (ai) {
          if (ai.description) update.notes = ai.description;
          if (ai.tags?.length) {
            let existingTags = [];
            try { existingTags = Array.isArray(link.tags) ? link.tags : JSON.parse(link.tags || '[]'); } catch (_) {}
            update.tags = [...new Set([...existingTags, ...ai.tags])].slice(0, 8);
          }
        }
        if (!update.notes && !update.image_url && !update.site_name && !update.tags) continue;
        if (scope === 'personal') {
          await env.DB.prepare(
            'UPDATE personal_links SET title = ?, notes = ?, image_url = ?, site_name = ?, metadata_version = 2' + (update.tags ? ', tags = ?' : '') + ' WHERE id = ?'
          ).bind(update.title, update.notes, update.image_url, update.site_name, ...(update.tags ? [JSON.stringify(update.tags)] : []), link.id).run();
        } else {
          await env.DB.prepare(
            'UPDATE links SET title = ?, notes = ?, image_url = ?, site_name = ?, metadata_version = 2' + (update.tags ? ', tags = ?' : '') + ' WHERE id = ?'
          ).bind(update.title, update.notes, update.image_url, update.site_name, ...(update.tags ? [JSON.stringify(update.tags)] : []), link.id).run();
        }
        // Best effort on GitHub storage: the .md entry catches up with the row.
        await storeMutateLink(env, scope, key, link.id, update);
      } catch (_) { /* one bad link must not stall the rest */ }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, run));
}

function queueMissingLinkEnrichment(env, scope, key, rows) {
  const missing = (rows || [])
    .filter((row) => {
      const notes = String(row.notes || '').trim();
      const genericReddit = row.site_name === 'Reddit' && /^Reddit (thread|discussion)\b/i.test(notes);
      return row?.url && Number(row.metadata_version || 0) < 2 && (!notes || (!row.site_name && !row.image_url) || genericReddit);
    })
    .slice(0, 10)
    .map(row => ({
      id: row.id,
      url: row.url,
      title: row.title || '',
      notes: row.notes || '',
      tags: row.tags || []
    }));
  if (missing.length) runInBackground(env, enrichLinksInBackground(env, scope, key, missing));
  return missing.length;
}

function runInBackground(env, promise) {
  if (env.__ctx?.waitUntil) env.__ctx.waitUntil(promise);
  else Promise.resolve(promise).catch(() => {});
}

/** Collect the tag vocabulary a community/user already uses, newest rows first. */
async function recentTagsForScope(env, scope, key, limit = 30) {
  const out = [];
  try {
    const q = scope === 'personal'
      ? 'SELECT tags FROM personal_links WHERE user_id = ? ORDER BY created_at DESC LIMIT 60'
      : 'SELECT tags FROM links WHERE community_id = ? ORDER BY created_at DESC LIMIT 60';
    const { results } = await env.DB.prepare(q).bind(key).all();
    for (const r of results || []) {
      let arr = [];
      try { arr = JSON.parse(r.tags || '[]'); } catch (_) {}
      for (const t of Array.isArray(arr) ? arr : []) {
        const s = String(t).replace(/^#/, '').trim().toLowerCase();
        if (s && !['telegram', 'community', 'personal', 'dump'].includes(s) && !out.includes(s)) out.push(s);
      }
      if (out.length >= limit) break;
    }
  } catch (_) {}
  return out;
}

function inferredLinkTags(rawUrl, meta = {}) {
  const haystack = `${rawUrl} ${meta.title || ''} ${meta.content || ''} ${meta.notes || ''}`.toLowerCase();
  const tags = inferredLinkTags(rawUrl, meta);
  const add = tag => { if (!tags.includes(tag)) tags.push(tag); };
  if (/reddit\.com|\breddit\b/.test(haystack)) add('reddit');
  if (/github\.com|gist\.github|\bgithub\b/.test(haystack)) add('github');
  if (/open[- ]source|opensource/.test(haystack)) add('open-source');
  if (/localllama|local\s+llm|ollama|llama\b/.test(haystack)) add('local-llm');
  if (/\bocr\b|optical character recognition/.test(haystack)) add('ocr');
  if (/\bai\b|artificial intelligence|machine learning/.test(haystack)) add('ai');
  if (/computer vision|vision model/.test(haystack)) add('computer-vision');
  return tags;
}

/**
 * AI describe + tag (karakeep-style) for a saved link. Uses the instance AI
 * config; identical link types get identical tags because the prompt is
 * seeded with the community's existing tag vocabulary. Never throws — null
 * means "AI unavailable" and callers fall back to the plain reply.
 * Returns { description, tags } or null.
 */
async function aiDescribeAndTag(env, rawUrl, meta = {}, existingTags = [], config = undefined) {
  let cfg;
  if (config === undefined) {
    try { cfg = await getInstanceAiConfig(env); } catch (_) { return null; }
  } else {
    cfg = config;
  }
  if (!cfg || !cfg.api_key) return null;
  const baseUrl = cleanApiBase(cfg.base_url);
  const model = normalizeModelId(cfg.model, baseUrl);
  if (!baseUrl || !model) return null;
  let endpoint;
  try {
    const ep = resolveChatEndpoint(baseUrl, cfg.mode || 'openai');
    if (!(await isSafeExternalUrl(new URL(ep), env))) return null;
    endpoint = ep;
  } catch (_) { return null; }

  const title = String(meta?.title || '').trim().slice(0, 200);
  const snippet = String(meta?.content || meta?.notes || '').replace(/\s+/g, ' ').slice(0, 5000);
  const vocab = (existingTags || [])
    .map(tag => String(tag).replace(/^#/, '').trim().toLowerCase())
    .filter(tag => tag && !['telegram', 'community', 'personal', 'dump'].includes(tag))
    .slice(0, 30);
  const mode = (cfg.mode || 'openai').toLowerCase();
  const controlledTags = [
    'ai', 'ocr', 'local-llm', 'machine-learning', 'computer-vision', 'open-source',
    'github', 'programming', 'research', 'tutorial', 'tools', 'reddit', 'web',
    'security', 'productivity', 'data', 'documentation', 'news', 'video', 'design'
  ];

  const system = [
    'You are a bookmarking assistant for a link archive.',
    'Write a useful context summary in 1-2 factual sentences: preserve the question, problem, subject, or decision the page is about, not just the site name.',
    'Choose 3-5 short lowercase tags (no #, no spaces) that describe the content.',
    'Reuse an existing tag exactly whenever it fits; do not invent a synonym for an existing tag.',
    `Prefer these controlled tags when applicable: ${controlledTags.join(', ')}.`,
    'Reply with ONLY one JSON object: {"description": "...", "tags": ["a", "b", "c"]}'
  ].join(' ');

  const user = [
    `Title: ${title || '(unknown)'}`,
    `URL: ${rawUrl}`,
    snippet ? `Page content: ${snippet}` : '',
    vocab.length ? `Existing tags: ${vocab.join(', ')}` : '',
    '',
    'JSON:'
  ].filter(Boolean).join('\n');

  const maxTok = 300;
  let payload, headers;
  if (mode === 'anthropic') {
    headers = { 'Content-Type': 'application/json', 'x-api-key': cfg.api_key, 'anthropic-version': '2023-06-01' };
    payload = { model, max_tokens: maxTok, system, messages: [{ role: 'user', content: user }], stream: false };
  } else {
    headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.api_key}` };
    payload = { model, max_tokens: maxTok, messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ], stream: false, temperature: 0.1 };
  }

  let text;
  try {
    const res = await fetchWithTimeout(endpoint, { method: 'POST', headers, body: JSON.stringify(payload), env }, 12000);
    if (!res.ok) return null;
    const data = await res.json();
    if (mode === 'anthropic') text = String(data?.content?.[0]?.text || '');
    else text = String(data?.choices?.[0]?.message?.content || '');
  } catch (_) { return null; }
  if (!text.trim()) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim());
  } catch (_) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch (_) {} }
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const description = String(parsed.description || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  const rawTags = Array.isArray(parsed.tags) ? parsed.tags : [];
  const tags = inferredLinkTags(rawUrl, meta);
  for (const t of rawTags) {
    let s = String(t).replace(/^#/, '').trim().toLowerCase().replace(/\s+/g, '-').slice(0, 24);
    if (s === 'localllm' || s === 'local-llms') s = 'local-llm';
    if (s === 'artificial-intelligence' || s === 'machine-intelligence') s = 'ai';
    if (s && !tags.includes(s)) tags.push(s);
    if (tags.length >= 5) break;
  }
  if (!description && !tags.length) return null;
  return { description, tags };
}

/** Format the saved-link reply karakeep-style: what it is → link → #tags. */
function formatSavedLinkReply(kindLabel, title, rawUrl, ai, fallbackNotes = '') {
  const head = `Saved to ${kindLabel}:\n${title || rawUrl}`;
  if (!ai) {
    const preview = fallbackNotes ? `\n${String(fallbackNotes)}` : '';
    return `${head}\n${rawUrl}${preview}`;
  }
  const lines = [head];
  if (ai.description) lines.push('', ai.description);
  lines.push('', rawUrl);
  if (ai.tags?.length) lines.push('', ai.tags.map(t => `#${t}`).join(' '));
  return lines.join('\n');
}
