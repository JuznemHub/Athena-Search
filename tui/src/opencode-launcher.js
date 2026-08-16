import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function launchAdvanced(state, io = {}, _theme) {
  const env = io?.env ?? process.env;
  const dir = await mkdtemp(join(tmpdir(), 'athena-opencode-'));
  const mcpPath = new URL('./mcp-athena.js', import.meta.url).pathname;
  const cfg = {
    $schema: 'https://opencode.ai/config.json',
    mcp: {
      athena: {
        type: 'local',
        command: ['node', mcpPath],
        enabled: true,
        env: {
          ATHENA_INSTANCE: state.instance ?? '',
          ATHENA_TOKEN: state.token ?? '',
          ATHENA_COMMUNITY_ID: state.community_id ?? '',
          DATABASE_URL: env.DATABASE_URL ?? process.env.DATABASE_URL ?? '',
        },
        // keep environment for compat with older opencode
        environment: {
          ATHENA_INSTANCE: state.instance ?? '',
          ATHENA_TOKEN: state.token ?? '',
          ATHENA_COMMUNITY_ID: state.community_id ?? '',
          DATABASE_URL: env.DATABASE_URL ?? process.env.DATABASE_URL ?? '',
        },
      },
    },
  };
  await writeFile(join(dir, 'opencode.json'), JSON.stringify(cfg, null, 2));
  // Session artifacts: /athena strict-mode toggle, /athena-study deep-research
  // command, /athena-ingest command, project AGENTS.md conventions, and an
  // athena-researcher subagent that pulls document content in parallel.
  const { mkdir } = await import('node:fs/promises');
  const athenaCmd = `---\ndescription: Toggle Athena strict mode — /athena alone toggles, /athena <query> searches Athena first\n---\n\n$ARGUMENTS\n\nIf $ARGUMENTS is empty or whitespace, toggle Athena strict mode for this session: check if athena strict mode is ON (you were told to use athena_search first), if ON then turn it OFF and say "Athena strict mode OFF — back to default opencode (use /athena <query> for one-shot or /athena to toggle ON again)"; if OFF then turn it ON and say "Athena strict mode ON — will use athena_search first before any outside search (use /athena again to toggle OFF)".\n\nIf $ARGUMENTS is not empty, strictly fetch from Athena first for that query: call athena_search (personal then community, limit 10) for $ARGUMENTS and cite [#doc_id], use athena_get_chunk with para_idx/line_number for verbatim lines. Never answer from training data when athena has hits. Query: $ARGUMENTS\n`;

  const studyCmd = `---\ndescription: Deep-study a topic from the Athena brain — cross-document research notes, not a 2-line answer\n---\n\nStudy topic: $ARGUMENTS\n\nProduce a structured study document compiled from the Athena brain. This is research, not a quick answer — take the time to read sources fully.\n\n## Workflow\n\n1. **Survey**: call athena_search for the topic with limit 15, both scopes that are permitted (personal needs GOD; if it errors, continue with community). List what you found.\n2. **Load sources**: for the 3–6 most relevant doc_ids call athena_get_doc to read full content. For very long docs, read more chunks via athena_get_chunk when a section needs closer inspection.\n3. **Cross-link**: while reading, note where documents agree, contradict, or extend each other. Explicitly connect claims across sources ("doc A says X; doc B qualifies this with Y").\n4. **Compile** the study notes (this is the deliverable):\n\n\`\`\`markdown\n# <Topic> — study notes\n\n## Summary (5–10 sentences, own words, every claim cited)\n\n## Key concepts\n- <concept> — explanation [#doc_id ...]\n\n## Cross-document connections\n- <how sources relate/contradict/extend each other>\n\n## Verbatim passages worth keeping (blockquote + [#doc_id:chunk pN])\n\n## Open questions & gaps (what the brain does NOT answer — mark clearly)\n\n## Source index (doc_id, title, why it mattered)\n\`\`\`\n\n## Rules\n\n- Every factual claim carries a citation in the form [#doc_id] (or [#doc_id:chunkN pM] for verbatim lines).\n- NEVER pad with training-data knowledge presented as sourced. Outside knowledge may only appear in a clearly-marked "context beyond the brain" aside.\n- If the brain has nothing on the topic, say so plainly and stop — do not fabricate a study document.\n`;

  const ingestCmd = `---\ndescription: Ingest content into the Athena brain — dedupe check, clean filename, tags, chunked dump\n---\n\nIngest the following into Athena: $ARGUMENTS\n\n## Workflow\n\n1. **Identify what to ingest**: the argument is either pasted content, a file path on this machine (read it), or an instruction like "the notes we just discussed in this session" (collect them from the conversation).\n2. **Dedupe first**: athena_list the target scope and check whether a document with a similar name/content already exists. If it does, tell the user and ask whether to keep both or replace (athena_dump upserts same filename).\n3. **Pick a filename**: lowercase, hyphens, short but descriptive, extension .md. Examples: \`karpathy-llm-wiki-pattern.md\`, \`rust-async-bookmarks-notes.md\`.\n4. **Prepare content**: keep the original text verbatim — no summarizing, no reformatting beyond fixing broken line wraps. Prepend a short metadata header:\n\n\`\`\`markdown\n---\nsource: <url or "session notes" or "paste">\ningested: <date>\ntags: [comma, separated, 3-6, lowercase]\n---\n\`\`\`\n\n5. **Dump**: athena_dump with scope (community unless the user asked personal — personal is GOD-only), the filename, and the content.\n6. **Report**: filename, chunk count, and the first athena_search query that now finds it. Verify with that search.\n`;

  const commands = [
    ['athena.md', athenaCmd],
    ['athena-study.md', studyCmd],
    ['athena-ingest.md', ingestCmd],
  ];
  for (const cmdDir of [join(dir, 'command'), join(dir, 'commands'), join(dir, '.opencode', 'commands')]) {
    await mkdir(cmdDir, { recursive: true });
    for (const [name, body] of commands) await writeFile(join(cmdDir, name), body);
  }

  const researcherAgent = `---\ndescription: Pulls Athena documents for a research topic and returns condensed, citation-tagged extracts\nmode: subagent\n---\n\nYou are the Athena researcher. You are given doc_ids (and optionally a focus question). For each doc_id call athena_get_doc; if a doc is missing, try athena_search with its title to locate the current doc_id. Return for every document:\n\n- doc_id and title\n- 5-15 bullet points covering its substance relative to the focus (not generic summary — pull the actual claims, numbers, definitions)\n- verbatim quotes for the 2-4 most important sentences, tagged [#doc_id:chunkN pM]\n- one line on how it relates to the other doc_ids in this batch\n\nDo not answer the focus question yourself — that is the primary agent's job. You only extract and inter-relate. If a doc_id yields nothing, say so explicitly rather than guessing from other docs.\n`;
  for (const agentDir of [join(dir, 'agent'), join(dir, '.opencode', 'agent')]) {
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, 'athena-researcher.md'), researcherAgent);
  }

  const agentsMd = `# Athena brain session\n\nThis opencode session is wired to an Athena Search instance via the \`athena\` MCP server.\n\n## Tools\n\n- \`athena_search(query, scope, limit)\` — full-text search over the brain (community scope; personal is GOD-only)\n- \`athena_get_doc(doc_id, scope)\` — all chunks of a document\n- \`athena_get_chunk(doc_id, para_idx, scope)\` — one chunk for verbatim lines\n- \`athena_dump(content, filename, scope)\` — ingest text into the brain (chunked, upsert by filename)\n- \`athena_list(scope, limit)\` — what is already in the brain\n\n## Conventions\n\n1. **Athena first.** For anything the brain might know, athena_search before answering from training data. \`/athena\` toggles strict mode; \`/athena <query>\` is a one-shot strict lookup.\n2. **Citations.** Claims sourced from the brain cite \`[#doc_id]\`; verbatim lines cite \`[#doc_id:chunkN pM]\`. Never attach a citation to knowledge that did not come from the brain.\n3. **Studying beats skimming.** For "explain X from my docs" requests use \`/athena-study\` behavior: load full docs with athena_get_doc, cross-link claims between documents, mark gaps explicitly. Default answers may stay short; study requests must not.\n4. **Ingestion discipline.** New content goes in via \`/athena-ingest\` rules: dedupe against athena_list first, verbatim content, tagged metadata header, hyphenated filename.\n5. **Scope honesty.** If a scope/tool errors (rank gate, missing community), say what is inaccessible and continue with what is — do not silently fall back to training data.\n6. **Parallel research.** When loading 3+ documents for one question, dispatch the athena-researcher subagent with the doc_ids and the focus question, then compose from its extracts.\n`;
  await writeFile(join(dir, 'AGENTS.md'), agentsMd);
  return new Promise((resolve) => {
    let settled = false;
    // opencode [project] defaults to TUI; dir is the project with opencode.json
    const child = spawn('opencode', [dir], { stdio: 'inherit', env });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      const msg = e.message || String(e);
      const notFound = /ENOENT/i.test(msg) || /not found/i.test(msg);
      rm(dir, { recursive: true, force: true }).finally(() => {
        resolve({ error: notFound ? `opencode not found: ${msg}` : msg });
      });
    });
    child.on('close', async (code) => {
      if (settled) return;
      settled = true;
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      resolve({ code });
    });
  });
}

let _availableCache = null;
let _availableExpires = 0;

export function isOpencodeAvailable() {
  const now = Date.now();
  if (_availableCache !== null && now < _availableExpires) return _availableCache;
  try {
    const r = spawnSync('opencode', ['--version'], { stdio: 'ignore', timeout: 2000 });
    if (r.error) {
      _availableCache = false;
    } else {
      _availableCache = r.status === 0;
    }
  } catch {
    _availableCache = false;
  }
  _availableExpires = now + 30_000;
  return _availableCache;
}

export function __resetAvailableCacheForTests() {
  _availableCache = null;
  _availableExpires = 0;
}
