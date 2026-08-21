# Contributing to Athena Search

AI-assisted contributions are welcome — this project itself is largely vibe-coded.
The bar below exists so quality survives the pace.

## The one rule

**You are responsible for everything you push — including code your AI wrote.**
"the model generated it" is not an excuse for a broken build, a leaked secret,
or a drive-by refactor. Review your own diff before opening the PR; if you
cannot explain what a hunk does, do not submit it.

## PR guidelines

1. **One logical change per PR.** No drive-by refactors, no reformatting mixed
   with features, no "while I was here".
2. **Small enough to review.** If the diff exceeds ~400 lines excluding
   lockfiles, split it.
3. **Conventional Commits** (`feat:`, `fix:`, `docs:`, `chore:` …) and a PR
   title that matches.
4. **CI must be green**: `npm run lint`, `npm run check:version`,
   `npm run test:unit`, TUI tests, gitleaks. Local equivalents:

   ```bash
   npx eslint worker/ server/ public/ scripts/
   npm run check:version && npm run test:unit
   cd tui && npm test
   ```

5. **No secrets, ever.** `.env` never leaves your machine. Gitleaks scans every
   PR and full history; a leaked credential means force-push history rewrite
   and key rotation — do not make us do that.
6. **Respect the architecture** (see [CLAUDE.md](CLAUDE.md)):
   - PostgreSQL is the only store; new tables go through `worker/schema.sql`
     or lazy `ensure*Table()` with idempotent columns.
   - One codebase, two runtimes: gate Cloudflare-only / Node-only code behind
     `isSelfHosted(env)`.
   - New `env.FOO` reads need an entry in `ALLOWED_ENV` (server/index.js).
   - Security invariants in CLAUDE.md are not suggestions.
7. **AI-generated code must be verified**: run the relevant tests, exercise the
   feature against a running instance, and read every line you commit.

## Repeated low-effort PRs

Pattern-matched spam, unreviewed AI dumps, PRs that ignore this guide, or
multiple broken builds in a row will get contributors blocked without further
warning. Maintainers' time is the scarcest resource here.

## Workflow

- Branch from `dev`; PRs target **dev → master** (never push to master).
- Wait for CodeRabbit + CI; address findings before requesting merge.
- Squash-worthy commits will be squash-merged.
