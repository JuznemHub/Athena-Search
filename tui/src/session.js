export function parseSessionToken(text) {
  const value = String(text || '').trim();
  const m = value.match(/[?&#]session=([^&]+)/) || value.match(/^[A-Za-z0-9_-]{20,}$/);
  if (!m) return null;
  return decodeURIComponent(m[1] || m[0]);
}
