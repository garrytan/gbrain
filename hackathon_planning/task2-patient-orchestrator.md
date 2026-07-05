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
| **Suggest which skills to run** | ✅ done | `orchestrate_input` op (`src/core/orchestrator/`): gate → LLM select → rank → report. Real skill catalog + hybrid history retrieval + LLM selector wired; deterministic `no_llm` fallback. The core hinge — built. |
| Run skills | ✅ plumbing | `gbrain agent run` + minion job queue (fan-out/gather, steering). Not invoked by the op — execution is deliberately left to the caller (decision support). |
| Feedback loop | 🟡 plumbing + hook | Fan-out manifest + aggregator exist; the orchestrator adds a `priorSkillOutputs` re-ranking hook (`run.ts`). Driver loop still TODO. |

**Core gap:** no component takes `(new input + history + state)` and returns `ranked skills to
run`. Good news — this hinge shares a shape the repo already ships: the advisor's
**collectors → rank → ranked list** (`src/core/advisor/run.ts`). Clone that shape; feed it an
input.

## Built — `src/core/orchestrator/` + `orchestrate_input` op

Wired end-to-end (`gbrain orchestrate "<input>"` + MCP), mirroring the advisor's
collect → rank → report:
- **`custom-skills.ts` — the healthcare custom-skill policy.** Patient data routes ONLY to
  role-tagged clinical skills (reuses `SKILL_ROLES`), never generic GBrain skills. Enforced
  three ways: allowlist gate (`partitionSkills`), an `excluded_generic` audit trail (APPI), and
  a fail-closed `assertAllCustom` backstop.
- **`deps-live.ts`** — production wiring: `loadCandidateSkills` → skill catalog (real `role`),
  `retrieveHistory` → `hybridSearchCached` (scoped to `patient_id`), `select` → the LLM ranker.
- **`select-llm.ts`** — LLM selector via an injected `chat` (tool-calling + fence-tolerant
  fallback); re-validates every row against the eligible set by exact name + clinical role.
- **`select.ts`** — deterministic v0 fallback (`no_llm: true`), also used in tests.
- **`run.ts` / `types.ts`** — routing pass with injected seams; reuses the frozen `SkillRole` contract.
- **`operations.ts`** — registers `orchestrate_input` (read-scope; params `input`, `patient_id`,
  `history_limit`, `no_llm`).
- Container-verified (`oven/bun:1`): 9/9 orchestrator tests + `bun run typecheck` green.

## Reuse, don't build (Phase 0)

- History retrieval — `query` op + `hybridSearch` / `relationalRetrieval` (`src/core/search/`)
- Input → relevant records — `volunteer_context` (`src/core/context/volunteer.ts`)
- Rank-and-return skeleton — advisor (`src/core/advisor/run.ts`, `rankFindings`)
- Skill catalog — `list_skills` / `get_skill` ops (`src/core/operations.ts`)
- Execution — `gbrain agent run` + minions (`src/commands/agent.ts`, `minion-orchestrator`)

## Build plan

### 1. `orchestrate_input` op (net-new) — ✅ done
- Modelled on `src/core/advisor/run.ts` (collect → rank), accepting an input. ✅ (`run.ts`).
- Pipeline: `input + state` → retrieve history (`hybridSearchCached`) → skill selector → ranked
  skills. ✅ (`deps-live.ts`).
- `deps.loadCandidateSkills` wired to the real skill catalog (`buildSkillCatalog`,
  `SkillCatalogEntry.role`). ✅
- Registered in `src/core/operations.ts` as a `read`-scope op; CLI (`gbrain orchestrate`) + MCP
  generated from it. ✅

### 2. Skill selector — the missing hinge — ✅ done (LLM + v0 fallback)
- MVP: LLM ranks `list_skills` (descriptions + triggers) given `(input + history)`.
- `list_skills` now carries `role` (`nurse | psychiatrist | general-medicine`, landed #2) —
  filter/weight candidates by the target care lane before ranking. Import `SKILL_ROLES`
  from `src/core/skill-frontmatter.ts`; don't hardcode the set.
- This is exactly the seat the unimplemented `routing-eval --llm` placeholder was left for —
  `src/commands/routing-eval.ts:14`.
- Harden later: embedding similarity between input and skill descriptions; deterministic
  pre-filter before the LLM tie-break.

### 3. Execution — ✅ built (local-only, opt-in) via `orchestrate_run`
- `execute.ts` runs each recommended skill as a **subagent job** (`jobs submit subagent` path
  per `LOCAL-MODELS-SETUP.md`; `agent run` avoided). `makeQueueJobRunner` wires the minion queue;
  a fake runner keeps the logic unit-tested (`test/orchestrator-execute.test.ts`).
- `orchestrate_run` op (write-scope, **local-only**) = orchestrate + execute + feedback loop.
  `orchestrate_input` (read, suggest-only) stays the default — execution is explicit opt-in.
- Remaining: end-to-end validation on the live worker + model stack.

### 4. Feedback loop — ✅ driver done (`loop.ts`)
- `orchestrateLoop(ctx, deps, { executor })` re-ranks with executed skills' outputs each round;
  converges when a round surfaces no new skill (`maxRounds` backstop). Executor is injected — no
  executor → single suggest-only pass. Tested in `test/orchestrator-loop.test.ts`.
- The real executor (wiring `SkillExecutor` → `gbrain agent run`) is the one remaining piece,
  gated behind the auto-run-boundary decision (step 3).

## Guardrails (Phase 3)
- `routing-eval` fixtures covering representative patient cases (input → expected skills).
- Conformance + typecheck gates.
- Healthcare/compliance: patient data is sensitive under Japan's APPI (要配慮個人情報).
  Enforce source-isolation (`sourceScopeOpts`), keep an audit trail of what was auto-run, and
  gate auto-execution — the orchestrator suggests and supports decisions; it must not act as an
  autonomous diagnosis engine. Decide the auto-run boundary early; it shapes the whole design.

## Remaining
- **Live-stack validation** (the only unverified path) — on the LM Studio / Qwen stack
  (`LOCAL-MODELS-SETUP.md`), start a worker (`bun src/cli.ts jobs work`) and run
  **`bash hackathon_planning/orchestrate-smoke.sh`**. It exercises the real LLM selector
  (`orchestrate`) and real execution (`orchestrate-run`). The code is unit-tested via injected
  fakes; only the real DB/worker/model round-trip can't be exercised in CI here.

All Task 2 features are built:
- Steps 1–2: gate + LLM selector + history retrieval + `orchestrate_input` (read, suggest-only).
- Step 3: execution via `orchestrate_run` (write, local-only) — subagent jobs.
- Step 4: feedback-loop driver (`loop.ts`).
- LLM-selector replay: `orchestrate-smoke.sh` (real selector, not v0).
- Relational retrieval: `relational` per-call flag on both ops.
- 22 unit tests + routing-eval fixtures (container-green).

## Cross-link with Task 1
The skills this orchestrator ranks and runs are exactly the Nurse/Psychiatrist skills built and
maintained in **Task 1**. When Task 1 adds/splits/updates a skill (and its resolver rows), this
orchestrator automatically routes against the current set.
