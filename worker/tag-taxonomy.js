/**
 * Controlled tag vocabulary + deterministic classifier.
 *
 * A link's tags are metadata, not prose: the rules below decide what a page
 * plainly is (type, platform, brand, topic), and the model only fills the gap
 * when the rules come up thin. Nothing reaches storage unless it is canonical
 * here or already in use in the same scope — a model cannot coin a tag.
 */

/** What the thing is. */
export const TYPE_TAGS = [
  'app', 'software', 'tool', 'service', 'website', 'library', 'framework',
  'api', 'bot', 'extension', 'plugin', 'cli', 'game', 'documentation',
  'driver', 'theme',
];

/** Where it runs. `multiplatform` is derived, never guessed. */
export const PLATFORM_TAGS = [
  'android', 'ios', 'windows', 'macos', 'linux', 'web', 'chrome', 'firefox',
  'multiplatform',
];

/** Hosts whose name is the topic: forges, registries, archives. */
export const ECOSYSTEM_TAGS = [
  'github', 'gitlab', 'codeberg', 'bitbucket', 'npm', 'pypi', 'docker',
  'arxiv', 'huggingface', 'kaggle', 'fdroid',
];

/** Brands that may appear as a tag when the page is actually about them. */
export const BRAND_TAGS = [
  'spotify', 'youtube', 'telegram', 'discord', 'reddit', 'netflix', 'twitch',
  'soundcloud', 'wikipedia', 'openai', 'chatgpt', 'steam',
];

/** Subject matter. */
export const CATEGORY_TAGS = [
  'music', 'video', 'movie', 'anime', 'book', 'podcast', 'radio', 'ai',
  'coding', 'privacy', 'vpn', 'security', 'crypto', 'news', 'tutorial',
  'wallpaper', 'sticker', 'font', 'photo', 'design', 'torrent', 'backup',
  'email', 'finance', 'education', 'productivity', 'social',
];

export const CANONICAL_TAGS = new Set([
  ...TYPE_TAGS, ...PLATFORM_TAGS, ...ECOSYSTEM_TAGS, ...BRAND_TAGS, ...CATEGORY_TAGS,
]);

export const PLATFORM_SET = new Set(PLATFORM_TAGS);

/** Provenance/ingest stamps. Never topics, except telegram for Telegram content. */
export const JUNK_TAGS = new Set([
  'backfill', 'dump', 'untagged', 'duplicate', 'duplicates', 'saved', 'link',
  'links', 'file', 'files', 'community', 'personal', 'post', 'posts', 'message',
  'messages', 'channel', 'channels', 'group', 'groups', 'feed', 'feeds',
  'bookmark', 'bookmarks', 'archive', 'archived', 'auto', 'import', 'imported',
  'shared', 'share', 'forward', 'forwarded', 'media', 'attachment', 'attachments',
  'document', 'documents', 'upload', 'uploads', 'rss', 'bot-api', 'untagged-link',
  'telegram',
  // Browser bookmark folders arrive as tags from TUI imports ("Bookmarks
  // Toolbar", "Trash") and describe no topic at all.
  'bookmarks-toolbar', 'bookmarks-bar', 'bookmark-bar', 'bookmark-toolbar',
  'other-bookmarks', 'mobile-bookmarks', 'unsorted', 'trash', 'favorites',
  'folder', 'folders',
  // Words title-scraping coins as tags that never describe a topic.
  'junk', 'misc', 'stuff', 'thing', 'things', 'item', 'items', 'various',
  'untitled', 'placeholder', 'temp', 'temporary', 'new', 'default', 'home',
  'main', 'page', 'index', 'welcome', 'hello', 'title', 'text', 'description',
  'header', 'footer', 'sidebar', 'content',
]);

/** Descriptive fluff: true of almost everything, so it selects nothing. */
export const GENERIC_REJECTS = new Set([
  'technology', 'technologies', 'digital', 'modern', 'online', 'platform',
  'platforms', 'solution', 'solutions', 'innovation', 'innovative', 'useful',
  'interesting', 'cool', 'awesome', 'best', 'popular', 'free', 'general',
  'various', 'misc', 'stuff', 'other', 'internet', 'web-based', 'cutting-edge',
  'powerful', 'simple', 'easy', 'advanced', 'professional', 'ultimate',
  'perfect', 'great', 'good', 'nice', 'amazing', 'unique', 'flexible',
  'efficient', 'reliable', 'secure', 'official', 'alternative', 'alternatives',
  'review', 'reviews', 'download', 'downloads', 'application', 'applications',
  'program', 'programs', 'media', 'content',
]);

