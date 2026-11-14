/**
 * FMHY-inspired Wiki Taxonomy and Classification Engine.
 *
 * Categorizes links into hierarchical categories and subheadings modeled after
 * FreeMediaHeckYeah (fmhy.net), ensuring all database links are organized.
 */

export const DEFAULT_FMHY_CATEGORIES = [
  {
    id: 'privacy',
    title: 'Adblocking & Privacy',
    icon: '🛡️',
    description: 'Adblockers, VPNs, anti-tracking, privacy browsers, and security tools.',
    subheadings: [
      {
        id: 'privacy-adblock',
        title: 'Adblockers & Content Filters',
        description: 'Block ads, trackers, and malicious scripts across browsers and DNS.',
        tags: ['adblock', 'filter', 'dns', 'tracker', 'ad-free', 'pi-hole', 'ublock'],
        keywords: ['adblock', 'ublock', 'adguard', 'pihole', 'blocker', 'filter list', 'tracker', 'block ads']
      },
      {
        id: 'privacy-vpn',
        title: 'VPNs & Proxies',
        description: 'Virtual private networks, proxies, and censorship circumvention.',
        tags: ['vpn', 'proxy', 'tor', 'wireguard', 'v2ray', 'shadowsocks', 'cloudflare-warp'],
        keywords: ['vpn', 'proxy', 'wireguard', 'openvpn', 'socks5', 'shadowsocks', 'v2ray', 'tor browser', 'mullvad', 'protonvpn']
      },
      {
        id: 'privacy-sec',
        title: 'Security & Encryption',
        description: 'Password managers, 2FA, encrypted messaging, and system hardening.',
        tags: ['security', 'crypto', 'encryption', 'password', '2fa', 'antivirus', 'firewall'],
        keywords: ['security', 'password', 'bitwarden', 'keepass', 'encryption', 'gpg', 'pgp', 'authenticator', 'malware', 'antivirus', 'threat']
      }
    ]
  },
  {
    id: 'video',
    title: 'Video & Streaming',
    icon: '🎬',
    description: 'Free streaming sites, movies, TV series, anime, live TV, and video tools.',
    subheadings: [
      {
        id: 'video-streaming',
        title: 'Movies & TV Streaming',
        description: 'Watch movies, TV shows, and series online with no subscription.',
        tags: ['movie', 'video', 'streaming', 'netflix', 'hulu', 'series', 'film'],
        keywords: ['stream', 'watch', 'movie', 'cinema', 'soap2day', 'flix', 'fmovies', 'sflix', 'hurawatch', '123movies', 'cinematics']
      },
      {
        id: 'video-anime',
        title: 'Anime & Cartoons',
        description: 'Stream subbed and dubbed anime, donghua, and animated series.',
        tags: ['anime', 'manga', 'cartoon', 'animation', 'crunchyroll'],
        keywords: ['anime', 'aniwave', '9anime', 'gogoanime', 'nyaa', 'crunchyroll', 'otaku', 'donghua']
      },
      {
        id: 'video-downloaders',
        title: 'Video Downloaders & Converters',
        description: 'Download videos from YouTube, Twitter, TikTok, and web streams.',
        tags: ['youtube', 'ytdlp', 'yt-dlp', 'download', 'ffmpeg', 'converter', 'encoder'],
        keywords: ['yt-dlp', 'ytdl', 'youtube-dl', 'video download', 'cobalt', 'downloader', 'ffmpeg', 'handbrake', 'mp4', 'm3u8']
      },
      {
        id: 'video-players',
        title: 'Media Players & Encoders',
        description: 'Desktop and mobile video players with broad codec support.',
        tags: ['media-player', 'player', 'mpv', 'vlc', 'codec'],
        keywords: ['mpv', 'vlc', 'potplayer', 'kodi', 'jellyfin', 'plex', 'media player']
      },
      {
        id: 'video-tv',
        title: 'Live TV & IPTV',
        description: 'IPTV channels, m3u playlists, and worldwide live television.',
        tags: ['tv', 'iptv', 'radio', 'broadcast'],
        keywords: ['iptv', 'm3u', 'live tv', 'television', 'channel', 'stream live', 'epg']
      }
    ]
  },
  {
    id: 'audio',
    title: 'Audio & Music',
    icon: '🎵',
    description: 'Music streaming, lossless audio, FLAC downloaders, podcasts, and radio.',
    subheadings: [
      {
        id: 'audio-streaming',
        title: 'Music Streaming & Discovery',
        description: 'Web streaming clients, ad-free frontends, and personalized radio.',
        tags: ['music', 'spotify', 'audio', 'radio', 'soundcloud', 'deezer'],
        keywords: ['music', 'spotify', 'deezer', 'tidal', 'qobuz', 'soundcloud', 'bandcamp', 'song', 'listen', 'tuner']
      },
      {
        id: 'audio-rippers',
        title: 'Audio Downloaders & Rippers',
        description: 'Download high quality FLAC, MP3, and albums with metadata.',
        tags: ['mp3', 'flac', 'lossless', 'rip', 'audio-ripper'],
        keywords: ['flac', 'lossless', 'deemix', 'spowlo', 'music download', 'audio download', 'album rip', 'spotdl']
      },
      {
        id: 'audio-production',
        title: 'Audio Production & Tools',
        description: 'DAWs, synthesizers, audio editors, stem separators, and lyrics.',
        tags: ['daw', 'synth', 'lyrics', 'production', 'transcribe'],
        keywords: ['audacity', 'reaper', 'vocal remover', 'stem separation', 'daw', 'synthesizer', 'lyrics', 'transcribe']
      }
    ]
  },
  {
    id: 'gaming',
    title: 'Gaming & Emulation',
    icon: '🎮',
    description: 'Game archives, emulators, ROMs, mods, and cloud gaming utilities.',
    subheadings: [
      {
        id: 'gaming-emulation',
        title: 'Emulators & ROMs',
        description: 'Console emulators from retro systems to Switch, PS3, and Arcade.',
        tags: ['emulator', 'rom', 'retro', 'gba', 'nds', 'ps2', 'ps3', 'switch', 'yuzu', 'ryujinx'],
        keywords: ['emulator', 'rom', 'bios', 'retroarch', 'rpcs3', 'pcsx2', 'dolphin', 'yuzu', 'ryujinx', 'cemu', 'citra', 'duckstation']
      },
      {
        id: 'gaming-pc',
        title: 'PC Gaming & Repacks',
        description: 'Game stores, repacks, patches, and game compatibility trackers.',
        tags: ['game', 'gaming', 'steam', 'epic', 'gog', 'repack'],
        keywords: [
          'fitgirl', 'dodi', 'repack', 'steam', 'gog', 'steamunlocked', 'itch.io',
          'game download', 'crackwatch', 'game launcher', 'game library',
          'game manager', 'game downloader', 'pc game', 'pc games', 'pc gaming',
          'playnite', 'heroic games', 'lutris', 'launchbox', 'hydra launcher'
        ]
      },
      {
        id: 'gaming-tools',
        title: 'Modding & Game Tools',
        description: 'Mod managers, cheats, trainers, save editors, and translation patches.',
        tags: ['mod', 'modding', 'patch', 'trainer', 'cheat'],
        keywords: ['nexus mods', 'modorganizer', 'wemod', 'cheat engine', 'trainer', 'save editor', 'translation patch', 'curseforge']
      }
    ]
  },
  {
    id: 'reading',
    title: 'Reading & Books',
    icon: '📚',
    description: 'eBooks, audiobooks, comics, manga, research papers, and document readers.',
    subheadings: [
      {
        id: 'reading-books',
        title: 'eBooks & Audiobooks',
        description: 'Free EPUB, PDF, and MOBI books, library mirrors, and audiobooks.',
        tags: ['book', 'reading', 'epub', 'audiobook', 'novel', 'literature'],
        keywords: ['z-library', 'libgen', 'anna\'s archive', 'gutenberg', 'ebook', 'audiobook', 'open library', 'standard ebooks', 'mobilism']
      },
      {
        id: 'reading-manga',
        title: 'Comics, Manga & Manhwa',
        description: 'Read comics, graphic novels, manga, webtoons, and scanlations.',
        tags: ['manga', 'comic', 'manhwa', 'webtoon', 'scanlation'],
        keywords: ['mangadex', 'comic', 'manga', 'manhwa', 'webtoon', 'readcomiconline', 'tapas', 'tachiyomi', 'mihon']
      },
      {
        id: 'reading-academic',
        title: 'Academic Papers & Textbooks',
        description: 'Scientific journals, research papers, textbooks, and Sci-Hub mirrors.',
        tags: ['paper', 'arxiv', 'science', 'research', 'academic', 'textbook'],
        keywords: ['sci-hub', 'arxiv', 'researchgate', 'paper', 'journal', 'doi', 'scholar', 'textbook', 'jstor']
      }
    ]
  },
  {
    id: 'ai',
    title: 'AI & Machine Learning',
    icon: '🤖',
    description: 'LLM frontends, local models, image generation, coding assistants, and prompts.',
    subheadings: [
      {
        id: 'ai-chat',
        title: 'LLMs & Chat WebUIs',
        description: 'OpenAI, Claude, DeepSeek, Ollama, Open WebUI, and multi-model interfaces.',
        tags: ['ai', 'llm', 'chatgpt', 'openai', 'claude', 'deepseek', 'ollama', 'openrouter'],
        keywords: ['chatgpt', 'claude', 'deepseek', 'ollama', 'open webui', 'openrouter', 'lm studio', 'gemini', 'perplexity', 'copilot']
      },
      {
        id: 'ai-creative',
        title: 'Image & Creative Generation',
        description: 'Stable Diffusion, Midjourney alternatives, text-to-image, and voice cloning.',
        tags: ['diffusion', 'image-gen', 'sd', 'comfyui', 'voice', 'tts', 'stt'],
        keywords: ['stable diffusion', 'comfyui', 'midjourney', 'civitai', 'lora', 'voice clone', 'whisper', 'elevenlabs', 'text to image']
      },
      {
        id: 'ai-tools',
        title: 'AI Coding & Agent Frameworks',
        description: 'Cursor, Copilot alternatives, LangChain, MCP, and AI productivity tools.',
        tags: ['mcp', 'agent', 'rag', 'embedding', 'huggingface', 'kaggle'],
        keywords: ['cursor', 'copilot', 'agent', 'mcp', 'langchain', 'huggingface', 'rag', 'embedding', 'model weights', 'agentic']
      }
    ]
  },
  {
    id: 'development',
    title: 'Development & Coding',
    icon: '💻',
    description: 'Developer utilities, git forges, libraries, APIs, Docker, and frontend resources.',
    subheadings: [
      {
        id: 'dev-tools',
        title: 'Developer Tools & IDEs',
        description: 'Code editors, debuggers, regex testers, formatters, and terminal apps.',
        tags: ['developer', 'coding', 'cli', 'tool', 'ide', 'vscode', 'editor'],
        keywords: ['vscode', 'neovim', 'editor', 'debugger', 'regex', 'json format', 'formatter', 'terminal', 'devtools', 'code editor']
      },
      {
        id: 'dev-repos',
        title: 'Repositories & Forges',
        description: 'GitHub, GitLab, Codeberg, package managers, and open source projects.',
        tags: ['github', 'gitlab', 'codeberg', 'git', 'npm', 'pypi', 'crates', 'package'],
        keywords: ['github.com', 'gitlab.com', 'codeberg.org', 'npm', 'pypi', 'crates.io', 'repository', 'git repo']
      },
      {
        id: 'dev-languages',
        title: 'Languages & Frameworks',
        description: 'Python, Rust, TypeScript, Go, React, Vue, Svelte, and modern stacks.',
        tags: ['python', 'rust', 'javascript', 'typescript', 'go', 'framework', 'library', 'frontend', 'web-development'],
        keywords: ['python', 'rust', 'typescript', 'react', 'vue', 'nodejs', 'golang', 'framework', 'library', 'web dev']
      }
    ]
  },
  {
    id: 'tools',
    title: 'Tools & Utilities',
    icon: '🧰',
    description: 'System software, file managers, format converters, calculators, and automation.',
    subheadings: [
      {
        id: 'tools-system',
        title: 'System & OS Utilities',
        description: 'Task managers, benchmarking, cleanup, uninstallation, and hardware tools.',
        tags: ['software', 'utility', 'system', 'hardware', 'windows', 'linux', 'macos'],
        keywords: ['sysinternals', 'bleachbit', 'revo uninstaller', 'hwinfo', 'benchmark', 'task manager', 'driver', 'utility', 'threat detection']
      },
      {
        id: 'tools-files',
        title: 'File & Disk Management',
        description: 'File search (Everything), archiving (7-Zip), disk visualization, and sync.',
        tags: ['file-manager', 'disk', 'archive', 'zip', 'search', 'sync'],
        keywords: ['everything', '7-zip', 'peazip', 'windirstat', 'wiztree', 'file converter', 'pdf tool', 'bulk rename', 'unzip']
      },
      {
        id: 'tools-productivity',
        title: 'Productivity & Office',
        description: 'Markdown editors, note-taking, spreadsheets, PDF editors, and mind maps.',
        tags: ['productivity', 'notes', 'markdown', 'office', 'pdf', 'calc'],
        keywords: ['obsidian', 'notion', 'logseq', 'libreoffice', 'pdf editor', 'calculator', 'clipboard', 'todo', 'kanban']
      }
    ]
  },
  {
    id: 'downloads',
    title: 'Downloads & Torrents',
    icon: '📦',
    description: 'Torrent clients, trackers, direct downloads, Debrid services, and mirrors.',
    subheadings: [
      {
        id: 'downloads-torrents',
        title: 'Torrent Clients & Search',
        description: 'qBittorrent, search plugins, DHT indexers, and public/private trackers.',
        tags: ['torrent', 'p2p', 'magnet', 'qbittorrent', 'tracker'],
        keywords: ['torrent', 'qbittorrent', 'magnet', '1337x', 'rarbg', 'rutracker', 'tracker', 'p2p', 'dht']
      },
      {
        id: 'downloads-direct',
        title: 'Direct Download & Debrid',
        description: 'File hosters, JDownloader, Real-Debrid, multi-host downloaders.',
        tags: ['download', 'jdownloader', 'debrid', 'mirror', 'cloud'],
        keywords: ['jdownloader', 'real-debrid', 'alldebrid', 'megathread', 'rapidgator', '1fichier', 'ddl', 'direct download']
      },
      {
        id: 'downloads-archives',
        title: 'Web Archives & Preservations',
        description: 'Wayback Machine, Internet Archive, open directories, and software mirrors.',
        tags: ['archive', 'wayback', 'preservation', 'history'],
        keywords: ['archive.org', 'wayback', 'open directory', 'mirror', 'preservation', 'software archive']
      }
    ]
  },
  {
    id: 'android',
    title: 'Android & Mobile',
    icon: '📱',
    description: 'F-Droid apps, APK repositories, Revanced, rooting, custom ROMs, and mobile mods.',
    subheadings: [
      {
        id: 'android-apps',
        title: 'F-Droid & Open Source Mobile',
        description: 'Free and open source Android apps without Google tracking.',
        tags: ['android', 'fdroid', 'f-droid', 'apk', 'mobile'],
        keywords: ['f-droid', 'fdroid', 'apk', 'foss android', 'open source android', 'aurora store', 'obtainium', 'apkpure']
      },
      {
        id: 'android-revanced',
        title: 'Revanced & Patched Apps',
        description: 'Ad-free YouTube, Reddit, Twitter, and Spotify client patches.',
        tags: ['revanced', 'patch', 'ad-free', 'mod', 'root'],
        keywords: ['revanced', 'vanced', 'xmanager', 'patched apk', 'ad-free youtube', 'sponsorblock', 'microg']
      },
      {
        id: 'android-root',
        title: 'Rooting & Custom ROMs',
        description: 'Magisk, KernelSU, LineageOS, flashing tools, and custom recoveries.',
        tags: ['root', 'magisk', 'kernelsu', 'flashing', 'rom', 'recovery'],
        keywords: ['magisk', 'kernelsu', 'lineageos', 'twrp', 'fastboot', 'adb', 'custom rom', 'flashing', 'unlock bootloader']
      }
    ]
  },
  {
    id: 'internet',
    title: 'Internet & Networking',
    icon: '🌐',
    description: 'Browsers, DNS resolvers, homelab, self-hosting, remote access, and wire guards.',
    subheadings: [
      {
        id: 'net-browsers',
        title: 'Web Browsers & Extensions',
        description: 'Privacy-hardened browsers, forks, userscripts, and essential addons.',
        tags: ['browser', 'chrome', 'firefox', 'extension', 'plugin', 'web'],
        keywords: ['firefox', 'brave', 'librewolf', 'chromium', 'tampermonkey', 'violentmonkey', 'userscript', 'extension', 'chrome web store']
      },
      {
        id: 'net-homelab',
        title: 'Self-Hosting & Homelab',
        description: 'Docker containers, reverse proxies, dashboards, and home server apps.',
        tags: ['self-hosted', 'docker', 'server', 'proxy', 'caddy', 'nginx', 'traefik'],
        keywords: ['docker', 'self-hosted', 'homelab', 'reverse proxy', 'nginx', 'caddy', 'traefik', 'portainer', 'casaos', 'yunohost']
      },
      {
        id: 'net-dns',
        title: 'DNS & Network Tools',
        description: 'NextDNS, AdGuard DNS, speed tests, port checkers, and network diagnostics.',
        tags: ['dns', 'networking', 'ip', 'ping', 'speedtest'],
        keywords: ['nextdns', 'adguard dns', 'speedtest', 'traceroute', 'whois', 'port checker', 'dns resolver', 'ip address']
      }
    ]
  },
  {
    id: 'storage',
    title: 'Storage & Cloud',
    icon: '🗃️',
    description: 'Cloud storage, S3-compatible buckets, file sync, encrypted backup, and databases.',
    subheadings: [
      {
        id: 'storage-cloud',
        title: 'Cloud Drives & File Sync',
        description: 'Free cloud drives, Nextcloud, Rclone, Syncthing, and peer sync.',
        tags: ['storage', 'cloud', 'sync', 'backup', 'rclone', 'syncthing'],
        keywords: ['rclone', 'syncthing', 'nextcloud', 'mega', 'google drive', 'dropbox', 'pcloud', 'file sync', 'cloud drive']
      },
      {
        id: 'storage-db',
        title: 'Databases & Backups',
        description: 'PostgreSQL, SQLite, Redis, S3 tools, and automated backup managers.',
        tags: ['database', 'sql', 'postgres', 'sqlite', 'redis', 'backup', 's3'],
        keywords: ['postgres', 'sqlite', 'database', 'pg_dump', 's3 backup', 'restic', 'borgbackup', 'r2', 's3 bucket']
      }
    ]
  },
  {
    id: 'social',
    title: 'Communication & Social',
    icon: '💬',
    description: 'Chat clients, Telegram bots, Matrix, Discord alternatives, email, and social frontends.',
    subheadings: [
      {
        id: 'social-chat',
        title: 'Chat Clients & Bridges',
        description: 'Telegram, Signal, Matrix/Element, IRC, and decentralized protocols.',
        tags: ['messaging', 'social', 'telegram', 'discord', 'matrix', 'signal', 'bot'],
        keywords: ['telegram', 'signal', 'matrix', 'element', 'discord', 'revolt', 'xmpp', 'irc', 'bridge', 'chat client']
      },
      {
        id: 'social-email',
        title: 'Email & Temp Mail',
        description: 'Temporary mail, alias services (SimpleLogin), privacy email providers.',
        tags: ['email', 'temp-mail', 'privacy'],
        keywords: ['temp mail', 'disposable email', 'simplelogin', 'anonaddy', 'protonmail', 'tuta', 'mailbox', 'email alias']
      },
      {
        id: 'social-frontends',
        title: 'Alternative Frontends',
        description: 'Lightweight, ad-free frontends for Reddit, Twitter, YouTube, and TikTok.',
        tags: ['frontend', 'reddit', 'twitter', 'youtube', 'privacy'],
        keywords: ['libreddit', 'redlib', 'nitter', 'invidious', 'piped', 'proxitok', 'teddit', 'alternative frontend']
      }
    ]
  },
  {
    id: 'education',
    title: 'Learning & Education',
    icon: '💡',
    description: 'Free university courses, coding tutorials, interactive math, science, and guides.',
    subheadings: [
      {
        id: 'edu-tutorials',
        title: 'Courses & Interactive Tutorials',
        description: 'Free programming, computer science, and technical learning platforms.',
        tags: ['education', 'tutorial', 'course', 'learning', 'coding'],
        keywords: ['tutorial', 'course', 'learn', 'freecodecamp', 'coursera', 'edx', 'roadmap.sh', 'w3schools', 'academy']
      },
      {
        id: 'edu-reference',
        title: 'Reference & Documentation',
        description: 'Cheatsheets, developer reference, Wikipedia, and language documentation.',
        tags: ['documentation', 'reference', 'wikipedia', 'guide'],
        keywords: ['cheatsheet', 'devdocs', 'documentation', 'wikipedia', 'reference guide', 'manual', 'handbook']
      }
    ]
  },
  {
    id: 'misc',
    title: 'Miscellaneous & Archives',
    icon: '📁',
    description: 'Uncategorized links, backfilled archives, and general web discoveries.',
    subheadings: [
      {
        id: 'misc-backfill',
        title: 'Backfill & Unsorted Archives',
        description: 'Links synchronized from Telegram channels, historical imports, and bookmarks.',
        tags: ['backfill', 'notags', 'website'],
        keywords: []
      },
      {
        id: 'misc-general',
        title: 'General Discoveries & Sites',
        description: 'Web utilities, miscellaneous portals, and diverse links.',
        tags: [],
        keywords: []
      }
    ]
  }
];

