# Minions fix: repairing a half-migrated install

**tl;dr:** Minions self-heals on upgrade. If an install is only partially
set up (no `~/.gbrain/preferences.json`, autopilot still inline, cron jobs
still on `agentTurn`), run:

```bash
gbrain apply-migrations --yes
```

It's idempotent. On an install that already migrated it's a cheap no-op.

## Context

The Minions schema, queue, worker, and migration skill ship together, and
the migration fires automatically on `gbrain upgrade` and via the
`postinstall` hook. An install is half-migrated when the schema is present
but the migration never completed: no `~/.gbrain/preferences.json`,
autopilot still runs inline, cron jobs still call `agentTurn`. This guide
covers detecting that state and finishing the migration.

## Detecting the half-migrated state

```bash
gbrain doctor
```

If the install is half-migrated, you'll see the `minions_migration` check
fail:

```
[FAIL] minions_migration: MINIONS HALF-INSTALLED (partial migration: 0.11.0). Run: gbrain apply-migrations --yes
```

(Missing `~/.gbrain/preferences.json` on a fresh install is a valid
pre-`apply-migrations` state — doctor deliberately does NOT fail on that
alone; the partial-migration record is the canonical half-migration signal.)

For a machine-readable report (cron-friendly):

```bash
gbrain skillpack-check --quiet && echo healthy || echo needs_action
gbrain skillpack-check | jq -r '.actions[]'    # prints the exact commands to run
```

## The fix

```bash
gbrain apply-migrations --yes
```

Reads `~/.gbrain/migrations/completed.jsonl`, diffs against the TS
migration registry, runs whatever's pending. Seven phases:

```
A. Schema        gbrain init --migrate-only
B. Smoke         gbrain jobs smoke
C. Mode          prompt (or --yes default pain_triggered)
D. Prefs         write ~/.gbrain/preferences.json
E. Host          AGENTS.md marker injection + cron rewrites for gbrain
                 builtins; JSONL TODOs for host-specific handlers
F. Install       gbrain autopilot --install (env-aware)
G. Record        append completed.jsonl status:"complete"
```

If Phase E emits TODOs for host-specific handlers (e.g. your OpenClaw's
own non-gbrain crons), the migration finishes with `status: "partial"`.
Your host agent walks the TODOs using `skills/migrations/v0.11.0.md` +
`docs/guides/plugin-handlers.md`, ships handler registrations in the
host repo, then re-runs `gbrain apply-migrations --yes`. Newly
registerable cron entries get rewritten and the JSONL rows mark
`status: "complete"`.

## Verify the fix landed

```bash
# 1. Preferences exist and are readable
cat ~/.gbrain/preferences.json

# 2. Migration recorded
cat ~/.gbrain/migrations/completed.jsonl

# 3. Autopilot is supervising a Minions worker child
# (the exit code is the verdict — 0 fresh, 1 needs attention,
#  2 self-disabled — so a nonzero exit here IS the finding, not a
#  broken verify step. Under `set -e`, append `|| true` to keep going.)
gbrain autopilot --status
ps aux | grep 'jobs work'

# 4. Jobs show up in the queue
gbrain jobs list

# 5. Any host-specific TODOs still pending
cat ~/.gbrain/migrations/pending-host-work.jsonl 2>/dev/null || echo "(none — all host work is done)"

# 6. Doctor + skillpack-check should both be clean
gbrain doctor
gbrain skillpack-check --quiet && echo ok
```

## If the fix fails

Each phase is idempotent. Re-running is safe. Common failure modes:

- **Phase B smoke fails:** the schema didn't apply. Check
  `~/.gbrain/config.json` has a valid `database_url` (or `database_path`
  for PGLite). Run `gbrain init --migrate-only` directly and look at
  the error.
- **Phase F install fails:** your host environment doesn't match any
  detected target. Pass `--target <macos|linux-systemd|ephemeral-container|linux-cron>`
  explicitly.
- **Pending host work never clears:** your host agent hasn't shipped
  handler registrations yet. Read
  `~/.gbrain/migrations/pending-host-work.jsonl`, open
  `skills/migrations/v0.11.0.md`, and follow the host-agent instruction
  manual.

## Related

- `skills/migrations/v0.11.0.md` — full migration skill for host agents.
- `skills/skillpack-check/SKILL.md` — when and how to run the health check.
- `docs/guides/plugin-handlers.md` — plugin contract for host-specific
  handlers.
- `skills/conventions/cron-via-minions.md` — the canonical cron rewrite
  pattern.