const bound = (src) => new RegExp(`(^|[^a-z0-9])(${src})([^a-z0-9]|$)`, 'i');
const hit = (bag, src) => bound(src).test(bag);

const BRAND_RULES = [
  ['spotify', 'spotify', 'music'],
  ['youtube', 'youtube|youtu\\.be', 'video'],
  ['telegram', 'telegram|t\\.me', ''],
  ['discord', 'discord', 'social'],
  ['reddit', 'reddit', 'social'],
  ['netflix', 'netflix', 'movie'],
  ['twitch', 'twitch', 'video'],
  ['soundcloud', 'soundcloud', 'music'],
  ['wikipedia', 'wikipedia', ''],
  ['openai', 'openai', 'ai'],
  ['chatgpt', 'chatgpt', 'ai'],
  ['steam', 'steam', 'game'],
];

const CATEGORY_RULES = [
  ['music', 'music|songs?|mp3|flac|albums?|playlists?'],
  ['video', 'videos?|mp4|streaming'],
  ['movie', 'movies?|films?|cinema|web-series|tv-series'],
  ['anime', 'anime|manga|manhwa'],
  ['book', 'books?|ebooks?|novels?|pdf'],
  ['podcast', 'podcasts?'],
  ['radio', 'radio|stations?'],
  ['ai', 'ai|llms?|machine learning|stable diffusion|midjourney'],
  ['coding', 'programming|developer|sdk|python|javascript|typescript|rust|golang'],
  ['privacy', 'privacy|adblock|ublock|trackers?|fingerprint'],
  ['vpn', 'vpn|proxies?'],
  ['security', 'security|malware|exploits?|vulnerabilit(y|ies)'],
  ['crypto', 'crypto|bitcoin|blockchain|web3'],
  ['news', 'news|breaking'],
  ['tutorial', 'tutorials?|guides?|how-?to|courses?'],
  ['wallpaper', 'wallpapers?'],
  ['sticker', 'stickers?'],
  ['font', 'fonts?|typeface'],
  ['photo', 'photos?|photography|camera'],
  ['design', 'design|figma'],
  ['torrent', 'torrents?|magnet link'],
  ['backup', 'backups?'],
  ['email', 'email|smtp|imap'],
  ['finance', 'finance|budget|banking'],
  ['education', 'education|learning|school|university'],
  ['productivity', 'productivity|todo|task manager'],
];

function hostLabels(rawUrl) {
  try {
    const u = new URL(String(rawUrl || '').startsWith('http') ? rawUrl : `https://${rawUrl}`);
    return u.hostname.replace(/^www\./, '').toLowerCase().split('.');
  } catch (_) {
    return [];
  }
}

/**
 * Classify one link from its own page facts. Deterministic: the same URL and
 * meta always produce the same tags, so re-running /forcetags is stable.
 * Returns { tags, facts } — facts carry the platform/brand view for callers
 * that need to explain or gate a decision.
 */
