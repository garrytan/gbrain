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

The `orchestrate_input` op lives in `src/core/operations.ts` (read-scope; `gbrain orchestrate`).

## Data flow (`orchestrate_input`)

1. `deps.loadCandidateSkills` → `buildSkillCatalog` (`skill-catalog.ts`) → `CandidateSkill[]` (with `role`).
2. `deps.retrieveHistory` → `hybridSearchCached` (`search/hybrid.ts`), scoped to `patient_id`.
3. Gate to custom clinical skills (`custom-skills.ts`).
4. `select-llm.ts` ranks them via `chat` (`ai/gateway.ts`); `no_llm: true` uses the v0 fallback.
5. Fail-closed `assertAllCustom`, return the ranked `OrchestratorReport`.

## Feedback loop

Call `orchestrate_input` / `runOrchestrator` again with the previous pass's outputs in
`ctx.priorSkillOutputs`; the selector re-ranks with the new evidence. Stop when recommendations
stabilise or go empty.

## Remaining / follow-ups

- Skill **execution** (`gbrain agent run` per recommendation) is deliberately out of scope — the
  op is decision support. A separate execute step + a feedback-loop driver can consume this output.
- `routing-eval` fixtures (input → expected skills) as the acceptance/demo gate.
