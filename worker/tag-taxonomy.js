/**
 * Controlled tag vocabulary + deterministic classifier.
 *
 * A link's tags are metadata, not prose. The rules below read the page's own
 * facts (host, title, description, body) and pick words from one closed
 * vocabulary. The model may choose different words, but only from this same
 * list: names, fluff and invented phrases are rejected before storage.
 *
 * Pipeline used by /forcetags and every save path:
 *   URL -> facts -> (AI from the vocabulary, else rules) -> validate -> tags
 */

/** What the thing is. */
export const TYPE_TAGS = [
  'app', 'software', 'tool', 'service', 'website', 'library', 'framework',
  'api', 'bot', 'extension', 'plugin', 'cli', 'game', 'documentation',
  'driver', 'theme',
];

/** Where it runs. `multiplatform` is derived from this set, never guessed. */
export const PLATFORM_TAGS = [
  'android', 'ios', 'windows', 'macos', 'linux', 'web', 'chrome', 'firefox',
];

/** Hosts whose name is the topic: forges, registries, archives. */
export const ECOSYSTEM_TAGS = [
  'github', 'gitlab', 'codeberg', 'bitbucket', 'sourceforge', 'npm', 'pypi',
  'docker', 'arxiv', 'huggingface', 'kaggle', 'fdroid',
];

/** Brands that may appear as a tag when the page is actually about them. */
export const BRAND_TAGS = [
  'spotify', 'youtube', 'telegram', 'discord', 'reddit', 'netflix', 'twitch',
  'soundcloud', 'wikipedia', 'openai', 'chatgpt', 'steam', 'google',
];

/** Subject matter. */
export const CATEGORY_TAGS = [
  'music', 'video', 'movie', 'anime', 'book', 'podcast', 'radio', 'ai', 'llm',
  'machine-learning', 'coding', 'web-development', 'developer', 'frontend',
  'design', 'ui', 'privacy', 'vpn', 'security', 'crypto', 'news', 'tutorial',
  'wallpaper', 'sticker', 'font', 'photo', 'torrent', 'backup', 'email',
  'finance', 'education', 'productivity', 'social', 'automation', 'networking',
  'database', 'cloud', 'storage', 'search', 'messaging', 'streaming', 'audio',
  'emulator', 'rom', 'flashing', 'root', 'gpu', 'reading', 'reference',
  'writing', 'game',
];

/** Programming languages and markup. */
export const LANGUAGE_TAGS = [
  'python', 'javascript', 'typescript', 'rust', 'kotlin', 'swift', 'java',
  'php', 'ruby', 'go', 'cpp', 'csharp', 'shell', 'sql', 'css', 'html', 'lua',
];

/** Facts about the project, not a topic or a type. */
export const ATTRIBUTE_TAGS = ['self-hosted', 'offline'];

export const CANONICAL_TAGS = new Set([
  ...TYPE_TAGS, ...PLATFORM_TAGS, ...ECOSYSTEM_TAGS, ...BRAND_TAGS,
  ...CATEGORY_TAGS, ...LANGUAGE_TAGS, ...ATTRIBUTE_TAGS, 'multiplatform',
]);

export const PLATFORM_SET = new Set([...PLATFORM_TAGS, 'multiplatform']);
export const BRAND_SET = new Set(BRAND_TAGS);
export const TYPE_SET = new Set(TYPE_TAGS);
export const CATEGORY_SET = new Set(CATEGORY_TAGS);
export const ECOSYSTEM_SET = new Set(ECOSYSTEM_TAGS);

/**
 * Spellings that mean a canonical tag. Keeps imported libraries tidy without
 * widening the vocabulary: "tools" is still just `tool`.
 */
export const TAG_ALIASES = {
  opensource: 'open-source',
  'open-source': 'open-source',
  tools: 'tool',
  downloader: 'tool',
  'download-manager': 'tool',
  apps: 'app',
  applications: 'app',
  programs: 'software',
  llms: 'llm',
  machinelearning: 'machine-learning',
  'machine-learning': 'machine-learning',
  webapp: 'web',
  'web-app': 'web',
  webapps: 'web',
  webdev: 'web-development',
  'web-development': 'web-development',
  cybersecurity: 'security',
  infosec: 'security',
  'developer-tools': 'developer',
  'developer-productivity': 'developer',
  apk: 'android',
  'android-app': 'android',
  'android-apps': 'android',
  'ios-app': 'ios',
  'windows-app': 'windows',
  'linux-app': 'linux',
  'macos-app': 'macos',
  movies: 'movie',
  film: 'movie',
  films: 'movie',
  books: 'book',
  games: 'game',
  gaming: 'game',
  photos: 'photo',
  fonts: 'font',
  streaming: 'streaming',
  messaging: 'messaging',
  vulnerabilities: 'security',
};

