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
    return m;
  }

  function formatDoc(item, i) {
    const tags = Array.isArray(item.tags) ? item.tags.join(', ') : (item.tags || '');
    const notes = (item.notes || '').slice(0, 800);
    const content = (item.content || '').slice(0, 60000);
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
5. Recommend saved URLs when applicable. Cite as [#n].
6. Stay strictly grounded in BRAIN CONTEXT; never invent facts not present in it.
7. The user may ask follow-up questions. Use the conversation history to understand context. If they say "tell me more" or "which sections", refer back to the documents discussed.`;
  }

  function buildContextMessage(docs, corpusSize) {
    if (!docs.length) return 'BRAIN CONTEXT: (truly empty — 0 saved items)';
    let used = 0;
    const ctx = docs.map((d, i) => {
      const remaining = Math.max(0, 80000 - used);
      const formatted = formatDoc(d, i).slice(0, remaining);
      used += formatted.length;
      return formatted;
    }).filter(Boolean).join('\n\n');
    return `BRAIN has ${corpusSize} saved item(s). Retrieved items:\n\n${ctx}`;
  }

  function answerLocal(question, corpus) {
    const retrieve = window.AthenaSearch?.retrieveForQuestion || ((q, c) => c.slice(0, 5));
    const docs = retrieve(question, corpus || [], 8);
    if (!docs.length) {
      return {
        answer: 'Your brain has no saved notes/links yet. Dump some first.',
        sources: [],
        results: []
      };
    }
    const lines = docs.slice(0, 5).map((d, i) => {
      const label = d.title || d.url || 'Note';
      return `${i + 1}. **${label}**${d.url ? ` — ${d.url}` : ''}`;
    });
    return {
      answer: `Closest matches in your brain:\n\n${lines.join('\n\n')}`,
      sources: docs.slice(0, 5),
      results: docs
    };
  }

  async function callViaProxy({ baseUrl, apiKey, model, mode, system, user, messages, onDelta, onThinking }) {
    // A same-origin login has no bearer token — the HttpOnly session cookie is
    // sent by the browser instead. Only a cross-origin backend needs the header.
    const token = localStorage.getItem('athena_session');

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
    if (ct.includes('text/event-stream')) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let full = '';
      let thinkingBuf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let j;
          try { j = JSON.parse(payload); } catch (_) { continue; }
          if (j.error) throw new Error(typeof j.error === 'string' ? j.error : 'AI stream error');
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
      return { text: full, thinking: thinkingBuf };
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      const bits = [data.error || `AI proxy failed (${res.status})`];
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
    const retrieve = window.AthenaSearch?.retrieveForQuestion;
    let docs = retrieve ? retrieve(q, list, 5, { minScore: 30, strict: true }) : list.slice(0, 5);
    if (!docs.length && list.length) {
      docs = [...list].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 3);
    }

    const hasLocalKey = !!(cfg.apiKey && cfg.baseUrl && cfg.model);
    const serverConfigured = await instanceAiConfigured();
    if (!hasLocalKey && !serverConfigured) {
      const local = answerLocal(q, list);
      return { ...local, mode: 'local', thinking: '' };
    }

    // Server accepts per-request credentials only for GOD rank (audit HIGH-1);
    // everyone else uses the instance config. Don't send a local key that would
    // be rejected — fall back to instance, or to local search when the instance
    // has no key configured.
    const isGod = window.athenaIsGod?.() ?? true;
    const sendOwn = isGod && hasLocalKey;
    if (!isGod && !serverConfigured) {
      const local = answerLocal(q, list);
      return { ...local, mode: 'local', thinking: '' };
    }

    // Build messages: system prompt with brain context, then conversation history.
    const system = buildSystemPrompt() + '\n\n' + buildContextMessage(docs, list.length);
    const history = conversationHistory && conversationHistory.length
      ? conversationHistory
      : [{ role: 'user', content: q }];
    const messages = [{ role: 'system', content: system }, ...history];

    try {
      const result = await callViaProxy({
        baseUrl: sendOwn ? cfg.baseUrl : '',
        apiKey: sendOwn ? cfg.apiKey : '',
        model: sendOwn ? normalizeModelId(cfg.model, cfg.baseUrl) : '',
        mode: sendOwn ? (cfg.mode || 'openai') : '',
        messages,
        onDelta,
        onThinking
      });
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
      return {
        answer: cleaned || text || 'Empty response from model.',
        thinking,
        sources: docs.slice(0, 8),
        results: docs,
        mode: 'llm'
      };
    } catch (err) {
      const local = answerLocal(q, list);
      return { ...local, mode: 'local', thinking: '', error: err.message || String(err) };
    }
  }

  /** Does the server hold usable AI credentials? Cached for the page session. */
  let _serverCfg = null;
  async function instanceAiConfigured() {
    if (_serverCfg !== null) return _serverCfg;
    try {
      const token = localStorage.getItem('athena_session');
      const apiBase = window.getAthenaApiBase?.() || window.location.origin;
      const res = await fetch(`${apiBase}/api/ai/config`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      });
      const data = await res.json().catch(() => ({}));
      // hasKey (not just `configured`) — a row with no API key cannot answer.
      _serverCfg = !!(data && data.hasKey);
    } catch (_) {
      _serverCfg = false;
    }
    return _serverCfg;
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
