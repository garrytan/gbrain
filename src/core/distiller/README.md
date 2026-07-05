# distiller — turn brain data into skills (Task 1)

Takes a **candidate topic** distilled from stored brain data and decides how the
skill library should change: **create** a new skill, leave an existing one as-is
(**exact_match**), **update** it with the new data, or **split** it in two. Then
the create/update/split path keeps the orchestrator (RESOLVER) in sync.

Mirrors `src/core/orchestrator/` deliberately: a pure decision pass with injected
seams, so it runs with **no DB and no LLM** yet. It returns a PLAN
(`DistillReport`), not side effects — executing the plan (`skillify scaffold`,
`skillopt`, resolver categorize) is a CLI-side concern, exactly as the
orchestrator returns a report rather than running `gbrain agent run`.

## Shape

- `types.ts` — `CandidateTopic`, `ExistingSkill`, `DistillDecision`
  (`none | exact_match | update | split`), `DistillReport`. Reuses the frozen
  `SkillRole` contract from `skill-frontmatter.ts`.
- `decide.ts` — the decider (Q1+Q2+Q3). **v0 deterministic** token-overlap
  placeholder covering `none | exact_match | update`; the LLM classifier is an
  injected seam (marked TODO) and is the only producer of `split`.
- `run.ts` — one distillation pass: APPI role guard → optional brain-data
  enrichment → lane restriction → decide → framed report. Seams:
  `loadExistingSkills` (real: `list_skills`), `retrieveBrainData` (real:
  `query`/`search`), `classify` (real: LLM).

## Guardrails (APPI 要配慮個人情報)

- A topic must carry a **healthcare role** (`nurse | psychiatrist |
  general-medicine`); `run.ts` fail-closes otherwise. The role set and the
  clinical-lane check are the single source of truth shared with the
  orchestrator (`skill-frontmatter.ts` `SKILL_ROLES` /
  `orchestrator/custom-skills.ts` `isHealthcareRole`).
- Topics are compared **only within their own care lane** — a nurse topic is
  never matched against a psychiatrist skill.
- Skills are decision support, not autonomous diagnosis; distillation proposes,
  a human authors/approves.

## Status

First slice (decider + create path) landed. Remaining: wire `loadExistingSkills`
to the real `list_skills`, the LLM `classify` seam, and the create/update/split
executors (`skillify` / `skillopt` / resolver categorize) behind a CLI verb.
