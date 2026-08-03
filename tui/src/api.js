// Athena Search REST client — everything the TUI needs, zero deps.

export class ApiError extends Error {
  constructor(message, type, status, { code = type, retryAfterMs = null } = {}) {
    super(message);
    this.type = type;
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

function normalize(url) {
  return url.replace(/\/+$/, '');
}

function retryAfterMs(headers) {
  const raw = headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function errorCode(data, status) {
  const nested = data?.error && typeof data.error === 'object' ? data.error : null;
  return data?.code || nested?.code || nested?.type || data?.type || `HTTP_${status}`;
}

function errorMessage(data, statusText) {
  if (typeof data?.error === 'string') return data.error;
  return data?.error?.message || data?.message || statusText || 'Request failed';
}

async function request(base, path, { method = 'GET', body, token, timeout = 15_000, headers = {} } = {}) {
  let res;
  try {
    res = await fetch(`${normalize(base)}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...headers,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new ApiError('The server did not respond (request timed out).', 'TIMEOUT', 0);
    }
    throw new ApiError(e?.message || 'Could not reach the Athena instance.', 'NETWORK', 0);
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    const type = errorCode(data, res.status);
    const message = errorMessage(data, res.statusText);
    throw new ApiError(message, type, res.status, {
      code: data?.code || type,
      retryAfterMs: retryAfterMs(res.headers),
    });
  }
  return data;
}

const BATCH_TIMEOUT_MS = 60_000;

export function makeClient(instanceUrl, token) {
  const base = normalize(instanceUrl);
  return {
    health: () => request(base, '/api/health'),
    storageConfig: () => request(base, '/api/storage/config'),
    me: () => request(base, '/api/auth/me', { token }),
    communities: () => request(base, '/api/communities', { token }),
    personalLinks: () => request(base, '/api/personal-links', { token }),
    links: (communityId) => request(base, `/api/links?community_id=${encodeURIComponent(communityId)}`, { token }),
    joinCommunity: (communityId) => request(base, '/api/communities/join', {
      method: 'POST', body: { community_id: communityId }, token,
    }),
    postLink: (payload) => request(base, '/api/links', { method: 'POST', body: payload, token }),
    postPersonalLink: (payload) => request(base, '/api/personal-links', { method: 'POST', body: payload, token }),
    postLinksBatch: (links, communityId, options = {}) => request(base, '/api/links/batch', {
      method: 'POST', body: { community_id: communityId, links }, token,
      timeout: options.timeout || BATCH_TIMEOUT_MS,
      headers: options.idempotencyKey ? { 'X-Athena-Batch-Key': options.idempotencyKey } : {},
    }),
    postPersonalLinksBatch: (links, options = {}) => request(base, '/api/personal-links/batch', {
      method: 'POST', body: { links }, token,
      timeout: options.timeout || BATCH_TIMEOUT_MS,
      headers: options.idempotencyKey ? { 'X-Athena-Batch-Key': options.idempotencyKey } : {},
    }),
  };
}

export const STORAGE_LABELS = {
  d1: 'Cloudflare D1',
  github: 'GitHub Storage',
  'github-storage': 'GitHub Storage',
  postgres: 'PostgreSQL',
  local: 'PostgreSQL',
};

export function rankOf(me) {
  if (me?.is_god) return { label: 'GOD', style: 'danger' };
  if (me?.is_elevated) return { label: 'ELEVATED', style: 'accent' };
  return { label: 'USER', style: 'dim' };
}
