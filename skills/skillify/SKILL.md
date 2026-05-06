---
name: skillify
version: 2.0.0
description: |
  The meta skill. Turn any raw feature or script into a properly-skilled,
  tested, resolvable, evaled unit of agent-visible capability. v2 adds
  cross-modal eval as a quality gate BEFORE tests — use multiple AI models
  to critique the skill's output, iterate to quality, THEN write tests
  that lock in the proven behavior.
triggers:
  - "skillify this"
  - "skillify"
  - "is this a skill?"
  - "make this proper"
  - "add tests and evals for this"
  - "check skill completeness"
tools:
  - search
  - list_pages
mutating: false
---

# Skillify — The Meta Skill

## Contract

A feature is "properly skilled" when all items in the checklist are present.

## The Checklist

```
□ 1.  SKILL.md           — skill file with name, description, triggers, contract, phases
□ 2.  Code               — deterministic script if applicable (scripts/*.ts)
□ 3.  Cross-modal eval   — NEW: run skill output through 3 models, iterate until quality passes
□ 4.  Unit tests         — cover every branch of deterministic logic
□ 5.  Integration tests  — exercise live endpoints (not just in-memory mocks)
□ 6.  LLM evals          — quality/correctness cases for any LLM-involving step
□ 7.  Resolver trigger   — entry in skills/RESOLVER.md with trigger patterns
□ 8.  Resolver eval      — test that trigger phrases route to this skill
□ 9.  Check-resolvable   — DRY audit, MECE check, no orphans, no overlapping triggers
□ 10. E2E test           — smoke test that exercises the full pipeline
□ 11. Brain filing       — if it creates brain pages, entry in brain/RESOLVER.md
```

## Why Cross-Modal Eval Comes Before Tests

Tests lock in behavior. If the behavior is mediocre, tests lock in mediocrity.

Cross-modal eval (step 3) uses multiple AI models to critique the skill's actual output against the task spec. This catches quality gaps, missing edge cases, and structural weaknesses BEFORE you write tests. The workflow:

1. Write the skill (steps 1-2)
2. Run it on a representative input → get output
3. Cross-modal eval the output (3 models score it on 5 dimensions)
4. If eval fails: iterate on the skill, re-eval, up to 3 cycles
5. Once eval passes: NOW write tests that assert the proven-good behavior
6. Tests lock in the quality bar the eval established

Without this ordering, you get skills that pass all tests but produce mediocre output — because the tests were written to match whatever the first version produced.

## Phases

### Phase 1: Audit

For the feature being skillified:
- **Feature name**: one-line description
- **Code path**: where does the implementation live?
- **Checklist status**: which of the 11 items exist?

### Phase 2: Write SKILL.md + Code (items 1-2)

Write the skill definition first. Frontmatter must include:
- `name`, `version`, `description`, `triggers[]`
- `tools[]` (what tools it uses)
- `mutating` (does it write to brain/disk?)

Body has at minimum: Contract, Phases, Output Format sections.

Extract deterministic code into `scripts/*.ts` if applicable.

### Phase 3: Cross-Modal Eval (item 3) — THE QUALITY GATE

Run the skill on a representative input. Then eval the output:

```bash
bun run lib/cross-modal-eval.ts \
  --task "TASK_DESCRIPTION" \
  --output path/to/skill-output.md \
  --dimensions "goal_achievement,depth,specificity,usefulness,correctness"
```

**Pass criteria:** All 5 dimensions average ≥ 7 across 3 models.

**If eval fails:**
1. Read the aggregated improvements (top 10 across all models)
2. Fix the skill's prompts, logic, or output structure
3. Re-run on the same input
4. Re-eval. Repeat up to 3 cycles.
5. After 3 fails: ship with a warning, but document the known gaps.

**If eval passes:** The skill's output quality is proven. Now write tests.

See `skills/cross-modal-review/SKILL.md` for the full eval pipeline, model selection, and custom dimensions.

### Phase 4: Tests (items 4-6)

