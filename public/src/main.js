/**
 * Athena — single bar: Search / Dump / AI
 */
/**
 * Which backend this page talks to.
 *
 * The site is always served from Cloudflare. GOD publishes one backend for the
 * instance and every browser uses it for auth, links, ranks, bans, and storage.
 */
let API_BASE = window.location.origin;
window.getAthenaApiBase = () => API_BASE;

/**
 * Adopt the instance-wide backend chosen by GOD.
 *
 * The default is published by the origin serving this page and read before
 * login, because login itself has to go to the right backend.
 */
async function adoptInstanceBackend() {
  // Remove browser-specific values written by older builds. They must never
  // override the instance-wide backend selected by GOD.
  try { localStorage.removeItem('athena_backend'); } catch (_) {}
  try {
    const res = await fetch(`${window.location.origin}/api/instance/config`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return;
    const data = await res.json();
    const backend = (data.default_backend || '').trim().replace(/\/+$/, '');
    API_BASE = backend || window.location.origin;
  } catch (_) {
    // Unreachable: fall back to this origin rather than blocking startup.
  }
}
const isHosted = !['localhost', '127.0.0.1', ''].includes(window.location.hostname);

document.addEventListener('DOMContentLoaded', () => {
  const state = {
    scope: 'personal',
    mode: 'search', // search | dump | ai | delete
    sessionToken: localStorage.getItem('athena_session') || null,
    currentUser: null,
    communities: [],
    activeCommunity: localStorage.getItem('athena_active_community') || '',
    communityBots: [],
    communityAdmins: [],
    personalLinks: [],
    communityLinks: [],
    personalDocuments: [],
    communityDocuments: [],
    conversationHistory: [],
    notifications: [],
    unreadNotifs: 0,
    hostedMode: isHosted,
    authConfig: null,
    hasSearched: false,
    authReady: false,
    isInstanceOwner: true // until /auth/me says otherwise; empty owner lists = all owners
  };
  function isGod() {
    return !!state.currentUser?.is_god;
  }
  // ai.js only sends per-request AI credentials for GOD — the server rejects
  // them for anyone else.
  window.athenaIsGod = isGod;
  window.getAthenaSessionToken = () => state.sessionToken;
  window.athenaSearchContext = () => ({
    scope: state.scope,
    communityId: state.activeCommunity,
  });
  function canUseAi() {
    // all logged-in ranks; if auth hasn't resolved yet, optimistically allow AI
    // (runAi re-checks with a toast) instead of silently bouncing to Search.
    return true;
  }
  function canEditAiConfig() {
    return !!state.currentUser?.can_ai_config;
  }

  const $ = (id) => document.getElementById(id);
  const authGate = $('authGate');
  const appRoot = $('appRoot');
  const authGateError = $('authGateError');
  const telegramLoginBtn = $('telegramLoginBtn');
  const discordLoginBtn = $('discordLoginBtn');
  const hamburgerBtn = $('hamburgerBtn');
  const sideDrawer = $('sideDrawer');
  const drawerOverlay = $('drawerOverlay');
  const closeDrawerBtn = $('closeDrawerBtn');
  const personalScopeBtn = $('personalScopeBtn');
  const communityScopeBtn = $('communityScopeBtn');
  const scopeSubtitle = $('scopeSubtitle');
  const modeBadgeText = $('modeBadgeText');
  const modePulse = $('modePulse');
  const searchBarBox = $('searchBarBox');
  const searchInput = $('searchInput');
  const clearSearchBtn = $('clearSearchBtn');
  const barActionBtn = $('barActionBtn');
  const uploadActions = $('uploadActions');
  const uploadFileBtn = $('uploadFileBtn');
  const documentFileInput = $('documentFileInput');
  const uploadStatus = $('uploadStatus');
  const iconSearch = $('iconSearch');
  const iconDump = $('iconDump');
  const iconAi = $('iconAi');
  const iconDelete = $('iconDelete');
  const notifBellBtn = $('notifBellBtn');
  const notifBadge = $('notifBadge');
  const notifPanel = $('notifPanel');
  const notifList = $('notifList');
  const closeNotifBtn = $('closeNotifBtn');
  const resultsList = $('resultsList');
  const emptyState = $('emptyState');
  const emptyStateText = $('emptyStateText');
  const resultsMeta = $('resultsMeta');
  const toast = $('toast');
  const aiAnswerCard = $('aiAnswerCard');
  const aiAnswerText = $('aiAnswerText');
  const aiSources = $('aiSources');
  const storageDesc = $('storageDesc');
  const storageProvider = $('storageProvider');
  const githubFields = $('githubFields');
  const githubRepo = $('githubRepo');
  const githubBranch = $('githubBranch');
  const githubToken = $('githubToken');
  const saveStorageBtn = $('saveStorageBtn');
  const syncStorageBtn = $('syncStorageBtn');
  const storageStatus = $('storageStatus');
  const storageGodBadge = $('storageGodBadge');
  const storageSettingsBody = $('storageSettingsBody');
  const userName = $('userName');
  const userEmail = $('userEmail');
  const userAvatar = $('userAvatar');
  const logoutBtn = $('logoutBtn');
  const communitySelect = $('communitySelect');
  const communityDetails = $('communityDetails');
  const botPlatform = $('botPlatform');
  const botUsernameInput = $('botUsernameInput');
  const groupIdInput = $('groupIdInput');
  const groupNameInput = $('groupNameInput');
  const saveBotBindingBtn = $('saveBotBindingBtn');
  const botBindingsList = $('botBindingsList');
  const botStatus = $('botStatus');
  const currentHost = $('currentHost');

  function authHeaders(extra = {}) {
    const h = { ...extra };
    if (state.sessionToken) h.Authorization = `Bearer ${state.sessionToken}`;
    return h;
  }

  async function api(path, options = {}) {
    // Deliberately NOT credentials:'include'. The backend does not send
    // Access-Control-Allow-Credentials, so the browser would block the response
    // outright once the backend is on a different origin. Cross-origin auth
    // travels in the Authorization header; the default ('same-origin') still
    // sends the HttpOnly session cookie when the backend IS this origin.
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...authHeaders(options.headers || {})
      }
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 || data.code === 'AUTH_REQUIRED') {
      clearSession();
      showLoggedOut();
      throw Object.assign(new Error('Login required'), { auth: true });
    }
    return { res, data };
  }

  function clearSession() {
    state.sessionToken = null;
    state.currentUser = null;
    state.conversationHistory = [];
    try { localStorage.removeItem('athena_session'); } catch (_) {}
    // Otherwise a logout inside the Mini App would be undone by CloudStorage on
    // the next open.
    try { window.Telegram?.WebApp?.CloudStorage?.removeItem('athena_session', () => {}); } catch (_) {}
    document.cookie = 'athena_session=; Path=/; Max-Age=0; SameSite=Lax';
  }

  function showLoggedOut() {
    authGate.classList.remove('hidden');
    appRoot.classList.add('hidden');
    sideDrawer.classList.remove('active');
    drawerOverlay.classList.remove('active');
  }

  function showLoggedIn() {
    authGate.classList.add('hidden');
    appRoot.classList.remove('hidden');
  }

  function showToast(message, isWarning = false) {
    toast.textContent = message;
    toast.style.borderColor = isWarning ? 'var(--warning-color)' : 'var(--border-highlight)';
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), 3500);
  }

  function escapeHtml(str) {
    return (str || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * Escaping alone does not make a URL safe to put in href — `javascript:` survives it
   * untouched and runs in our origin (where the session token lives) on click.
   * Anyone who can save or edit a link controls this string, so allow navigable
   * schemes only.
   */
  function safeHref(url) {
    const raw = String(url || '').trim();
    if (!raw) return '#';
    // Browsers ignore control chars/whitespace when parsing a scheme, so
    // "java\tscript:alert(1)" is still javascript:. Strip them before testing.
    const probe = raw.replace(/[\x00-\x20]/g, '').toLowerCase();
    if (/^(https?|mailto|tel):/.test(probe)) return escapeHtml(raw);
    if (/^[a-z][a-z0-9+.-]*:/.test(probe)) return '#'; // any other explicit scheme
    return escapeHtml(raw); // relative/scheme-less
  }

  function normalizeLink(row) {
    let tags = row.tags || [];
    if (typeof tags === 'string') {
      try { tags = JSON.parse(tags); } catch (_) {
        tags = tags.split(',').map(t => t.trim()).filter(Boolean);
      }
    }
    let title = row.title || row.url || 'Note';
    const url = row.url || '';
    // Prefer plain URL over "Link from Telegram (Name)" style titles
    if (/^link from telegram/i.test(title) || title.startsWith('Telegram ·')) {
      try {
        const u = new URL(url.startsWith('http') ? url : `https://${url}`);
        title = u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, '');
      } catch (_) {
        title = url || title;
      }
    }
    // Hide noisy telegram meta notes in SERP
    let notes = row.notes || '';
    if (/^telegram\s*·/i.test(notes) || /^shared by /i.test(notes) || /^proposed by /i.test(notes)) {
      notes = '';
    }
    return {
      id: row.id,
      title,
      url,
      notes,
      tags: Array.isArray(tags) ? tags : [],
      createdAt: row.createdAt || row.created_at || Date.now(),
      hash: row.url_hash || row.hash,
      imageUrl: row.image_url || row.imageUrl || '',
      siteName: row.site_name || row.siteName || '',
      addedBy: row.added_by_name || row.addedBy || row.added_by || '',
      addedByProvider: row.added_by_provider || row.addedByProvider || '',
      addedByUserId: row.added_by_user_id || '',
      upvotes: row.upvotes || 0,
      downvotes: row.downvotes || 0,
      myVote: row.my_vote || 0
    };
  }

  function normalizeDocument(row) {
    const filename = row.filename || row.name || 'Untitled document';
    const extension = filename.includes('.') ? filename.split('.').pop().toLowerCase() : 'txt';
    return {
      id: row.id,
      type: 'document',
      isDocument: true,
      title: row.title || filename,
      filename,
      mimeType: row.mime_type || row.mimeType || row.content_type || row.contentType || `${extension} text`,
      content: String(row.content || row.text || ''),
      createdAt: row.createdAt || row.created_at || Date.now(),
      addedBy: row.added_by_name || row.addedBy || row.added_by || '',
      addedByProvider: row.added_by_provider || row.addedByProvider || ''
    };
  }

  function formatDateTime(ts) {
    try {
      const d = new Date(ts);
      return d.toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
    } catch (_) {
      return '';
    }
  }

  function providerLabel(p) {
    if (!p) return '';
    const x = String(p).toLowerCase();
    if (x.includes('telegram')) return 'Telegram';
    if (x.includes('discord')) return 'Discord';
    return p;
  }

  function corpus() {
    return state.scope === 'community'
      ? [...state.communityLinks, ...state.communityDocuments]
      : [...state.personalLinks, ...state.personalDocuments];
  }

  // ---- Auth ----

  /**
   * Telegram CloudStorage — the only storage that survives a Mini App closing.
   *
   * The WebView wipes localStorage and cookies when the user swipes the Mini App
   * away, which is why the session had to be re-established every time.
   * CloudStorage is held by Telegram against the user's account, so it survives
   * closing, reinstalls, and switching devices. It also sidesteps the fact that
   * a SameSite=Lax cookie is never sent when the frontend and backend are on
   * different origins, which is the case once a self-hosted backend is selected.
   *
   * Available from Bot API 6.9; callers fall back silently on older clients.
   */
  function tgCloud() {
    const tg = window.Telegram?.WebApp;
    if (!tg?.CloudStorage) return null;
    try { if (tg.isVersionAtLeast && !tg.isVersionAtLeast('6.9')) return null; } catch (_) {}
    return tg.CloudStorage;
  }

  function cloudGet(key) {
    const cs = tgCloud();
    if (!cs) return Promise.resolve(null);
    return new Promise(resolve => {
      let done = false;
      const finish = v => { if (!done) { done = true; resolve(v); } };
      try { cs.getItem(key, (err, value) => finish(err ? null : (value || null))); }
      catch (_) { finish(null); }
      setTimeout(() => finish(null), 3000); // never hang the boot on a slow client
    });
  }

  function cloudSet(key, value) {
    const cs = tgCloud();
    if (!cs) return Promise.resolve(false);
    return new Promise(resolve => {
      let done = false;
      const finish = v => { if (!done) { done = true; resolve(v); } };
      try { cs.setItem(key, value, err => finish(!err)); } catch (_) { finish(false); }
      setTimeout(() => finish(false), 3000);
    });
  }

  /** Persist the session everywhere that might survive, best-effort. */
  async function persistSession(token) {
    state.sessionToken = token;
    try { localStorage.setItem('athena_session', token); } catch (_) {}
    await cloudSet('athena_session', token);
  }

  async function tryTelegramWebAppLogin() {
    try {
      const tg = window.Telegram?.WebApp;
      if (!tg) return { ok: false, reason: 'not_in_telegram' };
      try { tg.ready(); } catch (_) {}
      try { tg.expand(); } catch (_) {}
      // Telegram's in-app BROWSER exposes window.Telegram.WebApp but leaves
      // initData empty — only a real Mini App gets it. Bail out quietly so the
      // user sees the normal login buttons instead of a signature error about
      // data that was never sent.
      const initData = tg.initData || '';
      if (!initData) return { ok: false, reason: 'no_init_data' };
      // No credentials:'include' — see api(); the backend sends no
      // Allow-Credentials, so it would make this call fail cross-origin.
      const res = await fetch(`${API_BASE}/api/auth/telegram/webapp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success || !data.session) {
        if (data.code === 'SITE_BANNED' || data.error) {
          showAuthError(data.error || 'You are banned from all communities');
        }
        return { ok: false, reason: 'api', error: data.error };
      }
      await persistSession(data.session);
      if (data.user) {
        state.currentUser = data.user;
        state.isInstanceOwner = !!data.user.is_god;
        state.isElevated = !!data.user.is_elevated;
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: 'exception', error: e.message };
    }
  }

  async function loadAuthConfig() {
    try {
      const res = await fetch(`${API_BASE}/api/auth/config`);
      state.authConfig = await res.json();
    } catch (_) {
      state.authConfig = {};
    }
    const cfg = state.authConfig || {};
    if (cfg.telegramEnabled && telegramLoginBtn) {
      telegramLoginBtn.disabled = false;
      telegramLoginBtn.onclick = async () => {
        const wa = await tryTelegramWebAppLogin();
        if (wa && wa.ok) {
          showLoggedIn();
          updateUserUI();
          await bootstrapAppData();
          return;
        }
        const url = `${API_BASE}/api/auth/telegram`;
        const tg = window.Telegram?.WebApp;
        // Only use tg.openLink in a true Mini App (initData present) — in TG browser it opens external browser
        if (tg?.openLink && tg?.initData) {
          try { tg.openLink(url); return; } catch (_) {}
        }
        window.location.assign(url);
      };
    }
    if (cfg.discordEnabled && discordLoginBtn) {
      discordLoginBtn.disabled = false;
      discordLoginBtn.onclick = () => { window.location.assign(`${API_BASE}/api/auth/discord`); };
    }
  }

  function showAuthError(msg) {
    authGateError.textContent = msg;
    authGateError.classList.remove('hidden');
  }

  async function restoreSession() {
    const params = new URLSearchParams(window.location.search);
    const fromOAuth = params.get('session');
    const authErr = params.get('auth_error');
    const joinId = params.get('join');
    if (joinId) {
      localStorage.setItem('athena_pending_join', joinId.trim());
    }
    if (authErr) {
      const hints = {
        telegram_state: 'Login session expired or was reused. Close extra tabs and click Continue with Telegram once.',
        telegram_state_expired: 'Login took too long. Click Continue with Telegram again.',
        telegram_state_store: 'Could not start login (server). Try again in a moment.',
        telegram_token: 'Telegram rejected the login token. Check TELEGRAM_CLIENT_ID/SECRET match ProjectAthena bot.',
        telegram_jwt: 'Telegram ID token invalid. Check bot OIDC domain settings.',
        telegram_config: 'Telegram login is not configured on the server.',
        telegram_missing: 'Telegram did not return a full login response. Try again.',
        discord_state: 'Login session expired or was started in another browser. Click Continue with Discord once, in this tab.',
        discord_state_store: 'Could not start login (server). Try again in a moment.',
        banned: 'You are banned from all communities (no remaining memberships). If you still belong to another community, contact support — otherwise rejoin a group then /community_join <id>.'
      };
      showAuthError(hints[authErr] || `Login failed (${authErr})`);
      history.replaceState({}, '', window.location.pathname);
    }
    if (fromOAuth) {
      // Keep the OAuth token in memory and in the address bar for the TUI.
      // The backend also set an HttpOnly cookie for the website session; do not
      // copy this bearer credential into browser storage.
      state.sessionToken = fromOAuth;
      // Keep ?session= in the address bar on purpose: terminal clients
      // (athena-tui) log in via this URL and must be able to copy the token.
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(fromOAuth).then(
          () => showToast('Session ready — token copied. Paste it into athena-tui.'),
          () => showToast('Session ready — copy the session= token from the address bar.')
        );
      } else {
        showToast('Session ready — copy the session= token from the address bar.');
      }
    }
    // Cookie fallback. Only useful same-origin: a SameSite=Lax cookie is not
    // sent on cross-site requests, so this does nothing once a self-hosted
    // backend is selected — CloudStorage below is what actually covers that.
    if (!state.sessionToken) {
      const m = document.cookie.match(/(?:^|;\s*)athena_session=([^;]+)/);
      if (m) {
        state.sessionToken = decodeURIComponent(m[1]);
        try { localStorage.setItem('athena_session', state.sessionToken); } catch (_) {}
      }
    }

    // Telegram CloudStorage: survives the Mini App being closed, which wipes
    // both localStorage and cookies.
    if (!state.sessionToken) {
      const cloud = await cloudGet('athena_session');
      if (cloud) {
        state.sessionToken = cloud;
        try { localStorage.setItem('athena_session', cloud); } catch (_) {}
      }
    }
    if (!state.sessionToken) {
      // No token anywhere — still try the API (cookie may be sent by browser)
      try {
        const { res, data } = await api('/api/auth/me');
        if (res.ok && data.user) {
          state.currentUser = data.user;
          state.isInstanceOwner = !!data.user.is_god;
          state.isElevated = !!data.user.is_elevated;
          showLoggedIn();
          updateUserUI();
          return true;
        }
      } catch (_) {}
      showLoggedOut();
      return false;
    }
    try {
      const { res, data } = await api('/api/auth/me');
      if (!res.ok || !data.user) {
        // Only a genuine auth rejection may destroy the session. A 500 or 502
        // means the BACKEND is unhappy, not that the user is signed out, and
        // throwing the token away would force a fresh login over a hiccup.
        if (res.status === 401 || res.status === 403) {
          clearSession();
          showLoggedOut();
          if (data?.code === 'SITE_BANNED' || res.status === 403) {
            showAuthError(data?.error || 'You are banned. Rejoin the Telegram group, login, then /community_join <id>.');
          }
          return false;
        }
        showLoggedOut();
        showAuthError(`Backend returned ${res.status}. Your login is still saved — retry, or check Settings → Backend.`);
        return false;
      }
      state.currentUser = data.user;
      state.isInstanceOwner = !!data.user.is_god;
      state.isElevated = !!data.user.is_elevated;
      showLoggedIn();
      updateUserUI();
      return true;
    } catch (err) {
      // Network/CORS/DNS failure — the session is almost certainly still valid.
      // Keep it so a reload recovers instead of demanding a fresh login every
      // time the backend blinks. This is far more likely with a cross-origin
      // self-hosted backend than it ever was same-origin.
      console.warn('[athena] /api/auth/me unreachable:', err);
      showLoggedOut();
      showAuthError('Could not reach the backend. Your login is saved — reload to retry, or switch backend in Settings.');
      return false;
    }
  }

  async function processPendingJoin() {
    const joinId = (localStorage.getItem('athena_pending_join') || '').trim()
      || new URLSearchParams(window.location.search).get('join') || '';
    if (!joinId) return;
    localStorage.removeItem('athena_pending_join');
    if (window.location.search.includes('join=')) {
      history.replaceState({}, '', window.location.pathname);
    }
    try {
      const { res, data } = await api('/api/communities/join', {
        method: 'POST',
        body: JSON.stringify({ community_id: joinId })
      });
      if (!res.ok || !data.success) {
        showToast(data.error || 'Could not join community', true);
        return;
      }
      state.activeCommunity = data.community?.id || joinId;
      localStorage.setItem('athena_active_community', state.activeCommunity);
      state.scope = 'community';
      await loadCommunities();
      updateScopeUI();
      await Promise.all([loadCommunityLinksIfAny(), loadCommunityDocumentsIfAny()]);
      showToast(data.already_member
        ? `Already in ${data.community?.name || 'community'}`
        : `Joined ${data.community?.name || 'community'}`);
    } catch (err) {
      if (!err.auth) showToast(err.message || 'Join failed', true);
    }
  }

  function updateUserUI() {
    const u = state.currentUser;
    if (!u) return;
    state.isInstanceOwner = isGod();
    userName.textContent = u.displayName || u.username;
    const roleTag = isGod() ? ' · GOD' : (state.isElevated ? ' · staff' : ' · member');
    userEmail.textContent = `${u.provider || 'oauth'} · @${u.username}${roleTag}`;
    userAvatar.textContent = (u.displayName || u.username || '?').charAt(0).toUpperCase();
    if (u.avatarUrl) {
      userAvatar.style.backgroundImage = `url(${u.avatarUrl})`;
      userAvatar.style.backgroundSize = 'cover';
      userAvatar.textContent = '';
    }
    applyRoleUI();
  }

  function applyRoleUI() {
    const god = isGod();
    const aiOk = canUseAi();
    const aiCfg = canEditAiConfig();
    const wipeWrap = $('wipePersonalWrap');
    const wipeBtn = $('wipePersonalBtn');
    if (wipeWrap) {
      wipeWrap.classList.toggle('hidden', !god);
      wipeWrap.style.display = god ? 'block' : 'none';
    }
    if (wipeBtn) {
      wipeBtn.disabled = !god;
      wipeBtn.style.display = god ? 'block' : 'none';
      wipeBtn.style.opacity = god ? '1' : '0.45';
      wipeBtn.title = god ? 'Wipe your personal links (GOD)' : 'GOD rank only';
    }
    const aiBody = $('aiSettingsBody');
    const aiLock = $('aiLockBadge');
    const aiDesc = $('aiSettingsDesc');
    const aiPill = $('aiModePill');
    if (aiBody) {
      aiBody.classList.toggle('ui-locked', !aiCfg);
      aiBody.querySelectorAll('input, select, button').forEach(el => { el.disabled = !aiCfg; });
    }
    if (aiLock) aiLock.classList.toggle('hidden', aiCfg);
    if (aiDesc) {
      aiDesc.textContent = aiCfg
        ? 'GOD: set instance AI credentials (used by all ranks on site + /ai).'
        : 'AI chat is available. Credentials are set by GOD rank only (read-only here).';
    }
    if (aiPill) {
      aiPill.classList.toggle('mode-pill-locked', !aiOk);
      aiPill.title = 'AI (all ranks)';
    }
    // Bot section visible to all; editable GOD only
    const botSec = $('botSettingsSection');
    const botBody = $('botSettingsBody');
    const botBadge = $('botGodBadge');
    const botDesc = $('botSettingsDesc');
    if (botSec) botSec.classList.remove('hidden');
    if (botBody) {
      botBody.classList.toggle('ui-locked', !god);
      botBody.querySelectorAll('input, select, button').forEach(el => { el.disabled = !god; });
    }
    if (botBadge) botBadge.classList.toggle('hidden', god);
    if (botDesc) {
      botDesc.textContent = god
        ? 'GOD: register Telegram bot (token + DM /id). Communities: /community_verify in group.'
        : 'Read-only. Only GOD rank can add or change the bot.';
    }
    if (personalScopeBtn) {
      personalScopeBtn.classList.toggle('scope-locked', !god);
      personalScopeBtn.title = god ? 'Personal' : 'Personal locked — GOD rank only';
      if (!god && state.scope === 'personal') {
        state.scope = 'community';
        updateScopeUI();
      }
    }
    const backendInput = $('backendUrl');
    if (backendInput) backendInput.disabled = !god;
    $('defaultBackendBtn')?.classList.toggle('hidden', !god);
  }

  /**
   * Load everything the app needs after login.
   *
   * Each step is isolated. Previously these were awaited bare, so a single
   * failure — loadCommunities throwing on a network blip, or a backend that is
   * momentarily unreachable — aborted the rest of the function. The user ended
   * up authenticated and looking at the app shell with no mode set, nothing
   * rendered and no live sync: logged in, but the site never actually opened.
   * A failed section should cost you that section, not the whole app.
   */
  async function bootstrapAppData() {
    if (currentHost) currentHost.textContent = window.location.host;

    const failures = [];
    const step = async (name, fn) => {
      try { await fn(); } catch (err) {
        failures.push(name);
        console.warn(`[athena] ${name} failed:`, err);
      }
    };

    await step('ai settings', () => loadAiForm());
    await step('storage settings', () => loadStorageForm());
    await step('pending join', () => processPendingJoin());
    await step('communities', () => loadCommunities());
    await step('corpus', () => Promise.all([loadPersonalLinks(), loadCommunityLinksIfAny(), loadPersonalDocuments(), loadCommunityDocumentsIfAny()]));
    await step('bot bindings', () => loadCommunityBots());
    await step('community admins', () => loadCommunityAdmins());
    await step('notifications', () => loadNotifications());

    // These must run even if every fetch above failed, or there is no usable UI.
    try {
      // don't yank the user out of AI mode while data is still loading
      const initialMode = state.mode && state.mode !== 'search' ? state.mode : 'search';
      setMode(initialMode);
      updateScopeUI();
      renderHome();
      startLiveSync();
    } catch (err) {
      console.error('[athena] render failed:', err);
    }

    if (failures.length) {
      showToast(`Some data did not load (${failures.join(', ')}). Check Settings → Backend.`, true);
    }
  }

  // Poll D1 so Telegram dumps appear on the site without manual refresh
  let liveSyncTimer = null;
  let liveSyncBusy = false;
  let liveSyncListenersBound = false;
  let lastSyncFingerprint = '';
  function corpusFingerprint() {
    const p = state.personalLinks || [];
    const c = state.communityLinks || [];
    const pd = state.personalDocuments || [];
    const cd = state.communityDocuments || [];
    const newest = list => list.reduce((m, x) => Math.max(m, Number(x.created_at || x.createdAt || 0)), 0);
    return `${p.length}:${newest(p)}:${pd.length}:${newest(pd)}|${c.length}:${newest(c)}:${cd.length}:${newest(cd)}|${state.activeCommunity || ''}`;
  }
  async function refreshLiveData(opts = {}) {
    // No sessionToken check: a same-origin login authenticates with the HttpOnly
    // cookie alone, so currentUser is the only reliable signal.
    if (!state.currentUser) return;
    if (liveSyncBusy) return;
    liveSyncBusy = true;
    try {
      await Promise.all([
        loadPersonalLinks().catch(() => {}),
        loadCommunityLinksIfAny().catch(() => {}),
        loadPersonalDocuments().catch(() => {}),
        loadCommunityDocumentsIfAny().catch(() => {}),
        loadNotifications().catch(() => {})
      ]);
      const fp = corpusFingerprint();
      const changed = fp !== lastSyncFingerprint;
      lastSyncFingerprint = fp;
      if (changed || opts.forceUi) {
        if (state.mode === 'search') {
          if (state.hasSearched && searchInput.value.trim()) runSearch();
          else renderHome();
        }
      }
    } finally {
      liveSyncBusy = false;
    }
  }
  function startLiveSync() {
    if (liveSyncTimer) clearInterval(liveSyncTimer);
    lastSyncFingerprint = corpusFingerprint();
    // 5s poll — Telegram dumps show on site without full page reload
    liveSyncTimer = setInterval(() => refreshLiveData(), 5000);
    if (!liveSyncListenersBound) {
      liveSyncListenersBound = true;
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') refreshLiveData({ forceUi: true });
      });
      window.addEventListener('focus', () => refreshLiveData({ forceUi: true }));
    }
  }

  async function loadNotifications() {
    try {
      const { data } = await api('/api/notifications');
      state.notifications = data.notifications || [];
      state.unreadNotifs = data.unread || 0;
      updateNotifBadge();
    } catch (_) {
      state.notifications = [];
      state.unreadNotifs = 0;
    }
  }

  function updateNotifBadge() {
    if (!notifBadge) return;
    if (state.unreadNotifs > 0) {
      notifBadge.textContent = String(state.unreadNotifs > 99 ? '99+' : state.unreadNotifs);
      notifBadge.classList.remove('hidden');
    } else {
      notifBadge.classList.add('hidden');
    }
  }

  function renderNotifications() {
    if (!notifList) return;
    notifList.innerHTML = '';
    if (!state.notifications.length) {
      notifList.innerHTML = '<p class="status-msg">No notifications</p>';
      return;
    }
    // Bulk actions header
    const bulkActions = document.createElement('div');
    bulkActions.className = 'notif-bulk-actions';
    bulkActions.innerHTML = `
      <button type="button" class="btn btn-secondary btn-sm" id="notifReadAll">Read All</button>
      <button type="button" class="btn btn-danger btn-sm" id="notifDeleteAll">Delete All</button>
    `;
    notifList.appendChild(bulkActions);

    state.notifications.forEach(n => {
      const el = document.createElement('div');
      el.className = 'notif-item' + (n.read ? '' : ' unread');
      const payload = n.payload || {};
      el.innerHTML = `
        <div class="notif-title">${escapeHtml(n.title)}</div>
        <div class="notif-body">${escapeHtml(n.body || '')}</div>
        <div class="notif-time">${formatDateTime(n.created_at)}</div>
        <div class="notif-actions">
          ${payload.can_delete && payload.link_id ? `<button type="button" class="btn btn-danger btn-sm notif-del-link" data-id="${escapeHtml(n.id)}">Delete link</button>` : ''}
          <button type="button" class="btn btn-secondary btn-sm notif-dismiss" data-id="${escapeHtml(n.id)}">Dismiss</button>
        </div>
      `;
      notifList.appendChild(el);
    });

    // Wire up bulk actions
    const readAllBtn = notifList.querySelector('#notifReadAll');
    const deleteAllBtn = notifList.querySelector('#notifDeleteAll');
    if (readAllBtn) {
      readAllBtn.addEventListener('click', async () => {
        await api('/api/notifications', {
          method: 'POST',
          body: JSON.stringify({ action: 'read_all' })
        });
        await loadNotifications();
        renderNotifications();
      });
    }
    if (deleteAllBtn) {
      deleteAllBtn.addEventListener('click', async () => {
        if (!confirm('Delete all notifications?')) return;
        await api('/api/notifications', {
          method: 'POST',
          body: JSON.stringify({ action: 'delete_all' })
        });
        await loadNotifications();
        renderNotifications();
      });
    }

    notifList.querySelectorAll('.notif-del-link').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this reported link from the community brain?')) return;
        await api('/api/notifications', {
          method: 'POST',
          body: JSON.stringify({ id: btn.dataset.id, action: 'delete_link' })
        });
        showToast('Link deleted from community DB');
        await loadNotifications();
        await loadCommunityLinksIfAny();
        renderNotifications();
        if (state.mode === 'search' && searchInput.value.trim()) runSearch();
      });
    });
    notifList.querySelectorAll('.notif-dismiss').forEach(btn => {
      btn.addEventListener('click', async () => {
        await api('/api/notifications', {
          method: 'POST',
          body: JSON.stringify({ id: btn.dataset.id, action: 'dismiss' })
        });
        await loadNotifications();
        renderNotifications();
      });
    });
  }

  function renderCommunityDetails() {
    if (!communityDetails) return;
    const c = state.communities.find(x => x.id === state.activeCommunity);
    if (!c) {
      communityDetails.innerHTML = 'No community selected. In Telegram: owner runs <code>/community_verify</code> in a group.';
      return;
    }
    communityDetails.innerHTML = [
      `<strong>${escapeHtml(c.name)}</strong>`,
      `id: <code>${escapeHtml(c.id)}</code>`,
      c.group_id ? `group: ${escapeHtml(c.group_name || c.group_id)}` : '',
      `links: ${c.link_count ?? '—'} · admins: ${c.admin_count ?? '—'}`,
      c.topic_id ? `topic lock: ${escapeHtml(String(c.topic_id))}` : 'topic lock: OFF',
      c.bot_username ? `bot: @${escapeHtml(c.bot_username)}` : '',
      `role: ${escapeHtml(c.role || 'member')}`
    ].filter(Boolean).join('<br>');
  }

  async function loadCommunityAdmins() {
    const list = $('adminsList');
    if (!list) return;
    list.innerHTML = '';
    renderCommunityDetails();
    if (!state.activeCommunity) return;
    try {
      const { data } = await api(`/api/community-admins?community_id=${encodeURIComponent(state.activeCommunity)}`);
      state.communityAdmins = data.admins || [];
      if (!state.communityAdmins.length) {
        list.innerHTML = '<p class="status-msg">Admins: reply to a user with /admin in the group</p>';
        return;
      }
      state.communityAdmins.forEach(a => {
        const row = document.createElement('div');
        row.className = 'bot-binding-item';
        row.innerHTML = `<div><strong>${escapeHtml(a.platform)}</strong> ${escapeHtml(a.platform_user_id)}
          <div class="muted">${escapeHtml(a.label || '')}</div></div>`;
        list.appendChild(row);
      });
    } catch (_) {
      list.innerHTML = '';
    }
  }

  // ---- Data ----

  function isCommunityStaff() {
    if (state.scope !== 'community') return true; // personal: always allowed
    if (!state.activeCommunity) return false;
    const c = state.communities.find(x => x.id === state.activeCommunity);
    return !!(c && (c.is_staff || c.role === 'owner' || c.role === 'admin'));
  }

  function updateDeleteModeVisibility() {
    const delPill = document.querySelector('.mode-pill[data-mode="delete"]');
    if (!delPill) return;
    const allow = state.scope === 'personal' || isCommunityStaff();
    delPill.classList.toggle('hidden', !allow);
    delPill.disabled = !allow;
    if (!allow && state.mode === 'delete') setMode('search');
  }

  async function loadCommunities() {
    const { data } = await api('/api/communities');
    state.communities = data.communities || [];
    if (communitySelect) {
      communitySelect.innerHTML = '<option value="">None (personal)</option>';
      state.communities.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        const bits = [c.name];
        if (c.role) bits.push(`(${c.role})`);
        if (c.link_count != null) bits.push(`${c.link_count} links`);
        opt.textContent = bits.join(' · ');
        if (c.id === state.activeCommunity) opt.selected = true;
        communitySelect.appendChild(opt);
      });
    }
    if (state.activeCommunity && !state.communities.find(c => c.id === state.activeCommunity)) {
      state.activeCommunity = '';
      localStorage.removeItem('athena_active_community');
    }
    renderCommunityDetails();
    updateDeleteModeVisibility();
  }

  async function loadCommunityBots() {
    botBindingsList.innerHTML = '';
    if (botStatus) {
      botStatus.textContent = 'Personal bot only here. Communities: add bot to group → /community_verify';
    }
    try {
      const { data } = await api('/api/bot-bindings');
      state.communityBots = data.bots || [];
    } catch (_) {
      state.communityBots = [];
    }
    const personal = state.communityBots.filter(b => (b.scope || 'personal') === 'personal' || !b.community_id);
    const communityBots = state.communityBots.filter(b => b.community_id && (b.scope || '') === 'community');
    if (!personal.length && !communityBots.length) {
      botBindingsList.innerHTML = '<p class="status-msg">No bot yet. Paste token + DM /id above.</p>';
      return;
    }
    personal.forEach(b => {
      const row = document.createElement('div');
      row.className = 'bot-binding-item';
      row.innerHTML = `
        <div>
          <strong>Personal</strong> @${escapeHtml(b.bot_username || '?')}
          ${b.has_token ? '<span class="plat-tag plat-telegram">token ok</span>' : ''}
          <div class="muted">DM chat: ${escapeHtml(b.group_id)}</div>
        </div>
        <button class="icon-btn bot-del-btn" data-id="${escapeHtml(b.id)}" title="Unlink">&times;</button>`;
      botBindingsList.appendChild(row);
    });
    if (communityBots.length) {
      const head = document.createElement('p');
      head.className = 'status-msg';
      head.textContent = 'Linked communities (via Telegram):';
      botBindingsList.appendChild(head);
      communityBots.forEach(b => {
        const row = document.createElement('div');
        row.className = 'bot-binding-item';
        row.innerHTML = `
          <div>
            <strong>${escapeHtml(b.group_name || 'Community')}</strong>
            <div class="muted">group ${escapeHtml(b.group_id)} · ${escapeHtml(b.community_id || '')}</div>
          </div>`;
        botBindingsList.appendChild(row);
      });
    }
    botBindingsList.querySelectorAll('.bot-del-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        await api('/api/bot-bindings', { method: 'DELETE', body: JSON.stringify({ id: btn.dataset.id }) });
        await loadCommunityBots();
      });
    });
  }

  async function loadPersonalLinks() {
    if (!isGod()) {
      state.personalLinks = [];
      return;
    }
    try {
      const { data } = await api('/api/personal-links');
      state.personalLinks = (data.links || []).map(normalizeLink);
    } catch (err) {
      // The server is the source of truth now; there is no local mirror to fall back on.
      if (!err.auth) console.warn('loadPersonalLinks', err);
    }
  }

  async function loadCommunityLinksIfAny() {
    if (!state.activeCommunity) {
      state.communityLinks = [];
      return;
    }
    try {
      const { data } = await api(`/api/links?community_id=${encodeURIComponent(state.activeCommunity)}`);
      state.communityLinks = (data.links || []).map(normalizeLink);
    } catch (_) {
      state.communityLinks = [];
    }
  }

  async function loadPersonalDocuments() {
    if (!isGod()) {
      state.personalDocuments = [];
      return;
    }
    try {
      const { data } = await api('/api/documents?scope=personal');
      state.personalDocuments = (data.documents || []).map(normalizeDocument);
    } catch (err) {
      if (!err.auth) console.warn('loadPersonalDocuments', err);
    }
  }

  async function loadCommunityDocumentsIfAny() {
    if (!state.activeCommunity) {
      state.communityDocuments = [];
      return;
    }
    try {
      const params = new URLSearchParams({ scope: 'community', community_id: state.activeCommunity });
      const { data } = await api(`/api/documents?${params.toString()}`);
      state.communityDocuments = (data.documents || []).map(normalizeDocument);
    } catch (err) {
      if (!err.auth) console.warn('loadCommunityDocuments', err);
    }
  }

  const DOCUMENT_MAX_BYTES = 512 * 1024;
  const DOCUMENT_EXTENSIONS = new Set([
    'md', 'markdown', 'txt', 'py', 'js', 'ts', 'jsx', 'tsx', 'sh', 'bash', 'zsh', 'fish',
    'css', 'html', 'htm', 'json', 'yaml', 'yml', 'toml', 'xml', 'csv', 'sql', 'go', 'rs',
    'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'php', 'swift', 'kt', 'kts', 'lua', 'r',
    'dart', 'vue', 'svelte', 'ini', 'cfg', 'conf', 'env', 'log'
  ]);

  function validateDocumentFile(file, content) {
    const ext = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
    if (!DOCUMENT_EXTENSIONS.has(ext)) return 'unsupported file type';
    if (file.size > DOCUMENT_MAX_BYTES) return 'larger than 512 KiB';
    if (content.includes('\0')) return 'appears to be binary';
    const sample = content.slice(0, 8192);
    const controls = [...sample].filter(ch => {
      const code = ch.charCodeAt(0);
      return code < 32 && code !== 9 && code !== 10 && code !== 13;
    }).length;
    if (sample.length && controls / sample.length > 0.01) return 'appears to be binary';
    return '';
  }

  async function uploadDocuments(files) {
    if (!files.length) return;
    if (state.scope === 'personal' && !isGod()) return showToast('Personal uploads are GOD only', true);
    if (state.scope === 'community' && !state.activeCommunity) return showToast('Select a community first', true);
    uploadFileBtn.disabled = true;
    let uploaded = 0;
    const rejected = [];
    try {
      for (const file of files) {
        const metadataInvalid = validateDocumentFile(file, '');
        if (metadataInvalid) {
          rejected.push(`${file.name}: ${metadataInvalid}`);
          continue;
        }
        let content;
        try { content = await file.text(); } catch (_) {
          rejected.push(`${file.name}: could not read`);
          continue;
        }
        const invalid = validateDocumentFile(file, content);
        if (invalid) {
          rejected.push(`${file.name}: ${invalid}`);
          continue;
        }
        uploadStatus.textContent = `Uploading ${file.name}…`;
        const payload = {
          filename: file.name,
          mime_type: file.type || 'text/plain',
          content,
          scope: state.scope
        };
        if (state.scope === 'community') payload.community_id = state.activeCommunity;
        try {
          const { res, data } = await api('/api/documents', { method: 'POST', body: JSON.stringify(payload) });
          if (!res.ok || data.success === false) rejected.push(`${file.name}: ${data.error || `HTTP ${res.status}`}`);
          else uploaded++;
        } catch (err) {
          rejected.push(`${file.name}: ${err.message}`);
        }
      }
      if (state.scope === 'community') await Promise.all([loadCommunityLinksIfAny(), loadCommunityDocumentsIfAny()]);
      else await Promise.all([loadPersonalLinks(), loadPersonalDocuments()]);
      if (state.mode === 'search' && searchInput.value.trim()) runSearch();
      else renderHome();
      uploadStatus.textContent = rejected.length ? rejected.join('; ') : '';
      showToast(`${uploaded} document${uploaded === 1 ? '' : 's'} uploaded${rejected.length ? `; ${rejected.length} rejected` : ''}`, rejected.length > 0);
    } finally {
      uploadFileBtn.disabled = false;
      documentFileInput.value = '';
    }
  }

  function parseDumpInput(raw) {
    const text = (raw || '').trim();
    if (!text) return null;
    const urlMatch = text.match(/https?:\/\/[^\s]+/i);
    if (urlMatch) {
      const url = urlMatch[0].replace(/[),.;]+$/, '');
      const rest = text.replace(urlMatch[0], '').trim();
      let title = rest;
      let notes = rest;
      try {
        const u = new URL(url);
        if (!title) title = u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, '');
      } catch (_) {
        if (!title) title = url;
      }
      return { type: 'link', url, title: title || url, notes: notes || '', tags: ['dump'] };
    }
    // plain note
    const title = text.slice(0, 80) + (text.length > 80 ? '…' : '');
    return { type: 'note', url: '', title, notes: text, tags: ['note', 'dump'] };
  }

  async function saveDump(raw) {
    if (state.scope === 'personal' && !isGod()) {
      showToast('Personal dump is GOD only. Join a community first.', true);
      return;
    }
    if (state.scope === 'community' && !state.activeCommunity) {
      showToast('Select a community (join via bot: /community_join <id>)', true);
      return;
    }
    const parsed = parseDumpInput(raw);
    if (!parsed) return;

    if (parsed.url) {
      const list = corpus();
      if (window.Dedupe) {
        const dupe = window.Dedupe.checkDuplicateLink(parsed.url, list.filter(l => l.url));
        if (dupe.isDuplicate) {
          showToast(`Already saved: ${dupe.existingLink.title}`, true);
          return;
        }
      }
    }

    const norm = parsed.url && window.Dedupe
      ? window.Dedupe.normalizeUrl(parsed.url)
      : { canonicalUrl: parsed.url, hash: 'note_' + Date.now().toString(36) };

    const item = {
      id: 'item_' + Date.now().toString(36),
      title: parsed.title,
      url: norm.canonicalUrl || '',
      hash: norm.hash,
      tags: parsed.tags,
      notes: parsed.notes,
      createdAt: Date.now(),
      scope: state.scope
    };

    if (state.scope === 'personal') {
      try {
        const { res, data } = await api('/api/personal-links', {
          method: 'POST',
          body: JSON.stringify({
            url: item.url || `note://${item.id}`,
            title: item.title,
            notes: item.notes,
            tags: item.tags
          })
        });
        if (res.status === 409) {
          showToast(data.error || 'Website is already added', true);
          return;
        }
        if (data.id) item.id = data.id;
        if (data.title) item.title = data.title;
        if (data.notes != null) item.notes = data.notes;
        if (data.image_url) item.imageUrl = data.image_url;
        if (data.site_name) item.siteName = data.site_name;
      } catch (err) {
        if (!err.auth) console.warn(err);
      }
      state.personalLinks.unshift(item);
      showToast(parsed.type === 'link' ? 'Link saved (metadata scraped)' : 'Note saved to brain');
    } else {
      if (!state.activeCommunity) {
        showToast('Select a community in Settings first', true);
        return;
      }
      if (!item.url) {
        showToast('Community dump needs a URL', true);
        return;
      }
      const { res, data } = await api('/api/links', {
        method: 'POST',
        body: JSON.stringify({
          community_id: state.activeCommunity,
          url: item.url,
          title: item.title,
          notes: item.notes,
          tags: item.tags
        })
      });
      if (res.status === 409 || data.duplicate) {
        showToast(data.error || 'Website is already added', true);
        return;
      }
      if (!res.ok || !data.success) {
        showToast(data.error || 'Failed to save', true);
        return;
      }
      if (data.id) item.id = data.id;
      if (data.title) item.title = data.title;
      if (data.notes != null) item.notes = data.notes;
      if (data.image_url) item.imageUrl = data.image_url;
      if (data.site_name) item.siteName = data.site_name;
      item.addedBy = data.added_by_name || state.currentUser?.displayName || state.currentUser?.username;
      item.addedByProvider = data.added_by_provider || state.currentUser?.provider;
      item.createdAt = data.created_at || Date.now();
      state.communityLinks.unshift(item);
      showToast('Saved to community (metadata scraped)');
    }

    searchInput.value = '';
    clearSearchBtn.classList.add('hidden');
    setMode('search');
    renderHome();
  }

  async function runDelete(raw) {
    if (state.scope === 'community' && !isCommunityStaff()) {
      showToast('Only community owner or admins can use Delete mode', true);
      setMode('search');
      return;
    }
    const parsed = parseDumpInput(raw);
    if (!parsed || !parsed.url) {
      showToast('Paste a URL to delete', true);
      return;
    }
    const list = corpus();
    let found = null;
    if (window.Dedupe) {
      const dupe = window.Dedupe.checkDuplicateLink(parsed.url, list.filter(l => l.url));
      if (dupe.isDuplicate) found = dupe.existingLink;
    }
    if (!found) {
      const qa = parsed.url.toLowerCase().replace(/[^a-z0-9]/g, '');
      found = list.find(l => (l.url || '').toLowerCase().replace(/[^a-z0-9]/g, '') === qa);
    }

    if (found) {
      try {
        if (state.scope === 'personal') {
          await api('/api/personal-links', { method: 'DELETE', body: JSON.stringify({ id: found.id }) });
          state.personalLinks = state.personalLinks.filter(l => l.id !== found.id);
        } else {
          const { res, data } = await api('/api/links', {
            method: 'DELETE',
            body: JSON.stringify({ id: found.id, community_id: state.activeCommunity })
          });
          if (!res.ok) {
            showToast(data.error || 'Delete failed', true);
            return;
          }
          state.communityLinks = state.communityLinks.filter(l => l.id !== found.id);
        }
        showToast('Deleted from brain');
      } catch (err) {
        showToast(err.message, true);
        return;
      }
    } else {
      showToast('Was not in DB — adding now');
      await saveDump(parsed.url);
      return;
    }

    searchInput.value = '';
    clearSearchBtn.classList.add('hidden');
  }

  // ---- Modes / UI ----

  function setMode(mode) {
    if (mode === 'ai' && !state.authReady) {
      showToast('Auth is still loading — wait a second and click AI again', true);
      return;
    }
    if (mode === 'delete' && state.scope === 'community' && !isCommunityStaff()) {
      showToast('Only community owner or admins can enable Delete mode', true);
      mode = 'search';
    }
    state.mode = mode;
    uploadActions.classList.add('hidden');
    barActionBtn.setAttribute('aria-expanded', 'false');
    document.querySelectorAll('.mode-pill').forEach(p => {
      p.classList.toggle('active', p.dataset.mode === mode);
    });

    iconSearch.classList.toggle('hidden', mode !== 'search');
    iconDump.classList.toggle('hidden', mode !== 'dump');
    iconAi.classList.toggle('hidden', mode !== 'ai');
    if (iconDelete) iconDelete.classList.toggle('hidden', mode !== 'delete');

    searchBarBox.classList.toggle('mode-dump', mode === 'dump');
    searchBarBox.classList.toggle('mode-ai', mode === 'ai');
    searchBarBox.classList.toggle('mode-search', mode === 'search');
    searchBarBox.classList.toggle('mode-delete', mode === 'delete');

    if (mode === 'search') {
      modeBadgeText.textContent = 'Search';
      modePulse.style.background = 'var(--primary-blue)';
      searchInput.placeholder = 'Search your brain…';
      searchInput.enterKeyHint = 'search';
      scopeSubtitle.textContent = state.scope === 'personal'
        ? 'Search personal notes & links'
        : 'Search community set';
      aiAnswerCard.classList.add('hidden');
    } else if (mode === 'dump') {
      modeBadgeText.textContent = 'Dump';
      modePulse.style.background = 'var(--success-color)';
      searchInput.placeholder = 'Paste a link or any text to save…';
      searchInput.enterKeyHint = 'done';
      scopeSubtitle.textContent = 'Save into markdown brain';
      aiAnswerCard.classList.add('hidden');
      resultsList.innerHTML = '';
      resultsMeta.classList.add('hidden');
      emptyState.classList.remove('hidden');
      emptyStateText.innerHTML = 'Paste URL or note, press <strong>Enter</strong> or the arrow.';
    } else if (mode === 'delete') {
      modeBadgeText.textContent = 'Delete';
      modePulse.style.background = 'var(--danger-color)';
      searchInput.placeholder = 'Paste a link to delete (or it will be added if missing)…';
      searchInput.enterKeyHint = 'go';
      scopeSubtitle.textContent = 'Prohibited mode — deletes matching URLs from DB';
      aiAnswerCard.classList.add('hidden');
      resultsList.innerHTML = '';
      resultsMeta.classList.add('hidden');
      emptyState.classList.remove('hidden');
      emptyStateText.innerHTML = 'Paste URL → if found, <strong>deleted</strong>; if not, <strong>added</strong>.';
    } else {
      modeBadgeText.textContent = 'AI';
      modePulse.style.background = 'var(--primary-purple)';
      searchInput.placeholder = 'Ask anything about your brain…';
      searchInput.enterKeyHint = 'go';
      scopeSubtitle.textContent = 'Answers from your .md / links only';
      emptyState.classList.add('hidden');
    }
  }

  function updateScopeUI() {
    personalScopeBtn.classList.toggle('active', state.scope === 'personal');
    communityScopeBtn.classList.toggle('active', state.scope === 'community');
    if (state.mode === 'search') {
      scopeSubtitle.textContent = state.scope === 'personal'
        ? 'Search personal notes & links'
        : 'Search community set';
    }
    updateDeleteModeVisibility();
  }

  function compactHero(compact) {
    document.body.classList.toggle('results-active', compact);
  }

  function renderHome() {
    compactHero(false);
    resultsList.innerHTML = '';
    resultsMeta.classList.add('hidden');
    aiAnswerCard.classList.add('hidden');
    emptyState.classList.remove('hidden');
    const n = corpus().length;
    emptyStateText.innerHTML = n
      ? `<strong>${n}</strong> items in ${state.scope}. Type to search, or switch to Dump / AI.`
      : 'Paste a link or note in <strong>Dump</strong>, then search or ask AI.';
  }

  function filterLinks(links, query) {
    if (!query) return links;
    // Prefer Athena fuzzy search (ytdlp ↔ yt-dlp)
    if (window.AthenaSearch?.searchCorpus) {
      const limit = window.__athenaSteroid ? 500 : 80;
      return window.AthenaSearch.searchCorpus(links, query, limit);
    }
    const q = query.toLowerCase();
    const qa = q.replace(/[^a-z0-9]/g, '');
    return links.filter(item => {
      const bag = [item.title, item.url, item.notes, item.tags].join(' ').toLowerCase();
      const ba = bag.replace(/[^a-z0-9]/g, '');
      return bag.includes(q) || (qa.length >= 2 && ba.includes(qa));
    });
  }

  function highlight(text, query) {
    if (!query || !text) return escapeHtml(text || '');
    const safe = escapeHtml(text);
    const terms = query.trim().split(/\s+/).filter(Boolean).map(t =>
      t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    );
    if (!terms.length) return safe;
    try {
      const re = new RegExp(`(${terms.join('|')})`, 'ig');
      return safe.replace(re, '<em class="hl">$1</em>');
    } catch (_) {
      return safe;
    }
  }

  function documentSnippet(content, query, maxLength = 260) {
    const text = String(content || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    const terms = (query || '').toLowerCase().split(/\s+/).filter(Boolean);
    let index = -1;
    for (const term of terms) {
      const found = text.toLowerCase().indexOf(term);
      if (found >= 0 && (index < 0 || found < index)) index = found;
    }
    const start = index < 0 ? 0 : Math.max(0, index - Math.floor(maxLength / 3));
    const end = Math.min(text.length, start + maxLength);
    return `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
  }

  function downloadDocument(item) {
    const content = item && (item.content != null ? item.content : '');
    if (!content) return;
    const ext = (item.filename && item.filename.includes('.') ? item.filename.split('.').pop() : 'txt').toLowerCase();
    const mime = /^(md|markdown)$/.test(ext) ? 'text/markdown'
      : /^(json|ya?ml|toml|xml|csv|sql|html?|css|js|ts)$/.test(ext) ? `text/${ext}`
      : 'text/plain';
    const filename = (item.filename || item.title || 'document.txt').replace(/[/\\?%*:|"<>]/g, '_');
    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function renderGoogleResults(items, query, corpusTotal = null) {
    compactHero(true);
    resultsList.innerHTML = '';
    if (!items.length) {
      emptyState.classList.remove('hidden');
      resultsMeta.classList.add('hidden');
      emptyStateText.innerHTML = query
        ? `No results for <strong>${escapeHtml(query)}</strong>`
        : 'No items yet.';
      return;
    }
    emptyState.classList.add('hidden');
    resultsMeta.classList.remove('hidden');
    resultsMeta.textContent = `About ${items.length} result${items.length === 1 ? '' : 's'}${query ? ` for “${query}”` : ''}${corpusTotal != null ? ` · ${corpusTotal} saved items searched` : ''}`;

    const isCommunity = state.scope === 'community';

    items.forEach(item => {
      const card = document.createElement('article');
      card.className = 'g-result';
      if (item.isDocument) {
        card.classList.add('g-result-document');
        const when = formatDateTime(item.createdAt);
        card.innerHTML = `
          <div class="g-document-type">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><path d="M14 2v6h6"></path></svg>
            <span>${highlight(item.mimeType || 'text/plain', query)}</span>
          </div>
          <div class="g-title g-document-title">${highlight(item.filename || item.title || 'Untitled document', query)}</div>
          <p class="g-snippet">${highlight(documentSnippet(item.content, query), query)}</p>
          <div class="g-meta">${escapeHtml(when)}</div>
          <button type="button" class="download-doc-btn" data-id="${escapeHtml(item.id)}" title="Download file">⬇ Download</button>`;
        card.classList.add('g-result-downloadable');
        card.addEventListener('click', () => downloadDocument(item));
        resultsList.appendChild(card);
        return;
      }
      const displayUrl = item.url
        ? item.url.replace(/^https?:\/\//, '').replace(/\/$/, '')
        : 'note · local brain';
      const href = item.url || '#';
      const site = item.siteName || '';
      const desc = (item.notes || '').slice(0, 220) || (item.tags || []).map(t => `#${t}`).join(' ');
      const who = item.addedBy || item.added_by || '';
      const plat = providerLabel(item.addedByProvider);
      const when = formatDateTime(item.createdAt);
      let favicon = '';
      try {
        if (item.imageUrl) {
          favicon = item.imageUrl;
        } else if (item.url && item.url.startsWith('http')) {
          const host = new URL(item.url).hostname;
          favicon = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
        }
      } catch (_) {}

      const authorLine = isCommunity
        ? `<div class="g-author">${plat ? `<span class="plat-tag plat-${plat.toLowerCase()}">${escapeHtml(plat)}</span>` : ''}
            <span class="g-author-name">${escapeHtml(who || 'member')}</span>
            <span class="g-author-time">${escapeHtml(when)}</span></div>`
        : '';

      const voteRow = isCommunity
        ? `<div class="g-actions">
            <button type="button" class="vote-btn up ${item.myVote === 1 ? 'active' : ''}" data-id="${escapeHtml(item.id)}" data-vote="1" title="Upvote">▲ <span>${item.upvotes || 0}</span></button>
            <button type="button" class="vote-btn down ${item.myVote === -1 ? 'active' : ''}" data-id="${escapeHtml(item.id)}" data-vote="-1" title="Downvote">▼ <span>${item.downvotes || 0}</span></button>
            <button type="button" class="report-btn" data-id="${escapeHtml(item.id)}" title="Report">Report</button>
          </div>`
        : `<div class="g-meta">${escapeHtml(when)}${(item.tags || []).length ? ' · ' + item.tags.map(t => '#' + escapeHtml(t)).join(' ') : ''}</div>`;

      card.innerHTML = `
        ${authorLine}
        <div class="g-url-row">
          ${favicon
            ? `<img class="g-favicon-img" src="${safeHref(favicon)}" alt="" width="18" height="18" loading="lazy" referrerpolicy="no-referrer" onerror="this.classList.add('hidden');this.nextElementSibling?.classList.remove('hidden')">`
            : ''}
          <span class="g-favicon ${favicon ? 'hidden' : ''}"></span>
          <cite class="g-cite">${site ? escapeHtml(site) + ' · ' : ''}${highlight(displayUrl, query)}</cite>
        </div>
        <a class="g-title" href="${safeHref(href)}" ${item.url ? 'target="_blank" rel="noopener noreferrer"' : ''}>${highlight(item.title || 'Untitled', query)}</a>
        <p class="g-snippet">${highlight(desc, query)}</p>
        ${voteRow}
        <button type="button" class="edit-link-btn" data-id="${escapeHtml(item.id)}" title="Edit" aria-label="Edit">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
        </button>
        <div class="edit-panel hidden" data-edit-for="${escapeHtml(item.id)}">
          <label>Title</label>
          <input type="text" class="edit-title" value="${escapeHtml(item.title || '')}" />
          <label>URL</label>
          <input type="url" class="edit-url" value="${escapeHtml(item.url || '')}" />
          <label>Description</label>
          <textarea class="edit-notes" rows="3">${escapeHtml(item.notes || '')}</textarea>
          <div class="edit-panel-actions">
            <button type="button" class="btn btn-primary btn-sm edit-save">Save</button>
            <button type="button" class="btn btn-secondary btn-sm edit-cancel">Cancel</button>
          </div>
        </div>
      `;
      resultsList.appendChild(card);
    });

    resultsList.querySelectorAll('.edit-link-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = btn.dataset.id;
        const card = btn.closest('.g-result');
        const panel = card?.querySelector(`.edit-panel[data-edit-for="${CSS.escape(id)}"]`);
        if (!panel) return;
        // close others
        resultsList.querySelectorAll('.edit-panel').forEach(p => {
          if (p !== panel) p.classList.add('hidden');
        });
        resultsList.querySelectorAll('.g-result').forEach(c => c.classList.remove('editing'));
        panel.classList.toggle('hidden');
        card.classList.toggle('editing', !panel.classList.contains('hidden'));
        if (!panel.classList.contains('hidden')) {
          panel.querySelector('.edit-title')?.focus();
        }
      });
    });

    resultsList.querySelectorAll('.edit-cancel').forEach(btn => {
      btn.addEventListener('click', () => {
        const panel = btn.closest('.edit-panel');
        const card = btn.closest('.g-result');
        panel?.classList.add('hidden');
        card?.classList.remove('editing');
      });
    });

    resultsList.querySelectorAll('.edit-save').forEach(btn => {
      btn.addEventListener('click', async () => {
        const panel = btn.closest('.edit-panel');
        const card = btn.closest('.g-result');
        const id = panel?.dataset.editFor;
        if (!id || !panel) return;
        const title = panel.querySelector('.edit-title')?.value?.trim() || '';
        const url = panel.querySelector('.edit-url')?.value?.trim() || '';
        const notes = panel.querySelector('.edit-notes')?.value?.trim() || '';
        if (!url && !title && !notes) {
          showToast('Nothing to save', true);
          return;
        }
        btn.disabled = true;
        try {
          const path = state.scope === 'community' ? '/api/links' : '/api/personal-links';
          const { res, data } = await api(path, {
            method: 'PATCH',
            body: JSON.stringify({ id, title, url, notes })
          });
          if (!res.ok || !data.success) {
            showToast(data.error || 'Edit failed', true);
            return;
          }
          const list = state.scope === 'community' ? state.communityLinks : state.personalLinks;
          const idx = list.findIndex(l => l.id === id);
          if (idx >= 0) {
            list[idx] = {
              ...list[idx],
              title: data.title != null ? data.title : title,
              url: data.url || url,
              notes: data.notes != null ? data.notes : notes,
              imageUrl: data.image_url || list[idx].imageUrl,
              siteName: data.site_name || list[idx].siteName
            };
          }
          showToast('Link updated');
          panel.classList.add('hidden');
          card?.classList.remove('editing');
          card?.classList.add('edited-flash');
          setTimeout(() => card?.classList.remove('edited-flash'), 1200);
          renderGoogleResults(
            filterLinks(corpus(), searchInput.value.trim() || query || ''),
            searchInput.value.trim() || query || ''
          );
        } catch (err) {
          showToast(err.message || 'Edit failed', true);
        } finally {
          btn.disabled = false;
        }
      });
    });

    // Enter in title/url saves
    resultsList.querySelectorAll('.edit-panel input').forEach(inp => {
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          inp.closest('.edit-panel')?.querySelector('.edit-save')?.click();
        }
      });
    });

    if (isCommunity) {
      resultsList.querySelectorAll('.vote-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const linkId = btn.dataset.id;
          let vote = parseInt(btn.dataset.vote, 10);
          const item = state.communityLinks.find(l => l.id === linkId);
          if (item && item.myVote === vote) vote = 0; // toggle off
          try {
            const { data } = await api('/api/links/vote', {
              method: 'POST',
              body: JSON.stringify({ link_id: linkId, vote })
            });
            if (data.success && item) {
              item.upvotes = data.upvotes;
              item.downvotes = data.downvotes;
              item.myVote = data.my_vote;
              renderGoogleResults(items.map(i => i.id === linkId ? item : i), query);
            }
          } catch (err) {
            showToast(err.message, true);
          }
        });
      });
      resultsList.querySelectorAll('.report-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const reason = prompt('Report reason (optional):') || 'Reported';
          try {
            const { data } = await api('/api/links/report', {
              method: 'POST',
              body: JSON.stringify({ link_id: btn.dataset.id, reason })
            });
            if (data.success) {
              showToast('Reported — owners/admins notified');
              await loadNotifications();
            } else {
              showToast(data.error || 'Report failed', true);
            }
          } catch (err) {
            showToast(err.message, true);
          }
        });
      });
    }
  }

  let searchSeq = 0;
  let enrichmentRefreshKey = '';

  async function runSearch() {
    const q = searchInput.value.trim();
    state.hasSearched = true;
    aiAnswerCard.classList.add('hidden');
    if (!q) {
      enrichmentRefreshKey = '';
      renderHome();
      return;
    }

    // Show local matches immediately so typing stays responsive, then replace
    // them with the server's answer, which searches the WHOLE store rather than
    // just the slice of links this browser happens to have loaded.
    renderGoogleResults(filterLinks(corpus(), q), q);

    const seq = ++searchSeq;
    try {
      const params = new URLSearchParams({ q, scope: state.scope });
      if (state.scope === 'community') {
        if (!state.activeCommunity) return;
        params.set('community_id', state.activeCommunity);
      }
      const { res, data } = await api(`/api/links/search?${params.toString()}`);
      if (seq !== searchSeq) return;              // a newer query already ran
      if (searchInput.value.trim() !== q) return; // input moved on
      if (res.ok && data.success && Array.isArray(data.links)) {
        const documents = filterLinks(corpus().filter(item => item.isDocument), q);
        renderGoogleResults([...data.links.map(normalizeLink), ...documents], q, data.total);
        if (data.enrichment_pending && enrichmentRefreshKey !== q) {
          enrichmentRefreshKey = q;
          setTimeout(() => {
            if (searchInput.value.trim() === q) runSearch();
          }, 1800);
        }
      }
    } catch (_) {
      // Offline or denied — the local results already on screen stand.
    }
  }

  function renderInlineMarkdown(text) {
    return escapeHtml(text || '')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\[#(\d+)\]/g, '<span class="ai-cite">[#$1]</span>')
      .replace(/\[(\d+)\]/g, '<span class="ai-cite">[$1]</span>');
  }

  function renderMarkdownLite(text) {
    const lines = String(text || '').split(/\r?\n/);
    const isTable = line => /^\s*\|.*\|\s*$/.test(line);
    const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
    let html = '';
    for (let i = 0; i < lines.length;) {
      const line = lines[i];
      if (isTable(line) && isTable(lines[i + 1]) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        const header = cells(line);
        const rows = [];
        i += 2;
        while (i < lines.length && isTable(lines[i])) rows.push(cells(lines[i++]));
        html += '<div class="ai-table-wrap"><table><thead><tr>';
        html += header.map(cell => `<th>${renderInlineMarkdown(cell)}</th>`).join('');
        html += '</tr></thead><tbody>';
        html += rows.map(row => `<tr>${header.map((_, n) => `<td>${renderInlineMarkdown(row[n] || '')}</td>`).join('')}</tr>`).join('');
        html += '</tbody></table></div>';
        continue;
      }
      if (/^\s*[-*]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ''));
        html += `<ul>${items.map(item => `<li>${renderInlineMarkdown(item)}</li>`).join('')}</ul>`;
        continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+\.\s+/, ''));
        html += `<ol>${items.map(item => `<li>${renderInlineMarkdown(item)}</li>`).join('')}</ol>`;
        continue;
      }
      if (/^\s*#{1,4}\s+/.test(line)) {
        const match = line.match(/^\s*(#{1,4})\s+(.*)$/);
        const level = match[1].length;
        html += `<h${level}>${renderInlineMarkdown(match[2])}</h${level}>`;
        i++;
        continue;
      }
      if (!line.trim()) { i++; continue; }
      const paragraph = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !isTable(lines[i]) && !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i]) && !/^\s*#{1,4}\s+/.test(lines[i])) paragraph.push(lines[i++]);
      html += `<p>${renderInlineMarkdown(paragraph.join('\n')).replace(/\n/g, '<br>')}</p>`;
    }
    return html;
  }

  async function runAi() {
    if (state.authReady && !state.currentUser && !state.sessionToken) {
      showToast('Login to use AI', true);
      return;
    }
    const q = searchInput.value.trim();
    if (!q) {
      showToast('Ask a question about your saved notes', true);
      return;
    }
    compactHero(true);
    emptyState.classList.add('hidden');
    aiAnswerCard.classList.remove('hidden');
    aiSources.innerHTML = '';

    // "New chat" button — clear conversation and start fresh
    let newChatBtn = document.getElementById('newChatBtn');
    if (!newChatBtn) {
      newChatBtn = document.createElement('button');
      newChatBtn.id = 'newChatBtn';
      newChatBtn.className = 'new-chat-btn';
      newChatBtn.textContent = '✦ New chat';
      newChatBtn.addEventListener('click', () => {
        state.conversationHistory = [];
        aiAnswerText.innerHTML = '';
        aiSources.innerHTML = '';
        searchInput.value = '';
        searchInput.focus();
      });
      aiAnswerCard.insertBefore(newChatBtn, aiAnswerCard.firstChild);
    }

    // Add user message to conversation history
    state.conversationHistory.push({ role: 'user', content: q });

    // Render conversation thread with a loading placeholder
    renderChatThread(true);

    try {
      const result = await window.AthenaAI.answerFromBrain(
        q, corpus(),
        // onDelta: stream the current answer live
        (_delta, full) => {
          const el = aiAnswerText.querySelector('.chat-msg:last-child .chat-answer-content');
          if (el) el.textContent = full;
        },
        state.conversationHistory,
        // onThinking: stream thinking into the collapsible block
        (_chunk, fullThinking) => {
          const el = aiAnswerText.querySelector('.chat-msg:last-child .thinking-content');
          if (el) el.textContent = fullThinking;
        }
      );

      // Add assistant message to conversation history
      state.conversationHistory.push({
        role: 'assistant',
        content: result.answer,
        thinking: result.thinking || ''
      });

      // Re-render the full thread with the final answer
      renderChatThread(false);

      const label = document.querySelector('.ai-answer-label');
      if (label) {
        label.textContent = result.mode === 'llm'
          ? 'AI · grounded in your markdown brain'
          : 'AI · local brain (add API key in Settings for full assistant)';
      }

      aiSources.innerHTML = '';
      (result.sources || []).forEach(s => {
        const a = document.createElement(s.url || s.isDocument ? 'a' : 'span');
        a.className = 'ai-source-chip';
        a.textContent = (s.filename ? `${s.filename} ⬇` : (s.title || s.url || 'source'));
        if (s.url) {
          a.href = s.url;
          a.target = '_blank';
          a.rel = 'noopener';
        } else if (s.isDocument) {
          a.href = '#';
          a.title = 'Download file';
          a.addEventListener('click', (e) => { e.preventDefault(); downloadDocument(s); });
        }
        aiSources.appendChild(a);
      });
      renderGoogleResults(result.results || result.sources || [], q);
    } catch (err) {
      // Remove the failed user message from history
      state.conversationHistory.pop();
      renderChatThread(false);
      showToast(err.message, true);
    }
  }

  function renderChatThread(isStreaming) {
    const thread = state.conversationHistory;
    let html = '';
    for (let i = 0; i < thread.length; i++) {
      const msg = thread[i];
      if (msg.role === 'user') {
        html += `<div class="chat-msg chat-user"><div class="chat-msg-content">${escapeHtml(msg.content)}</div></div>`;
      } else {
        const hasThinking = msg.thinking && msg.thinking.trim();
        html += `<div class="chat-msg chat-assistant">`;
        if (hasThinking) {
          html += `<details class="thinking-block"><summary><span class="thinking-icon">🧠</span> Thinking</summary><div class="thinking-content">${escapeHtml(msg.thinking)}</div></details>`;
        }
        html += `<div class="chat-answer-content">${renderMarkdownLite(msg.content)}</div></div>`;
      }
    }
    if (isStreaming) {
      html += `<div class="chat-msg chat-assistant"><div class="chat-answer-content"><span class="ai-loading">Reading your brain…</span></div></div>`;
    } else if (thread.length) {
      html += `<div class="chat-followup"><input type="text" class="chat-followup-input" placeholder="Ask a follow-up…" /></div>`;
    }
    aiAnswerText.innerHTML = html;
    aiAnswerText.scrollTop = aiAnswerText.scrollHeight;

    // Wire up the follow-up input
    if (!isStreaming) {
      const followup = aiAnswerText.querySelector('.chat-followup-input');
      if (followup) {
        followup.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            const fq = followup.value.trim();
            if (fq) {
              searchInput.value = fq;
              runAi();
            }
          }
        });
        followup.focus();
      }
    }
  }

  /** Storage backend panel (GOD writes, everyone can see which backend is live). */
  function updateStorageSyncLabel(provider) {
    if (!syncStorageBtn) return;
    if (provider === 'github') {
      syncStorageBtn.textContent = 'Sync GitHub with D1 mirror';
      syncStorageBtn.title = 'Merge GitHub and D1 in both directions, keeping personal and community scopes separate';
    } else {
      syncStorageBtn.textContent = 'Push existing links to GitHub';
      syncStorageBtn.title = 'Merge D1 and GitHub in both directions, keeping personal and community scopes separate';
    }
  }

  async function loadStorageForm() {
    const god = canEditAiConfig();
    storageGodBadge?.classList.toggle('hidden', !god);
    if (storageSettingsBody) {
      storageSettingsBody.classList.toggle('ui-locked', !god);
      storageSettingsBody.querySelectorAll('input, select, button').forEach(el => { el.disabled = !god; });
    }
    try {
      const { res, data } = await api('/api/storage/config');
      if (!res.ok) return;
      const provider = data.provider || 'd1';
      const postgresAvailable = data.postgres_available || false;

      // Always show all available storage options - let GOD choose
      if (storageProvider) {
        let options = '';
        if (postgresAvailable) {
          options += `<option value="local">Local Database (${escapeHtml(data.db_engine || 'PostgreSQL')})</option>`;
        }
        options += `<option value="d1">Cloudflare D1</option>`;
        options += `<option value="github">GitHub Markdown</option>`;
        storageProvider.innerHTML = options;
        storageProvider.value = provider;
        storageProvider.disabled = !god;
      }

      // Show/hide GitHub fields based on provider
      githubFields?.classList.toggle('hidden', provider !== 'github');
      if (githubRepo && data.repo && !githubRepo.value) githubRepo.value = data.repo;
      if (githubBranch && data.branch && !githubBranch.value) githubBranch.value = data.branch;

      // Update status display
      if (storageStatus) {
        if (provider === 'github') {
          const files = data.file_count != null ? ` · ${data.file_count} file(s)` : '';
          const n = data.link_count != null ? ` · ${data.link_count} link(s)` : '';
          storageStatus.innerHTML = data.has_token
            ? `<span style="color:var(--success-color)">GitHub: ${escapeHtml(data.repo || '')}@${escapeHtml(data.branch || 'main')}${files}${n}</span>`
            : '<span style="color:var(--danger-color)">GitHub selected but no token saved</span>';
        } else if (provider === 'local') {
          storageStatus.innerHTML = `<span style="color:var(--success-color)">${escapeHtml(data.db_engine || 'Local Database')} (self-hosted)</span>`;
        } else {
          storageStatus.innerHTML = '<span style="color:var(--text-muted)">Cloudflare D1 (default)</span>';
        }
      }

      // Update description
      if (storageDesc) {
        if (provider === 'github') {
          storageDesc.textContent = 'Links live as Markdown in your repo. GitHub is the source of truth; D1 only caches for fast search.';
        } else if (provider === 'local') {
          storageDesc.textContent = `Links live in your own ${data.db_engine || 'database'}. Backups are sent to Telegram (and Drive if configured).`;
        } else {
          storageDesc.textContent = 'Links live in Cloudflare D1. Switch to GitHub to own them as Markdown.';
        }
      }
    } catch (_) { /* offline / not logged in */ }
  }

  async function loadAiForm() {
    const cfg = window.AthenaAI?.loadConfig?.() || {};
    const preset = $('aiPreset');
    const base = $('aiBaseUrl');
    const model = $('aiModel');
    const key = $('aiApiKey');
    const mode = $('aiMode');
    const status = $('aiConfigStatus');
    if (!preset) return;

    if (cfg.preset) preset.value = cfg.preset;
    if (base) base.value = cfg.baseUrl || '';
    if (model) model.value = cfg.model || '';
    if (key) key.value = cfg.apiKey || '';
    if (mode) mode.value = cfg.mode || 'openai';

    let serverOk = false;
    try {
      const { data } = await api('/api/ai/config');
      serverOk = !!(data && data.configured && data.hasKey);
      if (data?.configured) {
        if (base && !base.value) base.value = data.baseUrl || '';
        if (model && !model.value) model.value = data.model || '';
        if (mode && data.mode) mode.value = data.mode;
      } else if (canEditAiConfig() && cfg.apiKey && cfg.baseUrl && cfg.model) {
        // Auto-sync browser-only credentials to D1 so bot /ai works
        try {
          await api('/api/ai/config', {
            method: 'POST',
            body: JSON.stringify({
              baseUrl: cfg.baseUrl,
              apiKey: cfg.apiKey,
              model: cfg.model,
              mode: cfg.mode || 'openai'
            })
          });
          serverOk = true;
        } catch (_) {}
      }
    } catch (_) { /* offline / not logged */ }

    if (status) {
      status.innerHTML = (cfg.apiKey || serverOk)
        ? `<span style="color:var(--success-color)">API ready · ${escapeHtml(cfg.model || model?.value || 'model')} · ${serverOk ? 'synced for bot /ai' : 'click Save to sync bot'}</span>`
        : '<span style="color:var(--text-muted)">No API key — GOD: Settings → AI → Save</span>';
    }

    const steroidToggle = $('steroidModeToggle');
    if (steroidToggle) {
      try {
        const { data: sData } = await api('/api/ai/steroid');
        steroidToggle.checked = !!sData.steroid;
        window.__athenaSteroid = !!sData.steroid;
      } catch (_) {
        try {
          const { data: inst } = await api('/api/instance/config');
          steroidToggle.checked = !!inst.steroid;
          window.__athenaSteroid = !!inst.steroid;
        } catch (_) {}
      }
      steroidToggle.disabled = !canEditAiConfig();
    }
    updateAiFreeBadge();
  }

  function applyAiPreset(name) {
    const p = window.AthenaAI?.PRESETS?.[name];
    if (!p) return;
    const base = $('aiBaseUrl');
    const model = $('aiModel');
    const mode = $('aiMode');
    if (base && (p.baseUrl || name === 'custom')) base.value = p.baseUrl || base.value;
    if (model && p.model) model.value = p.model;
    if (mode && p.mode) mode.value = p.mode;
    updateAiFreeBadge();
  }

  async function updateAiFreeBadge() {
    const badge = $('aiFreeBadge');
    const base = $('aiBaseUrl')?.value.trim() || '';
    const model = $('aiModel')?.value.trim() || '';
    if (!badge || !base || !model) {
      if (badge) badge.textContent = '';
      return;
    }
    badge.textContent = 'Checking model + limits…';
    try {
      const { data } = await api('/api/ai/detect-free', {
        method: 'POST',
        body: JSON.stringify({ baseUrl: base, model })
      });
      const lim = data.limits || {};
      const parts = [];
      if (data.free) parts.push('<span style="color:var(--success-color)">● Free</span>');
      else parts.push('<span style="color:var(--text-muted)">● Paid</span>');
      if (lim.rpm != null) parts.push(`RPM ${lim.rpm}`);
      if (lim.tpm != null) parts.push(`TPM ${lim.tpm}`);
      if (lim.rpd != null) parts.push(`RPD ${lim.rpd}`);
      if (lim.notes) parts.push(`<span style="opacity:.7">${lim.notes}</span>`);
      badge.innerHTML = parts.join(' · ') || '';
    } catch (_) {
      badge.textContent = '';
    }
  }

  async function onSubmit(e) {
    e.preventDefault();
    const q = searchInput.value.trim();
    if (!q) return;
    if (state.mode === 'dump') {
      await saveDump(q);
    } else if (state.mode === 'delete') {
      await runDelete(q);
    } else if (state.mode === 'ai') {
      await runAi();
    } else {
      runSearch();
    }
  }

  // ---- Theme (UI only) ----

  const THEME_ORDER = ['dark', 'light', 'material', 'glass'];
  const THEME_META = { dark: '#06070a', light: '#f4f5f9', material: '#121218', glass: '#05060c' };

  function applyTheme(theme) {
    const t = THEME_ORDER.includes(theme) ? theme : 'dark';
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('athena_theme', t); } catch (_) {}
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = THEME_META[t] || THEME_META.dark;
    document.querySelectorAll('.theme-chip').forEach(chip => {
      chip.classList.toggle('active', chip.dataset.theme === t);
    });
  }

  function initThemeUI() {
    let saved = 'dark';
    try { saved = localStorage.getItem('athena_theme') || 'dark'; } catch (_) {}
    applyTheme(saved);
    document.querySelectorAll('.theme-chip').forEach(chip => {
      chip.addEventListener('click', () => applyTheme(chip.dataset.theme));
    });
  }

  // ---- Accent color system ----
  const ACCENT_DEFAULT = '#7c5ce0';
  const ACCENT_LS_KEY = 'athena_accent_color';

  function hexToHsl(hex) {
    let r = 0, g = 0, b = 0;
    if (hex.length === 4) {
      r = parseInt(hex[1] + hex[1], 16);
      g = parseInt(hex[2] + hex[2], 16);
      b = parseInt(hex[3] + hex[3], 16);
    } else if (hex.length === 7) {
      r = parseInt(hex.slice(1, 3), 16);
      g = parseInt(hex.slice(3, 5), 16);
      b = parseInt(hex.slice(5, 7), 16);
    }
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
  }

  function applyAccentColor(hex) {
    const root = document.documentElement;
    const hsl = hexToHsl(hex);
    const h = hsl.h, s = hsl.s, l = hsl.l;

    root.style.setProperty('--accent', hex);
    root.style.setProperty('--accent-soft', `hsla(${h}, ${s}%, ${l}%, 0.22)`);
    root.style.setProperty('--accent-gradient', `linear-gradient(135deg, hsl(${h}, ${s}%, ${Math.min(l + 15, 80)}%), hsl(${h}, ${s}%, ${Math.max(l - 15, 15)}%))`);
    root.style.setProperty('--accent-hover', `hsl(${h}, ${Math.min(s + 5, 100)}%, ${Math.min(l + 8, 85)}%)`);
    root.style.setProperty('--accent-surface', `hsla(${h}, ${s}%, ${l}%, 0.08)`);
    root.style.setProperty('--accent-border', `hsla(${h}, ${s}%, ${l}%, 0.35)`);
    root.style.setProperty('--primary-purple', hex);
    root.style.setProperty('--border-highlight', `hsla(${h}, ${s}%, ${l}%, 0.35)`);

    try { localStorage.setItem(ACCENT_LS_KEY, hex); } catch (_) {}

    const input = $('accentColorInput');
    const label = $('accentCurrentLabel');
    if (input) input.value = hex;
    if (label) label.textContent = hex;

    document.querySelectorAll('.accent-swatch').forEach(sw => {
      sw.classList.toggle('active', sw.dataset.color.toLowerCase() === hex.toLowerCase());
    });
  }

  function initAccentColor() {
    let saved = ACCENT_DEFAULT;
    try { saved = localStorage.getItem(ACCENT_LS_KEY) || ACCENT_DEFAULT; } catch (_) {}
    applyAccentColor(saved);

    const colorInput = $('accentColorInput');
    if (colorInput) {
      colorInput.value = saved;
      colorInput.addEventListener('input', (e) => {
        applyAccentColor(e.target.value);
      });
    }

    const resetBtn = $('accentResetBtn');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        applyAccentColor(ACCENT_DEFAULT);
      });
    }

    document.querySelectorAll('.accent-swatch').forEach(sw => {
      sw.addEventListener('click', () => {
        applyAccentColor(sw.dataset.color);
      });
    });
  }

  // ---- Dice animation ----
  // ---- Dice animation (SVG pip-based) ----
  const DICE_PIPS = {
    1: [{ x: 36, y: 36 }],
    2: [{ x: 20, y: 52 }, { x: 52, y: 20 }],
    3: [{ x: 20, y: 52 }, { x: 36, y: 36 }, { x: 52, y: 20 }],
    4: [{ x: 20, y: 20 }, { x: 52, y: 20 }, { x: 20, y: 52 }, { x: 52, y: 52 }],
    5: [{ x: 20, y: 20 }, { x: 52, y: 20 }, { x: 36, y: 36 }, { x: 20, y: 52 }, { x: 52, y: 52 }],
    6: [{ x: 20, y: 20 }, { x: 52, y: 20 }, { x: 20, y: 36 }, { x: 52, y: 36 }, { x: 20, y: 52 }, { x: 52, y: 52 }]
  };

  function renderDicePips(face) {
    const pips = DICE_PIPS[face] || DICE_PIPS[1];
    const svg = document.getElementById('diceSvg');
    const g = document.getElementById('dicePips');
    if (!g || !svg) return;
    g.innerHTML = '';
    pips.forEach(p => {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', p.x);
      c.setAttribute('cy', p.y);
      c.setAttribute('r', '5');
      c.setAttribute('fill', 'rgba(255,255,255,0.92)');
      g.appendChild(c);
    });
  }

  function initDice() {
    const mark = $('heroMark');
    const svg = document.getElementById('diceSvg');
    if (!mark || !svg) return;

    let currentFace = 1;
    let rolling = false;
    renderDicePips(currentFace);

    function rollDice() {
      if (rolling) return;
      rolling = true;

      let newFace;
      do { newFace = Math.floor(Math.random() * 6) + 1; } while (newFace === currentFace);

      svg.classList.add('rolling');

      setTimeout(() => {
        svg.classList.remove('rolling');
        renderDicePips(newFace);
        currentFace = newFace;
        rolling = false;
      }, 600);
    }

    mark.addEventListener('click', rollDice);

    // Idle rolls
    let idleTimer = setInterval(() => {
      if (!rolling && document.visibilityState === 'visible') rollDice();
    }, 6000);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        clearInterval(idleTimer);
      } else {
        idleTimer = setInterval(() => {
          if (!rolling && document.visibilityState === 'visible') rollDice();
        }, 6000);
      }
    });
  }

  // ---- Events ----

  function setupEventListeners() {
    initThemeUI();
    initAccentColor();
    initDice();

    function openDrawer() {
      if (sideDrawer) sideDrawer.classList.add('active');
      if (drawerOverlay) drawerOverlay.classList.add('active');
      document.body.style.overflow = 'hidden';
    }
    function closeDrawer() {
      if (sideDrawer) sideDrawer.classList.remove('active');
      if (drawerOverlay) drawerOverlay.classList.remove('active');
      document.body.style.overflow = '';
    }
    if (hamburgerBtn) {
      hamburgerBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openDrawer();
      });
    }
    if (closeDrawerBtn) closeDrawerBtn.addEventListener('click', closeDrawer);
    if (drawerOverlay) drawerOverlay.addEventListener('click', closeDrawer);

    const sessionTokenBtn = $('sessionTokenBtn');
    if (sessionTokenBtn) {
      sessionTokenBtn.addEventListener('click', async () => {
        if (!state.currentUser) {
          showToast('Login required to copy a session token', true);
          return;
        }
        try {
          const res = await fetch(`${API_BASE}/api/auth/session-token`, {
            method: 'GET',
            headers: authHeaders(),
          });
          const data = await res.json();
          if (!res.ok || !data?.token) {
            showToast('Login required to copy a session token', true);
            return;
          }
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(data.token);
          } else {
            prompt('Session token (for athena-tui):', data.token);
          }
          showToast('Session token copied — paste it into athena-tui');
        } catch {
          showToast('Could not reach the server', true);
        }
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeDrawer();
    });

    document.querySelectorAll('.mode-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        if (pill.dataset.mode === 'ai' && !canUseAi()) {
          showToast('Login to use AI', true);
          return;
        }
        if (pill.dataset.mode === 'delete' && state.scope === 'community' && !isCommunityStaff()) {
          showToast('Only community owner or admins can enable Delete mode', true);
          return;
        }
        setMode(pill.dataset.mode);
      });
    });

    const wipePersonalBtn = $('wipePersonalBtn');
    if (wipePersonalBtn) {
      wipePersonalBtn.addEventListener('click', async () => {
        if (!state.currentUser) {
          showToast('Login required', true);
          return;
        }
        if (!isGod()) {
          showToast('Wipe personal is GOD only', true);
          return;
        }
        if (!confirm('Wipe ALL your personal data on this instance?\n\nThis cannot be undone.')) return;
        if (!confirm('Final confirmation: delete personal links, AI config, and end all sessions?')) return;
        try {
          const { res, data } = await api('/api/account/wipe', {
            method: 'POST',
            body: JSON.stringify({ confirm: 'WIPE_PERSONAL', confirm2: 'DELETE_MY_DATA' })
          });
          if (!res.ok || !data.success) {
            showToast(data.error || 'Wipe failed', true);
            return;
          }
          clearSession();
          showLoggedOut();
          showToast('Personal data wiped. Log in again if needed.');
        } catch (err) {
          showToast(err.message || 'Wipe failed', true);
        }
      });
    }

    barActionBtn.addEventListener('click', () => {
      if (state.mode === 'dump') {
        const opening = uploadActions.classList.contains('hidden');
        uploadActions.classList.toggle('hidden', !opening);
        barActionBtn.setAttribute('aria-expanded', String(opening));
        if (opening) uploadFileBtn.focus();
        return;
      }
      let cycle = ['search', 'dump', 'ai', 'delete'];
      if (state.scope === 'community' && !isCommunityStaff()) {
        cycle = ['search', 'dump', 'ai'];
      }
      const i = cycle.indexOf(state.mode);
      setMode(cycle[(i + 1) % cycle.length]);
      searchInput.focus();
    });

    uploadFileBtn.addEventListener('click', () => documentFileInput.click());
    documentFileInput.addEventListener('change', () => uploadDocuments([...documentFileInput.files]));

    if (notifBellBtn) {
      notifBellBtn.addEventListener('click', async () => {
        await loadNotifications();
        renderNotifications();
        notifPanel?.classList.toggle('hidden');
      });
    }
    if (closeNotifBtn) {
      closeNotifBtn.addEventListener('click', () => notifPanel?.classList.add('hidden'));
    }

    searchBarBox.addEventListener('submit', onSubmit);

    searchInput.addEventListener('input', () => {
      clearSearchBtn.classList.toggle('hidden', !searchInput.value);
      if (state.mode === 'search' && state.hasSearched) runSearch();
    });

    clearSearchBtn.addEventListener('click', () => {
      searchInput.value = '';
      clearSearchBtn.classList.add('hidden');
      if (state.mode === 'search') renderHome();
      searchInput.focus();
    });

    personalScopeBtn.addEventListener('click', () => {
        if (!isGod()) {
          showToast('Personal mode is GOD only. Join a community via bot: /community_join <id>', true);
          return;
        }
      state.scope = 'personal';
      updateScopeUI();
      if (state.mode === 'search' && searchInput.value.trim()) runSearch();
      else if (state.mode === 'search') renderHome();
    });

    communityScopeBtn.addEventListener('click', async () => {
      if (!state.activeCommunity && !state.communities.length) {
        showToast('No communities yet. In Telegram: add bot to group → /community_verify', true);
        return;
      }
      if (!state.activeCommunity && state.communities.length) {
        state.activeCommunity = state.communities[0].id;
        localStorage.setItem('athena_active_community', state.activeCommunity);
        if (communitySelect) communitySelect.value = state.activeCommunity;
      }
      state.scope = 'community';
      updateScopeUI();
      if (state.mode === 'delete' && !isCommunityStaff()) setMode('search');
      await Promise.all([loadCommunityLinksIfAny(), loadCommunityDocumentsIfAny()]);
      if (state.mode === 'search' && searchInput.value.trim()) runSearch();
      else if (state.mode === 'search') renderHome();
    });

    const backendUrl = $('backendUrl');
    const backendStatus = $('backendStatus');

    async function showBackendStatus() {
      if (!backendStatus) return;
      $('defaultBackendBtn')?.classList.toggle('hidden', !canEditAiConfig());

      let instanceDefault = '';
      try {
        const r = await fetch(`${window.location.origin}/api/instance/config`, { signal: AbortSignal.timeout(8000) });
        if (r.ok) instanceDefault = ((await r.json()).default_backend || '').trim();
      } catch (_) {}

      if (backendUrl) backendUrl.value = instanceDefault;

      const lines = [];
      lines.push(instanceDefault
        ? `<span style="color:var(--success-color)">Instance backend: ${escapeHtml(instanceDefault)}</span>`
        : `<span style="color:var(--text-muted)">Instance backend: Cloudflare</span>`);
      backendStatus.innerHTML = lines.join('<br>');
      try {
        const res = await fetch(`${API_BASE}/api/health`);
        const h = await res.json();
        backendStatus.innerHTML += `<br><span style="color:var(--text-muted)">v${escapeHtml(h.version || '?')} · ${escapeHtml(h.runtime || (instanceDefault ? 'self-hosted' : 'cloudflare'))}</span>`;
      } catch (_) {
        backendStatus.innerHTML += '<br><span style="color:var(--danger-color)">unreachable</span>';
      }
    }
    showBackendStatus();

    // Publishing the default is a property of the SITE, so it is stored on the
    // origin serving this page — not on whichever backend is currently selected.
    $('defaultBackendBtn')?.addEventListener('click', async () => {
      if (!canEditAiConfig()) { showToast('GOD rank only', true); return; }
      const raw = (backendUrl?.value || '').trim().replace(/\/+$/, '');
      if (backendStatus) backendStatus.textContent = 'Publishing…';
      try {
        let originHeaders = authHeaders();
        // Sessions belong to one database. If GOD is using the self-hosted
        // backend, obtain a session for the public site from signed Mini App data.
        if (API_BASE !== window.location.origin) {
          const initData = window.Telegram?.WebApp?.initData || '';
          if (!initData) throw new Error('Open Athena as a Telegram Mini App to change the instance backend');
          const authRes = await fetch(`${window.location.origin}/api/auth/telegram/webapp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ initData }),
          });
          const authData = await authRes.json().catch(() => ({}));
          if (!authRes.ok || !authData.session) throw new Error(authData.error || 'Cloudflare authentication failed');
          originHeaders = { Authorization: `Bearer ${authData.session}` };
        }
        const res = await fetch(`${window.location.origin}/api/instance/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...originHeaders },
          body: JSON.stringify({ default_backend: raw }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
        showToast(raw ? `Backend set for everyone: ${raw}` : 'Backend choice cleared — using this site');
        setTimeout(() => window.location.reload(), 900);
      } catch (err) {
        const hint = /401|403|Login required|GOD/i.test(err.message)
          ? 'The site origin did not accept this GOD session.'
          : err.message;
        if (backendStatus) backendStatus.innerHTML = `<span style="color:var(--danger-color)">${escapeHtml(hint)}</span>`;
        showToast(hint, true);
      }
    });

    storageProvider?.addEventListener('change', () => {
      githubFields?.classList.toggle('hidden', storageProvider.value !== 'github');
      updateStorageSyncLabel(storageProvider.value);
    });

    saveStorageBtn?.addEventListener('click', async () => {
      if (!canEditAiConfig()) { showToast('GOD rank only', true); return; }
      const provider = storageProvider?.value || 'd1';
      const body = { provider };
      if (provider === 'github') {
        body.repo = (githubRepo?.value || '').trim();
        body.branch = (githubBranch?.value || '').trim() || 'main';
        const tok = (githubToken?.value || '').trim();
        if (tok) body.token = tok;
        if (!body.repo) { showToast('Repository is required (owner/repo)', true); return; }
      }
      if (storageStatus) storageStatus.textContent = 'Verifying…';
      try {
        const { res, data } = await api('/api/storage/config', { method: 'POST', body: JSON.stringify(body) });
        if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
        if (githubToken) githubToken.value = '';
        showToast('Storage settings saved');
        await loadStorageForm();
      } catch (err) {
        if (storageStatus) storageStatus.innerHTML = `<span style="color:var(--danger-color)">${escapeHtml(err.message)}</span>`;
        showToast(err.message, true);
      }
    });

    syncStorageBtn?.addEventListener('click', async () => {
      if (!canEditAiConfig()) { showToast('GOD rank only', true); return; }
      if (storageStatus) storageStatus.textContent = 'Syncing D1 and GitHub…';
      try {
        const { res, data } = await api('/api/storage/sync', { method: 'POST', body: JSON.stringify({}) });
        if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
        showToast(`Synced ${data.pushed || 0} link(s) across D1 and GitHub`);
        await loadStorageForm();
      } catch (err) {
        if (storageStatus) storageStatus.innerHTML = `<span style="color:var(--danger-color)">${escapeHtml(err.message)}</span>`;
        showToast(err.message, true);
      }
    });

    logoutBtn.addEventListener('click', async () => {
      try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) {}
      clearSession();
      showLoggedOut();
    });

    if (communitySelect) {
      communitySelect.addEventListener('change', async () => {
        state.activeCommunity = communitySelect.value || '';
        if (state.activeCommunity) localStorage.setItem('athena_active_community', state.activeCommunity);
        else localStorage.removeItem('athena_active_community');
        if (state.activeCommunity) state.scope = 'community';
        updateDeleteModeVisibility();
        updateScopeUI();
        await loadCommunityAdmins();
        await Promise.all([loadCommunityLinksIfAny(), loadCommunityDocumentsIfAny()]);
        if (state.mode === 'search') renderHome();
      });
    }

    saveBotBindingBtn.addEventListener('click', async () => {
      const bot_username = botUsernameInput.value.trim();
      const bot_token = $('botTokenInput')?.value.trim() || '';
      const group_id = groupIdInput.value.trim();
      if (!group_id) return showToast('Chat ID required — open bot DM, send /id', true);
      if (botPlatform.value === 'telegram' && !bot_token) {
        return showToast('Bot token required (from @BotFather)', true);
      }
      if (botPlatform.value !== 'telegram' && !bot_username) {
        return showToast('Bot username required', true);
      }
      botStatus.textContent = 'Verifying token & messaging chat…';
      const { res, data } = await api('/api/bot-bindings', {
        method: 'POST',
        body: JSON.stringify({
          scope: 'personal',
          platform: botPlatform.value,
          bot_username,
          bot_token,
          group_id,
          group_name: groupNameInput.value.trim() || 'Personal DM'
        })
      });
      if (!res.ok || !data.success) {
        botStatus.innerHTML = `<span style="color:var(--danger-color)">${escapeHtml(data.error || 'Failed')}</span>`;
        showToast(data.error || 'Failed', true);
        return;
      }
      if ($('botTokenInput')) $('botTokenInput').value = '';
      groupIdInput.value = '';
      groupNameInput.value = '';
      if (data.bot?.username) botUsernameInput.value = data.bot.username;
      botStatus.innerHTML = `<span style="color:var(--success-color)">Personal bot @${escapeHtml(data.bot?.username || bot_username)} linked. Add to a group → /community_verify</span>`;
      showToast('Personal bot linked');
      await loadCommunityBots();
    });

    const aiPreset = $('aiPreset');
    const saveAiConfigBtn = $('saveAiConfigBtn');
    const clearAiConfigBtn = $('clearAiConfigBtn');
    if (aiPreset) {
      aiPreset.addEventListener('change', () => applyAiPreset(aiPreset.value));
    }
    const aiBaseUrlEl = $('aiBaseUrl');
    const aiModelEl = $('aiModel');
    if (aiBaseUrlEl) {
      aiBaseUrlEl.addEventListener('change', updateAiFreeBadge);
      aiBaseUrlEl.addEventListener('input', () => { clearTimeout(window._freeBadgeTimer); window._freeBadgeTimer = setTimeout(updateAiFreeBadge, 700); });
    }
    if (aiModelEl) {
      aiModelEl.addEventListener('change', updateAiFreeBadge);
      aiModelEl.addEventListener('input', () => { clearTimeout(window._freeBadgeTimer); window._freeBadgeTimer = setTimeout(updateAiFreeBadge, 700); });
    }
    if (saveAiConfigBtn) {
      saveAiConfigBtn.addEventListener('click', async () => {
        if (!canEditAiConfig()) { showToast('AI credentials: GOD rank only', true); return; }
        let baseUrl = $('aiBaseUrl')?.value.trim() || '';
        let model = $('aiModel')?.value.trim() || '';
        // normalize OpenCode URLs / model ids (strip trailing dots/slashes)
        baseUrl = baseUrl.replace(/^['"]|['"]$/g, '').replace(/[.,;]+$/g, '');
        baseUrl = baseUrl.replace(/\/chat\/completions\/?$/i, '').replace(/\/messages\/?$/i, '').replace(/\/+$/g, '');
        if (window.AthenaAI?.normalizeModelId) {
          model = window.AthenaAI.normalizeModelId(model, baseUrl);
        } else {
          model = model.replace(/^opencode-go\//i, '').replace(/^opencode\//i, '');
        }
        if ($('aiBaseUrl')) $('aiBaseUrl').value = baseUrl;
        if ($('aiModel')) $('aiModel').value = model;
        const cfg = {
          preset: $('aiPreset')?.value || 'custom',
          baseUrl,
          model,
          apiKey: $('aiApiKey')?.value.trim() || '',
          mode: $('aiMode')?.value || 'openai'
        };
        if (!cfg.baseUrl || !cfg.model) {
          showToast('Base URL and model required', true);
          return;
        }
        window.AthenaAI.saveConfig(cfg);
        // Sync to server so Telegram /ai works with same settings
        if (cfg.apiKey) {
          try {
            await api('/api/ai/config', {
              method: 'POST',
              body: JSON.stringify({
                baseUrl: cfg.baseUrl,
                apiKey: cfg.apiKey,
                model: cfg.model,
                mode: cfg.mode
              })
            });
            showToast('AI saved (website + bot /ai)');
          } catch (err) {
            showToast('Saved locally; bot sync failed: ' + err.message, true);
          }
        } else {
          showToast('Saved — add a key to enable LLM');
        }
        await loadAiForm();
      });
    }
    if (clearAiConfigBtn) {
      clearAiConfigBtn.addEventListener('click', async () => {
        window.AthenaAI.saveConfig({});
        if ($('aiApiKey')) $('aiApiKey').value = '';
        if ($('aiBaseUrl')) $('aiBaseUrl').value = '';
        if ($('aiModel')) $('aiModel').value = '';
        try { await api('/api/ai/config', { method: 'DELETE' }); } catch (_) {}
        loadAiForm();
        showToast('AI config cleared');
      });
    }

    const steroidToggle = $('steroidModeToggle');
    if (steroidToggle) {
      steroidToggle.addEventListener('change', async () => {
        if (!canEditAiConfig()) {
          showToast('GOD only', true);
          steroidToggle.checked = !steroidToggle.checked;
          return;
        }
        try {
          await api('/api/ai/steroid', { method: 'POST', body: JSON.stringify({ steroid: steroidToggle.checked }) });
          window.__athenaSteroid = !!steroidToggle.checked;
          showToast(steroidToggle.checked ? 'Steroid mode ON — unlimited' : 'Steroid mode OFF — throttled');
        } catch (err) {
          showToast(err.message || 'Failed', true);
          steroidToggle.checked = !steroidToggle.checked;
        }
      });
    }
  }

  async function init() {
    // Must run before anything talks to the API, including the login buttons.
    await adoptInstanceBackend();
    setupEventListeners();
    await loadAuthConfig();
    // Telegram Mini App: try initData login first
    if (window.Telegram?.WebApp?.initData) {
      const wa = await tryTelegramWebAppLogin();
      if (wa && wa.ok) {
        state.authReady = true;
        showLoggedIn();
        updateUserUI();
        await bootstrapAppData();
        return;
      }
    }
    const ok = await restoreSession();
    state.authReady = true;
    if (ok) await bootstrapAppData();
  }

  init();
});
