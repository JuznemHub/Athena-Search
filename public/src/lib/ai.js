/**
 * Athena AI — RAG over markdown brain + OpenAI-compatible APIs via Worker proxy.
 */
(function () {
  const LS_KEY = 'athena_ai_config';

  const PRESETS = {
    openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', mode: 'openai', model: 'gpt-4o-mini' },
    openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', mode: 'openai', model: 'openrouter/free' },
    omniroute: { label: 'OmniRoute (self-hosted)', baseUrl: 'http://127.0.0.1:20128/v1', mode: 'openai', model: 'openrouter/free' },
    anthropic: { label: 'Anthropic', baseUrl: 'https://api.anthropic.com', mode: 'anthropic', model: 'claude-sonnet-4-20250514' },
    groq: { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', mode: 'openai', model: 'llama-3.3-70b-versatile' },
    nvidia: { label: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1', mode: 'openai', model: 'meta/llama-3.1-8b-instruct' },
    deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', mode: 'openai', model: 'deepseek-v4-flash' },
    opencode_go: {
      label: 'OpenCode Zen Go',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      mode: 'openai',
      model: 'deepseek-v4-flash'
    },
    opencode_zen: {
      label: 'OpenCode Zen',
      baseUrl: 'https://opencode.ai/zen/v1',
      mode: 'openai',
      model: 'deepseek-v4-flash'
    },
    cohere_command: {
      label: 'Cohere Command',
      baseUrl: 'https://api.cohere.ai/compatibility/v1',
      mode: 'openai',
      model: 'command-r-plus'
    },
    custom: { label: 'Custom (OpenAI-compatible)', baseUrl: '', mode: 'openai', model: '' }
  };

  function loadConfig() {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {};
    } catch (_) {
      return {};
    }
  }

  function saveConfig(cfg) {
    // codeql[js/clear-text-storage-of-sensitive-data] -- GOD's API key stored client-side for UX, server encrypts at rest (enc:v1: AES-GCM under STORAGE_KEY), 30-day TTL, user consent via Save action
    localStorage.setItem(LS_KEY, JSON.stringify(cfg));
  }

  function cleanBaseUrl(baseUrl) {
    let root = String(baseUrl || '').trim().replace(/^['"]|['"]$/g, '');
    root = root.replace(/[.,;]+$/g, '').replace(/\/+$/g, '');
    root = root.replace(/\/chat\/completions$/i, '').replace(/\/messages$/i, '').replace(/\/(?:api\/)?models$/i, '');
    return root;
  }

  function normalizeModelId(model, baseUrl) {
    let m = String(model || '').trim().replace(/^['"]|['"]$/g, '');
    if (/opencode\.ai/i.test(baseUrl || '') || /^opencode/i.test(m)) {
      m = m.replace(/^opencode-go\//i, '').replace(/^opencode\//i, '');
    }
    if (/[A-Z\s]/.test(m)) {
      m = m.toLowerCase().replace(/[\s_]+/g, '-').replace(new RegExp('[^a-z0-9/.-]', 'g'), '');
      m = m.replace(/-+/g, '-').replace(/^-|-$/g, '');
    } else {
      m = m.trim().replace(/-+/g, '-');
    }
    return m;
  }

  function isSteroidEnabled() {
    return !!window.__athenaSteroid;
  }

  const AI_REMOTE_LIMIT = 24;
  const AI_CONTEXT_MAX_CHARS = 120000;
  const AI_DOC_MAX_CHARS = 20000;

  function clipAiText(value, maxChars = AI_DOC_MAX_CHARS) {
    const text = String(value || '');
    if (text.length <= maxChars) return text;
    const marker = '\n[… content shortened for context …]\n';
    const side = Math.max(1, Math.floor((maxChars - marker.length) / 2));
    return `${text.slice(0, side)}${marker}${text.slice(-side)}`;
  }

  function compactAiContext(sections, maxChars = AI_CONTEXT_MAX_CHARS) {
    const available = Math.max(0, Number(maxChars) || AI_CONTEXT_MAX_CHARS);
    const out = [];
    let used = 0;
    for (const section of sections || []) {
      const value = String(section || '');
      if (!value || used >= available) break;
      const separator = out.length ? '\n\n' : '';
      const remaining = available - used - separator.length;
      if (remaining <= 0) break;
      out.push(separator + (value.length > remaining ? clipAiText(value, remaining) : value));
      used += separator.length + Math.min(value.length, remaining);
    }
    return out.join('');
  }

  function formatDoc(item, i) {
    const tags = Array.isArray(item.tags) ? item.tags.join(', ') : (item.tags || '');
    const notes = item.type === 'document' || item.isDocument ? '' : clipAiText(item.notes || '', 6000);
    const content = clipAiText(item.content || '', AI_DOC_MAX_CHARS);
    return [
      `[#${i + 1}]`,
      `Title: ${item.title || 'Untitled'}`,
      item.filename ? `Document: ${item.filename}` : null,
      item.mimeType ? `Type: ${item.mimeType}` : null,
      item.url ? `URL: ${item.url}` : (item.filename ? null : 'URL: (local note)'),
      tags ? `Tags: ${tags}` : null,
      notes ? `Notes: ${notes}` : null,
      content ? `Content:\n${content}` : null
    ].filter(Boolean).join('\n');
  }

  function buildSystemPrompt() {
    return `You are Athena, a second-brain assistant. You ONLY use BRAIN CONTEXT (saved links, notes, uploaded documents).

CRITICAL GROUNDING RULES - VIOLATION IS A FAILURE:
1. NEVER invent facts, URLs, titles, or explanations not present in BRAIN CONTEXT.
2. If BRAIN CONTEXT says "no relevant matches were retrieved" or "truly empty" or lists 0 items relevant to the question, you MUST output EXACTLY: "You have no saved link on this in your brain" and nothing else. No extra sentences, no apologies, no general knowledge.
3. If BRAIN CONTEXT lists items but they contain NO Notes/Content (only Title/URL/Tags), the answer is THIN. In thin case, you MUST output ONLY: "Found saved link: <Title> - <URL> (no description was saved, open the link for details) [#n]" — do NOT elaborate, do NOT invent what the site does.
4. If BRAIN CONTEXT lists items with Notes/Content, you MUST cite them as [#n] and base your entire answer ONLY on those items. List their titles and URLs and summarize ONLY what is in Notes/Content.
5. NEVER say the brain is empty if BRAIN CONTEXT lists any items — use them, even if thin.
6. By default give concise, direct answers. When user says "in detail", "detailed", "explain", be thorough but still only from BRAIN CONTEXT.
7. Answer DIRECTLY. Never include "Thinking", numbered analysis steps, or meta-commentary. Start immediately with answer.
8. When an uploaded DOCUMENT answers the question, read its relevant sections and present them clearly. Cite as [#n].
9. Cite only source IDs that appear in BRAIN CONTEXT.
10. BRAIN CONTEXT is a retrieved subset. If user asks for more, use every relevant retrieved item and state that answer is limited to retrieved matches.
11. Use clean Markdown only when useful. No Thinking section.
12. If you cannot cite at least one [#n] from BRAIN CONTEXT, you have failed grounding - output "You have no saved link on this in your brain" instead of hallucinating.`;
  }

  function buildContextMessage(docs, corpusSize, maxChars = null) {
    if (!docs.length) {
      return corpusSize
        ? `BRAIN has ${corpusSize} saved item(s), but no relevant matches were retrieved for this question.

INSTRUCTION: No relevant matches. You MUST output exactly "You have no saved link on this in your brain" and nothing else. Do NOT invent TokenRouter, blockchain, or any general knowledge. If you output anything else, you have failed.`
        : `BRAIN CONTEXT: (truly empty — 0 saved items)

INSTRUCTION: Brain is empty. You MUST output exactly "You have no saved link on this in your brain" and nothing else.`;
    }
    const prefix = `BRAIN has ${corpusSize} saved item(s). Retrieved items:\n\n`;
    const sections = docs.map((d, i) => {
      return formatDoc(d, i);
    }).filter(Boolean);
    const full = sections.join('\n\n');
    const budget = Number.isFinite(maxChars) ? maxChars : AI_CONTEXT_MAX_CHARS;
    if (full.length + prefix.length <= budget) {
      return prefix + full;
    }
    const available = Math.max(0, budget - prefix.length);
    const compact = [];
    let used = 0;
    for (const section of sections) {
      if (used >= available) break;
      const separator = compact.length ? '\n\n' : '';
      const remaining = available - used - separator.length;
      if (remaining <= 0) break;
      compact.push(separator + (section.length > remaining
        ? `${section.slice(0, remaining)}\n[content shortened for provider context]`
        : section));
      used += separator.length + Math.min(section.length, remaining);
    }
    return prefix + compact.join('');
  }


    function isProviderContextError(error) {
    return /context length|context window|maximum context|too many tokens|prompt is too long|request too large|input.{0,20}long/i
      .test(String(error?.message || error || ''));
  }

  function normalizeRemoteDoc(row) {
    let tags = row.tags || [];
    if (typeof tags === 'string') {
      try { tags = JSON.parse(tags); } catch (_) { tags = tags.split(',').map(t => t.trim()).filter(Boolean); }
    }
    return {
      ...row,
      tags: Array.isArray(tags) ? tags : [],
      notes: clipAiText(row.notes || '', 6000),
      content: clipAiText(row.content || '', AI_DOC_MAX_CHARS),
      createdAt: row.createdAt || row.created_at || 0,
      imageUrl: row.imageUrl || row.image_url || '',
      siteName: row.siteName || row.site_name || '',
      addedBy: row.addedBy || row.added_by_name || row.added_by || ''
    };
  }

  async function retrieveRemoteDocs(question, conversationHistory) {
    const context = window.athenaSearchContext?.() || {};
    const apiBase = window.getAthenaApiBase?.() || window.location.origin;
    const token = window.getAthenaSessionToken?.() || localStorage.getItem('athena_session');
    const prior = (conversationHistory || [])
      .filter(message => message.role === 'user')
      .map(message => String(message.content || '').slice(0, 200))
      .slice(-2);
    const currentQuestion = String(question || '').slice(0, 500);
    const currentTerms = window.AthenaSearch?.expandQueryTerms?.(currentQuestion)?.tokens || [];
    let retrievalQuestion = (currentTerms.length ? [currentQuestion] : [...prior, currentQuestion])
      .filter(Boolean).join(' ').slice(0, 500);
    if (!retrievalQuestion) retrievalQuestion = String(question || '').slice(0, 500);
    const docs = new Map();
    let total = 0;
    const safeQ = String(retrievalQuestion).slice(0, 500);
    const params = new URLSearchParams({
      q: safeQ,
      scope: context.scope || 'personal',
      limit: String(AI_REMOTE_LIMIT),
      purpose: 'ai'
    });
    if (context.scope === 'community' && context.communityId) params.set('community_id', context.communityId);
    let engine = 'postgres';
    try {
      const res = await fetch(`${apiBase}/api/links/search?${params}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.links)) {
        total = Number(data.total || 0);
        engine = data.retrieval_engine || engine;
        for (const row of data.links) {
          const doc = normalizeRemoteDoc(row);
          if (doc.id && !docs.has(doc.id)) docs.set(doc.id, doc);
        }
      }
    } catch (_) {}
    return { docs: [...docs.values()], total: total || docs.size, engine: docs.size ? engine : 'browser-local' };
  }

  function answerLocal(question, corpus, corpusSize = (corpus || []).length) {
    const retrieve = window.AthenaSearch?.retrieveForQuestion || ((q, c) => c);
    const list = corpus || [];
    const limit = isSteroidEnabled() ? list.length : 8;
    // Local fallback must be as strict as the LLM retrieval path. Otherwise a
    // provider 502 turns weak/generic matches into the visible answer.
    const docs = retrieve(question, list, limit, { minScore: 18, strict: true });
    if (!docs.length) {
      return {
        answer: corpusSize
          ? 'No saved items matched that question in the current retrieval pass.'
          : 'Your brain has no saved notes/links yet. Dump some first.',
        sources: [],
        results: []
      };
    }
    const display = docs.slice(0, 8);
    const lines = display.map((d, i) => {
      const label = d.title || d.url || 'Note';
      return `${i + 1}. **${label}**${d.url ? ` — ${d.url}` : ''}`;
    });
    return {
      answer: `Closest matches in your brain:\n\n${lines.join('\n\n')}`,
      sources: display,
      results: docs
    };
  }

  function formatAiFallbackMessage(error) {
    const status = Number(error?.details?.status || error?.status || 0);
    if (status >= 500) return 'AI provider is temporarily unavailable; showing relevant saved matches.';
    if (status === 401 || status === 403) return 'AI provider rejected the request; showing relevant saved matches.';
    if (status === 429) return 'AI provider is rate-limited; showing relevant saved matches.';
    return 'AI is unavailable; showing relevant saved matches.';
  }

  function isGroundedAiAnswer(text, docs) {
    const answer = String(text || '');
    // Compare hosts+paths, ignoring scheme, trailing slashes and punctuation —
    // models drop the trailing "/" or re-case the host, which is not hallucination.
    const normalizeUrl = url => {
      try {
        const u = new URL(String(url || '').replace(/[),.;!?'"\s]+$/g, ''));
        return `${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`;
      } catch (_) { return String(url || '').toLowerCase(); }
    };
    const knownUrls = new Set((docs || []).map(doc => normalizeUrl(doc.url)));
    const urls = answer.match(/https?:\/\/[^\s<>()[\]{}"']+/gi) || [];
    // Hard hallucination signal: a URL that is not in the retrieved set.
    if (!urls.every(url => knownUrls.has(normalizeUrl(url)))) return false;
    // Uncited summaries are still grounded when every URL is known; do not
    // discard a completed streamed answer over missing [#n] markers.
    return true;
  }

  async function callViaProxy({ baseUrl, apiKey, model, mode, system, user, messages, onDelta, onThinking }) {
    // A same-origin login has no bearer token — the HttpOnly session cookie is
    // sent by the browser instead. Only a cross-origin backend needs the header.
    const token = window.getAthenaSessionToken?.() || localStorage.getItem('athena_session');

    const apiBase = window.getAthenaApiBase?.() || window.location.origin;
    const res = await fetch(`${apiBase}/api/ai/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({
        baseUrl: cleanBaseUrl(baseUrl),
        apiKey,
        model: normalizeModelId(model, baseUrl),
        mode: mode || 'openai',
        ...(messages ? { messages } : { system, user }),
        max_tokens: 3000,
        temperature: 0.2,
        stream: true
      })
    });

    const ct = res.headers.get('content-type') || '';
    if (!res.ok && !ct.includes('text/event-stream')) {
      const data = await res.json().catch(() => ({}));
      const providerError = typeof data.error === 'string' ? data.error : data.error?.message;
      const err = new Error(providerError || `AI proxy failed (${res.status})`);
      err.details = { status: data.status || res.status, model: data.model || '', endpoint: data.endpoint || '' };
      throw err;
    }
    if (!res.ok) throw new Error(`AI proxy failed (${res.status})`);
    if (ct.includes('text/event-stream')) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let full = '';
      let thinkingBuf = '';
      let stalled = false;
      const STALL_MS = 60000;
      let lastByte = Date.now();
      const stallTimer = setInterval(() => {
        if (Date.now() - lastByte > STALL_MS) {
          stalled = true;
          clearInterval(stallTimer);
          reader.cancel().catch(() => {});
        }
      }, 2000);
      try {
        while (true) {
          const r = await reader.read();
          if (r.done) break;
          if (r.value && r.value.length) lastByte = Date.now();
          buf += decoder.decode(r.value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            let j;
            try { j = JSON.parse(payload); } catch (_) { continue; }
            if (j.error) {
              const message = typeof j.error === 'string' ? j.error : j.error.message || j.error.type || 'AI stream error';
              throw new Error(message);
            }
            if (j.delta) {
              full += j.delta;
              if (onDelta) onDelta(j.delta, full);
            }
            if (j.thinking) {
              thinkingBuf += j.thinking;
              if (onThinking) onThinking(j.thinking, thinkingBuf);
            }
          }
        }
        if (buf.trim().startsWith('data:')) {
          const payload = buf.trim().slice(5).trim();
          if (payload && payload !== '[DONE]') {
            try {
              const j = JSON.parse(payload);
              if (j.error) throw new Error(typeof j.error === 'string' ? j.error : j.error.message || 'AI stream error');
              if (j.delta) {
                full += j.delta;
                if (onDelta) onDelta(j.delta, full);
              }
            } catch (_) {}
          }
        }
      } finally {
        clearInterval(stallTimer);
      }
      if (!full && !thinkingBuf) {
        if (stalled) throw new Error('AI provider stalled (no data for 60s) — try again or check provider status');
        throw new Error('Empty response from AI provider');
      }
      return { text: full, thinking: thinkingBuf };
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      const providerError = typeof data.error === 'string' ? data.error : data.error?.message;
      const bits = [providerError || `AI proxy failed (${res.status})`];
      if (data.endpoint) bits.push(`endpoint: ${data.endpoint}`);
      if (data.model) bits.push(`model: ${data.model}`);
      throw new Error(bits.join(' · '));
    }
    return { text: data.content || '', thinking: data.thinking || '' };
  }

  async function answerFromBrain(question, corpus, onDelta, conversationHistory, onThinking) {
    const q = (question || '').trim();
    const cfg = loadConfig();
    const list = corpus || [];
    const history = conversationHistory && conversationHistory.length
      ? conversationHistory.map(message => ({
        role: message.role,
        content: String(message.content || '')
      }))
      : [{ role: 'user', content: q }];
    const retrieve = window.AthenaSearch?.retrieveForQuestion;
    const retrievalQuestion = history.filter(message => message.role === 'user').map(message => message.content).join(' ');
    const localLimit = isSteroidEnabled() ? list.length : 12;
    const localDocs = retrieve ? retrieve(retrievalQuestion || q, list, localLimit, { minScore: 18, strict: true }) : list;
    const remote = await retrieveRemoteDocs(q, history);
    const merged = new Map();
    // The server retrieval is authoritative: it searches the complete
    // PostgreSQL scope through Meilisearch/SQL. Browser-local rows are only a
    // network fallback, never extra context that can pollute the prompt.
    const retrievalDocs = remote.docs.length ? remote.docs : localDocs;
    for (const doc of retrievalDocs) merged.set(doc.id || doc.url || `retrieved-${merged.size}`, doc);
    const docs = [...merged.values()];
    const corpusSize = Math.max(list.length, remote.total || 0);

    // HARD FAIL-SAFE: If no docs retrieved for this question, do NOT call LLM - it will hallucinate.
    // Return the canonical "no saved link" message directly.
    if (!docs.length) {
      return {
        answer: corpusSize
          ? 'You have no saved link on this in your brain'
          : 'Your brain has no saved notes/links yet. Dump some first.',
        sources: [],
        results: [],
        mode: 'local',
        thinking: ''
      };
    }

        // THIN-DOCS GUARD: If retrieved docs have no grounded content for the
    // query-relevant subset, do NOT call the model and let it invent details.
    const expandedQuery = window.AthenaSearch?.expandQueryTerms?.(q) || { tokens: [], expanded: [] };
    const coreTerms = [...(expandedQuery.tokens || []), ...(expandedQuery.expanded || [])]
      .map(term => String(term).toLowerCase().replace(/[^a-z0-9]/g, ''))
      .filter((term, index, all) => term.length >= 3 && all.indexOf(term) === index)
      .slice(0, 32);
    function isRelevantDoc(d, terms) {
      if (!terms.length) return true;
      const bag = [d.title, d.url, d.filename, d.notes, d.content, Array.isArray(d.tags) ? d.tags.join(' ') : d.tags].join(' ').toLowerCase();
      const bagAl = bag.replace(/[^a-z0-9]/g, '');
      return terms.some(term => bag.includes(term) || bagAl.includes(term));
    }
    const relevantDocs = coreTerms.length ? docs.filter(d => isRelevantDoc(d, coreTerms)) : docs;
    const docsToCheck = relevantDocs;
    if (relevantDocs.length === 0) {
      return {
        answer: 'You have no saved link on this in your brain',
        sources: [],
        results: [],
        mode: 'local',
        thinking: ''
      };
    }
    const hasGroundedContent = docsToCheck.some(d => {
      const notes = String(d.notes || '').trim();
      const content = String(d.content || '').trim();
      const combined = notes + content;
      return combined.length >= 30;
    });
    if (!hasGroundedContent) {
      const lines = docsToCheck.slice(0, 5).map((d, i) => {
        const label = d.title || d.url || 'Note';
        const url = d.url ? ` - ${d.url}` : '';
        const tags = Array.isArray(d.tags) && d.tags.length ? ` (tags: ${d.tags.join(', ')})` : '';
        const origIdx = docs.indexOf(d);
        return `${i + 1}. **${label}**${url}${tags} [#${origIdx + 1}]`;
      });
      return {
        answer: `Found ${docsToCheck.length} saved link(s) for this query but no description was saved. Open the link for details:\n\n${lines.join('\n\n')}`,
        sources: docsToCheck.slice(0, 8),
        results: docsToCheck,
        mode: 'local',
        thinking: ''
      };
    }

    const hasLocalKey = !!(cfg.apiKey && cfg.baseUrl && cfg.model);
    const serverConfigured = await instanceAiConfigured();
    const isGod = window.athenaIsGod?.() ?? false;
    const sendOwn = isGod && hasLocalKey;

    if (!hasLocalKey && !serverConfigured) {
      const local = answerLocal(q, docs, corpusSize);
      const hint = isGod
        ? 'No AI credentials configured — GOD: Settings → AI → Save API key'
        : 'No instance AI credentials — GOD must configure in Settings → AI';
      return { ...local, mode: 'local', thinking: '', error: hint };
    }

    if (!isGod && !serverConfigured) {
      const local = answerLocal(q, docs, corpusSize);
      return {
        ...local,
        mode: 'local',
        thinking: '',
        error: 'Instance AI not configured — GOD rank must save credentials in Settings → AI (server has no key, possibly decryption failed or not synced)'
      };
    }

    if (isGod && !hasLocalKey && !serverConfigured) {
      const local = answerLocal(q, docs, corpusSize);
      return { ...local, mode: 'local', thinking: '', error: 'GOD: No local key in browser and no instance key on server — save in Settings → AI' };
    }

    try {
      let result;
      let contextLimit = null;
      for (;;) {
        const system = buildSystemPrompt() + '\n\n' + buildContextMessage(docs, corpusSize, contextLimit);
        try {
          result = await callViaProxy({
            baseUrl: sendOwn ? cfg.baseUrl : '',
            apiKey: sendOwn ? cfg.apiKey : '',
            model: sendOwn ? normalizeModelId(cfg.model, cfg.baseUrl) : '',
            mode: sendOwn ? (cfg.mode || 'openai') : '',
            messages: [{ role: 'system', content: system }, ...history],
            onDelta,
            onThinking
          });
          break;
        } catch (err) {
          if (!isProviderContextError(err) || !docs.length) throw err;
          const currentSize = buildContextMessage(docs, corpusSize, contextLimit).length;
          const nextLimit = Math.floor(currentSize * 0.6);
          if (nextLimit < 1000 || nextLimit >= currentSize) throw err;
          contextLimit = nextLimit;
        }
      }
      const text = result.text || '';
      const thinking = result.thinking || '';
      let cleaned = text;
      if (/^Thinking\b/i.test(text)) {
        const blocks = text.split(/\n{2,}/);
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i].trim();
          if (b && !/^Thinking\b/i.test(b) && !/^\d+\.\s/.test(b) && !/^\*\s/.test(b) && b.length > 20) {
            cleaned = b;
            break;
          }
        }
      }
      if (!isGroundedAiAnswer(cleaned, docs)) {
        const local = answerLocal(q, docs, corpusSize);
        return {
          ...local,
          mode: 'local',
          thinking: '',
          error: 'AI response was not grounded in the retrieved PostgreSQL matches; showing saved matches.'
        };
      }
      const displaySources = docs.slice(0, 8);
      return {
        answer: cleaned || text || 'Empty response from model.',
        thinking,
        sources: displaySources,
        results: docs,
        mode: 'llm',
        retrievalEngine: remote.engine
      };
    } catch (err) {
      const local = answerLocal(q, docs, corpusSize);
      return { ...local, mode: 'local', thinking: '', error: formatAiFallbackMessage(err), errorDetails: err.details || null };
    }
  }

  /** Does the server hold usable AI credentials? Cached for the page session. */
  let _serverCfg = null;
  let _serverCfgDetails = null;
  async function instanceAiConfigured() {
    if (_serverCfg === true) return true;
    try {
      const token = window.getAthenaSessionToken?.() || localStorage.getItem('athena_session');
      const apiBase = window.getAthenaApiBase?.() || window.location.origin;
      const res = await fetch(`${apiBase}/api/ai/config?v=1.0.41`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: 'no-store'
      });
      const data = await res.json().catch(() => ({}));
      _serverCfgDetails = data;
      _serverCfg = !!(data && data.hasKey);
      if (_serverCfg) return true;
      return false;
    } catch (_) {
      return false;
    }
  }

  function getLastServerAiConfig() {
    return _serverCfgDetails;
  }

  window.AthenaAI = {
    answerFromBrain,
    answerLocal,
    loadConfig,
    saveConfig,
    PRESETS,
    normalizeModelId,
    instanceAiConfigured,
    getLastServerAiConfig,
    formatAiFallbackMessage,
    isGroundedAiAnswer,
    compactAiContext
  };
})();