Now that cross-modal eval has established the quality bar, write tests that lock it in:

**Unit tests** — cover every branch of deterministic logic. Mock external calls.

**Integration tests** — hit real endpoints. Catch bugs mocks hide.

**LLM evals** — quality/correctness cases for any LLM-involving step. These are lighter than cross-modal eval — they test specific behaviors, not overall quality.

### Phase 5: Resolver + Check-Resolvable (items 7-9)

1. Add resolver entry to skills/RESOLVER.md with trigger patterns users ACTUALLY type
2. Write resolver eval: feed trigger phrases, assert they route correctly
3. Run check-resolvable audit:

```bash
gbrain check-resolvable
```

This verifies:
- a. Verify skill is reachable from skills/RESOLVER.md (not orphaned)
- b. Verify no other skill covers the same capability (no duplicate skills)
- c. Verify code imports shared libs instead of reimplementing (no duplicate code)
- d. Verify resolver triggers don't overlap with existing skills (no ambiguous routing)
- e. Verify brain filing conventions don't conflict with other skills

### Phase 6: E2E + Brain Filing (items 10-11)

- **E2E test**: smoke test exercising the full pipeline from trigger to side effect
- **Brain filing**: if the skill writes brain pages, add directory to brain/RESOLVER.md

### Phase 7: Verify All Green

```bash
# Unit tests
bun test test/unit/<skill>.test.ts

# Cross-modal eval receipt exists and shows pass
cat /tmp/cross-modal-eval-<skill>-*.json | bun run -e "const d = await Bun.file(process.argv[2]).json(); console.log(d.aggregated?.pass ? 'PASS' : 'FAIL')"

# Resolver reachable
grep "skills/<new-skill>" skills/RESOLVER.md

# DRY audit
gbrain check-resolvable

# E2E smoke
bun test test/e2e/<skill>.test.ts
```

## Quality Gates

A feature is NOT properly skilled until:
- Cross-modal eval passes (all dimensions ≥ 7 average)
- All tests pass (unit + integration + LLM evals)
- It appears in skills/RESOLVER.md with accurate trigger patterns
- `gbrain check-resolvable` shows no orphans, no MECE overlaps, no DRY violations
- If it writes to brain, brain/RESOLVER.md has the directory

## Anti-Patterns

- ❌ Writing tests before cross-modal eval (locks in mediocrity)
- ❌ Code with no SKILL.md (invisible to resolver)
- ❌ SKILL.md with no tests (untested contract)
- ❌ Tests that reimplement production code (masks real bugs)
- ❌ Resolver entry with internal jargon (must mirror real user language)
- ❌ Two skills that do the same thing (merge or kill one)
- ❌ Same logic in two scripts instead of shared lib (extract to lib/*.ts)
- ❌ Skipping cross-modal eval "because the output looks fine" (your judgment isn't 3 models)
- ❌ Running cross-modal eval on trivial outputs (don't waste API calls on one-liners)

## Why skillify + check-resolvable is the right pair

Some agent frameworks auto-create skills as a background behavior. That's fine until you don't know what the agent shipped — checklists decay, tests drift, resolver entries get stale.

Gbrain ships the same capability as two user-controlled tools:

- `skillify` builds the checklist and helps you fill in the gaps.
- `gbrain check-resolvable` validates the whole skill tree: reachability, MECE, DRY, gap detection, orphaned skills.

You decide when and what. The human keeps judgment. The tooling keeps the checklist honest. In practice this combo produces zero orphaned skills, every feature with tests + evals + resolver triggers + evals of the triggers.

## Output Format

A skillify run produces, in order:

1. An audit printout listing which of the 11 items exist and which are missing for the target feature.
2. The files created to close each gap (SKILL.md, test files, resolver entries).
3. The cross-modal eval report (if applicable) showing quality scores and improvements.
4. The final `gbrain check-resolvable` output confirming reachability.
5. A one-line summary of the resulting skill completeness score (N/11).