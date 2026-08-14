# AGENTS.md

Minimal fixture mimicking a GENERIC agent workspace — the shape
INSTALL_FOR_AGENTS.md's "any repo with a workspace" flow targets.
AGENTS.md lives at workspace root; skills live under `skills/`. No
manifest.json (the auto-derive path in `src/core/skill-manifest.ts`
handles this). Unlike `openclaw-reference-minimal/`, nothing here is
OpenClaw-specific: no OPENCLAW_WORKSPACE env, no plugin layout — just
a repo with a root AGENTS.md and a bare `skills/` directory. All
content is synthetic (alice-example style placeholders only).

## Brain operations

| Trigger | Skill |
|---------|-------|
| "what do we know about", "search for", "lookup" | `skills/query/SKILL.md` |
| any brain read/write/lookup/citation | `skills/brain-ops/SKILL.md` |
