# AGENTS.md

`CLAUDE.md` is canonical.

Before making code changes, read and follow `CLAUDE.md`.

## Git workflow (MANDATORY — the owner's standing rule)

- NEVER push changes directly to `master`. This is non-negotiable.
- All work happens on the single persistent branch `dev` (the owner's branch).
- **Local accumulation**: every batch of changes is committed to `dev` locally (on the VPS/workspace) and stays there. Do NOT push or open a PR after each small fix — batch fixes stay local until the owner says `open pr`.
- When the owner says `open pr` (exact phrase): push `dev`, open a single combined `dev → master` PR that bundles all accumulated changes, then run the usual pipeline. Every PR commit/message is filtered through the anti-slop skill before creation.
- For each `open pr` cycle:
  1. `git push origin dev`
  2. `gh pr create --base master --head dev` (or reuse existing open PR #)
  3. wait for CodeRabbit review and the `check` pipeline (`npm run lint`, `npm run check:version`, `gitleaks`, CodeQL)
  4. apply the GitHub Actions anti-slop skill to the PR body/commits before requesting review
  5. address/acknowledge CodeRabbit comments; never merge with failing checks
  6. merge when review is done and the pipeline is green (`gh pr merge --squash`)
- On `master`: after a squash-merge, sync `dev` to `origin/master` via `git merge origin/master` (no force-push — `dev` is protected).
- The `dev` branch is never deleted; it is the one branch used to PR into master.

## OpenCode instance

- This repo is configured for **OpenCode** (`opencode.json`) with the `superpowers` plugin and the following skills:
  - `tgbot-test-skill` (project, already present — do not reinstall)
  - `firecrawl`, `composio`, `frontend-design` (global opencode skills — already installed, reused from `~/.config/opencode/skills`)
  - `stop-slop` + anti-slop bundle (`peakoss/anti-slop`, `miqdadbadjuber/anti-slop`, `petergyang/no-ai-slop`) — applied to every PR/commit/message
  - `caveman` (token-efficient replies, opt-in via "caveman mode")
  - `backend-doctor` (health/diagnostics, via `ZypherHQ/backend-doctor`)
  - top-100 AI Agents catalog (reference: https://github.com/yuxiaopeng/Github-Ranking-AI/blob/main/Top100/AI%20Agents.md) and VoltAgent awesome-agent-skills (https://github.com/VoltAgent/awesome-agent-skills) — used as a menu for agent selection, not all installed by default
- Multiple agents are available via `/root/.config/opencode/agent`: `architect`, `debugger`, `frontend-designer`, `researcher`, `reviewer`, `technical-writer`. The opencode TUI routes work through them; direct CLI uses `opencode run --agent <name> "…"`.

## Anti-slop

- Every PR body, commit message, and user-facing doc is passed through `stop-slop` (and the `anti-slop` GitHub Action on PRs) before merge. No AI tells: no "delve/crucial/robust/seamless/leverage/tapestry", no throat-clearing, no triplets, no rhetorical questions.