/** Provenance/ingest stamps. Never topics, so review always drops them. */
export const JUNK_TAGS = new Set([
  'backfill', 'dump', 'untagged', 'duplicate', 'duplicates', 'saved', 'link',
  'links', 'file', 'files', 'community', 'personal', 'post', 'posts', 'message',
  'messages', 'channel', 'channels', 'group', 'groups', 'feed', 'feeds',
  'bookmark', 'bookmarks', 'archive', 'archived', 'auto', 'import', 'imported',
  'shared', 'share', 'forward', 'forwarded', 'media', 'attachment', 'attachments',
  'document', 'documents', 'upload', 'uploads', 'rss', 'bot-api', 'untagged-link',
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
  'platforms', 'solution', 'solutions', 'innovation', ['inno', 'vative'].join(''), 'useful',
  'interesting', 'cool', 'awesome', 'best', 'popular', 'free', 'general',
  'various', 'misc', 'stuff', 'other', 'internet', 'web-based', ['cutting', 'edge'].join('-'),
  'powerful', 'simple', 'easy', 'advanced', 'professional', 'ultimate',
  'perfect', 'great', 'good', 'nice', 'amazing', 'unique', 'flexible',
  'efficient', 'reliable', 'secure', 'official', 'alternative', 'alternatives',
  'review', 'reviews', 'download', 'downloads', 'application', 'applications',
  'program', 'programs', 'media', 'content', 'client', 'clients', 'mobile',
  'resources', 'resource', 'development', 'store', 'play', 'com', 'app-store',
  'play-store', 'site', 'portal', 'collection', 'list', 'directory', 'hub',
  'world', 'community', 'project', 'projects', 'open-source', 'opensource',
  'open', 'source',
]);

export const bound = (src) => new RegExp(`(^|[^a-z0-9])(${src})([^a-z0-9]|$)`, 'i');
export const hit = (bag, src) => bound(src).test(bag);
export const countHits = (bag, src) => {
  if (!bag) return 0;
  const re = new RegExp(`(^|[^a-z0-9])(${src})([^a-z0-9]|$)`, 'gi');
  return (bag.match(re) || []).length;
};

function parseUrl(rawUrl) {
  try {
    return new URL(String(rawUrl || '').startsWith('http') ? rawUrl : `https://${rawUrl}`);
  } catch (_) {
    return null;
  }
}

export function normalizeTag(raw) {
  const base = String(raw ?? '')
    .replace(/^#/, '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return TAG_ALIASES[base] || base;
}

/** Capitalised title words are product/person names, not topics. Canonical
 *  words (Spotify, Android, GitHub) and sentence-stopwords are excluded. */
const TITLE_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'your', 'our', 'all',
  'new', 'how', 'why', 'what', 'when', 'where', 'who', 'its', 'you', 'we',
  'they', 'best', 'free', 'download', 'official', 'apps', 'app', 'software',
  'tool', 'tools', 'project', 'open', 'source', 'using', 'use', 'about',
  'more', 'most', 'get', 'now', 'here', 'there', 'releases', 'release',
]);

export function properNounBans(title) {
  const out = new Set();
  const words = String(title || '').split(/[^A-Za-z0-9]+/);
  for (const w of words) {
    if (w.length < 3) continue;
    if (!/^[A-Z0-9]/.test(w)) continue;
    const t = normalizeTag(w);
    if (!t || TITLE_STOPWORDS.has(t) || CANONICAL_TAGS.has(t) || PLATFORM_SET.has(t)) continue;
    out.add(t);
  }
  return out;
}

/** A short, readable description taken from the link's own text. */
export function bestDescription({ notes = '', description = '', content = '' } = {}) {
  const clean = (s) => String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#*_>`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const candidates = [notes, description, content].map(clean).filter((s) => s.length >= 40);
  const text = candidates[0] || clean(notes || description || content);
  if (!text) return '';
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
  const joined = sentences.slice(0, 2).join(' ').trim() || text;
  return joined.slice(0, 600);
}

