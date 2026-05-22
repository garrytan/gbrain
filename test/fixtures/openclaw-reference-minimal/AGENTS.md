# AGENTS.md

Minimal fixture mimicking the OpenClaw reference deployment layout
(for W1 compat testing). AGENTS.md lives at workspace root; skills
live under `skills/`. No manifest.json (the auto-derive path in
`src/core/skill-manifest.ts` handles this).

## Gate 0 — access control

| Trigger | Skill |
|---------|-------|
| Every inbound message | `skills/signal-detector/SKILL.md` |

## Brain operations

| Trigger | Skill |
|---------|-------|
| "what do we know about", "search for", "lookup" | `skills/query/SKILL.md` |
| any brain read/write/lookup/citation | `skills/brain-ops/SKILL.md` |

## Calendar

| Trigger | Skill |
|---------|-------|
| "am I late", "how long until", "what time is" | `skills/context-now/SKILL.md` |
