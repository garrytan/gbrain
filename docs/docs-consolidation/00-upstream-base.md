# GBrain Upstream Base

Status: upstream documentation consolidation baseline

## Git

- Current branch: docs/consolidate-entrypoints-and-install-modes
- Pinned upstream commit: 814258dda67945ffec9457a1e73980e947b7e462
- Current branch state: rebased onto upstream/master at the pinned commit
- Current upstream version: 0.42.53.0

## Current release baseline

The consolidation baseline was refreshed after upstream advanced past the first
inventory pass. The changelog is now the first authority for documentation
drift checks: docs should be compared against the current release series before
rewrites are proposed.

Latest release entries reviewed:

- `0.42.53.0` - managed-Postgres sync no longer aborts at the first
  checkpoint; the durable-checkpoint pin now binds a real JSONB array instead
  of a double-encoded string, the same JSONB footgun is swept across the
  codebase, `gbrain eval suspected-contradictions` now handles an exact-alias
  result correctly, and a CI guard now catches the positional JSONB pattern
  that caused the regression.
- `0.42.52.0` - operational reliability hardening: autopilot now runs one
  brain-wide maintenance pass instead of per-source global work, the supervisor
  self-heals through transient database blips, `sources status` reports active
  syncs honestly, failed sources back off, `status --fast` / `--deadline-ms`
  provides budgeted snapshots, the sync stall watchdog aborts no-progress
  imports, minion timeout accounting is honest, and `agent run` parses trailing
  flags correctly.
- `0.42.51.0` - sync reliability/performance hardening: page-generation clock
  moved to a contention-free sequence, malformed checkpoints are
  repaired/constrained, `doctor` distinguishes active sync locks from stale
  syncs, and `sync --force-break-lock` reports no-lock cases honestly.
- `0.42.50.0` - CI reliability hardening: superseded PR runs cancel, jobs have
  explicit timeouts, E2E scrubs operator/agent environment variables, and
  workflow YAML is actionlint-checked.
- `0.42.49.0` - opt-in pacing for large embed backfills and shared DB pressure:
  `gbrain embed --stale --pace`, `pace.mode`, `GBRAIN_PACE_*`, sync shared
  permits, and pacing telemetry.
- `0.42.48.0` - brain repo durability hardening: `gbrain sources harden`,
  `gbrain sources pull`, `gbrain sources unharden`, out-of-repo PAT files, and
  `scripts/brain-commit-push.sh`.
- `0.42.47.0` - brain-resident skillpacks and advisor: `gbrain advisor`, MCP
  skill/advisor publishing toggles, and source-scoped skill reads.
- `0.42.46.0` - federated read scope for by-slug reads, tags, links, backlinks,
  and timeline when callers intentionally cross source boundaries.
- `0.42.45.0` - spend controls: `spend.posture`, `off`/`unlimited`, improved
  sync cost estimates, and non-TTY deferred embedding posture.
- `0.42.44.0` - personal-brain tutorial AlphaClaw link correction.
- `0.42.43.0` - push-based volunteered context, `volunteer_context`,
  `gbrain watch`, rolling-window retrieval reflex, volunteered-context feedback
  log, and transaction-pooler CI teardown coverage.
- `0.42.42.0` - bounded CLI teardown, truthful exit verdicts, PGLite error
  exit-code fix, and output flush fencing.
- `0.42.41.0` - conversation-fact durability, source write-through fix,
  reconnect support, PGLite lock hardening, source-grant read hardening, and
  doctor correctness work.

## Remotes

```
origin	analysis fork remote (fetch)
origin	analysis fork remote (push)
upstream	https://github.com/garrytan/gbrain.git (fetch)
upstream	https://github.com/garrytan/gbrain.git (push)
```

## Safety statement

No local Nexus runtime commands were run.

This fork/project is for upstream GBrain documentation analysis only.

Forbidden in this project:
- no local GBRAIN_HOME inspection
- no local GBRAIN_CORPUS_PATH inspection
- no Hermes/OpenClaw/Hindsight runtime inspection
- no gbrain init
- no gbrain sync
- no gbrain serve
- no gbrain auth
- no migrations
- no service starts/stops/restarts