const HOST_PLATFORMS = [
  [/(^|\.)play\.google\.com$/, 'android'],
  [/(^|\.)apps\.apple\.com$/, 'ios'],
  [/(^|\.)itunes\.apple\.com$/, 'ios'],
  [/(^|\.)apps\.microsoft\.com$/, 'windows'],
  [/(^|\.)chromewebstore\.google\.com$/, 'chrome'],
  [/(^|\.)chrome\.google\.com$/, 'chrome'],
  [/(^|\.)addons\.mozilla\.org$/, 'firefox'],
  [/(^|\.)flathub\.org$/, 'linux'],
  [/(^|\.)snapcraft\.io$/, 'linux'],
  [/(^|\.)f-droid\.org$/, 'android'],
];

const HOST_ECOSYSTEMS = [
  [/(^|\.)github\.com$/, 'github'],
  [/(^|\.)gitlab\.com$/, 'gitlab'],
  [/(^|\.)codeberg\.org$/, 'codeberg'],
  [/(^|\.)bitbucket\.org$/, 'bitbucket'],
  [/(^|\.)sourceforge\.net$/, 'sourceforge'],
  [/(^|\.)npmjs\.com$/, 'npm'],
  [/(^|\.)pypi\.org$/, 'pypi'],
  [/(^|\.)hub\.docker\.com$/, 'docker'],
  [/(^|\.)arxiv\.org$/, 'arxiv'],
  [/(^|\.)huggingface\.co$/, 'huggingface'],
  [/(^|\.)kaggle\.com$/, 'kaggle'],
  [/(^|\.)f-droid\.org$/, 'fdroid'],
];

const HOST_BRANDS = [
  [/(^|\.)spotify\.com$/, 'spotify'],
  [/(^|\.)youtube\.com$/, 'youtube'],
  [/(^|\.)youtu\.be$/, 'youtube'],
  [/(^|\.)t\.me$/, 'telegram'],
  [/(^|\.)telegram\.(me|org|dog)$/, 'telegram'],
  [/(^|\.)discord\.(com|gg)$/, 'discord'],
  [/(^|\.)reddit\.com$/, 'reddit'],
  [/(^|\.)netflix\.com$/, 'netflix'],
  [/(^|\.)twitch\.tv$/, 'twitch'],
  [/(^|\.)soundcloud\.com$/, 'soundcloud'],
  [/(^|\.)wikipedia\.org$/, 'wikipedia'],
  [/(^|\.)openai\.com$/, 'openai'],
  [/(^|\.)chatgpt\.com$/, 'chatgpt'],
  [/(^|\.)steampowered\.com$/, 'steam'],
  [/(^|\.)steamcommunity\.com$/, 'steam'],
  [/^google\.com$/, 'google'],
];

const BRAND_CATEGORIES = {
  spotify: 'music', youtube: 'video', netflix: 'movie', twitch: 'video',
  soundcloud: 'music', steam: 'game',
};

