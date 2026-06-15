# GBrain Upstream Base

Status: upstream documentation consolidation baseline

## Git

- Current branch: docs/consolidate-entrypoints-and-install-modes
- Pinned upstream commit: 090bb53203557f5659563ea28c1c847c32167aeb
- Current branch merge commit: 416f2ae29788a16cba1b20fb33ccf05a4eb665c1
- Current upstream version: 0.42.44.0

## Current release baseline

The consolidation baseline was refreshed after upstream advanced past the first
inventory pass. The changelog is now the first authority for documentation
drift checks: docs should be compared against the current release series before
rewrites are proposed.

Latest release entries reviewed:

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
