# AGENTS.md

`CLAUDE.md` is canonical.

Before making code changes, read and follow `CLAUDE.md`.

## Git workflow (MANDATORY — the owner's standing rule)

- NEVER push changes directly to `master`. This is non-negotiable.
- All work happens on the single persistent branch `dev` (the owner's branch).
- For every batch of changes:
  1. commit to `dev`, push `dev`
  2. open a PR `dev → master` (e.g. `gh pr create --base master --head dev`)
  3. wait for CodeRabbit review and the `check` pipeline (`npm run lint`,
     `npm run check:version`, gitleaks)
  4. address/acknowledge CodeRabbit comments; never merge with failing checks
  5. merge when review is done and the pipeline is green (`gh pr merge`)
- The `dev` branch is never deleted; it is the one branch used to PR into master.