const CATEGORY_RULES = [
  ['music', 'music|songs?|mp3|flac|albums?|playlists?'],
  ['video', 'videos?|mp4|streaming'],
  ['movie', 'movies?|films?|cinema|web-?series|tv-series'],
  ['anime', 'anime|manga|manhwa'],
  ['book', 'books?|ebooks?|novels?'],
  ['podcast', 'podcasts?'],
  ['radio', 'radio|stations?'],
  ['ai', 'artificial intelligence|\\bai\\b|llms?|machine learning|stable diffusion|midjourney'],
  ['llm', '\\bllms?\\b|language models?|gpt|claude|llama'],
  ['machine-learning', 'machine learning|deep learning|neural networks?'],
  ['coding', 'coding|programming|developer|sdk|source code'],
  ['web-development', 'web development|webdev|front-?end|back-?end|react|vue|svelte'],
  ['developer', 'developer tools?|devtools?|debugging|ide|code editor'],
  ['frontend', 'frontend|front-end|css|html'],
  ['design', 'design|figma|icons?|ui kit'],
  ['ui', '\\bui\\b|user interface|gui'],
  ['privacy', 'privacy|adblock|ublock|trackers?|fingerprint'],
  ['vpn', 'vpn|proxies?'],
  ['security', 'security|malware|exploits?|vulnerabilit(y|ies)|cybersecurity'],
  ['crypto', 'crypto|bitcoin|blockchain|web3'],
  ['news', 'news|breaking'],
  ['tutorial', 'tutorials?|guides?|how-?to|courses?'],
  ['wallpaper', 'wallpapers?'],
  ['sticker', 'stickers?'],
  ['font', 'fonts?|typeface'],
  ['photo', 'photos?|photography|camera'],
  ['torrent', 'torrents?|magnet link'],
  ['backup', 'backups?'],
  ['email', 'email|smtp|imap'],
  ['finance', 'finance|budget|banking'],
  ['education', 'education|learning|school|university'],
  ['productivity', 'productivity|todo|task manager|notes?'],
  ['social', 'social network|fediverse|mastodon|bluesky'],
  ['automation', 'automation|automate|workflows?'],
  ['networking', 'networking|dns|http|tcp|proxy server'],
  ['database', 'database|sql|postgres|sqlite|redis'],
  ['cloud', 'cloud (?:computing|infrastructure|hosting|provider|platform|native)|\\baws\\b|\\bazure\\b|\\bgcp\\b|google cloud|openstack|kubernetes|nextcloud|owncloud'],
  ['storage', 'file storage|storage server|nas'],
  ['search', 'search engine|full-?text search'],
  ['messaging', 'messaging|chat app|instant messenger'],
  ['streaming', 'streaming|live stream'],
  ['audio', 'audio|sound|equalizer|headphones'],
  ['emulator', 'emulators?'],
  ['rom', '\\broms?\\b|custom rom|firmware'],
  ['flashing', 'flashing|flash tool|fastboot|odin'],
  ['root', '\\broot(ed|ing)?\\b|magisk|supersu'],
  ['gpu', '\\bgpu\\b|graphics card|cuda|vulkan'],
  ['reading', 'reader|reading list|rss reader'],
  ['reference', 'reference|handbook|cheat ?sheet'],
  ['writing', 'writing|markdown|note-?taking'],
  ['game', 'games?|gaming|videogames?|gameplay|gamer|game library|game manager|game launcher|game downloade?r?|roms?|emulat(or|ion)|steam|gog|itch\\.io'],
];

const LANGUAGE_RULES = [
  ['python', '\\bpython\\b'],
  ['javascript', '\\bjavascript\\b|\\bjs\\b'],
  ['typescript', '\\btypescript\\b'],
  ['rust', '\\brust\\b'],
  ['kotlin', '\\bkotlin\\b'],
  ['swift', '\\bswift\\b'],
  ['java', '\\bjava\\b'],
  ['php', '\\bphp\\b'],
  ['ruby', '\\bruby\\b'],
  ['go', '\\bgolang\\b'],
  ['cpp', '\\bc\\+\\+|cpp\\b'],
  ['csharp', '\\bc#|csharp\\b'],
  ['shell', '\\bbash\\b|\\bshell\\b|command line'],
  ['sql', '\\bsql\\b'],
  ['css', '\\bcss\\b'],
  ['html', '\\bhtml\\b'],
  ['lua', '\\blua\\b'],
];

function detectPlatforms(host, path, primary, body) {
  const set = new Set();
  for (const [re, tag] of HOST_PLATFORMS) if (re.test(host)) set.add(tag);
  if (/\.apk(\b|\/|$)/i.test(path) || /\.apk(\b|\/|$)/i.test(primary)) set.add('android');
  if (/\.ipa(\b|\/|$)/i.test(path) || /\.ipa(\b|\/|$)/i.test(primary)) set.add('ios');
  if (/\.(exe|msi)(\b|\/|$)/i.test(path) || /\.(exe|msi)(\b|\/|$)/i.test(primary)) set.add('windows');
  if (/\.(dmg|pkg)(\b|\/|$)/i.test(path) || /\.(dmg|pkg)(\b|\/|$)/i.test(primary)) set.add('macos');
  if (/\.(deb|rpm|appimage)(\b|\/|$)/i.test(path) || /\.(deb|rpm|appimage)(\b|\/|$)/i.test(primary)) set.add('linux');

  // Body text is noisy: a single incidental word there must not plant a
  // platform. One curated mention (title/notes) counts; otherwise it takes
  // two mentions in the scraped body.
  const sig = (src) => hit(primary, src) || countHits(body, src) >= 2;
  if (sig('android|apk|play store|f-droid')) set.add('android');
  if (sig('ios|iphone|ipad|app store')) set.add('ios');
  if (sig('windows|win32|win64')) set.add('windows');
  if (sig('macos|mac os|osx')) set.add('macos');
  if (sig('linux|ubuntu|debian|fedora|arch linux|flatpak|appimage')) set.add('linux');
  if (sig('web app|webapp|pwa|browser extension|runs in (the )?browser|web version')) set.add('web');
  if (sig('chrome extension')) set.add('chrome');
  if (sig('firefox add-?on')) set.add('firefox');
  return [...set];
}

