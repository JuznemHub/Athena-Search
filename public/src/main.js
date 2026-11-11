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
    isInstanceOwner: true, // until /auth/me says otherwise; empty owner lists = all owners
    filterTag: '',
    filterStatus: 'all',
    filterSort: 'created_desc',
    tags: [],
    tagStats: null
  };
  function isGod() {
    return !!state.currentUser?.is_god;
  }
  function isStaffRank() {
    return Boolean(state.currentUser?.is_god || state.currentUser?.['is_e' + 'levated']);
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
  const telegramWebLoginBtn = $('telegramWebLoginBtn');
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
  const storageStatus = $('storageStatus');
  const saveStorageBtn = $('saveStorageBtn');
  const syncStorageBtn = $('syncStorageBtn');
  const storageGodBadge = $('storageGodBadge');
  // eslint-disable-next-line no-unused-vars
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
        ...authHeaders(options.headers || {}),
        ...(state.wikiShareToken ? { 'X-Wiki-Share-Token': state.wikiShareToken } : {})
      }
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 || data.code === 'AUTH_REQUIRED') {
      if (!state.publicWikiMode) {
        clearSession();
        showLoggedOut();
      }
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

  // --- Modal: replaces native confirm() with a themed, focus-trapped dialog ---
  function showModal({ title = 'Confirm', message = '', confirmText = 'Confirm', cancelText = 'Cancel', danger = false }) {
    return new Promise((resolve) => {
      const prevActive = document.activeElement;
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
          <h3 class="modal-title">${escapeHtml(title)}</h3>
          <p class="modal-message">${message}</p>
          <div class="modal-actions">
            <button type="button" class="btn btn-secondary" data-modal-cancel>${escapeHtml(cancelText)}</button>
            <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-modal-ok>${escapeHtml(confirmText)}</button>
          </div>
        </div>`;
      const done = (v) => {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
        if (prevActive && prevActive.focus) prevActive.focus();
        resolve(v);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') done(false);
        if (e.key === 'Tab') {
          const focusables = overlay.querySelectorAll('button');
          if (!focusables.length) return;
          e.preventDefault();
          const i = [...focusables].indexOf(document.activeElement);
          focusables[(i + (e.shiftKey ? -1 : 1) + focusables.length) % focusables.length].focus();
        }
      };
      overlay.querySelector('[data-modal-cancel]').addEventListener('click', () => done(false));
      overlay.querySelector('[data-modal-ok]').addEventListener('click', () => done(true));
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done(false); });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(overlay);
      overlay.querySelector(danger ? '[data-modal-ok]' : '[data-modal-cancel]').focus();
    });
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
      myVote: row.my_vote || 0,
      manualEditedAt: row.manual_edited_at || row.manualEditedAt || null,
      lastEditedBy: row.last_edited_by || row.lastEditedBy || null,
      lastEditedByName: row.last_edited_by_name || row.lastEditedByName || ''
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
    // codeql[js/clear-text-storage-of-sensitive-data] -- session token 30-day UUID, HttpOnly primary, localStorage cross-origin fallback
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

    if ((cfg.telegramBotEnabled || cfg.botUsername) && telegramWebLoginBtn) {
      telegramWebLoginBtn.classList.remove('hidden');
      telegramWebLoginBtn.disabled = false;
      telegramWebLoginBtn.onclick = async () => {
        try {
          telegramWebLoginBtn.disabled = true;
          telegramWebLoginBtn.textContent = 'Preparing login...';
          const r = await fetch(`${API_BASE}/api/auth/telegram/bot-login-start`, { method: 'POST' });
          const d = await r.json();
          if (!d.success || !d.token) {
            showAuthError(d.error || 'Could not start Telegram Web login.');
            telegramWebLoginBtn.disabled = false;
            telegramWebLoginBtn.textContent = 'Log in with Telegram Web';
            return;
          }
          const targetUrl = d.tgWebUrl || d.tmeUrl;
          window.open(targetUrl, '_blank', 'noopener,noreferrer');
          telegramWebLoginBtn.textContent = 'Confirming in Telegram...';
          authGateError.innerHTML = `Confirm login: click START in <a href="${targetUrl}" target="_blank" style="color:var(--accent,#2AABEE);text-decoration:underline;">Telegram Web</a> or <a href="${d.tmeUrl}" target="_blank" style="color:var(--accent,#2AABEE);text-decoration:underline;">Bot</a>.`;
          authGateError.classList.remove('hidden');

          let attempts = 0;
          const pollInterval = setInterval(async () => {
            attempts++;
            if (attempts > 120) {
              clearInterval(pollInterval);
              telegramWebLoginBtn.disabled = false;
              telegramWebLoginBtn.textContent = 'Log in with Telegram Web';
              showAuthError('Login session timed out. Click again to retry.');
              return;
            }
            try {
              const pr = await fetch(`${API_BASE}/api/auth/telegram/bot-login-poll?token=${encodeURIComponent(d.token)}`);
              const pd = await pr.json();
              if (pd.status === 'authenticated' && pd.session) {
                clearInterval(pollInterval);
                await persistSession(pd.session);
                if (pd.user) {
                  state.currentUser = pd.user;
                  state.isInstanceOwner = !!pd.user.is_god;
                  state.isElevated = !!pd.user.is_elevated;
                }
                showLoggedIn();
                updateUserUI();
                await bootstrapAppData();
              } else if (pd.status === 'banned') {
                clearInterval(pollInterval);
                telegramWebLoginBtn.disabled = false;
                telegramWebLoginBtn.textContent = 'Log in with Telegram Web';
                showAuthError(pd.error || 'You are not in any community Telegram group (or banned from all).');
              } else if (pd.status === 'expired' || pd.status === 'invalid') {
                clearInterval(pollInterval);
                telegramWebLoginBtn.disabled = false;
                telegramWebLoginBtn.textContent = 'Log in with Telegram Web';
                showAuthError('Login session expired. Try again.');
              }
            } catch (_) {}
          }, 1500);
        } catch (err) {
          showAuthError(err.message || 'Telegram Web login failed.');
          telegramWebLoginBtn.disabled = false;
          telegramWebLoginBtn.textContent = 'Log in with Telegram Web';
        }
      };
    }

    window.onTelegramAuth = async (user) => {
      try {
        const initData = new URLSearchParams(user).toString();
        const res = await fetch(`${API_BASE}/api/auth/telegram/webapp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ initData })
        });
        const data = await res.json().catch(() => ({}));
        if (data.success && data.session) {
          await persistSession(data.session);
          if (data.user) {
            state.currentUser = data.user;
            state.isInstanceOwner = !!data.user.is_god;
            state.isElevated = !!data.user.is_elevated;
          }
          showLoggedIn();
          updateUserUI();
          await bootstrapAppData();
        } else {
          showAuthError(data.error || 'Telegram Widget authentication failed.');
        }
      } catch (err) {
        showAuthError(err.message || 'Telegram Widget authentication error.');
      }
    };

    if (cfg.botUsername && $('telegramWidgetContainer') && !$('telegramWidgetContainer').hasChildNodes()) {
      const s = document.createElement('script');
      s.async = true;
      s.src = 'https://telegram.org/js/telegram-widget.js?22';
      s.setAttribute('data-telegram-login', cfg.botUsername);
      s.setAttribute('data-size', 'large');
      s.setAttribute('data-userpic', 'false');
      s.setAttribute('data-onauth', 'onTelegramAuth(user)');
      s.setAttribute('data-request-access', 'write');
      $('telegramWidgetContainer').appendChild(s);
    }

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
        // codeql[js/clear-text-storage-of-sensitive-data] -- session token is random 30-day UUID, HttpOnly cookie is primary, localStorage is cross-origin fallback
        try { localStorage.setItem('athena_session', state.sessionToken); } catch (_) {}
      }
    }

    // Telegram CloudStorage: survives the Mini App being closed, which wipes
    // both localStorage and cookies.
    if (!state.sessionToken) {
      const cloud = await cloudGet('athena_session');
      if (cloud) {
        state.sessionToken = cloud;
        // codeql[js/clear-text-storage-of-sensitive-data] -- see above, cross-origin fallback for Mini App
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
    const isStaff = isStaffRank();
    const aiOk = canUseAi();
    const aiCfg = canEditAiConfig();

    const adminNavBtn = $('adminDbNavBtn');
    if (adminNavBtn) {
      adminNavBtn.classList.remove('hidden');
      adminNavBtn.classList.toggle('nav-btn-locked', !isStaff);
      adminNavBtn.title = isStaff ? 'Database Manager (Admin & Owner)' : 'Database Manager (Admin Only)';
    }
    const adminDrawer = $('adminDrawerSection');
    if (adminDrawer) adminDrawer.classList.remove('hidden');

    const wikiShareBtn = $('wikiShareBtn');
    if (wikiShareBtn) wikiShareBtn.classList.toggle('hidden', !god);

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
    const mainScopeSelect = $('mainScopeSelect');
    if (mainScopeSelect) {
      const personalOpt = mainScopeSelect.querySelector('option[value="personal"]');
      if (personalOpt) {
        personalOpt.disabled = !god;
        personalOpt.textContent = god ? 'Personal (GOD)' : 'Personal (GOD locked)';
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
    await step('tags', () => loadMainTags());
    await step('notifications', () => loadNotifications());

    // These must run even if every fetch above failed, or there is no usable UI.
    try {
      // don't yank the user out of AI mode while data is still loading
      const initialMode = state.mode && state.mode !== 'search' ? state.mode : 'search';
      setMode(initialMode);
      updateScopeUI();
      renderHome();
      startLiveSync();
      if (window.location.hash === '#db' || window.location.hash === '#admin') {
        openAdminDb();
      } else if (window.location.hash === '#wiki') {
        openWiki();
      }
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
        if (!(await showModal({ title: 'Delete all notifications', message: 'Clear every notification?', confirmText: 'Delete all', danger: true }))) return;
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
        if (!(await showModal({ title: 'Delete reported link', message: 'Remove this link from the community brain?', confirmText: 'Delete', danger: true }))) return;
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
    if (state.activeCommunity && !state.communities.find(c => c.id === state.activeCommunity)) {
      state.activeCommunity = '';
      localStorage.removeItem('athena_active_community');
    }
    if (!state.activeCommunity && state.scope === 'community' && state.communities.length) {
      state.activeCommunity = state.communities[0].id;
      localStorage.setItem('athena_active_community', state.activeCommunity);
    }
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
    const mainCommSel = $('mainCommunitySelect');
    if (mainCommSel) {
      mainCommSel.innerHTML = '';
      if (!state.communities.length) {
        mainCommSel.innerHTML = '<option value="">No communities</option>';
      } else {
        state.communities.forEach(c => {
          const opt = document.createElement('option');
          opt.value = c.id;
          opt.textContent = `${c.name}${c.link_count != null ? ` (${c.link_count})` : ''}`;
          if (c.id === state.activeCommunity) opt.selected = true;
          mainCommSel.appendChild(opt);
        });
      }
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

  const DOCUMENT_MAX_BYTES = 5 * 1024 * 1024;
  const DOCUMENT_EXTENSIONS = new Set([
    'md', 'markdown', 'txt', 'py', 'js', 'ts', 'jsx', 'tsx', 'sh', 'bash', 'zsh', 'fish',
    'css', 'html', 'htm', 'json', 'yaml', 'yml', 'toml', 'xml', 'csv', 'sql', 'go', 'rs',
    'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'php', 'swift', 'kt', 'kts', 'lua', 'r',
    'dart', 'vue', 'svelte', 'ini', 'cfg', 'conf', 'env', 'log'
  ]);
  // Binary formats the server converts to Markdown via anydoc before storing.
  // They go up as raw bytes (content_base64), so no text checks apply here.
  const CONVERTIBLE_EXTENSIONS = new Set([
    'pdf', 'doc', 'docx', 'docm', 'ppt', 'pps', 'pot', 'pptx', 'pptm', 'ppsx', 'ppsm',
    'xls', 'xlsx', 'xlsm', 'xlsb', 'odt', 'ods', 'odp', 'rtf', 'epub'
  ]);
  const CONVERT_SOURCE_MAX_BYTES = 20 * 1024 * 1024;

  function fileExtension(name) {
    return name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  }

  function validateDocumentFile(file, content) {
    const ext = fileExtension(file.name);
    if (CONVERTIBLE_EXTENSIONS.has(ext)) {
      if (file.size > CONVERT_SOURCE_MAX_BYTES) return 'larger than 20 MiB';
      return '';
    }
    if (!DOCUMENT_EXTENSIONS.has(ext)) return 'unsupported file type';
    if (file.size > DOCUMENT_MAX_BYTES) return 'larger than 5 MiB';
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
        let contentBase64;
        try {
          if (CONVERTIBLE_EXTENSIONS.has(fileExtension(file.name))) {
            const buf = new Uint8Array(await file.arrayBuffer());
            let bin = '';
            for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
            contentBase64 = btoa(bin);
          } else {
            content = await file.text();
          }
        } catch (_) {
          rejected.push(`${file.name}: could not read`);
          continue;
        }
        const invalid = validateDocumentFile(file, content || '');
        if (invalid) {
          rejected.push(`${file.name}: ${invalid}`);
          continue;
        }
        uploadStatus.textContent = `Uploading ${file.name}…`;
        const payload = {
          filename: file.name,
          mime_type: file.type || 'text/plain',
          scope: state.scope
        };
        if (contentBase64 !== undefined) payload.content_base64 = contentBase64;
        else payload.content = content;
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
        if (!res.ok || !data.success) {
          showToast(data.error || 'Failed to save', true);
          return;
        }
        if (data.id) item.id = data.id;
        if (data.title) item.title = data.title;
        if (data.notes != null) item.notes = data.notes;
        if (data.image_url) item.imageUrl = data.image_url;
        if (data.site_name) item.siteName = data.site_name;
      } catch (err) {
        if (!err.auth) showToast(err.message || 'Failed to save', true);
        return;
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
          const { res, data } = await api('/api/personal-links', { method: 'DELETE', body: JSON.stringify({ id: found.id }) });
          if (!res.ok || !data.success) {
            showToast(data.error || 'Delete failed', true);
            return;
          }
          state.personalLinks = state.personalLinks.filter(l => l.id !== found.id);
        } else {
          const { res, data } = await api('/api/links', {
            method: 'DELETE',
            body: JSON.stringify({ id: found.id, community_id: state.activeCommunity })
          });
          if (!res.ok || !data.success) {
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
      p.setAttribute('aria-pressed', String(p.dataset.mode === mode));
    });

    iconSearch.classList.toggle('hidden', mode !== 'search');
    iconDump.classList.toggle('hidden', mode !== 'dump');
    iconAi.classList.toggle('hidden', mode !== 'ai');
    if (iconDelete) iconDelete.classList.toggle('hidden', mode !== 'delete');

    searchBarBox.classList.toggle('mode-dump', mode === 'dump');
    searchBarBox.classList.toggle('mode-ai', mode === 'ai');
    searchBarBox.classList.toggle('mode-search', mode === 'search');
    searchBarBox.classList.toggle('mode-delete', mode === 'delete');
    const mainDbPanel = $('mainDbPanel');
    if (mainDbPanel) mainDbPanel.classList.toggle('hidden', mode !== 'search');

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
    searchInput.setAttribute('aria-label', searchInput.placeholder.replace(/…$/, ''));
  }

  function updateScopeUI() {
    personalScopeBtn.classList.toggle('active', state.scope === 'personal');
    communityScopeBtn.classList.toggle('active', state.scope === 'community');
    const mainScopeSelect = $('mainScopeSelect');
    if (mainScopeSelect && mainScopeSelect.value !== state.scope) {
      mainScopeSelect.value = state.scope;
    }
    const commWrap = $('mainCommunityWrap');
    if (commWrap) {
      commWrap.style.display = state.scope === 'community' ? 'flex' : 'none';
    }
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
    let list = links || [];
    if (state.filterTag) {
      const tagLower = state.filterTag.toLowerCase();
      if (tagLower === 'notags') {
        list = list.filter(item => !item.tags || item.tags.length === 0);
      } else {
        list = list.filter(item => (item.tags || []).some(t => String(t).toLowerCase() === tagLower));
      }
    }
    if (state.filterStatus === 'edited') {
      list = list.filter(item => Boolean(item.manualEditedAt || item.manual_edited_at));
    } else if (state.filterStatus === 'unedited') {
      list = list.filter(item => !item.manualEditedAt && !item.manual_edited_at);
    }
    if (query) {
      // Apply filters before the search limit so matching filtered items are not
      // discarded by higher-ranked items from other tags or statuses.
      if (window.AthenaSearch?.searchCorpus) {
        const limit = window.__athenaSteroid ? 500 : 80;
        list = window.AthenaSearch.searchCorpus(list, query, limit);
      } else {
        const q = query.toLowerCase();
        const qa = q.replace(/[^a-z0-9]/g, '');
        list = list.filter(item => {
          const bag = [item.title, item.url, item.notes, (item.tags || []).join(' ')].join(' ').toLowerCase();
          const ba = bag.replace(/[^a-z0-9]/g, '');
          return bag.includes(q) || (qa.length >= 2 && ba.includes(qa));
        });
      }
    }
    if (state.filterSort === 'edited_desc') {
      list = [...list].sort((a, b) => Number(b.manualEditedAt || b.manual_edited_at || 0) - Number(a.manualEditedAt || a.manual_edited_at || 0));
    } else if (state.filterSort === 'created_asc') {
      list = [...list].sort((a, b) => Number(a.createdAt || a.created_at || 0) - Number(b.createdAt || b.created_at || 0));
    } else if (state.filterSort === 'title_asc') {
      list = [...list].sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
    } else if (state.filterSort === 'created_desc') {
      list = [...list].sort((a, b) => Number(b.createdAt || b.created_at || 0) - Number(a.createdAt || a.created_at || 0));
    }
    return list;
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
    // Owner/admin only: everyone else sees no edit/delete affordance, and the
    // server rejects the call with "Only owner/admins can edit or delete".
    const canModerate = state.scope === 'personal' || isStaffRank() || isCommunityStaff();

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

      const editAuditHtml = item.manualEditedAt
        ? `<div class="g-audit-row">
            <span class="admin-edit-badge" title="Manually edited">
              ✏️ Last edited by <strong>${escapeHtml(item.lastEditedByName || 'Admin')}</strong> · ${escapeHtml(formatDateTime(item.manualEditedAt))}
            </span>
           </div>`
        : '';

      const tagsList = (item.tags || []).filter(Boolean);
      const tagsHtml = tagsList.length
        ? `<div class="g-card-tags">
            ${tagsList.map(t => `<button type="button" class="g-tag-chip" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</button>`).join('')}
           </div>`
        : `<div class="g-card-tags">
            <button type="button" class="g-tag-chip g-tag-empty" data-tag="notags" title="Untagged link — click to filter">#notags</button>
           </div>`;

      const cardActionsHtml = canModerate ? `
        <div class="g-card-actions">
          <button type="button" class="btn btn-secondary btn-sm edit-link-btn" data-id="${escapeHtml(item.id)}" title="Edit link and tags">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
            <span>Edit</span>
          </button>
          <button type="button" class="btn btn-sm g-card-del-btn del-link-btn" data-id="${escapeHtml(item.id)}" data-title="${escapeHtml(item.title || item.url || 'this link')}" title="Delete link from database">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
            <span>Delete</span>
          </button>
        </div>` : '';

      card.innerHTML = `
        ${authorLine}
        <div class="g-url-row">
          <div class="g-url-meta">
            ${favicon
              ? `<img class="g-favicon-img" src="${safeHref(favicon)}" alt="" width="18" height="18" loading="lazy" referrerpolicy="no-referrer" onerror="this.classList.add('hidden');this.nextElementSibling?.classList.remove('hidden')">`
              : ''}
            <span class="g-favicon ${favicon ? 'hidden' : ''}"></span>
            <cite class="g-cite">${site ? escapeHtml(site) + ' · ' : ''}${highlight(displayUrl, query)}</cite>
          </div>
          ${cardActionsHtml}
        </div>
        <a class="g-title" href="${safeHref(href)}" ${item.url ? 'target="_blank" rel="noopener noreferrer"' : ''}>${highlight(item.title || 'Untitled', query)}</a>
        ${desc ? `<p class="g-snippet">${highlight(desc, query)}</p>` : ''}
        ${tagsHtml}
        ${voteRow}
        ${editAuditHtml}
        <div class="edit-panel hidden" data-edit-for="${escapeHtml(item.id)}">
          <label>Title</label>
          <input type="text" class="edit-title" value="${escapeHtml(item.title || '')}" />
          <label>URL</label>
          <input type="url" class="edit-url" value="${escapeHtml(item.url || '')}" />
          <label>Description</label>
          <textarea class="edit-notes" rows="3">${escapeHtml(item.notes || '')}</textarea>
          <label>Tags (space or comma-separated)</label>
          <input type="text" class="edit-tags" value="${escapeHtml((item.tags || []).map(t => '#' + t).join(' '))}" placeholder="e.g. #ai #tools #docs" />
          <div class="edit-panel-actions">
            <button type="button" class="btn btn-primary btn-sm edit-save">Save</button>
            <button type="button" class="btn btn-secondary btn-sm edit-cancel">Cancel</button>
            <button type="button" class="btn btn-sm g-card-del-btn edit-delete">Delete</button>
          </div>
        </div>
      `;
      resultsList.appendChild(card);
    });

    resultsList.querySelectorAll('.g-tag-chip').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const tag = btn.dataset.tag;
        if (!tag) return;
        if (tag.toLowerCase() === 'notags') {
          state.filterTag = 'notags';
        } else if (state.filterTag && state.filterTag.toLowerCase() === tag.toLowerCase()) {
          state.filterTag = '';
        } else {
          state.filterTag = tag;
        }
        renderMainTags();
        runSearch();
      });
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
        const tagsVal = panel.querySelector('.edit-tags')?.value?.trim() || '';
        const tags = tagsVal.split(/[\s,]+/).map(t => t.replace(/^#+/, '').trim()).filter(Boolean);
        if (!url && !title && !notes) {
          showToast('Nothing to save', true);
          return;
        }
        btn.disabled = true;
        try {
          const path = state.scope === 'community' ? '/api/links' : '/api/personal-links';
          const { res, data } = await api(path, {
            method: 'PATCH',
            body: JSON.stringify({ id, title, url, notes, tags })
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
              __sd: undefined,
              title: data.title != null ? data.title : title,
              url: data.url || url,
              notes: data.notes != null ? data.notes : notes,
              tags: Array.isArray(data.tags) ? data.tags : tags,
              imageUrl: data.image_url || list[idx].imageUrl,
              siteName: data.site_name || list[idx].siteName,
              manualEditedAt: data.manual_edited_at || Date.now(),
              lastEditedBy: data.last_edited_by || state.currentUser?.id,
              lastEditedByName: data.last_edited_by_name || state.currentUser?.displayName || state.currentUser?.username || 'Admin'
            };
          }
          showToast('Link updated in database');
          wikiState.dirty = true;
          if ($('wikiView') && !$('wikiView').classList.contains('hidden')) {
            loadWikiData();
          }
          panel.classList.add('hidden');
          card?.classList.remove('editing');
          card?.classList.add('edited-flash');
          setTimeout(() => card?.classList.remove('edited-flash'), 1200);
          await loadMainTags();
          runSearch();
        } catch (err) {
          showToast(err.message || 'Edit failed', true);
        } finally {
          btn.disabled = false;
        }
      });
    });

    // Delete from the same DB row the card shows (website + bot stay in sync).
    const deleteLinkById = async (id, btn) => {
      const isComm = state.scope === 'community';
      const item = (isComm ? state.communityLinks : state.personalLinks).find(l => l.id === id);
      const label = item?.title || item?.url || 'this link';
      if (!window.confirm(`Delete "${String(label).slice(0, 80)}" from the database? This cannot be undone.`)) return;
      if (btn) btn.disabled = true;
      try {
        const path = isComm ? '/api/links' : '/api/personal-links';
        const body = isComm
          ? JSON.stringify({ id, community_id: state.activeCommunity })
          : JSON.stringify({ id });
        const { res, data } = await api(path, { method: 'DELETE', body });
        if (!res.ok || !data.success) {
          showToast(data.error || 'Delete failed', true);
          if (btn) btn.disabled = false;
          return;
        }
        const list = isComm ? state.communityLinks : state.personalLinks;
        const idx = list.findIndex(l => l.id === id);
        if (idx >= 0) list.splice(idx, 1);
        showToast('Link deleted from database');
        wikiState.dirty = true;
        if ($('wikiView') && !$('wikiView').classList.contains('hidden')) {
          loadWikiData();
        }
        await loadMainTags();
        runSearch();
      } catch (err) {
        showToast(err.message || 'Delete failed', true);
        if (btn) btn.disabled = false;
      }
    };
    resultsList.querySelectorAll('.del-link-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        deleteLinkById(btn.dataset.id, btn);
      });
    });
    resultsList.querySelectorAll('.edit-delete').forEach(btn => {
      btn.addEventListener('click', () => {
        const panel = btn.closest('.edit-panel');
        deleteLinkById(panel?.dataset.editFor, btn);
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
    const seq = ++searchSeq;
    const q = searchInput.value.trim();
    state.hasSearched = true;
    aiAnswerCard.classList.add('hidden');
    const hasFilter = Boolean(state.filterTag || (state.filterStatus && state.filterStatus !== 'all') || (state.filterSort && state.filterSort !== 'created_desc'));

    if (!q && !hasFilter) {
      enrichmentRefreshKey = '';
      renderHome();
      return;
    }

    if (state.scope === 'community' && !state.activeCommunity) {
      renderGoogleResults([], q);
      emptyStateText.textContent = 'Select a community before searching its links.';
      showToast(emptyStateText.textContent, true);
      return;
    }

    // Local matches cover only the loaded slice; the server searches the full store.
    const localMatches = filterLinks(corpus(), q);
    renderGoogleResults(localMatches, q);
    let skeletonTimer = null;
    if (!localMatches.length) {
      // Wait briefly before showing placeholders to avoid flashing on fast searches.
      skeletonTimer = setTimeout(() => {
        if (seq !== searchSeq) return;
        emptyState.classList.add('hidden');
        resultsMeta.classList.add('hidden');
        resultsList.innerHTML = Array.from({ length: 3 }).map(() => `
          <article class="g-result g-result-skeleton" aria-hidden="true">
            <div class="skeleton sk-cite"></div>
            <div class="skeleton sk-title"></div>
            <div class="skeleton sk-line"></div>
            <div class="skeleton sk-line sk-short"></div>
          </article>`).join('');
      }, 120);
    }

    try {
      const params = new URLSearchParams({ scope: state.scope });
      if (q) params.set('q', q);
      if (state.filterTag) params.set('tag', state.filterTag);
      if (state.filterStatus && state.filterStatus !== 'all') params.set('edited', state.filterStatus);
      if (state.filterSort) params.set('sort', state.filterSort);
      if (state.scope === 'community') {
        params.set('community_id', state.activeCommunity);
      }
      const { res, data } = await api(`/api/links/search?${params.toString()}`);
      if (seq !== searchSeq) return;              // a newer query already ran
      if (searchInput.value.trim() !== q) return; // input moved on
      if (skeletonTimer) clearTimeout(skeletonTimer);
      const responseError = window.AthenaSearch.searchResponseError(res, data);
      if (responseError) {
        if (!resultsList.children.length || resultsList.querySelector('.g-result-skeleton')) {
          renderGoogleResults([], q);
          emptyStateText.textContent = responseError;
        }
        showToast(responseError, true);
        return;
      }

      const documents = filterLinks(corpus().filter(item => item.isDocument), q);
      renderGoogleResults([...data.links.map(normalizeLink), ...documents], q, data.total);
      if (data.enrichment_pending && enrichmentRefreshKey !== q) {
        enrichmentRefreshKey = q;
        setTimeout(() => {
          if (searchInput.value.trim() === q) runSearch();
        }, 1800);
      }
    } catch (err) {
      if (seq !== searchSeq || searchInput.value.trim() !== q || err.auth) return;
      const message = 'Could not load search results. Check your connection and try again.';
      if (!resultsList.children.length || resultsList.querySelector('.g-result-skeleton')) {
        renderGoogleResults([], q);
        emptyStateText.textContent = message;
      }
      showToast(message, true);
    } finally {
      if (skeletonTimer) clearTimeout(skeletonTimer);
    }
  }

  async function loadMainTags() {
    const summaryEl = $('mainTagsSummary');
    const cloudEl = $('mainTagsCloud');
    if (!cloudEl) return;
    try {
      const qParams = new URLSearchParams({ scope: state.scope });
      if (state.scope === 'community' && state.activeCommunity) {
        qParams.set('community_id', state.activeCommunity);
      }
      const { res, data } = await api(`/api/tags?${qParams.toString()}`);
      if (res.ok && data.success && Array.isArray(data.tags)) {
        state.tags = data.tags;
        state.tagStats = {
          total: data.total || 0,
          taggedCount: data.tagged_count || 0,
          untaggedCount: data.untagged_count || 0,
          uniqueTags: data.unique_tags || 0
        };
        renderMainTags();
      } else if (summaryEl) {
        summaryEl.textContent = 'Tags unavailable';
      }
    } catch (_) {
      if (summaryEl) summaryEl.textContent = '';
    }
  }

  function renderMainTags() {
    const summaryEl = $('mainTagsSummary');
    const cloudEl = $('mainTagsCloud');
    const clearBtn = $('mainTagClearBtn');
    if (!cloudEl) return;

    if (clearBtn) {
      clearBtn.classList.toggle('hidden', !state.filterTag);
    }

    if (summaryEl && state.tagStats) {
      summaryEl.textContent = `${state.tagStats.uniqueTags} tags · ${state.tagStats.total} total links`;
    }

    if (!state.tags || !state.tags.length) {
      cloudEl.innerHTML = '<span style="color:var(--text-muted);font-size:0.75rem;">No tags found in this corpus.</span>';
      return;
    }

    cloudEl.innerHTML = state.tags.map(t => {
      const isSelected = state.filterTag && state.filterTag.toLowerCase() === t.name.toLowerCase();
      const isNoTags = t.name.toLowerCase() === 'notags';
      return `
        <button type="button" class="main-tag-chip ${isSelected ? 'active' : ''}" aria-pressed="${Boolean(isSelected)}" data-tag="${escapeHtml(t.name)}" title="${isNoTags ? 'Untagged links' : `Tag #${escapeHtml(t.name)}`} (${t.count})">
          <span>#${escapeHtml(t.name)}</span>
          <span class="admin-tag-count">(${t.count.toLocaleString()})</span>
        </button>
      `;
    }).join('');

    cloudEl.querySelectorAll('.main-tag-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const selected = chip.dataset.tag;
        if (!selected) return;
        if (state.filterTag && state.filterTag.toLowerCase() === selected.toLowerCase()) {
          state.filterTag = '';
        } else {
          state.filterTag = selected;
        }
        renderMainTags();
        runSearch();
      });
    });
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

    state.conversationHistory.push({ role: 'user', content: q });
    renderChatThread(true);

    try {
      const result = await window.AthenaAI.answerFromBrain(
        q, corpus(),
        (_delta, full) => {
          const el = aiAnswerText.querySelector('.chat-msg:last-child .chat-answer-content');
          if (el) { el.textContent = full; el.classList.add('streaming'); }
        },
        state.conversationHistory,
        (_chunk, fullThinking) => {
          const el = aiAnswerText.querySelector('.chat-msg:last-child .thinking-content');
          if (el) el.textContent = fullThinking;
        }
      );

      state.conversationHistory.push({
        role: 'assistant',
        content: result.answer,
        thinking: result.thinking || ''
      });

      renderChatThread(false);

      const label = document.querySelector('.ai-answer-label');
      if (label) {
        if (result.mode === 'llm') {
          const engine = String(result.retrievalEngine || '').includes('meilisearch')
            ? 'Meilisearch + PostgreSQL'
            : result.retrievalEngine === 'browser-local'
              ? 'local matches'
              : 'PostgreSQL';
          label.textContent = `AI · grounded in ${engine}`;
        } else {
          const errHint = result.error ? ` — ${result.error}` : '';
          label.textContent = `AI · ${errHint ? 'local fallback' : 'local brain'}${errHint ? '' : ' (add API key in Settings for full assistant)'}`;
          if (result.error) {
            showToast(result.error, true);
            console.warn('[athena] AI fell back to local:', result.error);
          }
        }
      }

      if (result.error && result.mode === 'local') {
        const errDiv = document.createElement('div');
        errDiv.className = 'ai-fallback-banner';
        errDiv.style.cssText = 'margin:8px 0;padding:8px 12px;background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.35);border-radius:8px;color:var(--text-color);font-size:0.85em';
        const d = result.errorDetails;
        const detail = d ? ` (HTTP ${d.status || '?'}${d.model ? ` · ${d.model}` : ''})` : '';
        errDiv.textContent = `${result.error}${detail}`;
        aiAnswerText.appendChild(errDiv);
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
      state.conversationHistory.pop();
      renderChatThread(false);
      showToast(err.message, true);
      console.error('[athena] runAi failed:', err);
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

  /** Storage backend panel — PostgreSQL only. */
  // eslint-disable-next-line no-unused-vars
  function updateStorageSyncLabel(_provider) { return; }

  async function loadStorageForm() {
    const god = canEditAiConfig();
    storageGodBadge?.classList.toggle('hidden', !god);
    try {
      const { res, data } = await api('/api/storage/config');
      if (!res.ok) return;
      const _provider = data.provider || 'postgres';
      if (storageProvider) {
        storageProvider.innerHTML = `<option value="postgres" selected>PostgreSQL — ${escapeHtml(data.db_engine || 'PostgreSQL')}</option>`;
        storageProvider.value = 'postgres';
        storageProvider.disabled = true;
      }
      if (storageStatus) {
        storageStatus.innerHTML = `<span style="color:var(--success-color)">${escapeHtml(data.db_engine || 'PostgreSQL')} — PostgreSQL only (D1/GitHub removed)</span>`;
      }
      if (storageDesc) {
        storageDesc.textContent = `PostgreSQL — the only store. MCP memory uses the same DB via postgres-mcp (DATABASE_URL).`;
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
      const isGodUser = isGod() || canEditAiConfig();
      const hasLocal = !!(cfg.apiKey && cfg.baseUrl && cfg.model);
      let html;
      if (serverOk) {
        html = `<span style="color:var(--success-color)">API ready · ${escapeHtml(cfg.model || model?.value || 'model')} · synced for bot /ai</span>`;
      } else if (hasLocal && isGodUser) {
        html = `<span style="color:var(--warning-color)">Local key present (${escapeHtml(cfg.model || model?.value || 'model')}) — not synced to server. Click Save to sync bot & enable AI for all users. If Save fails, check GOD rank and STORAGE_KEY.</span>`;
      } else if (hasLocal && !isGodUser) {
        html = `<span style="color:var(--warning-color)">Local key saved in browser but you are not GOD — instance has no key. GOD must configure in Settings → AI.</span>`;
      } else {
        html = '<span style="color:var(--text-muted)">No API key — GOD: Settings → AI → Save</span>';
      }
      const lastCfg = window.AthenaAI?.getLastServerAiConfig?.();
      if (lastCfg && lastCfg.configured && !lastCfg.hasKey) {
        html += `<br><span style="color:var(--danger-color)">Server row exists but key unreadable — STORAGE_KEY missing/rotated? Re-save credentials.</span>`;
      }
      status.innerHTML = html;
    }

    const steroidToggle = $('steroidModeToggle');
    if (steroidToggle) {
      try {
        const { data: sData } = await api('/api/ai/steroid');
        steroidToggle.checked = !!sData.steroid;
        window.__athenaSteroid = !!sData.steroid;
        renderSteroidCaps(!!sData.steroid, sData.caps);
      } catch (_) {
        try {
          const { data: inst } = await api('/api/instance/config');
          steroidToggle.checked = !!inst.steroid;
          window.__athenaSteroid = !!inst.steroid;
        } catch (_) {}
      }
      steroidToggle.disabled = !canEditAiConfig();
    }
    loadAiErrors(false);
    updateAiFreeBadge();
  }

  function renderSteroidCaps(on, caps) {
    const el = $('steroidCapsDesc');
    if (!el) return;
    if (!caps) { el.textContent = on ? 'On = unlimited.' : 'Off = throttled (default).'; return; }
    const fmt = (v, unit) => v == null ? `no ${unit} cap` : `${v} ${unit}`;
    el.textContent = on
      ? `On: ${fmt(caps.retrieval_limit, 'item retrieval cap')}, full RAG context, enrichment ${caps.enrich_concurrency}× parallel.`
      : `Off (default): retrieval capped at ${caps.retrieval_limit}, top ${caps.rag_slice} into the prompt, enrichment 1 at a time.`;
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

  // --- GOD: provider model catalog + recent AI error log ---
  let aiModelCatalog = null;
  let aiModelCatalogKey = '';
  let aiModelPage = 0;
  const AI_MODEL_PAGE_SIZE = 100;

  async function loadAiModels(force = false) {
    if (!canEditAiConfig()) return showToast('Model picker is GOD only', true);
    const list = $('aiModelList');
    const picker = $('aiModelPicker');
    if (!picker) return;
    const base = $('aiBaseUrl')?.value.trim() || '';
    const key = $('aiApiKey')?.value.trim() || '';
    const catalogKey = `${base}\u0000${key}`;
    if (picker.classList.contains('hidden')) {
      picker.classList.remove('hidden');
    } else if (!force && aiModelCatalog && aiModelCatalogKey === catalogKey) {
      picker.classList.add('hidden');
      return;
    }
    if (!force && aiModelCatalog && aiModelCatalogKey === catalogKey) {
      return renderModelList($('aiModelFilter')?.value || '');
    }
    if (list) list.innerHTML = '<div class="model-item status-msg">Loading models…</div>';
    try {
      // Candidate (unsaved) base+key from the form, if both present — the
      // server refuses mixed pairs, so send them together or neither.
      const qs = new URLSearchParams();
      // Key goes in a header, not the URL — query strings land in proxy logs.
      if (base && key) { qs.set('base', base); }
      if (force) qs.set('refresh', '1');
      const { res, data } = await api(`/api/ai/models${qs.toString() ? `?${qs}` : ''}`, key ? { headers: { 'x-ai-key': key } } : {});
      if (!res.ok || data.success === false) {
        if (list) list.innerHTML = `<div class="model-item" style="color:var(--danger-color)">${escapeHtml(data.error || `HTTP ${res.status}`)}</div>`;
        return;
      }
      aiModelCatalog = data.models || [];
      aiModelCatalogKey = catalogKey;
      aiModelPage = 0;
      renderModelList($('aiModelFilter')?.value || '');
    } catch (err) {
      if (list) list.innerHTML = `<div class="model-item" style="color:var(--danger-color)">${escapeHtml(err.message)}</div>`;
    }
  }

  function renderModelList(filterText) {
    const list = $('aiModelList');
    if (!list || !aiModelCatalog) return;
    const pager = $('aiModelPager');
    const f = (filterText || '').toLowerCase();
    const items = aiModelCatalog.filter((m) => !f || m.id.toLowerCase().includes(f) || (m.name || '').toLowerCase().includes(f));
    if (!items.length) {
      list.innerHTML = '<div class="model-item status-msg">No models match.</div>';
      if (pager) pager.innerHTML = '';
      return;
    }
    const pageCount = Math.max(1, Math.ceil(items.length / AI_MODEL_PAGE_SIZE));
    aiModelPage = Math.min(Math.max(aiModelPage, 0), pageCount - 1);
    const start = aiModelPage * AI_MODEL_PAGE_SIZE;
    const visible = items.slice(start, start + AI_MODEL_PAGE_SIZE);
    list.innerHTML = visible.map((m) => {
      const ctx = m.context_length ? ` · ${(m.context_length / 1000).toFixed(0)}k ctx` : '';
      let price = '';
      if (m.pricing) {
        const parts = [];
        if (m.pricing.prompt != null) parts.push(`$${Number(m.pricing.prompt).toFixed(2)}/M in`);
        if (m.pricing.completion != null) parts.push(`$${Number(m.pricing.completion).toFixed(2)}/M out`);
        if (parts.length) price = ` · ${parts.join(' · ')}`;
      }
      const cls = m.free ? 'model-item model-free' : 'model-item';
      const tag = m.free ? '<span style="color:var(--success-color);font-weight:600;">FREE</span> ' : '';
      const name = m.name && m.name !== m.id ? `<span class="status-msg">${escapeHtml(m.name)} · </span>` : '';
      return `<div class="${cls}" role="option" tabindex="0" data-model="${escapeHtml(m.id)}">${tag}<span class="model-id">${escapeHtml(m.id)}</span><span class="status-msg">${name}${ctx}${price}</span></div>`;
    }).join('');
    list.querySelectorAll('.model-item[data-model]').forEach((el) => {
      const pick = () => {
        const model = $('aiModel');
        if (model) { model.value = el.dataset.model; updateAiFreeBadge(); }
      };
      el.addEventListener('click', pick);
      el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); } });
    });
    if (pager) {
      pager.innerHTML = `<span>Showing ${start + 1}–${Math.min(start + visible.length, items.length)} of ${items.length}${aiModelCatalog.length !== items.length ? ` · ${aiModelCatalog.length} total` : ''}</span><span style="display:flex;gap:6px;"><button type="button" class="btn btn-secondary" data-model-page="prev" ${aiModelPage === 0 ? 'disabled' : ''}>‹</button><span>${aiModelPage + 1}/${pageCount}</span><button type="button" class="btn btn-secondary" data-model-page="next" ${aiModelPage >= pageCount - 1 ? 'disabled' : ''}>›</button></span>`;
      pager.querySelector('[data-model-page="prev"]')?.addEventListener('click', () => { aiModelPage--; renderModelList(filterText); });
      pager.querySelector('[data-model-page="next"]')?.addEventListener('click', () => { aiModelPage++; renderModelList(filterText); });
    }
  }

  async function loadAiErrors(showPanel) {
    const panel = $('aiErrorPanel');
    if (!panel) return;
    if (!canEditAiConfig()) { panel.classList.add('hidden'); return; }
    if (showPanel) panel.classList.remove('hidden');
    const list = $('aiErrorList');
    try {
      const { data } = await api('/api/ai/errors');
      const errors = data.errors || [];
      const count = $('aiErrorCount');
      if (count) count.textContent = errors.length ? `(${errors.length})` : '';
      if (!errors.length) {
        if (list) list.innerHTML = '<div class="model-item status-msg">No recent errors — in-memory log clears on restart.</div>';
        return;
      }
      if (list) {
        list.innerHTML = errors.slice(0, 20).map((e) => {
          const t = new Date(e.time).toLocaleTimeString();
          const st = e.status ? `HTTP ${e.status}` : '';
          return `<div class="model-item"><span class="status-msg">${escapeHtml(t)} · ${escapeHtml(e.source)} · ${escapeHtml(e.model || '')} ${escapeHtml(st)}</span><br>${escapeHtml(e.message || '')}</div>`;
        }).join('');
      }
    } catch (_) {
      if (list) list.innerHTML = '<div class="model-item status-msg">Could not load error log.</div>';
    }
  }

  async function onSubmit(e) {
    e.preventDefault();
    const q = searchInput.value.trim();
    if (!q) return;
    try {
      if (state.mode === 'dump') {
        await saveDump(q);
      } else if (state.mode === 'delete') {
        await runDelete(q);
      } else if (state.mode === 'ai') {
        await runAi();
      } else {
        runSearch();
      }
    } catch (err) {
      if (!err.auth) showToast(err.message || 'Request failed', true);
    }
  }

  // ---- Theme (UI only) ----

  const THEME_ORDER = ['dark', 'light', 'material', 'glass'];
  const THEME_META = { dark: '#0a0a0a', light: '#f4f5f9', material: '#121218', glass: '#05060c' };

  function applyTheme(theme) {
    const t = THEME_ORDER.includes(theme) ? theme : 'dark';
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('athena_theme', t); } catch (_) {}
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = THEME_META[t];
    document.querySelectorAll('.theme-chip').forEach(chip => {
      const selected = chip.dataset.theme === t;
      chip.classList.toggle('active', selected);
      chip.setAttribute('aria-pressed', String(selected));
    });
    let customAccent = null;
    try { customAccent = localStorage.getItem(ACCENT_LS_KEY); } catch (_) {}
    applyAccentColor(validAccent(customAccent) ? customAccent : defaultAccent(), false);
  }

  function initThemeUI() {
    let saved = 'dark';
    try { saved = localStorage.getItem('athena_theme') || 'dark'; } catch (_) {}
    applyTheme(saved);
    document.querySelectorAll('.theme-chip').forEach(chip => {
      chip.addEventListener('click', () => applyTheme(chip.dataset.theme));
    });
  }

  // ---- Glass appearance ----
  function initGlassBlur() {
    const input = $('glassBlurInput');
    const output = $('glassBlurValue');
    if (!input || !output) return;
    let saved = null;
    try { saved = localStorage.getItem('athena_glass_blur'); } catch (_) {}
    const value = saved !== null && /^-?\d+$/.test(saved) ? Math.max(0, Math.min(40, Number(saved))) : 24;
    function applyBlur(blur, persist) {
      const amount = Math.max(0, Math.min(40, Math.round(Number(blur))));
      input.value = String(amount);
      output.textContent = `${amount} px`;
      input.setAttribute('aria-valuetext', `${amount} pixels`);
      document.documentElement.style.setProperty('--glass-blur', `${amount}px`);
      if (persist) {
        try { localStorage.setItem('athena_glass_blur', String(amount)); } catch (_) {}
      }
    }
    applyBlur(value, false);
    input.addEventListener('input', () => applyBlur(input.value, true));
  }

  // ---- Accent color system ----
  const ACCENT_DEFAULT = '#8e70f6';
  const ACCENT_LS_KEY = 'athena_accent_color';
  const validAccent = hex => /^#[0-9a-f]{6}$/i.test(hex || '');
  const defaultAccent = () => document.documentElement.dataset.theme === 'dark' ? '#0072f5' : ACCENT_DEFAULT;

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

  function applyAccentColor(hex, persist = true) {
    const root = document.documentElement;
    const hsl = hexToHsl(hex);
    const h = hsl.h, s = hsl.s, l = hsl.l;

    root.style.setProperty('--accent', hex);
    const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
    const luminance = rgb.map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2)
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
    const fg = (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? '#000000' : '#ffffff';
    root.style.setProperty('--accent-fg', fg);
    root.style.setProperty('--accent-soft', `hsla(${h}, ${s}%, ${l}%, 0.22)`);
    root.style.setProperty('--accent-gradient', hex);
    root.style.setProperty('--accent-hover', `hsl(${h}, ${Math.min(s + 5, 100)}%, ${Math.min(l + 8, 85)}%)`);
    root.style.setProperty('--accent-surface', `hsla(${h}, ${s}%, ${l}%, 0.08)`);
    root.style.setProperty('--accent-border', `hsla(${h}, ${s}%, ${l}%, 0.35)`);
    root.style.setProperty('--primary-purple', hex);
    root.style.setProperty('--border-highlight', `hsla(${h}, ${s}%, ${l}%, 0.35)`);

    if (persist) { try { localStorage.setItem(ACCENT_LS_KEY, hex); } catch (_) {} }

    const input = $('accentColorInput');
    const label = $('accentCurrentLabel');
    if (input) input.value = hex;
    if (label) label.textContent = hex;

    document.querySelectorAll('.accent-swatch').forEach(sw => {
      sw.classList.toggle('active', sw.dataset.color.toLowerCase() === hex.toLowerCase());
    });
  }

  function initAccentColor() {
    let saved = null;
    try { saved = localStorage.getItem(ACCENT_LS_KEY); } catch (_) {}
    saved = validAccent(saved) ? saved : defaultAccent();
    applyAccentColor(saved, false);

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
        try { localStorage.removeItem(ACCENT_LS_KEY); } catch (_) {}
        applyAccentColor(defaultAccent(), false);
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

      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!reduceMotion) svg.classList.add('rolling');

      setTimeout(() => {
        svg.classList.remove('rolling');
        renderDicePips(newFace);
        currentFace = newFace;
        rolling = false;
      }, reduceMotion ? 0 : 600);
    }

    mark.addEventListener('click', rollDice);
  }

  // ---- Admin & Owner Database Explorer ----

  const adminDbState = {
    scope: 'community',
    communityId: '',
    status: 'all',
    sort: 'created_desc',
    tag: '',
    q: '',
    page: 1,
    limit: 25,
    totalPages: 1,
    total: 0,
    links: [],
    tags: [],
    communities: [],
    loading: false
  };

  function renderAdminDbLockedView(customMsg = null) {
    const adminView = $('adminDbView');
    if (!adminView) return;
    const listEl = $('adminDbList');
    const countBadge = $('adminDbCountBadge');
    const rankBadge = $('adminDbRankBadge');
    const headerControls = adminView.querySelector('.admin-db-controls');
    const searchBar = adminView.querySelector('.admin-db-search-bar');
    const tagsContainer = adminView.querySelector('.admin-tags-container');
    const summary = adminView.querySelector('.admin-db-summary');
    const pager = $('adminDbPagination');

    if (headerControls) headerControls.style.display = 'none';
    if (searchBar) searchBar.style.display = 'none';
    if (tagsContainer) tagsContainer.style.display = 'none';
    if (summary) summary.style.display = 'none';
    if (pager) pager.classList.add('hidden');

    if (countBadge) countBadge.textContent = 'Access restricted';
    if (rankBadge) {
      rankBadge.textContent = 'Admin Only';
      rankBadge.style.opacity = '0.75';
    }

    if (listEl) {
      listEl.innerHTML = `
        <div class="admin-locked-card" id="adminDbLockedCard">
          <div class="admin-locked-icon" aria-hidden="true">
            <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
            </svg>
          </div>
          <h3>Only for Admin</h3>
          <p class="admin-locked-desc">${escapeHtml(customMsg || 'Database management is restricted to community administrators and owners. If you were recently granted admin rank via Telegram, verify you are logged in with that Telegram account.')}</p>
          <button type="button" id="adminLockedBackBtn" class="btn btn-primary btn-sm admin-locked-back-btn">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:6px;"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
            <span>Back to Search</span>
          </button>
        </div>
      `;
      $('adminLockedBackBtn')?.addEventListener('click', closeAdminDb);
    }
  }

  function openAdminDb() {
    const adminView = $('adminDbView');
    const searchWrap = $('searchWrapper');
    const scopeSwitch = document.querySelector('.scope-switch-container');
    if (!adminView || !searchWrap) return;

    searchWrap.classList.add('hidden');
    if (scopeSwitch) scopeSwitch.classList.add('hidden');
    $('wikiView')?.classList.add('hidden');
    $('wikiSidebar')?.classList.remove('mobile-open');
    $('wikiSidebarBackdrop')?.classList.add('hidden');
    document.body.classList.remove('wiki-active');
    document.body.style.overflow = '';
    adminView.classList.remove('hidden');

    const badge = $('modeBadgeText');
    if (badge) badge.textContent = 'Database';

    if (window.location.hash !== '#db') {
      window.history.pushState(null, '', '#db');
    }

    if (!isStaffRank()) {
      renderAdminDbLockedView();
      return;
    }

    const headerControls = adminView.querySelector('.admin-db-controls');
    if (headerControls) headerControls.style.display = '';
    const searchBar = adminView.querySelector('.admin-db-search-bar');
    if (searchBar) searchBar.style.display = '';
    const tagsContainer = adminView.querySelector('.admin-tags-container');
    if (tagsContainer) tagsContainer.style.display = '';
    const summary = adminView.querySelector('.admin-db-summary');
    if (summary) summary.style.display = '';
    const rankBadge = $('adminDbRankBadge');
    if (rankBadge) {
      rankBadge.textContent = isGod() ? 'GOD' : 'Admin & Owner';
      rankBadge.style.opacity = '1';
    }

    if (adminDbState.scope === 'personal' && !isGod()) {
      adminDbState.scope = 'community';
      const scopeSel = $('adminDbScope');
      if (scopeSel) scopeSel.value = 'community';
    }

    if (!adminDbState.communityId && state.activeCommunity) {
      adminDbState.communityId = state.activeCommunity;
    }

    loadAdminDbLinks();
  }

  function closeAdminDb() {
    const adminView = $('adminDbView');
    const searchWrap = $('searchWrapper');
    const scopeSwitch = document.querySelector('.scope-switch-container');
    if (!adminView || !searchWrap) return;

    adminView.classList.add('hidden');
    searchWrap.classList.remove('hidden');
    $('resultsContainer')?.classList.remove('hidden');
    if (scopeSwitch) scopeSwitch.classList.remove('hidden');

    const badge = $('modeBadgeText');
    if (badge) badge.textContent = state.mode ? state.mode.charAt(0).toUpperCase() + state.mode.slice(1) : 'Search';

    if (window.location.hash === '#db' || window.location.hash === '#admin') {
      window.history.pushState(null, '', window.location.pathname + window.location.search);
    }
  }

  async function loadAdminDbLinks() {
    if (adminDbState.loading) return;
    adminDbState.loading = true;
    const listEl = $('adminDbList');
    const countBadge = $('adminDbCountBadge');
    if (countBadge) countBadge.textContent = 'Fetching links…';
    if (listEl && !adminDbState.links.length) {
      listEl.innerHTML = '<div class="empty-state"><p>Loading database links…</p></div>';
    }

    try {
      const qParams = new URLSearchParams({
        scope: adminDbState.scope,
        edited: adminDbState.status,
        sort: adminDbState.sort,
        page: String(adminDbState.page),
        limit: String(adminDbState.limit)
      });
      if (adminDbState.scope === 'community' && adminDbState.communityId) {
        qParams.set('community_id', adminDbState.communityId);
      }
      if (adminDbState.tag) qParams.set('tag', adminDbState.tag);
      if (adminDbState.q) qParams.set('q', adminDbState.q);

      const { res, data } = await api(`/api/admin/links?${qParams.toString()}`);
      if (!res.ok || !data.success) {
        if (res.status === 403 || data?.code === 'ADMIN_ONLY') {
          renderAdminDbLockedView(data?.error);
          return;
        }
        showToast(data.error || 'Failed to load database links', true);
        if (countBadge) countBadge.textContent = 'Failed to load records';
        if (listEl) listEl.innerHTML = `<div class="empty-state"><p>${escapeHtml(data.error || 'Access denied or failed to load.')}</p></div>`;
        return;
      }

      adminDbState.links = data.links || [];
      adminDbState.total = data.total || 0;
      adminDbState.page = data.page || 1;
      adminDbState.totalPages = data.totalPages || 1;
      adminDbState.tags = data.tags || [];
      adminDbState.communities = data.communities || [];

      const commSel = $('adminDbCommunity');
      if (commSel && adminDbState.communities.length) {
        commSel.innerHTML = adminDbState.communities.map(c =>
          `<option value="${escapeHtml(c.id)}" ${c.id === (adminDbState.communityId || data.community_id) ? 'selected' : ''}>${escapeHtml(c.name || c.id)}</option>`
        ).join('');
        if (!adminDbState.communityId && data.community_id) {
          adminDbState.communityId = data.community_id;
        }
      }

      renderAdminDbTags();
      renderAdminDbLinks();
      renderAdminDbSummary();
      renderAdminDbPagination();
    } catch (err) {
      showToast(err.message || 'Error fetching database records', true);
      if (countBadge) countBadge.textContent = 'Failed to load records';
      if (listEl) listEl.innerHTML = `<div class="empty-state"><p>${escapeHtml(err.message || 'Failed to load.')}</p></div>`;
    } finally {
      adminDbState.loading = false;
    }
  }

  function renderAdminDbSummary() {
    const badge = $('adminDbCountBadge');
    if (!badge) return;
    const start = adminDbState.total === 0 ? 0 : (adminDbState.page - 1) * adminDbState.limit + 1;
    const end = Math.min(adminDbState.page * adminDbState.limit, adminDbState.total);
    badge.textContent = adminDbState.total > 0
      ? `Showing ${start}–${end} of ${adminDbState.total} links`
      : '0 links found in this scope';

    const activeFilter = $('adminDbActiveFilter');
    if (activeFilter) {
      if (adminDbState.tag) {
        activeFilter.classList.remove('hidden');
        activeFilter.innerHTML = `Tag: #${escapeHtml(adminDbState.tag)} <span style="cursor:pointer;margin-left:4px;" title="Clear tag filter">&times;</span>`;
        activeFilter.onclick = () => {
          adminDbState.tag = '';
          adminDbState.page = 1;
          loadAdminDbLinks();
        };
      } else {
        activeFilter.classList.add('hidden');
      }
    }
  }

  function renderAdminDbTags() {
    const cloud = $('adminTagsCloud');
    const clearBtn = $('adminTagClearBtn');
    if (!cloud) return;
    if (clearBtn) clearBtn.classList.toggle('hidden', !adminDbState.tag);

    if (!adminDbState.tags || !adminDbState.tags.length) {
      cloud.innerHTML = '<span style="font-size:0.75rem;color:var(--text-muted)">No tags detected in this scope</span>';
      return;
    }

    cloud.innerHTML = adminDbState.tags.map(t => {
      const active = adminDbState.tag.toLowerCase() === t.name.toLowerCase();
      return `<button type="button" class="admin-tag-chip ${active ? 'active' : ''}" data-tag="${escapeHtml(t.name)}">
        <span>#${escapeHtml(t.name)}</span>
        <span class="admin-tag-count">(${t.count})</span>
      </button>`;
    }).join('');

    cloud.querySelectorAll('.admin-tag-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const selected = btn.dataset.tag;
        if (adminDbState.tag.toLowerCase() === selected.toLowerCase()) {
          adminDbState.tag = '';
        } else {
          adminDbState.tag = selected;
        }
        adminDbState.page = 1;
        loadAdminDbLinks();
      });
    });
  }

  function renderAdminDbPagination() {
    const pager = $('adminDbPagination');
    const prevBtn = $('adminDbPrevBtn');
    const nextBtn = $('adminDbNextBtn');
    const pageInfo = $('adminDbPageInfo');
    if (!pager || !prevBtn || !nextBtn || !pageInfo) return;

    if (adminDbState.totalPages <= 1) {
      pager.classList.add('hidden');
      return;
    }
    pager.classList.remove('hidden');
    pageInfo.textContent = `Page ${adminDbState.page} of ${adminDbState.totalPages}`;
    prevBtn.disabled = adminDbState.page <= 1;
    nextBtn.disabled = adminDbState.page >= adminDbState.totalPages;
  }

  function renderAdminDbLinks() {
    const listEl = $('adminDbList');
    if (!listEl) return;
    if (!adminDbState.links.length) {
      const emptyMsg = (adminDbState.scope === 'community' && !adminDbState.communities.length)
        ? 'No communities found where you have admin permissions.'
        : 'No links matched your query or filters.';
      listEl.innerHTML = `<div class="empty-state">
        <p>${escapeHtml(emptyMsg)}</p>
      </div>`;
      return;
    }

    listEl.innerHTML = '';
    adminDbState.links.forEach(item => {
      const card = document.createElement('article');
      card.className = 'admin-card';
      card.dataset.id = item.id;

      const displayUrl = item.url
        ? item.url.replace(/^https?:\/\//, '').replace(/\/$/, '')
        : 'note · local';
      const href = item.url || '#';
      const site = item.site_name || '';
      const when = formatDateTime(item.created_at);

      let favicon = '';
      try {
        if (item.url && item.url.startsWith('http')) {
          const u = new URL(item.url);
          favicon = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(u.hostname)}&sz=32`;
        }
      } catch (_) {}

      const auditHtml = item.manual_edited_at
        ? `<span class="admin-edit-badge" title="Manually edited">
            ✏️ Last edited by <strong>${escapeHtml(item.last_edited_by_name || 'Admin')}</strong> · ${escapeHtml(formatDateTime(item.manual_edited_at))}
           </span>`
        : `<span style="color:var(--text-muted)">Unedited · Original version</span>`;

      const tagsHtml = (item.tags || []).length
        ? `<div class="admin-card-tags">
            ${item.tags.map(t => `<span class="admin-card-tag" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</span>`).join('')}
           </div>`
        : `<div class="admin-card-tags">
            <span class="admin-card-tag admin-card-notag" data-tag="notags" title="Untagged link — click to view untagged" style="opacity:0.65;font-style:italic;">#notags</span>
           </div>`;

      card.innerHTML = `
        <div class="admin-card-head">
          <div class="admin-card-url-row">
            ${favicon ? `<img src="${safeHref(favicon)}" alt="" width="16" height="16" loading="lazy" referrerpolicy="no-referrer" style="border-radius:3px;">` : ''}
            <span>${site ? escapeHtml(site) + ' · ' : ''}${escapeHtml(displayUrl)}</span>
          </div>
          <div class="admin-card-actions">
            <button type="button" class="btn btn-secondary btn-sm admin-card-edit-btn" data-id="${escapeHtml(item.id)}" title="Edit link">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:4px;"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
              Edit
            </button>
            <button type="button" class="btn btn-secondary btn-sm admin-card-del-btn" data-id="${escapeHtml(item.id)}" data-title="${escapeHtml(item.title || item.url || 'this link')}" title="Delete link">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:4px;"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
              Delete
            </button>
          </div>
        </div>
        <a class="admin-card-title" href="${safeHref(href)}" ${item.url ? 'target="_blank" rel="noopener noreferrer"' : ''}>
          ${escapeHtml(item.title || 'Untitled')}
        </a>
        ${item.notes ? `<p class="admin-card-notes">${escapeHtml(item.notes)}</p>` : ''}
        ${tagsHtml}
        <div class="admin-audit-bar">
          <div class="admin-audit-info">
            <span>Added by <strong>${escapeHtml(item.added_by_name || item.added_by || 'Member')}</strong> · ${escapeHtml(when)}</span>
            ${auditHtml}
          </div>
        </div>
        <div class="edit-panel hidden" data-edit-for="${escapeHtml(item.id)}">
          <label>Title</label>
          <input type="text" class="edit-title" value="${escapeHtml(item.title || '')}" />
          <label>URL</label>
          <input type="url" class="edit-url" value="${escapeHtml(item.url || '')}" />
          <label>Description / Notes</label>
          <textarea class="edit-notes" rows="3">${escapeHtml(item.notes || '')}</textarea>
          <label>Tags (space or comma-separated)</label>
          <input type="text" class="edit-tags" value="${escapeHtml((item.tags || []).map(t => '#' + t).join(' '))}" placeholder="e.g. #ai #tools #docs" />
          <div class="edit-panel-actions">
            <button type="button" class="btn btn-primary btn-sm admin-save-btn">Save Changes</button>
            <button type="button" class="btn btn-secondary btn-sm admin-cancel-btn">Cancel</button>
            <button type="button" class="btn btn-secondary btn-sm admin-panel-del-btn" data-id="${escapeHtml(item.id)}" data-title="${escapeHtml(item.title || item.url || 'this link')}" style="margin-left:auto;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:4px;"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
              Delete Link
            </button>
          </div>
        </div>
      `;
      listEl.appendChild(card);
    });

    listEl.querySelectorAll('.admin-card-tag').forEach(tagEl => {
      tagEl.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const tag = tagEl.dataset.tag;
        if (!tag) return;
        adminDbState.tag = tag;
        adminDbState.page = 1;
        loadAdminDbLinks();
      });
    });

    listEl.querySelectorAll('.admin-card-del-btn, .admin-panel-del-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = btn.dataset.id;
        const itemTitle = btn.dataset.title || 'this link';
        if (!id) return;
        if (!confirm(`Delete "${itemTitle}" permanently from database?`)) return;

        btn.disabled = true;
        try {
          const isComm = adminDbState.scope === 'community';
          const path = isComm ? '/api/links' : '/api/personal-links';
          const body = isComm ? { id, community_id: adminDbState.communityId } : { id };
          const { res, data } = await api(path, {
            method: 'DELETE',
            body: JSON.stringify(body)
          });
          if (!res.ok || !data.success) {
            showToast(data.error || 'Delete failed', true);
            btn.disabled = false;
            return;
          }
          showToast('Link deleted from database');
          wikiState.dirty = true;
          const list = isComm ? state.communityLinks : state.personalLinks;
          const mainIdx = list.findIndex(l => l.id === id);
          if (mainIdx >= 0) list.splice(mainIdx, 1);
          const topSearch = $('searchInput');
          if (topSearch?.value?.trim()) {
            try { runSearch(); } catch (_) {}
          }
          await loadAdminDbLinks();
        } catch (err) {
          showToast(err.message || 'Delete failed', true);
          btn.disabled = false;
        }
      });
    });

    listEl.querySelectorAll('.admin-card-edit-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const id = btn.dataset.id;
        const card = btn.closest('.admin-card');
        const panel = card?.querySelector(`.edit-panel[data-edit-for="${CSS.escape(id)}"]`);
        if (!panel) return;
        listEl.querySelectorAll('.edit-panel').forEach(p => { if (p !== panel) p.classList.add('hidden'); });
        listEl.querySelectorAll('.admin-card').forEach(c => c.classList.remove('editing'));
        panel.classList.toggle('hidden');
        card.classList.toggle('editing', !panel.classList.contains('hidden'));
        if (!panel.classList.contains('hidden')) {
          panel.querySelector('.edit-title')?.focus();
        }
      });
    });

    listEl.querySelectorAll('.admin-cancel-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const panel = btn.closest('.edit-panel');
        const card = btn.closest('.admin-card');
        panel?.classList.add('hidden');
        card?.classList.remove('editing');
      });
    });

    listEl.querySelectorAll('.admin-save-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const panel = btn.closest('.edit-panel');
        const card = btn.closest('.admin-card');
        const id = panel?.dataset.editFor;
        if (!id || !panel) return;

        const title = panel.querySelector('.edit-title')?.value?.trim() || '';
        const url = panel.querySelector('.edit-url')?.value?.trim() || '';
        const notes = panel.querySelector('.edit-notes')?.value?.trim() || '';
        const tagsVal = panel.querySelector('.edit-tags')?.value?.trim() || '';
        const tags = tagsVal.split(/[\s,]+/).map(t => t.replace(/^#+/, '').trim()).filter(Boolean);

        if (!url && !title && !notes) {
          showToast('Nothing to save', true);
          return;
        }

        btn.disabled = true;
        try {
          const path = adminDbState.scope === 'community' ? '/api/links' : '/api/personal-links';
          const { res, data } = await api(path, {
            method: 'PATCH',
            body: JSON.stringify({ id, title, url, notes, tags })
          });
          if (!res.ok || !data.success) {
            showToast(data.error || 'Edit failed', true);
            return;
          }

          const idx = adminDbState.links.findIndex(l => l.id === id);
          if (idx >= 0) {
            adminDbState.links[idx] = {
              ...adminDbState.links[idx],
              title: data.title != null ? data.title : title,
              url: data.url || url,
              notes: data.notes != null ? data.notes : notes,
              tags: Array.isArray(data.tags) ? data.tags : tags,
              manual_edited_at: data.manual_edited_at || Date.now(),
              last_edited_by: data.last_edited_by || state.currentUser?.id,
              last_edited_by_name: data.last_edited_by_name || state.currentUser?.displayName || state.currentUser?.username || 'Admin'
            };
          }

          const list = adminDbState.scope === 'community' ? state.communityLinks : state.personalLinks;
          const mainIdx = list.findIndex(l => l.id === id);
          if (mainIdx >= 0) {
            list[mainIdx] = {
              ...list[mainIdx],
              title: data.title != null ? data.title : title,
              url: data.url || url,
              notes: data.notes != null ? data.notes : notes,
              tags: Array.isArray(data.tags) ? data.tags : tags,
              manualEditedAt: data.manual_edited_at || Date.now(),
              lastEditedByName: data.last_edited_by_name || state.currentUser?.displayName || state.currentUser?.username || 'Admin'
            };
          }

          showToast('Link updated in database');
          wikiState.dirty = true;
          if ($('wikiView') && !$('wikiView').classList.contains('hidden')) {
            loadWikiData();
          }
          panel.classList.add('hidden');
          card?.classList.remove('editing');

          const topSearch = $('searchInput');
          if (topSearch?.value?.trim()) {
            try { runSearch(); } catch (_) {}
          }

          // Reload admin DB links so tag cloud, decremented counts, and cards refresh with fresh server data
          await loadAdminDbLinks();
        } catch (err) {
          showToast(err.message || 'Edit failed', true);
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  function setupAdminDbEvents() {
    $('adminDbNavBtn')?.addEventListener('click', openAdminDb);
    $('openAdminDbDrawerBtn')?.addEventListener('click', () => {
      const sideDrawerEl = $('sideDrawer');
      const drawerOverlayEl = $('drawerOverlay');
      if (sideDrawerEl) sideDrawerEl.classList.remove('active');
      if (drawerOverlayEl) drawerOverlayEl.classList.remove('active');
      document.body.style.overflow = '';
      openAdminDb();
    });
    $('adminDbCloseBtn')?.addEventListener('click', closeAdminDb);

    document.querySelector('.brand-logo')?.addEventListener('click', (e) => {
      const adminView = $('adminDbView');
      const wikiView = $('wikiView');
      if (adminView && !adminView.classList.contains('hidden')) {
        e.preventDefault();
        closeAdminDb();
      } else if (wikiView && !wikiView.classList.contains('hidden')) {
        e.preventDefault();
        closeWiki();
      }
    });

    $('adminDbScope')?.addEventListener('change', (e) => {
      adminDbState.scope = e.target.value;
      const commWrap = $('adminDbCommunityWrap');
      if (commWrap) commWrap.style.display = adminDbState.scope === 'personal' ? 'none' : 'flex';
      adminDbState.page = 1;
      adminDbState.tag = '';
      loadAdminDbLinks();
    });

    $('adminDbCommunity')?.addEventListener('change', (e) => {
      adminDbState.communityId = e.target.value;
      adminDbState.page = 1;
      adminDbState.tag = '';
      loadAdminDbLinks();
    });

    $('adminDbStatus')?.addEventListener('change', (e) => {
      adminDbState.status = e.target.value;
      adminDbState.page = 1;
      adminDbState.tag = '';
      loadAdminDbLinks();
    });

    $('adminDbSort')?.addEventListener('change', (e) => {
      adminDbState.sort = e.target.value;
      adminDbState.page = 1;
      loadAdminDbLinks();
    });

    $('adminDbRefreshBtn')?.addEventListener('click', () => {
      loadAdminDbLinks();
    });

    $('adminTagClearBtn')?.addEventListener('click', () => {
      adminDbState.tag = '';
      adminDbState.page = 1;
      loadAdminDbLinks();
    });

    let searchTimer = null;
    const searchInput = $('adminDbSearchInput');
    const clearSearch = $('adminDbClearSearch');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        if (clearSearch) clearSearch.classList.toggle('hidden', !searchInput.value);
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          adminDbState.q = searchInput.value.trim();
          adminDbState.page = 1;
          loadAdminDbLinks();
        }, 300);
      });
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          clearTimeout(searchTimer);
          adminDbState.q = searchInput.value.trim();
          adminDbState.page = 1;
          loadAdminDbLinks();
        }
      });
    }

    if (clearSearch) {
      clearSearch.addEventListener('click', () => {
        if (searchInput) searchInput.value = '';
        clearSearch.classList.add('hidden');
        adminDbState.q = '';
        adminDbState.page = 1;
        loadAdminDbLinks();
      });
    }

    $('adminDbPrevBtn')?.addEventListener('click', () => {
      if (adminDbState.page > 1) {
        adminDbState.page--;
        loadAdminDbLinks();
      }
    });

    $('adminDbNextBtn')?.addEventListener('click', () => {
      if (adminDbState.page < adminDbState.totalPages) {
        adminDbState.page++;
        loadAdminDbLinks();
      }
    });

    window.addEventListener('hashchange', () => {
      if (state.publicWikiMode) {
        if (window.location.hash !== '#wiki') {
          window.location.hash = '#wiki';
        }
        return;
      }
      if (window.location.hash === '#db' || window.location.hash === '#admin') {
        openAdminDb();
      } else if (window.location.hash === '#wiki') {
        openWiki();
      } else {
        closeAdminDb();
        closeWiki();
      }
    });
  }

  function setupMainDbEvents() {
    const scopeSel = $('mainScopeSelect');
    if (scopeSel) {
      scopeSel.addEventListener('change', async (e) => {
        const val = e.target.value;
        if (val === 'personal') {
          if (!isGod()) {
            showToast('Personal mode is GOD only', true);
            scopeSel.value = state.scope;
            return;
          }
          state.scope = 'personal';
        } else {
          state.scope = 'community';
          if (!state.activeCommunity && state.communities.length) {
            state.activeCommunity = state.communities[0].id;
            localStorage.setItem('athena_active_community', state.activeCommunity);
            if (communitySelect) communitySelect.value = state.activeCommunity;
            if ($('mainCommunitySelect')) $('mainCommunitySelect').value = state.activeCommunity;
          }
        }
        updateScopeUI();
        if (state.scope === 'community') {
          await Promise.all([loadCommunityLinksIfAny(), loadCommunityDocumentsIfAny()]);
        }
        await loadMainTags();
        runSearch();
      });
    }

    const commSel = $('mainCommunitySelect');
    if (commSel) {
      commSel.addEventListener('change', async (e) => {
        state.activeCommunity = e.target.value || '';
        if (state.activeCommunity) localStorage.setItem('athena_active_community', state.activeCommunity);
        else localStorage.removeItem('athena_active_community');
        if (communitySelect) communitySelect.value = state.activeCommunity;
        state.scope = 'community';
        updateScopeUI();
        await loadCommunityAdmins();
        await Promise.all([loadCommunityLinksIfAny(), loadCommunityDocumentsIfAny()]);
        await loadMainTags();
        runSearch();
      });
    }

    const statusSel = $('mainStatusSelect');
    if (statusSel) {
      statusSel.addEventListener('change', (e) => {
        state.filterStatus = e.target.value;
        runSearch();
      });
    }

    const sortSel = $('mainSortSelect');
    if (sortSel) {
      sortSel.addEventListener('change', (e) => {
        state.filterSort = e.target.value;
        runSearch();
      });
    }

    const tagsToggleBtn = $('mainTagsToggleBtn');
    const tagsCard = $('mainTagsCard');
    if (tagsToggleBtn && tagsCard) {
      tagsToggleBtn.addEventListener('click', () => {
        const isHidden = tagsCard.classList.toggle('hidden');
        tagsToggleBtn.setAttribute('aria-expanded', String(!isHidden));
      });
    }

    const tagClearBtn = $('mainTagClearBtn');
    if (tagClearBtn) {
      tagClearBtn.addEventListener('click', () => {
        state.filterTag = '';
        renderMainTags();
        runSearch();
      });
    }
  }

  // ---- Wiki View ----

  const wikiState = {
    scope: 'community',
    communityId: '',
    activeCategory: 'video',
    activeSubheading: '',
    q: '',
    page: 1,
    limit: 100,
    totalPages: 1,
    categories: [],
    totalLinks: 0,
    totalCategoryLinks: 0,
    links: [],
    loading: false,
    dirty: false
  };

  function openWiki() {
    const wikiView = $('wikiView');
    const searchWrapper = $('searchWrapper');
    const resultsContainer = $('resultsContainer');
    const adminView = $('adminDbView');

    if (!wikiView) return;
    if (adminView) adminView.classList.add('hidden');
    if (searchWrapper) searchWrapper.classList.add('hidden');
    if (resultsContainer) resultsContainer.classList.add('hidden');
    wikiView.classList.remove('hidden');
    document.querySelector('.scope-switch-container')?.classList.add('hidden');
    if (modeBadgeText) modeBadgeText.textContent = 'Wiki';
    document.body.classList.add('wiki-active');

    if (window.location.hash !== '#wiki') {
      window.location.hash = '#wiki';
    }

    const shareBtn = $('wikiShareBtn');
    if (shareBtn) {
      shareBtn.classList.toggle('hidden', !isGod() || state.publicWikiMode);
    }

    wikiState.scope = state.scope || 'community';
    if (wikiState.scope === 'personal' && !isGod()) {
      wikiState.scope = 'community';
    }
    wikiState.communityId = state.activeCommunity || '';

    // Populate scope and community selects in Wiki
    const scopeSel = $('wikiScopeSelect');
    if (scopeSel) {
      scopeSel.value = wikiState.scope;
      const personalOpt = scopeSel.querySelector('option[value="personal"]');
      if (personalOpt) personalOpt.disabled = !isGod();
    }
    const commWrap = $('wikiCommunityWrap');
    if (commWrap) {
      commWrap.style.display = wikiState.scope === 'personal' ? 'none' : 'flex';
    }
    const commSel = $('wikiCommunitySelect');
    if (commSel && state.communities) {
      commSel.innerHTML = state.communities.map(c =>
        `<option value="${escapeHtml(c.id)}" ${c.id === wikiState.communityId ? 'selected' : ''}>${escapeHtml(c.name || c.id)}</option>`
      ).join('');
      if (!wikiState.communityId && state.communities[0]) {
        wikiState.communityId = state.communities[0].id;
      }
    }

    if (!wikiState.categories.length || wikiState.dirty) {
      wikiState.dirty = false;
      loadWikiData();
    }
  }

  function closeWiki() {
    if (state.publicWikiMode) return;
    const wikiView = $('wikiView');
    const searchWrapper = $('searchWrapper');
    const resultsContainer = $('resultsContainer');
    if (!wikiView) return;
    wikiView.classList.add('hidden');
    document.body.classList.remove('wiki-active');
    $('wikiSidebar')?.classList.remove('mobile-open');
    $('wikiSidebarBackdrop')?.classList.add('hidden');
    document.body.style.overflow = '';
    if (searchWrapper) searchWrapper.classList.remove('hidden');
    if (resultsContainer) resultsContainer.classList.remove('hidden');
    document.querySelector('.scope-switch-container')?.classList.remove('hidden');
    if (modeBadgeText) modeBadgeText.textContent = state.mode ? state.mode.charAt(0).toUpperCase() + state.mode.slice(1) : 'Search';
    if (window.location.hash === '#wiki') {
      history.pushState('', document.title, window.location.pathname + window.location.search);
    }
  }

  async function loadWikiData() {
    await loadWikiCategories();
    await loadWikiLinks();
  }

  async function loadWikiCategories() {
    const listEl = $('wikiCatList');
    const totalBadge = $('wikiTotalCountBadge');
    if (listEl && !wikiState.categories.length) {
      listEl.innerHTML = '<div style="padding:10px;color:var(--text-muted);font-size:0.75rem;">Loading categories…</div>';
    }
    try {
      const qParams = new URLSearchParams({
        scope: wikiState.scope
      });
      if (wikiState.scope === 'community' && wikiState.communityId) {
        qParams.set('community_id', wikiState.communityId);
      }
      if (state.wikiShareToken) {
        qParams.set('share', state.wikiShareToken);
      }
      const { res, data } = await api(`/api/wiki/categories?${qParams.toString()}`);
      if (res.ok && data.success && Array.isArray(data.categories)) {
        wikiState.categories = data.categories;
        wikiState.totalLinks = data.total || 0;
        if (totalBadge) totalBadge.textContent = `${wikiState.totalLinks.toLocaleString()} links`;

        // If current activeCategory not in list, pick the first
        if (!wikiState.categories.find(c => c.id === wikiState.activeCategory)) {
          wikiState.activeCategory = wikiState.categories[0]?.id || 'video';
        }
        renderWikiSidebar();
      }
    } catch (err) {
      console.warn('[wiki] Failed to load categories:', err);
    }
  }

  function renderWikiSidebar() {
    const listEl = $('wikiCatList');
    if (!listEl) return;
    if (!wikiState.categories.length) {
      listEl.innerHTML = '<div style="padding:10px;color:var(--text-muted);font-size:0.75rem;">No categories found.</div>';
      return;
    }

    listEl.innerHTML = wikiState.categories.map(c => {
      const isActive = c.id === wikiState.activeCategory;
      const subs = c.subheadings || [];
      const subHtml = (isActive && subs.length) ? `
        <div class="wiki-cat-sub-list" role="group" aria-label="${escapeHtml(c.title)} subheadings">
          <button type="button" class="wiki-cat-sub-item ${!wikiState.activeSubheading ? 'active' : ''}" data-cat="${escapeHtml(c.id)}" data-sub="" title="All Subheadings in ${escapeHtml(c.title)}">
            <span class="wiki-cat-sub-dot">•</span>
            <span class="wiki-cat-sub-title">All Subheadings</span>
            <span class="wiki-cat-sub-count">${(c.count || 0).toLocaleString()}</span>
          </button>
          ${subs.map(s => `
            <button type="button" class="wiki-cat-sub-item ${wikiState.activeSubheading === s.id ? 'active' : ''}" data-cat="${escapeHtml(c.id)}" data-sub="${escapeHtml(s.id)}" title="${escapeHtml(s.title)} (${(s.count || 0).toLocaleString()})">
              <span class="wiki-cat-sub-dot">•</span>
              <span class="wiki-cat-sub-title">${escapeHtml(s.title)}</span>
              <span class="wiki-cat-sub-count">${(s.count || 0).toLocaleString()}</span>
            </button>
          `).join('')}
        </div>
      ` : '';

      return `
        <div class="wiki-cat-group ${isActive ? 'active' : ''}">
          <button type="button" class="wiki-cat-item ${isActive ? 'active' : ''}" data-cat="${escapeHtml(c.id)}" title="${escapeHtml(c.title)} (${(c.count || 0).toLocaleString()})">
            <div class="wiki-cat-item-main">
              <span class="wiki-cat-item-icon">${escapeHtml(c.icon || '📁')}</span>
              <span>${escapeHtml(c.title)}</span>
            </div>
            <div class="wiki-cat-item-meta">
              <span class="wiki-cat-count">${(c.count || 0).toLocaleString()}</span>
              <span class="wiki-cat-arrow" aria-hidden="true">${isActive ? '▾' : '▸'}</span>
            </div>
          </button>
          ${subHtml}
        </div>
      `;
    }).join('');

    const cur = wikiState.categories.find(c => c.id === wikiState.activeCategory);
    const mobileBtnText = $('wikiMobileCatBtnText');
    if (mobileBtnText && cur) mobileBtnText.textContent = cur.title || 'Categories';

    // Wire Category button clicks
    listEl.querySelectorAll('.wiki-cat-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const catId = btn.dataset.cat;
        if (!catId) return;
        if (catId === wikiState.activeCategory) {
          selectWikiSubheading('', true);
          return;
        }
        wikiState.activeCategory = catId;
        wikiState.activeSubheading = '';
        wikiState.page = 1;

        const targetCat = wikiState.categories.find(c => c.id === catId);
        if (mobileBtnText && targetCat) mobileBtnText.textContent = targetCat.title || 'Categories';

        renderWikiSidebar();
        loadWikiLinks();
      });
    });

    // Wire Subheading item clicks (nested navigation)
    listEl.querySelectorAll('.wiki-cat-sub-item').forEach(subBtn => {
      subBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const subId = subBtn.dataset.sub || '';

        // Close mobile sidebar and backdrop
        $('wikiSidebar')?.classList.remove('mobile-open');
        $('wikiSidebarBackdrop')?.classList.add('hidden');
        document.body.style.overflow = '';

        selectWikiSubheading(subId, true);
      });
    });
  }

  function selectWikiSubheading(subId, shouldScroll = true) {
    wikiState.activeSubheading = subId || '';

    // 1. Sync Hero dropdown
    const subSelect = $('wikiSubSelect');
    if (subSelect && subSelect.value !== wikiState.activeSubheading) {
      subSelect.value = wikiState.activeSubheading;
    }

    // 2. Sync Controls Bar dropdown
    const ctrlSubSelect = $('wikiCtrlSubSelect');
    if (ctrlSubSelect && ctrlSubSelect.value !== wikiState.activeSubheading) {
      ctrlSubSelect.value = wikiState.activeSubheading;
    }

    // 3. Sync Pills
    const subPills = $('wikiSubPills');
    if (subPills) {
      subPills.querySelectorAll('.wiki-sub-pill').forEach(btn => {
        const match = (btn.dataset.sub || '') === wikiState.activeSubheading;
        btn.classList.toggle('active', match);
      });
    }

    // 4. Sync Sidebar Sub-items
    const listEl = $('wikiCatList');
    if (listEl) {
      listEl.querySelectorAll('.wiki-cat-sub-item').forEach(btn => {
        const match = (btn.dataset.sub || '') === wikiState.activeSubheading;
        btn.classList.toggle('active', match);
      });
    }

    // 5. Scroll down to target subheading section
    if (shouldScroll) {
      if (!wikiState.activeSubheading) {
        const curCat = wikiState.categories.find(c => c.id === wikiState.activeCategory);
        const curSubsWithLinks = new Set(wikiState.links.map(l => l.subheading || 'general'));
        const totalSubs = (curCat?.subheadings || []).filter(s => s.count > 0).length;
        if (curSubsWithLinks.size < totalSubs && totalSubs > 1) {
          wikiState.page = 1;
          loadWikiLinks().then(() => {
            $('wikiBlocks')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          });
        } else {
          $('wikiBlocks')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      } else {
        const targetEl = document.getElementById(`sub-${wikiState.activeSubheading}`);
        if (targetEl) {
          targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
          targetEl.classList.remove('wiki-sub-block-highlight');
          void targetEl.offsetWidth; // Force CSS reflow for re-triggering animation
          targetEl.classList.add('wiki-sub-block-highlight');
          setTimeout(() => {
            targetEl.classList.remove('wiki-sub-block-highlight');
          }, 1800);
        } else {
          // If section is not currently in the DOM, load it and scroll
          wikiState.page = 1;
          loadWikiLinks().then(() => {
            const el = document.getElementById(`sub-${wikiState.activeSubheading}`);
            if (el) {
              el.scrollIntoView({ behavior: 'smooth', block: 'start' });
              el.classList.add('wiki-sub-block-highlight');
              setTimeout(() => el.classList.remove('wiki-sub-block-highlight'), 1800);
            }
          });
        }
      }
    }
  }

  async function loadWikiLinks() {
    const blocksEl = $('wikiBlocks');
    if (wikiState.loading) return;
    wikiState.loading = true;

    if (blocksEl) {
      blocksEl.innerHTML = '<div class="wiki-loading">Loading links for category…</div>';
    }

    try {
      const qParams = new URLSearchParams({
        scope: wikiState.scope,
        category: wikiState.activeCategory,
        page: String(wikiState.page),
        limit: String(wikiState.limit)
      });
      if (wikiState.scope === 'community' && wikiState.communityId) {
        qParams.set('community_id', wikiState.communityId);
      }
      if (wikiState.activeSubheading) {
        qParams.set('subheading', wikiState.activeSubheading);
      }
      if (wikiState.q) {
        qParams.set('q', wikiState.q);
      }
      if (state.wikiShareToken) {
        qParams.set('share', state.wikiShareToken);
      }

      const { res, data } = await api(`/api/wiki/links?${qParams.toString()}`);
      if (res.ok && data.success && Array.isArray(data.links)) {
        wikiState.links = data.links;
        wikiState.totalPages = data.totalPages || 1;
        wikiState.totalCategoryLinks = data.total || 0;
        wikiState.fallbackFromCategory = data.fallbackFromCategory || null;
        wikiState.categoryTotal = typeof data.categoryTotal === 'number' ? data.categoryTotal : null;
        wikiState.globalTotal = typeof data.globalTotal === 'number' ? data.globalTotal : null;
        renderWikiContent();
      } else {
        if (blocksEl) blocksEl.innerHTML = '<div class="wiki-empty">Could not load wiki links.</div>';
      }
    } catch (err) {
      if (blocksEl) blocksEl.innerHTML = `<div class="wiki-empty">Error loading links: ${escapeHtml(err.message)}</div>`;
    } finally {
      wikiState.loading = false;
    }
  }

  function renderWikiContent() {
    const curCat = wikiState.categories.find(c => c.id === wikiState.activeCategory) || {
      id: wikiState.activeCategory,
      title: 'Links',
      icon: '📁',
      description: 'Browsing wiki links',
      subheadings: []
    };

    // 1. Update Hero
    const heroIcon = $('wikiHeroIcon');
    const heroTitle = $('wikiHeroTitle');
    const heroDesc = $('wikiHeroDesc');
    const heroCount = $('wikiHeroCount');
    if (heroIcon) heroIcon.textContent = curCat.icon || '📁';
    if (heroTitle) heroTitle.textContent = curCat.title;
    if (heroDesc) {
      if (wikiState.fallbackFromCategory) {
        heroDesc.textContent = `Showing results across all categories for “${wikiState.q}”`;
      } else {
        heroDesc.textContent = curCat.description || '';
      }
    }
    if (heroCount) heroCount.textContent = `${(wikiState.totalCategoryLinks || curCat.count || 0).toLocaleString()} links`;

    // 2. Subheading Scroll-down Selection & Pills
    const subSelect = $('wikiSubSelect');
    const ctrlSubSelect = $('wikiCtrlSubSelect');
    const subPills = $('wikiSubPills');
    const subBadge = $('wikiSubCountBadge');
    const subs = curCat.subheadings || [];

    if (subBadge) {
      subBadge.textContent = subs.length ? `${subs.length} subheadings` : '';
    }

    // Build scroll-down select options
    let selectOpts = `<option value="">All Subheadings (${(wikiState.totalCategoryLinks || curCat.count || 0).toLocaleString()})</option>`;
    for (const s of subs) {
      const isSel = (wikiState.activeSubheading || '') === s.id;
      selectOpts += `<option value="${escapeHtml(s.id)}" ${isSel ? 'selected' : ''}>${escapeHtml(s.title)}${s.count ? ` (${s.count.toLocaleString()})` : ''}</option>`;
    }

    if (subSelect) {
      if (!subs.length) {
        subSelect.innerHTML = '<option value="">All Links</option>';
        subSelect.disabled = true;
      } else {
        subSelect.disabled = false;
        subSelect.innerHTML = selectOpts;
        subSelect.value = wikiState.activeSubheading || '';
      }
      if (!subSelect.dataset.bound) {
        subSelect.dataset.bound = 'true';
        subSelect.addEventListener('change', () => {
          selectWikiSubheading(subSelect.value, true);
        });
      }
    }

    if (ctrlSubSelect) {
      if (!subs.length) {
        ctrlSubSelect.innerHTML = '<option value="">All Links</option>';
        ctrlSubSelect.disabled = true;
      } else {
        ctrlSubSelect.disabled = false;
        ctrlSubSelect.innerHTML = selectOpts;
        ctrlSubSelect.value = wikiState.activeSubheading || '';
      }
      if (!ctrlSubSelect.dataset.bound) {
        ctrlSubSelect.dataset.bound = 'true';
        ctrlSubSelect.addEventListener('change', () => {
          selectWikiSubheading(ctrlSubSelect.value, true);
        });
      }
    }

    // Subheading Pills
    if (subPills) {
      if (!subs.length) {
        subPills.innerHTML = '';
      } else {
        const allActive = !wikiState.activeSubheading;
        let pillsHtml = `<button type="button" class="wiki-sub-pill ${allActive ? 'active' : ''}" data-sub="" title="Show all subheadings in this category">All Subheadings</button>`;
        for (const s of subs) {
          const isAct = (wikiState.activeSubheading || '') === s.id;
          pillsHtml += `<button type="button" class="wiki-sub-pill ${isAct ? 'active' : ''}" data-sub="${escapeHtml(s.id)}">${escapeHtml(s.title)}${s.count ? ` (${s.count.toLocaleString()})` : ''}</button>`;
        }
        subPills.innerHTML = pillsHtml;

        subPills.querySelectorAll('.wiki-sub-pill').forEach(btn => {
          btn.addEventListener('click', () => {
            selectWikiSubheading(btn.dataset.sub || '', true);
          });
        });
      }
    }

    // 3. Render Link Blocks
    const blocksEl = $('wikiBlocks');
    if (!blocksEl) return;

    if (!wikiState.links.length) {
      const emptyMsg = wikiState.q
        ? `<p>No links found for “<strong>${escapeHtml(wikiState.q)}</strong>” in this category or across Athena Wiki.</p>`
        : '<p>No links found matching your current filter.</p>';
      blocksEl.innerHTML = `
        <div class="wiki-empty">
          ${emptyMsg}
        </div>`;
      $('wikiPagination')?.classList.add('hidden');
      return;
    }

    const allCatMap = new Map((wikiState.categories || []).map(c => [c.id, c]));
    const allSubMetaLookup = new Map();
    for (const cat of (wikiState.categories || [])) {
      for (const s of (cat.subheadings || [])) {
        allSubMetaLookup.set(s.id, { ...s, categoryTitle: cat.title });
      }
    }

    // Group links by subheading
    const subMap = new Map();
    for (const l of wikiState.links) {
      const subKey = l.subheading || 'general';
      if (!subMap.has(subKey)) subMap.set(subKey, []);
      subMap.get(subKey).push(l);
    }

    // Canonical order: taxonomy subheadings first, followed by any extras
    const orderedSubIds = [];
    for (const s of (curCat.subheadings || [])) {
      if (subMap.has(s.id)) orderedSubIds.push(s.id);
    }
    for (const subId of subMap.keys()) {
      if (!orderedSubIds.includes(subId)) orderedSubIds.push(subId);
    }

    let blocksHtml = '';
    if (wikiState.fallbackFromCategory) {
      const fallbackCat = allCatMap.get(wikiState.fallbackFromCategory);
      const fallbackTitle = fallbackCat ? fallbackCat.title : wikiState.fallbackFromCategory;
      blocksHtml += `
        <div class="wiki-search-fallback-banner">
          <span class="wiki-search-fallback-icon">💡</span>
          <span class="wiki-search-fallback-text">
            No matches in <strong>${escapeHtml(fallbackTitle)}</strong> for “<strong>${escapeHtml(wikiState.q)}</strong>”.
            Showing <strong>${wikiState.totalCategoryLinks.toLocaleString()}</strong> results across all categories.
          </span>
        </div>
      `;
    }

    for (const subId of orderedSubIds) {
      const subLinks = subMap.get(subId) || [];
      const meta = allSubMetaLookup.get(subId) || {
        title: subId.replace(/^[a-z]+-/, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        description: ''
      };

      blocksHtml += `
        <section class="wiki-sub-block" id="sub-${escapeHtml(subId)}">
          <div class="wiki-sub-header">
            <h4 class="wiki-sub-title">
              <span>${escapeHtml(meta.title)}</span>
              <a href="#sub-${escapeHtml(subId)}" class="wiki-sub-anchor" title="Direct link to this section">#</a>
            </h4>
            ${meta.description ? `<p class="wiki-sub-desc">${escapeHtml(meta.description)}</p>` : ''}
          </div>
          <div class="wiki-link-list">
            ${subLinks.map(l => {
              let host = '';
              try { if (l.url && l.url.startsWith('http')) host = new URL(l.url).hostname; } catch (_) {}

              const tagPills = (l.tags || []).map(t =>
                `<button type="button" class="wiki-tag-pill" data-tag="${escapeHtml(t)}" title="Filter by #${escapeHtml(t)}">#${escapeHtml(t)}</button>`
              ).join('');

              const auditBadge = l.manual_edited_at
                ? `<span class="admin-edit-badge" title="Manually edited">✏️ ${escapeHtml(l.last_edited_by_name || 'Admin')} · ${escapeHtml(formatDateTime(l.manual_edited_at))}</span>`
                : '';

              const linkCat = allCatMap.get(l.category);
              const showCatBadge = linkCat && (wikiState.fallbackFromCategory || (wikiState.q && l.category !== wikiState.activeCategory) || wikiState.activeCategory === 'all');
              const catBadge = showCatBadge
                ? `<span class="wiki-cat-chip" title="Category: ${escapeHtml(linkCat.title)}">${escapeHtml(linkCat.icon || '📁')} ${escapeHtml(linkCat.title)}</span>`
                : '';

              return `
                <article class="wiki-link-card" data-id="${escapeHtml(l.id)}">
                  <div class="wiki-card-head">
                    <div class="wiki-card-title-row">
                      <a class="wiki-card-title" href="${safeHref(l.url || '#')}" target="_blank" rel="noopener noreferrer">
                        <span>${escapeHtml(l.title || l.url || 'Untitled')}</span>
                        <span class="wiki-card-ext-icon">↗</span>
                      </a>
                      ${host ? `<span class="wiki-domain-chip">${escapeHtml(host)}</span>` : ''}
                      ${catBadge}
                    </div>
                    ${l.url ? `<button type="button" class="wiki-copy-url-btn" data-url="${escapeHtml(l.url)}" title="Copy URL" aria-label="Copy URL"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button>` : ''}
                  </div>
                  ${l.notes ? `<p class="wiki-card-desc">${escapeHtml(l.notes)}</p>` : ''}
                  <div class="wiki-card-footer">
                    <div class="wiki-card-tags">
                      ${tagPills}
                    </div>
                    <div class="wiki-card-meta">
                      ${auditBadge}
                      <span>Added ${escapeHtml(formatDateTime(l.created_at))}</span>
                    </div>
                  </div>
                </article>
              `;
            }).join('')}
          </div>
        </section>
      `;
    }

    blocksEl.innerHTML = blocksHtml;

    // Wire copy buttons on link cards
    blocksEl.querySelectorAll('.wiki-copy-url-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const u = btn.dataset.url;
        if (!u) return;
        try {
          await navigator.clipboard.writeText(u);
          showToast('Link copied to clipboard');
        } catch (_) {
          showToast('Failed to copy', true);
        }
      });
    });

    // Wire tag clicks inside wiki link cards
    blocksEl.querySelectorAll('.wiki-tag-pill').forEach(pill => {
      pill.addEventListener('click', (e) => {
        e.preventDefault();
        const tag = pill.dataset.tag;
        if (!tag) return;
        const sInput = $('wikiSearchInput');
        if (sInput) sInput.value = tag;
        $('wikiClearSearch')?.classList.remove('hidden');
        wikiState.q = tag;
        wikiState.page = 1;
        loadWikiLinks();
      });
    });

    // 4. Pagination
    const pager = $('wikiPagination');
    const prevBtn = $('wikiPrevBtn');
    const nextBtn = $('wikiNextBtn');
    const pageInfo = $('wikiPageInfo');
    if (pager && prevBtn && nextBtn && pageInfo) {
      if (wikiState.totalPages <= 1) {
        pager.classList.add('hidden');
      } else {
        pager.classList.remove('hidden');
        pageInfo.textContent = `Page ${wikiState.page} of ${wikiState.totalPages}`;
        prevBtn.disabled = wikiState.page <= 1;
        nextBtn.disabled = wikiState.page >= wikiState.totalPages;
      }
    }
  }

  function setupWikiShareModal() {
    const shareBtn = $('wikiShareBtn');
    const modal = $('wikiShareModal');
    const backdrop = $('wikiShareModalBackdrop');
    const closeBtn = $('wikiShareCloseBtn');
    const generateBtn = $('wikiGenerateShareBtn');
    const durationSel = $('wikiShareDuration');
    const genBox = $('wikiGeneratedLinkBox');
    const urlInput = $('wikiShareUrlInput');
    const copyBtn = $('wikiCopyShareBtn');
    const expiryBadge = $('wikiGenExpiryBadge');
    const linksList = $('wikiShareLinksList');

    if (!shareBtn || !modal) return;

    function openModal() {
      if (!isGod()) {
        showToast('Owner rank required to generate shareable links', true);
        return;
      }
      modal.classList.remove('hidden');
      if (genBox) genBox.classList.add('hidden');
      loadActiveShareLinks();
    }

    function closeModal() {
      modal.classList.add('hidden');
    }

    shareBtn.addEventListener('click', openModal);
    closeBtn?.addEventListener('click', closeModal);
    backdrop?.addEventListener('click', closeModal);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
        closeModal();
      }
    });

    generateBtn?.addEventListener('click', async () => {
      if (!isGod()) return;
      generateBtn.disabled = true;
      try {
        const duration = durationSel?.value || '1m';
        const { res, data } = await api('/api/wiki/share-links', {
          method: 'POST',
          body: JSON.stringify({
            duration,
            community_id: wikiState.communityId || ''
          })
        });
        if (res.ok && data.success && data.link) {
          const l = data.link;
          const fullUrl = `${window.location.origin}/wiki?share=${encodeURIComponent(l.token)}`;
          if (urlInput) urlInput.value = fullUrl;
          if (expiryBadge) {
            const expDate = new Date(l.expires_at).toLocaleDateString();
            expiryBadge.textContent = `Expires ${expDate} (${l.duration_label})`;
          }
          if (genBox) genBox.classList.remove('hidden');
          showToast('Shareable link generated! Copied to clipboard.');
          try {
            await navigator.clipboard.writeText(fullUrl);
          } catch (_) {}
          loadActiveShareLinks();
        } else {
          showToast(data.error || 'Failed to generate link', true);
        }
      } catch (err) {
        showToast(err.message || 'Error creating link', true);
      } finally {
        generateBtn.disabled = false;
      }
    });

    copyBtn?.addEventListener('click', async () => {
      if (urlInput?.value) {
        try {
          await navigator.clipboard.writeText(urlInput.value);
          const origText = copyBtn.textContent;
          copyBtn.textContent = 'Copied!';
          setTimeout(() => { copyBtn.textContent = origText; }, 2000);
          showToast('Link copied to clipboard');
        } catch (_) {
          urlInput.select();
          showToast('Please copy the URL manually');
        }
      }
    });

    async function loadActiveShareLinks() {
      if (!linksList) return;
      linksList.innerHTML = '<div class="wiki-share-links-loading" style="padding:12px;font-size:0.75rem;color:var(--text-muted);">Loading active share links…</div>';
      try {
        const { res, data } = await api('/api/wiki/share-links');
        if (res.ok && data.success && Array.isArray(data.links)) {
          if (!data.links.length) {
            linksList.innerHTML = '<div style="padding:10px;font-size:0.75rem;color:var(--text-muted);">No share links generated yet.</div>';
            return;
          }
          linksList.innerHTML = data.links.map(item => {
            const fullUrl = `${window.location.origin}/wiki?share=${encodeURIComponent(item.token)}`;
            const expDate = new Date(item.expires_at).toLocaleDateString();
            const createdDate = new Date(item.created_at).toLocaleDateString();
            let statusBadge = '<span class="wiki-share-badge-active">Active</span>';
            if (item.is_revoked) {
              statusBadge = '<span class="wiki-share-badge-revoked">Revoked</span>';
            } else if (item.is_expired) {
              statusBadge = '<span class="wiki-share-badge-expired">Expired</span>';
            }

            const canRevoke = !item.is_revoked && !item.is_expired;

            return `
              <div class="wiki-share-row" data-id="${escapeHtml(item.id)}">
                <div class="wiki-share-meta">
                  <div class="wiki-share-dur">${escapeHtml(item.duration_label || 'Share Link')} · ${statusBadge}</div>
                  <div class="wiki-share-details">
                    <span>Expires: ${escapeHtml(expDate)}</span>
                    <span>Views: ${(item.views || 0).toLocaleString()}</span>
                    <span>Created: ${escapeHtml(createdDate)}</span>
                  </div>
                </div>
                <div class="wiki-share-actions">
                  <button type="button" class="btn btn-secondary btn-sm wiki-share-copy-item" data-url="${escapeHtml(fullUrl)}" title="Copy link">Copy</button>
                  ${canRevoke ? `<button type="button" class="btn btn-danger btn-sm wiki-share-revoke-item" data-id="${escapeHtml(item.id)}" title="Revoke access immediately">Revoke</button>` : ''}
                </div>
              </div>
            `;
          }).join('');

          linksList.querySelectorAll('.wiki-share-copy-item').forEach(btn => {
            btn.addEventListener('click', async () => {
              const u = btn.dataset.url;
              if (u) {
                try {
                  await navigator.clipboard.writeText(u);
                  showToast('Share link copied');
                } catch (_) {}
              }
            });
          });

          linksList.querySelectorAll('.wiki-share-revoke-item').forEach(btn => {
            btn.addEventListener('click', async () => {
              const id = btn.dataset.id;
              if (!id) return;
              btn.disabled = true;
              try {
                const { res, data } = await api('/api/wiki/share-links/revoke', {
                  method: 'POST',
                  body: JSON.stringify({ id })
                });
                if (res.ok && data.success) {
                  showToast('Share link revoked');
                  loadActiveShareLinks();
                } else {
                  showToast(data.error || 'Failed to revoke', true);
                  btn.disabled = false;
                }
              } catch (err) {
                showToast(err.message || 'Revoke failed', true);
                btn.disabled = false;
              }
            });
          });
        }
      } catch (_err) {
        linksList.innerHTML = `<div style="padding:10px;font-size:0.75rem;color:var(--text-muted);">Failed to load share history.</div>`;
      }
    }
  }

  function setupWikiEvents() {
    $('wikiNavBtn')?.addEventListener('click', openWiki);
    $('openWikiDrawerBtn')?.addEventListener('click', () => {
      const sideDrawerEl = $('sideDrawer');
      const drawerOverlayEl = $('drawerOverlay');
      if (sideDrawerEl) sideDrawerEl.classList.remove('active');
      if (drawerOverlayEl) drawerOverlayEl.classList.remove('active');
      document.body.style.overflow = '';
      openWiki();
    });
    $('wikiCloseBtn')?.addEventListener('click', closeWiki);

    $('wikiScopeSelect')?.addEventListener('change', (e) => {
      wikiState.scope = e.target.value;
      const commWrap = $('wikiCommunityWrap');
      if (commWrap) commWrap.style.display = wikiState.scope === 'personal' ? 'none' : 'flex';
      wikiState.page = 1;
      wikiState.q = '';
      loadWikiData();
    });

    $('wikiCommunitySelect')?.addEventListener('change', (e) => {
      wikiState.communityId = e.target.value;
      wikiState.page = 1;
      wikiState.q = '';
      loadWikiData();
    });

    const sInput = $('wikiSearchInput');
    const clrSearch = $('wikiClearSearch');
    if (sInput) {
      let debounce = null;
      sInput.addEventListener('input', () => {
        if (clrSearch) clrSearch.classList.toggle('hidden', !sInput.value.trim());
        clearTimeout(debounce);
        debounce = setTimeout(() => {
          wikiState.q = sInput.value.trim();
          wikiState.page = 1;
          loadWikiLinks();
        }, 220);
      });
    }

    if (clrSearch) {
      clrSearch.addEventListener('click', () => {
        if (sInput) sInput.value = '';
        clrSearch.classList.add('hidden');
        wikiState.q = '';
        wikiState.page = 1;
        loadWikiLinks();
      });
    }

    // Mobile sidebar toggle and backdrop
    const sidebarEl = $('wikiSidebar');
    const backdropEl = $('wikiSidebarBackdrop');
    const toggleBtn = $('wikiSidebarToggle');

    function toggleMobileSidebar() {
      const open = sidebarEl?.classList.toggle('mobile-open');
      backdropEl?.classList.toggle('hidden', !open);
      document.body.style.overflow = open ? 'hidden' : '';
    }

    toggleBtn?.addEventListener('click', toggleMobileSidebar);
    backdropEl?.addEventListener('click', () => {
      sidebarEl?.classList.remove('mobile-open');
      backdropEl?.classList.add('hidden');
      document.body.style.overflow = '';
    });

    $('wikiPrevBtn')?.addEventListener('click', () => {
      if (wikiState.page > 1) {
        wikiState.page--;
        loadWikiLinks();
      }
    });

    $('wikiNextBtn')?.addEventListener('click', () => {
      if (wikiState.page < wikiState.totalPages) {
        wikiState.page++;
        loadWikiLinks();
      }
    });

    $('wikiAiOrganizeBtn')?.addEventListener('click', async () => {
      const btn = $('wikiAiOrganizeBtn');
      if (btn) btn.disabled = true;
      showToast('AI is reviewing library links & tags to refine categories…');
      try {
        const { res, data } = await api('/api/wiki/ai-organize', {
          method: 'POST',
          body: JSON.stringify({
            scope: wikiState.scope,
            community_id: wikiState.communityId
          })
        });
        if (res.ok && data.success) {
          showToast(data.ai_generated ? 'AI taxonomy generated & applied!' : (data.message || 'Taxonomy updated'));
          await loadWikiCategories();
          await loadWikiLinks();
        } else {
          showToast(data.error || 'AI organization failed', true);
        }
      } catch (err) {
        showToast(err.message || 'AI request failed', true);
      } finally {
        if (btn) btn.disabled = false;
      }
    });

    setupWikiShareModal();
  }

  async function initPublicWiki(shareToken) {
    state.publicWikiMode = true;
    state.wikiShareToken = shareToken;
    document.body.classList.add('public-wiki-only');
    document.body.classList.add('wiki-active');

    // Hide auth gate & show root
    authGate.classList.add('hidden');
    appRoot.classList.remove('hidden');

    // Hide drawer and hamburger
    if (sideDrawer) sideDrawer.classList.add('hidden');
    if (drawerOverlay) drawerOverlay.classList.add('hidden');

    try {
      const verifyRes = await fetch(`${API_BASE}/api/wiki/share-links/verify?share=${encodeURIComponent(shareToken)}`);
      const verifyData = await verifyRes.json().catch(() => ({}));

      if (!verifyRes.ok || !verifyData.valid) {
        showPublicWikiError(verifyData.error || 'This wiki share link is invalid or has expired.');
        return;
      }

      const banner = $('wikiPublicBanner');
      const expEl = $('wikiPublicExpiry');
      if (banner && expEl) {
        banner.classList.remove('hidden');
        const expDate = new Date(verifyData.expires_at).toLocaleDateString();
        expEl.textContent = `Valid until ${expDate} · ${escapeHtml(verifyData.duration_label || '')}`;
      }

      const brandTitle = $('wikiBrandTitle');
      const brandTagline = $('wikiBrandTagline');
      if (brandTitle) brandTitle.textContent = 'Athena Wiki';
      if (brandTagline) brandTagline.textContent = 'Public curated directory · Read-only view';

      openWiki();

      window.addEventListener('hashchange', () => {
        if (state.publicWikiMode && window.location.hash !== '#wiki') {
          window.location.hash = '#wiki';
        }
      });
    } catch (_err) {
      showPublicWikiError('Network error connecting to Athena Wiki.');
    }
  }

  function showPublicWikiError(msg) {
    const wikiView = $('wikiView');
    const searchWrapper = $('searchWrapper');
    const resultsContainer = $('resultsContainer');
    const adminView = $('adminDbView');
    if (searchWrapper) searchWrapper.classList.add('hidden');
    if (resultsContainer) resultsContainer.classList.add('hidden');
    if (adminView) adminView.classList.add('hidden');
    if (wikiView) wikiView.classList.remove('hidden');

    $('wikiControlsBar')?.classList.add('hidden');
    $('wikiSidebar')?.classList.add('hidden');
    $('wikiCatHero')?.classList.add('hidden');
    $('wikiPagination')?.classList.add('hidden');

    const blocks = $('wikiBlocks');
    if (blocks) {
      blocks.innerHTML = `
        <div class="wiki-empty" style="padding: 60px 20px; text-align: center;">
          <div style="font-size: 2.8rem; line-height: 1; margin-bottom: 14px;">⌛</div>
          <h3 style="font-size: 1.35rem; font-weight: 700; color: var(--text-main); margin-bottom: 8px;">Access Expired or Unavailable</h3>
          <p style="color: var(--text-muted); max-width: 460px; margin: 0 auto 24px; font-size: 0.9rem; line-height: 1.5;">${escapeHtml(msg)}</p>
          <a href="/" class="btn btn-primary" style="display: inline-flex; border-radius: 999px; padding: 8px 24px; text-decoration: none;">Return to Athena</a>
        </div>
      `;
    }
  }

  // ---- Events ----

  function setupEventListeners() {
    initThemeUI();
    initGlassBlur();
    initAccentColor();
    initDice();
    setupAdminDbEvents();
    setupMainDbEvents();
    setupWikiEvents();

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
        if (!(await showModal({ title: 'Wipe personal data', message: 'Delete ALL your personal data on this instance? This cannot be undone.', confirmText: 'Continue', danger: true }))) return;
        if (!(await showModal({ title: 'Final confirmation', message: 'Delete personal links, AI config, and end all sessions?', confirmText: 'Wipe everything', danger: true }))) return;
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
    // Drag-and-drop upload onto the whole search area while in dump mode
    const dropZone = searchBarBox;
    if (dropZone) {
      ['dragenter', 'dragover'].forEach((evName) => {
        dropZone.addEventListener(evName, (e) => {
          if (state.mode !== 'dump') return;
          e.preventDefault();
          dropZone.classList.add('dropzone-active');
        });
      });
      ['dragleave', 'drop'].forEach((evName) => {
        dropZone.addEventListener(evName, (e) => {
          if (state.mode !== 'dump') return;
          e.preventDefault();
          if (evName === 'dragleave' && dropZone.contains(e.relatedTarget)) return;
          dropZone.classList.remove('dropzone-active');
          if (evName === 'drop' && e.dataTransfer?.files?.length) uploadDocuments([...e.dataTransfer.files]);
        });
      });
    }

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

    personalScopeBtn.addEventListener('click', async () => {
      if (!isGod()) {
        showToast('Personal mode is GOD only. Join a community via bot: /community_join <id>', true);
        return;
      }
      state.scope = 'personal';
      updateScopeUI();
      await loadMainTags();
      runSearch();
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
        if ($('mainCommunitySelect')) $('mainCommunitySelect').value = state.activeCommunity;
      }
      state.scope = 'community';
      updateScopeUI();
      if (state.mode === 'delete' && !isCommunityStaff()) setMode('search');
      await Promise.all([loadCommunityLinksIfAny(), loadCommunityDocumentsIfAny()]);
      await loadMainTags();
      runSearch();
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

    // Storage is PostgreSQL-only — sync/save kept as no-ops for compat.
    saveStorageBtn?.addEventListener('click', async () => {
      showToast('PostgreSQL is the only store — no switch needed. Set DATABASE_URL on server.', true);
    });
    syncStorageBtn?.addEventListener('click', async () => {
      showToast('Sync removed — PostgreSQL only (D1/GitHub deprecated)', true);
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
        if ($('mainCommunitySelect')) $('mainCommunitySelect').value = state.activeCommunity;
        updateDeleteModeVisibility();
        updateScopeUI();
        await loadCommunityAdmins();
        await Promise.all([loadCommunityLinksIfAny(), loadCommunityDocumentsIfAny()]);
        await loadMainTags();
        if (state.mode === 'search') runSearch();
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
    const aiLoadModelsBtn = $('aiLoadModelsBtn');
    if (aiLoadModelsBtn) aiLoadModelsBtn.addEventListener('click', () => loadAiModels(false));
    const aiRefreshModelsBtn = $('aiRefreshModelsBtn');
    if (aiRefreshModelsBtn) aiRefreshModelsBtn.addEventListener('click', () => loadAiModels(true));
    const aiModelFilter = $('aiModelFilter');
    if (aiModelFilter) aiModelFilter.addEventListener('input', () => { aiModelPage = 0; renderModelList(aiModelFilter.value); });
    const aiErrorsRefreshBtn = $('aiErrorsRefreshBtn');
    if (aiErrorsRefreshBtn) aiErrorsRefreshBtn.addEventListener('click', () => loadAiErrors(true));
    const aiErrorsClearBtn = $('aiErrorsClearBtn');
    if (aiErrorsClearBtn) aiErrorsClearBtn.addEventListener('click', async () => {
      try { await api('/api/ai/errors', { method: 'DELETE' }); } catch (_) {}
      loadAiErrors(true);
    });
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

    // Check for public shareable wiki link
    const urlParams = new URLSearchParams(window.location.search);
    const shareToken = urlParams.get('share');
    if (shareToken) {
      await initPublicWiki(shareToken);
      return;
    }

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