export function classifyTags(rawUrl, meta = {}) {
  const bag = `${meta?.title || ''} ${meta?.notes || ''} ${meta?.content || ''} ${rawUrl || ''}`
    .toLowerCase()
    .replace(/\s+/g, ' ');

  const platforms = new Set();
  if (hit(bag, 'android|apk|play store|f-droid')) platforms.add('android');
  if (hit(bag, 'ios|iphone|ipad|app store|ipa')) platforms.add('ios');
  if (hit(bag, 'windows|win32|win64|\\.exe')) platforms.add('windows');
  if (hit(bag, 'macos|mac os|osx|\\.dmg')) platforms.add('macos');
  if (hit(bag, 'linux|ubuntu|debian|fedora|\\.deb|appimage|flatpak')) platforms.add('linux');
  if (hit(bag, 'web app|webapp|pwa|browser extension|runs in the browser')) platforms.add('web');
  if (hit(bag, 'chrome extension')) platforms.add('chrome');
  if (hit(bag, 'firefox add-?on')) platforms.add('firefox');

  const software = hit(bag, 'apps?|apk|software|client|installer|\\.exe|\\.apk|\\.ipa|extension|plugin')
    || ['android', 'ios', 'windows', 'macos', 'linux'].some((p) => platforms.has(p));

  const tags = [];
  const add = (t) => { if (t && CANONICAL_TAGS.has(t) && !tags.includes(t) && tags.length < 8) tags.push(t); };

  const brands = [];
  const redundant = new Set();
  for (const [tag, src, category] of BRAND_RULES) {
    if (!hit(bag, src)) continue;
    brands.push(tag);
    add(tag);
    if (category) redundant.add(category);
  }

  // Type: what it is, most specific first.
  const mobile = platforms.has('android') || platforms.has('ios');
  if (software) add(mobile ? 'app' : 'software');
  if (hit(bag, 'extension|add-?on')) add('extension');
  if (hit(bag, 'plugin')) add('plugin');
  if (hit(bag, 'telegram bot|discord bot|chatbot')) add('bot');
  if (hit(bag, 'framework')) add('framework');
  if (hit(bag, 'library|module|sdk|package')) add('library');
  if (hit(bag, 'rest api|graphql|webhook api') || (hit(bag, 'api') && !software)) add('api');
  if (hit(bag, 'game|games|gaming|emulator')) add('game');
  if (hit(bag, 'documentation|docs|manual')) add('documentation');
  if (hit(bag, 'cli|command line')) add('cli');
  if (!software && hit(bag, 'tool|tools|utility|converter|downloader|generator|manager|viewer|editor')) add('tool');
  if (!software && hit(bag, 'service|hosting|cloud storage|saas')) add('service');

  // Topic: brands already cover their own category, so skip the redundancy.
  for (const [tag, src] of CATEGORY_RULES) {
    if (redundant.has(tag)) continue;
    if (hit(bag, src)) add(tag);
  }

  // Ecosystems (host identity only counts where the name is the topic).
  const labels = hostLabels(rawUrl);
  for (const label of labels) {
    const clean = label.replace(/[^a-z0-9]/g, '');
    if (ECOSYSTEM_TAGS.includes(clean)) add(clean);
  }

  // Platforms only describe software; an article about Android is not an app.
  if (software) {
    const os = ['android', 'ios', 'windows', 'macos', 'linux'].filter((p) => platforms.has(p));
    for (const p of os) add(p);
    if (platforms.has('web')) add('web');
    if (platforms.has('chrome')) add('chrome');
    if (platforms.has('firefox')) add('firefox');
    if (os.length >= 2) add('multiplatform');
  }

  if (!tags.length) add('website');

  return {
    tags,
    facts: {
      software,
      platforms: [...platforms],
      brands,
      telegram: brands.includes('telegram'),
      redundant: [...redundant],
    },
  };
}

/**
 * Enforce the vocabulary. Existing scope vocabulary is allowed through so a
 * community's curated tags survive; anything else must be canonical.
 * Returns { tags, rejected: [{ tag, reason }] } with one reason per drop.
 */
export function validateTags(tags, { vocabulary = [], banned = [], max = 8 } = {}) {
  const allowed = new Set(vocabulary.map((t) => String(t).replace(/^#/, '').trim().toLowerCase()).filter(Boolean));
  const bannedSet = new Set(banned.map((t) => String(t).replace(/^#/, '').trim().toLowerCase()).filter(Boolean));
  const out = [];
  const rejected = [];
  const seen = new Set();
  for (const raw of Array.isArray(tags) ? tags : []) {
    const tag = String(raw).replace(/^#/, '').trim().toLowerCase().replace(/\s+/g, '-').slice(0, 40);
    if (!tag || tag.length < 2) { rejected.push({ tag, reason: 'empty' }); continue; }
    if (seen.has(tag)) { rejected.push({ tag, reason: 'duplicate' }); continue; }
    seen.add(tag);
    if (bannedSet.has(tag)) { rejected.push({ tag, reason: 'name' }); continue; }
    if (JUNK_TAGS.has(tag)) { rejected.push({ tag, reason: 'junk' }); continue; }
    if (GENERIC_REJECTS.has(tag)) { rejected.push({ tag, reason: 'generic' }); continue; }
    if (!CANONICAL_TAGS.has(tag) && !allowed.has(tag)) { rejected.push({ tag, reason: 'unknown' }); continue; }
    if (out.length >= max) { rejected.push({ tag, reason: 'limit' }); continue; }
    out.push(tag);
  }
  return { tags: out, rejected };
}
