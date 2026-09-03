---
name: backend-doctor
description: Run Backend Doctor deep audits through verified local/source workflows, produce React-Doctor-style terminal summaries plus JSON/SARIF reports, triage findings across security, infrastructure, correctness, reliability, architecture, and maintainability, preview/apply safe fixes, and guide an agent through fixing issues until the Backend Doctor score reaches 100. Use after code changes, before commits, when auditing backend or full-stack repositories, or when users ask for all issues found by Backend Doctor.
---

# Backend Doctor Skill

Use this skill when the user asks to audit, review, clean up, harden, refactor, or verify a backend or full-stack codebase with Backend Doctor.

## Command Selection

Backend Doctor is not yet verified as a public npm package. Prefer verified local/source workflows from `/home/backend-doctor` until npm publication is real.

```bash
cargo run -q -p backend-doctor-cli -- <PROJECT> --deep --no-fail
```

Use the local npm wrapper when validating package-wrapper behavior inside the repository:

```bash
node npm/backend-doctor/bin/backend-doctor.js <PROJECT> --deep --no-fail
```

Use a staged local binary when release artifacts have been built:

```bash
/home/backend-doctor/dist/backend-doctor-x86_64-unknown-linux-gnu/backend-doctor <PROJECT> --deep --no-fail
```

If the release artifact is missing, use the debug build:

```bash
/home/backend-doctor/target/debug/backend-doctor <PROJECT> --deep --no-fail
```

After the package is published and `npm view backend-doctor version` succeeds, this can become the public workflow:

```bash
npx --yes backend-doctor@latest <PROJECT> --deep --no-fail
```

## Core Commands

Pretty React-Doctor-style report:

```bash
cargo run -q -p backend-doctor-cli -- <PROJECT> --deep --no-fail
```

Pretty report plus machine-readable files:

```bash
cargo run -q -p backend-doctor-cli -- <PROJECT> --deep --no-fail --json-out <PROJECT>/backend-doctor-report.json --sarif <PROJECT>/backend-doctor.sarif
```

Full verbose finding list:

```bash
cargo run -q -p backend-doctor-cli -- <PROJECT> --deep --verbose --no-fail
```

Numeric score only:

```bash
cargo run -q -p backend-doctor-cli -- <PROJECT> --deep --score --no-fail
```

Run project tests too, only after the first clean audit summary:

```bash
cargo run -q -p backend-doctor-cli -- <PROJECT> --deep --run-tests --no-fail --json-out <PROJECT>/backend-doctor-report.json --sarif <PROJECT>/backend-doctor.sarif
```

Preview safe automatic fixes:

```bash
cargo run -q -p backend-doctor-cli -- <PROJECT> --deep --fix-safe --dry-run --no-fail
```

Apply safe automatic fixes only after user approval:

```bash
cargo run -q -p backend-doctor-cli -- <PROJECT> --deep --fix-safe --yes --no-fail
```

## Agent Workflow

1. Run the pretty report first without `--score` and without `--run-tests`.
2. Save JSON/SARIF on the second run so findings can be grouped and tracked.
3. Treat score caps as blockers. If the report says the score is capped because raw secrets were found, triage secrets before lower-severity work.
4. Categorize findings into real release blockers, real lower-priority hardening, likely false positives or generated/sanitized artifacts, and safe automatic fixes.
5. For each high-impact category, inspect representative examples before applying broad fixes.
6. Fix in this order: raw secrets and sensitive logging; inline Compose/Docker secrets; auth/security configuration gaps; ignored/swallowed errors in production paths; missing HTTP/server timeouts; Docker root users; production placeholders; architecture and maintainability cleanup.
7. After each repair batch, rerun the pretty report and compare score/finding counts.
8. Use `--run-tests` after meaningful code changes to validate behavior.
9. Stop only when Backend Doctor reports `100 / 100`, or when remaining findings are documented false positives or accepted risks.

## Useful JSON Summaries

Total findings, severities, rules, and top files:

```bash
jq -r '
  .findings as $f |
  "Total findings: \($f | length)",
  "",
  "By severity:",
  ($f | sort_by(.severity // "unknown") | group_by(.severity // "unknown")[] |
    "  \(.[0].severity // "unknown"): \(length)"
  ),
  "",
  "By rule:",
  ($f | sort_by(.rule_id // .ruleId // "unknown") | group_by(.rule_id // .ruleId // "unknown") | sort_by(length) | reverse[] |
    "  \(length)x \(.[0].rule_id // .[0].ruleId // "unknown")"
  ),
  "",
  "Top files:",
  ($f | sort_by(.path // .file // .location.path // "unknown") | group_by(.path // .file // .location.path // "unknown") | sort_by(length) | reverse | .[:20][] |
    "  \(length)x \(.[0].path // .[0].file // .[0].location.path // "unknown")"
  )
' <PROJECT>/backend-doctor-report.json
```

First examples for a specific rule:

```bash
jq -r '.findings[] | select((.rule_id // .ruleId // "") == "<RULE_ID>") | "\(.path // .file // .location.path // "unknown"):\(.line // .location.line // 1) \(.message // .title // "")"' <PROJECT>/backend-doctor-report.json | head -20
```

## Important Flags

- Use `--deep` for the real audit.
- Use `--no-fail` while investigating so the command completes even when many issues exist.
- Do not use `--score` when the user wants the pretty report; it prints only the number.
- Use `--verbose` when the user wants every finding in terminal output.
- Use `--run-tests` only when test output and runtime cost are acceptable.
- Use `--json-out` and `--sarif` for durable reports.
- Use `--fix-safe --dry-run` before any automatic fix.

## Rules

- Never print raw secrets.
- Do not hide suppressed findings unless the user asks for a clean summary.
- Do not chase score 100 at the expense of intended architecture.
