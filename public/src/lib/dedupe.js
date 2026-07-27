/**
 * Deduplication & URL Normalization Module
 * Handles URL canonicalization, stripping tracking queries, and checking duplicates.
 */

/**
 * Normalizes a URL string by stripping protocol, www, trailing slashes, and common tracking query parameters.
 * @param {string} rawUrl - The input URL string.
 * @returns {object} Object containing normalizedUrl and canonicalHash.
 */
function normalizeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { normalizedUrl: '', canonicalUrl: '', hash: '' };
  }

  let cleaned = rawUrl.trim();
  if (!cleaned.match(/^https?:\/\//i)) {
    cleaned = 'https://' + cleaned;
  }

  try {
    const parsed = new URL(cleaned);

    // Strip tracking parameters
    const trackingParams = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'ref', 'fbclid', 'gclid', 'msclkid', 'mc_cid', 'mc_eid', '_hsenc', '_hsmi'
    ];
    
    trackingParams.forEach(param => parsed.searchParams.delete(param));

    // Normalize hostname
    let hostname = parsed.hostname.toLowerCase();
    if (hostname.startsWith('www.')) {
      hostname = hostname.slice(4);
    }

    // Normalize path (strip trailing slash)
    let pathname = parsed.pathname;
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }

    const canonicalUrl = `${parsed.protocol}//${hostname}${pathname}${parsed.search}`;
    const normalizedUrl = `${hostname}${pathname}${parsed.search}`.toLowerCase();

    // Simple Hash Generator for deduplication check
    let hash = 0;
    for (let i = 0; i < normalizedUrl.length; i++) {
      const char = normalizedUrl.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }

    return {
      canonicalUrl,
      normalizedUrl,
      hash: Math.abs(hash).toString(36)
    };
  } catch (err) {
    return {
      canonicalUrl: cleaned,
      normalizedUrl: cleaned.toLowerCase(),
      hash: 'raw_' + cleaned.length
    };
  }
}

/**
 * Checks if a candidate URL already exists in a given array of link objects.
 * @param {string} candidateUrl - The URL to test.
 * @param {Array} existingLinks - Array of existing link objects containing `.url` or `.normalizedUrl`.
 * @returns {object} { isDuplicate: boolean, existingLink: object|null }
 */
function checkDuplicateLink(candidateUrl, existingLinks = []) {
  const normalizedCandidate = normalizeUrl(candidateUrl);

  for (const link of existingLinks) {
    const targetNorm = normalizeUrl(link.url || link.canonicalUrl || '');
    if (targetNorm.normalizedUrl === normalizedCandidate.normalizedUrl) {
      return {
        isDuplicate: true,
        existingLink: link
      };
    }
  }

  return {
    isDuplicate: false,
    existingLink: null
  };
}

// Export for ES modules and global window usage
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { normalizeUrl, checkDuplicateLink };
} else {
  window.Dedupe = { normalizeUrl, checkDuplicateLink };
}
