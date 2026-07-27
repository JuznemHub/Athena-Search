/**
 * Fuzzy / flexible search + RAG retrieval for Athena brain.
 * Matches: ytdlp↔yt-dlp, "context engineering"↔lean-ctx, github paths, stems.
 */
(function () {
  function alnum(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function soft(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[_\-./\\+]+/g, ' ')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokens(s) {
    return soft(s).split(' ').filter(t => t.length > 0);
  }

  function ngrams(s, n = 3) {
    const a = alnum(s);
    if (a.length < n) return a.length ? [a] : [];
    const out = [];
    for (let i = 0; i < a.length - n + 1; i++) out.push(a.slice(i, i + n));
    return out;
  }

  /** Lightweight stems for matching (context→ctx, engineering→engin) */
  function stems(word) {
    const w = alnum(word);
    if (w.length < 3) return [w];
    const out = new Set([w]);
    // common short forms
    if (w.startsWith('context')) out.add('ctx');
    if (w === 'ctx' || w === 'context') {
      out.add('ctx');
      out.add('context');
    }
    // strip common suffixes
    for (const suf of ['ing', 'tion', 'tions', 'ment', 'ments', 'ness', 'ers', 'er', 'ed', 'ly', 'ies', 'es', 's']) {
      if (w.length > suf.length + 3 && w.endsWith(suf)) {
        out.add(w.slice(0, -suf.length));
      }
    }
    // prefixes of length 3-6 for partials
    for (let len = 3; len <= Math.min(6, w.length); len++) out.add(w.slice(0, len));
    return [...out];
  }

  // Domain synonym seeds (query term → extra search terms)
  const SYNONYMS = {
    context: ['ctx', 'lean-ctx', 'leanctx', 'prompt', 'rag'],
    engineering: ['engin', 'ctx', 'lean-ctx', 'tools'],
    youtube: ['yt-dlp', 'ytdlp', 'youtube-dl', 'video', 'download'],
    download: ['yt-dlp', 'ytdlp', 'dl', 'fetch'],
    video: ['yt-dlp', 'ytdlp', 'youtube'],
    bookmark: ['link', 'url', 'save'],
    ai: ['llm', 'model', 'gpt', 'claude'],
    telegram: ['tg', 'bot'],
    discord: ['bot'],
    github: ['repo', 'git', 'code'],
    lean: ['lean-ctx', 'leanctx', 'ctx'],
    ctx: ['context', 'lean-ctx', 'leanctx']
  };

  function expandQueryTerms(query) {
    const base = tokens(query);
    const extra = new Set();
    const ql = query.toLowerCase();
    for (const t of base) {
      const key = alnum(t);
      (SYNONYMS[key] || []).forEach(x => extra.add(x));
      stems(t).forEach(s => extra.add(s));
    }
    // phrase-level
    if (/context\s*eng|contexteng|ctx/.test(ql)) {
      ['lean-ctx', 'leanctx', 'ctx', 'context', 'prompt', 'rag'].forEach(x => extra.add(x));
    }
    if (/youtube|yt\b|video\s*down/.test(ql)) {
      ['yt-dlp', 'ytdlp', 'youtube-dl', 'download'].forEach(x => extra.add(x));
    }
    return { tokens: base, expanded: [...extra] };
  }

  function itemText(item) {
    return [
      item.title || '',
      item.url || '',
      item.notes || '',
      item.filename || '',
      item.content || '',
      Array.isArray(item.tags) ? item.tags.join(' ') : String(item.tags || '')
    ].join(' ');
  }

  function itemSegments(item) {
    const segs = [];
    const text = itemText(item);
    segs.push(...tokens(text));
    segs.push(alnum(text));
    try {
      if (item.url) {
        const u = new URL(item.url.startsWith('http') ? item.url : 'https://' + item.url);
        u.pathname.split('/').filter(Boolean).forEach(s => {
          segs.push(s);
          segs.push(alnum(s));
          // split camel/kebab: lean-ctx → lean, ctx
          soft(s).split(' ').forEach(p => segs.push(p));
        });
        segs.push(u.hostname.replace(/^www\./, ''));
      }
    } catch (_) {}
    return segs.filter(Boolean);
  }

  function getSearchData(item) {
    if (item.__sd) return item.__sd;
    const text = itemText(item);
    const segs = itemSegments(item);
    const sd = {
      text,
      textSoft: soft(text),
      textAlnum: alnum(text),
      segs,
      segsAlnum: segs.map(alnum),
      // Pre-built trigram index so large documents aren't rescanned on every
      // expanded-term pass during retrieval (this was the main slowness).
      ngramsSet: new Set(ngrams(text, 3))
    };
    item.__sd = sd;
    return sd;
  }

  function scoreItem(item, query) {
    const q = (query || '').trim();
    if (!q) return 1;

    const sd = getSearchData(item);
    const text = sd.text;
    const textSoft = sd.textSoft;
    const textAlnum = sd.textAlnum;
    const qSoft = soft(q);
    const qAlnum = alnum(q);
    const { tokens: qTokens, expanded } = expandQueryTerms(q);
    const segs = sd.segs;
    const segsAlnum = sd.segsAlnum;

    let score = 0;

    if (text.toLowerCase().includes(q.toLowerCase())) score += 50;
    if (textSoft.includes(qSoft)) score += 40;
    if (qAlnum.length >= 2 && textAlnum.includes(qAlnum)) score += 80;

    // each query token + stems
    let tokenHits = 0;
    for (const t of qTokens) {
      const stemSet = stems(t);
      let hit = false;
      for (const st of stemSet) {
        if (st.length < 2) continue;
        if (textAlnum.includes(st) || textSoft.includes(st)) {
          hit = true;
          score += st.length >= 4 ? 18 : 10;
          break;
        }
        // match against path segments (ctx in lean-ctx)
        if (segsAlnum.some(sa => sa === st || sa.includes(st) || st.includes(sa) && sa.length >= 3)) {
          hit = true;
          score += 22;
          break;
        }
      }
      if (hit) tokenHits += 1;
      else {
        // n-gram soft match
        const tg = ngrams(t, 3);
        const ig = sd.ngramsSet;
        let ng = 0;
        for (const g of tg) if (ig.has(g)) ng++;
        if (tg.length && ng / tg.length >= 0.45) {
          tokenHits += 0.5;
          score += 8;
        }
      }
    }
    if (qTokens.length && tokenHits >= Math.ceil(qTokens.length * 0.4)) score += 15;

    // expanded synonym terms
    for (const ex of expanded) {
      const ea = alnum(ex);
      if (ea.length < 2) continue;
      if (textAlnum.includes(ea) || segsAlnum.some(sa => sa.includes(ea) || ea.includes(sa))) {
        score += 28;
      }
    }

    // reverse: repo name parts inside query (lean-ctx → context via ctx stem already)
    for (const sa of segsAlnum) {
      if (sa.length >= 3 && qAlnum.includes(sa)) score += 20;
    }

    const titleAlnum = alnum(item.title || '');
    const urlAlnum = alnum(item.url || '');
    if (qAlnum.length >= 2) {
      if (titleAlnum.includes(qAlnum)) score += 25;
      if (urlAlnum.includes(qAlnum)) score += 30;
    }

    return score;
  }

  function searchCorpus(items, query, limit = 50) {
    const q = (query || '').trim();
    if (!q) return (items || []).slice(0, limit);

    const ranked = (items || [])
      .map(item => ({ item, score: scoreItem(item, q) }))
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score);

    return ranked.slice(0, limit).map(r => r.item);
  }

  /**
   * RAG retrieval: always try hard to find something; if weak, still return top corpus.
   *
   * opts.minScore  — minimum score to be "strong" (default 12).
   * opts.strict    — when true, do NOT fall back to weak / recent items; return
   *                  only items that actually matched.  Used for AI context so
   *                  irrelevant docs (Spotify, Google for a "piracy" question)
   *                  never pollute the prompt.
   */
  function retrieveForQuestion(question, corpus, limit = 12, opts = {}) {
    const list = corpus || [];
    if (!list.length) return [];

    const minScore = opts.minScore || 12;

    const ranked = list
      .map(item => ({ item, score: scoreItem(item, question) }))
      .sort((a, b) => b.score - a.score);

    const strong = ranked.filter(r => r.score >= minScore).map(r => r.item);
    const weak = ranked.filter(r => r.score > 0 && r.score < minScore).map(r => r.item);

    // expanded term searches
    const { expanded } = expandQueryTerms(question);
    const extra = [];
    for (const term of expanded) {
      for (const item of searchCorpus(list, term, 6)) {
        if (!strong.find(b => b.id === item.id) && !extra.find(e => e.id === item.id)) {
          extra.push(item);
        }
      }
    }

    let out = [];
    const push = (arr) => {
      for (const it of arr) {
        if (out.length >= limit) break;
        if (!out.find(x => x.id === it.id)) out.push(it);
      }
    };
    push(strong);
    push(extra);

    // In strict mode (AI context) we only send items that truly matched —
    // no dumping of unrelated recent items into the prompt.
    if (opts.strict) {
      return out.slice(0, limit);
    }

    push(weak);

    // CRITICAL: if still empty/low, send recent brain items so LLM isn't told "empty"
    if (out.length < Math.min(3, list.length)) {
      const recent = [...list].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      push(recent);
    }

    // always include highest-scoring even if score 0 was filtered — use full ranked
    if (out.length === 0) {
      push(ranked.map(r => r.item));
    }

    return out.slice(0, limit);
  }

  window.AthenaSearch = { searchCorpus, scoreItem, retrieveForQuestion, alnum, soft, expandQueryTerms };
})();
