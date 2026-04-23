---
name: skillpack-check
version: 1.0.0
description: |
  Run `gbrain skillpack-check` to produce an agent-readable JSON health report
  for the gbrain install. Wraps `gbrain doctor` + `gbrain apply-migrations
  --list` so a host agent (your OpenClaw's morning-briefing, any OpenClaw cron)
  can see at a glance whether the skillpack needs attention.

  Use when the user asks "is gbrain healthy?", when a cron fires a morning
  check, or proactively when something seems off (jobs not running, brain
  not updating, autopilot silent).
triggers:
  - "skillpack check"
  - "is gbrain healthy"
  - "gbrain health"
  - "check the brain"
  - "is the brain working"
tools:
  - shell
mutating: false
---

# Skillpack Check

## Contract

Running `gbrain skillpack-check` returns a JSON report with:

- **`healthy`** (bool): true if no action needed.
- **`summary`** (string): one-line summary safe to quote in a briefing.
- **`actions`** (string[]): every remediation command. If non-empty, run them.
- **`doctor`**: full `gbrain doctor --fast --json` output (filesystem checks).
- **`migrations`**: applied/pending/partial counts from `apply-migrations --list`.

Exit code:
- `0` — healthy, nothing to do.
- `1` — action needed. Read `actions[]` and execute.
- `2` — could not determine (binary crash or missing subcommand). Investigate.

## When to run

- **Daily cron** (e.g. your OpenClaw's `morning-briefing`): `gbrain skillpack-check --quiet`.
  Exit code alone tells you if anything is wrong; surface a one-liner in the
  briefing only when exit != 0. No JSON noise in happy-path briefings.
- **On demand**: `gbrain skillpack-check` for the full JSON when debugging.
- **In a CI pipeline**: same pattern — exit code gates, JSON is the evidence.

## What to do with the output

### Happy path (`healthy: true`)

Surface the summary in the agent's output only if asked. Nothing else.

### Action needed (`healthy: false`)

The `actions[]` array contains the commands to run, in order. Execute them:

```bash
for cmd in $(echo "$REPORT" | jq -r '.actions[]'); do
  eval "$cmd"
done
```

Common `actions[]` entries and what they mean:

- `gbrain apply-migrations --yes` — A migration is pending or half-finished.
  Run this (it's idempotent). If it exits `status: "partial"`, the host has
  non-builtin cron handlers that need plugin registration — follow
  `skills/migrations/v0.11.0.md`.
- `gbrain embed --stale` — Embeddings are stale.
- `gbrain check-backlinks --fix` — Dead links or missing back-links.
- Free-text action (no `Run:` prefix in the source message) — agent judgment
  needed. Quote it in the report for the user.

### Determine failure (`exit 2`)

Treat as urgent. Probably means the gbrain binary is missing from `$PATH` or
a required subcommand crashed. Check:

1. `which gbrain` returns a path
2. `gbrain --version` exits 0
3. `~/.gbrain/` is accessible

## Output format

```json
{
  "version": "0.11.1",
  "ts": "2026-04-18T12:34:56.789Z",
  "healthy": false,
  "summary": "gbrain skillpack needs attention: 1 action(s) — gbrain apply-migrations --yes",
  "actions": ["gbrain apply-migrations --yes"],
  "doctor": {
    "exit_code": 1,
    "checks": [
      { "name": "minions_migration", "status": "fail", "message": "MINIONS HALF-INSTALLED (partial migration: 0.11.0). Run: gbrain apply-migrations --yes" }
    ]
  },
  "migrations": {
    "applied_count": 0,
    "pending_count": 0,
    "partial_count": 1,
    "stdout": "..."
  }
}
```

## Anti-Patterns

- ❌ Running without `--quiet` in a cron that emails its output — you'll get
  the full JSON blob in every daily email. Use `--quiet` in crons.
- ❌ Ignoring exit code 2. A crashed doctor is worse than a failing check
  because you don't even know what's wrong.
- ❌ Running on every chat turn. Once per hour (or on user request) is plenty.
- ❌ Treating warnings as failures. Only `fail` status needs action;
  `warn` is informational.

## Output Format

The skill itself doesn't write files; it reports the CLI output verbatim to
the user (or to the agent's briefing pipeline). One-line summary first,
then the action list, then (only if relevant) the full JSON for debugging.

## Related

- `gbrain doctor` — the underlying filesystem + DB check. skillpack-check
  composes this.
- `gbrain apply-migrations --list` — the migration status view.
- `skills/migrations/v0.11.0.md` — the host-agent instruction manual for
  resolving `pending-host-work.jsonl` items.
- `docs/guides/minions-fix.md` — troubleshooting a half-migrated install.
