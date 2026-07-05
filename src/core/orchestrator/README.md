# orchestrator/ — patient orchestrator (Task 2)

Takes a new patient input + state, weighs it against retrieved history, and returns a **ranked
list of skills to run**. Mirrors the advisor's `collect → rank → report` shape.

> Status: **wired end-to-end.** Exposed as the `orchestrate_input` op (`gbrain orchestrate
> "<input>"` + MCP). Real skill loading (skill catalog), history retrieval (hybrid search), and
> the LLM selector are all connected; a deterministic fallback selector and injected seams keep
> the core unit-testable with no DB/LLM. The orchestrator **suggests** skills — executing them is
> intentionally left to the caller (decision support, not autonomous diagnosis).

## The load-bearing rule

**For healthcare / patient data we run our OWN custom clinical skills — never generic GBrain
skills.** See `custom-skills.ts`. The gate is an **allowlist by role**: a skill is eligible only
if its `SKILL.md` frontmatter declares `role: nurse | psychiatrist | general-medicine` (the
frozen `SkillRole` contract in `skill-frontmatter.ts`). Every generic
bundled GBrain skill (query, ingest, maintain, …) lacks that role and is therefore ineligible for
patient routing.

- Eligible skills → selected + ranked.
- Generic skills that *would* have matched → recorded in `excluded_generic` for the audit trail
  (APPI 要配慮個人情報), never run.
- `assertAllCustom()` is a fail-closed backstop: if a future selector bug ever proposes a
  non-clinical skill, the run throws instead of leaking patient data.

## Files

| File | Role |
|---|---|
| `types.ts` | Core types (`PatientInput`, `CandidateSkill`, `OrchestratorReport`, …). |
| `custom-skills.ts` | **The policy.** Role allowlist, partition, fail-closed assert. |
| `select.ts` | Deterministic v0 selector (trigger overlap). Fallback + used in tests. |
| `select-llm.ts` | **LLM selector** — ranks eligible skills via an injected `chat`; re-validates output against the eligible set. |
| `deps-live.ts` | Production wiring: skill catalog + hybrid retrieval + LLM `chat`. |
| `run.ts` | One routing pass. Injected deps for history retrieval + skill loading. |
| `loop.ts` | Feedback-loop driver — re-ranks with executed skills' outputs until it converges (injected executor; suggest-only with none). |
| `execute.ts` | Real `SkillExecutor` — runs a skill as a subagent job (`jobs submit subagent` path per LOCAL-MODELS-SETUP.md); `makeQueueJobRunner` wires the minion queue. |

Two ops in `src/core/operations.ts`: **`orchestrate_input`** (read-scope, suggest-only;
`gbrain orchestrate`) and **`orchestrate_run`** (write-scope, **local-only**; `gbrain
orchestrate-run`) which additionally executes the recommended skills via subagent jobs and runs
the feedback loop. Execution requires a running `gbrain jobs work` worker + a chat model.

## Data flow (`orchestrate_input`)

1. `deps.loadCandidateSkills` → `buildSkillCatalog` (`skill-catalog.ts`) → `CandidateSkill[]` (with `role`).
2. `deps.retrieveHistory` → `hybridSearchCached` (`search/hybrid.ts`), scoped to `patient_id`.
3. Gate to custom clinical skills (`custom-skills.ts`).
4. `select-llm.ts` ranks them via `chat` (`ai/gateway.ts`); `no_llm: true` uses the v0 fallback.
5. Fail-closed `assertAllCustom`, return the ranked `OrchestratorReport`.

## Feedback loop

`loop.ts` `orchestrateLoop(ctx, deps, { executor })` drives it: each round runs the orchestrator,
executes the newly-recommended skills via the injected `executor`, appends their outputs to
`priorSkillOutputs`, and re-ranks. It converges when a round surfaces no new skill (`maxRounds` is
a backstop). With **no executor** it does a single suggest-only pass — the safe default, since
auto-running clinical skills is a policy call, not an implementation default.

## Acceptance fixtures

`test/fixtures/orchestrator-routing-cases.ts` holds the shared `input → expected skills` cases;
`test/orchestrator-routing.test.ts` replays them through the deterministic v0 selector (and the
same cases can later run through the LLM selector).

## Remaining / follow-ups

- **Live-stack validation**: `makeQueueJobRunner` + `orchestrate_run` are unit-tested via an
  injected runner, but the real subagent-job path needs a live DB + `gbrain jobs work` worker + a
  chat model (the LM Studio / Qwen setup in `hackathon_planning/LOCAL-MODELS-SETUP.md`). Run
  `gbrain orchestrate-run "<input>"` end-to-end there to confirm.
- Replay the routing fixtures through the **LLM selector** in CI once a model endpoint is wired.
- Optional: relational-retrieval enrichment for history.