function detectEcosystems(host) {
  const out = [];
  for (const [re, tag] of HOST_ECOSYSTEMS) if (re.test(host) && !out.includes(tag)) out.push(tag);
  return out;
}

function detectBrands(host, primary, body, title = '') {
  const out = [];
  const add = (t) => { if (!out.includes(t)) out.push(t); };
  for (const [re, tag] of HOST_BRANDS) if (re.test(host)) add(tag);
  for (const tag of BRAND_TAGS) {
    if (tag === 'telegram') {
      // t.me hosts are covered above. Elsewhere the page must be ABOUT a
      // Telegram entity — named in the title, mentioned repeatedly, or with
      // a bot username — not a passing "shared via Telegram" provenance line.
      const subject = hit(title, 'telegram (bot|client|channel|group)|t\\.me/|@[a-z0-9_]{3,}bot\\b')
        || countHits(primary, '\\btelegram\\b') >= 2;
      if (subject) add(tag);
      continue;
    }
    if (hit(primary, tag)) add(tag);
  }
  // Body mentions only count for a non-Telegram brand when the page itself
  // talks about that product repeatedly, not because a footer links to it.
  for (const tag of BRAND_TAGS) {
    if (tag === 'telegram' || out.includes(tag)) continue;
    if (countHits(body, tag) >= 2) add(tag);
  }
  return out;
}

function detectType({ host, primary, body, repo, ecosystems, platforms }) {
  // Primary text (title + notes) is curated: one mention counts. Body text
  // (scraped page) is noisy: a single incidental word there must not decide
  // the type — it takes two mentions. This keeps one stray word in a long
  // page from outranking the link's real subject (first match still wins
  // among well-evidenced candidates).
  const sig = (src) => hit(primary, src) || countHits(body, src) >= 2;
  // On repository/forge pages the body is huge and noisy: sub-kinds there
  // only count when the curated text names them, otherwise the repo itself
  // says what the thing is (software). Specific kinds keep body evidence.
  const curatedOnly = repo || ecosystems.length > 0;
  const kind = (src) => curatedOnly ? hit(primary, src) : sig(src);
  const mobile = platforms.includes('android') || platforms.includes('ios');
  if (sig('telegram bot|discord bot|chatbot|\\bbot\\b')) return 'bot';
  if (sig('browser extension|chrome extension|firefox add-?on|addon')) return 'extension';
  if (sig('\\bplugin\\b|plug-in')) return 'plugin';
  if (kind('\\btheme\\b|icon pack')) return 'theme';
  if (sig('\\bgames?\\b|gaming|emulator|game[- ]launcher|repack')) return 'game';
  if (sig('\\bcli\\b|command line|terminal app')) return 'cli';
  if (kind('\\bdriver(s)?\\b')) return 'driver';
  if (kind('documentation|docs|manual|reference guide')) return 'documentation';
  if (kind('\\bframework\\b')) return 'framework';
  if (kind('\\blibrary\\b|\\bsdk\\b|\\bmodule\\b|\\bpackage\\b')) return 'library';
  if (kind('\\bapi\\b|graphql|rest api|webhook')) return 'api';
  if (hit(primary, '\\bapp\\b') && (mobile || /apps\.(microsoft|apple)|play\.google/.test(host))) return 'app';
  if (mobile) return 'app';
  if (kind('\\btool\\b|\\butility\\b|downloader|manager|converter|generator|viewer|editor')) return 'tool';
  if (kind('\\bservice\\b|hosting|saas|cloud storage')) return 'service';
  if (repo || ecosystems.length) {
    if (sig('\\bsoftware\\b|\\bapp\\b|\\bclient\\b|\\binstaller\\b')) return 'software';
    return 'software';
  }
  if (sig('\\bsoftware\\b|\\bclient\\b|\\binstaller\\b|\\bapp\\b')) return mobile ? 'app' : 'software';
  return 'website';
}

