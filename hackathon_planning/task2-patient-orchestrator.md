# Task 2 — Patient orchestrator

> **Start here:** read [`00-setup-and-split.md`](./00-setup-and-split.md) for the frozen
> interface contract, shared-file ownership, and the 3-way split before picking up work.

Take new patient input, weigh it against historical information + current state, and suggest
which skills to run — feeding each skill's output back so later routing can build on earlier
results.

> Scope note: excludes the database/engine layer. Retrieval + storage are treated as a
> given black box.

## Current-state map (flowchart → repo)

| Flowchart node | Status | What backs it today |
|---|---|---|
| Patient input (new state) | ✅ | `query` op / `volunteer_context` are entry points. |
| Historical information | ✅ strong | Hybrid + relational retrieval (`hybridSearch`, `relationalRetrieval` in `src/core/search/`). |
| Weigh new state vs. history | ✅ substrate | Same retrieval layer. |
| **Suggest which skills to run** | 🔨 in progress (PR) | Rough template landed in `src/core/orchestrator/` (gate → select → rank → report). v0 deterministic selector; the LLM ranker is a marked TODO. This was *the* core hinge — now scaffolded. |
| Run skills | ✅ plumbing | `gbrain agent run` + minion job queue (fan-out/gather, steering). |
| Feedback loop | 🟡 plumbing + hook | Fan-out manifest + aggregator exist; the orchestrator adds a `priorSkillOutputs` re-ranking hook (`run.ts`). Driver loop still TODO. |

**Core gap:** no component takes `(new input + history + state)` and returns `ranked skills to
run`. Good news — this hinge shares a shape the repo already ships: the advisor's
**collectors → rank → ranked list** (`src/core/advisor/run.ts`). Clone that shape; feed it an
input.

## Built so far — branch `worktree-nick+orchestrator-work` (in PR)

Rough template at `src/core/orchestrator/`, mirroring the advisor's collect → rank → report:
- **`custom-skills.ts` — the healthcare custom-skill policy.** Patient data routes ONLY to
  role-tagged clinical skills (reuses `SKILL_ROLES`), never generic GBrain skills. Enforced
  three ways: allowlist gate (`partitionSkills`), an `excluded_generic` audit trail (APPI), and
  a fail-closed `assertAllCustom` backstop.
- **`run.ts`** — one routing pass; history retrieval + skill loading are injected seams, so it
  runs with no DB dependency yet.
- **`select.ts`** — v0 deterministic trigger-overlap ranker; the LLM selector is a marked TODO.
- **`types.ts`** — reuses the frozen `SkillRole` contract, so the selector and the parser can't drift.
- Container-verified (`oven/bun:1`): orchestrator tests + `bun run typecheck` green.

## Reuse, don't build (Phase 0)

- History retrieval — `query` op + `hybridSearch` / `relationalRetrieval` (`src/core/search/`)
- Input → relevant records — `volunteer_context` (`src/core/context/volunteer.ts`)
- Rank-and-return skeleton — advisor (`src/core/advisor/run.ts`, `rankFindings`)
- Skill catalog — `list_skills` / `get_skill` ops (`src/core/operations.ts`)
- Execution — `gbrain agent run` + minions (`src/commands/agent.ts`, `minion-orchestrator`)

## Build plan

### 1. `orchestrate_input` op (net-new) — 🔨 pipeline built; op not yet registered
- Model directly on `src/core/advisor/run.ts` (collectors → rank), but accept an input. ✅ done
  (`src/core/orchestrator/run.ts`).
- Pipeline: `input + state` → retrieve history (`query` / `volunteer_context`) →
  **skill selector** → ranked skills. ✅ shape done; retrieval is still an injected stub.
- Wire `deps.loadCandidateSkills` to the real `list_skills` (`SkillCatalogEntry`,
  `src/core/skill-catalog.ts` — now carries `role`). ⬜
- Register in `src/core/operations.ts` as a `read`-scope op so CLI + MCP are generated from it. ⬜
  (shared file — Dev A arbitrates.)

### 2. Skill selector — the missing hinge — 🔨 v0 placeholder done; LLM ranker TODO
- MVP: LLM ranks `list_skills` (descriptions + triggers) given `(input + history)`.
- `list_skills` now carries `role` (`nurse | psychiatrist | general-medicine`, landed #2) —
  filter/weight candidates by the target care lane before ranking. Import `SKILL_ROLES`
  from `src/core/skill-frontmatter.ts`; don't hardcode the set.
- This is exactly the seat the unimplemented `routing-eval --llm` placeholder was left for —
  `src/commands/routing-eval.ts:14`.
- Harden later: embedding similarity between input and skill descriptions; deterministic
  pre-filter before the LLM tie-break.

### 3. Execution — ⬜ not started
- `gbrain agent run` per selected skill.
- Respect `pain_triggered` routing (native subagent first, minions on pain signals) per
  `skills/conventions/subagent-routing.md`.

### 4. Feedback loop — 🟡 hook present (`priorSkillOutputs`); driver TODO
- Two options for "outputs inform next routing":
  - **(a)** fan-out manifest + aggregator (existing plumbing), or
  - **(b)** re-invoke `orchestrate_input` with prior skill outputs appended to `state`.
- **(b) is cleanest** for the loop in the diagram — the orchestrator re-ranks with new evidence
  each pass; stop when no new skills are suggested.

## Guardrails (Phase 3)
- `routing-eval` fixtures covering representative patient cases (input → expected skills).
- Conformance + typecheck gates.
- Healthcare/compliance: patient data is sensitive under Japan's APPI (要配慮個人情報).
  Enforce source-isolation (`sourceScopeOpts`), keep an audit trail of what was auto-run, and
  gate auto-execution — the orchestrator suggests and supports decisions; it must not act as an
  autonomous diagnosis engine. Decide the auto-run boundary early; it shapes the whole design.

## Suggested first slice
Steps 1 + 2 (the `orchestrate_input` op + LLM skill selector). Highest-value missing piece,
demo-able on its own, and cloning the advisor's shape means filling a known-shaped hole rather
than inventing architecture.

## Cross-link with Task 1
The skills this orchestrator ranks and runs are exactly the Nurse/Psychiatrist skills built and
maintained in **Task 1**. When Task 1 adds/splits/updates a skill (and its resolver rows), this
orchestrator automatically routes against the current set.
