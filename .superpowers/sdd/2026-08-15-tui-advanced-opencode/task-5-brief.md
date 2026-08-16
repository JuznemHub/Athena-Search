### Task 5: E2E verification + docs

**Files:**
- Modify: `tui/README.md` (add Advanced section)
- Test: `tui/smoke.mjs` (extend)

**Interfaces:**
- Consumes: all prior tasks

- [ ] **Step 1: Update tui/README.md Advanced section**

```md
## Advanced (opencode)

Press `Tab` or choose `Advanced (opencode)` → full opencode TUI with `athena` MCP.

- Any AI via `~/.config/opencode` (not website `user_ai_config`).
- Ranks enforced: `personal` GOD-only, `community` member-only.
- Paragraph search: `what is paragraph 5 of story.pdf` → `athena_get_chunk` with `para_idx`.
Requires `opencode` (`npm i -g opencode`) + `DATABASE_URL` + `pgvector`.
```

- [ ] **Step 2: Run `tui` smoke + manual**

Run: `node tui/smoke.mjs && node --test tui/src/mcp-athena.test.js tui/src/opencode-launcher.test.js`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tui/README.md
git commit -m "docs(tui): advanced opencode mode"
```

