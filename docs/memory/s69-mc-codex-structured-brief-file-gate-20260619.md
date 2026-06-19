# s69-mc-codex structured brief file gate

Recorded: 2026-06-19 20:15 China time
Owner/prefix: `s69-mc-codex-`
Source project: `G:\codex-project\s69-mc-codex`
Source commit: `ee3fd5ab fix(writer): require structured brief files`

## Durable rule

Formal 40/80 episode writing stages require a real `OCTOS_BRIEF_FILE`.
`OCTOS_BRIEF` env text is smoke-only and must not be accepted for 40+ production.
`OCTOS_PRODUCTION_EPISODE_THRESHOLD=80` must not downgrade the formal 40 stage.

## Brief contract

The production brief gate requires labeled section bodies:

- title/project name
- format/platform
- one-line pitch
- story overview
- theme/value core
- protagonist
- world/background
- core conflict/antagonist
- character bio/relationships
- 40-episode arc/staged plan
- ending/card-hook plan

40->80 promotion proof also requires the previous stage `run_config.brief_source`
to start with `file:`.

## Verification

- Subagent review `Herschel`: `0 findings / APPROVE`
- Targeted tests: 79 passed
- Writer non-live: 170 passed / 13 deselected
- Determ tests: 47 passed
- Review tests: 9 passed
- py_compile passed
- No live provider launched
