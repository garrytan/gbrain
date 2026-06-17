# GBrain Upstream Base

Status: upstream documentation consolidation baseline

## Git

- Current branch: docs/consolidate-entrypoints-and-install-modes
- Pinned upstream commit: 70d5f36db60d435b40f83031473f1911f6bc2f9a
- Current branch state: rebased onto upstream/master at the pinned commit
- Current upstream version: 0.42.50.0

## Current release baseline

The consolidation baseline was refreshed after upstream advanced past the first
inventory pass. The changelog is now the first authority for documentation
drift checks: docs should be compared against the current release series before
rewrites are proposed.

Latest release entries reviewed:

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
origin	https://github.com/TheAngryPit/gbrain.git (fetch)
origin	https://github.com/TheAngryPit/gbrain.git (push)
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