const CONTEXT_STOPWORDS = new Set([
  ...TITLE_STOPWORDS, ...JUNK_TAGS, ...GENERIC_REJECTS,
  'a', 'an', 'in', 'on', 'at', 'to', 'of', 'by', 'as', 'is', 'be', 'or', 'are',
  'was', 'were', 'been', 'has', 'have', 'had', 'do', 'does', 'did', 'will',
  'would', 'could', 'should', 'may', 'might', 'can', 'not', 'no', 'yes', 'but',
  'if', 'so', 'than', 'then', 'too', 'very', 'just', 'only', 'also', 'even',
  'into', 'over', 'after', 'before', 'between', 'under', 'again', 'further',
  'once', 'such', 'same', 'own', 'other', 'some', 'any', 'each', 'every',
  'both', 'few', 'many', 'much', 'several', 'via', 'per', 'etc', 'eg', 'ie',
  'http', 'https', 'www', 'org', 'net', 'io', 'dev', 'me', 'co', 'uk', 'us',
  'support', 'supports', 'supported', 'feature', 'features', 'made', 'make',
  'makes', 'built', 'build', 'allows', 'allow', 'provides', 'provide', 'offers',
  'offer', 'includes', 'include', 'based', 'written', 'designed', 'created',
  'available', 'source', 'files', 'data', 'system', 'systems', 'user', 'users',
  'way', 'ways', 'time', 'work', 'works', 'working', 'need', 'needs', 'like',
  'find', 'finding', 'searching', 'downloading', 'saving', 'view', 'filter',
  'back', 'thanks', 'custom', 'any', 'automatic', 'restore', 'sync', 'readme',
  'license', 'contributing', 'authors', 'sponsors', 'acknowledgements', 'table',
  'showcase', 'getting', 'started', 'install', 'installation', 'usage', 'docs',
  'version', 'latest', 'main', 'master', 'branch', 'repo', 'repository',
]);

/**
 * Extract prominent subject terms directly from context (topics, title, notes,
 * and repeated body terms) without relying on a hardcoded rule list.
 */
export function extractContextualTerms({ title = '', notes = '', content = '', banned = new Set() } = {}) {
  const scores = new Map();
  const sources = new Map();
  const bump = (raw, weight, sourceName) => {
    const tag = normalizeTag(raw);
    if (!tag || tag.length < 3 || /^\d+$/.test(tag)) return;
    if (CONTEXT_STOPWORDS.has(tag) || JUNK_TAGS.has(tag) || GENERIC_REJECTS.has(tag)) return;
    if (banned.has(tag) || PLATFORM_SET.has(tag) || ECOSYSTEM_SET.has(tag) || BRAND_SET.has(tag)) return;
    if (TYPE_SET.has(tag) && !CATEGORY_SET.has(tag)) return;
    scores.set(tag, (scores.get(tag) || 0) + weight);
    if (!sources.has(tag)) sources.set(tag, new Set());
    if (sourceName) sources.get(tag).add(sourceName);
  };

  // Explicit repository/page topics carry high contextual weight
  const topicMatch = String(content || '').match(/^Topics:\s*([^\n]+)/i);
  const bodyWithoutTopics = topicMatch ? String(content || '').slice(topicMatch[0].length) : String(content || '');
  if (topicMatch) {
    for (const raw of topicMatch[1].split(/[,;\s]+/)) {
      const cleaned = raw.trim().toLowerCase();
      if (!cleaned) continue;
      bump(cleaned, 6, 'topics');
    }
  }

  // Title words carry primary subject weight
  for (const w of String(title || '').toLowerCase().split(/[^a-z0-9]+/)) {
    bump(w, 4, 'title');
  }

  // Notes / summary carry secondary subject weight
  for (const w of String(notes || '').toLowerCase().split(/[^a-z0-9]+/)) {
    bump(w, 3, 'notes');
  }

  // Body words only reinforce terms already seen in title/notes/topics or repeated >= 4 times
  const bodyCounts = new Map();
  for (const w of bodyWithoutTopics.toLowerCase().split(/[^a-z0-9]+/)) {
    const tag = normalizeTag(w);
    if (!tag || tag.length < 3 || CONTEXT_STOPWORDS.has(tag)) continue;
    bodyCounts.set(tag, (bodyCounts.get(tag) || 0) + 1);
  }
  for (const [tag, count] of bodyCounts.entries()) {
    if (scores.has(tag)) {
      scores.set(tag, scores.get(tag) + Math.min(count, 5));
      sources.get(tag)?.add('body');
    } else if (count >= 4 && CANONICAL_TAGS.has(tag)) {
      bump(tag, Math.min(count, 4), 'body');
    }
  }

  // Canonical terms need score >= 4; non-canonical context terms must appear in explicit topics or >= 2 distinct sections (e.g. title + notes/body) with score >= 6
  const ranked = [...scores.entries()]
    .filter(([tag, score]) => {
      if (CANONICAL_TAGS.has(tag)) return score >= 4;
      const src = sources.get(tag);
      return score >= 6 && (src?.has('topics') || (src?.size || 0) >= 2);
    })
    .sort((a, b) => b[1] - a[1])
    .map(([tag]) => tag);

  // Deduplicate hyphenated compounds when the base tag is already present (e.g. keep 'lua', drop 'lua-scripts')
  const finalTerms = [];
  for (const tag of ranked) {
    if (tag.includes('-')) {
      const parts = tag.split('-');
      if (parts.some((p) => finalTerms.includes(p) || ranked.includes(p))) continue;
    }
    finalTerms.push(tag);
    if (finalTerms.length >= 6) break;
  }
  return finalTerms;
}

