/**
 * Template-free, tool-calling AI database agent for Athena's Custom Cleaner.
 * Runs asynchronously in cleaner_agent_jobs using whatever AI provider is
 * configured in Athena (OpenAI, Grok/xAI, Anthropic, OpenRouter, etc.).
 */

const AGENT_MAX_STEPS = 24;
const AGENT_AI_TIMEOUT_MS = 45_000;
const SQL_ROW_LIMIT = 200;

export async function ensureCleanerAgentTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS cleaner_agent_jobs (
       id TEXT PRIMARY KEY,
       user_id TEXT NOT NULL,
       scope TEXT NOT NULL,
       scope_key TEXT NOT NULL,
       prompt TEXT NOT NULL,
       dry_run INTEGER NOT NULL DEFAULT 1,
       status TEXT NOT NULL DEFAULT 'running',
       step_count INTEGER NOT NULL DEFAULT 0,
       logs_json TEXT NOT NULL DEFAULT '[]',
       staged_ops_json TEXT NOT NULL DEFAULT '[]',
       diffs_json TEXT NOT NULL DEFAULT '[]',
       summary TEXT,
       error TEXT,
       applied_count INTEGER NOT NULL DEFAULT 0,
       created_at BIGINT NOT NULL,
       updated_at BIGINT NOT NULL
     )`
  ).run();
}

export function validateReadOnlySql(rawSql) {
  const sql = String(rawSql || '').trim().replace(/;+\s*$/, '');
  if (!sql) return { error: 'Empty SQL query' };
  if (sql.includes(';')) return { error: 'Only a single SELECT statement is allowed' };
  if (!/^(?:select|with)\b/i.test(sql)) return { error: 'Only SELECT or WITH queries are allowed' };
  if (/\b(?:insert|update|delete|drop|alter|create|replace|truncate|pragma|attach|detach|vacuum|grant|revoke|copy)\b/i.test(sql)) {
    return { error: 'Write or DDL keywords are forbidden in sql_read' };
  }
  return { sql };
}

function truncateCell(v) {
  if (typeof v !== 'string') return v;
  return v.length > 260 ? `${v.slice(0, 257)}...` : v;
}

const AGENT_TOOLS = [
  {
    name: 'sql_read',
    description: 'Run a read-only SELECT query on Athena Postgres/SQLite tables (links, personal_links, uploaded_documents, communities). Always filter by the active community_id or user_id. Limit results (<= 200 rows).',
    parameters: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'Single read-only SELECT query.' },
      },
      required: ['sql'],
    },
  },
  {
    name: 'probe_urls',
    description: 'Check live HTTP reachability, final redirect URL, content-type, page title, and t.me availability for up to 20 URLs.',
    parameters: {
      type: 'object',
      properties: {
        urls: { type: 'array', items: { type: 'string' }, description: 'Array of http(s) URLs to probe (max 20).' },
      },
      required: ['urls'],
    },
  },
  {
    name: 'stage_mutations',
    description: 'Stage database deletions or updates by row id. In dry-run mode these are queued for user review; in live mode they are queued and applied at completion.',
    parameters: {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['delete_link', 'update_link', 'delete_document'] },
              id: { type: 'string' },
              title: { type: 'string' },
              notes: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
              url: { type: 'string' },
              reason: { type: 'string' },
            },
            required: ['action', 'id', 'reason'],
          },
        },
      },
      required: ['operations'],
    },
  },
  {
    name: 'finish',
    description: 'Finish the task and provide a concise summary of findings and staged/applied changes.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
      },
      required: ['summary'],
    },
  },
];

async function probeOneUrl(rawUrl, env, fetchWithTimeout) {
  const url = String(rawUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) return { url, ok: false, status: 0, error: 'non-http' };
  try {
    let res = await fetchWithTimeout(url, { method: 'HEAD', env, redirect: 'follow' }, 4500);
    if (res.status === 405 || res.status === 403 || /t\.me\//i.test(url)) {
      res = await fetchWithTimeout(url, { method: 'GET', env, redirect: 'follow' }, 5000);
    }
    const contentType = String(res.headers.get('content-type') || '').toLowerCase();
    let title = '';
    let tgUnavailable = false;
    if (contentType.includes('text/html') && res.body) {
      const html = (await res.text().catch(() => '')).slice(0, 24_000);
      const tm = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
      title = tm ? tm[1].replace(/\s+/g, ' ').trim() : '';
      if (/t\.me\//i.test(url)) {
        const hasMeta = /class="tgme_page_title"|property="og:title"/i.test(html);
        const isDead = /If you have <strong>Telegram<\/strong>, you can contact|tgme_page_extra[^>]*>\s*<\/div>/i.test(html) && !hasMeta;
        if (!hasMeta || isDead) tgUnavailable = true;
      }
    }
    return {
      url,
      ok: res.status >= 200 && res.status < 400 && !tgUnavailable,
      status: res.status,
      final_url: res.url || url,
      content_type: contentType.split(';')[0],
      title,
      ...(tgUnavailable ? { tg_unavailable: true } : {}),
    };
  } catch (err) {
    return { url, ok: false, status: 0, error: err?.message || 'unreachable' };
  }
}

async function callAgentTurn(env, cfg, deps, { system, messages }) {
  const { cleanApiBase, normalizeModelId, resolveChatEndpoint, aiUpstreamHeaders, isAllowedAiEndpoint, fetchWithTimeout } = deps;
  const base = cleanApiBase(cfg.base_url || '');
  const key = String(cfg.api_key || '').trim();
  const model = normalizeModelId(cfg.model, base);
  const aiMode = String(cfg.mode || 'openai').toLowerCase();
  const endpoint = resolveChatEndpoint(base, aiMode, model);
  const epUrl = new URL(endpoint);
  if (!(await isAllowedAiEndpoint(epUrl, env))) {
    throw new Error('Configured AI endpoint is not allowed');
  }

  let body;
  let headers;
  if (aiMode === 'anthropic') {
    headers = { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    body = {
      model,
      max_tokens: 3500,
      system,
      tools: AGENT_TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      messages,
    };
  } else {
    headers = aiUpstreamHeaders(base, key);
    body = {
      model,
      temperature: 0.1,
      max_tokens: 3500,
      tools: AGENT_TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
      messages: [{ role: 'system', content: system }, ...messages],
    };
  }

  const res = await fetchWithTimeout(endpoint, {
    method: 'POST', env, redirect: 'error', allowPrivate: true, headers, body: JSON.stringify(body),
  }, AGENT_AI_TIMEOUT_MS);
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`AI provider HTTP ${res.status}: ${txt.slice(0, 240)}`);
  }
  const data = await res.json();

  if (aiMode === 'anthropic') {
    const blocks = Array.isArray(data.content) ? data.content : [];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const calls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({
      id: b.id, name: b.name, args: b.input || {},
    }));
    return { text, calls, rawAssistant: blocks };
  }

  const msg = data.choices?.[0]?.message || {};
  const text = String(msg.content || '');
  const calls = (Array.isArray(msg.tool_calls) ? msg.tool_calls : []).map((tc) => {
    let args = {};
    try { args = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments || '{}') : (tc.function?.arguments || {}); } catch (_) {}
    return { id: tc.id || `call_${Math.random().toString(36).slice(2, 8)}`, name: tc.function?.name, args };
  });
  return { text, calls, rawAssistant: msg };
}

export async function applyStagedMutations(env, { scope, scopeKey, ops, user, actorLabel, deps }) {
  const { generateUrlHash, markMeiliScopeDirty, logActivityEvent } = deps;
  const table = scope === 'personal' ? 'personal_links' : 'links';
  const scopeCol = scope === 'personal' ? 'user_id' : 'community_id';
  let applied = 0;
  let failed = 0;

  for (const op of ops) {
    try {
      if (op.action === 'delete_link') {
        const res = await env.DB.prepare(`DELETE FROM ${table} WHERE id = ? AND ${scopeCol} = ?`).bind(op.id, scopeKey).run();
        if (Number(res?.meta?.changes ?? res?.changes ?? 0) > 0) applied++;
      } else if (op.action === 'delete_document') {
        const res = await env.DB.prepare(`DELETE FROM uploaded_documents WHERE id = ? AND scope = ? AND ${scopeCol} = ?`).bind(op.id, scope, scopeKey).run();
        if (Number(res?.meta?.changes ?? res?.changes ?? 0) > 0) applied++;
      } else if (op.action === 'update_link') {
        const row = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ? AND ${scopeCol} = ?`).bind(op.id, scopeKey).first();
        if (!row) continue;
        const nextUrl = typeof op.url === 'string' && /^https?:\/\//i.test(op.url.trim()) ? op.url.trim() : row.url;
        const nextHash = nextUrl !== row.url ? generateUrlHash(nextUrl) : row.url_hash;
        const nextTitle = typeof op.title === 'string' ? op.title.trim().slice(0, 300) : (row.title || '');
        const nextNotes = typeof op.notes === 'string' ? op.notes.trim().slice(0, 2000) : (row.notes || '');
        let existingTags = [];
        try { existingTags = JSON.parse(row.tags || '[]'); } catch (_) {}
        const nextTags = Array.isArray(op.tags)
          ? [...new Set(op.tags.map((t) => String(t).trim().replace(/^#+/, '').toLowerCase()).filter(Boolean))].slice(0, 12)
          : existingTags;
        await env.DB.prepare(
          `UPDATE ${table} SET url = ?, url_hash = ?, title = ?, notes = ?, tags = ?, manual_edited_at = ?, last_edited_by = ?, last_edited_by_name = ?, search_blob = NULL WHERE id = ?`
        ).bind(nextUrl, nextHash, nextTitle, nextNotes, JSON.stringify(nextTags), Date.now(), user.id, `AI Agent (${actorLabel})`, row.id).run();
        applied++;
      }
    } catch (_) {
      failed++;
    }
  }
  if (applied > 0) {
    markMeiliScopeDirty(env, scope, scopeKey);
    await logActivityEvent(env, {
      action: '🤖 AI DB Agent',
      actorUser: user,
      details: `Applied ${applied} operation(s)${failed ? ` · ${failed} failed` : ''} (${scope})`,
      scope,
      scopeKey,
    });
  }
  return { applied, failed };
}

