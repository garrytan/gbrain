# Task 1 — Distill existing data into skills

> **Start here:** read [`00-setup-and-split.md`](./00-setup-and-split.md) for the frozen
> interface contract, shared-file ownership, and the 3-way split before picking up work.

Turn stored brain data into reusable **Nurse** and **Psychiatrist** skills, deciding per
candidate topic whether to create, leave as-is, update, or split a skill — and keep the
orchestrator (RESOLVER) in sync.

> Scope note: excludes the database/engine layer. Retrieval + storage are treated as a
> given black box.

## Current-state map (flowchart → repo)

| Flowchart node | Status | What backs it today |
|---|---|---|
| Nurse / Psychiatrist split | ✅ done (Dev A, #2) | `role: nurse \| psychiatrist \| general-medicine` frontmatter tag shipped in `src/core/skill-frontmatter.ts` (`SKILL_ROLES`), surfaced via `list_skills`. Tag new skills with it. |
| **Q1: suitable skill exists?** | 🟡 weak | Only a literal trigger-string collision warning — `src/core/check-resolvable.ts:437` (MECE). No semantic "is there a skill for this topic" check. |
| No → create + update orchestrator | 🟡 partial | `gbrain skillify scaffold` writes stub files **and auto-appends a resolver row** (`src/core/skillify/generator.ts:150`), but only under `## Uncategorized`, and content is authored manually. |
| Q2: update with new info? | ❌ missing | No automated decider (prose guidance only). |
| No (exact match) → done | ✅ trivial | — |
| **Q3: enough nuance to split?** | ❌ missing | No split-decision logic anywhere. |
| Yes → split into 2 + update orchestrator | ❌ missing | Does not exist. |
| No → update skill | ✅ strong | `gbrain skillopt` optimizes a `SKILL.md` body, validation-gated (`src/core/skillopt/`, 23 modules) — but optimizes against a benchmark, not "fold in new data." |

**Core gap:** nothing in the repo distills brain *content* into skills today — every
existing "create a skill" path authors from features/code/routing tables, not stored data.
That distillation step, plus the Q2/Q3 deciders and the split executor, is the net-new work.

## Reuse, don't build (Phase 0)

- Skill format + frontmatter — `src/core/skill-frontmatter.ts`
- Scaffolding — `gbrain skillify scaffold` (`src/commands/skillify.ts`, `src/core/skillify/generator.ts`)
- Skill-body optimization — `gbrain skillopt` (`src/core/skillopt/`)
- Duplicate/gap/DRY lint — `gbrain check-resolvable` (`src/core/check-resolvable.ts`)
- Routing table — `skills/RESOLVER.md` + `AGENTS.md` merge (`src/core/check-resolvable.ts`)
- Authoring executor — `gbrain agent run` (`src/commands/agent.ts`)

## Build plan

MVP each decider as an **LLM call** (via `gbrain agent run`); harden to deterministic later.

### 1. Role axis ✅ (landed by Dev A, #2)
- `role: nurse | psychiatrist | general-medicine` frontmatter tag shipped in
  `src/core/skill-frontmatter.ts` (import the allowed set from `SKILL_ROLES`); surfaced via `list_skills`.
- Remaining for T1: a query/tag to pull the brain slice per role (source or tag filter).

### 2. The decider (collapses Q1 + Q2 + Q3)
- New step: given a candidate topic, LLM-classify against `list_skills` descriptions/triggers
  → `{ none | exact_match | update | split }`.
- Reuse `check-resolvable` MECE for the deterministic exact-trigger case.
- Output drives the branch below.

### 3. Create path (Q1 = none)
- `gbrain skillify scaffold <name>` (exists) → authoring agent (`gbrain agent run`) fills the
  stub from retrieved brain data → resolver row auto-appended (exists).

### 4. Exact match (Q2 = no)
- No-op. Log and stop.

### 5. Update path (Q3 = no)
- Wrap `skillopt` with an "incorporate new data" benchmark, **or** MVP: agent-run rewrite of the
  `SKILL.md` body, gated by `routing-eval` + the conformance test.

### 6. Split executor (Q3 = yes) — net-new
- LLM proposes 2 skills → `skillify scaffold` both → deprecate the original → categorize the new
  resolver rows (MVP: agent performs the functional-area edit per the `functional-area-resolver`
  playbook at `skills/functional-area-resolver/SKILL.md`).

### 7. Orchestrator sync
- `skillify scaffold` appends rows automatically; add a small step to move them out of
  `## Uncategorized` into the right functional area. MVP: agent-driven.

## Guardrails (Phase 3)
- `routing-eval` fixtures covering representative nurse/psychiatrist topics.
- Conformance + typecheck gates before any skill lands.
- Healthcare/compliance: patient-derived content is sensitive under Japan's APPI
  (要配慮個人情報). Enforce source-isolation (`sourceScopeOpts`), keep an audit trail, and frame
  skills as decision support — not autonomous diagnosis.

## Suggested first slice
Steps 1 → 2 → 3 (role tagging + decider + create path). Smallest loop that produces a real
skill from brain data end-to-end and proves the pattern.
