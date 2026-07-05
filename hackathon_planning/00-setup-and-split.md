# 00 — Setup & work split (read this first)

Coordination doc for 3 devs working Task 1 + Task 2 in parallel. Read before picking up work.

- **Task 1** — [distill data into skills](./task1-distill-data-into-skills.md)
- **Task 2** — [patient orchestrator](./task2-patient-orchestrator.md)

> Scope note: excludes the database/engine layer. Retrieval + storage are a given black box.
>
> **The database and all raw/patient data live in [`hackathon_raw_data/`](../hackathon_raw_data/)** — a tracked
> folder whose contents are gitignored. Point `gbrain` at it locally; never commit its contents.

## Status (Dev A foundations — LANDED)

The sequencing gate is cleared: **B and C are unblocked and build against real code, not a mock.**

| Foundation deliverable | Status |
|---|---|
| `role:` frontmatter contract (`nurse \| psychiatrist \| general-medicine`) | ✅ merged (#2), value refined `shared`→`general-medicine` |
| `role` wired through `list_skills` / `get_skill` | ✅ merged (#2) |
| 2–3 seed skills (nurse-triage, psych-risk-screen, patient-history-review) | ✅ merged (#3) |
| `routing-eval` fixtures (121 cases, 100% top-1) | ✅ merged (#3) |
| Seed dataset in `hackathon_raw_data/` | ✅ present (real Almage dataset, gitignored) |
| Owns shared-file merges (`operations.ts`, `RESOLVER.md`) | 🔄 ongoing coordination |
| Wire end-to-end demo | ⛔ blocked on Dev C's `orchestrate_input` + Dev B's pipeline |

**Environment note:** both tasks call `gbrain agent run`, which needs an LLM key + model
config + an agreed cost posture. Local dev currently runs keyless (PGLite, no embeddings) —
that covers routing/contract work but NOT the `agent run` demo. Set keys + tier before the demo.

## The one thing that will bite us: shared files

Both tasks write the same places. Agree ownership + the interface **before** coding, or hour-one
merge conflicts follow.

| Shared surface | Touched by | Owner | Rule |
|---|---|---|---|
| `src/core/skill-frontmatter.ts` (the `role:` tag) | T1 produces, T2 reads | **Dev A** | Land first; frozen contract (below). |
| `src/core/operations.ts` (new ops) | T1 + T2 both register ops | Dev A arbitrates | Each dev adds their op in a separate PR; A resolves order. |
| `skills/RESOLVER.md` / `AGENTS.md` (routing rows) | T1 mutates, T2 ranks against | Dev A arbitrates | Append-only during hackathon; categorize at the end. |

## Frozen interface contract (agree this first)

The seam where "T1 produces skills" meets "T2 ranks them". Freeze it so both sides can mock.

**Skill frontmatter** (`skills/<slug>/SKILL.md`) — ✅ LANDED (#2):
```yaml
name: <slug>
description: <one-line, used by the T2 selector for ranking>
triggers: [<phrase>, ...]
role: nurse | psychiatrist | general-medicine   # canonical set — src/core/skill-frontmatter.ts SKILL_ROLES
tools: [...]
mutating: true|false
```

Notes: `role` is case-insensitive + quote-tolerant, normalized to the lowercase canonical
slug; a non-canonical value is captured (not silently dropped) so a mis-tag is loud. Import
the allowed set from `SKILL_ROLES` (`src/core/skill-frontmatter.ts`) — do not hardcode it.

**`list_skills` output** (what the T2 selector consumes) — ✅ real shape shipped
(`SkillCatalogEntry`, `src/core/skill-catalog.ts`); `get_skill` projects `role` too:
```jsonc
{ "name": "...", "description": "...", "section": "...", "role": "nurse|psychiatrist|general-medicine",
  "triggers": ["..."], "tools": ["..."], "usable_tools": ["..."], "unavailable_tools": ["..."],
  "writes_pages": false, "mutating": false }
```

The mock is no longer needed — Dev B and Dev C build against the merged contract.

## Sequencing (there IS a dependency)

T2's selector ranks skills that T1 tags with `role`. So foundations gate everything:

1. **Dev A first (~first hour):** `role` frontmatter + 2–3 seed skills + eval fixtures. ✅ DONE.
2. **Then B and C in parallel**, building against the frozen contract. ← now unblocked.

## Branching / PR flow

- No more commits straight to `master`. Feature branch per stream:
  `<name>/task1-<slice>`, `<name>/task2-<slice>`, `<name>/foundations`.
- Small PRs, one reviewer (cross-review between the two feature devs).
- If using Conductor: branch name must match the workspace name (see CLAUDE.md IRON RULE).
- These planning docs and their commits stay on `master` (shared reference).

## Seed data + eval fixtures = shared definition of done

Even minus the DB, both tasks need content to run against (keep it all in `hackathon_raw_data/`). Write
these up front — they double as the demo script:
- **T1:** sample brain data to distill (a few nurse + psychiatrist notes/records).
- **T2:** sample patient inputs + history (input → expected skills), as `routing-eval` fixtures.

If a fixture passes, the slice is done. Build toward the fixtures, not toward "feels done".

## Environment baseline (everyone, before starting)

- [ ] `bun install`
- [ ] `hackathon_raw_data/` populated locally with the brain DB + dataset (gitignored — get it out-of-band)
- [ ] `bun run typecheck` green
- [ ] `gbrain smoke-test` green
- [ ] LLM API key + model config set (both tasks call `gbrain agent run`)
- [ ] agreed cost posture / model tier for `agent run`
- [ ] read the relevant task file + this contract

## The 3-way split

| Dev | Stream | First task | Depends on |
|---|---|---|---|
| **A** | Foundations & integration | `role` frontmatter + 2–3 seed skills + eval fixtures + seed dataset; owns shared-file merges; wires end-to-end demo | — (unblocks B & C) |
| **B** | Task 1 pipeline | Decider (collapses Q1–Q3), then create → update → split paths | contract from A |
| **C** | Task 2 orchestrator | `orchestrate_input` op + skill selector, then feedback loop | contract + ≥1 seed skill from A |

A's foundations have landed (#2 contract, #3 seed skills + fixtures) — B and C build
against real code; no mock needed.

Status: **C** — Task 2 orchestrator template + healthcare custom-skill gate in PR
(`worktree-nick+orchestrator-work`); LLM selector, `list_skills` wiring, and op registration
remain. **B** — Task 1 not yet started.

## Demo target (what "done" looks like at the end)

End-to-end: a sample patient input →`orchestrate_input` pulls history + ranks skills → runs the
selected Nurse/Psychiatrist skill(s) → output feeds back for a second routing pass. Plus: T1 can
take a fresh piece of brain data and produce/update a skill that then shows up in that routing.
Both proven by the shared `routing-eval` fixtures.

## Guardrail everyone shares

Patient data is sensitive under Japan's APPI (要配慮個人情報). Keep source-isolation
(`sourceScopeOpts`), an audit trail of what gets auto-run, and treat skills as decision
support — not autonomous diagnosis. Decide the auto-run boundary as a team, early.

**Team policy (T2, landed):** patient/healthcare data is routed ONLY to our own role-tagged
clinical skills — never generic GBrain skills. Enforced in
`src/core/orchestrator/custom-skills.ts` (allowlist by `SKILL_ROLES` + `excluded_generic` audit
trail + fail-closed `assertAllCustom`).
