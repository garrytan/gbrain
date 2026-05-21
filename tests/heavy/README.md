# tests/heavy/

Heavy ops-shape tests. Shell scripts that exercise gbrain end-to-end against
real infrastructure (Postgres, large fixtures, concurrent processes). Cost
minutes per run; NOT in default `bun test`.

## When to add a script here

Put a test here if it:
- Costs more than ~30s wallclock per run
- Needs real Postgres (not PGLite in-memory)
- Spins up multiple processes or measures concurrency
- Measures system metrics (RSS, latency under load, lock contention)
- Tests an upgrade / migration matrix against committed historical states

## When to use `*.slow.test.ts` instead

Put a slow test in `test/` with the `.slow.test.ts` suffix if it:
- Runs under `bun test` (TypeScript, uses bun:test imports)
- Is correctness-shaped, not ops-shaped (asserts behavior of one function)
- Can stub external dependencies

The two patterns coexist intentionally. `*.slow.test.ts` is per-file
correctness for cold paths; `tests/heavy/` is ops-shape scripts that don't
fit bun's test runner.

## How to run

```bash
# Run every script in this directory, sequentially:
bun run test:heavy

# Run a single script:
tests/heavy/<script>.sh
```

The runner is `scripts/run-heavy.sh`. It discovers every `tests/heavy/*.sh`
file at this directory's top level (NOT recursive), runs them in lexical
order, fails on the first non-zero exit.

## Naming convention

- `tests/heavy/<name>.sh` — top-level test script, picked up by the runner.
- `tests/heavy/_<name>.sh` — library/helper invoked by a sibling test.
  The leading underscore tells the runner to SKIP this file. Use this
  pattern for fixture builders, shared setup, anything that needs a
  required argument or isn't standalone-runnable.
- `tests/heavy/fixtures/<name>` — committed input data (SQL, JSON, etc).

## CI scheduling

Heavy tests run nightly at 08:17 UTC via `.github/workflows/heavy-tests.yml`,
and on PRs labeled `heavy-tests`. They are NOT part of the default PR CI
matrix — that gate stays fast.

## Failure output convention

Each script writes a per-run log to `~/.gbrain/audit/heavy-<script>-<ts>.log`
containing subprocess stdout/stderr, environment state, and any captured
metrics. The CI workflow uploads these as artifacts on failure for triage
without re-running locally.

## Style

- `#!/usr/bin/env bash`
- `set -euo pipefail`
- Explicit array argv for execs (no `eval`, no unquoted globs)
- Print a one-line `[<script>] <action>` log per major step
- Exit non-zero on any failure path; print enough context to diagnose
- Honor `$GBRAIN_HOME` / `$TMP_ROOT` env overrides where relevant

See `scripts/check-jsonb-pattern.sh` and `scripts/run-slow-tests.sh` for the
in-tree style reference.
