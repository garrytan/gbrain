# Minions fix — repairing a half-migrated install

**tl;dr:** on v0.11.1+ everything should self-heal. If Minions is partially
set up (no `~/.gbrain/preferences.json`, autopilot still inline, cron jobs
still on `agentTurn`), run:

```bash
gbrain apply-migrations --yes
```

It's idempotent. On v0.11.1 installs that already migrated it's a cheap
no-op.

## Context

v0.11.0 shipped the Minions schema, queue, worker, and migration skill —
but the migration skill itself never fired on upgrade. `runPostUpgrade`
printed the feature pitch and stopped. v0.11.0 was never released
publicly; v0.11.1 is the first public Minions ship and fixes the
mega-bug (migration fires automatically on `gbrain upgrade` and via
the `postinstall` hook).

If you're on a pre-v0.11.1 branch build (e.g. running the
`minions-jobs` branch before v0.11.1 tagged), Minions may be installed
but not wired: schema is v7, but no `~/.gbrain/preferences.json`,
autopilot still runs inline, cron jobs still call `agentTurn`.

This guide covers both paths: the canonical v0.11.1+ fix, and the
stopgap for pre-v0.11.1 binaries that don't have `apply-migrations`.

## Detecting the half-migrated state

```bash
gbrain doctor
```

If the install is half-migrated, you'll see:

```
[FAIL] minions_migration: MINIONS HALF-INSTALLED (partial migration: 0.11.0). Run: gbrain apply-migrations --yes
```

or

```
[FAIL] minions_config: MINIONS HALF-INSTALLED (schema v7+ but no ~/.gbrain/preferences.json). Run: gbrain apply-migrations --yes
```

For a machine-readable report (cron-friendly):

```bash
gbrain skillpack-check --quiet && echo healthy || echo needs_action
gbrain skillpack-check | jq -r '.actions[]'    # prints the exact commands to run
```

## The fix (v0.11.1 or later)

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
~29 non-gbrain crons), the migration finishes with `status: "partial"`.
Your host agent walks the TODOs using `skills/migrations/v0.11.0.md` +
`docs/guides/plugin-handlers.md`, ships handler registrations in the
host repo, then re-runs `gbrain apply-migrations --yes`. Newly
registerable cron entries get rewritten and the JSONL rows mark
`status: "complete"`.

## The stopgap (pre-v0.11.1 binary, no apply-migrations yet)

If you're stuck on a branch build that doesn't have `apply-migrations`:

```bash
curl -fsSL https://raw.githubusercontent.com/garrytan/gbrain/v0.11.1/scripts/fix-v0.11.0.sh | bash
```

This bash script does what apply-migrations does from a shell environment:

1. `gbrain init --migrate-only` — schema v7.
2. `gbrain jobs smoke` — verify Minions health.
3. Prompt for `minion_mode` (defaults `pain_triggered` on non-TTY).
4. Write `~/.gbrain/preferences.json` atomically.
5. Append `~/.gbrain/migrations/completed.jsonl` with `status: "partial"`
   and `apply_migrations_pending: true`. That partial record is the
   signal to v0.11.1's `apply-migrations` to pick up remaining phases
   after the user upgrades.
6. Detect host agent repos and PRINT rewrite instructions (never
   auto-edits from a curl-piped script).
7. Print the next step: `Run: gbrain autopilot --install`.

Once v0.11.1 is installed, re-run `gbrain apply-migrations --yes` to
finish the remaining phases (host rewrites + autopilot install). The
stopgap's `status: "partial"` record is designed to resume cleanly
(it doesn't poison the permanent migration path).

## Verify the fix landed

```bash
# 1. Preferences exist and are readable
cat ~/.gbrain/preferences.json

# 2. Migration recorded
cat ~/.gbrain/migrations/completed.jsonl

# 3. Autopilot is supervising a Minions worker child
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
