/**
 * Role-scoped Streamable HTTP MCP server for Athena.
 * - Owner MCP: full control over DB, users, communities, clones, cleaner agent, and blacklists.
 * - Admin MCP: scoped moderation/curation (search, add, edit, delete links/docs, reports, community blacklist).
 */
import { validateReadOnlySql, ensureCleanerAgentTable, runCleanerAgentJob } from './db-agent.js';

const MCP_PROTOCOL_VERSION = '2024-11-05';

export async function ensureMcpTokensTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS mcp_tokens (
       id TEXT PRIMARY KEY,
       token_hash TEXT UNIQUE NOT NULL,
       user_id TEXT NOT NULL,
       role TEXT NOT NULL,
       community_id TEXT,
       created_at BIGINT NOT NULL,
       last_used_at BIGINT
     )`
  ).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_mcp_tokens_user ON mcp_tokens(user_id, role)').run();
}

async function sha256Hex(raw) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(raw || '')));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomMcpToken(role) {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `athena_mcp_${role === 'owner' ? 'own' : 'adm'}_${hex}`;
}

function mcpUrlFromRequest(request, rawToken) {
  const u = new URL(request.url);
  return `${u.origin}/mcp/${rawToken}`;
}

async function isCommunityAdminInAny(env, userId) {
  const row = await env.DB.prepare(
    "SELECT community_id FROM community_members WHERE user_id = ? AND role IN ('owner','admin') LIMIT 1"
  ).bind(userId).first().catch(() => null);
  return Boolean(row?.community_id);
}

async function adminCommunityIds(env, userId, isOwner) {
  if (isOwner) {
    const { results } = await env.DB.prepare('SELECT id FROM communities').all().catch(() => ({ results: [] }));
    return new Set((results || []).map((r) => String(r.id)));
  }
  const { results } = await env.DB.prepare(
    "SELECT community_id FROM community_members WHERE user_id = ? AND role IN ('owner','admin')"
  ).bind(userId).all().catch(() => ({ results: [] }));
  return new Set((results || []).map((r) => String(r.community_id)));
}

export async function handleProfileMcpToken(request, user, env, corsHeaders, deps) {
  if (!user) return Response.json({ success: false, error: 'Authentication required' }, { status: 401, headers: corsHeaders });
  await ensureMcpTokensTable(env);

  const isOwner = await deps.isInstanceOwnerUserAsync(user, env);
  const isAdmin = isOwner || (await isCommunityAdminInAny(env, user.id));

  if (request.method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT role, community_id, created_at, last_used_at FROM mcp_tokens WHERE user_id = ?'
    ).bind(user.id).all();
    const byRole = { owner: null, admin: null };
    for (const r of (results || [])) {
      if (r.role === 'owner' || r.role === 'admin') {
        byRole[r.role] = {
          exists: true,
          community_id: r.community_id || null,
          created_at: Number(r.created_at || 0),
          last_used_at: r.last_used_at ? Number(r.last_used_at) : null,
        };
      }
    }
    return Response.json({ success: true, can_owner: isOwner, can_admin: isAdmin, tokens: byRole }, { headers: corsHeaders });
  }

  if (request.method === 'DELETE') {
    const body = await request.json().catch(() => ({}));
    const role = String(body.role || '').toLowerCase();
    if (role !== 'owner' && role !== 'admin') {
      return Response.json({ success: false, error: 'role must be owner or admin' }, { status: 400, headers: corsHeaders });
    }
    await env.DB.prepare('DELETE FROM mcp_tokens WHERE user_id = ? AND role = ?').bind(user.id, role).run();
    return Response.json({ success: true, revoked: role }, { headers: corsHeaders });
  }

  if (request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const role = String(body.role || '').toLowerCase();
    if (role !== 'owner' && role !== 'admin') {
      return Response.json({ success: false, error: 'role must be owner or admin' }, { status: 400, headers: corsHeaders });
    }
    if (role === 'owner' && !isOwner) {
      return Response.json({ success: false, error: 'Owner rank required for Owner MCP URL' }, { status: 403, headers: corsHeaders });
    }
    if (role === 'admin' && !isAdmin) {
      return Response.json({ success: false, error: 'Admin or Owner rank required for Admin MCP URL' }, { status: 403, headers: corsHeaders });
    }
    const communityId = body.community_id ? String(body.community_id).trim() : null;
    const rawToken = randomMcpToken(role);
    const tokenHash = await sha256Hex(rawToken);
    const now = Date.now();
    await env.DB.prepare('DELETE FROM mcp_tokens WHERE user_id = ? AND role = ?').bind(user.id, role).run();
    await env.DB.prepare(
      'INSERT INTO mcp_tokens (id, token_hash, user_id, role, community_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(`mcp_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`, tokenHash, user.id, role, communityId, now).run();

    return Response.json({
      success: true,
      role,
      url: mcpUrlFromRequest(request, rawToken),
      created_at: now,
    }, { headers: corsHeaders });
  }

  return Response.json({ success: false, error: 'Method not allowed' }, { status: 405, headers: corsHeaders });
}

const ADMIN_TOOLS = [
  {
    name: 'search_links',
    description: 'Search links in administered communities (or personal scope for owner).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        community_id: { type: 'string' },
        limit: { type: 'integer' },
      },
    },
  },
  {
    name: 'get_link',
    description: 'Fetch a single link by id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'add_link',
    description: 'Add a new link to an administered community.',
    inputSchema: {
      type: 'object',
      properties: {
        community_id: { type: 'string' },
        url: { type: 'string' },
        title: { type: 'string' },
        notes: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['community_id', 'url'],
    },
  },
  {
    name: 'edit_link',
    description: 'Edit title, notes, tags, or url of a link in an administered community.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        notes: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        url: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_link',
    description: 'Delete a link by id in an administered community.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'delete_document',
    description: 'Delete an uploaded document by id in an administered community.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'list_reports',
    description: 'List link reports in administered communities.',
    inputSchema: {
      type: 'object',
      properties: {
        community_id: { type: 'string' },
        status: { type: 'string', enum: ['open', 'resolved', 'dismissed'] },
      },
    },
  },
  {
    name: 'resolve_report',
    description: 'Resolve or dismiss a link report.',
    inputSchema: {
      type: 'object',
      properties: {
        report_id: { type: 'string' },
        status: { type: 'string', enum: ['resolved', 'dismissed'] },
      },
      required: ['report_id', 'status'],
    },
  },
  {
    name: 'list_blacklist',
    description: 'List URL/tag blacklist rules for an administered community.',
    inputSchema: {
      type: 'object',
      properties: { community_id: { type: 'string' } },
      required: ['community_id'],
    },
  },
  {
    name: 'add_blacklist',
    description: 'Add a URL/domain/tag blacklist rule to an administered community.',
    inputSchema: {
      type: 'object',
      properties: {
        community_id: { type: 'string' },
        kind: { type: 'string', enum: ['url', 'domain', 'tag'] },
        pattern: { type: 'string' },
      },
      required: ['community_id', 'kind', 'pattern'],
    },
  },
];

const OWNER_ONLY_TOOLS = [
  {
    name: 'sql_read',
    description: 'Run any read-only SELECT/WITH SQL query across the entire Athena database.',
    inputSchema: {
      type: 'object',
      properties: { sql: { type: 'string' } },
      required: ['sql'],
    },
  },
  {
    name: 'sql_write',
    description: 'Execute an INSERT, UPDATE, or DELETE SQL statement on the Athena database (instance owner only).',
    inputSchema: {
      type: 'object',
      properties: { sql: { type: 'string' } },
      required: ['sql'],
    },
  },
  {
    name: 'probe_urls',
    description: 'Probe up to 20 URLs for live HTTP status, redirect target, content-type, and title.',
    inputSchema: {
      type: 'object',
      properties: { urls: { type: 'array', items: { type: 'string' } } },
      required: ['urls'],
    },
  },
  {
    name: 'get_instance_stats',
    description: 'Get total counts across links, personal_links, uploaded_documents, users, communities, and clone jobs.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_communities',
    description: 'List all communities on the instance.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_users',
    description: 'List or search registered users on the instance.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'integer' } },
    },
  },
  {
    name: 'manage_community_member',
    description: 'Set a user role (owner/admin/member) or remove a member from a community.',
    inputSchema: {
      type: 'object',
      properties: {
        community_id: { type: 'string' },
        user_id: { type: 'string' },
        role: { type: 'string', enum: ['owner', 'admin', 'member', 'remove'] },
      },
      required: ['community_id', 'user_id', 'role'],
    },
  },
  {
    name: 'trigger_ai_cleaner_agent',
    description: 'Start the autonomous AI DB Cleaner agent with any custom prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        scope: { type: 'string', enum: ['community', 'personal'] },
        community_id: { type: 'string' },
        dry_run: { type: 'boolean' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'get_cleaner_agent_job',
    description: 'Check status, logs, and staged diffs of an AI DB Cleaner agent job.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id'],
    },
  },
  {
    name: 'list_clone_jobs',
    description: 'List recent/active Telegram clone & backfill jobs.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'stop_clone_job',
    description: 'Stop an active clone/backfill job by id.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id'],
    },
  },
  {
    name: 'manage_global_blacklist',
    description: 'List, add, or delete global blacklist rules.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'delete'] },
        kind: { type: 'string', enum: ['url', 'domain', 'tag'] },
        pattern: { type: 'string' },
        id: { type: 'string' },
      },
      required: ['action'],
    },
  },
];

async function executeMcpTool(name, args, ctx) {
  const { env, user, role, allowedCommunities, deps } = ctx;
  const isOwnerRole = role === 'owner';
  const ensureCommAllowed = (cid) => {
    if (isOwnerRole) return true;
    return cid && allowedCommunities.has(String(cid));
  };

  if (!isOwnerRole && OWNER_ONLY_TOOLS.some((t) => t.name === name)) {
    throw new Error(`Tool "${name}" requires Owner MCP role`);
  }

  switch (name) {
    case 'search_links': {
      const q = String(args.query || '').trim().toLowerCase();
      const limit = Math.min(100, Math.max(1, Number(args.limit || 25)));
      const cid = args.community_id ? String(args.community_id) : null;
      if (cid && !ensureCommAllowed(cid)) throw new Error('Community access denied');
      const allowedIds = cid ? [cid] : [...allowedCommunities];
      if (!allowedIds.length && !isOwnerRole) return { links: [] };
      let sql = 'SELECT id, community_id, url, title, notes, tags, created_at FROM links';
      const params = [];
      const where = [];
      if (!isOwnerRole || cid) {
        where.push(`community_id IN (${allowedIds.map(() => '?').join(',')})`);
        params.push(...allowedIds);
      }
      if (q) {
        where.push('(LOWER(url) LIKE ? OR LOWER(COALESCE(title,\'\')) LIKE ? OR LOWER(COALESCE(notes,\'\')) LIKE ? OR LOWER(COALESCE(tags,\'\')) LIKE ?)');
        const pat = `%${q}%`;
        params.push(pat, pat, pat, pat);
      }
      if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
      sql += ' ORDER BY created_at DESC LIMIT ?';
      params.push(limit);
      const { results } = await env.DB.prepare(sql).bind(...params).all();
      return { links: results || [] };
    }
    case 'get_link': {
      const row = await env.DB.prepare('SELECT * FROM links WHERE id = ?').bind(String(args.id)).first();
      if (!row || !ensureCommAllowed(row.community_id)) throw new Error('Link not found or access denied');
      return { link: row };
    }
    case 'add_link': {
      const cid = String(args.community_id || '');
      if (!ensureCommAllowed(cid)) throw new Error('Community access denied');
      const rawUrl = String(args.url || '').trim();
      if (!/^https?:\/\//i.test(rawUrl)) throw new Error('Valid http(s) url required');
      const id = `mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const hash = deps.generateUrlHash(rawUrl);
      const tags = Array.isArray(args.tags) ? args.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean) : [];
      await env.DB.prepare(
        `INSERT INTO links (id, community_id, url, url_hash, title, notes, tags, added_by, added_by_user_id, added_by_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, cid, rawUrl, hash, String(args.title || rawUrl).slice(0, 300), String(args.notes || '').slice(0, 2000), JSON.stringify(tags), user.username || user.id, user.id, user.display_name || user.username || user.id, Date.now()).run();
      deps.markMeiliScopeDirty(env, 'community', cid);
      return { created: true, id, url: rawUrl };
    }
    case 'edit_link': {
      const row = await env.DB.prepare('SELECT * FROM links WHERE id = ?').bind(String(args.id)).first();
      if (!row || !ensureCommAllowed(row.community_id)) throw new Error('Link not found or access denied');
      const nextUrl = typeof args.url === 'string' && /^https?:\/\//i.test(args.url.trim()) ? args.url.trim() : row.url;
      const nextHash = nextUrl !== row.url ? deps.generateUrlHash(nextUrl) : row.url_hash;
      const nextTitle = typeof args.title === 'string' ? args.title.slice(0, 300) : (row.title || '');
      const nextNotes = typeof args.notes === 'string' ? args.notes.slice(0, 2000) : (row.notes || '');
      const nextTags = Array.isArray(args.tags) ? JSON.stringify(args.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean)) : (row.tags || '[]');
      await env.DB.prepare(
        'UPDATE links SET url = ?, url_hash = ?, title = ?, notes = ?, tags = ?, manual_edited_at = ?, last_edited_by = ?, last_edited_by_name = ?, search_blob = NULL WHERE id = ?'
      ).bind(nextUrl, nextHash, nextTitle, nextNotes, nextTags, Date.now(), user.id, `MCP (${role})`, row.id).run();
      deps.markMeiliScopeDirty(env, 'community', row.community_id);
      return { updated: true, id: row.id };
    }
    case 'delete_link': {
      const row = await env.DB.prepare('SELECT id, community_id FROM links WHERE id = ?').bind(String(args.id)).first();
      if (!row || !ensureCommAllowed(row.community_id)) throw new Error('Link not found or access denied');
      await env.DB.prepare('DELETE FROM links WHERE id = ?').bind(row.id).run();
      deps.markMeiliScopeDirty(env, 'community', row.community_id);
      return { deleted: true, id: row.id };
    }
    case 'delete_document': {
      const row = await env.DB.prepare('SELECT id, scope, community_id FROM uploaded_documents WHERE id = ?').bind(String(args.id)).first();
      if (!row || (row.scope === 'community' && !ensureCommAllowed(row.community_id)) || (row.scope !== 'community' && !isOwnerRole)) {
        throw new Error('Document not found or access denied');
      }
      await env.DB.prepare('DELETE FROM uploaded_documents WHERE id = ?').bind(row.id).run();
      deps.markMeiliScopeDirty(env, row.scope, row.community_id || user.id);
      return { deleted: true, id: row.id };
    }
    case 'list_reports': {
      const cid = args.community_id ? String(args.community_id) : null;
      if (cid && !ensureCommAllowed(cid)) throw new Error('Community access denied');
      const allowedIds = cid ? [cid] : [...allowedCommunities];
      if (!allowedIds.length && !isOwnerRole) return { reports: [] };
      const where = [];
      const params = [];
      if (!isOwnerRole || cid) {
        where.push(`community_id IN (${allowedIds.map(() => '?').join(',')})`);
        params.push(...allowedIds);
      }
      if (args.status) { where.push('status = ?'); params.push(String(args.status)); }
      const sql = `SELECT * FROM link_reports${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 50`;
      const { results } = await env.DB.prepare(sql).bind(...params).all();
      return { reports: results || [] };
    }
    case 'resolve_report': {
      const rep = await env.DB.prepare('SELECT * FROM link_reports WHERE id = ?').bind(String(args.report_id)).first();
      if (!rep || !ensureCommAllowed(rep.community_id)) throw new Error('Report not found or access denied');
      const st = args.status === 'dismissed' ? 'dismissed' : 'resolved';
      await env.DB.prepare('UPDATE link_reports SET status = ? WHERE id = ?').bind(st, rep.id).run();
      return { updated: true, id: rep.id, status: st };
    }
    case 'list_blacklist': {
      const cid = String(args.community_id || '');
      if (!ensureCommAllowed(cid)) throw new Error('Community access denied');
      const { results } = await env.DB.prepare("SELECT * FROM blacklist_rules WHERE scope = 'community' AND scope_key = ? ORDER BY created_at DESC").bind(cid).all();
      return { rules: results || [] };
    }
    case 'add_blacklist': {
      const cid = String(args.community_id || '');
      if (!ensureCommAllowed(cid)) throw new Error('Community access denied');
      const id = `bl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      await env.DB.prepare('INSERT INTO blacklist_rules (id, scope, scope_key, kind, pattern, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, 'community', cid, String(args.kind || 'url'), String(args.pattern || '').trim(), user.id, Date.now()).run();
      return { added: true, id };
    }
    // ---- Owner-only tools ----
    case 'sql_read': {
      const check = validateReadOnlySql(args.sql);
      if (check.error) throw new Error(check.error);
      const { results } = await env.DB.prepare(check.sql).all();
      return { row_count: (results || []).length, rows: (results || []).slice(0, 200) };
    }
    case 'sql_write': {
      const sql = String(args.sql || '').trim().replace(/;+\s*$/, '');
      if (!sql || sql.includes(';')) throw new Error('Single SQL write statement required');
      if (!/^(?:insert|update|delete)\b/i.test(sql)) throw new Error('Only INSERT, UPDATE, or DELETE allowed');
      const res = await env.DB.prepare(sql).run();
      return { ok: true, changes: Number(res?.meta?.changes ?? res?.changes ?? 0) };
    }
    case 'probe_urls': {
      const urls = (Array.isArray(args.urls) ? args.urls : []).slice(0, 20);
      const out = await Promise.all(urls.map(async (raw) => {
        try {
          const r = await deps.fetchWithTimeout(String(raw), { method: 'HEAD', env, redirect: 'follow' }, 4500);
          return { url: raw, ok: r.status >= 200 && r.status < 400, status: r.status, final_url: r.url || raw };
        } catch (err) {
          return { url: raw, ok: false, status: 0, error: err?.message || 'unreachable' };
        }
      }));
      return { results: out };
    }
    case 'get_instance_stats': {
      const c = async (q) => Number((await env.DB.prepare(q).first().catch(() => ({ c: 0 })))?.c || 0);
      return {
        links: await c('SELECT COUNT(*) AS c FROM links'),
        personal_links: await c('SELECT COUNT(*) AS c FROM personal_links'),
        uploaded_documents: await c('SELECT COUNT(*) AS c FROM uploaded_documents'),
        users: await c('SELECT COUNT(*) AS c FROM users'),
        communities: await c('SELECT COUNT(*) AS c FROM communities'),
        active_clone_jobs: await c("SELECT COUNT(*) AS c FROM index_jobs WHERE status IN ('queued','running','stopping')"),
      };
    }
    case 'list_communities': {
      const { results } = await env.DB.prepare('SELECT id, name, creator_id, created_at FROM communities ORDER BY created_at DESC').all();
      return { communities: results || [] };
    }
    case 'list_users': {
      const q = String(args.query || '').trim().toLowerCase();
      const lim = Math.min(100, Math.max(1, Number(args.limit || 50)));
      const { results } = q
        ? await env.DB.prepare('SELECT id, username, display_name, provider, created_at FROM users WHERE LOWER(username) LIKE ? OR LOWER(COALESCE(display_name,\'\')) LIKE ? ORDER BY created_at DESC LIMIT ?').bind(`%${q}%`, `%${q}%`, lim).all()
        : await env.DB.prepare('SELECT id, username, display_name, provider, created_at FROM users ORDER BY created_at DESC LIMIT ?').bind(lim).all();
      return { users: results || [] };
    }
    case 'manage_community_member': {
      const cid = String(args.community_id || '');
      const uid = String(args.user_id || '');
      const r = String(args.role || '');
      if (r === 'remove') {
        await env.DB.prepare('DELETE FROM community_members WHERE community_id = ? AND user_id = ?').bind(cid, uid).run();
        return { removed: true, community_id: cid, user_id: uid };
      }
      await env.DB.prepare(
        'INSERT INTO community_members (community_id, user_id, role, joined_at) VALUES (?, ?, ?, ?) ON CONFLICT(community_id, user_id) DO UPDATE SET role = excluded.role'
      ).bind(cid, uid, r, Date.now()).run();
      return { updated: true, community_id: cid, user_id: uid, role: r };
    }
    case 'trigger_ai_cleaner_agent': {
      const cfg = await deps.getInstanceAiConfig(env).catch(() => null);
      if (!cfg?.api_key) throw new Error('Instance AI key not configured');
      await ensureCleanerAgentTable(env);
      const scope = args.scope === 'personal' ? 'personal' : 'community';
      let scopeKey = scope === 'personal' ? user.id : String(args.community_id || '');
      if (scope === 'community' && !scopeKey) {
        const first = await env.DB.prepare('SELECT id FROM communities ORDER BY created_at DESC LIMIT 1').first();
        scopeKey = first?.id || '';
      }
      const jobId = `cag_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const now = Date.now();
      await env.DB.prepare(
        "INSERT INTO cleaner_agent_jobs (id, user_id, scope, scope_key, prompt, dry_run, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)"
      ).bind(jobId, user.id, scope, scopeKey, String(args.prompt || ''), args.dry_run === false ? 0 : 1, now, now).run();
      deps.runInBackground(env, runCleanerAgentJob(env, jobId, {
        user, cfg, includeLinks: true, includeDocs: true, actorLabel: 'MCP', deps: deps.cleanerAgentDeps(),
      }));
      return { started: true, job_id: jobId, scope, scope_key: scopeKey };
    }
    case 'get_cleaner_agent_job': {
      await ensureCleanerAgentTable(env);
      const row = await env.DB.prepare('SELECT * FROM cleaner_agent_jobs WHERE id = ?').bind(String(args.job_id || '')).first();
      if (!row) throw new Error('Agent job not found');
      return { job: row };
    }
    case 'list_clone_jobs': {
      const { results } = await env.DB.prepare('SELECT id, chat_id, thread_id, community_id, target, status, processed, saved_links, saved_files, updated_at FROM index_jobs ORDER BY updated_at DESC LIMIT 30').all();
      return { jobs: results || [] };
    }
    case 'stop_clone_job': {
      await env.DB.prepare("UPDATE index_jobs SET status = 'stopping', updated_at = ? WHERE id = ? AND status IN ('queued','running')").bind(Date.now(), String(args.job_id || '')).run();
      return { stopping: true, job_id: args.job_id };
    }
    case 'manage_global_blacklist': {
      if (args.action === 'list') {
        const { results } = await env.DB.prepare("SELECT * FROM blacklist_rules WHERE scope = 'global' ORDER BY created_at DESC").all();
        return { rules: results || [] };
      }
      if (args.action === 'add') {
        const id = `bl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        await env.DB.prepare('INSERT INTO blacklist_rules (id, scope, scope_key, kind, pattern, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(id, 'global', '', String(args.kind || 'url'), String(args.pattern || '').trim(), user.id, Date.now()).run();
        return { added: true, id };
      }
      if (args.action === 'delete') {
        await env.DB.prepare("DELETE FROM blacklist_rules WHERE id = ? AND scope = 'global'").bind(String(args.id || '')).run();
        return { deleted: true, id: args.id };
      }
      throw new Error('Invalid blacklist action');
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export async function handleMcpHttpRequest(request, url, env, corsHeaders, deps) {
  await ensureMcpTokensTable(env);
  const pathToken = url.pathname.startsWith('/mcp/') ? decodeURIComponent(url.pathname.slice('/mcp/'.length)).split('/')[0] : '';
  const authHeader = request.headers.get('Authorization') || '';
  const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  const rawToken = pathToken || bearer || url.searchParams.get('token') || '';
  if (!rawToken) {
    return Response.json({ jsonrpc: '2.0', error: { code: -32001, message: 'MCP token required' } }, { status: 401, headers: corsHeaders });
  }

  const tokenHash = await sha256Hex(rawToken);
  const row = await env.DB.prepare('SELECT * FROM mcp_tokens WHERE token_hash = ?').bind(tokenHash).first();
  if (!row) {
    return Response.json({ jsonrpc: '2.0', error: { code: -32001, message: 'Invalid or revoked MCP token' } }, { status: 401, headers: corsHeaders });
  }
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(row.user_id).first();
  if (!user) {
    return Response.json({ jsonrpc: '2.0', error: { code: -32001, message: 'User not found' } }, { status: 401, headers: corsHeaders });
  }
  const isOwner = await deps.isInstanceOwnerUserAsync(user, env);
  const isAdmin = isOwner || (await isCommunityAdminInAny(env, user.id));
  if (row.role === 'owner' && !isOwner) {
    return Response.json({ jsonrpc: '2.0', error: { code: -32003, message: 'Owner rank revoked' } }, { status: 403, headers: corsHeaders });
  }
  if (row.role === 'admin' && !isAdmin) {
    return Response.json({ jsonrpc: '2.0', error: { code: -32003, message: 'Admin rank revoked' } }, { status: 403, headers: corsHeaders });
  }

  await env.DB.prepare('UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?').bind(Date.now(), row.id).run().catch(() => {});

  if (request.method === 'GET') {
    return Response.json({ ok: true, server: 'athena-mcp', role: row.role, protocolVersion: MCP_PROTOCOL_VERSION }, { headers: corsHeaders });
  }
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: corsHeaders });
  }

  const rpc = await request.json().catch(() => null);
  if (!rpc || typeof rpc !== 'object') {
    return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { status: 400, headers: corsHeaders });
  }

  const id = rpc.id ?? null;
  const method = String(rpc.method || '');
  const tools = row.role === 'owner' ? [...ADMIN_TOOLS, ...OWNER_ONLY_TOOLS] : ADMIN_TOOLS;

  if (method === 'notifications/initialized') {
    return new Response(null, { status: 202, headers: corsHeaders });
  }
  if (method === 'initialize') {
    return Response.json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: `athena-mcp-${row.role}`, version: '1.0.0' },
      },
    }, { headers: corsHeaders });
  }
  if (method === 'ping') {
    return Response.json({ jsonrpc: '2.0', id, result: {} }, { headers: corsHeaders });
  }
  if (method === 'tools/list') {
    return Response.json({ jsonrpc: '2.0', id, result: { tools } }, { headers: corsHeaders });
  }
  if (method === 'tools/call') {
    const toolName = String(rpc.params?.name || '');
    const toolArgs = rpc.params?.arguments || {};
    try {
      const allowedCommunities = await adminCommunityIds(env, user.id, isOwner);
      const result = await executeMcpTool(toolName, toolArgs, { env, user, role: row.role, allowedCommunities, deps });
      return Response.json({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
      }, { headers: corsHeaders });
    } catch (err) {
      return Response.json({
        jsonrpc: '2.0',
        id,
        result: { isError: true, content: [{ type: 'text', text: err?.message || 'Tool failed' }] },
      }, { headers: corsHeaders });
    }
  }

  return Response.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }, { status: 404, headers: corsHeaders });
}
