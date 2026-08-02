// Athena Search REST client — everything the TUI needs, zero deps.

export class ApiError extends Error {
  constructor(message, type, status) {
    super(message);
    this.type = type;
    this.status = status;
  }
}

function normalize(url) {
  return url.replace(/\/+$/, '');
}

async function request(base, path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${normalize(base)}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    const type = data?.error?.type || data?.type || `HTTP_${res.status}`;
    const message = data?.error?.message || data?.message || res.statusText;
    throw new ApiError(message, type, res.status);
  }
  return data;
}

export function makeClient(instanceUrl, token) {
  const base = normalize(instanceUrl);
  return {
    health: () => request(base, '/api/health'),
    storageConfig: () => request(base, '/api/storage/config'),
    me: () => request(base, '/api/auth/me', { token }),
    communities: () => request(base, '/api/communities', { token }),
    joinCommunity: (communityId) => request(base, '/api/communities/join', {
      method: 'POST', body: { community_id: communityId }, token,
    }),
    postLink: (payload) => request(base, '/api/links', { method: 'POST', body: payload, token }),
    postPersonalLink: (payload) => request(base, '/api/personal-links', { method: 'POST', body: payload, token }),
  };
}

export const STORAGE_LABELS = {
  d1: 'Cloudflare D1',
  'github-storage': 'GitHub Storage',
  postgres: 'PostgreSQL',
};

export function rankOf(me) {
  if (me?.is_god) return { label: 'GOD', style: 'danger' };
  if (me?.is_elevated) return { label: 'ELEVATED', style: 'accent' };
  return { label: 'USER', style: 'dim' };
}