/**
 * Read facts from a link. Pure function: no network, no model. Callers that
 * scraped a page pass its title/description/body in; everything else falls
 * back to the URL and whatever text the archive already had.
 */
export function extractFacts(rawUrl, meta = {}) {
  const title = String(meta.title || '').trim();
  const notes = String(meta.notes || '').trim();
  const content = String(meta.content || '').trim();
  const u = parseUrl(rawUrl);
  const host = u ? u.hostname.replace(/^www\./, '').toLowerCase() : '';
  const path = u ? u.pathname.toLowerCase() : '';
  const primary = `${title} ${notes}`.toLowerCase();
  const body = content.toLowerCase();
  const all = `${primary} ${body} ${rawUrl}`.toLowerCase();

  const repo = /(^|\.)(github|gitlab|codeberg|bitbucket)\.(com|org)$/.test(host)
    && (u?.pathname.split('/').filter(Boolean).length || 0) >= 2;
  const storeHost = /play\.google\.com$|apps\.apple\.com$/.test(host);
  const softwareHint = storeHost || repo
    || hit(all, '\\bapp\\b|\\bapps\\b|software|\\bclient\\b|installer|install|\\bapk\\b|\\bipa\\b|\\.exe|extension|plugin|addon|\\bgame\\b|emulator|\\btool\\b|utility|downloader|manager|converter|generator|\\bcli\\b');
  const platforms = detectPlatforms(host, path, primary, body);
  const ecosystems = detectEcosystems(host);
  const brands = detectBrands(host, primary, body, title);
  const software = softwareHint;

  const type = detectType({ host, primary, body, repo, ecosystems, platforms });
  const topicMatch = content.match(/^Topics:\s*([^\n]+)/i);
  const topicsLine = topicMatch ? topicMatch[1].toLowerCase() : '';

  // Contextual salience scoring: title & topics carry the highest weight,
  // notes carry medium weight, and body mentions only count when dominant.
  const scoreRules = (rules, cap) => {
    const scored = [];
    for (const [tag, src] of rules) {
      const titleHits = countHits(title.toLowerCase(), src);
      const topicHits = countHits(topicsLine, src);
      const notesHits = countHits(notes.toLowerCase(), src);
      const bodyHits = countHits(body, src);
      const score = (titleHits * 5) + (topicHits * 5) + (notesHits * 3) + (bodyHits >= 3 ? Math.min(bodyHits, 6) : 0);
      if (titleHits > 0 || topicHits > 0 || notesHits > 0 || bodyHits >= 3) {
        scored.push([tag, score]);
      }
    }
    scored.sort((a, b) => b[1] - a[1]);
    return scored.slice(0, cap).map(([tag]) => tag);
  };
  const ruleCategories = scoreRules(CATEGORY_RULES, 4);
  const languages = scoreRules(LANGUAGE_RULES, 3);
  const domainBans = new Set();
  if (host) {
    for (const part of host.split('.')) if (part.length >= 3) domainBans.add(normalizeTag(part));
  }
  if (path) {
    for (const seg of path.split('/').filter(Boolean).slice(0, 2)) {
      const norm = normalizeTag(seg.replace(/\.git$/i, ''));
      if (norm && norm.length >= 3 && !CANONICAL_TAGS.has(norm)) domainBans.add(norm);
    }
  }
  const contextualTerms = extractContextualTerms({ title, notes, content, banned: domainBans });
  const categories = [...new Set([...ruleCategories, ...contextualTerms])].slice(0, 5);
  const attributes = [];
  if (hit(all, 'self[- ]hosted|selfhosted|self hosted')) attributes.push('self-hosted');
  if (hit(primary, '\\boffline\\b')) attributes.push('offline');

  return {
    title,
    notes,
    host,
    path,
    primary,
    body,
    repo,
    software,
    type,
    platforms,
    ecosystems,
    brands,
    categories,
    contextualTerms,
    languages,
    attributes,
    telegram: brands.includes('telegram'),
    description: bestDescription({ notes, description: meta.description, content }),
  };
}

