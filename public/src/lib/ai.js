/**
 * Athena AI — RAG over markdown brain + OpenAI-compatible APIs via Worker proxy.
 */
(function () {
  const LS_KEY = 'athena_ai_config';

  const PRESETS = {
    openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', mode: 'openai', model: 'gpt-4o-mini' },
    openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', mode: 'openai', model: 'openai/gpt-4o-mini' },
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
    localStorage.setItem(LS_KEY, JSON.stringify(cfg));
  }

  function cleanBaseUrl(baseUrl) {
    let root = String(baseUrl || '').trim().replace(/^['"]|['"]$/g, '');
    root = root.replace(/[.,;]+$/g, '').replace(/\/+$/g, '');
    root = root.replace(/\/chat\/completions$/i, '').replace(/\/messages$/i, '');
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

  function formatDoc(item, i) {
    const tags = Array.isArray(item.tags) ? item.tags.join(', ') : (item.tags || '');
    const notes = item.notes || '';
    const content = item.content || '';
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
    return `You are Athena, a second-brain assistant. You ONLY use BRAIN CONTEXT below (the user's saved links, notes, and uploaded documents).

Rules:
1. NEVER say the brain is empty if BRAIN CONTEXT lists any items — use them.
2. By default give concise, direct answers. When the user says "in detail", "detailed", "explain", or asks for more depth, be thorough and comprehensive.
3. Answer DIRECTLY. NEVER include "Thinking", numbered analysis steps, evaluation of items, or meta-commentary about your reasoning. Start immediately with the answer.
4. When an uploaded DOCUMENT answers the question, read its relevant sections and present them clearly. Cite as [#n].
5. MANDATORY: Base your entire answer on the saved URLs/links in BRAIN CONTEXT. If the question is about a topic and BRAIN CONTEXT contains matching saved links, list THOSE links first with their titles and cite as [#n]. Do NOT fall back to general knowledge or invent websites that are not in BRAIN CONTEXT — only use what is saved in the user's brain.
6. Stay strictly grounded in BRAIN CONTEXT; never invent facts, URLs, titles, or websites not present in it. If BRAIN CONTEXT has no matching link for the topic, say "You have no saved link on this in your brain" instead of listing general internet sites.
7. Cite only source IDs that appear in BRAIN CONTEXT. Never invent URLs, titles, tags, or facts.
8. BRAIN CONTEXT is a retrieved subset. If the user asks for more, use every relevant retrieved item and state that the answer is limited to retrieved matches; never claim only five exist unless the context says the total is five.
9. Use clean Markdown: headings, bullets, and tables only when useful. Do not output a Thinking section or raw pipe tables without a header.
10. The user may ask follow-up questions. Use the conversation history to understand context. If they say "tell me more" or "which sections", refer back to the documents discussed.`;
  }

  function buildContextMessage(docs, corpusSize, maxChars = null) {
    if (!docs.length) {
      return corpusSize
        ? `BRAIN has ${corpusSize} saved item(s), but no relevant matches were retrieved for this question.`
        : 'BRAIN CONTEXT: (truly empty — 0 saved items)';
    }
    const prefix = `BRAIN has ${corpusSize} saved item(s). Retrieved items:\n\n`;
    const sections = docs.map((d, i) => {
      return formatDoc(d, i);
    }).filter(Boolean);
    const full = sections.join('\n\n');
    if (!Number.isFinite(maxChars) || full.length + prefix.length <= maxChars) {
      return prefix + full;
    }
    const available = Math.max(0, maxChars - prefix.length);
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
      .map(message => String(message.content || ''));
    const retrievalQuestion = [...prior, question].filter(Boolean).join(' ');
    const expanded = window.AthenaSearch?.expandQueryTerms?.(retrievalQuestion)?.expanded || [];
    const queries = [...new Set([retrievalQuestion, ...expanded])].filter(Boolean);
    const docs = new Map();
    let total = 0;
    for (const q of queries) {
      const params = new URLSearchParams({ q, scope: context.scope || 'personal', limit: isSteroidEnabled() ? 'all' : '50' });
      if (context.scope === 'community' && context.communityId) params.set('community_id', context.communityId);
      try {
        const res = await fetch(`${apiBase}/api/links/search?${params}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {}
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !Array.isArray(data.links)) continue;
        total = Math.max(total, Number(data.total || 0));
        for (const row of data.links) {
          const doc = normalizeRemoteDoc(row);
          if (doc.id && !docs.has(doc.id)) docs.set(doc.id, doc);
        }
      } catch (_) {}
    }
    return { docs: [...docs.values()], total: total || docs.size };
  }

  function answerLocal(question, corpus, corpusSize = (corpus || []).length) {
    const retrieve = window.AthenaSearch?.retrieveForQuestion || ((q, c) => c);
    const list = corpus || [];
    const limit = isSteroidEnabled() ? list.length : 8;
    const docs = retrieve(question, list, limit);
    if (!docs.length) {
      return {
        answer: corpusSize
          ? 'No saved items matched that question in the current retrieval pass.'
          : 'Your brain has no saved notes/links yet. Dump some first.',
        sources: [],
        results: []
      };
    }
    const display = isSteroidEnabled() ? docs : docs.slice(0, 5);
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
      throw new Error(providerError || `AI proxy failed (${res.status})`);
    }
    if (!res.ok) throw new Error(`AI proxy failed (${res.status})`);
    if (ct.includes('text/event-stream')) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let full = '';
      let thinkingBuf = '';
      // stall guard: if no bytes arrive for 60s, stop waiting (provider froze)
      const STALL_MS = 60000;
      let lastByte = Date.now();
      const stallTimer = setInterval(() => {
        if (Date.now() - lastByte > STALL_MS) {
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
      } finally {
        clearInterval(stallTimer);
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
    for (const doc of remote.docs) merged.set(doc.id || doc.url || `remote-${merged.size}`, doc);
    for (const doc of localDocs) merged.set(doc.id || doc.url || `local-${merged.size}`, doc);
    const docs = [...merged.values()];
    const corpusSize = Math.max(list.length, remote.total || 0);

    const hasLocalKey = !!(cfg.apiKey && cfg.baseUrl && cfg.model);
    const serverConfigured = await instanceAiConfigured();
    if (!hasLocalKey && !serverConfigured) {
      const local = answerLocal(q, docs, corpusSize);
      return { ...local, mode: 'local', thinking: '' };
    }

    // Server accepts per-request credentials only for GOD rank (audit HIGH-1);
    // everyone else uses the instance config. Don't send a local key that would
    // be rejected — fall back to instance, or to local search when the instance
    // has no key configured.
    const isGod = window.athenaIsGod?.() ?? false;
    const sendOwn = isGod && hasLocalKey;
    if (!isGod && !serverConfigured) {
      const local = answerLocal(q, docs, corpusSize);
      return { ...local, mode: 'local', thinking: '' };
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
      const displaySources = isSteroidEnabled() ? docs : docs.slice(0, 8);
      return {
        answer: cleaned || text || 'Empty response from model.',
        thinking,
        sources: displaySources,
        results: docs,
        mode: 'llm'
      };
    } catch (err) {
      const local = answerLocal(q, docs, corpusSize);
      return { ...local, mode: 'local', thinking: '', error: err.message || String(err) };
    }
  }

  /** Does the server hold usable AI credentials? Cached for the page session. */
  let _serverCfg = null;
  async function instanceAiConfigured() {
    // don't cache false (401 before fix) — retry every call until true, then cache true
    if (_serverCfg === true) return true;
    try {
      const token = window.getAthenaSessionToken?.() || localStorage.getItem('athena_session');
      const apiBase = window.getAthenaApiBase?.() || window.location.origin;
      const res = await fetch(`${apiBase}/api/ai/config?v=1.0.36`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: 'no-store'
      });
      const data = await res.json().catch(() => ({}));
      _serverCfg = !!(data && data.hasKey);
      if (_serverCfg) return true;
      // keep false as transient, don't cache permanently
      return false;
    } catch (_) {
      return false;
    }
  }

  window.AthenaAI = {
    answerFromBrain,
    answerLocal,
    loadConfig,
    saveConfig,
    PRESETS,
    normalizeModelId
  };
})();