export async function runCleanerAgentJob(env, jobId, { user, cfg, includeLinks, includeDocs, actorLabel, deps }) {
  await ensureCleanerAgentTable(env);
  const job = await env.DB.prepare('SELECT * FROM cleaner_agent_jobs WHERE id = ?').bind(jobId).first();
  if (!job) return;

  const scope = job.scope;
  const scopeKey = job.scope_key;
  const dryRun = Number(job.dry_run) !== 0;
  const table = scope === 'personal' ? 'personal_links' : 'links';
  const scopeCol = scope === 'personal' ? 'user_id' : 'community_id';
  const aiMode = String(cfg.mode || 'openai').toLowerCase();

  const logs = [];
  const stagedMap = new Map();
  const diffs = [];

  const saveProgress = async (patch = {}) => {
    const nextStatus = patch.status || undefined;
    const fields = ['step_count = ?', 'logs_json = ?', 'staged_ops_json = ?', 'diffs_json = ?', 'updated_at = ?'];
    const vals = [logs.length, JSON.stringify(logs.slice(-40)), JSON.stringify([...stagedMap.values()]), JSON.stringify(diffs.slice(-120)), Date.now()];
    if (nextStatus) { fields.push('status = ?'); vals.push(nextStatus); }
    if (patch.summary !== undefined) { fields.push('summary = ?'); vals.push(patch.summary); }
    if (patch.error !== undefined) { fields.push('error = ?'); vals.push(patch.error); }
    if (patch.applied_count !== undefined) { fields.push('applied_count = ?'); vals.push(patch.applied_count); }
    vals.push(jobId);
    await env.DB.prepare(`UPDATE cleaner_agent_jobs SET ${fields.join(', ')} WHERE id = ?`).bind(...vals).run();
  };

  const system = `You are Athena's autonomous AI DB Agent. Execute the user's instruction accurately using your tools.
Active Scope: ${scope} (${scopeCol} = '${scopeKey}')
Primary links table: ${table} (columns: id, ${scopeCol}, url, title, notes, tags, created_at, manual_edited_at)
Documents table: uploaded_documents (columns: id, scope, ${scopeCol}, filename, content, created_at)
Allowed targets: links=${includeLinks}, documents=${includeDocs}.
Workflow:
1. Use sql_read to inspect counts, schema/rows, or find candidates. Always scope queries with ${scopeCol} = '${scopeKey}'.
2. Use probe_urls whenever checking whether URLs are reachable, redirect, return images (.jpg/.png), or are unavailable t.me links.
3. Use stage_mutations to stage deletions or updates (never delete all rows in a duplicate group; keep the best accessible canonical row).
4. Call finish({ summary }) when done.`;

  const messages = [{ role: 'user', content: job.prompt }];

  try {
    let finalSummary = '';
    for (let step = 1; step <= AGENT_MAX_STEPS; step++) {
      const cur = await env.DB.prepare('SELECT status FROM cleaner_agent_jobs WHERE id = ?').bind(jobId).first();
      if (!cur || cur.status === 'stopping' || cur.status === 'stopped') {
        await saveProgress({ status: 'stopped', summary: finalSummary || 'Stopped by user.' });
        return;
      }

      const turn = await callAgentTurn(env, cfg, deps, { system, messages });
      if (aiMode === 'anthropic') {
        messages.push({ role: 'assistant', content: turn.rawAssistant });
      } else {
        messages.push({ role: 'assistant', content: turn.text || null, ...(turn.calls.length ? { tool_calls: turn.rawAssistant.tool_calls } : {}) });
      }

      if (!turn.calls.length) {
        finalSummary = turn.text || 'Completed.';
        logs.push(`Step ${step}: Agent finished.`);
        break;
      }

      const anthropicResults = [];
      let finishedByTool = false;

      for (const call of turn.calls) {
        let resultObj;
        if (call.name === 'sql_read') {
          const check = validateReadOnlySql(call.args?.sql);
          if (check.error) {
            resultObj = { error: check.error };
            logs.push(`Step ${step}: sql_read rejected (${check.error})`);
          } else {
            try {
              const { results } = await env.DB.prepare(check.sql).all();
              const rows = (results || []).slice(0, SQL_ROW_LIMIT).map((r) => {
                const out = {};
                for (const [k, v] of Object.entries(r)) out[k] = truncateCell(v);
                return out;
              });
              resultObj = { row_count: (results || []).length, truncated: (results || []).length > SQL_ROW_LIMIT, rows };
              logs.push(`Step ${step}: sql_read returned ${rows.length} row(s)`);
            } catch (err) {
              resultObj = { error: err?.message || 'SQL error' };
              logs.push(`Step ${step}: sql_read error (${resultObj.error})`);
            }
          }
        } else if (call.name === 'probe_urls') {
          const urls = (Array.isArray(call.args?.urls) ? call.args.urls : []).slice(0, 20);
          const probes = await Promise.all(urls.map((u) => probeOneUrl(u, env, deps.fetchWithTimeout)));
          resultObj = { results: probes };
          logs.push(`Step ${step}: probed ${probes.length} URL(s)`);
        } else if (call.name === 'stage_mutations') {
          const ops = Array.isArray(call.args?.operations) ? call.args.operations : [];
          let added = 0;
          for (const op of ops) {
            const id = String(op?.id || '').trim();
            const action = String(op?.action || '');
            if (!id || !['delete_link', 'update_link', 'delete_document'].includes(action)) continue;
            if (action === 'delete_document') {
              const doc = await env.DB.prepare(`SELECT id, filename, content FROM uploaded_documents WHERE id = ? AND scope = ? AND ${scopeCol} = ?`).bind(id, scope, scopeKey).first();
              if (!doc) continue;
              stagedMap.set(`${action}:${id}`, { action, id, reason: String(op.reason || '') });
              diffs.push({
                id, changed: true, deleted: true, changedFields: [op.reason ? `delete (${op.reason})` : 'delete'], usedAi: true,
                before: { url: `doc://${doc.filename}`, title: doc.filename, notes: String(doc.content || '').slice(0, 100), tags: [] },
                after: { url: '', title: '(deleted)', notes: '', tags: [] },
              });
              added++;
            } else {
              const row = await env.DB.prepare(`SELECT id, url, title, notes, tags FROM ${table} WHERE id = ? AND ${scopeCol} = ?`).bind(id, scopeKey).first();
              if (!row) continue;
              let existingTags = [];
              try { existingTags = JSON.parse(row.tags || '[]'); } catch (_) {}
              stagedMap.set(`${action}:${id}`, { ...op, action, id });
              diffs.push({
                id,
                changed: true,
                deleted: action === 'delete_link',
                changedFields: action === 'delete_link' ? [op.reason ? `delete (${op.reason})` : 'delete'] : ['ai-update'],
                usedAi: true,
                before: { url: row.url, title: row.title || '', notes: row.notes || '', tags: existingTags },
                after: action === 'delete_link'
                  ? { url: '', title: '(deleted)', notes: '', tags: [] }
                  : { url: op.url || row.url, title: op.title ?? row.title ?? '', notes: op.notes ?? row.notes ?? '', tags: Array.isArray(op.tags) ? op.tags : existingTags },
              });
              added++;
            }
          }
          resultObj = { staged: added, total_staged: stagedMap.size };
          logs.push(`Step ${step}: staged ${added} mutation(s) (total ${stagedMap.size})`);
        } else if (call.name === 'finish') {
          finalSummary = String(call.args?.summary || 'Completed.');
          resultObj = { ok: true };
          logs.push(`Step ${step}: ${finalSummary}`);
          finishedByTool = true;
        } else {
          resultObj = { error: `Unknown tool: ${call.name}` };
        }

        if (aiMode === 'anthropic') {
          anthropicResults.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(resultObj) });
        } else {
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(resultObj) });
        }
      }

      if (aiMode === 'anthropic') {
        messages.push({ role: 'user', content: anthropicResults });
      }
      await saveProgress();
      if (finishedByTool) break;
    }

    const stagedOps = [...stagedMap.values()];
    let appliedCount = 0;
    if (!dryRun && stagedOps.length) {
      const res = await applyStagedMutations(env, { scope, scopeKey, ops: stagedOps, user, actorLabel, deps });
      appliedCount = res.applied;
    }
    await saveProgress({
      status: 'done',
      summary: finalSummary || `Completed with ${stagedOps.length} staged operation(s).`,
      applied_count: appliedCount,
    });
  } catch (err) {
    logs.push(`Error: ${err?.message || 'Agent failed'}`);
    await saveProgress({ status: 'error', error: err?.message || 'Agent failed' });
  }
}