/**
 * Classify a link record into a category and subheading using the provided taxonomy.
 */
export function classifyLink(link, taxonomy = DEFAULT_FMHY_CATEGORIES) {
  if (!link) {
    return { categoryId: 'misc', subheadingId: 'misc-general' };
  }

  let tags = link.tags || [];
  if (typeof tags === 'string') {
    try { tags = JSON.parse(tags); } catch (_) {
      tags = tags.split(/[\s,]+/).map(t => t.replace(/^#+/, '').trim()).filter(Boolean);
    }
  }
  const tagSet = new Set((Array.isArray(tags) ? tags : []).map(t => String(t).toLowerCase().replace(/^#+/, '').trim()));

  const titleLower = String(link.title || '').toLowerCase();
  const urlLower = String(link.url || '').toLowerCase();
  const notesLower = String(link.notes || '').toLowerCase();

  let bestCat = null;
  let bestSub = null;
  let bestScore = 0;

  for (const cat of taxonomy) {
    for (const sub of (cat.subheadings || [])) {
      let score = 0;

      // Primary context: title (+9), URL (+7), description/notes (+5)
      let kwScore = 0;
      if (Array.isArray(sub.keywords)) {
        for (const kw of sub.keywords) {
          const kwNorm = String(kw || '').toLowerCase();
          if (!kwNorm) continue;
          if (titleLower.includes(kwNorm)) kwScore += 12;
          if (urlLower.includes(kwNorm)) kwScore += 9;
          if (notesLower.includes(kwNorm)) kwScore += 6;
        }
      }

      // Secondary signal: tags (+2 each, ignore noisy ingest/generic tags).
      // Any contextual keyword hit gets a +20 tier boost so stray tags like
      // #cloud cannot override an explicit title/url/notes match.
      let tagScore = 0;
      if (Array.isArray(sub.tags)) {
        for (const t of sub.tags) {
          const tNorm = String(t || '').toLowerCase();
          if (
            tNorm !== 'backfill' &&
            tNorm !== 'website' &&
            tNorm !== 'notags' &&
            tNorm !== 'opensource' &&
            tNorm !== 'open-source' &&
            tagSet.has(tNorm)
          ) {
            tagScore += 2;
          }
        }
      }
      if (kwScore > 0) score += kwScore + 20 + tagScore;
      else score += tagScore;

      if (score > bestScore) {
        bestScore = score;
        bestCat = cat.id;
        bestSub = sub.id;
      }
    }
  }

  if (bestScore >= 5 && bestCat && bestSub) {
    return { categoryId: bestCat, subheadingId: bestSub };
  }

  // Fallback for untagged / generic backfill
  return { categoryId: 'misc', subheadingId: 'misc-backfill' };
}

/**
 * Ensure wiki_taxonomy table exists.
 */
export async function ensureWikiTaxonomyTable(env) {
  if (!env?.DB) return;
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS wiki_taxonomy (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      community_id TEXT,
      categories TEXT NOT NULL,
      updated_at BIGINT NOT NULL,
      updated_by TEXT
    )
  `).run();
}

/**
 * Retrieve active taxonomy for scope and community.
 */
export async function getWikiTaxonomy(env, scope = 'community', communityId = '') {
  try {
    await ensureWikiTaxonomyTable(env);
    const id = scope === 'personal' ? 'personal:god' : `community:${communityId || 'default'}`;
    const row = await env.DB.prepare('SELECT categories FROM wiki_taxonomy WHERE id = ?').bind(id).first();
    if (row?.categories) {
      const parsed = JSON.parse(row.categories);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (_) {}
  return DEFAULT_FMHY_CATEGORIES;
}

/**
 * Persist custom AI taxonomy for scope and community.
 */
export async function saveWikiTaxonomy(env, scope = 'community', communityId = '', categories = [], userId = 'admin') {
  await ensureWikiTaxonomyTable(env);
  const id = scope === 'personal' ? 'personal:god' : `community:${communityId || 'default'}`;
  await env.DB.prepare(
    'INSERT OR REPLACE INTO wiki_taxonomy (id, scope, community_id, categories, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, scope, communityId || null, JSON.stringify(categories), Date.now(), userId).run();
}