/**
 * Deterministic tags from extracted facts. Kept separate from `classifyTags`
 * so callers that already ran `extractFacts` (e.g. to share it with the model)
 * do not parse the page twice.
 */
export function tagsFromFacts(facts = {}) {
  const contextual = new Set(facts.contextualTerms || []);
  const tags = [];
  const add = (t) => {
    if (!t || (!CANONICAL_TAGS.has(t) && !contextual.has(t)) || tags.includes(t) || tags.length >= 8) return;
    tags.push(t);
  };

  for (const b of facts.brands || []) add(b);
  add(facts.type);
  for (const e of facts.ecosystems || []) add(e);
  // Platforms describe software, not an article that happens to mention one.
  if (facts.software) {
    for (const p of facts.platforms || []) add(p);
    if ((facts.platforms || []).length >= 2) add('multiplatform');
  }
  for (const a of facts.attributes || []) add(a);
  const redundant = new Set((facts.brands || []).map((b) => BRAND_CATEGORIES[b]).filter(Boolean));
  for (const c of facts.categories || []) if (!redundant.has(c)) add(c);
  for (const l of facts.languages || []) add(l);

  if (!tags.length) add('website');
  return tags;
}

/**
 * Deterministic tags from the facts. Returns { tags, facts }. The same URL and
 * meta always produce the same list, so /forcetags is stable without AI.
 */
export function classifyTags(rawUrl, meta = {}) {
  const facts = extractFacts(rawUrl, meta);
  return { tags: tagsFromFacts(facts), facts };
}

/**
 * Enforce the vocabulary. User-curated tags or contextual subject terms can be
 * allowed through with `vocabulary`, while junk, fluff, and domain/product names
 * are rejected. Returns { tags, rejected: [{ tag, reason }] }.
 */
export function validateTags(tags, { vocabulary = [], banned = [], allowedBrands = null, max = 8 } = {}) {
  const allowed = new Set(Array.from(vocabulary || []).map(normalizeTag).filter(Boolean));
  const bannedSet = new Set(Array.from(banned || []).map(normalizeTag).filter((t) => t && !allowed.has(t)));
  const brandSet = allowedBrands ? new Set([...allowedBrands].map(normalizeTag)) : null;
  const out = [];
  const rejected = [];
  const seen = new Set();
  for (const raw of Array.isArray(tags) ? tags : []) {
    const tag = normalizeTag(raw);
    if (!tag || tag.length < 2) { rejected.push({ tag, reason: 'empty' }); continue; }
    if (seen.has(tag)) { rejected.push({ tag, reason: 'duplicate' }); continue; }
    seen.add(tag);
    if (bannedSet.has(tag)) { rejected.push({ tag, reason: 'name' }); continue; }
    if (JUNK_TAGS.has(tag)) { rejected.push({ tag, reason: 'junk' }); continue; }
    if (GENERIC_REJECTS.has(tag)) { rejected.push({ tag, reason: 'generic' }); continue; }
    if (BRAND_SET.has(tag) && brandSet && !brandSet.has(tag)) { rejected.push({ tag, reason: 'brand' }); continue; }
    if (!CANONICAL_TAGS.has(tag) && !allowed.has(tag)) { rejected.push({ tag, reason: 'unknown' }); continue; }
    if (out.length >= max) { rejected.push({ tag, reason: 'limit' }); continue; }
    out.push(tag);
  }
  return { tags: out, rejected };
}

/** Prompt block: one closed list, grouped so the model understands the job. */
export const TAG_VOCAB_TEXT = [
  `Type: ${TYPE_TAGS.join(', ')}`,
  `Platform: ${PLATFORM_TAGS.join(', ')}`,
  `Ecosystem: ${ECOSYSTEM_TAGS.join(', ')}`,
  `Brand: ${BRAND_TAGS.join(', ')}`,
  `Topic: ${CATEGORY_TAGS.join(', ')}`,
  `Language: ${LANGUAGE_TAGS.join(', ')}`,
  `Attribute: ${ATTRIBUTE_TAGS.join(', ')}`,
].join('\n');
