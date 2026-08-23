/**
 * Cloudflare Worker: Athena (auth + API + static)
 * Telegram + Discord OAuth, session-gated APIs, community bot bindings
 */

// GitHub/D1 storage removed — PostgreSQL only (see README Storage).
// storage.js (GitHubStore) is retained on disk but no longer imported.

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
  '/api/ai/config',
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
    TG_API_BASE = telegramApiBaseFor(env);
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
          version: '1.0.53',
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

      if (pathname === '/api/internal/ai-config' && request.method === 'POST') {
        return await handleInternalAiConfigSync(request, env, corsHeaders);
      }

      if (pathname === '/api/internal/steroid' && request.method === 'POST') {
        return await handleInternalSteroidSync(request, env, corsHeaders);
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

      if (pathname === '/api/ai/steroid') {
        if (request.method === 'GET') {
          const enabled = await getSteroidMode(env);
          return Response.json({ success: true, steroid: enabled, caps: enabled
            ? { retrieval_limit: null, rag_slice: null, enrich_concurrency: 4, enrich_throttle_ms: 0 }
            : { retrieval_limit: 300, rag_slice: 8, enrich_concurrency: 1, enrich_throttle_ms: 900 } }, { headers: corsHeaders });
        }
        if (!(await isInstanceOwnerUserAsync(user, env))) {
          return deny(corsHeaders, 'Steroid mode is GOD only', 'GOD_ONLY');
        }
        if (request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          const enabled = !!(body.steroid ?? body.enabled);
          await setSteroidMode(env, enabled);
          const peerSynced = await syncSteroidToPeer(env, enabled);
          return Response.json({ success: true, steroid: enabled, peer_synced: peerSynced }, { headers: corsHeaders });
        }
      }

      if (pathname === '/api/ai/detect-free' && request.method === 'POST') {
        if (!user) {
          return Response.json({ success: false, error: 'Login required' }, { status: 401, headers: corsHeaders });
        }
        const body = await request.json().catch(() => ({}));
        const baseUrl = String(body.baseUrl || body.base_url || '').trim();
        const model = String(body.model || '').trim();
        if (!baseUrl || !model) {
          return Response.json({ success: false, error: 'baseUrl and model required' }, { status: 400, headers: corsHeaders });
        }
        const free = await isFreeTierModel(model, baseUrl, env, body.apiKey || body.api_key || '');
        const limits = providerLimitInfo(baseUrl, model, free);
        return Response.json({ success: true, free, model, baseUrl, limits, provider: detectProviderForModel(model, baseUrl) }, { headers: corsHeaders });
      }

      // Model catalog for the settings picker: GOD-only, works against the
      // saved instance config or a candidate base+key pair being tested
      // before saving. Lists every model the endpoint exposes with free/paid
      // classification (OpenRouter pricing included).
      if (pathname === '/api/ai/models' && request.method === 'GET') {
        if (!user) {
          return Response.json({ success: false, error: 'Login required', code: 'AUTH_REQUIRED' }, { status: 401, headers: corsHeaders });
        }
        if (!(await isInstanceOwnerUserAsync(user, env))) {
          return deny(corsHeaders, 'Model catalog is GOD rank only', 'GOD_ONLY');
        }
        const qBase = String(url.searchParams.get('base') || '').trim();
        const qKey = String(url.searchParams.get('key') || '').trim();
        const inst = await getInstanceAiConfig(env);
        // Testing an unsaved endpoint requires the paired set — mixing a
        // caller's base with the stored key would ship the secret elsewhere.
        if ((qBase || qKey) && !(qBase && qKey)) {
          return deny(corsHeaders, 'Provide both base and key to test an unsaved endpoint', 'MODELS_OVERRIDE_INCOMPLETE');
        }
        const baseUrl = cleanApiBase(qBase || inst?.base_url || '');
        const apiKey = (qKey || inst?.api_key || '').trim();
        if (!baseUrl) return Response.json({ success: false, error: 'No base URL configured' }, { status: 400, headers: corsHeaders });
        const refresh = ['1', 'true', 'yes'].includes(String(url.searchParams.get('refresh') || '').toLowerCase());
        // Unsaved base+key pairs must always hit the live endpoint: caching by
        // base alone can leak one account's provider-visible catalog to another
        // account using the same gateway with a different key.
        const override = !!(qBase || qKey);
        const cacheKey = `models:${baseUrl}`;
        const cached = override ? null : AI_MODEL_LIST_CACHE.get(cacheKey);
        if (!refresh && cached && cached.expires > Date.now()) {
          return Response.json({ success: true, baseUrl, models: cached.list, cached: true, provider: detectProviderForModel('', baseUrl) }, { headers: { ...corsHeaders, 'Cache-Control': 'no-store' } });
        }
        const raw = await fetchModelList(baseUrl, env, apiKey) || [];
        const models = raw.map((e) => {
          const id = String(e.id || e.model || '').trim();
          if (!id) return null;
          const p = e.pricing || e.cost || {};
          // providers use either pair: openai-style prompt/completion or
          // models.dev-style input/output ($/1M tokens)
          const inPrice = p.prompt != null ? Number(p.prompt) : (p.input != null ? Number(p.input) : null);
          const outPrice = p.completion != null ? Number(p.completion) : (p.output != null ? Number(p.output) : null);
          const pricing = { prompt: inPrice, completion: outPrice };
          return {
            // Keep provider metadata used by model pickers and diagnostics. The
            // endpoint is GOD-only, so preserving architecture/limits/links is
            // useful and does not expose a non-owner's credentials.
            ...e,
            id,
            name: String(e.name || id),
            free: isModelFreeEntry(e),
            context_length: Number(e.context_length || e.top_provider?.context_length || e.limit?.context || 0) || null,
            ...(pricing.prompt != null || pricing.completion != null ? { pricing } : {}),
          };
        }).filter(Boolean).sort((a, b) => (a.free === b.free ? a.id.localeCompare(b.id) : (a.free ? -1 : 1)));
        if (models.length && !override) AI_MODEL_LIST_CACHE.set(cacheKey, { list: models, expires: Date.now() + 5 * 60_000 });
        return Response.json({ success: true, baseUrl, models, provider: detectProviderForModel('', baseUrl), cached: false }, { headers: { ...corsHeaders, 'Cache-Control': 'no-store' } });
      }

      // Recent upstream AI failures (in-memory ring buffer, newest first).
      if (pathname === '/api/ai/errors') {
        if (!(await isInstanceOwnerUserAsync(user, env))) {
          return deny(corsHeaders, 'AI error log is GOD rank only', 'GOD_ONLY');
        }
        if (request.method === 'GET') {
          return Response.json({ success: true, errors: AI_ERROR_LOG }, { headers: corsHeaders });
        }
        if (request.method === 'DELETE') {
          AI_ERROR_LOG.length = 0;
          return Response.json({ success: true, cleared: true }, { headers: corsHeaders });
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
      console.error('[athena] worker fetch failed:', err?.stack || err);
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
  markMeiliScopeDirty(env, 'community', communityId);
  try { await env.DB.prepare('DELETE FROM telegram_pending WHERE community_id = ?').bind(communityId).run(); } catch (_) {}
  // Only the ACTIVE store is cleared. In GitHub mode that means the Markdown
  // too; the parked Cloudflare copy is deliberately left alone, and vice versa.
  await clearActiveStoreFolder(env, 'community', communityId);
  runInBackground(env, logOperationalEvent(
    env,
    '🧹 Community database cleared',
    `${c.name} (${c.id}); removed ${(linkRows || []).length} links`
  ));
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
  const banReason = reason || 'banned';
  let previous = null;
  try {
    previous = await env.DB.prepare(
      'SELECT reason FROM community_bans WHERE community_id = ? AND platform = ? AND platform_user_id = ?'
    ).bind(communityId, platform, String(platformUserId)).first();
  } catch (_) {}
  await env.DB.prepare(
    `INSERT OR REPLACE INTO community_bans (community_id, platform, platform_user_id, user_id, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(communityId, platform, String(platformUserId), uid, banReason, Date.now()).run();
  // NOTE: the membership row is deliberately preserved. Deleting it made every ban
  // irreversible (unban never restored it) and silently destroyed owner/admin roles,
  // so a brief Telegram hiccup permanently demoted staff. Access is gated on the ban
  // row itself, which unbanUserFromCommunity can undo.
  if (uid) {
    // Kill website sessions immediately so the ban takes effect at once.
    await destroyUserSessions(env, uid);
  }
  if (!previous || previous.reason !== banReason) {
    let communityName = communityId;
    let targetName = uid || platformUserId;
    try {
      const c = await env.DB.prepare('SELECT name FROM communities WHERE id = ?').bind(communityId).first();
      if (c?.name) communityName = c.name;
      if (uid) {
        const u = await env.DB.prepare('SELECT username, display_name FROM users WHERE id = ?').bind(uid).first();
        targetName = u?.username ? `@${u.username}` : (u?.display_name || targetName);
      }
    } catch (_) {}
    runInBackground(env, logOperationalEvent(
      env,
      '🚫 Community access revoked',
      `${targetName} banned from ${communityName} (${communityId}); reason: ${banReason}`
    ));
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
  await ensureBotBindingColumns(env);
  const logTarget = await getConfiguredLogTarget(env, uid);
  try {
    await env.DB.prepare('DELETE FROM personal_links WHERE user_id = ?').bind(uid).run();
  } catch (_) {}
  try {
    await ensureDocumentsTable(env);
    await clearActiveDocumentFolder(env, 'personal', uid);
    await env.DB.prepare("DELETE FROM uploaded_documents WHERE scope = 'personal' AND user_id = ?").bind(uid).run();
  } catch (_) {}
  markMeiliScopeDirty(env, 'personal', uid);
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
  await logOperationalEvent(env, '🧹 Personal database cleared', `${user.username || user.display_name || uid} wiped personal links, documents, and settings`, uid, logTarget);
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
      await logWebsiteAuthFailure(env, 'Telegram', 'initData missing');
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
      await logWebsiteAuthFailure(env, 'Telegram', 'bot token is not configured');
      return Response.json({
        success: false,
        error: 'TELEGRAM_BOT_TOKEN missing (GOD: Settings → Bot, or wrangler secret put TELEGRAM_BOT_TOKEN)'
      }, { status: 503, headers: corsHeaders });
    }
    const verified = await verifyTelegramInitData(initData, botToken);
    if (!verified) {
      await logWebsiteAuthFailure(env, 'Telegram', 'invalid Mini App signature');
      return Response.json({
        success: false,
        error: 'Invalid Telegram signature (bot token must match the Mini App bot)'
      }, { status: 401, headers: corsHeaders });
    }
    const params = verified.params;
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    if (authDate && (Date.now() / 1000 - authDate) > 86400 * 2) {
      await logWebsiteAuthFailure(env, 'Telegram', 'Mini App login expired');
      return Response.json({ success: false, error: 'Telegram login expired — reopen the Mini App' }, { status: 401, headers: corsHeaders });
    }
    let tgUser = {};
    try { tgUser = JSON.parse(params.get('user') || '{}'); } catch (_) { tgUser = {}; }
    const tgId = String(tgUser.id || params.get('id') || '');
    if (!tgId) {
      await logWebsiteAuthFailure(env, 'Telegram', 'Telegram user is missing from initData');
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
      await logWebsiteAuthFailure(env, 'Telegram', 'user is fully banned', `@${username}`);
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
         const notifyText = `🌐 ${boldHtml(loginLabel)}${loginTgId ? ` | ${codeHtml(String(loginTgId))}` : ''} logged in to website`;
        const logTarget = await getConfiguredLogTarget(env, godUsers?.[0]?.id);
        if (logTarget) {
          await sendConfiguredLog(env, notifyText, godUsers?.[0]?.id, logTarget);
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
    await logWebsiteAuthFailure(env, 'Telegram', `OAuth provider error: ${err}`);
    return Response.redirect(`${frontendOrigin(env, url)}/?auth_error=telegram_${encodeURIComponent(err)}`, 302);
  }
  if (!code || !state) {
    await logWebsiteAuthFailure(env, 'Telegram', 'OAuth callback missing code or state');
    return Response.redirect(`${frontendOrigin(env, url)}/?auth_error=telegram_missing`, 302);
  }
  if (!env.TELEGRAM_CLIENT_ID || !env.TELEGRAM_CLIENT_SECRET) {
    await logWebsiteAuthFailure(env, 'Telegram', 'OAuth credentials are not configured');
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
    await logWebsiteAuthFailure(env, 'Telegram', 'OAuth state was not found');
    return Response.redirect(`${frontendOrigin(env, url)}/?auth_error=telegram_state`, 302);
  }
  const exp = Number(row.expires_at);
  if (!exp || exp < Date.now()) {
    try {
      await env.DB.prepare('DELETE FROM oauth_states WHERE state = ?').bind(state).run();
    } catch (_) {}
    await logWebsiteAuthFailure(env, 'Telegram', 'OAuth state expired');
    return Response.redirect(`${frontendOrigin(env, url)}/?auth_error=telegram_state_expired`, 302);
  }
  // Bind the flow to the browser that started it. Skipped only when the
  // registered redirect_uri lives on another origin — there the start cookie was
  // set elsewhere and cannot be presented here; that topology relays above.
  const ownRedirect = telegramRedirectUri(env, url).startsWith(`${url.origin}/`);
  if (ownRedirect && readOauthStateCookie(request) !== state) {
    await logWebsiteAuthFailure(env, 'Telegram', 'OAuth browser state cookie mismatch');
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
    await logWebsiteAuthFailure(env, 'Telegram', `OAuth token exchange failed (${tokenRes.status})`);
    return Response.redirect(`${frontendOrigin(env, url)}/?auth_error=telegram_token`, 302);
  }

  const claims = await verifyTelegramIdToken(tokens.id_token, env.TELEGRAM_CLIENT_ID);
  if (!claims) {
    await logWebsiteAuthFailure(env, 'Telegram', 'OAuth ID token verification failed');
    return Response.redirect(`${frontendOrigin(env, url)}/?auth_error=telegram_jwt`, 302);
  }

  const providerId = String(claims.sub || claims.id || '');
  if (!providerId) {
    await logWebsiteAuthFailure(env, 'Telegram', 'OAuth user identity missing');
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
    await logWebsiteAuthFailure(env, 'Telegram', 'user is fully banned', `@${username}`);
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
       const notifyText = `🌐 ${boldHtml(loginLabel)}${loginTgId ? ` | ${codeHtml(String(loginTgId))}` : ''} logged in to website (Telegram)`;
        const logTarget = await getConfiguredLogTarget(env, godUsers?.[0]?.id);
        if (logTarget) {
          await sendConfiguredLog(env, notifyText, godUsers?.[0]?.id, logTarget);
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
    await logWebsiteAuthFailure(env, 'Discord', 'OAuth callback is missing code or credentials');
    return Response.redirect(`${frontendOrigin(env, url)}/?auth_error=discord`, 302);
  }
  if (!state) {
    await logWebsiteAuthFailure(env, 'Discord', 'OAuth callback state is missing');
    return Response.redirect(`${frontendOrigin(env, url)}/?auth_error=discord_state`, 302);
  }
  // redirect_uri is always this origin, so the start cookie is always presented.
  if (readOauthStateCookie(request) !== state) {
    await logWebsiteAuthFailure(env, 'Discord', 'OAuth browser state cookie mismatch');
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
    await logWebsiteAuthFailure(env, 'Discord', 'OAuth state expired or was not found');
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
    await logWebsiteAuthFailure(env, 'Discord', `OAuth token exchange failed (${tokenRes.status})`);
    return Response.redirect(`${frontendOrigin(env, url)}/?auth_error=discord_token`, 302);
  }

  const meRes = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` }
  });
  const me = await meRes.json();
  if (!me.id) {
    await logWebsiteAuthFailure(env, 'Discord', 'Discord user identity lookup failed');
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
    await logWebsiteAuthFailure(env, 'Discord', 'user is fully banned', `@${username}`);
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
       const notifyText = `🌐 ${boldHtml(loginLabel)} logged in to website (Discord)`;
        const logTarget = await getConfiguredLogTarget(env, godUsers?.[0]?.id);
        if (logTarget) {
          await sendConfiguredLog(env, notifyText, godUsers?.[0]?.id, logTarget);
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
  await logOperationalEvent(env, '🆕 Community created', `${name} (${id}) by ${user.username || user.display_name || user.id}`, user.id);
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
    await logOperationalEvent(env, '⚠️ Community join failed', 'community_id missing');
    return Response.json({ success: false, error: 'community_id required' }, { status: 400, headers: corsHeaders });
  }
  const c = await env.DB.prepare(
    'SELECT id, name, creator_id, created_at FROM communities WHERE id = ?'
  ).bind(communityId).first();
  if (!c) {
    await logOperationalEvent(env, '⚠️ Community join failed', `Community not found: ${communityId}`);
    return Response.json({ success: false, error: 'Community not found (invalid invite)' }, { status: 404, headers: corsHeaders });
  }
  if (await isBannedFromCommunity(env, communityId, user)) {
    await logOperationalEvent(env, '🚫 Community join blocked', `${user.username || user.display_name || user.id} is banned from ${c.name} (${c.id})`, user.id);
    return deny(corsHeaders, 'You are banned from this community', 'BANNED');
  }
  // Must be in the Telegram group linked to this community (members; owners skip)
  if (!(await isInstanceOwnerUserAsync(user, env)) && c.creator_id !== user.id) {
    const tgId = await resolveTgApiIdForUser(user);
    if (!tgId) {
      await logOperationalEvent(env, '⚠️ Community join blocked', `${user.username || user.display_name || user.id} has no linked Telegram ID for ${c.name}`, user.id);
      return deny(corsHeaders,
        'Open the Athena bot in Telegram and send /start once (links your Telegram user id), join the community group, then /community_join again',
        'NEED_TG_API_ID');
    }
    const inGroup = await isTelegramUserInCommunityGroup(env, communityId, tgId);
    if (!inGroup) {
      await logOperationalEvent(env, '⚠️ Community join blocked', `${user.username || user.display_name || user.id} is not in the Telegram group for ${c.name}`, user.id);
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
       const notifyText = `👤 ${boldHtml(joinerLabel)}${joinerTgId ? ` | ${codeHtml(String(joinerTgId))}` : ''} joined ${boldHtml(c.name)} community`;
        const logTarget = await getConfiguredLogTarget(env, godUsers?.[0]?.id);
        if (logTarget) {
          await sendConfiguredLog(env, notifyText, godUsers?.[0]?.id, logTarget);
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
  // Where a linked channel's content lands: 'community' | 'personal' | 'both'.
  // personal/both are GOD-only and write into the linking GOD user's brain.
  try {
    await env.DB.prepare(`ALTER TABLE community_bots ADD COLUMN channel_target TEXT DEFAULT 'community'`).run();
  } catch (_) {}
  // Full-copy toggle for groups: also capture text-only posts like channels do.
  try {
    await env.DB.prepare(`ALTER TABLE community_bots ADD COLUMN copy_text INTEGER DEFAULT 0`).run();
  } catch (_) {}
}

const CHANNEL_TARGETS = new Set(['community', 'personal', 'both']);

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

// Active Bot API origin. Defaults to Telegram cloud; a self-hosted instance can
// point TELEGRAM_API_BASE at a local telegram-bot-api server to lift the 20 MB
// getFile cap to 2 GB (files, ebooks, big PDFs). Set once per fetch() from env.
const TG_CLOUD_BASE = 'https://api.telegram.org';
let TG_API_BASE = TG_CLOUD_BASE;
function telegramApiBaseFor(env) {
  const raw = String(env?.TELEGRAM_API_BASE || '').trim().replace(/\/+$/, '');
  if (!raw) return TG_CLOUD_BASE;
  try {
    const u = new URL(raw);
    // loopback/private only — never ship the bot token to an arbitrary host
    const host = u.hostname.toLowerCase();
    const private_ = host === 'localhost' || host === '::1' ||
      /^127\./.test(host) || /^10\./.test(host) ||
      /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    return (u.protocol === 'http:' || u.protocol === 'https:') && private_ ? u.origin : TG_CLOUD_BASE;
  } catch (_) { return TG_CLOUD_BASE; }
}

async function telegramApi(token, method, payload = null) {
  const url = `${TG_API_BASE}/bot${token}/${method}`;
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

// Command menu registered with setMyCommands — what users see in Telegram's
// "/" autocomplete. Staff-only commands stay out of everyone's menu on
// purpose; /help lists them per rank.
const TELEGRAM_COMMAND_MENU = [
  { command: 'start', description: 'Welcome / status' },
  { command: 'help', description: 'Help menu' },
  { command: 'search', description: 'Search the active brain' },
  { command: 'export', description: 'Telegram bot export / history guide' },
  { command: 'ai', description: 'Ask AI over your brain' },
  { command: 'personal', description: 'Dump → personal brain (GOD)' },
  { command: 'community', description: 'Dump → community brain' },
  { command: 'mode', description: 'Show / switch dump mode' },
  { command: 'id', description: 'Chat / user / topic ids' },
  { command: 'rank', description: 'Your ranks' },
  { command: 'community_join', description: 'Join a community' },
  { command: 'community_list', description: 'Your communities' },
  { command: 'edit', description: 'Edit title/notes of a link' },
  { command: 'delete', description: 'Delete a saved link' },
  { command: 'dumpall', description: 'Multi-link posts: save all' },
  { command: 'channel_target', description: 'GOD: channel → community/personal/both' },
  { command: 'group_copy', description: 'Owner: group full-copy on/off' },
  { command: 'topic_link', description: 'Clone this forum topic into a brain' },
  { command: 'topic_list', description: 'Linked topics in this group' },
  { command: 'topic_target', description: 'GOD: topic → community/personal/both' },
  { command: 'userbot_add', description: 'GOD: add userbot account' },
  { command: 'userbot_del', description: 'GOD: remove account(s)' },
  { command: 'userbot_follow', description: 'Follow a chat for live cloning' },
  { command: 'userbot_status', description: 'Userbot connection + follows' },
  { command: 'userbot_disconnect', description: 'GOD: stop + delete session' },
  { command: 'clone', description: 'Clone this chat (live + history)' },
    { command: 'dumpsmart', description: 'Multi-link: primary only' },
    { command: 'forcetags', description: 'GOD: tag all untagged links' },
    { command: 'transfers', description: 'GOD: clone sessions list' },
    { command: 'clone_del', description: 'GOD: delete a clone session' },
];

async function ensureTelegramWebhook(token, workerOrigin, env) {
  const hook = `${workerOrigin.replace(/\/$/, '')}/api/telegram-webhook`;
  const payload = {
    url: hook,
    allowed_updates: ['message', 'edited_message', 'channel_post', 'callback_query', 'chat_member', 'my_chat_member']
  };
  const secret = env ? await webhookSecret(env) : null;
  if (secret) payload.secret_token = secret;
  const data = await telegramApi(token, 'setWebhook', payload);
  // Register the command menu so "/" autocomplete works in Telegram's UI.
  // Fire-and-forget: a failure here never breaks the webhook itself.
  if (data.ok) {
    try {
      await telegramApi(token, 'setMyCommands', { commands: TELEGRAM_COMMAND_MENU });
    } catch (_) {}
  }
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

  markMeiliScopeDirty(env, 'community', communityId);
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
  markMeiliScopeDirty(env, 'community', link.community_id);
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
const MEILI_STATE = new Map();
const MEILI_BATCH_SIZE = 250;
const AI_RETRIEVAL_LIMIT = 24;
const AI_CONTEXT_MAX_CHARS = 120_000;
const AI_DOC_MAX_CHARS = 20_000;

function clipAiText(value, maxChars = AI_DOC_MAX_CHARS) {
  const text = String(value || '');
  if (text.length <= maxChars) return text;
  const marker = '\n[… content shortened for context …]\n';
  const side = Math.max(1, Math.floor((maxChars - marker.length) / 2));
  return `${text.slice(0, side)}${marker}${text.slice(-side)}`;
}

function compactAiContext(sections, maxChars = AI_CONTEXT_MAX_CHARS) {
  const available = Math.max(0, Number(maxChars) || AI_CONTEXT_MAX_CHARS);
  const out = [];
  let used = 0;
  for (const section of sections || []) {
    const value = String(section || '');
    if (!value || used >= available) break;
    const separator = out.length ? '\n\n' : '';
    const remaining = available - used - separator.length;
    if (remaining <= 0) break;
    out.push(separator + (value.length > remaining ? clipAiText(value, remaining) : value));
    used += separator.length + Math.min(value.length, remaining);
  }
  return out.join('');
}

function isGroundedAiAnswer(text, docs) {
  const answer = String(text || '');
  // Compare hosts+paths, ignoring scheme, trailing slashes and punctuation —
  // models drop the trailing "/" or re-case the host, which is not hallucination.
  const normalizeUrl = url => {
    try {
      const u = new URL(String(url || '').replace(/[),.;!?'"\s]+$/g, ''));
      return `${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`;
    } catch (_) { return String(url || '').toLowerCase(); }
  };
  const knownUrls = new Set((docs || []).map(doc => normalizeUrl(doc.url)));
  const urls = answer.match(/https?:\/\/[^\s<>()[\]{}"']+/gi) || [];
  // Hard hallucination signal: a URL that is not in the retrieved set.
  if (!urls.every(url => knownUrls.has(normalizeUrl(url)))) return false;
  // Uncited summaries are still grounded when every URL is known; do not
  // discard a completed streamed answer over missing [#n] markers.
  return true;
}

function groundedMatchesReply(docs) {
  const lines = (docs || []).slice(0, 8).map((doc, index) => {
    const title = doc.title || doc.filename || doc.url || 'Saved item';
    const url = doc.url ? ` — ${doc.url}` : '';
    return `${index + 1}. **${title}**${url} [#${index + 1}]`;
  });
  return `Closest matches in your brain:\n\n${lines.join('\n\n')}`;
}

function meiliConfig(env) {
  const raw = String(env.MEILI_URL || env.MEILISEARCH_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    if (u.protocol === 'http:' && !isSelfHosted(env)) return null;
    const index = String(env.MEILI_INDEX || 'athena').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(index)) return null;
    return { base: u.toString().replace(/\/+$/, ''), index, key: String(env.MEILI_MASTER_KEY || '').trim() };
  } catch (_) {
    return null;
  }
}

function meiliStateFor(cfg, scope, key) {
  const stateKey = `${cfg.base}/${cfg.index}|${scope}|${key}`;
  let state = MEILI_STATE.get(stateKey);
  if (!state) {
    state = { ready: false, synced: false, dirty: true, syncing: false };
    MEILI_STATE.set(stateKey, state);
  }
  return state;
}

async function meiliRequest(env, path, init = {}, timeoutMs = 8000) {
  const cfg = meiliConfig(env);
  if (!cfg) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = new Headers(init.headers || {});
    headers.set('Accept', 'application/json');
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    if (cfg.key) headers.set('Authorization', `Bearer ${cfg.key}`);
    return await fetch(`${cfg.base}${path}`, { ...init, headers, signal: controller.signal });
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureMeiliIndex(env) {
  const cfg = meiliConfig(env);
  if (!cfg) return false;
  const state = meiliStateFor(cfg, '__index__', '__index__');
  if (state.ready) return true;
  const indexPath = `/indexes/${encodeURIComponent(cfg.index)}`;
  const created = await meiliRequest(env, '/indexes', {
    method: 'POST',
    body: JSON.stringify({ uid: cfg.index, primaryKey: 'id' })
  });
  if (!created || (!created.ok && created.status !== 409)) return false;
  const settings = await meiliRequest(env, `${indexPath}/settings`, {
    method: 'PATCH',
    body: JSON.stringify({
      searchableAttributes: ['title', 'url', 'filename', 'notes', 'content', 'tags'],
      filterableAttributes: ['scope', 'scope_key', 'type'],
      sortableAttributes: ['created_at']
    })
  });
  if (!settings || !settings.ok) return false;
  state.ready = true;
  return true;
}

function meiliFilterValue(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function meiliScopeFilter(scope, key) {
  return `scope = "${meiliFilterValue(scope)}" AND scope_key = "${meiliFilterValue(key)}"`;
}

function meiliDocumentFromRow(row, scope, key) {
  let tags = row.tags || [];
  if (typeof tags === 'string') {
    try { tags = JSON.parse(tags); } catch (_) { tags = tags.split(',').map((tag) => tag.trim()).filter(Boolean); }
  }
  const isDocument = row.type === 'document' || (!row.url && row.filename);
  return {
    id: `${scope}:${key}:${row.id}`,
    source_id: String(row.id),
    scope,
    scope_key: String(key),
    type: isDocument ? 'document' : 'link',
    title: String(row.title || row.filename || ''),
    url: String(row.url || ''),
    filename: String(row.filename || ''),
    notes: String(row.notes || ''),
    content: String(row.content || '').slice(0, 250_000),
    tags: Array.isArray(tags) ? tags : [],
    image_url: String(row.image_url || ''),
    site_name: String(row.site_name || ''),
    created_at: Number(row.created_at || 0)
  };
}

function meiliRowFromHit(hit) {
  return {
    id: hit.source_id || hit.id,
    type: hit.type || 'link',
    isDocument: hit.type === 'document',
    title: hit.title || hit.filename || '',
    url: hit.url || null,
    filename: hit.filename || null,
    notes: hit.notes || hit.content || '',
    content: hit.content || '',
    tags: Array.isArray(hit.tags) ? hit.tags : (hit.tags || []),
    image_url: hit.image_url || '',
    site_name: hit.site_name || '',
    created_at: Number(hit.created_at || 0)
  };
}

/**
 * Meilisearch is the recall/ranking index; PostgreSQL is the source of truth
 * for the context sent to the model. Hydrate hits by scoped primary key so a
 * stale/truncated index payload can never become the AI answer by itself.
 */
async function hydrateMeiliRows(env, scope, key, hits) {
  const rows = Array.isArray(hits) ? hits : [];
  if (!rows.length) return [];
  const table = scope === 'personal' ? 'personal_links' : 'links';
  const col = scope === 'personal' ? 'user_id' : 'community_id';
  const linkIds = [...new Set(rows.filter(row => row.type !== 'document' && !row.isDocument).map(row => String(row.id || '')).filter(Boolean))];
  const documentIds = [...new Set(rows.filter(row => row.type === 'document' || row.isDocument).map(row => String(row.id || '')).filter(Boolean))];
  const byKey = new Map();

  try {
    if (linkIds.length) {
      const placeholders = linkIds.map(() => '?').join(',');
      const { results } = await env.DB.prepare(
        `SELECT * FROM ${table} WHERE ${col} = ? AND id IN (${placeholders})`
      ).bind(key, ...linkIds).all();
      for (const row of results || []) byKey.set(`link:${row.id}`, { ...row, type: 'link' });
    }
  } catch (_) {}

  try {
    if (documentIds.length) {
      await ensureDocumentsTable(env);
      const placeholders = documentIds.map(() => '?').join(',');
      const { results } = await env.DB.prepare(
        `SELECT * FROM uploaded_documents WHERE scope = ? AND ${col} = ? AND id IN (${placeholders})`
      ).bind(scope, key, ...documentIds).all();
      for (const row of results || []) byKey.set(`document:${row.id}`, { ...documentAsLink(row), isDocument: true });
    }
  } catch (_) {}

  return rows.map((hit) => {
    const kind = hit.type === 'document' || hit.isDocument ? 'document' : 'link';
    return byKey.get(`${kind}:${hit.id}`) || hit;
  });
}

async function syncMeiliScope(env, scope, key) {
  const cfg = meiliConfig(env);
  if (!cfg || !(await ensureMeiliIndex(env))) return false;
  const state = meiliStateFor(cfg, scope, key);
  if (state.syncing) return false;
  state.syncing = true;
  try {
    const table = scope === 'personal' ? 'personal_links' : 'links';
    const col = scope === 'personal' ? 'user_id' : 'community_id';
    const { results: links } = await env.DB.prepare(`SELECT * FROM ${table} WHERE ${col} = ? ORDER BY created_at DESC`).bind(key).all();
    await ensureDocumentsTable(env);
    const { results: documents } = await env.DB.prepare(
      `SELECT * FROM uploaded_documents WHERE scope = ? AND ${col} = ? ORDER BY created_at DESC`
    ).bind(scope, key).all();
    const docs = [
      ...(links || []).map((row) => meiliDocumentFromRow(row, scope, key)),
      ...(documents || []).map((row) => meiliDocumentFromRow({ ...documentAsLink(row), content: row.content }, scope, key))
    ];
    const indexPath = `/indexes/${encodeURIComponent(cfg.index)}`;
    const cleared = await meiliRequest(env, `${indexPath}/documents/delete`, {
      method: 'POST',
      body: JSON.stringify({ filter: meiliScopeFilter(scope, key) })
    });
    if (!cleared || !cleared.ok) return false;
    for (let i = 0; i < docs.length; i += MEILI_BATCH_SIZE) {
      const response = await meiliRequest(env, `${indexPath}/documents`, {
        method: 'POST',
        body: JSON.stringify(docs.slice(i, i + MEILI_BATCH_SIZE))
      }, 15_000);
      if (!response || !response.ok) return false;
    }
    state.synced = true;
    state.dirty = false;
    return true;
  } catch (_) {
    return false;
  } finally {
    state.syncing = false;
  }
}

function scheduleMeiliSync(env, scope, key) {
  const cfg = meiliConfig(env);
  if (!cfg) return;
  const state = meiliStateFor(cfg, scope, key);
  if (state.syncPromise || state.syncing) return;
  state.syncPromise = syncMeiliScope(env, scope, key).finally(() => { state.syncPromise = null; });
  runInBackground(env, state.syncPromise);
}

async function syncMeiliScopeNow(env, scope, key) {
  const cfg = meiliConfig(env);
  if (!cfg) return false;
  const state = meiliStateFor(cfg, scope, key);
  if (state.synced && !state.dirty) return true;
  const pending = state.syncPromise || syncMeiliScope(env, scope, key);
  state.syncPromise ||= pending;
  try {
    await pending;
  } finally {
    if (state.syncPromise === pending) state.syncPromise = null;
  }
  return !!state.synced && !state.dirty;
}

function markMeiliScopeDirty(env, scope, key) {
  const cfg = meiliConfig(env);
  if (!cfg || key == null || key === '') return;
  const state = meiliStateFor(cfg, scope, key);
  state.dirty = true;
  if (state.synced) scheduleMeiliSync(env, scope, key);
}

async function meiliSearchScope(env, scope, key, query, { limit = 50, offset = 0, waitForSync = false } = {}) {
  const cfg = meiliConfig(env);
  if (!cfg || !(await ensureMeiliIndex(env))) return null;
  const state = meiliStateFor(cfg, scope, key);
  if (!state.synced || state.dirty) {
    if (!waitForSync) {
      scheduleMeiliSync(env, scope, key);
      return null;
    }
    if (!(await syncMeiliScopeNow(env, scope, key))) return null;
  }
  const indexPath = `/indexes/${encodeURIComponent(cfg.index)}`;
  const response = await meiliRequest(env, `${indexPath}/search`, {
    method: 'POST',
    body: JSON.stringify({
      q: String(query || '').slice(0, 240),
      filter: meiliScopeFilter(scope, key),
      limit: limit == null ? 1000 : Math.max(1, Math.min(Number(limit) || 50, 1000)),
      offset: Math.max(0, Number(offset) || 0)
    })
  });
  if (!response || !response.ok) return null;
  const data = await response.json().catch(() => null);
  if (!data || !Array.isArray(data.hits)) return null;
  // Meilisearch writes are task-based. During the short window after a
  // background rebuild, an empty response can be stale; let PostgreSQL serve
  // the authoritative fallback instead of presenting a false empty result.
  if (!data.hits.length) return null;
  return {
    rows: data.hits.map(meiliRowFromHit),
    total: Number(data.estimatedTotalHits ?? data.total ?? data.hits.length)
  };
}

/**
 * Bounded hybrid retrieval for AI. Meilisearch finds candidates, PostgreSQL
 * hydrates the authoritative rows, and the shared ranker removes weak hits.
 * PostgreSQL remains a complete fallback when the index is unavailable.
 */
async function retrieveAiRows(env, scope, key, query, { limit = AI_RETRIEVAL_LIMIT } = {}) {
  const max = Math.max(1, Math.min(Number(limit) || AI_RETRIEVAL_LIMIT, AI_RETRIEVAL_LIMIT));
  // Remove conversational filler before asking Meilisearch; SQL still gets
  // the original question so its synonym expansion remains authoritative.
  const meiliTerms = expandServerSearchTerms(query).slice(0, 6);
  const meiliQuery = meiliTerms.join(' ') || query;
  const accelerated = await meiliSearchScope(env, scope, key, meiliQuery, {
    limit: Math.min(max * 2, 100),
    waitForSync: true
  });
  let rows;
  let engine = 'postgres';

  if (accelerated?.rows?.length) {
    const hits = await hydrateMeiliRows(env, scope, key, accelerated.rows);
    const ranked = rankLinks(dedupeLinkRows(hits), query, max, 8);
    rows = ranked.length ? ranked : dedupeLinkRows(hits).slice(0, max);
    engine = 'meilisearch+postgres';
    // The index may be a little ahead/behind PostgreSQL search_blob backfill;
    // top up from the authoritative SQL path without exceeding the AI budget.
    if (rows.length < max) {
      const sqlRows = await searchAllLinks(env, scope, key, query, max);
      rows = rankLinks(dedupeLinkRows([...rows, ...sqlRows]), query, max, 8);
    }
  } else {
    const sqlRows = await searchAllLinks(env, scope, key, query, max);
    rows = rankLinks(dedupeLinkRows(sqlRows), query, max, 8);
  }

  return {
    rows: rows.slice(0, max),
    total: await countScopeLinks(env, scope, key),
    engine
  };
}

async function handleSearchLinks(url, user, env, corsHeaders) {
  const q = (url.searchParams.get('q') || '').trim();
  const scope = (url.searchParams.get('scope') || 'community').toLowerCase();
  const rawLimit = (url.searchParams.get('limit') || '').trim().toLowerCase();
  const requestedLimit = rawLimit === 'all'
    ? null
    : Math.max(parseInt(rawLimit || '1000', 10) || 1000, 1);
  const steroid = await getSteroidMode(env);
  const effectiveLimit = steroid ? requestedLimit : (requestedLimit == null ? 50 : Math.min(requestedLimit, 50));
  if (!q) return Response.json({ success: true, links: [], query: '' }, { headers: corsHeaders });
  const aiPurpose = url.searchParams.get('purpose') === 'ai';

  if (aiPurpose) {
    if (scope === 'personal') {
      if (!(await isInstanceOwnerUserAsync(user, env))) {
        return deny(corsHeaders, 'Personal mode is for GOD rank (instance host) only', 'PERSONAL_LOCKED');
      }
      await ensureFresh(env, 'personal', user.id);
    } else {
      const communityId = url.searchParams.get('community_id');
      const gate = await requireActiveMember(env, communityId, user, corsHeaders);
      if (gate) return gate;
      await ensureFresh(env, 'community', communityId);
    }
    const scopeKey = scope === 'personal' ? user.id : url.searchParams.get('community_id');
    const retrieval = await retrieveAiRows(env, scope, scopeKey, q, { limit: AI_RETRIEVAL_LIMIT });
    const enrichmentPending = queueMissingLinkEnrichment(env, scope, scopeKey, retrieval.rows);
    return Response.json({
      success: true,
      query: q,
      scope,
      // The browser only needs bounded context; the bot keeps the full
      // PostgreSQL rows locally for its own prompt builder.
      links: retrieval.rows.map(row => ({
        ...row,
        notes: clipAiText(row.notes || '', 6_000),
        content: clipAiText(row.content || '', AI_DOC_MAX_CHARS)
      })),
      total: retrieval.total,
      retrieval_engine: retrieval.engine,
      enrichment_pending: enrichmentPending
    }, { headers: corsHeaders });
  }

  if (scope === 'personal') {
    if (!(await isInstanceOwnerUserAsync(user, env))) {
      return deny(corsHeaders, 'Personal mode is for GOD rank (instance host) only', 'PERSONAL_LOCKED');
    }
    await ensureFresh(env, 'personal', user.id);
    await ensureLinkMetaColumns(env);
    const accelerated = await meiliSearchScope(env, 'personal', user.id, q, { limit: effectiveLimit });
    const rows = accelerated?.rows || await searchAllLinks(env, 'personal', user.id, q, effectiveLimit);
    const links = rankLinks(dedupeLinkRows(rows), q, effectiveLimit);
    const enrichmentPending = queueMissingLinkEnrichment(env, 'personal', user.id, links);
    const total = await countScopeLinks(env, 'personal', user.id);
    return Response.json(
      { success: true, query: q, scope, links, total, enrichment_pending: enrichmentPending },
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
  const accelerated = await meiliSearchScope(env, 'community', communityId, q, { limit: effectiveLimit });
  const rows = accelerated?.rows || await searchAllLinks(env, 'community', communityId, q, effectiveLimit);
  const links = rankLinks(dedupeLinkRows(rows), q, effectiveLimit);
  const enrichmentPending = queueMissingLinkEnrichment(env, 'community', communityId, links);
  const total = await countScopeLinks(env, 'community', communityId);
  return Response.json(
    { success: true, query: q, scope, links, total, enrichment_pending: enrichmentPending },
    { headers: corsHeaders }
  );
}

/** Rank candidates by how well they match, best first. */
function rankLinks(rows, query, limit = null, minScore = 8) {
  const q = String(query || '').toLowerCase().trim();
  const qa = q.replace(/[^a-z0-9]/g, '');
  if (!q) return takeResults(rows, limit);
  const terms = expandServerSearchTerms(q);
  const scored = [];
  for (const r of rows) {
    const title = String(r.title || '').toLowerCase();
    const urlStr = String(r.url || '').toLowerCase();
    const content = String(r.content || '');
    const boundedContent = content.length > 50_000
      ? `${content.slice(0, 25_000)} ${content.slice(-25_000)}`
      : content;
    const bag = [r.title, r.url, r.filename, r.notes, boundedContent, r.search_blob, r.tags].join(' ').toLowerCase();
    const ba = bag.replace(/[^a-z0-9]/g, '');
    let score = 0;
    if (title === q) score += 100;
    if (title.startsWith(q)) score += 50;
    if (title.includes(q)) score += 30;
    if (urlStr.includes(q)) score += 20;
    if (bag.includes(q)) score += 10;
    if (qa.length >= 2 && ba.includes(qa)) score += 8;
    let termHits = 0;
    for (const term of terms) {
      const compact = term.replace(/[^a-z0-9]/g, '');
      if (bag.includes(term) || (compact.length >= 2 && ba.includes(compact))) {
        termHits++;
        score += term === q ? 20 : 8;
      }
    }
    if (terms.length && termHits === terms.length) score += 30;
    else if (termHits > 1) score += termHits * 5;
    if (score >= minScore) scored.push({ r, score });
  }
  scored.sort((a, b) => b.score - a.score || (b.r.created_at || 0) - (a.r.created_at || 0));
  return takeResults(scored.map(s => s.r), limit);
}

const DOCUMENT_MAX_BYTES = 5 * 1024 * 1024;
const DOCUMENT_EXTENSIONS = new Set([
  'md', 'markdown', 'txt', 'py', 'js', 'ts', 'jsx', 'tsx', 'sh', 'bash', 'zsh', 'fish',
  'css', 'html', 'htm', 'json', 'yaml', 'yml', 'toml', 'xml', 'csv', 'sql', 'go', 'rs',
  'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'php', 'swift', 'kt', 'kts', 'lua', 'r',
  'dart', 'vue', 'svelte', 'ini', 'cfg', 'conf', 'env', 'log',
]);
// Binary formats anydoc converts to Markdown before ingestion. The native
// bindings need the libuv thread pool, so conversion runs on the self-host
// Node runtime only; the Cloudflare Worker path gets a clear error instead.
const CONVERTIBLE_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'docm', 'ppt', 'pps', 'pot', 'pptx', 'pptm', 'ppsx', 'ppsm',
  'xls', 'xlsx', 'xlsm', 'xlsb', 'odt', 'ods', 'odp', 'rtf', 'epub',
]);
const CONVERT_SOURCE_MAX_BYTES = 20 * 1024 * 1024;

const ANYDOC_ERROR_MESSAGES = {
  unsupported: 'format not recognized, or an image-only/scanned PDF without a text layer',
  malformed: 'file is structurally unusable — no content could be extracted',
  encrypted: 'file is encrypted or password-protected',
  resourceLimit: 'file crossed a conversion safety limit (decompression, nesting, node count)',
  missingPart: 'a part required for meaningful output is absent',
  io: 'file could not be read',
};

let anydocModule = null;
async function convertDocumentToMarkdown(env, ext, base64) {
  if (!isSelfHosted(env)) {
    return { error: 'Binary formats (pdf, docx, xlsx, …) need the self-hosted server — the Cloudflare Worker cannot run the converter' };
  }
  let bytes;
  try {
    const bin = atob(base64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch (_) {
    return { error: 'content_base64 is not valid base64' };
  }
  if (bytes.length > CONVERT_SOURCE_MAX_BYTES) return { error: 'Document exceeds 20 MiB before conversion' };
  try {
    // Non-literal specifier so bundlers never try to resolve the native module.
    const spec = '@firecrawl/anydoc';
    anydocModule ||= await import(spec);
    const markdown = await anydocModule.toMarkdownBytes(bytes, ext);
    if (!markdown || !markdown.trim()) return { error: 'No text content found in document' };
    return { markdown };
  } catch (err) {
    const reason = ANYDOC_ERROR_MESSAGES[err && err.code];
    return { error: reason ? `Conversion failed: ${reason}` : `Conversion failed: ${(err && err.message) || 'unknown error'}` };
  }
}

/** Tag columns so an entire clone/backfill session can be deleted precisely. */
async function ensureTransferColumns(env) {
  for (const t of ['links', 'personal_links', 'uploaded_documents']) {
    try { await env.DB.prepare(`ALTER TABLE ${t} ADD COLUMN transfer_id TEXT`).run(); } catch (_) {}
  }
}

async function ensureDocumentsTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS uploaded_documents (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, user_id TEXT, community_id TEXT,
       filename TEXT NOT NULL, content TEXT NOT NULL, uploaded_by TEXT NOT NULL,
       github_path TEXT, created_at INTEGER NOT NULL, search_blob TEXT,
       source_chat_id TEXT, source_message_id TEXT
    )`
  ).run();
  await env.DB.prepare('ALTER TABLE uploaded_documents ADD COLUMN IF NOT EXISTS source_chat_id TEXT').run().catch(() => {});
  await env.DB.prepare('ALTER TABLE uploaded_documents ADD COLUMN IF NOT EXISTS source_message_id TEXT').run().catch(() => {});
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_documents_personal ON uploaded_documents(scope, user_id, created_at)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_documents_community ON uploaded_documents(scope, community_id, created_at)').run();
}

export async function ensureChunksTable(env) {
  await env.DB.prepare('CREATE EXTENSION IF NOT EXISTS vector').run().catch(() => {});
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS document_chunks (
        id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, scope TEXT NOT NULL, scope_key TEXT NOT NULL,
        chunk_idx INTEGER NOT NULL, page INTEGER, para_idx INTEGER, content TEXT NOT NULL,
        token_count INTEGER, embedding VECTOR(1536), tsv TSVECTOR, created_at BIGINT NOT NULL
      )`
    ).run();
  } catch (e) {
    const msg = String(e.message || '');
    if (/vector/i.test(msg) || /type "vector" does not exist/i.test(msg)) {
      await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS document_chunks (
          id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, scope TEXT NOT NULL, scope_key TEXT NOT NULL,
          chunk_idx INTEGER NOT NULL, page INTEGER, para_idx INTEGER, content TEXT NOT NULL,
          token_count INTEGER, embedding TEXT, tsv TSVECTOR, created_at BIGINT NOT NULL
        )`
      ).run().catch(() => {});
      await env.DB.prepare('ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS embedding TEXT').run().catch(() => {});
      await env.DB.prepare('ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS tsv TSVECTOR').run().catch(() => {});
    } else {
      throw e;
    }
  }
  // Self-heal: a TEXT fallback column (created before pgvector was installed)
  // is upgraded to VECTOR once the extension exists, so the ivfflat index can build.
  const embeddingType = await env.DB.prepare(
    "SELECT data_type FROM information_schema.columns WHERE table_name = 'document_chunks' AND column_name = 'embedding'"
  ).first('data_type').catch(() => null);
  const hasVector = await env.DB.prepare(
    "SELECT extname FROM pg_extension WHERE extname = 'vector'"
  ).first('extname').catch(() => null);
  if (embeddingType === 'text' && hasVector) {
    await env.DB.prepare('ALTER TABLE document_chunks ALTER COLUMN embedding TYPE VECTOR(1536) USING NULL').run().catch(() => {});
  }
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_chunks_doc ON document_chunks(doc_id, chunk_idx)').run().catch(() => {});
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_chunks_scope ON document_chunks(scope, scope_key, para_idx)').run().catch(() => {});
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON document_chunks USING ivfflat (embedding vector_l2_ops)').run().catch(() => {});
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_chunks_tsv ON document_chunks USING gin(tsv)').run().catch(() => {});
}

function documentFolder(scope, key) {
  return scope === 'personal' ? `documents/personal/${key}` : `documents/communities/${key}`;
}

function validateDocumentText(scope, filename, content) {
  if (typeof content !== 'string') return { error: 'content must be UTF-8 text' };
  const encoded = new TextEncoder().encode(content);
  if (/\x00/.test(content) || new TextDecoder().decode(encoded) !== content) return { error: 'content must be valid UTF-8 text' };
  const bytes = encoded.length;
  if (bytes > DOCUMENT_MAX_BYTES) return { error: 'Document exceeds 512 KiB' };
  const controls = (content.match(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g) || []).length;
  if (controls / Math.max(content.length, 1) > 0.01) return { error: 'Binary or control-heavy content is not allowed' };
  return { scope, filename, content, bytes };
}

function validateDocumentInput(body) {
  const scope = String(body.scope || '').toLowerCase();
  const filename = String(body.filename || '').normalize('NFC').trim();
  if (scope !== 'personal' && scope !== 'community') return { error: 'scope must be personal or community' };
  if (!filename || filename.length > 180 || filename === '.' || filename === '..' || /[\\/\x00-\x1f\x7f]/.test(filename)) {
    return { error: 'Invalid filename' };
  }
  const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
  if (CONVERTIBLE_EXTENSIONS.has(ext)) {
    if (typeof body.content_base64 !== 'string' || !body.content_base64) {
      return { error: 'content_base64 (raw file bytes) required for this format' };
    }
    return { scope, filename, ext, convertible: true, contentBase64: body.content_base64 };
  }
  if (!DOCUMENT_EXTENSIONS.has(ext)) return { error: 'File extension is not allowed' };
  return validateDocumentText(scope, filename, body.content);
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
  let doc = validateDocumentInput(body);
  if (doc.error) return Response.json({ success: false, error: doc.error }, { status: 400, headers: corsHeaders });
  if (doc.convertible) {
    const converted = await convertDocumentToMarkdown(env, doc.ext, doc.contentBase64);
    if (converted.error) return Response.json({ success: false, error: converted.error }, { status: 400, headers: corsHeaders });
    doc = validateDocumentText(doc.scope, doc.filename, converted.markdown);
    if (doc.error) return Response.json({ success: false, error: `${doc.error} (after conversion to Markdown)` }, { status: 400, headers: corsHeaders });
  }
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
  markMeiliScopeDirty(env, doc.scope, key);
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
  markMeiliScopeDirty(env, row.scope, row.scope === 'personal' ? row.user_id : row.community_id);
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
    markMeiliScopeDirty(env, 'community', payload.community_id || n.community_id);
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
    row = await env.DB.prepare(
      'SELECT base_url, model, mode, updated_at, api_key FROM user_ai_config ORDER BY updated_at DESC LIMIT 1'
    ).first();
  }
  if (row && row.api_key) {
    try {
      const decrypted = await decryptSecret(env, row.api_key);
      if (decrypted === null && String(row.api_key).startsWith('enc:v1:')) {
        row._decrypt_failed = true;
        row.api_key = null;
      } else {
        row.api_key = decrypted;
      }
    } catch (_) {
      row._decrypt_failed = true;
      row.api_key = null;
    }
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
  const decryptFailed = !!row._decrypt_failed;
  return Response.json({
    success: true,
    configured: true,
    baseUrl: row.base_url,
    model: row.model,
    mode: row.mode,
    hasKey: !!row.api_key,
    decrypt_failed: decryptFailed,
    error: decryptFailed ? 'API key decryption failed — STORAGE_KEY missing or rotated. GOD must re-save credentials.' : undefined,
    updatedAt: row.updated_at,
    read_only: !isGod
  }, { headers: corsHeaders });
}

async function writeInstanceAiConfig(env, { baseUrl, apiKey, model, mode, updatedAt = Date.now(), userId = null }) {
  await ensureAiConfigTable(env);
  const encKey = await encryptSecret(env, apiKey);
  await env.DB.prepare(
    `INSERT INTO user_ai_config (user_id, base_url, api_key, model, mode, updated_at)
     VALUES ('__instance__', ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       base_url = excluded.base_url,
       api_key = excluded.api_key,
       model = excluded.model,
       mode = excluded.mode,
       updated_at = excluded.updated_at`
  ).bind(baseUrl, encKey, model, mode, updatedAt).run();
  if (userId) {
    await env.DB.prepare(
      `INSERT INTO user_ai_config (user_id, base_url, api_key, model, mode, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         base_url = excluded.base_url,
         api_key = excluded.api_key,
         model = excluded.model,
         mode = excluded.mode,
         updated_at = excluded.updated_at`
    ).bind(userId, baseUrl, encKey, model, mode, updatedAt).run();
  }
}

async function aiConfigPeerUrl(env) {
  const configured = isSelfHosted(env)
    ? env.ATHENA_AI_PEER_URL
    : await getInstanceSetting(env, 'default_backend');
  const value = String(configured || '').trim().replace(/\/+$/, '');
  if (!value) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.origin : '';
  } catch (_) { return ''; }
}

async function syncAiConfigToPeer(env, payload) {
  // Both runtimes already share this secret for Telegram webhook auth. Prefer a
  // dedicated sync secret when one is supplied, then use the existing shared
  // secret so config sync works on older deployments without new provisioning.
  const secret = String(env.AI_CONFIG_SYNC_SECRET || env.TELEGRAM_WEBHOOK_SECRET || env.STORAGE_KEY || '');
  const peer = await aiConfigPeerUrl(env);
  if (!secret || !peer) return false;
  try {
    const response = await fetchWithTimeout(`${peer}/api/internal/ai-config`, {
      method: 'POST',
      env,
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        'X-Athena-Internal-Key': secret
      },
      body: JSON.stringify(payload)
    }, 10000);
    return response.ok;
  } catch (err) {
    console.error('AI config peer sync failed', err?.message || err);
    return false;
  }
}

async function handleInternalAiConfigSync(request, env, corsHeaders) {
  const expected = String(env.AI_CONFIG_SYNC_SECRET || env.TELEGRAM_WEBHOOK_SECRET || env.STORAGE_KEY || '');
  const provided = request.headers.get('X-Athena-Internal-Key') || '';
  if (!expected || provided !== expected) {
    return Response.json({ success: false, error: 'Forbidden' }, { status: 403, headers: corsHeaders });
  }
  const body = await request.json().catch(() => ({}));
  if (body.clear) {
    await ensureAiConfigTable(env);
    await env.DB.prepare('DELETE FROM user_ai_config').run();
    return Response.json({ success: true, cleared: true }, { headers: corsHeaders });
  }
  const baseUrl = cleanApiBase(body.baseUrl || body.base_url || '');
  const apiKey = String(body.apiKey || body.api_key || '').trim();
  const model = normalizeModelId(body.model, baseUrl);
  const mode = String(body.mode || 'openai').toLowerCase();
  const updatedAt = Number(body.updatedAt || body.updated_at || Date.now());
  if (!baseUrl || !apiKey || !model || !Number.isFinite(updatedAt)) {
    return Response.json({ success: false, error: 'Invalid AI config' }, { status: 400, headers: corsHeaders });
  }
  await ensureAiConfigTable(env);
  const existing = await env.DB.prepare(
    "SELECT updated_at FROM user_ai_config WHERE user_id = '__instance__'"
  ).first();
  if (existing && Number(existing.updated_at || 0) > updatedAt) {
    return Response.json({ success: true, ignored: true }, { headers: corsHeaders });
  }
  await writeInstanceAiConfig(env, { baseUrl, apiKey, model, mode, updatedAt });
  return Response.json({ success: true, synced: true }, { headers: corsHeaders });
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
  const updatedAt = Date.now();
  await writeInstanceAiConfig(env, { baseUrl, apiKey, model, mode, updatedAt, userId: user.id });
  const peerSynced = await syncAiConfigToPeer(env, { baseUrl, apiKey, model, mode, updatedAt });
  return Response.json({ success: true, peer_synced: peerSynced }, { headers: corsHeaders });
}

async function handleClearAiConfig(user, env, corsHeaders) {
  await ensureAiConfigTable(env);
  await env.DB.prepare("DELETE FROM user_ai_config WHERE user_id = '__instance__'").run();
  await env.DB.prepare('DELETE FROM user_ai_config WHERE user_id = ?').bind(user.id).run();
  const peerSynced = await syncAiConfigToPeer(env, { clear: true, updatedAt: Date.now() });
  return Response.json({ success: true, peer_synced: peerSynced }, { headers: corsHeaders });
}

// ============================================================
// Pluggable link storage — PostgreSQL only (D1/GitHub removed).
// Legacy GitHub cache tables (storage_sync, storage_file_cache, parked_*) kept for compat.
// ============================================================
/* eslint-disable no-unused-vars */
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

/** Per-file parse cache kept for compat — orphaned after postgres-only (GitHub removed). */
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

/** Parking/switching removed — PostgreSQL is the only store. Kept as no-ops for call sites. */
async function parkActiveStore(_env, _storeName) { return; }
async function restoreStore(_env, _storeName) { return; }
async function clearActiveStoreFolder(_env, _scope, _key) { return { handled: false }; }
async function clearActiveDocumentFolder(_env, _scope, _key) { return { handled: false }; }
async function parkedLinksFor(_env, _storeName, _scope, _key) { return []; }
async function getStorageConfig(env) {
  // Single-backend mode: always PostgreSQL. Existing rows (provider='d1'/'github') are ignored.
  return { provider: 'postgres', repo: '', branch: '', token: null };
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

/** GitHub removed — always null. */
async function githubStoreFor(_env) { return null; }
function scopeKeyFor(scope, key) {
  return scope === 'personal' ? `personal:${key}` : `community:${key}`;
}
/** No-op: PostgreSQL is live, no cache to reconcile. */
async function ensureFresh(_env, _scope, _key, { force = false } = {}) {
  return { provider: 'postgres' };
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
    markMeiliScopeDirty(env, 'personal', key);
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
  markMeiliScopeDirty(env, 'community', key);
}

function storageHeadingFor(scope, key) {
  return scope === 'personal' ? 'Athena — personal brain' : `Athena — community ${key}`;
}

/** GitHub removed — always fall through to PostgreSQL direct INSERT. */
async function storeAddLink(_env, _scope, _key, _link) { return { handled: false }; }
async function storeAddLinks(_env, _scope, _key, _links) { return { handled: false }; }
async function storeMutateLink(_env, _scope, _key, _linkId, _replacement) { return { handled: false }; }

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

/** Current rows for a scope (legacy Markdown helper, kept). */
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
/* eslint-enable no-unused-vars */

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

async function getSteroidMode(env) {
  const val = await getInstanceSetting(env, 'ai_steroid_mode');
  return val === '1' || val === 'true';
}

async function setSteroidMode(env, enabled) {
  await ensureInstanceSettings(env);
  await env.DB.prepare('INSERT OR REPLACE INTO instance_settings (key, value, updated_at) VALUES (?, ?, ?)').bind('ai_steroid_mode', enabled ? '1' : '0', Date.now()).run();
}

async function syncSteroidToPeer(env, enabled) {
  const secret = String(env.AI_CONFIG_SYNC_SECRET || env.TELEGRAM_WEBHOOK_SECRET || env.STORAGE_KEY || '');
  const peer = await aiConfigPeerUrl(env);
  if (!secret || !peer) return false;
  try {
    const res = await fetchWithTimeout(`${peer}/api/internal/steroid`, {
      method: 'POST',
      env,
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-Athena-Internal-Key': secret },
      body: JSON.stringify({ steroid: !!enabled, updatedAt: Date.now() })
    }, 10000);
    return res.ok;
  } catch (err) {
    console.error('Steroid peer sync failed', err?.message || err);
    return false;
  }
}

async function handleInternalSteroidSync(request, env, corsHeaders) {
  const expected = String(env.AI_CONFIG_SYNC_SECRET || env.TELEGRAM_WEBHOOK_SECRET || env.STORAGE_KEY || '');
  const provided = request.headers.get('X-Athena-Internal-Key') || '';
  if (!expected || provided !== expected) {
    return Response.json({ success: false, error: 'Forbidden' }, { status: 403, headers: corsHeaders });
  }
  const body = await request.json().catch(() => ({}));
  const enabled = !!(body.steroid ?? body.enabled);
  const updatedAt = Number(body.updatedAt || Date.now());
  await ensureInstanceSettings(env);
  const existing = await env.DB.prepare('SELECT value, updated_at FROM instance_settings WHERE key = ?').bind('ai_steroid_mode').first();
  if (existing && Number(existing.updated_at || 0) > updatedAt) {
    return Response.json({ success: true, ignored: true }, { headers: corsHeaders });
  }
  await setSteroidMode(env, enabled);
  return Response.json({ success: true, steroid: enabled }, { headers: corsHeaders });
}

async function getWebsiteDisplayUrl(env) {
  // Instance website URL comes from the DB (GOD sets it in Settings → Backend)
  // or ATHENA_FRONTEND_URL — never hardcoded, so forks stay neutral.
  try {
    const backend = await getInstanceSetting(env, 'default_backend');
    const url = (backend || env.ATHENA_FRONTEND_URL || '').trim().replace(/\/+$/, '');
    return url;
  } catch (_) { return ''; }
}

async function handleGetInstanceConfig(env, corsHeaders) {
  return Response.json({
    success: true,
    default_backend: await getInstanceSetting(env, 'default_backend'),
    steroid: await getSteroidMode(env),
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
  // PostgreSQL-only mode
  const engine = selfHostedEngine(env);
  return Response.json({
    success: true,
    provider: 'postgres',
    runtime: isSelfHosted(env) ? 'selfhost' : 'cloudflare',
    github_available: false,
    postgres_available: true,
    store_label: `${engine} (PostgreSQL)`,
    db_engine: engine,
    repo: '',
    branch: '',
    has_token: false,
    token_encrypted: false,
  }, { headers: corsHeaders });
}

async function handleSaveStorageConfig(request, env, corsHeaders) {
  // Single backend — no switching. Keep endpoint for compatibility but reject other providers.
  const body = await request.json().catch(() => ({}));
  const provider = String(body.provider || 'postgres').toLowerCase();
  if (provider !== 'postgres' && provider !== 'local' && provider !== 'postgresql') {
    return Response.json({ success: false, error: 'Only PostgreSQL is supported (D1/GitHub removed). Set DATABASE_URL.' }, { status: 400, headers: corsHeaders });
  }
  return Response.json({ success: true, provider: 'postgres', engine: selfHostedEngine(env) }, { headers: corsHeaders });
}

// GitHub/D1 sync removed — PostgreSQL only. Stubs kept for call sites.
// eslint-disable-next-line no-unused-vars
async function mergeScope(_env, _store, _scope, _key) { return { ok: true, total: 0 }; }
// eslint-disable-next-line no-unused-vars
async function replaceParkedLinks(_env, _storeName, _scope, _key, _links) { return; }
// eslint-disable-next-line no-unused-vars
async function mergeAllScopes(_env, _store, _godUserId) { return { ok: true, total: 0, detail: [] }; }
async function handleStorageSync(_user, _env, corsHeaders) {
  return Response.json({ success: false, error: 'Sync removed — PostgreSQL is the only store (D1/GitHub deprecated). Use backups.', code: 'POSTGRES_ONLY' }, { status: 400, headers: corsHeaders });
}

function cleanApiBase(baseUrl) {
  let root = String(baseUrl || '').trim();
  // strip quotes, trailing junk users paste by accident
  root = root.replace(/^['"]|['"]$/g, '');
  root = root.replace(/[.,;]+$/g, '');
  root = root.replace(/\/+$/g, '');
  // drop accidental path suffixes
  root = root.replace(/\/chat\/completions$/i, '');
  root = root.replace(/\/responses$/i, '');
  root = root.replace(/\/messages$/i, '');
  root = root.replace(/\/(?:api\/)?models$/i, '');
  root = root.replace(/\/+$/g, '');
  // OpenCode Zen / Go: ensure /v1 (saved as .../zen/go without /v1 → 404)
  if (/opencode\.ai\/zen(\/go)?$/i.test(root)) root = `${root}/v1`;
  return root;
}

/**
 * Self-hosted gateways such as OmniRoute normally listen on loopback over
 * plain HTTP. They are administrator-controlled instance configuration, so
 * allow only explicitly local targets while keeping public AI URLs HTTPS-only.
 */
function isLocalAiEndpoint(u, env) {
  if (!isSelfHosted(env) || !u || u.protocol !== 'http:') return false;
  const host = String(u.hostname || '').toLowerCase();
  if (host === 'localhost' || host === 'host.docker.internal' || host === '::1') return true;
  const v4 = host.match(/^(\d{1,3})(?:\.(\d{1,3})){3}$/);
  if (!v4) return false;
  const octets = host.split('.').map(Number);
  if (octets.some((n) => n > 255)) return false;
  return octets[0] === 127
    || octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

async function isAllowedAiEndpoint(u, env) {
  if (!u) return false;
  if (u.protocol === 'http:') return isLocalAiEndpoint(u, env);
  return u.protocol === 'https:' && await isSafeExternalUrl(u, env);
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
    if (!isSelfHosted(env)) return true;
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const host = (u.hostname || '').trim().toLowerCase();
    if (!host) return false;
    if (PRIVATE_HOST_RE.test(host)) return false;
    let ip = host;
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
    if (!isIp) {
      const cached = DNS_VERDICTS.get(host);
      if (cached && cached.until > Date.now()) return cached.safe;
      // Known public AI providers — allow even if DoH temporarily unreachable
      const KNOWN_PUBLIC = /(?:api\.openai\.com|api\.anthropic\.com|api\.groq\.com|openrouter\.ai|api\.deepseek\.com|api\.cohere\.ai|integrate\.api\.nvidia\.com|opencode\.ai|api\.github\.com|models\.dev)$/i;
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
        if (!addrs.length) {
          // No records: could be NXDOMAIN or DoH outage. For known public AI hosts, assume safe
          // to avoid breaking AI search during transient DNS issues; otherwise block.
          if (KNOWN_PUBLIC.test(host)) {
            return true;
          }
          console.warn(`[athena] isSafeExternalUrl: no DNS records for ${host} — blocking (DoH failure or NXDOMAIN)`);
          return false;
        }
        safe = addrs.every(isPublicIp);
      } catch (_) {
        if (KNOWN_PUBLIC.test(host)) {
          console.warn(`[athena] isSafeExternalUrl: DoH exception for ${host}, but known public — allowing`);
          return true;
        }
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

function resolveChatEndpoint(baseUrl, mode, model = '') {
  let root = cleanApiBase(baseUrl);
  if (!root) return null;
  if (!/^https?:\/\//i.test(root)) root = `https://${root}`;

  const modelId = String(model || '').toLowerCase();

  // OpenCode Zen/Go: some models use Responses or Anthropic Messages endpoints
  if (/opencode\.ai\/zen/i.test(root)) {
    if (/^gpt-5(\.|$|-)/i.test(modelId) || modelId.includes('gpt-5')) {
      if (/\/responses$/i.test(root)) return root;
      if (/\/v1$/i.test(root)) return `${root}/responses`;
      return `${root}/v1/responses`;
    }
    if (/^(minimax|qwen)/i.test(modelId)) {
      if (/\/messages$/i.test(root)) return root;
      if (/\/v1$/i.test(root)) return `${root}/messages`;
      return `${root}/v1/messages`;
    }
  }

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
  // Normalize display names like "Big Pickle" -> "big-pickle"
  // Handles caps, spaces, underscores pasted from UI/docs
  if (/[A-Z\s]/.test(m)) {
    m = m.toLowerCase().replace(/[\s_]+/g, '-').replace(new RegExp('[^a-z0-9/.-]', 'g'), '');
    m = m.replace(/-+/g, '-').replace(/^-|-$/g, '');
  } else {
    m = m.trim().replace(/-+/g, '-');
  }
  return m;
}

/** Time-to-first-byte budget for the upstream model call; a cold model is slow. */
const AI_PROXY_TIMEOUT_MS = 30_000;

// Recent upstream AI failures, newest first. In-memory: a restart clears it,
// which matches its purpose — "what just broke" for the GOD settings panel.
const AI_ERROR_LOG = [];
const AI_ERROR_LOG_MAX = 50;
// Provider model catalogs served to the settings picker, 5 min per base.
const AI_MODEL_LIST_CACHE = new Map();
function recordAiError({ provider, model, status, endpoint, message, source }) {
  try {
    AI_ERROR_LOG.unshift({
      time: Date.now(),
      provider: String(provider || detectProviderForModel(model, endpoint) || 'unknown'),
      model: String(model || ''),
      status: status == null ? null : Number(status),
      endpoint: String(endpoint || ''),
      message: String(message || '').slice(0, 300),
      source: String(source || 'proxy'),
    });
    if (AI_ERROR_LOG.length > AI_ERROR_LOG_MAX) AI_ERROR_LOG.length = AI_ERROR_LOG_MAX;
  } catch (_) {}
}

/**
 * One shared non-streaming chat call for every AI consumer (bot /ai,
 * enrichment helpers): SSRF-checked endpoint, model fallback chain,
 * Retry-After honored, errors normalized AND recorded in the error log.
 * Returns { content, model, endpoint }. Throws an Error carrying
 * .status/.endpoint/.model on failure.
 */
async function callAiChatShared(env, { baseUrl, apiKey, mode, model, system, user: userMsg, maxTokens = 3000, temperature = 0.2, source = 'bot' }) {
  const base = cleanApiBase(baseUrl || '');
  const key = String(apiKey || '').trim();
  const m = normalizeModelId(model, base);
  const aiMode = (mode || 'openai').toLowerCase();
  if (!base || !key || !m) {
    const e = new Error('AI credentials incomplete');
    e.status = 400;
    throw e;
  }
  let endpoint;
  try {
    const u = new URL(base.startsWith('http') ? base : `https://${base}`);
    if (!(await isAllowedAiEndpoint(u, env))) throw new Error('API base must be a public HTTPS host or a local self-hosted gateway');
    endpoint = resolveChatEndpoint(base, aiMode, m);
    if (!endpoint) throw new Error('Could not resolve chat endpoint');
    const ep = new URL(endpoint);
    if (!(await isAllowedAiEndpoint(ep, env))) throw new Error('API base must be a public HTTPS host or a local self-hosted gateway');
  } catch (err) {
    recordAiError({ model: m, endpoint: base, message: err?.message || String(err), source });
    const e = new Error(err?.message || 'Invalid AI base URL');
    e.status = 400;
    throw e;
  }

  const tryModels = [m, ...(await getFallbackChain(base, env, key, m))];
  let lastErr = null;
  for (let mi = 0; mi < tryModels.length; mi++) {
    const curModel = tryModels[mi];
    const curEndpoint = resolveChatEndpoint(base, aiMode, curModel);
    try {
      let res;
      if (aiMode === 'anthropic') {
        res = await fetchWithTimeout(curEndpoint, {
          method: 'POST', env, redirect: 'error', allowPrivate: true,
          headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: curModel, max_tokens: maxTokens, system: system || undefined, messages: [{ role: 'user', content: userMsg }] })
        }, AI_PROXY_TIMEOUT_MS);
      } else if (curEndpoint.endsWith('/responses')) {
        res = await fetchWithTimeout(curEndpoint, {
          method: 'POST', env, redirect: 'error', allowPrivate: true,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ model: curModel, input: system ? `${system}\n\n${userMsg}` : userMsg })
        }, AI_PROXY_TIMEOUT_MS);
      } else {
        res = await fetchWithTimeout(curEndpoint, {
          method: 'POST', env, redirect: 'error', allowPrivate: true,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ model: curModel, messages: [{ role: 'system', content: system || '' }, { role: 'user', content: userMsg }], temperature, max_tokens: maxTokens })
        }, AI_PROXY_TIMEOUT_MS);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const retryable = res.status === 429 || res.status === 503 || res.status === 502 || res.status === 500 || res.status === 401 || res.status === 402;
        const retryAfter = parseInt(res.headers.get('retry-after') || res.headers.get('Retry-After') || '0', 10);
        if (retryable && mi < tryModels.length - 1) {
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 400 * (mi + 1);
          await new Promise((r) => setTimeout(r, Math.min(waitMs, 15_000)));
          continue;
        }
        let data = {};
        try { data = JSON.parse(text); } catch (_) { data = { raw: text.slice(0, 300) }; }
        const msg = data.error?.message || data.message || (typeof data.error === 'string' ? data.error : null) || (/^\s*</.test(text) ? `Provider returned HTML (HTTP ${res.status}) — check base URL` : text.slice(0, 200) || res.statusText);
        recordAiError({ model: curModel, status: res.status, endpoint: curEndpoint, message: msg, source });
        const e = new Error(msg);
        e.status = res.status; e.endpoint = curEndpoint; e.model = curModel;
        throw e;
      }
      const data = await res.json().catch(() => ({}));
      let content = '';
      if (aiMode === 'anthropic') {
        content = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      } else if (curEndpoint.endsWith('/responses')) {
        content = data.output_text || (Array.isArray(data.output) ? data.output.map((o) => Array.isArray(o.content) ? o.content.map((c) => c.text || '').join('') : '').join('\n') : '') || data.choices?.[0]?.message?.content || '';
      } else {
        content = data.choices?.[0]?.message?.content || '';
      }
      if (!content) {
        recordAiError({ model: curModel, status: 200, endpoint: curEndpoint, message: 'Empty response from model', source });
        const e = new Error('Empty response from model');
        e.status = 502; e.endpoint = curEndpoint; e.model = curModel;
        throw e;
      }
      return { content, model: curModel, endpoint: curEndpoint };
    } catch (err) {
      if (err?.status) throw err; // already normalized + recorded above
      lastErr = err;
      if (mi < tryModels.length - 1) { await new Promise((r) => setTimeout(r, 300 * (mi + 1))); continue; }
      recordAiError({ model: curModel, endpoint: curEndpoint, message: err?.message || String(err), source });
      const e = new Error(err?.message || 'All AI models failed');
      e.status = 502; e.endpoint = curEndpoint; e.model = curModel;
      throw e;
    }
  }
  const e = new Error(lastErr?.message || 'All AI models failed');
  e.status = 502;
  throw e;
}

async function handleAiChatProxy(request, user, env, corsHeaders) {
  if (!user) {
    return Response.json({ success: false, error: 'Login required', code: 'AUTH_REQUIRED' }, { status: 401, headers: corsHeaders });
  }
  const body = await request.json().catch(() => ({}));
  const inst = await getInstanceAiConfig(env);
  const bodyBase = cleanApiBase(body.baseUrl || body.base_url || '');
  const bodyKey = (body.apiKey || body.api_key || '').trim();
  const bodyMode = (body.mode || '').toLowerCase();
  const bodyModel = (body.model || '').trim();
  const hasOverride = !!(bodyBase || bodyKey || bodyMode || bodyModel);
  if (hasOverride && !(await isInstanceOwnerUserAsync(user, env))) {
    return Response.json(
      { success: false, error: 'Per-request AI overrides are GOD rank only' },
      { status: 403, headers: corsHeaders }
    );
  }
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
  const wantStream = body.stream === true ||
    (request.headers.get('accept') || '').toLowerCase().includes('text/event-stream');

  if (!baseUrl || !apiKey || !model) {
    const detail = inst?._decrypt_failed
      ? 'API key decryption failed — STORAGE_KEY missing or rotated. GOD must re-save credentials in Settings → AI.'
      : 'No AI credentials. GOD: Settings → AI → Save (syncs for website + bot /ai)';
    return Response.json(
      { success: false, error: detail, code: inst?._decrypt_failed ? 'DECRYPT_FAILED' : 'NO_CREDENTIALS' },
      { status: 400, headers: corsHeaders }
    );
  }

  try {
    const u = new URL(baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`);
    if (!(await isAllowedAiEndpoint(u, env))) {
      return Response.json({ success: false, error: 'API base must be HTTPS or a local self-hosted gateway' }, { status: 400, headers: corsHeaders });
    }
  } catch (_) {
    return Response.json({ success: false, error: 'Invalid baseUrl' }, { status: 400, headers: corsHeaders });
  }

  const endpoint = resolveChatEndpoint(baseUrl, mode, model);
  if (!endpoint) {
    return Response.json({ success: false, error: 'Could not resolve chat endpoint' }, { status: 400, headers: corsHeaders });
  }
  const ep = new URL(endpoint);
  if (!(await isAllowedAiEndpoint(ep, env))) {
    return Response.json({ success: false, error: 'API base must be HTTPS or a local self-hosted gateway' }, { status: 400, headers: corsHeaders });
  }

  let contextLimit = null;
  try {
    for (let ctxIter = 0; ctxIter < 6; ctxIter++) {
      let effectiveSystem = system;
      let effectiveUser = userMsg;
      let effectiveMessages = messages ? JSON.parse(JSON.stringify(messages)) : null;

      if (contextLimit !== null) {
        const suffix = '\n[content shortened for provider context]';
        if (effectiveSystem) {
          if (effectiveSystem.length > contextLimit) {
            effectiveSystem = effectiveSystem.slice(0, Math.max(0, contextLimit - suffix.length)) + suffix;
          }
        } else if (effectiveMessages) {
          let remaining = contextLimit;
          for (let i = 0; i < effectiveMessages.length; i++) {
            const c = String(effectiveMessages[i].content || '');
            if (c.length > remaining && remaining > 500) {
              effectiveMessages[i].content = c.slice(0, remaining - suffix.length) + suffix;
              remaining = 0;
            } else {
              remaining -= c.length;
            }
            if (remaining <= 0) {
              effectiveMessages = effectiveMessages.slice(0, i + 1);
              break;
            }
          }
        } else if (effectiveUser) {
          if (effectiveUser.length > contextLimit) {
            effectiveUser = effectiveUser.slice(0, Math.max(0, contextLimit - suffix.length)) + suffix;
          }
        }
      }

      try {
        const tryModels = [model, ...(await getFallbackChain(baseUrl, env, apiKey, model))];
        let upstreamRes = null;
        let usedModel = model;
        let lastErrText = '';
        let _upstreamIsPlainJson = false;
        for (let mi=0; mi<tryModels.length; mi++) {
          const curModel = tryModels[mi];
          const streamAttempts = wantStream ? [true, false] : [false];
          for (let ai=0; ai<streamAttempts.length; ai++) {
            const doStream = streamAttempts[ai];
            try {
              const maxTok = Math.min(parseInt(body.max_tokens, 10) || 500, 8192);
              let curRes;
              if (mode === 'anthropic') {
                curRes = await fetchWithTimeout(endpoint, {
                  method: 'POST', env, redirect: 'error', allowPrivate: true,
                  headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
                  body: JSON.stringify({ model: curModel, max_tokens: maxTok, system: effectiveSystem || undefined, messages: effectiveMessages || [{ role: 'user', content: effectiveUser }], ...(doStream ? { stream: true } : {}) })
                }, AI_PROXY_TIMEOUT_MS);
              } else if (endpoint.endsWith('/responses')) {
                const input = effectiveMessages ? effectiveMessages.map(m => `${m.role}: ${m.content}`).join('\n\n') : (effectiveSystem ? `${effectiveSystem}\n\n${effectiveUser}` : effectiveUser);
                curRes = await fetchWithTimeout(endpoint, {
                  method: 'POST', env, redirect: 'error', allowPrivate: true,
                  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
                  body: JSON.stringify({ model: curModel, input })
                }, AI_PROXY_TIMEOUT_MS);
              } else {
                const msgs = effectiveMessages || [...(effectiveSystem ? [{ role: 'system', content: effectiveSystem }] : []), { role: 'user', content: effectiveUser }];
                curRes = await fetchWithTimeout(endpoint, {
                  method: 'POST', env, redirect: 'error', allowPrivate: true,
                  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
                  body: JSON.stringify({ model: curModel, messages: msgs, temperature: body.temperature ?? 0.2, max_tokens: maxTok, ...(doStream ? { stream: true } : {}) })
                }, AI_PROXY_TIMEOUT_MS);
              }

              if (!curRes.ok) {
                const text = await curRes.text();
                const isRetryable = curRes.status===429 || curRes.status===503 || curRes.status===502 || curRes.status===500 || curRes.status===401 || curRes.status===402;
                const retryAfter = parseInt(curRes.headers.get('retry-after')||curRes.headers.get('Retry-After')||'0',10);
                const waitMs = Number.isFinite(retryAfter) && retryAfter>0 ? retryAfter*1000 : 400*(mi+1);
                if (doStream && ai < streamAttempts.length-1) {
                  lastErrText = `stream refused (HTTP ${curRes.status})`;
                  continue;
                }
                if (isRetryable && mi < tryModels.length-1) {
                  console.warn(`AI chat fallback ${curModel} ${curRes.status} retryAfter ${retryAfter}s -> next`);
                  await new Promise(r=>setTimeout(r, waitMs));
                  break;
                }
                let data = {};
                try { data = JSON.parse(text); } catch (_) { data = { raw: text.slice(0, 500) }; }
                let msg = data.error?.message || data.message || data.error?.type || (typeof data.error === 'string' ? data.error : null) || null;
                if (!msg) {
                  if (/^\s*</.test(text) || /<!DOCTYPE/i.test(text)) {
                    msg = `Provider returned HTML (HTTP ${curRes.status}) — check base URL. Expected OpenAI chat endpoint.`;
                  } else {
                    msg = text.slice(0, 200) || curRes.statusText;
                  }
                }
                if (isAiContextError(msg) || isAiContextError(text)) {
                  const e = new Error(msg);
                  e.status = curRes.status;
                  e.endpoint = endpoint;
                  e.model = curModel;
                  throw e;
                }
                recordAiError({ model: curModel, status: curRes.status, endpoint, message: msg, source: 'proxy' });
                return Response.json({ success: false, error: msg, status: curRes.status, endpoint, model: curModel }, { status: 502, headers: corsHeaders });
              }
              upstreamRes = curRes;
              usedModel = curModel;
              _upstreamIsPlainJson = !doStream;
              break;
            } catch (e) {
              if (isAiContextError(e)) throw e;
              lastErrText = e?.message || String(e);
              const timedOut = e?.name === 'AbortError';
              if (!timedOut && doStream && ai < streamAttempts.length-1) { continue; }
              if (mi < tryModels.length-1) { await new Promise(r=>setTimeout(r, 300*(mi+1))); break; }
              throw e;
            }
          }
          if (upstreamRes) break;
        }
        if (!upstreamRes || !upstreamRes.ok) {
          return Response.json({ success: false, error: lastErrText || 'All AI models failed', model: usedModel, endpoint }, { status: 502, headers: corsHeaders });
        }

        if (endpoint.endsWith('/responses')) {
          const data = await upstreamRes.json().catch(() => ({}));
          const content = data.output_text || (Array.isArray(data.output) ? data.output.map(o => Array.isArray(o.content) ? o.content.map(c => c.text || '').join('') : '').join('\n') : '') || data.choices?.[0]?.message?.content || '';
          if (!wantStream) {
            return Response.json({ success: true, content, thinking: null, endpoint, model, usage: null }, { headers: corsHeaders });
          }
          const encoder = new TextEncoder();
          return new Response(new ReadableStream({
            start(controller) {
              const chunk = 40;
              for (let i = 0; i < content.length; i += chunk) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta: content.slice(i, i + chunk) })}\n\n`));
              }
              controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
              controller.close();
            }
          }), { headers: { ...corsHeaders, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' } });
        }

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
          let content = contentBuf || reasonBuf;
          let thinkingOut = reasonBuf || null;
          if (!content) {
            let data = {};
            try { data = JSON.parse(text); } catch (_) {}
            if (mode === 'anthropic') content = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
            else content = data.choices?.[0]?.message?.content || data.choices?.[0]?.text || data.output_text || '';
          }
          return Response.json({ success: true, content, thinking: thinkingOut, endpoint, model, usage: null }, { headers: corsHeaders });
        }

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
                    if (d.content) {
                      contentSeen += d.content;
                      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta: d.content })}\n\n`));
                    }
                    if (d.reasoning_content) {
                      reasonBuf += d.reasoning_content;
                      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ thinking: d.reasoning_content })}\n\n`));
                    }
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
          headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no', ...corsHeaders }
        });
      } catch (err) {
        if (isAiContextError(err)) {
          const currentSize = (system?.length || 0) + (userMsg?.length || 0) + JSON.stringify(messages || []).length;
          const effectiveSize = contextLimit === null ? currentSize : contextLimit;
          const nextLimit = Math.floor(effectiveSize * 0.6);
          if (nextLimit < 1000 || nextLimit >= effectiveSize) {
            recordAiError({ model, status: err.status || 400, endpoint, message: err.message || String(err), source: 'proxy-context' });
            return Response.json({ success: false, error: err.message || String(err), status: err.status || 400, endpoint, model }, { status: 502, headers: corsHeaders });
          }
          contextLimit = nextLimit;
          console.warn(`AI context too large (${currentSize} chars), retrying with ${nextLimit} chars`);
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    return Response.json({ success: false, error: err.message || 'Proxy request failed', endpoint, model }, { status: 502, headers: corsHeaders });
  }
}

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
      markMeiliScopeDirty(env, 'personal', userId);
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
      markMeiliScopeDirty(env, 'community', communityId);
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

  markMeiliScopeDirty(env, 'personal', userId);

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
  markMeiliScopeDirty(env, 'personal', userId);
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

  markMeiliScopeDirty(env, 'personal', userId);

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

  markMeiliScopeDirty(env, 'community', existing.community_id);

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

// Keep each HTML page comfortably below Telegram's 4096-character message
// limit so the navigation keyboard stays attached to the complete result page.
const TG_SEARCH_PAGE_SIZE = 5;
const TG_SEARCH_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

// Conversation threads for bot /ai follow-ups (reply to an answer).
async function ensureAiThreadsTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS tg_ai_threads (
       key TEXT PRIMARY KEY, ai_msg_id BIGINT, history TEXT, updated_at BIGINT)`
  ).run();
}
function aiThreadKey(chatId, threadId) { return `${chatId}:${threadId || 0}`; }

async function ensureTelegramSearchTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS telegram_search_sessions (
      id TEXT PRIMARY KEY,
      tg_user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      query TEXT NOT NULL,
      page INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`
  ).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_tg_search_sessions_expiry ON telegram_search_sessions(expires_at)').run().catch(() => {});
  await env.DB.prepare('DELETE FROM telegram_search_sessions WHERE expires_at < ?').bind(Date.now()).run().catch(() => {});
}

function telegramSearchKeyboard(sessionId, page, total) {
  const pages = Math.max(1, Math.ceil(total / TG_SEARCH_PAGE_SIZE));
  const nav = [];
  if (page > 0) nav.push({ text: '◀ Previous', callback_data: `search:prev:${sessionId}` });
  if (page < pages - 1) nav.push({ text: 'Next page ▶', callback_data: `search:next:${sessionId}` });
  return {
    inline_keyboard: [
      ...(nav.length ? [nav] : []),
      [{ text: '✖ Close', callback_data: `search:close:${sessionId}` }]
    ]
  };
}

function telegramSearchRowHtml(row) {
  const title = (row.title && !/^link from telegram/i.test(row.title))
    ? row.title
    : titleFromUrl(row.url || row.filename || '');
  const prefix = row.isDocument || row.type === 'document' ? '📄' : '🔗';
  const bits = [`${prefix} ${boldHtml(title || 'Untitled')}`];
  if (row.url) {
    const displayUrl = String(row.url).length > 220 ? `${String(row.url).slice(0, 220)}…` : row.url;
    bits.push(linkHtml(row.url, displayUrl));
  }
  else bits.push(italicHtml(`(${row.filename || 'document'})`));
  const notes = String(row.notes || row.content || '').replace(/\s+/g, ' ').trim();
  if (notes) bits.push(escHtml(notes.slice(0, 360)) + (notes.length > 360 ? '…' : ''));
  return bits.join('\n');
}

async function getTelegramSearchPage(env, session) {
  await ensureFresh(env, session.scope, session.scope_key);
  const accelerated = await meiliSearchScope(env, session.scope, session.scope_key, session.query, {
    limit: TG_SEARCH_PAGE_SIZE,
    offset: Math.max(0, Number(session.page || 0)) * TG_SEARCH_PAGE_SIZE
  });
  let hits;
  let total;
  if (accelerated) {
    hits = accelerated.rows;
    total = accelerated.total;
  } else {
    const rows = await searchAllLinks(env, session.scope, session.scope_key, session.query, null);
    const ranked = rankLinks(dedupeLinkRows(rows), session.query, null);
    total = ranked.length;
    const start = Math.max(0, Number(session.page || 0)) * TG_SEARCH_PAGE_SIZE;
    hits = ranked.slice(start, start + TG_SEARCH_PAGE_SIZE);
  }
  const pages = Math.max(1, Math.ceil(total / TG_SEARCH_PAGE_SIZE));
  const page = Math.min(Math.max(0, Number(session.page || 0)), pages - 1);
  if (page !== Number(session.page || 0)) {
    session.page = page;
    await env.DB.prepare('UPDATE telegram_search_sessions SET page = ? WHERE id = ?').bind(page, session.id).run().catch(() => {});
  }
  const start = total ? page * TG_SEARCH_PAGE_SIZE + 1 : 0;
  const end = Math.min(total, page * TG_SEARCH_PAGE_SIZE + hits.length);
  const label = session.scope === 'personal' ? 'Personal' : 'Community';
  const header = `${boldHtml(`🔍 ${label} Search`)} · ${start}–${end} of ${total}`;
  const html = hits.length
    ? `${header}\n${italicHtml(`Query: ${session.query}`)}\n\n${hits.map(telegramSearchRowHtml).join('\n\n')}`
    : `${header}\n\n${escHtml(session.query ? 'No matching saved items.' : 'Enter a search query.')}`;
  return { html, keyboard: telegramSearchKeyboard(session.id, page, total), page, total };
}

async function startTelegramSearch(env, token, chatId, tgUserId, scope, scopeKey, query, threadId) {
  await ensureTelegramSearchTable(env);
  const now = Date.now();
  const session = {
    id: `ts_${randomToken().slice(0, 12)}`,
    tg_user_id: String(tgUserId || ''),
    chat_id: String(chatId),
    scope,
    scope_key: String(scopeKey),
    query: String(query || '').trim().slice(0, 240),
    page: 0
  };
  await env.DB.prepare(
    `INSERT INTO telegram_search_sessions
      (id, tg_user_id, chat_id, scope, scope_key, query, page, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).bind(session.id, session.tg_user_id, session.chat_id, session.scope, session.scope_key,
    session.query, now, now + TG_SEARCH_SESSION_TTL_MS).run();
  const view = await getTelegramSearchPage(env, session);
  return sendTelegramMessageWithKeyboard(token, chatId, view.html, view.keyboard, threadId, 'HTML');
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

/** Resolve the configured log channel and the bot token that owns it. */
async function getConfiguredLogTarget(env, ownerUserId = null) {
  try {
    await ensureBotBindingColumns(env);
    let binding = null;
    if (ownerUserId) {
      binding = await env.DB.prepare(
        `SELECT log_channel_id, bot_token, scope FROM community_bots
          WHERE platform = 'telegram'
            AND (created_by = ? OR user_id = ?)
            AND log_channel_id IS NOT NULL AND log_channel_id != ''
          ORDER BY CASE WHEN COALESCE(scope,'personal')='personal' THEN 0 ELSE 1 END, created_at DESC LIMIT 1`
      ).bind(ownerUserId, ownerUserId).first();
    }
    // no unscoped fallback: don't leak another user's channel
    if (!binding?.log_channel_id) return null;
    const token = (binding.bot_token && await decryptBotToken(env, binding.bot_token)) || env.TELEGRAM_BOT_TOKEN;
    if (!token) return null;
    return { channelId: String(binding.log_channel_id), token };
  } catch (_) { return null; }
}

/** Send operational events only to the explicitly configured log channel. */
async function sendConfiguredLog(env, text, ownerUserId = null, target = null) {
  const logTarget = target || await getConfiguredLogTarget(env, ownerUserId);
  if (!logTarget?.channelId || !logTarget.token) return false;
  const result = await sendTelegramFormatted(logTarget.token, logTarget.channelId, text).catch(() => null);
  return !!result?.ok;
}

async function logWebsiteAuthFailure(env, provider, reason, subject = '') {
  const details = [
    `${boldHtml('⚠️ Website login failed')} (${escHtml(provider)})`,
    escHtml(reason),
    subject ? `User: ${escHtml(subject)}` : ''
  ].filter(Boolean).join('\n');
  await sendConfiguredLog(env, details);
}

async function logOperationalEvent(env, title, details, ownerUserId = null, target = null) {
  const text = [boldHtml(title), details ? escHtml(details) : ''].filter(Boolean).join('\n');
  await sendConfiguredLog(env, text, ownerUserId, target);
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
  markMeiliScopeDirty(env, 'community', communityId);
  try {
    await ensureDocumentsTable(env);
    await clearActiveDocumentFolder(env, 'community', communityId);
    await env.DB.prepare("DELETE FROM uploaded_documents WHERE scope = 'community' AND community_id = ?").bind(communityId).run();
  } catch (_) {}
  markMeiliScopeDirty(env, 'community', communityId);
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
  runInBackground(env, logOperationalEvent(
    env,
    '🗑️ Community deleted',
    `${c.name} (${c.id}); all community data was removed`
  ));
  return { ok: true, name: c.name, id: c.id };
}

async function saveCommunityUrlDirect(env, token, binding, rawUrl, senderName, athenaUser, chatId, userNotes = '', titleHint = '', threadId = null, fullPost = '') {
  const communityId = binding.community_id;
  if (!communityId) {
    await sendTelegramMessage(token, chatId, 'Group not linked as community. Owner: /community_verify', threadId);
    return;
  }
  if (!athenaUser) {
    await sendTelegramMessage(token, chatId,
      `Login at ${await getWebsiteDisplayUrl(env)} with Telegram, then /community_join ${communityId}`, threadId);
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
  // tagging: user #hashtags win, else karakeep AI (skip AI if tags already present)
  const fromPost = fullPost || userNotes + ' ' + (titleHint||'');
  let userTags = normalizeTagList(extractHashtags(fromPost + ' ' + userNotes + ' ' + (titleHint||'')));
  let reply;
  try {
    if (userTags.length) {
      const merged = [...new Set([...['telegram','community'], ...userTags])];
      await ensureSearchColumns(env);
      try {
        await env.DB.prepare(`UPDATE links SET title = ?, tags = ?, notes = ?, metadata_version = ${AI_METADATA_VERSION}, search_blob = NULL WHERE id = ?`)
          .bind(meta.title, JSON.stringify(merged), meta.notes || '', id).run();
        const g1 = await storeMutateLink(env, 'community', communityId, id, { title: meta.title, notes: meta.notes || '', tags: merged });
        if (g1?.handled && !g1.ok) { await sendTelegramMessage(token, chatId, `Saved to DB but GitHub sync failed: ${g1.error||'unknown'}`, threadId); reply = formatSavedLinkReply('community', meta.title, rawUrl, { title: meta.title, description: meta.notes || '', tags: userTags }); } else { reply = formatSavedLinkReply('community', meta.title, rawUrl, { title: meta.title, description: meta.notes || '', tags: userTags }); }
      } catch (_) { reply = formatSavedLinkReply('community', meta.title, rawUrl, { title: meta.title, description: meta.notes || '', tags: userTags }); }
    } else {
      const vocab = await recentTagsForScope(env, 'community', communityId);
      const ai = await aiDescribeAndTag(env, rawUrl, meta, vocab);
      if (ai) {
        const savedTitle = ai.title || meta.title;
        const merged = ai.tags?.length
          ? [...new Set([...['telegram', 'community'], ...ai.tags])]
          : ['telegram', 'community'];
        await ensureSearchColumns(env);
        try {
          await env.DB.prepare(`UPDATE links SET title = ?, tags = ?, notes = ?, metadata_version = ${AI_METADATA_VERSION}, search_blob = NULL WHERE id = ?`)
            .bind(savedTitle, JSON.stringify(merged), ai.description || meta.notes || '', id).run();
          const g2 = await storeMutateLink(env, 'community', communityId, id, { title: savedTitle, notes: ai.description || meta.notes || '', tags: merged });
          if (g2?.handled && !g2.ok) { await sendTelegramMessage(token, chatId, `Saved to DB but GitHub sync failed: ${g2.error||'unknown'}`, threadId); }
        } catch (_) {}
        reply = formatSavedLinkReply('community', savedTitle, rawUrl, ai);
      } else {
        const fb=fallbackTagsFromMeta(rawUrl, meta);
        if(fb.length){
          const mergedFb=[...new Set([...['telegram','community'], ...fb])];
          try{ await env.DB.prepare(`UPDATE links SET title = ?, tags = ?, notes = ?, metadata_version = ${AI_METADATA_VERSION}, search_blob = NULL WHERE id = ?`).bind(meta.title, JSON.stringify(mergedFb), meta.notes||'', id).run(); await storeMutateLink(env,'community',communityId,id,{title:meta.title, notes:meta.notes||'', tags:mergedFb}); }catch(_){}
          reply = formatSavedLinkReply('community', meta.title, rawUrl, {title: meta.title, description: meta.notes||'', tags: fb}, meta.notes);
        } else {
          reply = formatSavedLinkReply('community', meta.title, rawUrl, null, meta.notes);
        }
      }
    }
  } catch (_) {
    reply = formatSavedLinkReply('community', meta.title, rawUrl, null, meta.notes);
  }
  markMeiliScopeDirty(env, 'community', communityId);
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
  // Inline keyboard buttons — dump channels hide most links behind buttons.
  try {
    for (const row of msg?.reply_markup?.inline_keyboard || []) {
      for (const btn of row || []) {
        if (btn?.url) urls.add(String(btn.url).replace(/[),.;]+$/g, ''));
      }
    }
  } catch (_) {}
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

function extractHashtags(text) {
  const raw = String(text || '').match(/#[\w-]{1,40}/g);
  if (!raw) return [];
  const out = [];
  for (const h of raw) {
    const tag = h.slice(1).toLowerCase().replace(/\s+/g, '-').slice(0,40).trim();
    if (!tag) continue;
    if (['telegram','community','personal','dump'].includes(tag)) continue;
    if (!out.includes(tag)) out.push(tag);
    if (out.length >= 10) break;
  }
  return out;
}

function fallbackTagsFromMeta(rawUrl, meta) {
  const tags=[];
  try {
    const u=new URL(rawUrl.startsWith('http')?rawUrl:`https://${rawUrl}`);
    const host=u.hostname.replace(/^www\./,'').toLowerCase();
    const base=host.replace(/\.(com|net|org|io|so|app|dev|me|co|ai)$/i,'').split('.').pop()||'';
    if(base && !['github','t','telegram'].includes(base) && !tags.includes(base)) tags.push(base);
    if(host.includes('github') && !tags.includes('github')) tags.push('github');
    if(host.includes('youtube')||host.includes('youtu.be')) tags.push('video');
  } catch(_){}
  const text=`${meta?.title||''} ${meta?.notes||''} ${meta?.content||''}`.toLowerCase();
  const keywords=['dns','adblock','ublock','block','privacy','vpn','tool','client','proxy','security','network','filter','easylist','tracker'];
  for(const k of keywords){ if(text.includes(k) && !tags.includes(k)) tags.push(k); if(tags.length>=5) break; }
  // title words fallback
  if(tags.length<3){
    const words=String(meta?.title||'').toLowerCase().match(/[a-z]{3,15}/g)||[];
    for(const w of words){ if(!['the','and','with','from','this','that','client','project','independent','not'].includes(w) && !tags.includes(w)) tags.push(w); if(tags.length>=4) break; }
  }
  return tags.slice(0,6).map(t=>t.replace(/^#/,'').toLowerCase().replace(/\s+/g,'-').slice(0,40)).filter(Boolean);
}

function normalizeTagList(tags) {
  const out = [];
  for (const t of Array.isArray(tags) ? tags : []) {
    const tag = String(t).replace(/^#/,'').trim().toLowerCase().replace(/\s+/g,'-').slice(0,40);
    if (!tag || out.includes(tag)) continue;
    out.push(tag);
  }
  return out;
}

/**
 * Clean multi-link channel captions into readable notes.
 * Keep: title + description (+ optional special thanks).
 * Drop: Links block, support/donate fluff, hashtags (tags extracted separately via extractHashtags).
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
// helpers push the filter into SQL so every row is considered, including
// uploaded Markdown and JSON documents.
//
// search_blob holds a lowercased, alphanumeric-only copy of title+url+content+tags
// so a collapsed query ("ytdlp") still matches "yt-dlp" — the same trick
// fuzzyMatchLinks does in JS, but done where the whole table can be scanned.
// ---------------------------------------------------------------------------

async function ensureSearchColumns(env) {
  for (const sql of [
    'ALTER TABLE personal_links ADD COLUMN search_blob TEXT',
    'ALTER TABLE links ADD COLUMN search_blob TEXT',
    'ALTER TABLE uploaded_documents ADD COLUMN search_blob TEXT',
  ]) {
    try { await env.DB.prepare(sql).run(); } catch (_) {}
  }
}

function buildSearchBlob(row) {
  let tags = row.tags;
  if (typeof tags === 'string') { try { tags = JSON.parse(tags); } catch (_) { /* keep raw */ } }
  const bag = [row.title, row.url, row.filename, row.notes, row.content, Array.isArray(tags) ? tags.join(' ') : tags]
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

async function backfillDocumentSearchBlobs(env, scope, whereCol, whereVal, batch = 20) {
  await ensureDocumentsTable(env);
  await ensureSearchColumns(env);
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, filename, content
       FROM uploaded_documents
       WHERE scope = ? AND ${whereCol} = ? AND (search_blob IS NULL OR search_blob = '')
       LIMIT ${batch}`
    ).bind(scope, whereVal).all();
    for (const r of (results || [])) {
      await env.DB.prepare('UPDATE uploaded_documents SET search_blob = ? WHERE id = ?')
        .bind(buildSearchBlob(r), r.id).run();
    }
    return (results || []).length;
  } catch (_) { return 0; }
}

/**
 * Candidate rows for a query across the ENTIRE store — no recency window.
 * Returns [] for an empty query so callers can fall back to "recent".
 */
const SEARCH_SYNONYMS = {
  ai: ['llm', 'artificial intelligence', 'machine learning', 'local llm'],
  ddl: ['direct download', 'download'],
  download: ['ddl', 'direct download'],
  movie: ['movies', 'film', 'cinema', 'bollywood', 'web series'],
  movies: ['movie', 'film', 'cinema', 'bollywood', 'web series'],
  indian: ['india', 'hindi', 'bollywood', 'south indian'],
  ocr: ['optical character recognition', 'document scanning', 'computer vision'],
  github: ['repository', 'repo', 'open source'],
  localllama: ['local llm', 'llama', 'ollama'],
};

function expandServerSearchTerms(query) {
  const STOPWORDS_SERVER = new Set(['what','is','are','was','were','where','when','why','how','a','an','the','does','do','did','can','could','would','should','tell','me','about','of','for','on','in','to','you','your','it','this','that','with','from','and','or','as','at','be','by','if','we','us','my','our','please','list','some','show','find','give','get','recommend','recommendation','recommendations','suggest','suggestions','best','good']);
  const base = String(query || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  // Filter stopwords for search matching - "what is tokenrouter" should search for "tokenrouter", not "is"
  const filtered = base.filter(w => {
    const al = w.replace(/[^a-z0-9]/g, '');
    return al.length >= 2 && !STOPWORDS_SERVER.has(al);
  });
  const terms = filtered.length ? filtered : base.filter(w => w.replace(/[^a-z0-9]/g, '').length >= 2);
  const out = new Set(terms);
  for (const term of terms) {
    const key = term.replace(/[^a-z0-9]/g, '');
    for (const synonym of SEARCH_SYNONYMS[key] || []) out.add(synonym);
  }
  if (/local\s*llama|local\s*llm/i.test(query)) {
    for (const term of SEARCH_SYNONYMS.localllama) out.add(term);
  }
  return [...out].filter(term => term.length >= 2).slice(0, 24);
}

async function countScopeLinks(env, scope, key) {
  const table = scope === 'personal' ? 'personal_links' : 'links';
  const col = scope === 'personal' ? 'user_id' : 'community_id';
  try {
    await ensureDocumentsTable(env);
    const row = await env.DB.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE ${col} = ?`).bind(key).first();
    const docRow = await env.DB.prepare(
      `SELECT COUNT(*) AS total FROM uploaded_documents WHERE scope = ? AND ${col} = ?`
    ).bind(scope, key).first();
    return Number(row?.total || 0) + Number(docRow?.total || 0);
  } catch (_) { return null; }
}

function resultLimitClause(limit) {
  if (limit == null) return '';
  const n = Number(limit);
  return Number.isFinite(n) && n >= 0 ? ` LIMIT ${Math.floor(n)}` : '';
}

function takeResults(rows, limit) {
  return limit == null ? rows : rows.slice(0, Math.max(0, Number(limit)));
}

async function searchAllLinks(env, scope, key, query, limit = null) {
  const q = String(query || '').toLowerCase().trim().slice(0, 240);
  if (!q) return [];
  const table = scope === 'personal' ? 'personal_links' : 'links';
  const col = scope === 'personal' ? 'user_id' : 'community_id';
  await backfillSearchBlobs(env, table, col, key);
  await backfillDocumentSearchBlobs(env, scope, col, key);

  const terms = expandServerSearchTerms(q);
  if (!terms.length) return [];
  const clauses = terms.map(() => `(
    lower(COALESCE(title,'')) LIKE ? OR
    lower(COALESCE(url,'')) LIKE ? OR
    lower(COALESCE(notes,'')) LIKE ? OR
    lower(COALESCE(tags,'')) LIKE ? OR
    COALESCE(search_blob,'') LIKE ?
  )`).join(' OR ');
  const params = [key];
  for (const term of terms) {
    const like = `%${term}%`;
    params.push(like, like, like, like, `%${term.replace(/[^a-z0-9]/g, '')}%`);
  }
  try {
    const { results } = await env.DB.prepare(
      `SELECT * FROM ${table}
       WHERE ${col} = ?
         AND (${clauses})
       ORDER BY created_at DESC${resultLimitClause(limit)}`
    ).bind(...params).all();
    await ensureDocumentsTable(env);
    const docCol = scope === 'personal' ? 'user_id' : 'community_id';
    const docClauses = terms.map(() => `(
      lower(COALESCE(filename,'')) LIKE ? OR
      lower(COALESCE(content,'')) LIKE ? OR
      COALESCE(search_blob,'') LIKE ?
    )`).join(' OR ');
    const docParams = [scope, key];
    for (const term of terms) {
      const like = `%${term}%`;
      docParams.push(like, like, `%${term.replace(/[^a-z0-9]/g, '')}%`);
    }
    const { results: documents } = await env.DB.prepare(
      `SELECT * FROM uploaded_documents
       WHERE scope = ? AND ${docCol} = ?
         AND (${docClauses})
        ORDER BY created_at DESC${resultLimitClause(limit)}`
    ).bind(...docParams).all();
    return [...(results || []), ...(documents || []).map(documentAsLink)];
  } catch (_) { return []; }
}

/**
 * Rows to search over: every match in the store, plus the recent tail as a
 * fallback so an empty or unmatched query still has something to show.
 */
async function candidateLinks(env, scope, key, query, recentLimit = null) {
  const matches = await searchAllLinks(env, scope, key, query, recentLimit);
  const table = scope === 'personal' ? 'personal_links' : 'links';
  const col = scope === 'personal' ? 'user_id' : 'community_id';
  const { results: recent } = await env.DB.prepare(
    `SELECT * FROM ${table} WHERE ${col} = ? ORDER BY created_at DESC${resultLimitClause(recentLimit)}`
  ).bind(key).all();
  await ensureDocumentsTable(env);
  const { results: recentDocuments } = await env.DB.prepare(
    `SELECT * FROM uploaded_documents WHERE scope = ? AND ${col} = ? ORDER BY created_at DESC${resultLimitClause(recentLimit)}`
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
  if (!q) return rows;
  return rows.filter(r => {
    const bag = [r.title, r.url, r.filename, r.notes, r.content, r.tags].join(' ').toLowerCase();
    const ba = bag.replace(/[^a-z0-9]/g, '');
    return bag.includes(q) || (qa.length >= 2 && ba.includes(qa));
  });
}

function isAiContextError(error) {
  return /context length|context window|maximum context|too many tokens|prompt is too long|request too large|input.{0,20}long/i
    .test(String(error?.message || error || ''));
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
  markMeiliScopeDirty(env, 'personal', userId);
  return {
    duplicate: false,
    id,
    title: meta.title,
    url: rawUrl,
    notes: meta.notes,
    content: meta.content,
    scraped: meta.scraped
  };
}

async function deletePersonalUrl(env, userId, rawUrl) {
  const existing = await findExistingLink(env, 'personal_links', 'user_id', userId, rawUrl);
  if (!existing) return { found: false };
  await env.DB.prepare('DELETE FROM personal_links WHERE id = ? AND user_id = ?').bind(existing.id, userId).run();
  markMeiliScopeDirty(env, 'personal', userId);
  return { found: true, id: existing.id };
}

async function deleteCommunityUrl(env, communityId, rawUrl) {
  const existing = await findExistingLink(env, 'links', 'community_id', communityId, rawUrl);
  if (!existing) return { found: false };
  await env.DB.prepare('DELETE FROM links WHERE id = ?').bind(existing.id).run();
  await env.DB.prepare('DELETE FROM link_votes WHERE link_id = ?').bind(existing.id).run();
  markMeiliScopeDirty(env, 'community', communityId);
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
      { text: '👤 Personal', callback_data: 'help:personal' }
    ], [
      { text: '👥 Community', callback_data: 'help:community' },
      { text: '📡 Channels', callback_data: 'help:channels' }
    ]]
  };
}

function helpBackKeyboard() {
  return {
    inline_keyboard: [[
      { text: '« Help menu', callback_data: 'help:menu' }
    ], [
      { text: '🌐 Global', callback_data: 'help:global' },
      { text: '👤 Personal', callback_data: 'help:personal' }
    ], [
      { text: '👥 Community', callback_data: 'help:community' },
      { text: '📡 Channels', callback_data: 'help:channels' }
    ]]
  };
}

function helpTextForSection(section) {
  if (section === 'global') {
    return [
      `${boldHtml('🌐 Global')} ${italicHtml('— quick start & ranks')}`,
      '',
      `${boldHtml('Commands')}`,
      `/start — welcome & status`,
      `/help — this menu`,
      `/id — chat id · your user id · topic id`,
      `/rank — your ranks across communities ${italicHtml('(incl. banned)')}`,
      '',
      `${boldHtml('Ranks')}`,
      `• ${boldHtml('GOD')} — instance host ${codeHtml('TG_OWNER_IDS')} — personal, bot settings, AI credentials`,
      `• ${boldHtml('owner')} — community creator /community_verify`,
      `• ${boldHtml('admin')} — promoted with /admin`,
      `• ${boldHtml('member')} — ${italicHtml('login + join TG group +')} /community_join`,
      `• ${boldHtml('banned')} — left/kicked from that community's TG group ${italicHtml('(other communities OK)')}`,
      '',
      `${italicHtml('Tip:')} open a forum topic and /id shows topic id for /topic.`,
      `${italicHtml('Tip:')} clone channels/groups/topics into your brain — see ${boldHtml('📡 Channels')} in /help.`,
    ].join('\n');
  }
  if (section === 'personal') {
    return [
      `${boldHtml('👤 Personal')} ${italicHtml('(GOD rank only)')}`,
      '',
      `${boldHtml('Mode')} ${italicHtml('— dual dump target')}`,
      `/personal — dump → ${boldHtml('your personal brain')}`,
      `/community — dump → ${boldHtml('community brain')} ${italicHtml('(DM or group)')}`,
      `/mode — show current dump mode`,
       `${codeHtml('/mode personal | community')} — switch`,
      '',
      `${italicHtml('In bot DM after')} /community: ${italicHtml('paste URLs → community DB')}`,
      `${italicHtml('In bot DM after')} /personal: ${italicHtml('paste URLs → personal DB')}`,
      '',
      `${boldHtml('Links')}`,
      `• Paste a URL ${italicHtml('(or forward)')} in the active mode`,
       `• /search ${codeHtml('<query>')} — search active brain`,
       `• /export — Telegram export status and bot/session modes`,
      `• /ai ${codeHtml('<question>')} — AI over brain ${italicHtml('(all ranks community; personal GOD-only)')}`,
      `  ${italicHtml('Reply to any AI answer to ask a follow-up.')}`,
      `• /delete ${codeHtml('<url>')} — delete a link — or reply /delete`,
      `  ${codeHtml('/delete <chat_id> [thread_id] [files]')} — delete an entire cloned chat/topic (vault files too with "files")`,
      `• /edit ${codeHtml('<url or title words>')} | notes: New description`,
      `• /edit ${codeHtml('<url>')} | title: New Title | notes: New notes`,
      `• ${italicHtml('Reply to a saved link:')} /edit | title: New Title`,
      '',
      `${boldHtml('Multi-link posts')}`,
      `• /dumpall on — save every URL`,
      `• /dumpall off — ${boldHtml('SMART primary only')} ${italicHtml('(default)')}`,
      `• /dumpall — show multi-link mode`,
      `• /dumpsmart — same as /dumpall off`,
      '',
      `/clear_personal_db — wipe your personal links ${italicHtml('(GOD)')}`,
      '',
      `${italicHtml('Setup:')} website ${boldHtml('Settings → Bot')} ${italicHtml('(GOD: token + DM')} /id${italicHtml(')')}.`,
    ].join('\n');
  }
  if (section === 'community') {
    return [
      `${boldHtml('👥 Community')}`,
      '',
      `${boldHtml('Setup')}`,
      `• /community_verify — link this group ${italicHtml('(creates community; you = owner)')}`,
      `• /community — switch dump → ${boldHtml('community brain')}`,
      `• /personal — switch dump → ${boldHtml('personal brain')} ${italicHtml('(GOD)')}`,
      `• /mode — show dump mode · /mode personal|community`,
      '',
      `${boldHtml('Members')} ${italicHtml('(login + in TG group + join)')}`,
      `  ${codeHtml('1)')} Join the Telegram group`,
      `  ${codeHtml('2)')} Login on website ${italicHtml('(same Telegram)')}`,
      `  ${codeHtml('3)')} /community_join ${codeHtml('<id>')}`,
      `• Paste URL in group/topic to dump`,
      `• /community_list — name | id`,
      `• /community_list ${codeHtml('<id|name>')} — details`,
      `• /search ${codeHtml('<query>')} · /ai ${codeHtml('<question>')} · /rank`,
      `${italicHtml('Leave/kick/ban from group → site+bot access revoked until rejoin +')} /community_join`,
      '',
      `${boldHtml('Admin + owner')}`,
      `• /delete ${codeHtml('<url>')} · reply /delete — remove a link ${italicHtml('(staff)')}`,
      `  ${codeHtml('/delete <chat_id> [thread_id] [files]')} — delete all data cloned from that chat/topic`,
      `  ${codeHtml('/clone_del <id|chat_id> [files]')} — same, by backfill session id`,
      `• /edit ${codeHtml('<url|title>')} | notes: … — edit link`,
      `  ${italicHtml('Reply:')} /edit | title: … or notes: …`,
      `• /topic ${codeHtml('<id>')} — lock bot to that forum topic only`,
      `• /topic off — whole group · /topic — show lock`,
      `• /topic here — lock to current topic`,
      `• /dumpall on|off · /dumpsmart — multi-link mode`,
      `• /kick ${codeHtml('<@user|id>')} — remove community access ${italicHtml('(can rejoin)')} — reply /kick`,
      `• /clear ${codeHtml('<@user|id>')} — same as /kick`,
      `  ${italicHtml('Admin: members only · Owner/GOD: members+admins')}`,
      '',
      `${boldHtml('Owner only')}`,
      `• /admin — reply to user → promote admin`,
      `• /demote — reply or /demote ${codeHtml('<@user|id>')} → member`,
      `• /clear_db ${codeHtml('<id>')} — wipe community links only ${italicHtml('(keep community)')}`,
      `• /community_delete ${codeHtml('<id>')} — wipe community + all data`,
      `  ${italicHtml('then reply')} ${codeHtml('YES_DELETE_<token>')} ${italicHtml('to confirm')}`,
      '',
      `${boldHtml('File uploads:')} send ${codeHtml('.md/.txt/.json/.py')} etc in group → community brain`,
      `${boldHtml('Documents:')} ${codeHtml('.pdf/.docx/.pptx/.xlsx/.odt/.rtf/.epub')} convert to Markdown on self-host ${italicHtml('(20 MiB source → 5 MiB md)')}`,
      '',
      `${italicHtml('Auto-indexing')} ${italicHtml('(see')} ${boldHtml('📡 Channels')} ${italicHtml('in')} /help ${italicHtml('for the full guide)')}`,
      `• /channel_link ${codeHtml('<community_id> <channel_id>')} — channel posts → community brain`,
      `  ${italicHtml('(bot must be channel admin; owner/GOD runs this)')}`,
      `• /channel_unlink ${codeHtml('<channel_id>')} — stop indexing a channel`,
      `• /index — indexing status · history backfill needs /index_start`,
      '',
      `${boldHtml('GOD:')} /personal · /clear_personal_db · /sync · /backup · /db · website bot + AI credentials`,
      `• /setlogchannel ${codeHtml('<id|off>')} — set log channel for login/join notifications`,
      `• /restart — restart Athena service ${italicHtml('(GOD only)')}`,
    ].join('\n');
  }
  if (section === 'channels') {
    return [
      `${boldHtml('📡 Channels & history indexing')}`,
      '',
      `${boldHtml('Index NEW channel posts')}`,
      `${codeHtml('1)')} Add the bot to the channel as admin:`,
      `   ${italicHtml('Channel → Manage Channel → Administrators → Add Bot')}`,
      `${codeHtml('2)')} Link it to a community ${italicHtml('(owner/GOD, in the linked group or bot DM)')}:`,
      `   /channel_link ${codeHtml('<community_id> <channel_id> [community|personal|both]')}`,
      `   • ${italicHtml('target personal/both are GOD rank only — content lands in the GOD brain')}`,
      `   • ${italicHtml('channel_id: forward a channel post to')} ${codeHtml('@userinfobot')} ${italicHtml('(channel ids start with -100)')}`,
      `   • ${italicHtml('or forward a channel post to the bot and reply to it:')} /channel_link ${codeHtml('<community_id>')}`,
      `${codeHtml('3)')} Done — every new post's links and files land in that community brain.`,
      '',
      `/index — indexing status`,
      `/channel_unlink ${codeHtml('<channel_id>')} — stop indexing a channel`,
      `/channel_target ${codeHtml('<channel_id> <community|personal|both>')} — GOD: where content lands`,
      `${boldHtml('Groups & forum topics')}`,
      `/group_copy ${codeHtml('on|off')} — also save text-only posts (owner)`,
      `${boldHtml('🧬 Clone any chat')} ${italicHtml('(userbot mode — one command)')}`,
      `${codeHtml('/clone')} ${italicHtml('inside a channel/group/topic → live + history, auto-detected')}`,
      `${codeHtml('/clone <chat_id>')} ${italicHtml('in my DM — for channels you cannot type in; or forward a post and reply /clone')}`,
      `${codeHtml('/clone <chat_id> <min_id> <max_id>')} ${italicHtml('— clone an id range only')}`,
      `${codeHtml('/clone personal')} / ${codeHtml('/clone both')} ${italicHtml('— GOD targets')}`,
      `${boldHtml('🤖 Userbot accounts')} ${italicHtml('(self-host, GOD)')}`,
      `/userbot_connect ${codeHtml('<api_id> <api_hash> <session>')} — persistent session`,
      `/userbot_follow ${codeHtml('<community_id> <chat_id> [target]')} — clone a chat live`,
      `/userbot_status · /userbot_unfollow ${codeHtml('<chat_id>')} · /userbot_disconnect`,
      `${italicHtml('In-chat shortcuts:')} ${codeHtml('/follow [target]')} ${italicHtml('and')} ${codeHtml('/backfill')} ${italicHtml('— auto-detect chat/topic/community, reuse the connected session.')}`,
      `${boldHtml('Why a session?')} Bots only see messages after they are added as admin. A user session is your account reading the chat like Telegram Desktop does — connect it once and both live cloning and history backfill reuse it; nothing is asked twice.`,
      `${boldHtml('Progress & errors:')} backfills show a live progress bar; ${codeHtml('/userbot_status')} lists per-chat counters and the last errors.`,
      `${boldHtml('🏷 Tags:')} clones auto-tag via AI, context fallback when AI is down. ${codeHtml('/forcetags [community|personal|both]')} retags untagged links.`,
      `${boldHtml('Transfers & cleanup:')}`,
      `  ${codeHtml('/transfers')} — list backfill sessions (id, chat, counts)`,
      `  ${codeHtml('/clone_del <session_id|chat_id> [thread_id] [files]')} — delete that clone's data`,
      `  ${codeHtml('/delete <chat_id> [thread_id] [files]')} — same, shorter alias`,
      `  ${codeHtml('/forcetags [community|personal|both|<community_id>]')} — retag untagged links (AI + context fallback)`,
      `${boldHtml('Indexing dashboard:')} ${codeHtml('/userbot_status')} / ${codeHtml('/indexing')}`,
      `${boldHtml('Undo a bad clone:')} ${codeHtml('/transfers')} → ${codeHtml('/clone_del <session_id> [files]')} removes everything that session imported (vault media too with "files").`,
      `${boldHtml('Topic in DM:')} forward any post from the chat/topic to the bot → reply ${codeHtml('/clone')}`,
      `${boldHtml('Forum groups:')} bot auto-detects whether topics are enabled; without a thread it shows the topic list, with a thread it clones that topic only. After a backfill finishes, live cloning keeps capturing new posts automatically.`,
      `${boldHtml('Old posts:')} photo/link/text inside a caption or inline button are all indexed — use an id range ${codeHtml('/clone <chat> <min> <max>')} to clone a specific window.`,
      `${boldHtml('GOD live target:')} ${codeHtml('/clone personal')} / ${codeHtml('both')} routes into your personal brain (GOD rank).`,
      `/topic_link ${codeHtml('<community_id> [target]')} — clone this topic (inside it, or from DM: ${codeHtml('/clone <chat> <thread>')})`,
      `/topic_list · /topic_unlink ${codeHtml('<thread_id>')} · /topic_target ${codeHtml('<thread_id> <target>')}`,
      `  ${italicHtml('All topic commands work inside the group AND from DM by passing chat id.')}`,
      '',
       `${boldHtml('Setup history backfill is now one step:')} ${codeHtml('/clone')} ${italicHtml('inside the chat — or')} ${codeHtml('/clone <chat_id> [thread_id]')} ${italicHtml('from my DM. No manual api_id/session needed after')} ${codeHtml('/userbot_add')}${italicHtml('.')}`,
       `${boldHtml('Progress:')} ${codeHtml('/index_status')} · ${codeHtml('/index_stop')} ${italicHtml('to cancel.')}`,
       `${boldHtml('Old/manual:')} ${codeHtml('/index_start')} ${italicHtml('still works for one-off explicit sessions.')}`,
       `${boldHtml('⚠️ A session string grants full account access — revoke anytime in')} ${italicHtml('Telegram Settings → Devices → terminate session.')}`,
    ].join('\n');
  }
  return [
    `${boldHtml('Athena')} — ${italicHtml('second brain')}`,
    '',
    `${boldHtml('Tap a section below:')}`,
    `• ${boldHtml('🌐 Global')} — /start /help /id /rank`,
    `• ${boldHtml('👤 Personal')} — dual mode, dump, search, AI ${italicHtml('(GOD)')}`,
    `• ${boldHtml('👥 Community')} — verify, join, admins, topics`,
    `• ${boldHtml('📡 Channels')} — index channels + backfill history`,
    '',
    `${boldHtml('Member quick start:')}`,
    `1. Join the community Telegram group`,
    `2. Login on the website with Telegram`,
    `3. /community_join id — in bot DM`,
    `4. Paste links → /search query · /ai question`,
    `5. For Telegram export: /export (Bot API by default; session history is optional)`,
    '',
    `${italicHtml('Settings, AI keys and bot setup live on the website.')}`,
  ].join('\n');
}

function parseTelegramEditPayload(rest, replyMessage = null) {
  let payload = String(rest || '').trim();
  if (replyMessage) {
    const replyUrls = extractUrlsFromTelegramMessage(replyMessage);
    const replyText = (replyMessage.text || replyMessage.caption || '').trim();
    const replyTarget = replyUrls[0] || replyText.split(/\s+/).find(part => /^https?:\/\//i.test(part)) || '';
    if (replyTarget && /^\|/.test(payload)) payload = `${replyTarget} ${payload}`;
    else if (replyTarget && !payload.includes('|') && payload) payload = `${replyTarget} | ${payload}`;
  }
  if (!payload || !payload.includes('|')) return null;
  const pipe = payload.indexOf('|');
  const queryPart = payload.slice(0, pipe).trim();
  const editPart = payload.slice(pipe + 1).trim();
  if (!queryPart || !editPart) return null;

  let newTitle = null;
  let newNotes = null;
  if (/title\s*:/i.test(editPart) || /notes\s*:/i.test(editPart)) {
    const titleMatch = editPart.match(/title\s*:\s*([\s\S]*?)(?=\|\s*notes\s*:|$)/i);
    const notesMatch = editPart.match(/notes\s*:\s*([\s\S]*?)$/i);
    if (titleMatch) newTitle = titleMatch[1].replace(/\|\s*$/, '').trim();
    if (notesMatch) newNotes = notesMatch[1].trim();
    if (newTitle == null && newNotes == null) newNotes = editPart;
  } else {
    newNotes = editPart;
  }
  return { queryPart, newTitle, newNotes };
}

async function editTelegramMessage(token, chatId, messageId, text, replyMarkup, threadId = null, parseMode = 'HTML') {
  if (!token || !chatId || !messageId) return { ok: false };
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    // editMessageText is single-message only — prefer full text when short, else truncate cleanly
    text: (parseMode === 'HTML' ? chunkTelegramHtml(text) : chunkTelegramText(text, TG_MSG_MAX))[0] || String(text).slice(0, TG_MSG_MAX),
    disable_web_page_preview: true
  };
  if (parseMode) payload.parse_mode = parseMode;
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

  // ---- Telegram search pagination ----
  // Callback data contains only an opaque id; query, scope, and page are kept
  // server-side so users cannot edit the callback into another brain/query.
  if (data.startsWith('search:')) {
    await ensureTelegramSearchTable(env);
    const [, action, sessionId] = data.split(':');
    const session = sessionId
      ? await env.DB.prepare('SELECT * FROM telegram_search_sessions WHERE id = ? AND expires_at > ?').bind(sessionId, Date.now()).first()
      : null;
    if (!session || String(session.chat_id) !== String(chatId) || String(session.tg_user_id) !== String(tgUserId)) {
      await telegramApi(token, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Search expired or not yours', show_alert: true }).catch(() => {});
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    if (action === 'close') {
      await env.DB.prepare('DELETE FROM telegram_search_sessions WHERE id = ?').bind(session.id).run().catch(() => {});
      await telegramApi(token, 'answerCallbackQuery', { callback_query_id: cq.id });
      await editTelegramMessage(token, chatId, msgId, `${boldHtml('🔍 Search closed.')}`, null, threadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    const callbackUser = await resolveAthenaUserFromTg(env, tgUserId);
    if (session.scope === 'personal') {
      if (!isGodTgId(tgUserId, env) && !(callbackUser && await isInstanceOwnerUserAsync(callbackUser, env))) {
        await telegramApi(token, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Personal search is GOD-only', show_alert: true }).catch(() => {});
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
    } else if (callbackUser) {
      if (await isBannedFromCommunity(env, session.scope_key, callbackUser)) {
        await telegramApi(token, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'You are banned from this community', show_alert: true }).catch(() => {});
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
      const elevated = (await isElevatedUser(callbackUser, env)) || isInstanceOwnerTgId(tgUserId, env);
      if (!elevated && !(await ensureMember(session.scope_key, callbackUser.id, env))) {
        await telegramApi(token, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Join the community to continue searching', show_alert: true }).catch(() => {});
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
    }
    const currentPage = Number(session.page || 0);
    session.page = action === 'prev' ? Math.max(0, currentPage - 1) : currentPage + 1;
    await telegramApi(token, 'answerCallbackQuery', { callback_query_id: cq.id });
    const view = await getTelegramSearchPage(env, session);
    await editTelegramMessage(token, chatId, msgId, view.html, view.keyboard, threadId, 'HTML');
    await env.DB.prepare('UPDATE telegram_search_sessions SET page = ? WHERE id = ?').bind(view.page, session.id).run().catch(() => {});
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  // ---- Help menu buttons ----
  if (data.startsWith('help:')) {
    await telegramApi(token, 'answerCallbackQuery', { callback_query_id: cq.id });
    const section = data.slice(5); // menu | global | personal | community | channels
    if (section === 'menu') {
      await editTelegramMessage(token, chatId, msgId, helpTextForSection('menu'), helpMenuKeyboard(), threadId, 'HTML');
    } else if (section === 'global' || section === 'personal' || section === 'community' || section === 'channels') {
      await editTelegramMessage(token, chatId, msgId, helpTextForSection(section), helpBackKeyboard(), threadId, 'HTML');
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
    markMeiliScopeDirty(env, 'community', pend.community_id);
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

/**
 * Channel posts: index new links + documents in real time when the channel is
 * linked to a community via /channel_link. No user gates — the authorization
 * is the link itself (owner/GOD ran /channel_link, which verified server-side
 * that this bot is an admin of the channel). Bots cannot reply in channels,
 * so everything here is silent; failures go to the error console.
 */
async function indexChannelPost(msg, binding, token, env) {
  if (!binding?.community_id) return;
  // Anonymous source — commands typed in a channel are never executed.
  if (String(msg.text || '').trim().startsWith('/')) return;
  await ensureBotBindingColumns(env);

  // Rank-aware target: GOD chose where this channel lands.
  const target = CHANNEL_TARGETS.has(binding.channel_target) ? binding.channel_target : 'community';
  const personalOwner = target === 'community' ? null : String(binding.created_by || binding.user_id || '');
  const sinks = sinkTargetsFor(target, personalOwner);
  await capturePostIntoSinks(env, sinks, {
    msg, token,
    communityId: binding.community_id,
    personalOwner,
    channelTitle: msg.sender_chat?.title || msg.chat?.title || 'channel',
  });
}

/**
 * Where should a full-copy post land? GOD's chosen target resolved to sink
 * list. Falls back to community when a personal target has no linking user.
 */
function sinkTargetsFor(target, personalOwner) {
  const sinks = [];
  if (target === 'personal' && personalOwner) sinks.push('personal');
  else if (target === 'both' && personalOwner) sinks.push('personal', 'community');
  else sinks.push('community');
  return sinks;
}

/**
 * Full-copy one Telegram post into every sink: links, documents
 * (pdf/docx/epub/md/…), and text-only announcements as markdown. Used by
 * channels, forum topics, and copy-mode groups. Dedupe is per-sink.
 */
async function capturePostIntoSinks(env, sinks, ctx) {
  const { msg, token, communityId, personalOwner, channelTitle } = ctx;
  const text = String(msg.text || msg.caption || '').trim();
  const urls = [...new Set(extractUrlsFromTelegramMessage(msg, { includeReply: false }))];
  const doc = msg.document;

  for (const sink of sinks) {
    try {
      if (sink === 'personal') {
        if (!personalOwner) continue;
        if (doc && doc.file_id) {
          const filename = doc.file_name || 'document.txt';
          const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
          if ((DOCUMENT_EXTENSIONS.has(ext) || CONVERTIBLE_EXTENSIONS.has(ext)) && Number(doc.file_size || 0) <= CONVERT_SOURCE_MAX_BYTES) {
            const fileInfo = await telegramApi(token, 'getFile', { file_id: doc.file_id });
            if (fileInfo?.ok && fileInfo.result?.file_path) {
              const fileRes = await fetchWithTimeout(`${TG_API_BASE}/file/bot${token}/${fileInfo.result.file_path}`, { env, redirect: 'error', allowPrivate: true }, 60_000);
              if (fileRes.ok) {
                const r = await savePersonalIndexedDocument(env, personalOwner, filename, ext, new Uint8Array(await fileRes.arrayBuffer()), `channel:${msg.chat.id}`, { chatId: msg.chat.id, messageId: msg.message_id }, `live:${normalizeTgChatId(msg.chat.id)}`);
                if (r && r.error) console.warn(`post doc skipped (${channelTitle}, personal): ${r.error}`);
              }
            }
          }
        }
        const savedP = await savePersonalIndexedLinks(env, personalOwner, urls, channelTitle, text);
        if (savedP) console.log(`${channelTitle} → personal: indexed ${savedP} link(s)`);
        if (!savedP && !doc && text.length >= 80) {
          const dateStr = msg.date ? new Date(msg.date * 1000).toISOString().slice(0, 10) : '';
          const safeName = String(channelTitle).replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'chat';
          const md = `# ${channelTitle}${dateStr ? ` — ${dateStr}` : ''}\n\n${text}`;
          await savePersonalIndexedDocument(env, personalOwner, `${safeName}_${msg.message_id}.md`, 'md', new TextEncoder().encode(md), `channel:${msg.chat.id}`, { chatId: msg.chat.id, messageId: msg.message_id });
        }
        continue;
      }

      // community sink
      await ensureDocumentsTable(env);
      if (doc && doc.file_id) {
        try {
          const filename = doc.file_name || 'document.txt';
          const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
          if (DOCUMENT_EXTENSIONS.has(ext) || CONVERTIBLE_EXTENSIONS.has(ext)) {
            if (Number(doc.file_size || 0) > CONVERT_SOURCE_MAX_BYTES) {
              console.warn(`post doc skipped (${channelTitle}): exceeds ${CONVERT_SOURCE_MAX_BYTES} bytes`);
            } else {
              const fileInfo = await telegramApi(token, 'getFile', { file_id: doc.file_id });
              if (fileInfo?.ok && fileInfo.result?.file_path) {
                const fileRes = await fetchWithTimeout(`${TG_API_BASE}/file/bot${token}/${fileInfo.result.file_path}`, { env, redirect: 'error', allowPrivate: true }, 60_000);
                if (fileRes.ok) {
                  const r = await saveIndexedDocument(env, communityId, filename, ext, new Uint8Array(await fileRes.arrayBuffer()), `channel:${msg.chat.id}`, { chatId: msg.chat.id, messageId: msg.message_id });
                  if (r && r.error) console.warn(`post doc skipped (${channelTitle}): ${r.error}`);
                }
              }
            }
          }
        } catch (e) {
          console.error('post doc index failed', e?.message || e);
        }
      }

      const saved = await saveIndexedLinks(env, communityId, urls, channelTitle, text, 'channel');
      if (saved) console.log(`${channelTitle}: indexed ${saved} link(s)`);

      if (!saved && !doc && text.length >= 80) {
        try {
          const dateStr = msg.date ? new Date(msg.date * 1000).toISOString().slice(0, 10) : '';
          const safeName = String(channelTitle).replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'chat';
          const filename = `${safeName}_${msg.message_id}.md`;
          const md = `# ${channelTitle}${dateStr ? ` — ${dateStr}` : ''}\n\n${text}`;
          await saveIndexedDocument(env, communityId, filename, 'md', new TextEncoder().encode(md), `channel:${msg.chat.id}`, { chatId: msg.chat.id, messageId: msg.message_id });
        } catch (e) {
          console.error('post text index failed', e?.message || e);
        }
      }
    } catch (e) {
      console.error(`capture failed (${sink})`, e?.message || e);
    }
  }
}

// ---- Forum-topic bindings: clone specific topics, rank-aware targets ----
async function ensureTopicBindingTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS telegram_topic_bindings (
       id TEXT PRIMARY KEY,
       chat_id TEXT NOT NULL,
       thread_id TEXT NOT NULL,
       community_id TEXT NOT NULL,
       target TEXT NOT NULL DEFAULT 'community',
       created_by TEXT,
       created_at BIGINT NOT NULL
     )`
  ).run();
  await env.DB.prepare(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_topic_bind_chat_thread ON telegram_topic_bindings(chat_id, thread_id)'
  ).run().catch(() => {});
}

/** Shared by channel indexing and history backfill. Returns {error?} or {saved} or null on skip. */
async function saveIndexedDocument(env, communityId, filename, ext, bytes, uploadedBy, sourceMessage = null, transferId = null) {
  if (!DOCUMENT_EXTENSIONS.has(ext) && !CONVERTIBLE_EXTENSIONS.has(ext)) return null;
  if (!bytes || bytes.length > CONVERT_SOURCE_MAX_BYTES) return { error: 'document exceeds 20 MiB' };
  await ensureDocumentsTable(env);
  if (sourceMessage?.chatId != null && sourceMessage?.messageId != null) {
    const duplicate = await env.DB.prepare(
      `SELECT id FROM uploaded_documents
       WHERE scope = 'community' AND community_id = ? AND source_chat_id = ? AND source_message_id = ? LIMIT 1`
    ).bind(communityId, String(sourceMessage.chatId), String(sourceMessage.messageId)).first().catch(() => null);
    if (duplicate) return { duplicate: true, id: duplicate.id };
  }
  let valid;
  if (CONVERTIBLE_EXTENSIONS.has(ext)) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const converted = await convertDocumentToMarkdown(env, ext, btoa(bin));
    valid = converted.error ? { error: converted.error } : validateDocumentText('community', filename, converted.markdown);
  } else {
    valid = validateDocumentInput({ scope: 'community', filename, content: new TextDecoder().decode(bytes) });
  }
  if (valid?.error) return valid;
  if (!valid || !valid.content) return null;
  const id = 'doc_ix_' + Date.now().toString(36) + '_' + randomToken().slice(0, 4);
  try {
    await env.DB.prepare(
      `INSERT INTO uploaded_documents
       (id, scope, community_id, filename, content, uploaded_by, created_at, source_chat_id, source_message_id)
       VALUES (?, 'community', ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, communityId, valid.filename, valid.content, uploadedBy, Date.now(),
      sourceMessage?.chatId == null ? null : String(sourceMessage.chatId),
      sourceMessage?.messageId == null ? null : String(sourceMessage.messageId)).run();
  } catch (error) {
    if (!/source_chat_id|source_message_id|column .* does not exist/i.test(String(error?.message || error))) throw error;
    await env.DB.prepare(
      `INSERT INTO uploaded_documents (id, scope, community_id, filename, content, uploaded_by, created_at)
       VALUES (?, 'community', ?, ?, ?, ?, ?)`
    ).bind(id, communityId, valid.filename, valid.content, uploadedBy, Date.now()).run();
  }
  if (transferId) {
    await ensureTransferColumns(env);
    await env.DB.prepare('UPDATE uploaded_documents SET transfer_id = ? WHERE id = ?').bind(transferId, id).run().catch(() => {});
  }
  markMeiliScopeDirty(env, 'community', communityId);
  return { saved: id };
}

/** Personal-brain variants of the channel indexers — target = personal|both. */
async function savePersonalIndexedLinks(env, ownerUserId, urls, attributionName, postText, transferId = null) {
  const baseTags = ['telegram', 'channel'];
  let saved = 0;
  for (const rawUrl of urls) {
    try {
      if (await findExistingLink(env, 'personal_links', 'user_id', ownerUserId, rawUrl)) continue;
      const meta = await enrichLinkFields(env, rawUrl, { title: '', notes: postText || '' });
      const urlHash = generateUrlHash(rawUrl);
      const id = 'ixp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      await ensureLinkMetaColumns(env);
      await env.DB.prepare(
        `INSERT INTO personal_links (id, user_id, url, url_hash, title, notes, tags, created_at, image_url, site_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, ownerUserId, rawUrl, urlHash, meta.title, meta.notes || '',
        JSON.stringify(baseTags), Date.now(), meta.image_url || null, meta.site_name || null).run();
      saved++;
      if (transferId) {
        await ensureTransferColumns(env);
        await env.DB.prepare('UPDATE personal_links SET transfer_id = ? WHERE id = ?').bind(transferId, id).run().catch(() => {});
      }
      markMeiliScopeDirty(env, 'personal', ownerUserId);
    } catch (e) {
      if (!isUniqueConstraintError(e)) console.error(`personal indexed link failed (${rawUrl})`, e?.message || e);
    }
  }
  return saved;
}

async function savePersonalIndexedDocument(env, ownerUserId, filename, ext, bytes, uploadedBy, sourceMessage = null, transferId = null) {
  if (!DOCUMENT_EXTENSIONS.has(ext) && !CONVERTIBLE_EXTENSIONS.has(ext)) return null;
  if (!bytes || bytes.length > CONVERT_SOURCE_MAX_BYTES) return { error: 'document exceeds 20 MiB' };
  await ensureDocumentsTable(env);
  if (sourceMessage?.chatId != null && sourceMessage?.messageId != null) {
    const duplicate = await env.DB.prepare(
      `SELECT id FROM uploaded_documents
       WHERE scope = 'personal' AND user_id = ? AND source_chat_id = ? AND source_message_id = ? LIMIT 1`
    ).bind(ownerUserId, String(sourceMessage.chatId), String(sourceMessage.messageId)).first().catch(() => null);
    if (duplicate) return { duplicate: true, id: duplicate.id };
  }
  let valid;
  if (CONVERTIBLE_EXTENSIONS.has(ext)) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const converted = await convertDocumentToMarkdown(env, ext, btoa(bin));
    valid = converted.error ? { error: converted.error } : validateDocumentInput({ scope: 'personal', filename, content: converted.markdown });
  } else {
    valid = validateDocumentInput({ scope: 'personal', filename, content: new TextDecoder().decode(bytes) });
  }
  if (valid?.error) return valid;
  if (!valid || !valid.content) return null;
  const id = 'doc_ixp_' + Date.now().toString(36) + '_' + randomToken().slice(0, 4);
  await env.DB.prepare(
    `INSERT INTO uploaded_documents
     (id, scope, user_id, filename, content, uploaded_by, created_at, source_chat_id, source_message_id)
     VALUES (?, 'personal', ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, ownerUserId, valid.filename, valid.content, uploadedBy, Date.now(),
    sourceMessage?.chatId == null ? null : String(sourceMessage.chatId),
    sourceMessage?.messageId == null ? null : String(sourceMessage.messageId)).run();
  if (transferId) {
    await ensureTransferColumns(env);
    await env.DB.prepare('UPDATE uploaded_documents SET transfer_id = ? WHERE id = ?').bind(transferId, id).run().catch(() => {});
  }
  markMeiliScopeDirty(env, 'personal', ownerUserId);
  return { saved: id };
}

/** Shared insert path for indexed links (channel posts + history backfill). */
async function saveIndexedLinks(env, communityId, urls, attributionName, postText, source /* 'channel'|'backfill' */, transferId = null) {
  const baseTags = ['telegram', source === 'backfill' ? 'backfill' : 'channel'];
  let saved = 0;
  for (const rawUrl of urls) {
    try {
      if (await findExistingLink(env, 'links', 'community_id', communityId, rawUrl)) continue;
      const meta = await enrichLinkFields(env, rawUrl, { title: '', notes: postText || '' });
      const urlHash = generateUrlHash(rawUrl);
      const id = 'ix_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      await ensureLinkMetaColumns(env);
      try {
        await env.DB.prepare(
          `INSERT INTO links (id, community_id, url, url_hash, title, notes, tags, added_by,
            added_by_user_id, added_by_provider, added_by_name, upvotes, downvotes, created_at, image_url, site_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'telegram', ?, 0, 0, ?, ?, ?)`
        ).bind(
          id, communityId, rawUrl, urlHash, meta.title, meta.notes || '',
          JSON.stringify(baseTags), attributionName, attributionName,
          Date.now(), meta.image_url || null, meta.site_name || null
        ).run();
      } catch (error) {
        if (isUniqueConstraintError(error)) continue;
        if (!isMissingLinkMetaColumnError(error)) throw error;
        await env.DB.prepare(
          'INSERT INTO links (id, community_id, url, url_hash, title, notes, tags, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(id, communityId, rawUrl, urlHash, meta.title, meta.notes || '', JSON.stringify(baseTags), attributionName, Date.now()).run();
      }
      saved++;
      if (transferId) {
        await ensureTransferColumns(env);
        await env.DB.prepare('UPDATE links SET transfer_id = ? WHERE id = ?').bind(transferId, id).run().catch(() => {});
      }
      // tagging: post #hashtags win, else AI describe (same as group dumps)
      const userTags = normalizeTagList(extractHashtags(postText || ''));
      let finalTags = null;
      let finalTitle = meta.title;
      let finalNotes = meta.notes || '';
      if (userTags.length) {
        finalTags = [...new Set([...baseTags, ...userTags])];
      } else {
        const vocab = await recentTagsForScope(env, 'community', communityId);
        let ai = null;
        try { ai = await aiDescribeAndTag(env, rawUrl, meta, vocab); } catch (_) {}
        if (ai) {
          finalTitle = ai.title || meta.title;
          finalNotes = ai.description || meta.notes || '';
          finalTags = ai.tags?.length ? [...new Set([...baseTags, ...ai.tags])] : baseTags;
        } else {
          // AI down → context tags from caption/URL so clones are never tagless
          const fb = fallbackTagsFromMeta(rawUrl, { title: meta.title, notes: meta.notes || postText, content: '' });
          finalTags = [...new Set([...baseTags, ...(fb || [])])];
        }
      }
      if (finalTags) {
        await ensureSearchColumns(env);
        await env.DB.prepare(`UPDATE links SET title = ?, tags = ?, notes = ?, metadata_version = ${AI_METADATA_VERSION}, search_blob = NULL WHERE id = ?`)
          .bind(finalTitle, JSON.stringify(finalTags), finalNotes, id).run().catch(() => {});
      }
    } catch (e) {
      console.error(`indexed link save failed (${rawUrl})`, e?.message || e);
    }
  }
  markMeiliScopeDirty(env, 'community', communityId);
  return saved;
}

// ---- History backfill via a user session string (gramjs, self-host only) ----

async function ensureIndexTables(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS telegram_index_sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, community_id TEXT NOT NULL,
      chat_id TEXT NOT NULL, api_id TEXT, api_hash_enc TEXT, session_enc TEXT NOT NULL,
      created_at INTEGER NOT NULL)`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS index_jobs (
      id TEXT PRIMARY KEY, community_id TEXT NOT NULL, chat_id TEXT NOT NULL, user_id TEXT NOT NULL,
      status TEXT NOT NULL, offset_id INTEGER NOT NULL DEFAULT 0,
      processed INTEGER NOT NULL DEFAULT 0, saved_links INTEGER NOT NULL DEFAULT 0,
      saved_docs INTEGER NOT NULL DEFAULT 0, progress_chat_id TEXT,
      error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`
  ).run();
}

const INDEX_BATCH = 100;
const INDEX_BATCH_DELAY_MS = 1500; // ~40 req/min ceiling — well under Telegram's flood limits
const INDEX_MAX_MESSAGES = 50000;
const INDEX_AUTO_CONTINUATIONS = 20; // big channels finish across chunked runs

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Media vault: store original files on the VPS (self-host only) when
 * ATHENA_MEDIA_DIR is set. Everything is kept — photos, videos, audio,
 * archives, apk — independent of what gets indexed into the brain.
 */
const MEDIA_VAULT_DIR = String(process.env?.ATHENA_MEDIA_DIR || '').trim();
async function vaultSave(chatId, messageId, filename, bytes) {
  if (!MEDIA_VAULT_DIR || !bytes?.length) return false;
  try {
    const fsSpec = 'node:fs/promises';
    const { mkdir, writeFile } = await import(fsSpec);
    const safeName = String(filename || `file_${messageId}`).replace(/[^\w.-]+/g, '_').slice(0, 120);
    const dir = `${MEDIA_VAULT_DIR}/${String(chatId).replace(/[^\w-]+/g, '_')}`;
    await mkdir(dir, { recursive: true });
    await writeFile(`${dir}/${messageId}_${safeName}`, bytes);
    return true;
  } catch (e) {
    console.error('[vault] save failed', e?.message || e);
    return false;
  }
}

/** Classify gramjs media for skip/vault decisions. */
function classifyGramjsMedia(docu) {
  const attrs = docu?.attributes || [];
  const fnameAttr = attrs.find((a) => a.className === 'MessageAttributeFilename');
  const filename = fnameAttr?.fileName || '';
  const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
  const mime = String(docu?.mimeType || '');
  const isVideo = attrs.some((a) => a.className === 'MessageAttributeVideo') || mime.startsWith('video/');
  const isAudio = attrs.some((a) => a.className === 'MessageAttributeAudio') || mime.startsWith('audio/');
  const isPhoto = mime === 'image/jpeg' && !filename; // Telegram photos are jpegs w/o name
  const kind = isVideo ? 'video' : isAudio ? 'audio' : isPhoto ? 'photo' : 'document';
  return { filename, ext, kind };
}

/** URLs from a gramjs message: link entities + plain-text regex. */
function urlsFromGramjsMessage(message) {
  const out = new Set();
  const text = String(message.text || message.message || '');
  try {
    for (const e of message.entities || []) {
      if (e?.className === 'MessageEntityTextUrl' && e.url) out.add(e.url);
    }
  } catch (_) {}
  // Inline / URL buttons under the post
  try {
    const rm = message.replyMarkup;
    const rows = rm?.rows || [];
    for (const row of rows) {
      for (const b of row?.buttons || []) {
        if (b?.className === 'KeyboardButtonUrl' && b.url) out.add(String(b.url));
      }
    }
  } catch (_) {}
  for (const m of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) out.add(m[0]);
  return [...out];
}

/**
 * Backfill one chat's history into a community using the stored user session.
 * Pacing: INDEX_BATCH_DELAY_MS between getHistory pages plus per-media gaps;
 * FloodWaitError sleeps the exact server-announced time (capped at 5 min).
 * The cursor (offset_id) persists in index_jobs, so a stopped job resumes.
 */
/**
 * Create + launch a backfill job using the connected userbot session
 * (userbot_state). One place for both /backfill (in-chat) and /index_start.
 */
async function startBackfillJob(env, { token, chatId, forumThreadId, athenaUser, communityIdArg, chatIdArg, threadArg = '', communityName = '', userbotLabel = '', minId = '', maxId = '' }) {
  await ensureUserbotTables(env);
  await ensureIndexTables(env);
  // Normalize bare channel ids (Telegram web apps often show them without -100)
  let cid = String(chatIdArg || '').trim();
  if (/^\d{9,}$/.test(cid)) cid = `-100${cid}`;
  // One active backfill per chat — a second /index_start would double-index
  const active = await env.DB.prepare(
    "SELECT id FROM index_jobs WHERE chat_id = ? AND status IN ('queued','running')"
  ).bind(cid).first();
  if (active) {
    await sendTelegramFormatted(token, chatId,
      `${boldHtml('⏳')} A backfill for ${codeHtml(cid)} is already running. Progress: ${codeHtml('/index_status')} · cancel: ${codeHtml('/index_stop')}`,
      forumThreadId).catch(() => {});
    return { ok: false, reason: 'already running', jobId: active.id };
  }
  try { await env.DB.prepare('ALTER TABLE index_jobs ADD COLUMN thread_id TEXT').run(); } catch (e) { if (!/exists/i.test(String(e?.message))) console.error('[backfill] thread_id alter:', e?.message); }
  try { await env.DB.prepare('ALTER TABLE index_jobs ADD COLUMN progress_msg_id BIGINT').run(); } catch (e) { if (!/exists/i.test(String(e?.message))) console.error('[backfill] progress_msg_id alter:', e?.message); }
  try { await env.DB.prepare('ALTER TABLE index_jobs ADD COLUMN min_id BIGINT').run(); } catch (e) { if (!/exists/i.test(String(e?.message))) console.error('[backfill] min_id alter:', e?.message); }
  try { await env.DB.prepare('ALTER TABLE index_jobs ADD COLUMN max_id BIGINT').run(); } catch (e) { if (!/exists/i.test(String(e?.message))) console.error('[backfill] max_id alter:', e?.message); }
  try { await env.DB.prepare('ALTER TABLE index_jobs ADD COLUMN saved_files INTEGER DEFAULT 0').run(); } catch (e) { if (!/exists/i.test(String(e?.message))) console.error('[backfill] saved_files alter:', e?.message); }
  try { await env.DB.prepare('ALTER TABLE index_jobs ADD COLUMN skipped_media INTEGER DEFAULT 0').run(); } catch (e) { if (!/exists/i.test(String(e?.message))) console.error('[backfill] skipped_media alter:', e?.message); }
  try { await env.DB.prepare('ALTER TABLE index_jobs ADD COLUMN urls_seen INTEGER DEFAULT 0').run(); } catch (e) { if (!/exists/i.test(String(e?.message))) console.error('[backfill] urls_seen alter:', e?.message); }
  try { await env.DB.prepare('ALTER TABLE index_jobs ADD COLUMN continuations INTEGER DEFAULT 0').run(); } catch (e) { if (!/exists/i.test(String(e?.message))) console.error('[backfill] continuations alter:', e?.message); }
  const jobId = 'ij_' + Date.now().toString(36) + '_' + randomToken().slice(0, 6);
  await env.DB.prepare(
      `INSERT INTO index_jobs (id, community_id, chat_id, user_id, status, offset_id, progress_chat_id, created_at, updated_at, thread_id, min_id, max_id)
       VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?)`
    ).bind(jobId, communityIdArg, cid, athenaUser.id, chatId, Date.now(), Date.now(), threadArg || null, minId ? Number(minId) : null, maxId ? Number(maxId) : null).run();
  runInBackground(env, runHistoryIndexJob(env, { id: jobId, community_id: communityIdArg, chat_id: cid, thread_id: threadArg || null, userbot_label: userbotLabel || null, min_id: minId ? Number(minId) : null, max_id: maxId ? Number(maxId) : null, saved_files: 0, skipped_media: 0, offset_id: 0, processed: 0, saved_links: 0, saved_docs: 0, progress_chat_id: chatId }, token));
  await sendTelegramFormatted(token, chatId,
    `${boldHtml('▶️')} Backfill started for ${codeHtml(chatIdArg)}${threadArg ? ` topic ${codeHtml('#' + threadArg)}` : ''} → ${boldHtml(escHtml(communityName || communityIdArg))}.\n${italicHtml('Live progress below ·')} ${codeHtml('/index_stop')} ${italicHtml('to cancel.')}`,
    forumThreadId).catch(() => {});
  return { ok: true, jobId };
}

async function runHistoryIndexJob(env, job, token) {
  const log = (...a) => console.log(`[index ${job.id}]`, ...a);
  const patch = async (fields) => {
    const keys = Object.keys(fields);
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    await env.DB.prepare(`UPDATE index_jobs SET ${sets}, updated_at = ? WHERE id = ?`)
      .bind(...keys.map((k) => fields[k]), Date.now(), job.id).run().catch(() => {});
  };
  // Live progress: edit one message with a bar instead of spamming new ones.
  let progressMsgId = null;
  let lastProgressAt = 0;
  const renderBar = (done, total) => {
    // Message ids are not sequential (deleted/legacy gaps), so the "total"
    // (latest id) is approximate. When done exceeds it, show done as truth.
    const denom = Math.max(done, total || 0);
    const pct = denom ? Math.min(100, Math.round((done / denom) * 100)) : 0;
    const filled = Math.round((pct / 100) * 18);
    const bar = '▮'.repeat(filled) + '▯'.repeat(18 - filled);
    const parts = [`${bar} ${pct}%`, `${done}${total && total >= done ? `/${total}` : ''} msgs`];
    if (job.saved_links) parts.push(`${job.saved_links} links`);
    if (job.saved_docs) parts.push(`${job.saved_docs} docs`);
    if (job.saved_files) parts.push(`${job.saved_files} files`);
    if (job.urls_seen) parts.push(`${job.urls_seen} urls found`);
    if (job.skipped_media) parts.push(`${job.skipped_media} media skipped`);
    return parts.join(' · ');
  };
  const pushProgress = async (force = false, done = 0) => {
    const now = Date.now();
    if (!force && now - lastProgressAt < 10_000) return;
    lastProgressAt = now;
    try {
      const text = `${boldHtml('🗂 Backfill')} ${job.thread_id ? codeHtml('#' + job.thread_id) : codeHtml(job.chat_id)}\n${codeHtml(renderBar(done, job.total_messages || 0))}\n${italicHtml('/index_stop to cancel')}`;
      if (progressMsgId) {
        await telegramApi(token, 'editMessageText', { chat_id: job.progress_chat_id, message_id: progressMsgId, text, parse_mode: 'HTML' }).catch(() => {});
      } else {
        const m = await sendTelegramFormatted(token, job.progress_chat_id, text, null);
        progressMsgId = m?.message_id || null;
        if (progressMsgId) await env.DB.prepare('UPDATE index_jobs SET progress_msg_id = ? WHERE id = ?').bind(progressMsgId, job.id).run().catch(() => {});
      }
    } catch (_) {}
  };
  try {
    // Session comes from the named userbot account (job.userbot_label),
    // or the first enabled one. One connect powers live cloning AND backfills.
    await ensureUserbotTables(env);
    let sess = null;
    if (job.userbot_label) sess = await env.DB.prepare('SELECT * FROM userbot_accounts WHERE label = ? AND enabled = 1').bind(job.userbot_label).first().catch(() => null);
    if (!sess) sess = await env.DB.prepare('SELECT * FROM userbot_accounts WHERE enabled = 1 ORDER BY label LIMIT 1').first();
    if (!sess) {
      await patch({ status: 'error', error: 'no userbot session — /userbot_add first' });
      await sendTelegramFormatted(token, job.progress_chat_id, `${boldHtml('❌')} No connected session. Run ${codeHtml('/userbot_add')} once, then retry.`).catch(() => {});
      return;
    }
    const _ubLabel = sess.label;
    let gramjs;
    try {
      // Non-literal specifier: bundlers must never try to resolve the native
      // gramjs package — it is an optional, self-host-only dependency.
      const spec = 'telegram';
      gramjs = await import(spec);
    } catch (_) {
      await patch({ status: 'error', error: 'gramjs not installed (npm install telegram)' });
      await sendTelegramFormatted(token, job.progress_chat_id, `${boldHtml('❌')} History backfill needs the optional package. On the server: ${codeHtml('npm install telegram')}, then ${codeHtml('/index_start')} again.`).catch(() => {});
      return;
    }
    const { TelegramClient } = gramjs;
    const { StringSession } = gramjs.sessions;
    const sessionString = await decryptBotToken(env, sess.session_enc);
    const apiHash = await decryptBotToken(env, sess.api_hash_enc);
    if (!sessionString || !apiHash) { await patch({ status: 'error', error: 'session decrypt failed (STORAGE_KEY rotated?)' }); return; }
    const client = new TelegramClient(new StringSession(sessionString), Number(sess.api_id) || 0, apiHash, { connectionRetries: 3 });
    await client.connect();
    let offsetId = job.offset_id || 0;
    let processed = job.processed || 0;
    job.saved_files = Number(job.saved_files || 0);
    job.skipped_media = Number(job.skipped_media || 0);
    job.urls_seen = Number(job.urls_seen || 0);
    // Approximate total for the progress bar: latest message id in the chat.
    try {
      const head = await client.getMessages(job.chat_id, { limit: 1 });
      job.total_messages = Number(head?.[0]?.id || 0) || null;
    } catch (_) { job.total_messages = null; }
    await pushProgress(true, processed);
    let savedLinks = job.saved_links || 0;
    let savedDocs = job.saved_docs || 0;
    let lastProgress = 0;
    await patch({ status: 'running', error: null });
    log(`start chat=${job.chat_id} offset=${offsetId}`);
    while (processed < INDEX_MAX_MESSAGES) {
      const row = await env.DB.prepare('SELECT status FROM index_jobs WHERE id = ?').bind(job.id).first();
      if (!row || row.status === 'stopping') { await patch({ status: 'stopped' }); log('stopped'); break; }
      let messages;
      try {
        messages = await client.getMessages(job.chat_id, {
          limit: INDEX_BATCH,
          offsetId,
          ...(job.thread_id ? { replyTo: Number(job.thread_id) } : {})
        });
      } catch (e) {
        if (e && typeof e.seconds === 'number') { // FloodWaitError
          log(`flood-wait ${e.seconds}s — sleeping`);
          await patch({ error: `flood-wait ${e.seconds}s` });
          await sleep(Math.min(e.seconds * 1000, 300_000));
          continue;
        }
        if (/input entity/i.test(String(e?.message))) {
          log('entity cache cold — priming once, then retrying');
          const ok = await primeEntity(client, job.chat_id, 60_000);
          if (!ok) {
            e.message = `The session account cannot see ${job.chat_id}. Join this channel/group with that account, then retry.`;
            throw e;
          }
          messages = await client.getMessages(job.chat_id, {
            limit: INDEX_BATCH,
            offsetId,
            ...(job.thread_id ? { replyTo: Number(job.thread_id) } : {})
          });
        } else { throw e; }
      }
      if (!messages || !messages.length) { await patch({ status: 'done' }); log('done (end of history)'); break; }
      if (job.min_id && offsetId && offsetId < Number(job.min_id)) { await patch({ status: 'done' }); log('done (reached min_id)'); break; }
      for (const message of messages) {
        offsetId = Math.max(offsetId, Number(message.id || 0));
        // Explicit id range (/clone <chat> <min> <max>): skip outside it.
        if (job.max_id && Number(message.id || 0) > Number(job.max_id)) continue;
        processed++;
        const text = String(message.text || message.message || '');
        if (text.startsWith('/')) continue;
        const urls = urlsFromGramjsMessage(message);
        if (urls.length) {
          job.urls_seen = (job.urls_seen || 0) + urls.length;
          // Fast path: insert now with caption-as-notes, then let the shared
          // background enrichment do scrape + AI/context tags. Sequential
          // per-URL scraping here made backfills crawl for hours.
          await ensureTransferColumns(env);
          const fresh = [];
          for (const rawUrl of [...new Set(urls)]) {
            try {
              if (await findExistingLink(env, 'links', 'community_id', job.community_id, rawUrl)) continue;
              const urlHash = generateUrlHash(rawUrl);
              const id = 'ix_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
              await ensureLinkMetaColumns(env);
              const capTitle = titleFromUrl(rawUrl);
              try {
                await env.DB.prepare(
                  `INSERT INTO links (id, community_id, url, url_hash, title, notes, tags, added_by,
                    added_by_user_id, added_by_provider, added_by_name, upvotes, downvotes, created_at, image_url, site_name)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'telegram', ?, 0, 0, ?, NULL, NULL)`
                ).bind(id, job.community_id, rawUrl, urlHash, capTitle, (text || '').slice(0, 3000),
                  JSON.stringify(['telegram', 'backfill']), 'history backfill', 'history backfill',
                  Date.now()).run();
                savedLinks++; fresh.push({ id, url: rawUrl });
              } catch (error) {
                if (isUniqueConstraintError(error)) continue;
                if (!isMissingLinkMetaColumnError(error)) throw error;
                await env.DB.prepare(
                  'INSERT INTO links (id, community_id, url, url_hash, title, notes, tags, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
                ).bind(id, job.community_id, rawUrl, urlHash, capTitle, (text || '').slice(0, 3000),
                  JSON.stringify(['telegram', 'backfill']), 'history backfill', Date.now()).run();
                savedLinks++; fresh.push({ id, url: rawUrl });
              }
            } catch (e) {
              console.error(`[index] link insert failed (${rawUrl})`, e?.message || e);
            }
          }
          if (fresh.length) {
            markMeiliScopeDirty(env, 'community', job.community_id);
            runInBackground(env, enrichLinksInBackground(env, 'community', job.community_id, fresh));
          }
        }
        // Media vault: keep the ORIGINAL file on the VPS for every media type
        // (photos/videos/audio/archives/apk included), independent of indexing.
        const mediaAny = message.media;
        if (MEDIA_VAULT_DIR && mediaAny && mediaAny.className === 'MessageMediaDocument' && mediaAny.document) {
          try {
            const cls = classifyGramjsMedia(mediaAny.document);
            if (Number(mediaAny.document.size || 0) <= 2 * 1024 * 1024 * 1024) {
              const buf = await client.downloadMedia(message, {});
              if (buf?.length && await vaultSave(job.chat_id, message.id, cls.filename || `media_${message.id}`, new Uint8Array(buf))) {
                job.saved_files = (job.saved_files || 0) + 1;
              }
              await sleep(300);
            }
          } catch (e) {
            if (e && typeof e.seconds === 'number') await sleep(Math.min(e.seconds * 1000, 300_000));
            else console.error('[vault] media failed', e?.message || e);
          }
        }
        // Count non-indexable media so the user sees why docs can be 0.
        if (mediaAny && mediaAny.className === 'MessageMediaDocument' && mediaAny.document) {
          const cls0 = classifyGramjsMedia(mediaAny.document);
          const idxable = DOCUMENT_EXTENSIONS.has(cls0.ext) || CONVERTIBLE_EXTENSIONS.has(cls0.ext);
          if (!idxable) job.skipped_media = (job.skipped_media || 0) + 1;
        } else if (message.media && ['MessageMediaPhoto'].includes(message.media.className)) {
          job.skipped_media = (job.skipped_media || 0) + 1;
        }
        // Full-history copy: substantial text-only posts become documents too.
        if (!urls.length && text.length >= 80) {
          try {
            const safeName = String(job.chat_id).replace(/[^\w-]+/g, '_').slice(0, 40);
            const filename = `${safeName}_${message.id}.md`;
            const when = message.date ? new Date(message.date * 1000).toISOString().slice(0, 10) : '';
            const md = `# History backfill${when ? ` — ${when}` : ''}\n\n${text}`;
            const r = await saveIndexedDocument(env, job.community_id, filename, 'md', new TextEncoder().encode(md), `backfill:${job.chat_id}`, { chatId: job.chat_id, messageId: message.id }, job.id);
            if (r?.saved) savedDocs++;
          } catch (e) {
            console.error('[index] text post failed', e?.message || e);
          }
        }
        const media = message.media;
        if (media && media.className === 'MessageMediaDocument' && media.document) {
          const docu = media.document;
          const fnameAttr = (docu.attributes || []).find((a) => a.className === 'MessageAttributeFilename');
          const filename = fnameAttr?.fileName || '';
          const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
          // Positive allowlist: video/audio/archives (mkv, mp4, mp3, zip, …)
          // never match DOCUMENT_EXTENSIONS/CONVERTIBLE_EXTENSIONS.
          if (filename && (DOCUMENT_EXTENSIONS.has(ext) || CONVERTIBLE_EXTENSIONS.has(ext)) && Number(docu.size || 0) <= CONVERT_SOURCE_MAX_BYTES) {
            try {
              const buf = await client.downloadMedia(message, {});
              if (buf && buf.length) {
                const r = await saveIndexedDocument(env, job.community_id, filename, ext, new Uint8Array(buf), `backfill:${job.chat_id}`, { chatId: job.chat_id, messageId: message.id }, job.id);
                if (r?.saved) savedDocs++;
              }
              await sleep(400);
            } catch (e) {
              if (e && typeof e.seconds === 'number') { await sleep(Math.min(e.seconds * 1000, 300_000)); }
              else console.error('[index] media failed', e?.message || e);
            }
          }
        }
      }
      await patch({ offset_id: offsetId, processed, saved_links: savedLinks, saved_docs: savedDocs, saved_files: job.saved_files || 0, skipped_media: job.skipped_media || 0, urls_seen: job.urls_seen || 0 });
      log(`batch done · total ${processed} · +${messages.length} · urls ${job.urls_seen || 0}`);
      if (processed - lastProgress >= 50) lastProgress = processed;
      await pushProgress(false, processed);
      await sleep(INDEX_BATCH_DELAY_MS);
    }
    if (processed >= INDEX_MAX_MESSAGES) {
      const conts = Number(job.continuations || 0);
      if (conts < INDEX_AUTO_CONTINUATIONS) {
        await patch({ status: 'queued', continuations: conts + 1 });
        log(`cap reached — auto-continuing (chunk ${conts + 2})`);
        runInBackground(env, runHistoryIndexJob(env, { ...job, status: 'queued' }, token));
      } else {
        await patch({ status: 'error', error: `stopped after ${conts + 1} chunks (${processed} msgs) — /index_start resumes`.slice(0, 300) });
      }
      await sendTelegramFormatted(token, job.progress_chat_id, `${boldHtml('🧩')} Chunk complete: ${processed} msgs · continuing automatically…`).catch(() => {});
      try { await client.disconnect(); } catch (_) {}
      return;
    }
    const finalRow = await env.DB.prepare('SELECT status, saved_links, saved_docs FROM index_jobs WHERE id = ?').bind(job.id).first();
    const doneText = `${finalRow?.status === 'done' ? '✅' : '⏸'} Backfill ${finalRow?.status || 'done'}: ${processed} scanned · ${savedLinks} links · ${savedDocs} docs saved.`;
    if (progressMsgId) {
      await telegramApi(token, 'editMessageText', { chat_id: job.progress_chat_id, message_id: progressMsgId, text: doneText, parse_mode: 'HTML' }).catch(() =>
        sendTelegramFormatted(token, job.progress_chat_id, doneText).catch(() => {}));
    } else {
      await sendTelegramFormatted(token, job.progress_chat_id, doneText).catch(() => {});
    }
    // Session auto-delete when the job finishes cleanly — a stored user
    // session is a live account key; it should not outlive its purpose.
    if (finalRow?.status === 'done') {
      await env.DB.prepare('DELETE FROM telegram_index_sessions WHERE id = ?').bind(job.id).run().catch(() => {});
    }
    try { await client.disconnect(); } catch (_) {}
  } catch (e) {
    console.error('[index] job failed', e?.message || e);
    await userbotLogError(env, job.chat_id, e);
    await patch({ status: 'error', error: String(e?.message || e).slice(0, 300) });
    await sendTelegramFormatted(token, job.progress_chat_id, `${boldHtml('❌')} Backfill failed: ${escHtml(String(e?.message || e).slice(0, 200))}`).catch(() => {});
  }
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
  // Channel posts have no sender identity: real-time indexing only, and only
  // for channels linked to a community via /channel_link. Bots cannot reply
  // in channels, so this path is silent by necessity.
  if (String(msg.chat?.type || '') === 'channel') {
    // A Kage/static scrape or a Telegram file download can exceed Telegram's
    // webhook response window. ACK first; the adapter's waitUntil keeps this
    // work alive on Cloudflare and the Node shim handles it in the background.
    runInBackground(env, indexChannelPost(msg, binding, token, env));
    return new Response('OK', { status: 200, headers: corsHeaders });
  }
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

  // ---- Full-copy indexing for forum topics & copy-mode groups ----
  // A linked topic (telegram_topic_bindings) or a group with copy_text=1 gets
  // the channel treatment: links, documents, and text-only posts, routed by
  // the GOD-chosen target. Runs in background; the normal dump path below is
  // untouched (DB-level dedupe prevents double saves).
  const isGroupChat0 = String(msg.chat?.type || '').includes('group') || chatId.startsWith('-');
  if (isGroupChat0 && !(String(msg.text || msg.caption || '').trim().startsWith('/'))) {
    try {
      await ensureBotBindingColumns(env);
      await ensureTopicBindingTable(env);
      const threadId0 = msg.message_thread_id != null ? String(msg.message_thread_id) : null;
      let fullCopy = null;
      if (threadId0) {
        const tb = await env.DB.prepare(
          'SELECT * FROM telegram_topic_bindings WHERE chat_id = ? AND thread_id = ?'
        ).bind(chatId, threadId0).first();
        if (tb) fullCopy = { communityId: tb.community_id, target: tb.target, owner: tb.created_by, label: `topic ${threadId0}` };
      }
      if (!fullCopy && Number(binding?.copy_text || 0) === 1 && binding?.community_id) {
        fullCopy = { communityId: binding.community_id, target: binding.channel_target || 'community', owner: binding.created_by, label: 'group copy' };
      }
      if (fullCopy) {
        const personalOwner = fullCopy.target === 'community' ? null : String(fullCopy.owner || '');
        const sinks = sinkTargetsFor(fullCopy.target, personalOwner);
        runInBackground(env, capturePostIntoSinks(env, sinks, {
          msg, token,
          communityId: fullCopy.communityId,
          personalOwner,
          channelTitle: `${msg.chat?.title || 'group'}${threadId0 ? ` · #${threadId0}` : ''}`,
        }));
      }
    } catch (e) {
      console.error('full-copy hook failed', e?.message || e);
    }
  }

  // ---- Document/file handling ----
  // When a user sends a .md or supported file, save it to the active scope.
  // In groups: always community scope. In DMs: respect /personal or /community mode.
  const doc = msg.document;

  // Group/channel files from members who never logged into the website are
  // still indexed into the community brain — group membership is the
  // authorization (same trust model as /channel_link). Personal scope still
  // requires a website account below.
  if (doc && doc.file_id && !athenaUser && binding?.community_id &&
      (String(msg.chat?.type || '').includes('group') || chatId.startsWith('-')) &&
      !(String(msg.text || msg.caption || '').trim().startsWith('/'))) {
    const filename0 = doc.file_name || 'document.txt';
    const ext0 = filename0.includes('.') ? filename0.split('.').pop().toLowerCase() : '';
    if (DOCUMENT_EXTENSIONS.has(ext0) || CONVERTIBLE_EXTENSIONS.has(ext0)) {
      if (Number(doc.file_size || 0) > CONVERT_SOURCE_MAX_BYTES) {
        await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} ${codeHtml(filename0)} exceeds the ${CONVERT_SOURCE_MAX_BYTES / (1024 * 1024)} MiB indexing limit.`, forumThreadId);
      } else {
        try {
          const fileInfo = await telegramApi(token, 'getFile', { file_id: doc.file_id });
          if (fileInfo?.ok && fileInfo.result?.file_path) {
            const fileRes = await fetchWithTimeout(`${TG_API_BASE}/file/bot${token}/${fileInfo.result.file_path}`, { env, redirect: 'error', allowPrivate: true }, 60_000);
            if (fileRes.ok) {
              const r = await saveIndexedDocument(env, binding.community_id, filename0, ext0, new Uint8Array(await fileRes.arrayBuffer()), `tg:${tgUserId}`, { chatId: msg.chat.id, messageId: msg.message_id });
              if (r?.error) await sendTelegramFormatted(token, chatId, `${boldHtml('❌')} ${escHtml(filename0)}: ${escHtml(r.error)}`, forumThreadId);
              else if (r?.saved) await sendTelegramFormatted(token, chatId, `${boldHtml('✅')} Saved to community brain: ${codeHtml(escHtml(filename0))}\n${italicHtml('Login on the website to search it.')}`, forumThreadId);
            }
          }
        } catch (e) {
          console.error('group doc (no-user) index failed', e?.message || e);
        }
      }
    }
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  if (doc && doc.file_id && athenaUser) {
    let filename = doc.file_name || 'document.txt';
    const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
    if (DOCUMENT_EXTENSIONS.has(ext) || CONVERTIBLE_EXTENSIONS.has(ext)) {
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
        if (Number(doc.file_size || 0) > CONVERT_SOURCE_MAX_BYTES) {
          await sendTelegramFormatted(token, chatId, `${boldHtml('❌')} File exceeds the 20 MiB Telegram indexing limit.`, forumThreadId);
          return new Response('OK', { status: 200, headers: corsHeaders });
        }
        const botToken = token || env.TELEGRAM_BOT_TOKEN;
        const fileInfo = await telegramApi(botToken, 'getFile', { file_id: doc.file_id });
        if (!fileInfo?.ok || !fileInfo.result?.file_path) {
          await sendTelegramFormatted(token, chatId, `${boldHtml('❌')} Could not download file.`, forumThreadId);
          return new Response('OK', { status: 200, headers: corsHeaders });
        }
        const fileUrl = `${TG_API_BASE}/file/bot${botToken}/${fileInfo.result.file_path}`;
        const fileRes = await fetchWithTimeout(fileUrl, { env, redirect: 'error' }, 60_000);
        if (!fileRes.ok) throw new Error(`Download failed: ${fileRes.status}`);
        // Same validators as the API path — byte-accurate size cap, filename and
        // UTF-8 checks. Binary formats convert to Markdown first (self-host
        // only); text formats are validated inline as before.
        let valid;
        if (CONVERTIBLE_EXTENSIONS.has(ext)) {
          const arr = new Uint8Array(await fileRes.arrayBuffer());
          let bin = '';
          for (let i = 0; i < arr.length; i += 0x8000) bin += String.fromCharCode(...arr.subarray(i, i + 0x8000));
          const converted = await convertDocumentToMarkdown(env, ext, btoa(bin));
          if (converted.error) {
            await sendTelegramFormatted(token, chatId, `${boldHtml('❌')} ${escHtml(converted.error)}`, forumThreadId);
            return new Response('OK', { status: 200, headers: corsHeaders });
          }
          valid = validateDocumentText(docScope, filename, converted.markdown);
        } else {
          valid = validateDocumentInput({ scope: docScope, filename, content: await fileRes.text() });
        }
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
          await sendTelegramFormatted(token, chatId, `${boldHtml('✅')} Saved to personal brain: ${codeHtml(filename)}`, forumThreadId);
        } else {
          await env.DB.prepare(
            `INSERT INTO uploaded_documents (id, scope, community_id, filename, content, uploaded_by, created_at)
             VALUES (?, 'community', ?, ?, ?, ?, ?)`
          ).bind(id, docCommunityId, filename, content, athenaUser.id, now).run();
          const communityName = binding?.group_name || docCommunityId;
          await sendTelegramFormatted(token, chatId, `${boldHtml('✅')} Saved to community brain (${escHtml(communityName)}): ${codeHtml(filename)}`, forumThreadId);
        }
        markMeiliScopeDirty(env, docScope, docScope === 'personal' ? athenaUser.id : docCommunityId);
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
    '/delete', '/edit', '/topic', '/dumpall', '/dumpsmart', '/admin', '/demote', '/clear', '/kick',
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
        `1) Login at ${await getWebsiteDisplayUrl(env)} with Telegram`,
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
      const websiteForEmpty = await getWebsiteDisplayUrl(env);
      const hostLabelEmpty = websiteForEmpty.replace(/^https?:\/\//, '');
      await logOperationalEvent(env, '⚠️ Community join failed', `Telegram user ${tgUserId || 'unknown'} did not provide a community id`);
      await sendTelegramMessage(token, chatId, `Usage: /community_join <community_id>\nInstance: ${hostLabelEmpty} (${websiteForEmpty})\nGet id: /community_list or from owner`, forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    if (!athenaUser) {
      await logOperationalEvent(env, '⚠️ Community join blocked', `Telegram user ${tgUserId || 'unknown'} is not logged in; requested ${cid}`);
      const website = await getWebsiteDisplayUrl(env);
      const hostLabel = website.replace(/^https?:\/\//, '');
      const cForNotRegistered = await env.DB.prepare('SELECT id, name FROM communities WHERE id = ?').bind(cid).first();
      const communityLabelNotReg = cForNotRegistered ? `${cForNotRegistered.name} (${cForNotRegistered.id})` : cid;
      await sendTelegramMessage(token, chatId,
        `Not registered yet.\nInstance: ${hostLabel} — ${website}\nCommunity: ${communityLabelNotReg}\n\n1) Login at ${website} with Telegram\n2) Join this Telegram group\n3) Then send /community_join ${cid}`, forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    const c = await env.DB.prepare('SELECT id, name FROM communities WHERE id = ?').bind(cid).first();
    if (!c) {
      await logOperationalEvent(env, '⚠️ Community join failed', `Unknown community ${cid} requested by ${tgUserId || athenaUser.id}`, athenaUser.id);
      await sendTelegramMessage(token, chatId, `Community not found: ${cid}`, forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    if (isGod) {
      await sendTelegramMessage(token, chatId, `You are GOD already — you don't need to /community_join. You have full access to ${c.name} (${c.id}) and all communities.`, forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    if (await isBannedFromCommunity(env, cid, athenaUser)) {
      await logOperationalEvent(env, '🚫 Community join blocked', `${athenaUser.username || athenaUser.display_name || athenaUser.id} is banned from ${c.name} (${cid})`, athenaUser.id);
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
        await logOperationalEvent(env, '⚠️ Community join blocked', `${athenaUser.username || athenaUser.display_name || athenaUser.id} is not in the Telegram group for ${c.name}`, athenaUser.id);
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
      const websiteForExisting = await getWebsiteDisplayUrl(env);
      await sendTelegramMessage(token, chatId,
        `You are already a member of ${c.name} (${c.id}) — you don't need to /community_join again.\nOpen ${websiteForExisting} → Communities.`, forumThreadId);
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
         const notifyText = `👤 ${boldHtml(joinerLabel)}${joinerTgId ? ` | ${codeHtml(String(joinerTgId))}` : ''} joined ${boldHtml(c.name)} community`;
        const logTarget = await getConfiguredLogTarget(env, godUsers?.[0]?.id);
        if (logTarget) {
          await sendConfiguredLog(env, notifyText, godUsers?.[0]?.id, logTarget);
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
       await sendTelegramFormatted(token, chatId, `Login at ${await getWebsiteDisplayUrl(env)} with Telegram first.`, forumThreadId);
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
       const cid = String(channelId).trim();
       if (!/^-\d+$/.test(cid)) {
         await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} Invalid channel ID. Use -100... for channels. Forward msg to @userinfobot.`, forumThreadId);
         return new Response('OK', { status: 200, headers: corsHeaders });
       }
       const probeTok = (await decryptBotToken(env, personalBot.bot_token)) || token || env.TELEGRAM_BOT_TOKEN;
       // validate channel type via getChat
       try {
         const chk = await telegramApi(probeTok, 'getChat', { chat_id: cid });
         const ctype = chk?.result?.type || '';
         if (!chk?.ok || !chk?.result || ctype !== 'channel') {
           await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} ID ${codeHtml(cid)} is not a channel (type=${escHtml(ctype||'unknown')}). Use channel ID (-100...).`, forumThreadId);
           return new Response('OK', { status: 200, headers: corsHeaders });
         }
       } catch (e) {
         await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} Cannot validate ${codeHtml(cid)}: ${escHtml(e.message||'getChat failed')}.`, forumThreadId);
         return new Response('OK', { status: 200, headers: corsHeaders });
       }
       const probe = await sendTelegramFormatted(probeTok, cid, `${boldHtml('✅')} Athena log channel linked — test ok`);
       if (!probe?.ok) {
         await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} Cannot post to ${codeHtml(cid)}: ${escHtml(probe?.error || 'bot not admin')}. Not saved.`, forumThreadId);
         return new Response('OK', { status: 200, headers: corsHeaders });
       }
       await env.DB.prepare('UPDATE community_bots SET log_channel_id = ? WHERE id = ?').bind(cid, personalBot.id).run();
       await sendTelegramFormatted(token, chatId, `${boldHtml('✅')} Log channel set to: ${codeHtml(cid)}\nLogs now ONLY go to channel (no DM).`, forumThreadId);
     }
     return new Response('OK', { status: 200, headers: corsHeaders });
   }

   // ---- /channel_link — index a channel's new posts into a community ----
   // Owner/GOD only. The bot must already be an admin of the channel; the
   // check runs server-side via this bot's own token, so a channel cannot be
   // linked by anyone who merely knows its id.
   if (cmd === '/channel_link' || cmd === '/channellink') {
     if (!athenaUser) {
       await sendTelegramFormatted(token, chatId, `Login at ${await getWebsiteDisplayUrl(env)} with Telegram first.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     const communityIdArg = (parts[1] || '').trim();
     const channelIdArg = (parts[2] || '').trim() || (msg.reply_to_message?.sender_chat?.id ? String(msg.reply_to_message.sender_chat.id) : '');
     const targetArg = (parts[3] || '').trim().toLowerCase();
     if (targetArg && !CHANNEL_TARGETS.has(targetArg)) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} Target must be ${codeHtml('community')}, ${codeHtml('personal')} or ${codeHtml('both')}.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     if ((targetArg === 'personal' || targetArg === 'both') && !isGod) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('🔒')} ${codeHtml('personal')}/${codeHtml('both')} targets are GOD rank only.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     const channelTarget = targetArg || 'community';
     if (!communityIdArg || !channelIdArg) {
       await sendTelegramFormatted(token, chatId, [
         `${boldHtml('📢 Link a channel for auto-indexing')}`,
         '',
         `Usage: ${codeHtml('/channel_link <community_id> <channel_id> [community|personal|both]}')}`,
         `${codeHtml('personal')}/${codeHtml('both')} are GOD rank only.`,
         `Or: forward a channel post here, reply to it with ${codeHtml('/channel_link <community_id>')}`,
         '',
         'Requires: community owner/GOD, and this bot added as ADMIN of the channel.',
         'New channel posts (links + pdf/docx/md/json/… files) are indexed in real time.',
         `Channel ID: forward a channel post to ${linkHtml('https://t.me/userinfobot', '@userinfobot')}`,
         `Unlink: ${codeHtml('/channel_unlink <channel_id>')}`
       ].join('\n'), forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     if (!(await ensureOwnerOrAdmin(communityIdArg, athenaUser.id, env)) && !isGod) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('🔒')} Community owner/GOD only.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     const community = await env.DB.prepare('SELECT id, name FROM communities WHERE id = ?').bind(communityIdArg).first();
     if (!community) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} Community ${codeHtml(communityIdArg)} not found.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     const cid = channelIdArg.startsWith('-') ? channelIdArg : `-100${channelIdArg.replace(/^-100/, '')}`;
     if (!/^-\d+$/.test(cid)) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} Invalid channel ID (use -100…).`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     // Userbot mode makes this command unnecessary — point the way.
     await ensureUserbotTables(env);
     const ubCount = (await env.DB.prepare('SELECT COUNT(*) AS n FROM userbot_accounts WHERE enabled = 1').first())?.n || 0;
     if (ubCount > 0) {
       await sendTelegramFormatted(token, chatId,
         `${boldHtml('💡')} You have a userbot connected — no bot-admin needed.\nRun in my DM: ${codeHtml('/clone ' + cid + (targetArg ? ' ' + targetArg : ''))}\n${italicHtml('(or forward any post from that channel and reply with /clone)')}`,
         forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     // Validate: channel exists, bot is admin — with THIS bot's token.
     const me = await telegramApi(token, 'getMe', {});
     const botId = me?.result?.id;
     const chk = await telegramApi(token, 'getChat', { chat_id: cid });
     if (!chk?.ok || chk?.result?.type !== 'channel') {
       await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} ${codeHtml(cid)} is not a reachable channel for this bot — add the bot as ADMIN first.\n${italicHtml('Or connect a userbot account (/userbot_add) and use /clone — no admin needed.')}`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     const member = botId ? await telegramApi(token, 'getChatMember', { chat_id: cid, user_id: botId }) : null;
     const botStatus = member?.result?.status || '';
     if (!['administrator', 'creator'].includes(botStatus)) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} This bot is not an admin of that channel (status: ${escHtml(botStatus || 'unknown')}). Promote it and retry.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     await ensureBotBindingColumns(env);
     const channelTitle = chk.result.title || cid;
     const existingBinding = await env.DB.prepare(
       `SELECT id, community_id FROM community_bots WHERE platform = 'telegram' AND group_id = ?`
     ).bind(cid).first();
     if (existingBinding) {
       await env.DB.prepare('UPDATE community_bots SET community_id = ?, group_name = ?, channel_target = COALESCE(?, channel_target) WHERE id = ?')
         .bind(communityIdArg, channelTitle, channelTarget, existingBinding.id).run();
     } else {
       const id = 'cb_' + Date.now().toString(36) + '_' + randomToken().slice(0, 6);
       await env.DB.prepare(
         `INSERT INTO community_bots (id, community_id, platform, bot_username, group_id, group_name, created_by, created_at, scope, user_id, bot_token, channel_target)
          VALUES (?, ?, 'telegram', ?, ?, ?, ?, ?, 'community', NULL, NULL, ?)`
       ).bind(id, communityIdArg, me?.result?.username || null, cid, channelTitle, athenaUser.id, Date.now(), channelTarget).run();
     }
     await sendTelegramFormatted(token, chatId, [
       `${boldHtml('✅')} Channel ${boldHtml(escHtml(channelTitle))} linked to ${boldHtml(escHtml(community.name || communityIdArg))}.`,
       '',
       `${boldHtml('Target:')} ${codeHtml(channelTarget)}${channelTarget !== 'community' ? italicHtml(' (GOD personal brain included)') : ''}`,
       `${boldHtml('From now on')} every new post is copied automatically — links, captions, documents (pdf/docx/md/…), and text-only announcements. Video/audio/apk are skipped.`,
       '',
       `${boldHtml('Copy the existing history too')} (everything already in the channel):`,
       `1. On this server run: ${codeHtml('node scripts/gen-session.js')}`,
       `2. DM me: ${codeHtml('/index_start <community_id> <chat_id> <api_id> <api_hash> <session_string>')}`,
       `   • chat_id = ${codeHtml(cid)} · progress: ${codeHtml('/index_status')} · stop: ${codeHtml('/index_stop')}`,
       `${italicHtml('The session string is encrypted at rest and auto-deleted when the backfill finishes.')}`
     ].join('\n'), forumThreadId);
     return new Response('OK', { status: 200, headers: corsHeaders });
   }

   // ---- /group_copy — GOD toggles full-copy (text posts) for this group ----
   if (cmd === '/group_copy' || cmd === '/groupcopy') {
     if (!binding?.community_id) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} Not a linked community group. ${codeHtml('/community_verify')} first.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     if (!isGod && !(await ensureOwnerOrAdmin(binding.community_id, athenaUser?.id || '', env))) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('🔒')} Community owner/GOD only.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     const arg = (parts[1] || '').trim().toLowerCase();
     await ensureBotBindingColumns(env);
     if (arg === 'on' || arg === 'off') {
       const val = arg === 'on' ? 1 : 0;
       await env.DB.prepare('UPDATE community_bots SET copy_text = ? WHERE id = ?').bind(val, binding.id).run();
       await sendTelegramFormatted(token, chatId,
         `${boldHtml('✅')} Group full-copy ${arg === 'on' ? 'ON' : 'OFF'}.` +
         (arg === 'on' ? `\n${italicHtml('Text-only posts are now saved too. Target:')} ${codeHtml(binding.channel_target || 'community')} ${italicHtml('(change with /channel_target)')}` : ''),
         forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     const cur = Number(binding.copy_text || 0) === 1;
     await sendTelegramFormatted(token, chatId,
       `${boldHtml('Group full-copy:')} ${cur ? 'ON' : 'OFF'}\n${codeHtml('/group_copy on')} — also save text-only posts\n${codeHtml('/group_copy off')} — links & documents only`,
       forumThreadId);
     return new Response('OK', { status: 200, headers: corsHeaders });
   }

   // ---- /topic_link — clone a specific forum topic into the brain ----
   if (cmd === '/topic_link' || cmd === '/topiclink') {
     if (!msg.is_topic_message || msg.message_thread_id == null) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} Use ${codeHtml('/topic_link')} inside the forum topic you want to clone.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     if (!athenaUser) {
       await sendTelegramFormatted(token, chatId, `Login at ${await getWebsiteDisplayUrl(env)} with Telegram first.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     const communityIdArg = (parts[1] || '').trim();
     const targetArg = (parts[2] || '').trim().toLowerCase();
     if (!communityIdArg) {
       await sendTelegramFormatted(token, chatId,
         `Usage: ${codeHtml('/topic_link <community_id> [community|personal|both]')}\n${italicHtml('Run inside the topic. personal/both are GOD rank only.')}`,
         forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     if (targetArg && !CHANNEL_TARGETS.has(targetArg)) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} Target must be ${codeHtml('community')}, ${codeHtml('personal')} or ${codeHtml('both')}.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     if ((targetArg === 'personal' || targetArg === 'both') && !isGod) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('🔒')} ${codeHtml('personal')}/${codeHtml('both')} targets are GOD rank only.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     if (!(await ensureOwnerOrAdmin(communityIdArg, athenaUser.id, env)) && !isGod) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('🔒')} Community owner/GOD only.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     const community = await env.DB.prepare('SELECT id, name FROM communities WHERE id = ?').bind(communityIdArg).first();
     if (!community) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} Community ${codeHtml(communityIdArg)} not found.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     await ensureTopicBindingTable(env);
     const threadIdStr = String(msg.message_thread_id);
     const existing = await env.DB.prepare(
       'SELECT id FROM telegram_topic_bindings WHERE chat_id = ? AND thread_id = ?'
     ).bind(chatId, threadIdStr).first();
     if (existing) {
       await env.DB.prepare('UPDATE telegram_topic_bindings SET community_id = ?, target = COALESCE(NULLIF(?, \'\'), target), created_by = ? WHERE id = ?')
         .bind(communityIdArg, targetArg, athenaUser.id, existing.id).run();
     } else {
       await env.DB.prepare(
         `INSERT INTO telegram_topic_bindings (id, chat_id, thread_id, community_id, target, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`
       ).bind('tb_' + Date.now().toString(36) + '_' + randomToken().slice(0, 5), chatId, threadIdStr, communityIdArg, targetArg || 'community', athenaUser.id, Date.now()).run();
     }
     // Backfill pointer for this topic
     await sendTelegramFormatted(token, chatId, [
       `${boldHtml('✅')} Topic ${codeHtml('#' + threadIdStr)} linked to ${boldHtml(escHtml(community.name || communityIdArg))} · target ${codeHtml(targetArg || 'community')}.`,
       `${italicHtml('New posts in this topic are copied automatically (links, files, text).')}`,
       `History: ${codeHtml('/index_start <community_id> <chat_id> <api_id> <api_hash> <session> ' + threadIdStr)} ${italicHtml('(last arg = thread)')}`,
       `Manage: ${codeHtml('/topic_target ' + threadIdStr + ' <target>')} · ${codeHtml('/topic_unlink ' + threadIdStr)}`
     ].join('\n'), forumThreadId);
     return new Response('OK', { status: 200, headers: corsHeaders });
   }

   // ---- /topic_unlink ----
   if (cmd === '/topic_unlink' || cmd === '/topicunlink') {
     const threadArg = (parts[1] || '').trim() || (msg.message_thread_id != null ? String(msg.message_thread_id) : '');
     if (!threadArg) {
       await sendTelegramFormatted(token, chatId, `Usage: ${codeHtml('/topic_unlink <thread_id>')}`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     await ensureTopicBindingTable(env);
     const row = await env.DB.prepare(
       'SELECT * FROM telegram_topic_bindings WHERE chat_id = ? AND thread_id = ?'
     ).bind(chatId, threadArg).first();
     if (!row) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} No linked topic ${codeHtml('#' + threadArg)} in this group.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     if (!(await ensureOwnerOrAdmin(row.community_id, athenaUser?.id || '', env)) && !isGod) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('🔒')} Community owner/GOD only.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     await env.DB.prepare('DELETE FROM telegram_topic_bindings WHERE id = ?').bind(row.id).run();
     await sendTelegramFormatted(token, chatId, `${boldHtml('✅')} Topic ${codeHtml('#' + threadArg)} unlinked — new posts are no longer cloned.`, forumThreadId);
     return new Response('OK', { status: 200, headers: corsHeaders });
   }

   // ---- /topic_list ----
   if (cmd === '/topic_list' || cmd === '/topiclist') {
     await ensureTopicBindingTable(env);
     const { results } = await env.DB.prepare(
       'SELECT thread_id, community_id, target FROM telegram_topic_bindings WHERE chat_id = ? ORDER BY thread_id'
     ).bind(chatId).all();
     if (!results?.length) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('🗂')} No topics linked in this group yet. ${codeHtml('/topic_link <community_id>')} inside a topic.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     const lines = results.map((r) => `• ${codeHtml('#' + r.thread_id)} → ${escHtml(r.community_id)} · ${codeHtml(r.target || 'community')}`);
     await sendTelegramFormatted(token, chatId, `${boldHtml('🗂 Linked topics in this group')}\n\n${lines.join('\n')}`, forumThreadId);
     return new Response('OK', { status: 200, headers: corsHeaders });
   }

   // ---- /topic_target — GOD switches where a linked topic lands ----
   if (cmd === '/topic_target' || cmd === '/topictarget') {
     if (!isGod) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('🔒')} GOD rank only.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     const threadArg = (parts[1] || '').trim();
     const tArg = (parts[2] || '').trim().toLowerCase();
     if (!threadArg || !CHANNEL_TARGETS.has(tArg)) {
       await sendTelegramFormatted(token, chatId,
         `Usage: ${codeHtml('/topic_target <thread_id> <community|personal|both>')}`,
         forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     await ensureTopicBindingTable(env);
     const row = await env.DB.prepare(
       'SELECT id FROM telegram_topic_bindings WHERE chat_id = ? AND thread_id = ?'
     ).bind(chatId, threadArg).first();
     if (!row) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} No linked topic ${codeHtml('#' + threadArg)}.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     await env.DB.prepare('UPDATE telegram_topic_bindings SET target = ? WHERE id = ?').bind(tArg, row.id).run();
     await sendTelegramFormatted(token, chatId, `${boldHtml('✅')} Topic ${codeHtml('#' + threadArg)} now indexes into: ${codeHtml(tArg)}`, forumThreadId);
     return new Response('OK', { status: 200, headers: corsHeaders });
   }

   // ---- /channel_target — GOD switches where a linked channel lands ----
   if (cmd === '/channel_target' || cmd === '/channeltarget') {
     if (!athenaUser) {
       await sendTelegramFormatted(token, chatId, `Login at ${await getWebsiteDisplayUrl(env)} with Telegram first.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     if (!isGod) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('🔒')} GOD rank only.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     const cidArg = (parts[1] || '').trim();
     const tArg = (parts[2] || '').trim().toLowerCase();
     if (!cidArg || !CHANNEL_TARGETS.has(tArg)) {
       await sendTelegramFormatted(token, chatId,
         `Usage: ${codeHtml('/channel_target <channel_id> <community|personal|both>')}\nCurrent: reply with just ${codeHtml('/channel_target <channel_id>')}`,
         forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     await ensureBotBindingColumns(env);
     const row = await env.DB.prepare(
       `SELECT id, group_name, created_by, channel_target FROM community_bots WHERE platform = 'telegram' AND group_id = ? AND community_id IS NOT NULL`
     ).bind(cidArg.startsWith('-') ? cidArg : `-100${cidArg.replace(/^-100/, '')}`).first();
     if (!row) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} No linked channel ${codeHtml(cidArg)}. Link it first with ${codeHtml('/channel_link')}.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     // personal/both write into the linking GOD's brain; the SELECT above must
     // expose created_by for that ownership check.
     await env.DB.prepare('UPDATE community_bots SET channel_target = ? WHERE id = ?').bind(tArg, row.id).run();
     await sendTelegramFormatted(token, chatId,
       `${boldHtml('✅')} ${escHtml(row.group_name || cidArg)} now indexes into: ${codeHtml(tArg)}` +
       (tArg !== 'community' ? `\n${italicHtml('Personal content lands in the GOD account that ran /channel_link.')}` : ''),
       forumThreadId);
     return new Response('OK', { status: 200, headers: corsHeaders });
   }

   if (cmd === '/channel_unlink') {
     if (!athenaUser) {
       await sendTelegramFormatted(token, chatId, `Login at ${await getWebsiteDisplayUrl(env)} with Telegram first.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     const cid = (parts[1] || '').trim();
     if (!cid) {
       await sendTelegramFormatted(token, chatId, `Usage: ${codeHtml('/channel_unlink <channel_id>')}`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     const row = await env.DB.prepare(
       `SELECT id, community_id FROM community_bots WHERE platform = 'telegram' AND group_id = ? AND community_id IS NOT NULL`
     ).bind(cid).first();
     if (!row) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} No linked channel with ID ${codeHtml(cid)}.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     if (!(await ensureOwnerOrAdmin(row.community_id, athenaUser.id, env)) && !isGod) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('🔒')} Community owner/GOD only.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     await env.DB.prepare('DELETE FROM community_bots WHERE id = ?').bind(row.id).run();
     await sendTelegramFormatted(token, chatId, `${boldHtml('✅')} Channel ${codeHtml(cid)} unlinked — new posts are no longer indexed.`, forumThreadId);
     return new Response('OK', { status: 200, headers: corsHeaders });
   }

    // ---- /export — Telegram Bot API default + optional session history ----
    if (cmd === '/export' || cmd === '/telegram_export') {
      const mode = (rest.split(/\s+/)[0] || 'bot').toLowerCase();
      if (mode === 'session' || mode === 'history') {
        await sendTelegramFormatted(token, chatId, [
          `${boldHtml('🗂 Session history export')}`,
          '',
          `${italicHtml('This is optional. Bot mode is the default and handles new posts without a user session.')}`,
          `Run ${codeHtml('/index_start <community_id> <chat_id> <api_id> <api_hash> <session_string>')} in a private bot DM.`,
          `Install ${codeHtml('npm install telegram')} on the self-hosted server first.`,
          `${boldHtml('Never paste a session string in a group.')} It grants the user account access and is encrypted only when ${codeHtml('STORAGE_KEY')} is configured.`,
          `Progress: ${codeHtml('/index_status')} · cancel and delete session: ${codeHtml('/index_stop')}`
        ].join('\n'), forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
      const linked = binding?.community_id ? await env.DB.prepare(
        `SELECT group_id, group_name FROM community_bots
         WHERE platform = 'telegram' AND community_id = ? AND group_id LIKE '-100%' ORDER BY created_at DESC`
      ).bind(binding.community_id).all() : { results: [] };
      const channels = (linked.results || []).map((row) => `• ${escHtml(row.group_name || row.group_id)} (${codeHtml(row.group_id)})`);
      await sendTelegramFormatted(token, chatId, [
        `${boldHtml('📤 Telegram export')}`,
        '',
        `${boldHtml('Default: Bot API mode')}`,
        'New channel posts, links, captions, and supported documents are exported into the linked community brain as the webhook receives them.',
        channels.length ? `${boldHtml('Linked channels')}\n${channels.join('\n')}` : 'No channels linked yet.',
        `Enable it with ${codeHtml('/channel_link <community_id> <channel_id>')} after promoting this bot to channel admin.`,
        '',
        `${boldHtml('Optional: session mode')}`,
        `Use ${codeHtml('/export session')} for the private history-backfill guide. Bots cannot read old history; a short-lived encrypted user session is required for that one task.`
      ].join('\n'), forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }

    // ---- /index — indexing status + backfill pointer ----
   if (cmd === '/index') {
     const linked = binding?.community_id ? await env.DB.prepare(
       `SELECT group_id, group_name FROM community_bots WHERE platform = 'telegram' AND community_id = ? AND group_id LIKE '-100%'`
     ).bind(binding.community_id).all() : { results: [] };
     const chanLines = (linked.results || []).map((r) => `• ${escHtml(r.group_name || '')} (${codeHtml(r.group_id)})`);
     const isGroup = String(msg.chat?.type || '').includes('group') || chatId.startsWith('-');
     await sendTelegramFormatted(token, chatId, [
       `${boldHtml('🗂 Indexing')}`,
       '',
       `${boldHtml('Real time (automatic)')}`,
       isGroup ? '• This group: every posted link and file is saved as it arrives.' : '• Linked groups: every posted link and file is saved as it arrives.',
       chanLines.length ? `• Linked channels (new posts auto-copied):\n${chanLines.join('\n')}` : '• Channels: none linked yet — /channel_link <community_id> <channel_id>',
       '',
       `${boldHtml('History backfill')}`,
       'Telegram bots cannot read old messages. Backfilling a group/channel history needs a user session string:',
       `${codeHtml('/index_start')} — start (self-hosted, GOD/owner)`,
       `${codeHtml('/index_status')} — progress`,
       `${codeHtml('/index_stop')} — cancel + delete session`
     ].join('\n'), forumThreadId);
     return new Response('OK', { status: 200, headers: corsHeaders });
   }

   // ---- /index_start — history backfill with a user session string ----
   // Self-host only (gramjs is a native Node dependency), DM only (the
   // session string is a live account key), GOD or community owner.
     // ---- /clone (aliases /follow, /backfill): ONE command inside any chat ----
     // Registers live following AND starts history backfill. Dedupe makes the
     // overlap free. Works in channels/groups/topics where the userbot account
     // is a member — no bot-admin, no group binding required.
     if (cmd === '/clone' || cmd === '/follow' || cmd === '/backfill') {
       const dmOnly = !chatId.startsWith('-');
    // Remote mode (DM): /clone <chat_id> [thread_id] [target|community…]
    // or reply-to a forwarded channel post. For channels you cannot type in.
    let remoteChatId = '';
    let remoteThread = '';
    if (dmOnly) {
      const fwd = msg.reply_to_message?.forward_from_chat?.id
        ?? msg.reply_to_message?.forward_from_chat
        ?? msg.forward_from_chat?.id;
      for (const a of parts.slice(1)) {
        const t = a.trim();
        if (/^-?\d{8,}$/.test(t)) remoteChatId = t;
        else if (/^\d{1,7}$/.test(t)) remoteThread = t;
      }
      if (!remoteChatId && fwd != null) remoteChatId = String(fwd);
      if (!remoteChatId) {
        await sendTelegramFormatted(token, chatId,
          `${boldHtml('🧬 /clone from my DM')}\n\n${boldHtml('Easiest:')} forward any post from the channel here, then ${boldHtml('reply')} to it with ${codeHtml('/clone [target]')}\n\n${boldHtml('Or by id:')} ${codeHtml('/clone <chat_id> [thread_id] [target|community_id]')}\n${italicHtml('chat ids look like -100… (forward a post to @userinfobot to see one)')}`,
          forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
    }
    if (!athenaUser) {
      await sendTelegramFormatted(token, chatId, `Login at ${await getWebsiteDisplayUrl(env)} with Telegram first.`, forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    await ensureUserbotTables(env);
    const { results: enabledAccounts } = await env.DB.prepare('SELECT label FROM userbot_accounts WHERE enabled = 1 ORDER BY label').all();
    if (!enabledAccounts?.length) {
      await sendTelegramFormatted(token, chatId,
        `${boldHtml('🤖')} No userbot account connected yet. GOD: ${codeHtml('/userbot_add <label> <api_id> <api_hash> <session>')} in my DM.`,
        forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }

    // Parse args: target word, community id, optional min/max id range.
    let targetArg = '';
    let communityIdArg = '';
    let minIdArg = '';
    let maxIdArg = '';
    const rangeTokens = [];
    for (const a of parts.slice(1)) {
      const t = a.trim();
      if (!t) continue;
      if (CHANNEL_TARGETS.has(t.toLowerCase())) { targetArg = t.toLowerCase(); continue; }
      if (/^c_/.test(t)) { communityIdArg = t; continue; }
      if (/^\d{1,9}$/.test(t)) { rangeTokens.push(t); continue; }
      if (t.length > 8 && !/^-?\d+$/.test(t)) communityIdArg = t;
    }
    if (rangeTokens.length === 1) maxIdArg = rangeTokens[0];
    if (rangeTokens.length >= 2) { minIdArg = rangeTokens[0]; maxIdArg = rangeTokens[1]; }
    if ((targetArg === 'personal' || targetArg === 'both') && !isGod) {
      await sendTelegramFormatted(token, chatId, `${boldHtml('🔒')} ${codeHtml('personal')}/${codeHtml('both')} targets are GOD rank only.`, forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }

    let threadArg = msg.is_topic_message && msg.message_thread_id != null ? String(msg.message_thread_id) : '';
    let chatIdN = normalizeTgChatId(chatId);
    if (dmOnly && remoteChatId) {
      chatIdN = normalizeTgChatId(remoteChatId);
      if (remoteThread) threadArg = remoteThread;
    }

    // Forum auto-detection: if no thread specified and chat is a forum
    if (dmOnly && remoteChatId && !threadArg) {
      const isForum = await isForumEnabled(token, chatIdN, env);
      if (isForum) {
        const topics = await getForumTopicsViaUserbot(env, chatIdN);
        if (topics.length) {
          // If user said "all" as target, clone every topic topic-wise
          if (targetArg === 'all' || communityIdArg === 'all') {
            let _created = 0;
            for (const t of topics) {
              try {
                await env.DB.prepare(
                  `INSERT INTO telegram_topic_bindings (id, chat_id, thread_id, community_id, target, created_by, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(chat_id, thread_id) DO UPDATE SET community_id=excluded.community_id, target=excluded.target`
                ).bind('tb_'+Date.now().toString(36)+Math.random().toString(36).slice(2,6), chatIdN, String(t.id), communityIdArg || 'personal', targetArg === 'all' ? 'community' : (targetArg || 'community'), athenaUser.id, Date.now()).run();
                // Also create follow+backfill for each topic
                await env.DB.prepare(
                  `INSERT INTO userbot_follows (chat_id, label, community_id, target, created_by, created_at)
                   VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(chat_id) DO NOTHING`
                ).bind(chatIdN+':'+String(t.id), (await env.DB.prepare('SELECT label FROM userbot_accounts WHERE enabled=1 LIMIT 1').first())?.label || 'main', communityIdArg || 'personal', targetArg === 'all' ? 'community' : (targetArg || 'community'), athenaUser.id, Date.now()).run().catch(()=>{});
                _created++;
              } catch(e) { console.error('topic clone all failed', e?.message); }
            }
            await sendTelegramFormatted(token, chatId,
              `${boldHtml('✅ Cloning ' + topics.length + ' topics from ' + escHtml(chatIdN))} — each topic will be indexed separately. Check ${codeHtml('/userbot_status')} for per-topic progress.`,
              forumThreadId);
            return new Response('OK', { status: 200, headers: corsHeaders });
          }
          const lines = topics.slice(0, 15).map(t => `${codeHtml('/clone ' + chatIdN + ' ' + t.id)} — ${escHtml(t.title)}`);
          await sendTelegramFormatted(token, chatId,
            `${boldHtml('📋 Forum detected (' + topics.length + ' topics)')}\n${lines.join('\n')}\n\n${italicHtml('Run /clone with a topic id to clone just that topic, or /clone ' + chatIdN + ' all to clone all topics')}`,
            forumThreadId);
          return new Response('OK', { status: 200, headers: corsHeaders });
        }
      }
    }

    // Community resolution: explicit arg → topic binding → group binding →
    // GOD fallback to personal.
    if (!communityIdArg && threadArg) {
      const tb = await env.DB.prepare('SELECT community_id FROM telegram_topic_bindings WHERE chat_id = ? AND thread_id = ?').bind(chatIdN, threadArg).first().catch(() => null);
      communityIdArg = tb?.community_id || '';
    }
    if (!communityIdArg) communityIdArg = binding?.community_id || '';
    if (!communityIdArg && !targetArg && isGod) targetArg = 'personal';
    if (!communityIdArg && !targetArg) {
      await sendTelegramFormatted(token, chatId,
        `${boldHtml('⚠️')} No community bound here. GOD can use ${codeHtml('/clone personal')} or ${codeHtml('/clone both')}; otherwise pass the community: ${codeHtml('/clone <community_id>')}${dmOnly ? ` or ${codeHtml('/clone <chat_id> <community_id>')}` : ''}`,
        forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    let communityName = communityIdArg;
    if (communityIdArg) {
      if (!(await ensureOwnerOrAdmin(communityIdArg, athenaUser.id, env)) && !isGod) {
        await sendTelegramFormatted(token, chatId, `${boldHtml('🔒')} Community owner/GOD only.`, forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
      const comm = await env.DB.prepare('SELECT id, name FROM communities WHERE id = ?').bind(communityIdArg).first();
      if (!comm) {
        await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} Community ${codeHtml(communityIdArg)} not found.`, forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
      communityName = comm.name || communityIdArg;
    }

    // Account pick: single enabled → it; multiple → first (or match label arg).
    let label = enabledAccounts[0].label;
    if (enabledAccounts.length > 1) {
      const wantLabel = parts.slice(1).find((a) => enabledAccounts.some((e) => e.label === a.trim().toLowerCase()));
      if (wantLabel) label = wantLabel.trim().toLowerCase();
    }
    const acc = USERBOT_ACCOUNTS.get(label);
    if (!acc) {
      const startedNow = await startUserbotAccount(env, label);
      if (!startedNow.ok) {
        await sendTelegramFormatted(token, chatId, `${boldHtml('❌')} Account ${codeHtml(label)} is stored but disconnected (${escHtml(startedNow.reason || 'unknown')}). Restart the server or re-add it.`, forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
    }

    // Probe NOW — instant feedback if this account cannot see the chat.
    const visible = await primeEntity(USERBOT_ACCOUNTS.get(label).client, chatIdN, 45_000);
    if (!visible) {
      await sendTelegramFormatted(token, chatId,
        `${boldHtml('⚠️')} The account ${codeHtml(label)} cannot see ${codeHtml(chatIdN)}.\n${italicHtml('Join this channel/group with that account, then run /clone again.')}`,
        forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }

    // Register live follow.
    await env.DB.prepare(
      `INSERT INTO userbot_follows (chat_id, label, community_id, target, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET label = excluded.label, community_id = excluded.community_id,
         target = excluded.target, created_by = excluded.created_by`
    ).bind(chatIdN, label, communityIdArg || null, targetArg || 'community', athenaUser.id, Date.now()).run();

    // History backfill right after — dedupe makes overlap harmless.
    await startBackfillJob(env, { token, chatId, forumThreadId, athenaUser, communityIdArg, chatIdArg: chatIdN, threadArg, communityName, userbotLabel: label, minId: minIdArg, maxId: maxIdArg });

    const scopeLine = targetArg === 'personal'
      ? `${boldHtml('your personal brain')}`
      : targetArg === 'both'
        ? `${boldHtml('personal + community')}`
        : `${boldHtml(escHtml(communityName))}`;
    await sendTelegramFormatted(token, chatId,
      `${boldHtml('🧬 Cloning this chat')} → ${scopeLine}\n• Live: every new post lands automatically\n• History: backfill running below with a progress bar\n• Duplicates are impossible (URL-hash per brain)`,
      forumThreadId).catch(() => {});
    return new Response('OK', { status: 200, headers: corsHeaders });
     }

   if (cmd === '/index_start' || cmd === '/indexstart' || cmd === '/backfill') {
     const dmOnly = !chatId.startsWith('-');
     if (!isSelfHosted(env)) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} History backfill runs on the self-hosted server (it needs the optional gramjs package). This instance is on Cloudflare Workers.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     if (!athenaUser) {
       await sendTelegramFormatted(token, chatId, `Login at ${await getWebsiteDisplayUrl(env)} with Telegram first.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }

     if (!dmOnly) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('🔒')} Session material never goes in groups. Use ${codeHtml('/backfill')} inside the chat, or run this in my DM.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     const usage = [
       `${boldHtml('🗂 History backfill')}`,
       '',
       `Usage (in bot DM): ${codeHtml('/index_start <community_id> <chat_id> <api_id> <api_hash> <session_string> [thread_id]')}`,
       `• thread_id — optional; backfill only that forum topic`,
       '',
       `• chat_id — the group/channel to backfill (forward a post to ${linkHtml('https://t.me/userinfobot', '@userinfobot')}; channels are -100…)`,
       '• api_id + api_hash — from my.telegram.org (the app the session belongs to)',
       `• session_string — gramjs StringSession. On the server: ${codeHtml('npm install telegram')} then ${codeHtml('node scripts/gen-session.js')} (Athena repo) prints one interactively.`,
       '',
       'Pacing is built in (flood-wait honored, ~1.5s/page). The triggering message is deleted; the session is deleted when the job completes. Progress every 300 messages; stopped jobs resume from the cursor.',
       `Full guide: /help → 📡 Channels · ${codeHtml('/index_status')} · ${codeHtml('/index_stop')}`
     ].join('\n');
     // Two forms:
     //   short:  /index_start <community_id> <chat_id> [thread_id]
     //           → reuses the connected userbot session automatically
     //   legacy: /index_start <community_id> <chat_id> <api_id> <api_hash> <session_string> [thread_id]
     const communityIdArg = parts[1] || '';
     const chatIdArg = parts[2] || '';
     const legacy = parts.length >= 6;
     let apiIdArg = '';
     let apiHashArg = '';
     let sessionArg = '';
     let threadArg = '';
     if (legacy) {
       apiIdArg = parts[3] || '';
       apiHashArg = parts[4] || '';
       sessionArg = parts.slice(5).join(' ');
       const threadMatch = sessionArg.match(/\s(-?\d{6,})\s*$/);
       if (threadMatch) {
         threadArg = threadMatch[1];
         sessionArg = sessionArg.slice(0, threadMatch.index).trim();
       }
     } else {
       threadArg = parts[3] || '';
     }
     if (!communityIdArg || !chatIdArg || (legacy && (!apiIdArg || !apiHashArg || !sessionArg))) {
       await sendTelegramFormatted(token, chatId, usage, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     if (!legacy) {
       await ensureUserbotTables(env);
       const st = await env.DB.prepare('SELECT label FROM userbot_accounts WHERE enabled = 1 ORDER BY label LIMIT 1').first();
       if (!st) {
         await sendTelegramFormatted(token, chatId,
           `${boldHtml('🤖')} No userbot session yet. Add one — after that backfills never ask again:\n${codeHtml('/userbot_add <label> <api_id> <api_hash> <session_string>')}\nGenerate a session on the server: ${codeHtml('node scripts/gen-session.js')}`,
           forumThreadId);
         return new Response('OK', { status: 200, headers: corsHeaders });
       }
     }
     if (!(await ensureOwnerOrAdmin(communityIdArg, athenaUser.id, env)) && !isGod) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('🔒')} Community owner/GOD only.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     const community = await env.DB.prepare('SELECT id, name FROM communities WHERE id = ?').bind(communityIdArg).first();
     if (!community) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} Community ${codeHtml(communityIdArg)} not found.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     if (!/^[-\d@_\w]+$/.test(chatIdArg)) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} Invalid chat_id.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     if (legacy) {
       // Manual one-off session: store encrypted, then reuse the standard pipeline.
       await telegramApi(token, 'deleteMessage', { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
       await ensureUserbotTables(env);
       const sessionEnc = await encryptSecret(env, sessionArg.trim());
       const apiHashEnc = await encryptSecret(env, apiHashArg.trim());
       if (!String(sessionEnc).startsWith('enc:v1:') || !String(apiHashEnc).startsWith('enc:v1:')) {
         await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} Server has no STORAGE_KEY — refusing to store the session string unencrypted. Set STORAGE_KEY and retry.`, forumThreadId);
         return new Response('OK', { status: 200, headers: corsHeaders });
       }
       await env.DB.prepare(
         `INSERT INTO userbot_accounts (label, api_id, api_hash_enc, session_enc, enabled, updated_at)
          VALUES ('main', ?, ?, ?, 1, ?)
          ON CONFLICT(label) DO UPDATE SET api_id = excluded.api_id, api_hash_enc = excluded.api_hash_enc,
            session_enc = excluded.session_enc, enabled = 1, last_error = NULL, updated_at = excluded.updated_at`
       ).bind(apiIdArg.trim(), apiHashEnc, sessionEnc, Date.now()).run();
       if (USERBOT_ACCOUNTS.has('main')) { try { await USERBOT_ACCOUNTS.get('main').client.disconnect(); } catch (_) {} USERBOT_ACCOUNTS.delete('main'); }
       await startUserbotAccount(env, 'main');
     }
     await startBackfillJob(env, { token, chatId, forumThreadId, athenaUser, communityIdArg, chatIdArg, threadArg, communityName: community.name || communityIdArg });
     return new Response('OK', { status: 200, headers: corsHeaders });
   }

   // ---- /userbot_add — GOD: store a named account (multiple allowed) ----
   if (cmd === '/userbot_add' || cmd === '/userbotadd' || cmd === '/userbot_connect' || cmd === '/userbotconnect') {
     const dmOnly = !chatId.startsWith('-');
     if (!isSelfHosted(env)) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} Userbot mode runs on the self-hosted server only.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     if (!isGod) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('🔒')} GOD rank only.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     if (!dmOnly) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('🔒')} Session strings are secrets — DM only.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     const label = (parts[1] || 'main').toLowerCase().replace(/[^\w-]/g, '').slice(0, 24) || 'main';
     const apiIdArg = parts[2] || '';
     const apiHashArg = parts[3] || '';
     const sessionArg = parts.slice(4).join(' ');
     if (!apiIdArg || !apiHashArg || !sessionArg) {
       await ensureUserbotTables(env);
       const { results: have } = await env.DB.prepare('SELECT label FROM userbot_accounts ORDER BY label').all();
       const lines = have?.length ? have.map((h) => `• ${codeHtml(h.label)}`) : ['• none yet'];
       await sendTelegramFormatted(token, chatId,
         `${boldHtml('🤖 Add a userbot account')}\n${codeHtml('/userbot_add <label> <api_id> <api_hash> <session_string>')}\n\n${boldHtml('Stored accounts:')}\n${lines.join('\n')}\n\n${italicHtml('Generate a session on the server: node scripts/gen-session.js')}\n${italicHtml('One add powers live cloning AND all backfills for that account. The account must be a member of the chats it follows.')}`,
         forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     await telegramApi(token, 'deleteMessage', { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
     await ensureUserbotTables(env);
     const sessionEnc = await encryptSecret(env, sessionArg.trim());
     const apiHashEnc = await encryptSecret(env, apiHashArg.trim());
     if (!String(sessionEnc).startsWith('enc:v1:') || !String(apiHashEnc).startsWith('enc:v1:')) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} Server has no STORAGE_KEY — refusing to store the session unencrypted.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     await env.DB.prepare(
       `INSERT INTO userbot_accounts (label, api_id, api_hash_enc, session_enc, enabled, updated_at)
        VALUES (?, ?, ?, ?, 1, ?)
        ON CONFLICT(label) DO UPDATE SET api_id = excluded.api_id, api_hash_enc = excluded.api_hash_enc,
          session_enc = excluded.session_enc, enabled = 1, last_error = NULL, updated_at = excluded.updated_at`
     ).bind(label, apiIdArg.trim(), apiHashEnc, sessionEnc, Date.now()).run();
     if (USERBOT_ACCOUNTS.has(label)) { try { await USERBOT_ACCOUNTS.get(label).client.disconnect(); } catch (_) {} USERBOT_ACCOUNTS.delete(label); }
     const started = await startUserbotAccount(env, label);
     await sendTelegramFormatted(token, chatId,
       started.ok
         ? `${boldHtml('✅')} Account ${codeHtml(label)} connected.\n${codeHtml('/follow [target]')} inside any chat this account can see · ${codeHtml('/backfill')} for history · ${codeHtml('/userbot_del ' + label)} to remove.`
         : `${boldHtml('❌')} Connect failed for ${codeHtml(label)}: ${escHtml(started.reason || 'unknown')}`,
       forumThreadId);
     return new Response('OK', { status: 200, headers: corsHeaders });
   }

   // ---- /userbot_del — GOD: remove one account or all ----
   if (cmd === '/userbot_del' || cmd === '/userbotdel') {
     if (!isGod) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('🔒')} GOD rank only.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     if (!isSelfHosted(env)) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} Userbot mode is self-host only.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     const target = (parts[1] || '').toLowerCase().trim();
     await ensureUserbotTables(env);
     if (!target) {
       const { results: have } = await env.DB.prepare('SELECT label FROM userbot_accounts ORDER BY label').all();
       await sendTelegramFormatted(token, chatId,
         `Usage: ${codeHtml('/userbot_del <label>')} or ${codeHtml('/userbot_del all')}\n${boldHtml('Stored:')} ${have?.length ? have.map((h) => codeHtml(h.label)).join(', ') : 'none'}`,
         forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     if (target === 'all') {
       const { results: all } = await env.DB.prepare('SELECT label FROM userbot_accounts').all();
       for (const r of all || []) await stopUserbotAccount(env, r.label, true);
       await sendTelegramFormatted(token, chatId, `${boldHtml('✅')} Removed ${all?.length || 0} account(s), their sessions and follows.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     const exists = await env.DB.prepare('SELECT label FROM userbot_accounts WHERE label = ?').bind(target).first();
     if (!exists) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} No account named ${codeHtml(target)}.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     await stopUserbotAccount(env, target, true);
     await sendTelegramFormatted(token, chatId, `${boldHtml('✅')} Account ${codeHtml(target)} removed — session and its follows deleted.`, forumThreadId);
     return new Response('OK', { status: 200, headers: corsHeaders });
   }

   // ---- /userbot_follow — GOD/owner: add a chat to live clone ----
   if (cmd === '/userbot_follow' || cmd === '/userbotfollow') {
     if (!isSelfHosted(env)) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} Userbot mode is self-host only.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     if (!athenaUser) {
       await sendTelegramFormatted(token, chatId, `Login at ${await getWebsiteDisplayUrl(env)} with Telegram first.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     const communityIdArg = (parts[1] || '').trim();
     const chatIdArg = normalizeTgChatId((parts[2] || '').trim());
     const targetArg = (parts[3] || '').trim().toLowerCase();
     if (!communityIdArg || !chatIdArg) {
       await sendTelegramFormatted(token, chatId,
         `Usage: ${codeHtml('/userbot_follow <community_id> <chat_id> [community|personal|both]')}\n${italicHtml('The userbot account must be a member of that chat. personal/both are GOD rank only.')}`,
         forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     if (targetArg && !CHANNEL_TARGETS.has(targetArg)) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} Target must be ${codeHtml('community')}, ${codeHtml('personal')} or ${codeHtml('both')}.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     if ((targetArg === 'personal' || targetArg === 'both') && !isGod) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('🔒')} ${codeHtml('personal')}/${codeHtml('both')} targets are GOD rank only.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     if (!(await ensureOwnerOrAdmin(communityIdArg, athenaUser.id, env)) && !isGod) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('🔒')} Community owner/GOD only.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     const community = await env.DB.prepare('SELECT id, name FROM communities WHERE id = ?').bind(communityIdArg).first();
     if (!community) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} Community ${codeHtml(communityIdArg)} not found.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     await ensureUserbotTables(env);
     const { results: enabledAccounts } = await env.DB.prepare('SELECT label FROM userbot_accounts WHERE enabled = 1 ORDER BY label').all();
     if (!enabledAccounts?.length) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('🤖')} No userbot accounts. GOD: ${codeHtml('/userbot_add <label> <api_id> <api_hash> <session>')}`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     const label = enabledAccounts.length === 1 ? enabledAccounts[0].label
       : (enabledAccounts.find((a) => a.label === (parts[4] || ''))?.label || '');
     if (!label) {
       await sendTelegramFormatted(token, chatId,
         `${boldHtml('ℹ️')} Multiple accounts — specify which:\n${enabledAccounts.map((a) => codeHtml(`/userbot_follow ${communityIdArg} ${chatIdArg} ${targetArg || 'community'} ${a.label}`)).join('\n')}`,
         forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     // Probe now so the user learns immediately if this account can see the chat.
     const probe = USERBOT_ACCOUNTS.get(label);
     let probeNote = '';
     if (probe) {
       const ok = await primeEntity(probe.client, chatIdArg, 30_000);
       probeNote = ok ? '' : `\n${boldHtml('⚠️')} That account cannot see ${codeHtml(chatIdArg)} yet — join the chat with it, then re-run.`;
     }
     await env.DB.prepare(
       `INSERT INTO userbot_follows (chat_id, label, community_id, target, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET label = excluded.label, community_id = excluded.community_id,
          target = excluded.target, created_by = excluded.created_by`
     ).bind(chatIdArg, label, communityIdArg, targetArg || 'community', athenaUser.id, Date.now()).run();
     await sendTelegramFormatted(token, chatId,
       `${boldHtml('✅')} Following ${codeHtml(chatIdArg)} → ${boldHtml(escHtml(community.name || communityIdArg))} · account ${codeHtml(label)} · target ${codeHtml(targetArg || 'community')}${probeNote}\n${italicHtml('New messages clone automatically. Existing history: /backfill here or /index_start.')}`,
       forumThreadId);
     return new Response('OK', { status: 200, headers: corsHeaders });
   }

   // ---- /userbot_unfollow ----
   if (cmd === '/userbot_unfollow' || cmd === '/userbotunfollow') {
     const cidArg = (parts[1] || '').trim();
     if (!cidArg) {
       await sendTelegramFormatted(token, chatId, `Usage: ${codeHtml('/userbot_unfollow <chat_id>')}`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     await ensureUserbotTables(env);
     const r = await env.DB.prepare('DELETE FROM userbot_follows WHERE chat_id = ?').bind(cidArg).run();
     await sendTelegramFormatted(token, chatId, `${boldHtml('✅')} Unfollowed ${codeHtml(cidArg)}${r?.changes ? '' : italicHtml(' (was not followed)')}.`, forumThreadId);
     return new Response('OK', { status: 200, headers: corsHeaders });
   }

   // ---- /forcetags — GOD: backfill tags for every untagged link ----
   if (cmd === '/forcetags') {
     if (!isGod) { await sendTelegramFormatted(token, chatId, `${boldHtml('🔒')} GOD rank only.`, forumThreadId); return new Response('OK', { status: 200, headers: corsHeaders }); }
     await ensureAiConfigTable(env);
     const cfgFt = await getInstanceAiConfig(env);
     const BATCH = 150;
     // Scope: /forcetags [community|personal|both|<community_id>] (default both)
     let scopeArg = '';
     let scopeCommunity = '';
     for (const a of parts.slice(1)) {
       const t = a.trim();
       if (['community', 'personal', 'both'].includes(t.toLowerCase())) scopeArg = t.toLowerCase();
       else if (/^c_/.test(t)) scopeCommunity = t;
     }
     scopeArg = scopeArg || 'both';
     const think = await sendTelegramFormatted(token, chatId, `${boldHtml('🏷')} Scanning (${scopeArg}${scopeCommunity ? ` · ${scopeCommunity}` : ''})…`, forumThreadId);
     const thinkId = think?.message_id;
     const targets = [];
     const pick = async (table, col) => {
       await ensureSearchColumns(env);
       const extra = (table === 'links' && scopeCommunity) ? ` AND community_id = '${scopeCommunity.replace(/'/g, '')}'` : '';
       const { results } = await env.DB.prepare(
         `SELECT id, url, title, notes, search_blob FROM ${table}
          WHERE COALESCE(tags,'') IN ('', '[]', 'null') OR metadata_version IS NULL OR metadata_version < 1${extra}
          ORDER BY created_at DESC LIMIT ${BATCH}`
       ).all();
       for (const r of results || []) targets.push({ table, col, row: r });
     };
     if (scopeArg !== 'personal') {
       if (scopeCommunity) await pick('links', scopeCommunity);
       else {
         const { results: cids } = await env.DB.prepare('SELECT DISTINCT community_id AS id FROM links').all();
         for (const row of cids || []) await pick('links', row.id);
       }
     }
     if (scopeArg !== 'community') {
       const godRow = await env.DB.prepare("SELECT id FROM users WHERE id LIKE 'telegram_%' ORDER BY created_at ASC LIMIT 1").first().catch(() => null);
       const godId = isGodTgId(tgUserId, env) ? `telegram_${tgUserId}` : (godRow?.id || '');
       if (godId) await pick('personal_links', godId);
     }
     if (!targets.length) {
       if (thinkId) await telegramApi(token, 'editMessageText', { chat_id: chatId, message_id: thinkId, text: `${boldHtml('✅')} Every link already has tags.`, parse_mode: 'HTML' }).catch(() => {});
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     let done = 0, aiHits = 0, ctxHits = 0;
     const editProgress = async () => {
       const pct = Math.min(100, Math.round((done / targets.length) * 100));
       const filled = Math.round((pct / 100) * 18);
       const bar = '▮'.repeat(filled) + '▯'.repeat(18 - filled);
       await telegramApi(token, 'editMessageText', {
         chat_id: chatId, message_id: thinkId, parse_mode: 'HTML',
         text: `${boldHtml('🏷 Force tags')}\n${codeHtml(bar + ' ' + pct + '%')}\n${done}/${targets.length} · AI ${aiHits} · context ${ctxHits}`
       }).catch(() => {});
     };
     for (const t of targets) {
       try {
         const r = t.row;
         const meta = { title: r.title || '', notes: r.notes || '', content: r.search_blob || '' };
         let tags = null; let title = r.title || ''; let notes = r.notes || '';
         if (cfgFt?.api_key) {
           try {
             const vocab = await recentTagsForScope(env, t.table === 'links' ? 'community' : 'personal', t.col);
             const ai = await aiDescribeAndTag(env, r.url, meta, vocab, cfgFt);
             if (ai) {
               aiHits++;
               title = ai.title || title;
               notes = ai.description || notes;
               tags = ai.tags || [];
             }
           } catch (_) {}
         }
         if (!tags?.length) {
           tags = fallbackTagsFromMeta(r.url, meta);
           ctxHits++;
         }
         if (!tags.length) tags = ['untagged'];
         await env.DB.prepare(
           `UPDATE ${t.table} SET tags = ?, title = ?, notes = ?, metadata_version = ${AI_METADATA_VERSION}, search_blob = NULL WHERE id = ?`
         ).bind(JSON.stringify(tags), title, notes, r.id).run();
         markMeiliScopeDirty(env, t.table === 'links' ? 'community' : 'personal', t.col);
       } catch (_) {}
       done++;
       if (done % 10 === 0) await editProgress();
     }
     await editProgress();
     await sendTelegramFormatted(token, chatId,
       `${boldHtml('✅')} Tagged ${done} link(s): ${aiHits} via AI · ${ctxHits} via context fallback.\n${italicHtml(targets.length >= BATCH ? 'More remain — run /forcetags again to continue.' : 'All caught up.')}`,
       forumThreadId);
     return new Response('OK', { status: 200, headers: corsHeaders });
   }

   // ---- /transfers — GOD: recent clone/backfill sessions with ids ----
   if (cmd === '/transfers' || cmd === '/clone_sessions') {
     if (!isGod) { await sendTelegramFormatted(token, chatId, `${boldHtml('🔒')} GOD rank only.`, forumThreadId); return new Response('OK', { status: 200, headers: corsHeaders }); }
     await ensureIndexTables(env);
     await ensureTransferColumns(env);
     const { results } = await env.DB.prepare(
       'SELECT id, chat_id, status, processed, saved_links, saved_docs, saved_files, created_at FROM index_jobs ORDER BY created_at DESC LIMIT 10'
     ).all();
     if (!results?.length) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('🗂')} No clone/backfill sessions yet.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     const lines = results.map((j) => `• ${codeHtml(j.id)}\n  ${escHtml(j.chat_id)} · ${j.status} · ${j.processed || 0} msgs · ${j.saved_links || 0} links · ${j.saved_docs || 0} docs${j.saved_files ? ` · ${j.saved_files} files` : ''}`);
     await sendTelegramFormatted(token, chatId,
       `${boldHtml('🗂 Clone sessions')}\n\n${lines.join('\n\n')}\n\n${italicHtml('Delete one:')} ${codeHtml('/clone_del <id> [files]')}${italicHtml(' — add "files" to also wipe its vault media')}`,
       forumThreadId);
     return new Response('OK', { status: 200, headers: corsHeaders });
   }

   // ---- /clone_del — GOD: delete one transfer session's imported data ----
   if (cmd === '/clone_del' || cmd === '/clonedel') {
     if (!isGod) { await sendTelegramFormatted(token, chatId, `${boldHtml('🔒')} GOD rank only.`, forumThreadId); return new Response('OK', { status: 200, headers: corsHeaders }); }
     await ensureUserbotTables(env);
     await ensureIndexTables(env);
     await ensureTransferColumns(env);
     const target = (parts[1] || '').trim();
     const withFiles = (parts[2] || '').toLowerCase() === 'files';
     if (!target) {
       await sendTelegramFormatted(token, chatId,
         `Usage:\n${codeHtml('/clone_del <job_id> [files]')} — delete that session's imports\n${codeHtml('/clone_del <chat_id> [files]')} — delete ALL sessions for a chat\n${codeHtml('/transfers')} — list ids`,
         forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     let transferIds;
     let jobIds;
     if (target.startsWith('ij_')) {
       transferIds = [target]; jobIds = [target];
     } else {
       const cid = normalizeTgChatId(target);
       const { results } = await env.DB.prepare('SELECT id FROM index_jobs WHERE chat_id = ?').bind(cid).all();
       jobIds = (results || []).map((r) => r.id);
       transferIds = [...jobIds, `live:${cid}`];
     }
     if (!transferIds.length) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} Nothing found for ${codeHtml(target)}. See ${codeHtml('/transfers')}.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     const ph = transferIds.map(() => '?').join(',');
     const args = [...transferIds];
     const d1 = await env.DB.prepare(`DELETE FROM links WHERE transfer_id IN (${ph})`).bind(...args).run().catch(() => ({ changes: 0 }));
     const d2 = await env.DB.prepare(`DELETE FROM personal_links WHERE transfer_id IN (${ph})`).bind(...args).run().catch(() => ({ changes: 0 }));
     const d3 = await env.DB.prepare(`DELETE FROM uploaded_documents WHERE transfer_id IN (${ph})`).bind(...args).run().catch(() => ({ changes: 0 }));
     // vault files for the whole chat when asked
     let filesWiped = false;
     if (withFiles && MEDIA_VAULT_DIR) {
       try {
         const fsSpec = 'node:fs/promises';
         const { rm } = await import(fsSpec);
         const dir = `${MEDIA_VAULT_DIR}/${String(jobIds[0] ? target : transferIds.find(t => t.startsWith('live:'))?.slice(5) || target).replace(/[^\w-]+/g, '_')}`;
         await rm(dir, { recursive: true, force: true });
         filesWiped = true;
       } catch (_) {}
     }
     if (jobIds.length) {
       await env.DB.prepare(`DELETE FROM index_jobs WHERE id IN (${jobIds.map(() => '?').join(',')})`).bind(...jobIds).run().catch(() => {});
     }
     // meili dirty for affected scopes
     try {
       const cidForMeili = target.startsWith('ij_') ? null : normalizeTgChatId(target);
       if (cidForMeili) markMeiliScopeDirty(env, 'community', cidForMeili);
     } catch (_) {}
     await sendTelegramFormatted(token, chatId,
       `${boldHtml('🗑 Deleted session')} ${codeHtml(target)}\n• links removed: ${d1?.changes || 0}\n• personal links: ${d2?.changes || 0}\n• documents: ${d3?.changes || 0}${filesWiped ? '\n• vault media folder wiped' : ''}\n${italicHtml(withFiles ? '' : 'Vault media files were kept — repeat with "files" to wipe them.')}`,
       forumThreadId);
     return new Response('OK', { status: 200, headers: corsHeaders });
   }

   // ---- /userbot_status — the one dashboard: accounts, channels, live + backfill status ----
   if (cmd === '/userbot_status' || cmd === '/userbotstatus' || cmd === '/indexing') {
     if (!isSelfHosted(env)) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} Userbot mode is self-host only.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     await ensureUserbotTables(env);
     await ensureIndexTables(env);
     const { results: accounts } = await env.DB.prepare('SELECT label, enabled, last_error FROM userbot_accounts ORDER BY label').all();
     const { results: follows } = await env.DB.prepare('SELECT chat_id, label, community_id, target FROM userbot_follows ORDER BY label, chat_id').all();
     const { results: jobs } = await env.DB.prepare(
       'SELECT id, chat_id, status, processed, saved_links, saved_docs, error, updated_at FROM index_jobs ORDER BY updated_at DESC'
     ).all();

     const accLines = (accounts || []).map((a) => {
       const live = USERBOT_ACCOUNTS.has(a.label) ? `🟢 connected (${Math.round((Date.now() - USERBOT_ACCOUNTS.get(a.label).startedAt) / 60000)}m)` : '🔴 stored, disconnected';
       return `• ${codeHtml(a.label)} — ${live}${a.last_error ? ` · ${escHtml(a.last_error)}` : ''}`;
     });

     const jobByChat = new Map();
     for (const j of jobs || []) {
       const k = normalizeTgChatId(j.chat_id);
       if (!jobByChat.has(k)) jobByChat.set(k, j);
     }
     const followLines = [];
     // Group jobs by chat for per-topic breakdown
     const jobsByChatThread = new Map(); // "chat:thread" -> job
     for (const j of jobs || []) {
       const k = normalizeTgChatId(j.chat_id) + ':' + (j.thread_id || '');
       if (!jobsByChatThread.has(k)) jobsByChatThread.set(k, j);
     }
     for (const f of follows || []) {
       let name = f.chat_id;
       const ubAcc = USERBOT_ACCOUNTS.get(f.label);
       if (ubAcc) {
         try { const ent = await ubAcc.client.getEntity(f.chat_id); if (ent?.title || ent?.username) name = ent.title || `@${ent.username}`; } catch (_) {}
       }
       try {
         const ch = await telegramApi(token, 'getChat', { chat_id: f.chat_id });
         if (ch?.ok && (ch.result?.title || ch.result?.username)) name = ch.result.title ? `${ch.result.title}` : `@${ch.result.username}`;
       } catch (_) {}
       const s = USERBOT_STATS.get(f.chat_id) || USERBOT_STATS.get(String(Number(f.chat_id))) || {};
       const liveBits = [`msgs ${s.msgs || 0}`, `links ${s.links || 0}`, `docs ${s.docs || 0}`];
       if (s.lastAt) liveBits.push(`last ${Math.max(1, Math.round((Date.now() - s.lastAt) / 60000))}m ago`);
       else liveBits.push(italicHtml('waiting for new posts'));
       const jb = jobByChat.get(normalizeTgChatId(f.chat_id));
       let bf = 'backfill: not run';
       if (jb) {
         const capNote = jb.processed >= INDEX_MAX_MESSAGES ? ' · cap hit, auto-continuing' : '';
         const totalBit = jb.processed ? `${jb.processed} msgs` : '';
         bf = `backfill: ${jb.status}${totalBit ? ` (${totalBit})` : ''}${capNote}`;
         if (jb.urls_seen) bf += ` · ${jb.urls_seen} urls`;
         if (jb.saved_links) bf += ` · ${jb.saved_links} links saved`;
         if (jb.saved_files) bf += ` · ${jb.saved_files} files`;
         if (jb.error) bf += ` — ${String(jb.error).slice(0, 80)}`;
       }
       // Per-topic breakdown for forum groups
       let topicLines = [];
       try {
         const { results: topics } = await env.DB.prepare('SELECT thread_id, target FROM telegram_topic_bindings WHERE chat_id = ? ORDER BY thread_id').bind(f.chat_id).all();
         for (const t of topics || []) {
           const tj = jobsByChatThread.get(normalizeTgChatId(f.chat_id) + ':' + t.thread_id);
           const tStatus = tj ? `${tj.status}${tj.processed ? ` ${tj.processed} msgs` : ''}${tj.saved_links ? ` · ${tj.saved_links} links` : ''}${tj.saved_docs ? ` · ${tj.saved_docs} docs` : ''} — ${escHtml(String(tj.error || 'ok').slice(0,60))}` : 'not started';
           // Fallback: if no per-thread job, check if whole-chat job covered it
           topicLines.push(`    ${codeHtml('#' + t.thread_id)} [${escHtml(t.target || 'community')}] — ${tStatus}`);
         }
         // Also bare topic jobs without binding (DM clone)
         for (const [k, j] of jobsByChatThread) {
           if (k.startsWith(normalizeTgChatId(f.chat_id) + ':') && k.split(':')[1]) {
             const tid = k.split(':')[1];
             if (!topics?.some(t => String(t.thread_id) === tid)) {
               topicLines.push(`    ${codeHtml('#' + tid)} — ${j.status} ${j.processed || 0} msgs · ${j.saved_links || 0} links`);
             }
           }
         }
       } catch (_) {}
       followLines.push(
         `• ${boldHtml(escHtml(name))} ${italicHtml(`[${f.target || 'community'}]`)}\n` +
         `  live: ${liveBits.join(' · ')}${USERBOT_ACCOUNTS.has(f.label) ? ' ' + italicHtml('(active — new posts clone automatically)') : ''}\n` +
         `  ${bf}` +
         (topicLines.length ? `\n  ${boldHtml('Topics:')}\n${topicLines.join('\n')}` : '')
       );
     }

     let errLines = [];
     try {
       const { results: errs } = await env.DB.prepare('SELECT t, label, chat, error FROM userbot_errors ORDER BY t DESC LIMIT 5').all();
       errLines = (errs || []).map((e) => `• ${new Date(e.t).toISOString().slice(11, 19)} [${escHtml(e.label || '-')}] ${escHtml(String(e.error).slice(0, 110))}`);
     } catch (_) {}

     await sendTelegramFormatted(token, chatId,
       `${boldHtml('🤖 Accounts')}\n${accLines.length ? accLines.join('\n') : italicHtml('none — /userbot_add')}` +
       `\n\n${boldHtml('📡 Channels/chats being indexed')}\n${followLines.length ? followLines.join('\n\n') : italicHtml('none — run /clone inside a chat, or /clone <chat_id> in DM')}` +
       (errLines.length ? `\n\n${boldHtml('⚠️ Recent errors')}\n${errLines.join('\n')}` : ''),
       forumThreadId);
     return new Response('OK', { status: 200, headers: corsHeaders });
   }


   // ---- /userbot_disconnect — GOD: remove ALL accounts (alias /userbot_del all) ----
   if (cmd === '/userbot_disconnect' || cmd === '/userbotdisconnect') {
     if (!isGod) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('🔒')} GOD rank only.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     if (!isSelfHosted(env)) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('⚠️')} Userbot mode is self-host only.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     await ensureUserbotTables(env);
     const { results: all } = await env.DB.prepare('SELECT label FROM userbot_accounts').all();
     for (const r of all || []) await stopUserbotAccount(env, r.label, true);
     await sendTelegramFormatted(token, chatId,
       `${boldHtml('✅')} Disconnected — ${all?.length || 0} account(s), sessions and follows deleted.`,
       forumThreadId);
     return new Response('OK', { status: 200, headers: corsHeaders });
   }

   if (cmd === '/index_status') {
     await ensureIndexTables(env);
     const { results } = await env.DB.prepare(
       `SELECT j.* FROM index_jobs j WHERE j.user_id = ? ORDER BY j.updated_at DESC LIMIT 5`
     ).bind(athenaUser?.id || tgUserId || '').all();
     if (!results || !results.length) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('🗂')} No backfill jobs yet. ${codeHtml('/index_start')} to begin.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     const lines = results.map((j) => `${j.status === 'running' ? '▶️' : j.status === 'done' ? '✅' : j.status === 'error' ? '❌' : '⏸'} ${codeHtml(j.chat_id)} — ${escHtml(j.status)}: ${j.processed || 0} scanned · ${j.saved_links || 0} links · ${j.saved_docs || 0} docs\n   ${codeHtml(j.id)} · delete: /clone_del ${codeHtml(j.id)}${j.error ? `\n   ${escHtml(j.error)}` : ''}`);
     await sendTelegramFormatted(token, chatId, `${boldHtml('🗂 Backfill jobs')}\n\n${lines.join('\n\n')}`, forumThreadId);
     return new Response('OK', { status: 200, headers: corsHeaders });
   }

   if (cmd === '/index_stop') {
     if (!athenaUser) {
       await sendTelegramFormatted(token, chatId, `Login at ${await getWebsiteDisplayUrl(env)} with Telegram first.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     await ensureIndexTables(env);
     const { results } = await env.DB.prepare(
       `SELECT id FROM index_jobs WHERE user_id = ? AND status IN ('queued','running')`
     ).bind(athenaUser.id).all();
     if (!results || !results.length) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('🗂')} No running backfill jobs.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     for (const j of results) {
       await env.DB.prepare(`UPDATE index_jobs SET status = 'stopping', updated_at = ? WHERE id = ?`).bind(Date.now(), j.id).run();
       await env.DB.prepare('DELETE FROM telegram_index_sessions WHERE id = ?').bind(j.id).run().catch(() => {});
     }
     await sendTelegramFormatted(token, chatId, `${boldHtml('⏹')} Stopping ${results.length} job(s) and deleting the stored session(s).`, forumThreadId);
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
      forumThreadId,
      'HTML'
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

      await logOperationalEvent(env, '🆕 Community created', `${chatTitle} (${id}) by ${owner.username || owner.display_name || owner.id}`, owner.id);
      await sendTelegramMessage(replyToken, chatId, [
        'Community linked to Athena ✓',
        `${chatTitle} | ${id}`,
        '',
        'Members must:',
        `1) Login at ${await getWebsiteDisplayUrl(env)}`,
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
    markMeiliScopeDirty(env, 'personal', athenaUser.id);
    await logOperationalEvent(env, '🧹 Personal database cleared', `${athenaUser.username || athenaUser.display_name || athenaUser.id} cleared personal links`, athenaUser.id);
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

  // ---- /kick (alias /clear) — remove from community without a Telegram ban ----
  if (cmd === '/clear' || cmd === '/kick') {
    const cid = binding?.community_id;
    if (!cid) {
      await sendTelegramMessage(token, chatId, 'Use /kick in a verified community group (or with community linked).', forumThreadId);
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
        await sendTelegramMessage(token, chatId, 'Usage: /kick <@username|telegram_id>\nOr reply to their message with /kick', forumThreadId);
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
      await sendTelegramMessage(token, chatId, 'Cannot /kick GOD rank.', forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    const targetRole = targetUser ? await getCommunityMemberRole(env, cid, targetUser) : null;
    // Admin cannot clear owner or other admins; owner/god can clear admin+member
    if (!isGod && userRank === 'admin') {
      if (targetRole === 'owner' || targetRole === 'admin') {
        await sendTelegramMessage(token, chatId, 'Admins can only /kick member rank (not owner/admin).', forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
      // platform admin ids
      const padm = await env.DB.prepare(
        `SELECT 1 FROM community_admins WHERE community_id = ? AND platform = 'telegram' AND platform_user_id = ?`
      ).bind(cid, targetTg).first();
      if (padm) {
        await sendTelegramMessage(token, chatId, 'Admins can only /kick member rank (not admin).', forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
    }
    if (targetRole === 'owner' && !isGod) {
      // only god can clear owner? actually owner clearing self weird; other owners N/A
      const creator = await env.DB.prepare('SELECT creator_id FROM communities WHERE id = ?').bind(cid).first();
      if (targetUser && creator?.creator_id === targetUser.id) {
        await sendTelegramMessage(token, chatId, 'Cannot /kick community owner.', forumThreadId);
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
    await logOperationalEvent(
      env,
      '👢 Community member removed',
      `${targetName} (${targetTg}) removed from ${cid} by ${senderName}`,
      athenaUser?.id
    );
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
      if (!q) {
        await sendTelegramFormatted(token, chatId, `${boldHtml('🔍 Usage:')} ${codeHtml('/search <query>')}\nSearch returns matching links/documents only; use the buttons below a result page for older matches.`, forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
      await startTelegramSearch(env, token, chatId, tgUserId, 'personal', athenaUser.id, q, forumThreadId);
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
    if (!q) {
      await sendTelegramFormatted(token, chatId, `${boldHtml('🔍 Usage:')} ${codeHtml('/search <query>')}\nSearch returns matching links/documents only; use the buttons below a result page for older matches.`, forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    await startTelegramSearch(env, token, chatId, tgUserId, 'community', searchCommunityId, q, forumThreadId);
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

   // ---- /ai (same RAG + proxy as website, with thinking blocks) ----
   if (cmd === '/ai') {
     const q = rest || '';
     await ensureAiThreadsTable(env);
     let conversationHistory = [];
     const replyToId = msg.reply_to_message?.message_id;
     if (replyToId) {
       const row = await env.DB.prepare('SELECT history FROM tg_ai_threads WHERE key = ? AND ai_msg_id = ?')
         .bind(aiThreadKey(chatId, forumThreadId), replyToId).first().catch(() => null);
       if (row?.history) {
         try { conversationHistory = JSON.parse(row.history) || []; } catch (_) {}
       }
     }
     if (!q && conversationHistory.length) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('🧠')} Reply with your follow-up question.`, forumThreadId);
       return new Response('OK', { status: 200, headers: corsHeaders });
     }
     if (!q) {
       await sendTelegramFormatted(token, chatId, `${boldHtml('🧠 Usage:')} ${codeHtml('/ai your question about your brain')}\nExample: ${codeHtml('/ai how do I download youtube videos')}\n${italicHtml('Tip: reply to any AI answer to ask a follow-up.')}`, forumThreadId);
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

      // RAG retrieval — Meilisearch finds a small candidate set, PostgreSQL
      // hydrates the authoritative rows, and SQL remains the fallback.
      const scopeKey = scope === 'personal' ? athenaUser.id : aiCommunityId;
      await ensureFresh(env, scope, scopeKey);
      const retrieval = await retrieveAiRows(env, scope, scopeKey, q, { limit: AI_RETRIEVAL_LIMIT });
      const rows = retrieval.rows;
      const docs = rows;
      queueMissingLinkEnrichment(env, scope, scopeKey, rows);
      if (!docs.length) {
        await sendTelegramFormatted(token, chatId, 'You have no saved link on this in your brain', forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }

      // Build context — same format as website (includes document content)
      const formatDoc = (item, i) => {
        const notes = item.type === 'document' || item.isDocument ? '' : clipAiText(item.notes || '', 6_000);
        const content = clipAiText(item.content || '', AI_DOC_MAX_CHARS);
        const parts = [`[#${i + 1}]`, `Title: ${item.title || 'Untitled'}`];
        if (item.filename) parts.push(`Document: ${item.filename}`);
        if (item.url) parts.push(`URL: ${item.url}`);
        if (notes) parts.push(`Notes: ${notes}`);
        if (content) parts.push(`Content:\n${content}`);
        return parts.join('\n');
      };
      const contextSections = docs.map(formatDoc).filter(Boolean);

      // Same system prompt as website. The context is bounded before the
      // request; the retry loop is a second safety net for provider limits.
      const baseSystemPrompt = `You are Athena, a second-brain assistant. You ONLY use BRAIN CONTEXT below (the user's saved links, notes, and uploaded documents).

Rules:
1. NEVER say the brain is empty if BRAIN CONTEXT lists any items — use them.
2. By default give concise, direct answers. When the user says "in detail", "detailed", "explain", or asks for more depth, be thorough and comprehensive.
3. Answer DIRECTLY. NEVER include "Thinking", numbered analysis steps, evaluation of items, or meta-commentary about your reasoning. Start immediately with the answer.
4. When an uploaded DOCUMENT answers the question, read its relevant sections and present them clearly. Cite as [#n].
5. Recommend saved URLs when applicable. Cite as [#n].
6. Stay strictly grounded in BRAIN CONTEXT; never invent facts not present in it.

`;

     const thinkMsg = await sendTelegramFormatted(token, chatId, `${boldHtml('🧠')} Thinking with your${scope === 'personal' ? ' personal' : ''} brain…`, forumThreadId);
     const thinkMsgId = thinkMsg.message_id;

      const model = normalizeModelId(cfg.model, cfg.base_url);

      try {
        let content = '';
        let contextLimit = AI_CONTEXT_MAX_CHARS;
        for (;;) {
          const context = compactAiContext(contextSections, contextLimit);
          const systemPrompt = `${baseSystemPrompt}\n\nBRAIN has ${retrieval.total ?? rows.length} saved item(s). Retrieved for this question via ${retrieval.engine}:\n\n${context || '(no saved items)'}`;
          try {
            // Same request path as the website proxy: SSRF-checked endpoint,
            // model fallback chain, Retry-After, normalized + logged errors.
            const effectiveUser = conversationHistory.length
              ? `${conversationHistory.map((m) => `${m.role === 'user' ? 'User' : 'Athena'}: ${m.content}`).join('\n\n')}\n\nUser: ${q}\n\n(Continue this conversation. Answer the latest question, grounded in BRAIN CONTEXT where relevant.)`
              : q;
            const out = await callAiChatShared(env, {
              baseUrl: cfg.base_url, apiKey: cfg.api_key, mode: cfg.mode || 'openai', model,
              system: systemPrompt, user: effectiveUser, maxTokens: 3000, source: 'bot-ai',
            });
            content = isGroundedAiAnswer(out.content, docs)
              ? out.content
              : groundedMatchesReply(docs);
            break;
          } catch (err) {
            if (!isAiContextError(err) || !docs.length) throw err;
            const currentSize = context.length;
            const nextLimit = Math.floor(currentSize * 0.6);
            if (nextLimit < 1000 || nextLimit >= currentSize) throw err;
            contextLimit = nextLimit;
          }
        }

       // Rich text: full markdown → Telegram HTML (headers, lists, quotes,
       // code blocks, tables, bold/italic/strike, links, citations)
       const aiHtml = mdToTelegramHtml(content || '(empty)');
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
        docs.forEach((d, i) => {
         const t = d.title || titleFromUrl(d.url || '');
         const isDoc = d.isDocument || d.type === 'document';
         const sourceLine = isDoc ? `📄 ${t}` : (d.url ? `🔗 ${t}\n${d.url}` : null);
         if (!sourceLine) return;
         if (citedIndices.has(i)) mainSources.push(sourceLine);
       });

       // Only CITED sources are shown — unrelated matches are never appended
       // (use /search for the full paginated result list).
       if (mainSources.length) {
         msg += `\n\n${mainSources.join('\n')}`;
       }
       if (!mainSources.length && docs.length) {
         const allSources = docs.slice(0, 3).map((d) => {
           const t = d.title || titleFromUrl(d.url || '');
           const isDoc = d.isDocument || d.type === 'document';
           return isDoc ? `📄 ${t}` : (d.url ? `🔗 ${t}\n${d.url}` : null);
         }).filter(Boolean);
         if (allSources.length) {
           msg += `\n\n${boldHtml('📚 Top matches:')}\n${allSources.join('\n')}\n${italicHtml('More: /search ' + q.slice(0, 60))}`;
         }
       }

        // editMessageText is single-message — long answers continue in
        // follow-up messages instead of being silently truncated
        const parts = chunkTelegramHtml(msg);
        await editTelegramMessage(token, chatId, thinkMsgId, parts[0] || msg, null, forumThreadId);
        for (let pi = 1; pi < parts.length; pi++) {
          await sendTelegramFormatted(token, chatId, parts[pi], forumThreadId);
        }
        // Remember the thread so replying to this message is a follow-up.
        try {
          conversationHistory.push({ role: 'user', content: q }, { role: 'assistant', content: content || '' });
          const trimmed = JSON.stringify(conversationHistory.slice(-8));
          await env.DB.prepare(
            `INSERT INTO tg_ai_threads (key, ai_msg_id, history, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET ai_msg_id = excluded.ai_msg_id, history = excluded.history, updated_at = excluded.updated_at`
          ).bind(aiThreadKey(chatId, forumThreadId), thinkMsgId, trimmed, Date.now()).run();
        } catch (_) {}
      } catch (err) {
        await editTelegramMessage(token, chatId, thinkMsgId, `${boldHtml('❌ AI failed:')} ${escHtml(err.message)}`, null, forumThreadId);
      }
     return new Response('OK', { status: 200, headers: corsHeaders });
   }

  // ---- /db — show storage backend (all ranks) ----
  if (cmd === '/db') {
    const scope = binding?.scope || (binding?.community_id ? 'community' : 'personal');
    const lines = [
      boldHtml('🗄 Storage Backend'),
      '',
      `${boldHtml('Engine:')} ${codeHtml(selfHostedEngine(env))}`,
      `${boldHtml('Active:')} ${codeHtml('postgres')} (PostgreSQL)`,
      `${boldHtml('Runtime:')} ${isSelfHosted(env) ? 'Node.js' : 'Cloudflare Workers'}`,
      `${boldHtml('MCP:')} ${codeHtml('postgres-mcp')} — ${italicHtml('use same DATABASE_URL as memory')}`,
      '',
      `${boldHtml('Your dump mode:')} ${codeHtml(scope)}`,
    ];
    if (binding?.community_id) {
      lines.push(`${boldHtml('Community:')} ${escHtml(binding.group_name || binding.community_id)}`);
    }
    lines.push('', `${codeHtml('/backup')} ${italicHtml('for Telegram/Drive backup (self-host)')}`);
    await sendTelegramFormatted(token, chatId, lines.join('\n'), forumThreadId);
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  // ---- /sync — removed (PostgreSQL only). Keep command as stub for compat.
  if (cmd === '/sync') {
    await sendTelegramFormatted(token, chatId, `${boldHtml('ℹ️ Sync removed')} — PostgreSQL is the only store (D1/GitHub deprecated). Use ${codeHtml('/backup')} on self-host or ${codeHtml('pg_dump')}.`, forumThreadId);
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  // ---- /backup (GOD only, self-hosted) ----
  if (cmd === '/backup') {
    if (!isGod) {
      await sendTelegramFormatted(token, chatId, `${boldHtml('🔒 GOD rank only')}\n/backup triggers an immediate database backup.`, forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    if (!athenaUser) {
      await sendTelegramFormatted(token, chatId, `Login at ${await getWebsiteDisplayUrl(env)} first.`, forumThreadId);
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
    const edit = parseTelegramEditPayload(rest, msg.reply_to_message);
    if (!edit) {
      await sendTelegramMessage(token, chatId,
        'Usage:\n/edit <url or title words> | <new description>\n/edit <url> | title: New Title | notes: New notes\nOr reply to a saved-link message: /edit | new description', forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    const { queryPart, newTitle, newNotes } = edit;

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

    // Documents are searchable but not editable through the link command.
    rows = rows.filter(row => row?.url);
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
    await ensureLinkMetaColumns(env);
    await ensureSearchColumns(env);
    try {
      if (scope === 'personal') {
        await env.DB.prepare(
          `UPDATE personal_links SET title = ?, notes = ?, metadata_version = ${AI_METADATA_VERSION}, search_blob = NULL WHERE id = ? AND user_id = ?`
        ).bind(title, notes, hit.id, athenaUser.id).run();
      } else {
        await env.DB.prepare(
          `UPDATE links SET title = ?, notes = ?, metadata_version = ${AI_METADATA_VERSION}, search_blob = NULL WHERE id = ?`
        ).bind(title, notes, hit.id).run();
      }
    } catch (_) {
      if (scope === 'personal') {
        await env.DB.prepare(
          'UPDATE personal_links SET title = ?, notes = ? WHERE id = ? AND user_id = ?'
        ).bind(title, notes, hit.id, athenaUser.id).run();
      } else {
        await env.DB.prepare(
          'UPDATE links SET title = ?, notes = ? WHERE id = ?'
        ).bind(title, notes, hit.id).run();
      }
    }
    const storeScopeKey = scope === 'personal' ? athenaUser.id : binding.community_id;
    const storePatch = await storeMutateLink(env, scope, storeScopeKey, hit.id, { title, notes });
    if (storePatch.handled && !storePatch.ok) {
      await sendTelegramMessage(token, chatId, `Updated in database, but storage sync failed: ${storePatch.error}`, forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    markMeiliScopeDirty(env, scope, storeScopeKey);
    await sendTelegramMessage(token, chatId,
      `Updated:\nTitle: ${title || '(untitled)'}\nURL: ${hit.url}\nNotes: ${String(notes || '(empty)')}`, forumThreadId);
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  // ---- /delete ----
  if (cmd === '/delete') {
    // TG ID delete: /delete -100123... [thread_id] [files]  -> delete backfill+live for that chat/topic
    const delParts = rest.trim().split(/\s+/).filter(Boolean);
    const looksTgId = delParts.length && /^-?\d{5,}$/.test(delParts[0]);
    if (looksTgId) {
      if (!isGod && !(binding && await ensureOwnerOrAdmin(binding.community_id, athenaUser?.id || '', env))) {
        await sendTelegramMessage(token, chatId, 'Only community owner/GOD can delete cloned data.', forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
      await ensureTransferColumns(env);
      const chatArg = normalizeTgChatId(delParts[0]);
      const threadArg = delParts[1] && /^\d{1,10}$/.test(delParts[1]) && !/^c_/.test(delParts[1]) ? delParts[1] : '';
      const withFiles = delParts.includes('files');
      let transferIds;
      let jobIds;
      if (threadArg) {
        // Topic delete: find jobs for this chat+thread
        const { results } = await env.DB.prepare('SELECT id FROM index_jobs WHERE chat_id = ? AND thread_id = ?').bind(chatArg, threadArg).all().catch(() => ({ results: [] }));
        jobIds = (results || []).map(r => r.id);
        transferIds = [...jobIds];
        // live topic docs are tagged live:chat:thread? Currently live:<chat> only; also check docs with source containing thread
        const { results: _tdocs } = await env.DB.prepare("SELECT id FROM telegram_topic_bindings WHERE chat_id = ? AND thread_id = ?").bind(chatArg, threadArg).all().catch(() => ({ results: [] }));
        // Also include any live transfer for this chat+thread combo via source_chat+source_message lookup is too broad; just use transferIds
      } else {
        const { results } = await env.DB.prepare('SELECT id FROM index_jobs WHERE chat_id = ?').bind(chatArg).all().catch(() => ({ results: [] }));
        jobIds = (results || []).map(r => r.id);
        transferIds = [...jobIds, `live:${chatArg}`];
        // Also bare id variant (-100 prefix stripped)
        const bare = chatArg.replace(/^-100/, '');
        if (bare !== chatArg) {
          const { results: r2 } = await env.DB.prepare('SELECT id FROM index_jobs WHERE chat_id = ?').bind(bare).all().catch(() => ({ results: [] }));
          for (const r of r2 || []) if (!transferIds.includes(r.id)) { transferIds.push(r.id); jobIds.push(r.id); }
          transferIds.push(`live:${bare}`);
        }
      }
      if (!transferIds.length) {
        await sendTelegramMessage(token, chatId, `Nothing found for ${chatArg}${threadArg ? ':' + threadArg : ''}. Try /transfers to see ids.`, forumThreadId);
        return new Response('OK', { status: 200, headers: corsHeaders });
      }
      const ph = transferIds.map(() => '?').join(',');
      const d1 = await env.DB.prepare(`DELETE FROM links WHERE transfer_id IN (${ph})`).bind(...transferIds).run().catch(() => ({ changes: 0 }));
      const d2 = await env.DB.prepare(`DELETE FROM personal_links WHERE transfer_id IN (${ph})`).bind(...transferIds).run().catch(() => ({ changes: 0 }));
      const d3 = await env.DB.prepare(`DELETE FROM uploaded_documents WHERE transfer_id IN (${ph})`).bind(...transferIds).run().catch(() => ({ changes: 0 }));
      // Also delete docs by source_chat for topic granularity
      let d4 = { changes: 0 };
      if (threadArg) {
        // Topic docs have source_message but not easy to filter; keep transfer_id as primary
      } else if (!threadArg && chatArg.startsWith('-100')) {
        // For plain chat delete, also remove untagged docs that came from that chat via source_chat_id
        try {
          const r = await env.DB.prepare('DELETE FROM uploaded_documents WHERE source_chat_id = ?').bind(chatArg).run();
          d4 = r;
          const r2 = await env.DB.prepare('DELETE FROM uploaded_documents WHERE source_chat_id = ?').bind(chatArg.replace(/^-100/, '')).run().catch(() => ({ changes: 0 }));
          d4.changes = (d4.changes || 0) + (r2.changes || 0);
        } catch (_) {}
      }
      if (withFiles && MEDIA_VAULT_DIR) {
        try {
          const { rm } = await import('node:fs/promises');
          const dir = `${MEDIA_VAULT_DIR}/${chatArg.replace(/[^\w-]+/g, '_')}`;
          await rm(dir, { recursive: true, force: true });
        } catch (_) {}
      }
      if (jobIds.length) {
        await env.DB.prepare(`DELETE FROM index_jobs WHERE id IN (${jobIds.map(() => '?').join(',')})`).bind(...jobIds).run().catch(() => {});
        // Remove topic binding or follow if deleting topic
        if (threadArg) {
          await env.DB.prepare('DELETE FROM telegram_topic_bindings WHERE chat_id = ? AND thread_id = ?').bind(chatArg, threadArg).run().catch(() => {});
        } else {
          await env.DB.prepare('DELETE FROM userbot_follows WHERE chat_id = ?').bind(chatArg).run().catch(() => {});
          await env.DB.prepare('DELETE FROM telegram_topic_bindings WHERE chat_id = ?').bind(chatArg).run().catch(() => {});
        }
      }
      await sendTelegramMessage(token, chatId,
        `🗑 Deleted ${threadArg ? 'topic ' + threadArg + ' of ' : ''}${chatArg}\n• links: ${d1?.changes || 0}\n• personal links: ${d2?.changes || 0}\n• documents: ${(d3?.changes || 0) + (d4?.changes || 0)}${withFiles ? '\n• vault files wiped' : ''}`,
        forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    if (!binding) {
      await sendTelegramMessage(token, chatId, 'Not linked.', forumThreadId);
      return new Response('OK', { status: 200, headers: corsHeaders });
    }
    let urls = extractUrls(rest);
    if (!urls.length) urls = extractUrlsFromTelegramMessage(msg);
    if (!urls.length && msg.reply_to_message) urls = extractUrlsFromTelegramMessage(msg.reply_to_message);
    if (!urls.length) {
      await sendTelegramMessage(token, chatId, 'Usage: /delete https://…\nOr reply /delete to a message with a link (incl. photo captions).\n\nFor cloned data: /delete <chat_id> [thread_id] [files]  or  /clone_del <id>', forumThreadId);
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
          else {
            try {
              const vocab = await recentTagsForScope(env, 'personal', athenaUser.id);
              const ai = await aiDescribeAndTag(env, rawUrl, {
                title: add.title,
                notes: add.notes,
                content: add.content
              }, vocab);
              if (ai && add.id) {
                const savedTitle = ai.title || add.title;
                const tags = [...new Set([...(ai.tags || []), 'telegram', 'dump'])];
                await ensureSearchColumns(env);
                await env.DB.prepare(
                  `UPDATE personal_links SET title = ?, notes = ?, tags = ?, metadata_version = ${AI_METADATA_VERSION}, search_blob = NULL WHERE id = ?`
                ).bind(savedTitle, ai.description || add.notes || '', JSON.stringify(tags), add.id).run();
                await storeMutateLink(env, 'personal', athenaUser.id, add.id, {
                  title: savedTitle,
                  notes: ai.description || add.notes || '',
                  tags
                });
              }
            } catch (_) {}
            await sendTelegramMessage(token, chatId, `Was not in DB — added to personal: ${rawUrl}`, forumThreadId);
          }
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
          try {
            const tagText = [telegramFullPostText(msg.reply_to_message), telegramFullPostText(msg)].filter(Boolean).join(' ');
            const userTags2 = normalizeTagList(extractHashtags(tagText || meta.notes || ''));
            if (userTags2.length) {
              const tags = [...new Set([...['telegram'], ...userTags2])];
              await ensureSearchColumns(env);
              await env.DB.prepare(
                `UPDATE links SET title = ?, notes = ?, tags = ?, metadata_version = ${AI_METADATA_VERSION}, search_blob = NULL WHERE id = ?`
              ).bind(meta.title, meta.notes || '', JSON.stringify(tags), id).run();
              const gd = await storeMutateLink(env, 'community', binding.community_id, id, { title: meta.title, notes: meta.notes || '', tags });
              if (gd?.handled && !gd.ok) { await sendTelegramMessage(token, chatId, `Saved to DB but GitHub sync failed: ${gd.error||'unknown'}`, forumThreadId); }
            } else {
              const vocab = await recentTagsForScope(env, 'community', binding.community_id);
              const ai = await aiDescribeAndTag(env, rawUrl, meta, vocab);
              if (ai) {
                const savedTitle = ai.title || meta.title;
                const tags = [...new Set([...(ai.tags || []), 'telegram'])];
                await ensureSearchColumns(env);
                await env.DB.prepare(
                  `UPDATE links SET title = ?, notes = ?, tags = ?, metadata_version = ${AI_METADATA_VERSION}, search_blob = NULL WHERE id = ?`
                ).bind(savedTitle, ai.description || meta.notes || '', JSON.stringify(tags), id).run();
                const ga2 = await storeMutateLink(env, 'community', binding.community_id, id, { title: savedTitle, notes: ai.description || meta.notes || '', tags });
                if (ga2?.handled && !ga2.ok) { await sendTelegramMessage(token, chatId, `Saved to DB but GitHub sync failed: ${ga2.error||'unknown'}`, forumThreadId); }
              } else {
                const fb = fallbackTagsFromMeta(rawUrl, meta);
                if (fb.length) {
                  const tagsFb = [...new Set([...['telegram'], ...fb])];
                  await ensureSearchColumns(env);
                  await env.DB.prepare(`UPDATE links SET title = ?, notes = ?, tags = ?, metadata_version = ${AI_METADATA_VERSION}, search_blob = NULL WHERE id = ?`).bind(meta.title, meta.notes||'', JSON.stringify(tagsFb), id).run();
                  const gf = await storeMutateLink(env, 'community', binding.community_id, id, { title: meta.title, notes: meta.notes||'', tags: tagsFb });
                  if (gf?.handled && !gf.ok) { await sendTelegramMessage(token, chatId, `Saved to DB but GitHub sync failed: ${gf.error||'unknown'}`, forumThreadId); }
                }
              }
            }
          } catch (_) {}
          markMeiliScopeDirty(env, 'community', binding.community_id);
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
      await saveCommunityUrlDirect(env, token, binding, rawUrl, senderName, athenaUser, chatId, notesForSave, titleHint, forumThreadId, fullPost);
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
        const userTagsPersonal = normalizeTagList(extractHashtags(fullPost));
        let reply;
        try {
          if (userTagsPersonal.length && r.id) {
            const merged = [...new Set([...['telegram','personal'], ...userTagsPersonal])];
            await ensureSearchColumns(env);
            try {
              await env.DB.prepare(`UPDATE personal_links SET title = ?, tags = ?, notes = ?, metadata_version = ${AI_METADATA_VERSION}, search_blob = NULL WHERE id = ?`)
                .bind(r.title, JSON.stringify(merged), r.notes || '', r.id).run();
              const gp = await storeMutateLink(env, 'personal', athenaUser.id, r.id, { title: r.title, notes: r.notes || '', tags: merged });
              if (gp?.handled && !gp.ok) { await sendTelegramMessage(token, chatId, `Saved to DB but GitHub sync failed: ${gp.error||'unknown'}`, forumThreadId); }
            } catch (_) {}
            reply = formatSavedLinkReply('personal', r.title, rawUrl, { title: r.title, description: r.notes || '', tags: userTagsPersonal }, r.notes);
            reply = formatSavedLinkReply('personal', r.title, rawUrl, { title: r.title, description: r.notes || '', tags: userTagsPersonal }, r.notes);
          } else {
            const vocab = await recentTagsForScope(env, 'personal', athenaUser.id);
            const ai = await aiDescribeAndTag(env, rawUrl, {
              title: r.title,
              notes: r.notes,
              content: r.content
            }, vocab);
            if (ai && r.id) {
              const savedTitle = ai.title || r.title;
              const merged = ai.tags?.length
                ? [...new Set([...['telegram', 'personal'], ...ai.tags])]
                : ['telegram', 'personal'];
              await ensureSearchColumns(env);
              try {
                await env.DB.prepare(`UPDATE personal_links SET title = ?, tags = ?, notes = ?, metadata_version = ${AI_METADATA_VERSION}, search_blob = NULL WHERE id = ?`)
                  .bind(savedTitle, JSON.stringify(merged), ai.description || r.notes || '', r.id).run();
                await storeMutateLink(env, 'personal', athenaUser.id, r.id, { title: savedTitle, notes: ai.description || r.notes || '', tags: merged });
              } catch (_) {}
            } else {
              const fb=fallbackTagsFromMeta(rawUrl, {title: r.title, notes: r.notes, content: r.content});
              if(fb.length && r.id){
                const mergedFb=[...new Set([...['telegram','personal'], ...fb])];
                try{ await env.DB.prepare(`UPDATE personal_links SET title = ?, tags = ?, notes = ?, metadata_version = ${AI_METADATA_VERSION}, search_blob = NULL WHERE id = ?`).bind(r.title, JSON.stringify(mergedFb), r.notes||'', r.id).run(); await storeMutateLink(env,'personal',athenaUser.id,r.id,{title:r.title, notes:r.notes||'', tags:mergedFb}); }catch(_){}
                reply = formatSavedLinkReply('personal', r.title, rawUrl, {title: r.title, description: r.notes||'', tags: fb}, r.notes);
              } else {
                reply = formatSavedLinkReply('personal', r.title, rawUrl, null, r.notes);
              }
            }
            if(!reply) reply = formatSavedLinkReply('personal', ai?.title || r.title, rawUrl, ai, r.notes);
          }
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
    const parts = parseMode === 'HTML' ? chunkTelegramHtml(text) : chunkTelegramText(text, TG_MSG_MAX);
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
    const parts = parseMode === 'HTML' ? chunkTelegramHtml(text) : chunkTelegramText(text, TG_MSG_MAX);
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

/** Inline markdown → Telegram HTML. Input must already be HTML-escaped. */
function mdInlineTelegram(line) {
  // Protect inline code from every other rule first
  const codes = [];
  let s = line.replace(/`([^`\n]+)`/g, (_, body) => `\u0000IC${codes.push(`<code>${body}</code>`) - 1}\u0000`);
  s = s
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, '<b><i>$1</i></b>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n]+)__/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?![\w*])/g, '$1<i>$2</i>')
    .replace(/(^|[^\w_])_([^_\n]+)_(?![\w_])/g, '$1<i>$2</i>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    .replace(/\[#(\d+)\]/g, '<b>[#$1]</b>')
    .replace(/\[(\d+)\]/g, '<b>[$1]</b>');
  return s.replace(/\u0000IC(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}

/** Markdown (chat-model output) → Telegram HTML rich text. */
function mdToTelegramHtml(md) {
  const src = String(md || '').replace(/\r\n?/g, '\n');
  const blocks = [];
  const keep = (html) => `\u0000BLK${blocks.push(html) - 1}\u0000`;

  // Fenced code blocks first — their contents must not see any other rule
  let text = src.replace(/```[^\n]*\n?[\s\S]*?(?:```|$)/g, (m) => {
    const body = m.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '');
    return keep(`<pre><code>${escHtml(body)}</code></pre>`);
  });
  // Pipe tables (header | --- | --- | rows) render as monospace blocks
  text = text.replace(/^[^\n]*\|[^\n]*\n\|?[\s:|-]*-[\s:|-]*\n(?:[^\n]*\|[^\n]*(?:\n|$))*/gm, (m) => {
    const rows = m.trim().split('\n');
    return keep(`<pre>${escHtml(rows.join('\n'))}</pre>`);
  });

  const out = [];
  let quote = [];
  const flushQuote = () => {
    if (!quote.length) return;
    out.push(`<blockquote>${mdInlineTelegram(quote.join('\n'))}</blockquote>`);
    quote = [];
  };
  for (const raw of text.split('\n')) {
    const line = escHtml(raw);
    const qm = line.match(/^\s*&gt;\s?(.*)$/);
    if (qm) { quote.push(qm[1]); continue; }
    flushQuote();
    const hm = line.match(/^#{1,6}\s+(.*)$/);
    if (hm) { out.push(`<b>${mdInlineTelegram(hm[1])}</b>`); continue; }
    if (/^\s*([-*_])\s*(?:\1\s*){2,}$/.test(line)) { out.push('───────────'); continue; }
    const bm = line.match(/^\s*[-*•]\s+(.*)$/);
    if (bm) { out.push(`• ${mdInlineTelegram(bm[1])}`); continue; }
    out.push(mdInlineTelegram(line));
  }
  flushQuote();
  return out.join('\n').replace(/\u0000BLK(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
}

/** Telegram's HTML subset — the only tags whose pairing we track when chunking. */
const TG_STYLE_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'code', 'pre', 'a', 'blockquote', 'spoiler', 'tg-spoiler']);

/**
 * Split HTML for Telegram's 4096 limit without producing invalid markup:
 * cuts never land inside a tag, and any tag still open at the cut is closed
 * for this chunk and reopened (with its full attributes, e.g. <a href>) in
 * the next one.
 */
function chunkTelegramHtml(text, maxLen = TG_MSG_MAX) {
  const s = String(text || '');
  if (s.length <= maxLen) return s ? [s] : [];
  const chunks = [];
  let rest = s;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf('\n', maxLen);
    if (cut < Math.floor(maxLen * 0.5)) cut = rest.lastIndexOf(' ', maxLen);
    if (cut < Math.floor(maxLen * 0.4)) cut = maxLen;
    const lastLt = rest.lastIndexOf('<', cut);
    const lastGt = rest.lastIndexOf('>', cut);
    if (lastLt > lastGt) cut = lastGt >= 0 ? lastGt + 1 : rest.indexOf('>', cut) + 1;
    const head = rest.slice(0, cut);
    const open = [];
    const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s[^<>]*)?)>/g;
    let m;
    while ((m = tagRe.exec(head)) !== null) {
      const name = m[2].toLowerCase();
      if (!TG_STYLE_TAGS.has(name)) continue;
      if (m[1] === '/') {
        const idx = open.map((o) => o.name).lastIndexOf(name);
        if (idx !== -1) open.splice(idx, 1);
      } else {
        open.push({ name, full: m[0] });
      }
    }
    chunks.push(head.trimEnd() + open.slice().reverse().map((o) => `</${o.name}>`).join(''));
    rest = open.map((o) => o.full).join('') + rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.trim()) chunks.push(rest);
  return chunks;
}

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
    if (r?.type === 'document' || r?.isDocument || !r?.url) {
      key = `id:${r?.type || 'row'}:${r?.id || r?.filename || r?.title || ''}`;
    } else {
      try { key = canonicalUrlForHash(r.url); } catch (_) { key = `hash:${r.url_hash || r.url || ''}`; }
    }
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
    const { env: requestEnv, allowPrivate = false, ...fetchOptions } = options;
    let u = url;
    let hops = 0;
    const redirect = (fetchOptions.redirect === undefined) ? 'follow' : fetchOptions.redirect;
    while (true) {
      const target = new URL(u);
      const allowed = allowPrivate && isLocalAiEndpoint(target, requestEnv)
        ? true
        : await isSafeExternalUrl(target, requestEnv);
      if (!allowed) {
        const err = new Error(`blocked: ${target.hostname} is not a public host`);
        err.code = 'SSRF_BLOCKED';
        throw err;
      }
      const res = await fetch(u, { ...fetchOptions, redirect: 'manual', signal: ctrl.signal });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        if (redirect === 'error') {
          // Allow same-host redirects (e.g., trailing slash) even when redirect is error,
          // because they are safe and the API key stays on same origin.
          if (loc) {
            try {
              const nextUrl = new URL(loc, u);
              if (nextUrl.hostname === target.hostname && nextUrl.protocol === target.protocol) {
                if (++hops > 5) {
                  const err = new Error('too many redirects');
                  err.code = 'SSRF_BLOCKED';
                  throw err;
                }
                u = nextUrl.toString();
                continue;
              }
            } catch (_) {}
          }
          const err = new Error(`redirect refused: ${target.hostname} -> ${res.headers.get('location') || 'unknown'}`);
          err.code = 'REDIRECT_REFUSED';
          throw err;
        }
        if (redirect === 'follow') {
          if (!loc) return res;
          u = new URL(loc, u).toString();
          if (++hops > 5) {
            const err = new Error('too many redirects');
            err.code = 'SSRF_BLOCKED';
            throw err;
          }
          continue;
        }
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
    const oembedFallback = async () => {
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
    };
    const endpoint = `https://www.reddit.com${page.pathname.replace(/\/+$/, '')}.json?raw_json=1`;
    const response = await fetchWithTimeout(endpoint, {
      env,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'AthenaBot/1.3 (bookmark metadata)'
      }
    });
    if (!response.ok) return oembedFallback();
    let data;
    try { data = await response.json(); } catch (_) { return oembedFallback(); }
    const post = data?.[0]?.data?.children?.find(child => child?.data)?.data;
    if (!post?.title) return oembedFallback();
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
// --- kage fallback scraper (self-host only) --------------------------------
// kage (github.com/tamnd/kage) mirrors a page with headless Chrome and every
// script stripped — exactly what JS-rendered SPAs need. Enabled by setting
// KAGE_BIN to the kage binary on a self-hosted server. A missing binary is
// remembered for 10 minutes so each scrape does not pay a spawn cost.
let _kageUnavailableUntil = 0;

async function scrapeViaKage(rawUrl, env) {
  if (!isSelfHosted(env)) return null;
  if (Date.now() < _kageUnavailableUntil) return null;
  const bin = String(env.KAGE_BIN || 'kage').trim();
  if (!bin) return null;
  let dir = null;
  try {
    const cpSpec = 'node:child_process';
    const fsSpec = 'node:fs/promises';
    const osSpec = 'node:os';
    const pathSpec = 'node:path';
    const { execFile } = await import(cpSpec);
    const { mkdtemp, readFile, readdir } = await import(fsSpec);
    const { tmpdir } = await import(osSpec);
    const { join } = await import(pathSpec);
    dir = await mkdtemp(join(tmpdir(), 'athena-kage-'));
    const childEnv = typeof process !== 'undefined' ? { ...process.env } : undefined;
    if (childEnv && env.KAGE_CHROME) childEnv.KAGE_CHROME = String(env.KAGE_CHROME);
    await new Promise((resolve, reject) => {
      execFile(bin, ['clone', rawUrl, '--max-pages', '1', '--workers', '1', '-o', dir], {
        timeout: 90_000,
        env: childEnv,
        windowsHide: true
      }, (err) => (err ? reject(err) : resolve()));
    });
    // The mirror lands in <dir>/<host>/…; pick the largest HTML file that is
    // not a localized asset under _kage/.
    const htmlFiles = [];
    const walk = async (d) => {
      for (const entry of await readdir(d, { withFileTypes: true })) {
        const p = join(d, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '_kage') continue;
          await walk(p);
        } else if (/\.html?$/i.test(entry.name)) {
          const buf = await readFile(p);
          htmlFiles.push({ p, size: buf.length, buf });
        }
      }
    };
    await walk(dir);
    if (!htmlFiles.length) return null;
    htmlFiles.sort((a, b) => b.size - a.size);
    const html = htmlFiles[0].buf.toString('utf8').slice(0, 400_000);
    const title = cleanSiteTitle(
      metaContent(html, ['og:title', 'twitter:title']) || (() => {
        const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        return m ? decodeHtmlEntities(m[1]) : '';
      })(), '', '');
    const description = cleanGenericSummary(metaContent(html, ['description', 'og:description', 'twitter:description']) || '');
    let image = metaContent(html, ['og:image', 'twitter:image']) || '';
    try { if (image && !/^https?:\/\//i.test(image)) image = new URL(image, rawUrl).href; } catch (_) { image = ''; }
    const content = extractReadableContent(html);
    if (!content && !description) return null;
    let siteName = '';
    try { siteName = new URL(rawUrl).hostname.replace(/^www\./, ''); } catch (_) {}
    return { title, description, content, image, siteName };
  } catch (e) {
    // ENOENT = kage not installed; back off so saves stay fast without it.
    if (/ENOENT|not found|not executable/i.test(String(e?.message || e))) _kageUnavailableUntil = Date.now() + 10 * 60_000;
    else console.warn('kage scrape failed', e?.message || e);
    return null;
  } finally {
    if (dir) await import('node:fs/promises').then((m) => m.rm(dir, { recursive: true, force: true })).catch(() => {});
  }
}

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

    let kageFallbackUsed = false;
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
    if (!res.ok) {
      const kage = await scrapeViaKage(rawUrl, env);
      if (kage) {
        return {
          title: kage.title || fallback.title,
          description: kage.description || '',
          content: kage.content || '',
          image: kage.image || '',
          siteName: kage.siteName || '',
          viaKage: true
        };
      }
      return fallback;
    }

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
    let content = extractReadableContent(html);

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

    // JS-rendered SPA fallback: when static HTML yielded almost nothing, the
    // page likely renders client-side. If kage (headless-Chrome mirror) is
    // configured on this server, render it for real and re-extract.
    if ((!content || content.length < 400) && (!description || description.length < 80)) {
      const kage = await scrapeViaKage(rawUrl, env);
      if (kage) {
        kageFallbackUsed = true;
        if (kage.content && kage.content.length > content.length) content = kage.content;
        if (kage.description && scoreDescriptionCandidate(kage.description) >= 40) description = kage.description;
        if (!title || isWeakTitle(title, rawUrl)) title = kage.title || title;
        if (!image && kage.image) image = kage.image;
      }
    }

    return {
      title: String(title || fallback.title).slice(0, 160),
      description,
      content,
      image: image.slice(0, 500),
      siteName: (siteName || host || '').slice(0, 120),
      viaKage: kageFallbackUsed || undefined
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

const AI_METADATA_VERSION = 3;

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
const FREE_MODEL_CACHE = new Map();
const FREE_MODEL_LIST_TTL_MS = 60 * 60 * 1000;

function isModelFreeEntry(entry) {
  const id = String(entry.id || entry.model || '');
  // OpenRouter free suffix is ":free"; OpenCode Zen free variants end in "-free".
  if (id.toLowerCase() === 'openrouter/free') return true;
  if (/(^|:)free$/i.test(id) || /-free$/i.test(id)) return true;
  const p = entry.pricing || entry.cost || {};
  const vals = [p.prompt, p.completion, p.input, p.output, entry.input, entry.output];
  const nums = vals.filter(v => v !== null && v !== undefined && v !== '')
    .map(v => Number(v)).filter(Number.isFinite);
  if (nums.length && nums.every(n => n === 0)) return true;
  return false;
}

function providerLimitInfo(baseUrl, model, free) {
  const p = detectProviderForModel(model, baseUrl);
  const data = {
    opencode: { rpm: 30, rpd: 'varies', notes: 'go key: zen free via zen/v1; deepseek/nemotron 401 credits, most *-free 429 on quota' },
    groq: { rpm: 30, tpm: 12000, notes: 'free tier 12000 tpm shared; 70b->429 on RAG, use 8b/instant' },
    nvidia: { rpm: 32, notes: 'free key: worker request limit 35/32; nemotron-ultra 503, use llama-3.1-8b' },
    openai: { rpm: 'varies', notes: 'paid per-usage / tier rate limits' },
    anthropic: { rpd: 'varies', notes: 'paid; 429 on usage tier' },
    deepseek: { rpm: 'varies', notes: 'provider quota and balance apply' },
    cohere: { rpm: 'varies', notes: 'provider quota and account tier apply' },
    omniroute: { notes: 'local gateway limits, routing policy, and upstream provider quotas apply' },
    openrouter: { rpm: free ? 20 : null, rpd: free ? 50 : null, notes: free ? 'free models: 20/min 50/day; 402 = no balance' : 'paid per-usage' },
    auto: { notes: 'unknown provider — check provider console' }
  };
  return data[p] || data.auto;
}

async function fetchModelList(baseUrl, env, apiKey) {
  const root = cleanApiBase(baseUrl);
  if (!root) return null;
  // The live /models endpoint is the source of truth for WHAT exists: zen and
  // zen/go expose different catalogs, and third-party catalogs lag behind
  // (removed models listed, new ones missing). Metadata (name, cost, context)
  // comes from models.dev when available, matched by exact id — it never adds
  // or keeps a model the endpoint no longer serves.
  let live = null;
  const url = `${root}/models`;
  try {
    const endpoint = new URL(url.startsWith('http') ? url : `https://${url}`);
    if (await isAllowedAiEndpoint(endpoint, env)) {
      const headers = {};
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const res = await fetchWithTimeout(endpoint.toString(), {
        headers, env, allowPrivate: isLocalAiEndpoint(endpoint, env)
      }, 5000);
      if (res.ok) {
        const data = await res.json().catch(() => null);
        const raw = Array.isArray(data?.data) ? data.data
          : Array.isArray(data?.models) ? data.models
          : Array.isArray(data) ? data : null;
        if (raw) {
          live = raw.map((e) => {
            if (typeof e === 'string') return { id: e.trim() };
            if (!e || typeof e !== 'object') return null;
            const id = String(e.id || e.model || e.name || '').trim();
            return id ? { ...e, id } : null;
          }).filter(Boolean);
        }
      }
    }
  } catch (_) {}
  // OpenRouter's router is a valid model even when the catalog endpoint omits
  // virtual/router entries. Keep it selectable and classify it as free.
  if (hostMatches(root, 'openrouter.ai') && live && !live.some((e) => String(e.id).toLowerCase() === 'openrouter/free')) {
    live.push({
      id: 'openrouter/free',
      name: 'OpenRouter Free Router',
      description: 'Routes each request to a compatible free OpenRouter model.',
      pricing: { prompt: '0', completion: '0' }
    });
  }
  let meta = null;
  if (root.includes('opencode.ai')) {
    try {
      const devUrl = 'https://models.dev/api.json';
      if (await isSafeExternalUrl(new URL(devUrl), env)) {
        const res = await fetchWithTimeout(devUrl, { env }, 5000);
        if (res.ok) {
          const data = await res.json().catch(() => null);
          const models = data?.opencode?.models;
          if (models && typeof models === 'object') meta = models;
        }
      }
    } catch (_) {}
  }
  if (live && meta) {
    return live.map((e) => {
      const m = meta[e.id];
      return m ? { ...e, name: e.name || m.name, cost: e.cost || m.cost, limit: e.limit || m.limit } : e;
    });
  }
  if (live) return live;
  if (meta) {
    const list = Object.entries(meta).map(([id, m]) => ({ id, ...m }));
    if (list.length) return list;
  }
  return null;
}

function hostMatches(baseUrl, domain) {
  try {
    const raw = String(baseUrl||'').trim();
    if (!raw) return false;
    const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    const h = u.hostname.toLowerCase();
    return h === domain || h.endsWith(`.${domain}`);
  } catch { return false; }
}
function detectProviderForModel(model, baseUrl) {
  const m = String(model||'').toLowerCase();
  if (hostMatches(baseUrl, 'opencode.ai')) return 'opencode';
  if (hostMatches(baseUrl, 'openrouter.ai') || m.startsWith('openrouter/')) return 'openrouter';
  if (hostMatches(baseUrl, 'omniroute') || /:20128(?:\/|$)/i.test(String(baseUrl || ''))) return 'omniroute';
  if (hostMatches(baseUrl, 'groq.com')) return 'groq';
  if (hostMatches(baseUrl, 'anthropic.com')) return 'anthropic';
  if (hostMatches(baseUrl, 'openai.com')) return 'openai';
  if (hostMatches(baseUrl, 'deepseek.com') || m.startsWith('deepseek/')) return 'deepseek';
  if (hostMatches(baseUrl, 'nvidia.com') || m.startsWith('meta/')) return 'nvidia';
  if (hostMatches(baseUrl, 'cohere.ai') || m.startsWith('command-')) return 'cohere';
  if (m.startsWith('openai/') || m.startsWith('gpt-')) return 'openai';
  if (m.startsWith('anthropic/') || m.includes('claude')) return 'anthropic';
  if (m.includes('groq') || m.includes('llama')) return 'groq';
  return 'auto';
}

async function getLiveFreeModels(baseUrl, env, apiKey) {
  const list = await fetchModelList(baseUrl, env, apiKey);
  if (!list) return [];
  return list.filter(e => isModelFreeEntry(e)).map(e => String(e.id||e.model)).filter(Boolean);
}

async function getFallbackChain(baseUrl, env, apiKey, primaryModel) {
  const liveFree = await getLiveFreeModels(baseUrl, env, apiKey);
  const out = [];
  const seen = new Set([String(primaryModel||'').toLowerCase()]);
  for (const m of liveFree) {
    const low = String(m).toLowerCase();
    if (!seen.has(low)) { out.push(m); seen.add(low); }
    if (out.length >= 4) break;
  }
  return out;
}

async function isFreeTierModel(modelId, baseUrl, env, apiKey) {
  const m = String(modelId || '').toLowerCase();
  if (m.includes('free')) return true;
  const root = cleanApiBase(baseUrl);
  if (!root) return false;
  let cache = FREE_MODEL_CACHE.get(root);
  const now = Date.now();
  if (cache && cache.until > now) {
    if (cache.map.has(m)) return cache.map.get(m);
    const slug = m.split('/').pop();
    if (slug && cache.map.has(slug)) return cache.map.get(slug);
    return false;
  }
  const list = await fetchModelList(baseUrl, env, apiKey);
  if (!list) return false;
  const map = new Map();
  for (const entry of list) {
    const id = String(entry.id || entry.model || '').toLowerCase();
    if (!id) continue;
    const free = isModelFreeEntry(entry);
    map.set(id, free);
    const slug = id.split('/').pop();
    if (slug) map.set(slug, free);
  }
  FREE_MODEL_CACHE.set(root, { map, until: now + FREE_MODEL_LIST_TTL_MS });
  if (map.has(m)) return map.get(m);
  const slug = m.split('/').pop();
  if (slug && map.has(slug)) return map.get(slug);
  return false;
}

async function enrichLinksInBackground(env, scope, key, links) {
  await ensureSearchColumns(env);
  const vocab = await recentTagsForScope(env, scope, key);
  let aiConfig = null;
  try { aiConfig = await getInstanceAiConfig(env); } catch (_) {}
  const steroid = await getSteroidMode(env);
  const CONCURRENCY = steroid ? 4 : 1;
  let enrichedLinks = links;
  if (!steroid && links.length > 3) enrichedLinks = links.slice(0, 3);
  let next = 0;
  const run = async () => {
    while (next < enrichedLinks.length) {
      const link = enrichedLinks[next++];
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
        if (!steroid) await new Promise(r => setTimeout(r, 900));
        if (ai) {
          if (ai.title) update.title = ai.title;
          if (ai.description) update.notes = ai.description;
          if (ai.tags?.length) {
            let existingTags = [];
            try { existingTags = Array.isArray(link.tags) ? link.tags : JSON.parse(link.tags || '[]'); } catch (_) {}
            update.tags = [...new Set([...ai.tags, ...existingTags])];
          }
        }
        if (!update.notes && !update.image_url && !update.site_name && !update.tags) continue;
        const metadataVersion = ai?.tags?.length && ai.description ? AI_METADATA_VERSION : 2;
        if (scope === 'personal') {
          await env.DB.prepare(
            `UPDATE personal_links SET title = ?, notes = ?, image_url = ?, site_name = ?, metadata_version = ${metadataVersion}, search_blob = NULL` + (update.tags ? ', tags = ?' : '') + ' WHERE id = ?'
          ).bind(update.title, update.notes, update.image_url, update.site_name, ...(update.tags ? [JSON.stringify(update.tags)] : []), link.id).run();
        } else {
          await env.DB.prepare(
            `UPDATE links SET title = ?, notes = ?, image_url = ?, site_name = ?, metadata_version = ${metadataVersion}, search_blob = NULL` + (update.tags ? ', tags = ?' : '') + ' WHERE id = ?'
          ).bind(update.title, update.notes, update.image_url, update.site_name, ...(update.tags ? [JSON.stringify(update.tags)] : []), link.id).run();
        }
        // Best effort on GitHub storage: the .md entry catches up with the row.
        await storeMutateLink(env, scope, key, link.id, update);
        markMeiliScopeDirty(env, scope, key);
      } catch (_) { /* one bad link must not stall the rest */ }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, run));
}

function queueMissingLinkEnrichment(env, scope, key, rows) {
  const missing = (rows || [])
    .filter(row => row?.url && Number(row.metadata_version || 0) < AI_METADATA_VERSION)
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
async function recentTagsForScope(env, scope, key, limit = 200) {
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

/**
 * AI describe + tag (karakeep-style) for a saved link. Uses the instance AI
 * config; identical link types get identical tags because the prompt is
 * seeded with the community's existing tag vocabulary. Never throws — null
 * means "AI unavailable" and callers fall back to the plain reply.
 * Returns { title, description, tags } or null.
 */
function parseAiDescribeResponse(text) {
  if (!String(text || '').trim()) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(String(text).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim());
  } catch (_) {
    const match = String(text).match(/\{[\s\S]*\}/);
    if (match) { try { parsed = JSON.parse(match[0]); } catch (_) {} }
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const title = String(parsed.title || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const description = String(parsed.description || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  const tags = [];
  for (const t of Array.isArray(parsed.tags) ? parsed.tags : []) {
    const tag = String(t).replace(/^#/, '').trim().toLowerCase().replace(/\s+/g, '-').slice(0, 40);
    if (tag && !tags.includes(tag)) tags.push(tag);
  }
  if (!title && !description && !tags.length) return null;
  return { title, description, tags };
}

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
    const ep = resolveChatEndpoint(baseUrl, cfg.mode || 'openai', model);
    if (!(await isSafeExternalUrl(new URL(ep), env))) return null;
    endpoint = ep;
  } catch (_) { return null; }

  const title = String(meta?.title || '').trim().slice(0, 200);
  const snippet = [meta?.notes, meta?.content]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .join('\n\n')
    .replace(/\s+/g, ' ');
  const vocab = (existingTags || [])
    .map(tag => String(tag).replace(/^#/, '').trim().toLowerCase())
    .filter(tag => tag && !['telegram', 'community', 'personal', 'dump'].includes(tag))
    .filter((tag, index, all) => all.indexOf(tag) === index);
  const mode = (cfg.mode || 'openai').toLowerCase();

  const system = [
    'You are a bookmarking assistant for a link archive.',
    'Translate the title, summary, and tags to English before returning them, even when the source page is in another language.',
    'Return a useful context summary in 1-2 factual English sentences: preserve the question, problem, subject, or decision the page is about, not just the site name.',
    'Return an English title when the source title is not English.',
    'Choose 3-7 short lowercase English tags (no #, no spaces) that describe the content.',
    'Reuse an existing tag exactly whenever it fits; do not invent a synonym for an existing tag.',
    'Derive tags from the extracted page content, title, URL, and existing vocabulary; never use a fixed application taxonomy.',
    'Reply with ONLY one JSON object: {"title": "...", "description": "...", "tags": ["a", "b", "c"]}'
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
  const tryModels = [model, ...(await getFallbackChain(baseUrl, env, cfg.api_key, model))];
  let lastError = null;
  for (let mi=0; mi<tryModels.length; mi++) {
    const curModel = tryModels[mi];
    let payload, headers;
    if (mode === 'anthropic') {
      headers = { 'Content-Type': 'application/json', 'x-api-key': cfg.api_key, 'anthropic-version': '2023-06-01' };
      payload = { model: curModel, max_tokens: maxTok, system, messages: [{ role: 'user', content: user }], stream: false };
    } else if (endpoint.endsWith('/responses')) {
      headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.api_key}` };
      payload = { model: curModel, input: `${system}\n\n${user}`, stream: false };
    } else {
      headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.api_key}` };
      payload = { model: curModel, max_tokens: maxTok, messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ], stream: false, temperature: 0.1 };
    }
    let text = '';
    try {
      if (!endpoint.endsWith('/responses')) payload.stream = true;
      const res = await fetchWithTimeout(endpoint, { method: 'POST', headers, body: JSON.stringify(payload), env }, AI_PROXY_TIMEOUT_MS);
      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        const isRetryable = res.status===429 || res.status===503 || res.status===502 || res.status===500 || res.status===401 || res.status===402;
        const retryAfter = parseInt(res.headers.get('retry-after')||res.headers.get('Retry-After')||'0',10);
        const waitMs = Number.isFinite(retryAfter) && retryAfter>0 ? retryAfter*1000 : 400*(mi+1);
        console.error(`AI link enrichment failed ${curModel} ${res.status}`, errorText.slice(0,180));
        recordAiError({ model: curModel, status: res.status, endpoint, message: `link enrichment: ${errorText.slice(0, 200) || res.statusText}`, source: 'enrichment' });
        if (isRetryable && mi < tryModels.length-1) { await new Promise(r=>setTimeout(r, waitMs)); continue; }
        return null;
      }
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('text/event-stream')) {
        const streamText = await res.text();
        let reasoning = '';
        for (const line of streamText.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payloadLine = line.slice(5).trim();
          if (!payloadLine || payloadLine === '[DONE]') continue;
          try {
            const event = JSON.parse(payloadLine);
            if (mode === 'anthropic') {
              text += String(event.delta?.text || '');
            } else {
              const delta = event.choices?.[0]?.delta || {};
              text += String(delta.content || event.choices?.[0]?.message?.content || '');
              reasoning += String(delta.reasoning_content || delta.reasoning || '');
            }
          } catch (_) {}
        }
        if (!text.trim()) text = reasoning;
      } else {
        const data = await res.json();
        if (mode === 'anthropic') {
          text = String(data?.content?.[0]?.text || '');
        } else if (endpoint.endsWith('/responses')) {
          text = String(data.output_text
            || (Array.isArray(data.output) ? data.output.map(o => Array.isArray(o.content) ? o.content.map(c => c.text || '').join('') : '').join('\n') : '')
            || data.choices?.[0]?.message?.content || '');
        } else {
          const content = data?.choices?.[0]?.message?.content;
          text = typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content.map(part => String(part?.text || part?.content || '')).join('')
              : String(data?.choices?.[0]?.message?.reasoning_content || data?.output_text || JSON.stringify(content || ''));
        }
      }
      return parseAiDescribeResponse(text);
    } catch (err) {
      lastError = err;
      console.error('AI link enrichment request failed', err?.message || err);
      if (mi < tryModels.length-1) continue;
      return null;
    }
  }
  console.error('AI all fallbacks failed', lastError?.message||'');
  return null;
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


// ---- Userbot live-clone daemon (self-host only) ---------------------------
// A stored user session (gramjs) keeps a persistent connection and mirrors
// every new message from followed chats into brains — same capture pipeline
// and rank-aware targets as channel indexing. The session is AES-GCM
// encrypted at rest; /userbot_disconnect deletes it entirely.

async function ensureUserbotTables(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS userbot_accounts (
       label TEXT PRIMARY KEY, api_id TEXT NOT NULL, api_hash_enc TEXT NOT NULL,
       session_enc TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
       last_error TEXT, updated_at BIGINT)`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS userbot_follows (
       chat_id TEXT PRIMARY KEY, label TEXT NOT NULL DEFAULT 'main',
       community_id TEXT NOT NULL, target TEXT NOT NULL DEFAULT 'community',
       created_by TEXT, created_at BIGINT NOT NULL)`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS userbot_errors (
       t BIGINT PRIMARY KEY, label TEXT, chat TEXT, error TEXT)`
  ).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_userbot_errors_t ON userbot_errors(t)').run().catch(() => {});
  // live-DB migration: older installs created userbot_follows without label
  try { await env.DB.prepare("ALTER TABLE userbot_follows ADD COLUMN label TEXT DEFAULT 'main'").run(); } catch (_) {}
  // one-time migration from the old singleton table
  try {
    const legacy = await env.DB.prepare("SELECT * FROM userbot_state WHERE id = 'singleton' AND enabled = 1").first().catch(() => null);
    if (legacy) {
      const have = await env.DB.prepare("SELECT label FROM userbot_accounts WHERE label = 'main'").first().catch(() => null);
      if (!have) {
        await env.DB.prepare(
          `INSERT INTO userbot_accounts (label, api_id, api_hash_enc, session_enc, enabled, updated_at)
           VALUES ('main', ?, ?, ?, 1, ?) ON CONFLICT(label) DO NOTHING`
        ).bind(legacy.api_id, legacy.api_hash_enc, legacy.session_enc, Date.now()).run();
      }
    }
  } catch (_) {}
}

const USERBOT_ACCOUNTS = new Map(); // label -> { client, startedAt }
const USERBOT_STARTING = new Set();
const USERBOT_STATS = new Map(); // chat_id -> {msgs, links, docs, lastAt}

function userbotStat(chatId, field) {
  const s = USERBOT_STATS.get(chatId) || { msgs: 0, links: 0, docs: 0, lastAt: 0 };
  if (field) s[field] += 1;
  s.lastAt = Date.now();
  USERBOT_STATS.set(chatId, s);
}

/** Accepts -100… and bare channel ids — returns a stable key. */
function normalizeTgChatId(id) {
  let s = String(id || '').trim();
  if (/^\d{9,}$/.test(s)) s = `-100${s}`;
  return s;
}

async function userbotLogError(env, label, chatId, error) {
  const msg = String(error?.message || error).slice(0, 300);
  console.error(`[userbot:${label}] ${chatId || '-'}:`, msg);
  try {
    await env.DB.prepare('INSERT INTO userbot_errors (t, label, chat, error) VALUES (?, ?, ?, ?)')
      .bind(Date.now(), String(label || ''), String(chatId || ''), msg).run();
    await env.DB.prepare('DELETE FROM userbot_errors WHERE t < ?').bind(Date.now() - 7 * 86400_000).run().catch(() => {});
  } catch (_) {}
}


async function isForumEnabled(token, chatId, env) {
  // Try bot API first
  try {
    const res = await telegramApi(token, 'getChat', { chat_id: chatId });
    if (res?.result?.is_forum) return true;
  } catch (_) {}
  // Try via userbot session - check forum flag on dialog
  try {
    await ensureUserbotTables(env);
    const { results } = await env.DB.prepare('SELECT label FROM userbot_accounts WHERE enabled=1 LIMIT 1').all();
    if (results?.length) {
      const label = results[0].label;
      const acc = USERBOT_ACCOUNTS.get(label);
      if (acc?.client) {
        try {
          const entity = await acc.client.getEntity(chatId);
          if (entity?.forum) return true;
        } catch (_) {}
      }
    }
  } catch (_) {}
  return false;
}

async function getForumTopicsViaUserbot(env, chatId) {
  try {
    await ensureUserbotTables(env);
    const { results } = await env.DB.prepare('SELECT label FROM userbot_accounts WHERE enabled=1 LIMIT 1').all();
    if (!results?.length) return [];
    const label = results[0].label;
    const acc = USERBOT_ACCOUNTS.get(label);
    if (!acc?.client) return [];
    // Use gramjs raw API: channels.GetForumTopics
    const peer = await acc.client.getInputEntity(chatId);
    const result = await acc.client.invoke(new (await import('telegram/tl')).Api.channels.GetForumTopics({ channel: peer }));
    // result.topics is array of ForumTopic objects
    return (result?.topics || []).map(t => ({
      id: String(t.id),
      title: t.title || `Topic ${t.id}`,
      closed: !!t.closed
    }));
  } catch (e) {
    console.error('[forum] get topics failed', e?.message || e);
    return [];
  }
}

function gramjsChatId(message) {
  // gramjs exposes marked ids on message.chatId (-100… for channels/supergroups)
  const id = Number(message?.chatId ?? 0);
  return id ? String(id) : null;
}

/** Mirror one gramjs message into the sinks of its follow. */
async function captureGramjsMessage(env, follow, message) {
  const text = String(message.message || '').trim();
  if (text.startsWith('/')) return;
  userbotStat(follow.chat_id, 'msgs');
  const target = CHANNEL_TARGETS.has(follow.target) ? follow.target : 'community';
  const personalOwner = target === 'community' ? null : String(follow.created_by || '');
  const sinks = sinkTargetsFor(target, personalOwner);
  const urls = urlsFromGramjsMessage(message);
  const acc = USERBOT_ACCOUNTS.get(follow.label);

  for (const sink of sinks) {
    try {
      if (sink === 'personal') {
        if (urls.length) {
          const n = await savePersonalIndexedLinks(env, personalOwner, urls, 'userbot', text);
          if (n) { userbotStat(follow.chat_id, 'links'); for (let i=0;i<n;i++) userbotStat(follow.chat_id); }
        }
        const media = message.media;
        if (media?.className === 'MessageMediaDocument' && media.document) {
          const docu = media.document;
          const fnameAttr = (docu.attributes || []).find((a) => a.className === 'MessageAttributeFilename');
          const filename = fnameAttr?.fileName || '';
          const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
          if ((DOCUMENT_EXTENSIONS.has(ext) || CONVERTIBLE_EXTENSIONS.has(ext)) && Number(docu.size || 0) <= CONVERT_SOURCE_MAX_BYTES) {
            const buf = await acc.client.downloadMedia(message, {});
            if (buf?.length) {
              await savePersonalIndexedDocument(env, personalOwner, filename, ext, new Uint8Array(buf), `userbot:${follow.chat_id}`, { chatId: follow.chat_id, messageId: message.id });
              userbotStat(follow.chat_id, 'docs');
            }
          }
        }
        if (!urls.length && !message.media && text.length >= 80) {
          const safeName = String(follow.chat_id).replace(/[^\w-]+/g, '_').slice(0, 40);
          const md = `# Userbot clone ${follow.chat_id}\n\n${text}`;
          await savePersonalIndexedDocument(env, personalOwner, `${safeName}_${message.id}.md`, 'md', new TextEncoder().encode(md), `userbot:${follow.chat_id}`, { chatId: follow.chat_id, messageId: message.id });
        }
        continue;
      }
      // community sink
      if (urls.length) {
        const n = await saveIndexedLinks(env, follow.community_id, urls, 'userbot', text, 'channel');
        if (n) { userbotStat(follow.chat_id, 'links'); for (let i=0;i<n;i++) userbotStat(follow.chat_id); }
      }
      const media = message.media;
      if (media?.className === 'MessageMediaDocument' && media.document) {
        const docu = media.document;
        const fnameAttr = (docu.attributes || []).find((a) => a.className === 'MessageAttributeFilename');
        const filename = fnameAttr?.fileName || '';
        const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
        if ((DOCUMENT_EXTENSIONS.has(ext) || CONVERTIBLE_EXTENSIONS.has(ext)) && Number(docu.size || 0) <= CONVERT_SOURCE_MAX_BYTES) {
          const buf = await acc.client.downloadMedia(message, {});
          if (buf?.length) {
            await saveIndexedDocument(env, follow.community_id, filename, ext, new Uint8Array(buf), `userbot:${follow.chat_id}`, { chatId: follow.chat_id, messageId: message.id });
            userbotStat(follow.chat_id, 'docs');
          }
        }
      }
      if (!urls.length && !message.media && text.length >= 80) {
        const safeName = String(follow.chat_id).replace(/[^\w-]+/g, '_').slice(0, 40);
        const md = `# Userbot clone ${follow.chat_id}\n\n${text}`;
        await saveIndexedDocument(env, follow.community_id, `${safeName}_${message.id}.md`, 'md', new TextEncoder().encode(md), `userbot:${follow.chat_id}`, { chatId: follow.chat_id, messageId: message.id });
      }
    } catch (e) {
      await userbotLogError(env, follow.label, follow.chat_id, e);
    }
  }
}

/** Page dialogs until the chat resolves; returns true when visible. */
async function primeEntity(client, chatId, budgetMs = 90_000) {
  const want = normalizeTgChatId(chatId);
  const deadline = Date.now() + budgetMs;
  try { await client.getEntity(want); return true; } catch (_) {}
  let offsetPeer;
  while (Date.now() < deadline) {
    let dialogs;
    try { dialogs = await client.getDialogs({ limit: 200, offsetPeer }); } catch (_) { break; }
    if (!dialogs?.length) break;
    for (const d of dialogs) {
      if (normalizeTgChatId(String(d.id)) === want) return true;
    }
    offsetPeer = dialogs[dialogs.length - 1];
  }
  return false;
}

/** Connect one account by label. Safe to call repeatedly. */
export async function startUserbotAccount(env, label = 'main') {
  if (!isSelfHosted(env)) return { ok: false, reason: 'self-host only' };
  await ensureUserbotTables(env);
  if (USERBOT_ACCOUNTS.has(label)) return { ok: true, already: true };
  if (USERBOT_STARTING.has(label)) return { ok: false, reason: 'starting' };
  USERBOT_STARTING.add(label);
  try {
    const st = await env.DB.prepare('SELECT * FROM userbot_accounts WHERE label = ? AND enabled = 1').bind(label).first();
    if (!st) return { ok: false, reason: 'not configured' };
    let gramjs;
    try { gramjs = await import('telegram'); } catch (_) {
      await env.DB.prepare("UPDATE userbot_accounts SET last_error = 'gramjs not installed', updated_at = ? WHERE label = ?").bind(Date.now(), label).run();
      return { ok: false, reason: 'gramjs missing' };
    }
    const { TelegramClient } = gramjs;
    const { StringSession } = gramjs.sessions;
    const sessionString = await decryptBotToken(env, st.session_enc);
    const apiHash = await decryptBotToken(env, st.api_hash_enc);
    if (!sessionString || !apiHash) {
      await env.DB.prepare("UPDATE userbot_accounts SET last_error = 'decrypt failed', updated_at = ? WHERE label = ?").bind(Date.now(), label).run();
      return { ok: false, reason: 'decrypt failed' };
    }
    const client = new TelegramClient(new StringSession(sessionString), Number(st.api_id) || 0, apiHash, { connectionRetries: 5 });
    await client.connect();
    // Prime entity cache so raw -100… ids resolve for this account.
    try {
      let offsetPeer;
      for (let i = 0; i < 6; i++) {
        const dialogs = await client.getDialogs({ limit: 200, offsetPeer });
        if (!dialogs?.length) break;
        offsetPeer = dialogs[dialogs.length - 1];
      }
    } catch (_) {}
    const DEBUG_UB = String(process.env?.ATHENA_USERBOT_DEBUG || '') === '1';
    const handler = async (message) => {
      let chatId = null;
      try {
        if (!message) return;
        chatId = gramjsChatId(message);
        // peerId fallback when the entity cache lacks the marked id
        if (!chatId) {
          const peer = message.peerId;
          const cidNum = Number(peer?.channelId ?? 0);
          if (peer?.className === 'PeerChannel' && cidNum) chatId = `-100${cidNum}`;
          else if (peer?.className === 'PeerChat' && peer.chatId) chatId = String(-peer.chatId);
        }
        if (!chatId) return;
        const variants = [chatId];
        if (/^-100\d+$/.test(chatId)) variants.push(chatId.slice(4)); // bare channel id
        else if (/^\d{9,}$/.test(chatId)) variants.push(`-100${chatId}`);
        let follow = null;
        for (const v of variants) {
          follow = await env.DB.prepare('SELECT * FROM userbot_follows WHERE chat_id = ? AND label = ?').bind(v, label).first();
          if (follow) break;
        }
        if (DEBUG_UB) console.log(`[userbot:${label}] msg from ${chatId} → ${follow ? 'FOLLOWED' : 'not followed'}`);
        if (!follow) return;
        userbotStat(follow.chat_id, 'msgs');
        await captureGramjsMessage(env, follow, message);
      } catch (e) {
        if (e && typeof e.seconds === 'number') await sleep(Math.min(e.seconds * 1000, 300_000));
        else await userbotLogError(env, label, chatId, e);
      }
    };
    // Raw handler (no event filter): proven to receive channel posts for this
    // session. A keepalive ping keeps Telegram's update stream warm — without
    // periodic requests the socket can go quiet and stop delivering updates.
    client.addEventHandler(handler);
    const ping = async () => {
      try { await client.getDialogs({ limit: 1 }); } catch (_) {}
    };
    ping();
    const keepalive = setInterval(ping, 4 * 60_000);
    keepalive.unref?.();
    USERBOT_ACCOUNTS.set(label, { client, keepalive, startedAt: Date.now() });
    console.log(`[userbot:${label}] connected`);
    return { ok: true };
  } finally {
    USERBOT_STARTING.delete(label);
  }
}

/** Boot-time: connect every enabled account. No-op when none configured. */
export async function startUserbotDaemon(env) {
  if (!isSelfHosted(env)) return { ok: false, reason: 'self-host only' };
  await ensureUserbotTables(env);
  const { results } = await env.DB.prepare('SELECT label FROM userbot_accounts WHERE enabled = 1').all();
  let started = 0;
  for (const r of results || []) {
    const res = await startUserbotAccount(env, r.label);
    if (res.ok && !res.already) started++;
  }
  return { ok: true, started };
}

async function stopUserbotAccount(env, label, deleteRow = true) {
  const acc = USERBOT_ACCOUNTS.get(label);
  if (acc) { try { await acc.client.disconnect(); } catch (_) {} if (acc.keepalive) clearInterval(acc.keepalive); USERBOT_ACCOUNTS.delete(label); }
  if (deleteRow) {
    await env.DB.prepare('DELETE FROM userbot_accounts WHERE label = ?').bind(label).run();
    await env.DB.prepare('DELETE FROM userbot_follows WHERE label = ?').bind(label).run();
  } else {
    await env.DB.prepare('UPDATE userbot_accounts SET enabled = 0, updated_at = ? WHERE label = ?').bind(Date.now(), label).run().catch(() => {});
  }
}

export {
  scrapeViaKage,
  ensureIndexTables,
  runHistoryIndexJob,
  buildSearchBlob,
  cleanApiBase,
  compactAiContext,
  dedupeLinkRows,
  expandServerSearchTerms,
  fuzzyMatchLinks,
  getInstanceAiConfig,
  getSteroidMode,
  isGroundedAiAnswer,
  helpTextForSection,
  isFreeTierModel,
  normalizeModelId,
  parseAiDescribeResponse,
  parseTelegramEditPayload,
  rankLinks,
  resolveChatEndpoint,
  resultLimitClause,
  syncAiConfigToPeer,
  syncSteroidToPeer
};
