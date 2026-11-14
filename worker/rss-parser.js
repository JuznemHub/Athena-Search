/**
 * RSS 2.0, Atom 1.0, and JSON Feed parser with OPML support.
 * Pure ES module with no external dependencies; compatible with both
 * Cloudflare Workers and Node.js.
 */

/**
 * Decode XML entities, including numeric decimal and hex entities.
 */
export function decodeXmlEntities(text) {
  if (!text) return '';
  return String(text)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return ''; }
    })
    .replace(/&#([0-9]+);/g, (_, dec) => {
      try { return String.fromCodePoint(parseInt(dec, 10)); } catch { return ''; }
    });
}

/**
 * Extract content from between XML tags, handling CDATA blocks.
 */
export function extractTagContent(xml, tagName) {
  if (!xml) return '';
  const regex = new RegExp(`<${tagName}(?:\\s+[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = xml.match(regex);
  if (!match) return '';
  let inner = match[1];
  // Extract CDATA if present
  const cdataMatch = inner.match(/<!\[CDATA\[([\s\S]*?)\]\]>/i);
  if (cdataMatch) {
    return cdataMatch[1].trim();
  }
  return decodeXmlEntities(inner.trim());
}

/**
 * Extract attribute value from an XML tag.
 */
export function extractAttribute(xml, tagName, attrName) {
  if (!xml) return '';
  const regex = new RegExp(`<${tagName}[^>]*\\b${attrName}=["']([^"']*)["'][^>]*>`, 'i');
  const match = xml.match(regex);
  return match ? decodeXmlEntities(match[1].trim()) : '';
}

/**
 * Extract lead image URL from XML item block or HTML content.
 */
export function extractLeadImage(itemXml, htmlContent = '') {
  // 1. media:content or media:thumbnail
  const mediaUrl = extractAttribute(itemXml, 'media:content', 'url') ||
    extractAttribute(itemXml, 'media:thumbnail', 'url') ||
    extractAttribute(itemXml, 'enclosure', 'url');

  if (mediaUrl && /^https?:\/\//i.test(mediaUrl)) {
    return mediaUrl;
  }

  // 2. First <img> tag in HTML content
  const combined = `${itemXml} ${htmlContent}`;
  const imgMatch = combined.match(/<img[^>]+src=["'](https?:\/\/[^"']+)["']/i);
  if (imgMatch) {
    return imgMatch[1];
  }
  return null;
}

/**
 * Strip HTML tags and normalize whitespace to create plain text snippet.
 */
export function stripHtml(html, maxLength = 260) {
  if (!html) return '';
  let plain = String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  plain = decodeXmlEntities(plain);
  if (plain.length > maxLength) {
    return plain.slice(0, maxLength).trim() + '…';
  }
  return plain;
}

/**
 * Parse date string into milliseconds timestamp.
 */
export function parseDateToMs(dateStr) {
  if (!dateStr) return Date.now();
  const parsed = Date.parse(dateStr);
  if (!isNaN(parsed) && parsed > 0) {
    return parsed;
  }
  return Date.now();
}

function resolveFeedUrl(candidate, baseUrl = '') {
  const clean = decodeXmlEntities(String(candidate || '').trim());
  if (!clean) return '';
  try {
    return baseUrl ? new URL(clean, baseUrl).toString() : clean;
  } catch {
    return clean;
  }
}

/**
 * Pick the best Atom <link> href regardless of attribute order (`rel` before or after `href`).
 */
function extractAtomLink(blockXml, preferRel = 'alternate', baseUrl = '') {
  const linkTags = [...String(blockXml || '').matchAll(/<link\b([^>]*?)\/?>/gi)];
  let fallback = '';
  for (const m of linkTags) {
    const attrs = m[1] || '';
    const href = extractAttrFromTag(attrs, 'href');
    if (!href) continue;
    const rel = (extractAttrFromTag(attrs, 'rel') || 'alternate').toLowerCase();
    if (rel === preferRel) return resolveFeedUrl(href, baseUrl);
    if (!fallback && rel !== 'self' && rel !== 'hub') fallback = resolveFeedUrl(href, baseUrl);
  }
  return fallback;
}

/**
 * Parse RSS 2.0 / 0.9x XML document.
 */
function parseRss(xml, feedBaseUrl = '') {
  const channelMatch = xml.match(/<channel[\s\S]*?>([\s\S]*?)<\/channel>/i);
  const channelXml = channelMatch ? channelMatch[1] : xml;

  const feedTitle = extractTagContent(channelXml, 'title') || 'Untitled Feed';
  const feedDescription = extractTagContent(channelXml, 'description') || '';
  const channelHead = channelXml.split(/<item[\s>]/i)[0] || channelXml;
  const feedLink = resolveFeedUrl(extractTagContent(channelHead, 'link') || extractAtomLink(channelHead, 'alternate', feedBaseUrl), feedBaseUrl);
  const baseForItems = feedLink || feedBaseUrl;
  const imageMatch = channelHead.match(/<image\b[^>]*>([\s\S]*?)<\/image>/i);
  const feedIcon = imageMatch ? resolveFeedUrl(extractTagContent(imageMatch[1], 'url'), baseForItems) : null;

  const itemRegex = /<item(?:\s+[^>]*)?>([\s\S]*?)<\/item>/gi;
  const articles = [];
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    const title = extractTagContent(itemXml, 'title') || 'Untitled';
    const rawLink = extractTagContent(itemXml, 'link') || extractAtomLink(itemXml, 'alternate', baseForItems);
    const rawGuid = extractTagContent(itemXml, 'guid');
    const isPerma = extractAttribute(itemXml, 'guid', 'isPermaLink') !== 'false' && /^https?:\/\//i.test(rawGuid);
    const link = resolveFeedUrl(rawLink || (isPerma ? rawGuid : ''), baseForItems);
    const guid = rawGuid || link || title;
    const author = extractTagContent(itemXml, 'dc:creator') || extractTagContent(itemXml, 'author') || '';
    const pubDateStr = extractTagContent(itemXml, 'pubDate') || extractTagContent(itemXml, 'dc:date') || extractTagContent(itemXml, 'published') || extractTagContent(itemXml, 'updated');
    const publishedAt = parseDateToMs(pubDateStr);
    const content = extractTagContent(itemXml, 'content:encoded') || extractTagContent(itemXml, 'description') || '';
    const summary = stripHtml(extractTagContent(itemXml, 'description') || content);
    const imageUrl = extractLeadImage(itemXml, content);

    if (link || title) {
      articles.push({
        guid: guid || link || title,
        url: link || '',
        title,
        author: stripHtml(author, 80),
        summary,
        content,
        imageUrl,
        publishedAt
      });
    }
  }

  return {
    type: 'rss',
    title: feedTitle,
    description: feedDescription,
    siteUrl: feedLink,
    iconUrl: feedIcon,
    articles
  };
}

/**
 * Parse Atom 1.0 XML document.
 */
function parseAtom(xml, feedBaseUrl = '') {
  const feedHead = xml.split(/<entry[\s>]/i)[0] || xml;
  const feedTitle = extractTagContent(feedHead, 'title') || 'Untitled Atom Feed';
  const feedSubtitle = extractTagContent(feedHead, 'subtitle') || '';
  const feedIcon = resolveFeedUrl(extractTagContent(feedHead, 'icon') || extractTagContent(feedHead, 'logo') || '', feedBaseUrl) || null;
  const feedLink = extractAtomLink(feedHead, 'alternate', feedBaseUrl);
  const baseForEntries = feedLink || feedBaseUrl;

  const entryRegex = /<entry(?:\s+[^>]*)?>([\s\S]*?)<\/entry>/gi;
  const articles = [];
  let match;

  while ((match = entryRegex.exec(xml)) !== null) {
    const entryXml = match[1];
    const title = extractTagContent(entryXml, 'title') || 'Untitled';
    const link = extractAtomLink(entryXml, 'alternate', baseForEntries);
    const guid = extractTagContent(entryXml, 'id') || link || title;
    const author = extractTagContent(entryXml, 'name') || extractTagContent(entryXml, 'author') || '';
    const pubDateStr = extractTagContent(entryXml, 'published') || extractTagContent(entryXml, 'updated');
    const publishedAt = parseDateToMs(pubDateStr);
    const content = extractTagContent(entryXml, 'content') || extractTagContent(entryXml, 'summary') || '';
    const summary = stripHtml(extractTagContent(entryXml, 'summary') || content);
    const imageUrl = extractLeadImage(entryXml, content);

    if (link || title) {
      articles.push({
        guid: guid || link || title,
        url: link || '',
        title,
        author: stripHtml(author, 80),
        summary,
        content,
        imageUrl,
        publishedAt
      });
    }
  }

  return {
    type: 'atom',
    title: feedTitle,
    description: feedSubtitle,
    siteUrl: feedLink,
    iconUrl: feedIcon,
    articles
  };
}

/**
 * Parse JSON Feed 1.0/1.1 specification.
 */
function parseJsonFeed(jsonStr) {
  let parsed;
  try {
    parsed = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
  } catch (err) {
    throw new Error('Invalid JSON Feed: ' + err.message, { cause: err });
  }

  const articles = (parsed.items || []).map((item) => {
    const title = item.title || 'Untitled';
    const link = item.url || item.external_url || '';
    const guid = item.id || link || title;
    const author = item.author?.name || item.authors?.[0]?.name || '';
    const publishedAt = parseDateToMs(item.date_published || item.date_modified);
    const content = item.content_html || item.content_text || '';
    const summary = stripHtml(item.summary || content);
    const imageUrl = item.image || item.banner_image || extractLeadImage('', content);

    return {
      guid: String(guid),
      url: link,
      title,
      author: stripHtml(author, 80),
      summary,
      content,
      imageUrl: imageUrl || null,
      publishedAt
    };
  });

  return {
    type: 'jsonfeed',
    title: parsed.title || 'Untitled Feed',
    description: parsed.description || '',
    siteUrl: parsed.home_page_url || '',
    iconUrl: parsed.icon || parsed.favicon || null,
    articles
  };
}

/**
 * Detect feed type and parse raw feed content (string or object).
 */
export function parseFeed(content, feedBaseUrl = '') {
  if (!content) {
    throw new Error('Empty feed content');
  }

  const str = typeof content === 'string' ? content.trim() : JSON.stringify(content);

  // Check for JSON Feed
  if (str.startsWith('{') && (str.includes('jsonfeed.org') || str.includes('"items"'))) {
    return parseJsonFeed(str);
  }

  // Check for Atom vs RSS
  if (/<feed[\s\S]*?xmlns=["'][^"']*atom/i.test(str) || (str.includes('<feed') && str.includes('<entry'))) {
    return parseAtom(str, feedBaseUrl);
  }

  return parseRss(str, feedBaseUrl);
}

/**
 * Parse OPML (Outline Processor Markup Language) XML document.
 * Returns array of feed outlines with title, xmlUrl, htmlUrl, and category.
 */
export function parseOpml(xmlText) {
  if (!xmlText) return [];
  const outlines = [];

  // Match outlines with xmlUrl attribute
  const outlineRegex = /<outline\s+([^>]+)>/gi;
  let match;

  // Track parent category if grouped under an outline folder
  // E.g. <outline text="Tech"><outline type="rss" xmlUrl="..."/></outline>
  const folderRegex = /<outline\s+[^>]*text=["']([^"']*)["'][^>]*>([\s\S]*?)<\/outline>/gi;
  let folderMatch;

  const foundUrls = new Set();

  while ((folderMatch = folderRegex.exec(xmlText)) !== null) {
    const categoryName = decodeXmlEntities(folderMatch[1]);
    const innerXml = folderMatch[2];
    const subRegex = /<outline\s+([^>]+)\/?>/gi;
    let subMatch;

    while ((subMatch = subRegex.exec(innerXml)) !== null) {
      const attrs = subMatch[1];
      const xmlUrl = extractAttrFromTag(attrs, 'xmlUrl');
      if (xmlUrl && !foundUrls.has(xmlUrl)) {
        foundUrls.add(xmlUrl);
        outlines.push({
          title: extractAttrFromTag(attrs, 'title') || extractAttrFromTag(attrs, 'text') || 'Feed',
          xmlUrl,
          htmlUrl: extractAttrFromTag(attrs, 'htmlUrl') || '',
          category: categoryName || 'General'
        });
      }
    }
  }

  // Also catch flat outlines with xmlUrl not caught in categorized groups
  while ((match = outlineRegex.exec(xmlText)) !== null) {
    const attrs = match[1];
    const xmlUrl = extractAttrFromTag(attrs, 'xmlUrl');
    if (xmlUrl && !foundUrls.has(xmlUrl)) {
      foundUrls.add(xmlUrl);
      const cat = extractAttrFromTag(attrs, 'category') || 'General';
      outlines.push({
        title: extractAttrFromTag(attrs, 'title') || extractAttrFromTag(attrs, 'text') || 'Feed',
        xmlUrl,
        htmlUrl: extractAttrFromTag(attrs, 'htmlUrl') || '',
        category: cat
      });
    }
  }

  return outlines;
}

function extractAttrFromTag(tagAttrs, attrName) {
  const regex = new RegExp(`\\b${attrName}=["']([^"']*)["']`, 'i');
  const match = tagAttrs.match(regex);
  return match ? decodeXmlEntities(match[1].trim()) : '';
}

/**
 * Generate OPML 2.0 XML document from feeds array.
 */
export function generateOpml(feeds = [], title = 'Athena RSS Feeds') {
  const categories = {};
  for (const feed of feeds) {
    const cat = feed.category || 'General';
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(feed);
  }

  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  xml += `<opml version="2.0">\n`;
  xml += `  <head>\n`;
  xml += `    <title>${escapeXml(title)}</title>\n`;
  xml += `    <dateCreated>${new Date().toUTCString()}</dateCreated>\n`;
  xml += `  </head>\n`;
  xml += `  <body>\n`;

  for (const [catName, catFeeds] of Object.entries(categories)) {
    xml += `    <outline text="${escapeXml(catName)}">\n`;
    for (const f of catFeeds) {
      xml += `      <outline type="rss" text="${escapeXml(f.title)}" title="${escapeXml(f.title)}" xmlUrl="${escapeXml(f.url)}" htmlUrl="${escapeXml(f.site_url || '')}"/>\n`;
    }
    xml += `    </outline>\n`;
  }

  xml += `  </body>\n`;
  xml += `</opml>`;
  return xml;
}

function escapeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
