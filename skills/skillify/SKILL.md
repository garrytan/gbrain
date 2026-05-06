---
name: skillify
version: 1.0.0
description: |
  The meta skill. Turn any raw feature into a properly-skilled, tested,
  resolvable unit of agent capability. Cross-modal eval runs BEFORE tests:
  3 frontier models critique the output, you iterate to quality, THEN
  write tests that lock in the proven-good behavior.
triggers:
  - "skillify this"
  - "skillify"
  - "is this a skill?"
  - "make this proper"
  - "add tests and evals for this"
  - "check skill completeness"
tools:
  - exec
  - read
  - write
mutating: true
---

# Skillify — The Meta Skill

## Contract

A feature is "properly skilled" when all 11 checklist items pass.

## The Checklist

```
□ 1.  SKILL.md           — skill file with frontmatter + contract + phases
□ 2.  Code               — deterministic script if applicable
□ 3.  Cross-modal eval   — 3 frontier models critique output, iterate ≤3 cycles
□ 4.  Unit tests         — cover every branch of deterministic logic
□ 5.  Integration tests  — exercise live endpoints
□ 6.  LLM evals          — quality/correctness cases for LLM-involving steps
□ 7.  Resolver trigger    — entry in skills/RESOLVER.md with real user trigger phrases
□ 8.  Resolver eval       — test that triggers route to this skill
□ 9.  Check-resolvable   — DRY + MECE audit, no orphans
□ 10. E2E test           — smoke test: trigger → side effect
□ 11. Brain filing       — if it writes pages, entry in brain/RESOLVER.md
```

## Phase 0: Should This Be a Skill?

Before skillifying, check:
- Will this be invoked 2+ times? (One-off work ≠ skill)
- Is there >20 lines of logic? (Trivial helpers don't need full infrastructure)
- Does it have a clear trigger phrase a user would actually say?

If no to all three, it's a script, not a skill. Move on.

## Phase 1: Audit

```
Feature: [name]
Code: [path]
Missing items: [check each of the 11]
```

## Phase 2: Write SKILL.md + Code (items 1-2)

### SKILL.md frontmatter template (copy-paste):

```yaml
---
name: my-skill
version: 1.0.0
description: |
  One paragraph. What it does, when to use it.
triggers:
  - "trigger phrase users actually say"
  - "another real trigger"
tools:
  - exec
  - read
  - write
mutating: false  # true if it writes to brain/disk
---
```

Body must include: **Contract** (what it guarantees), **Phases** (step-by-step), **Output Format** (what it produces).

Extract deterministic code into `scripts/*.ts`.

## Phase 3: Cross-Modal Eval (item 3) — THE QUALITY GATE

### Why this comes before tests

Tests lock in behavior. If the behavior is mediocre, tests lock in mediocrity. Cross-modal eval proves the quality bar FIRST, then tests cement it.

### Step 1: Pick a representative input

Choose the input that exercises the skill's hardest documented use case. If unsure: use the primary trigger example from SKILL.md, or the most complex real-world input from the last 7 days of memory files.

### Step 2: Run the skill, capture output

```bash
# Run the skill on the representative input → produces output file
# The output IS what gets evaluated
```

### Step 3: Run 3 frontier models

Models (use DIFFERENT providers to avoid shared blind spots):

| Slot | Model | Provider |
|------|-------|----------|
| A | `gpt-5.5` | OpenAI |
| B | `claude-opus-4-7` | Anthropic |
| C | `deepseek-ai/DeepSeek-V4-Pro` | Together AI |

**These MUST be frontier models.** Using Haiku or GPT-4-mini is asking a C student to grade an A student.

Each model gets this prompt:

```
You are a strict quality evaluator. Given a TASK, CONTEXT, and OUTPUT,
determine if the output is genuinely excellent or "good enough" slop.

TASK: {task_description}
CONTEXT: {who uses this, what success looks like, what the output feeds into}

Score 1-10 on each dimension:
{dimensions_with_rubrics}

Scoring calibration:
  9-10: Exceptional — would impress a domain expert
  7-8:  Solid — accomplishes the goal, no major gaps
  5-6:  Mediocre — obvious weaknesses
  3-4:  Poor — missing important elements
  1-2:  Failed

Then list exactly 10 improvements. Each MUST:
- Name the EXACT section/line to change
- Say WHAT to change and WHY
- Give a concrete EXAMPLE of the improved version
- Be ranked by impact (highest first)

Respond in JSON only.

OUTPUT: {the_output}
```

Run via `recipes/cross-modal-eval/cross-modal-eval.ts (or lib/cross-modal-eval.ts)`:

```bash
node recipes/cross-modal-eval/cross-modal-eval.ts (or lib/cross-modal-eval.ts) \
  --task "description" \
  --output path/to/output.md \
  --dimensions "goal_achievement,depth,specificity,actionability,completeness"
```

### Step 4: Aggregate scores

```
For each dimension:
  final_score = mean(model_A_score, model_B_score, model_C_score)

Pass criteria (BOTH must be true):
  1. Every dimension mean ≥ 7
  2. No single model scored any dimension < 5

Improvement ranking:
  - Cluster 30 improvements by semantic similarity
  - Multi-model agreement (2+ models said the same thing) = highest priority
  - Within a cluster, rank by impact position from each model's list
  - Produce TOP 10 ranked improvements with model attribution
```

### Step 5: Fix cycle (up to 3 iterations)

```
CYCLE 1:
  Eval → scores + top 10 improvements
  IF pass: → done, write tests
  ELSE:
    Apply top 10 improvements to the actual file
    Log: which improvements applied, what changed
    
CYCLE 2:
  Re-eval the FIXED output (same 3 models, same dimensions)
  Compare: before/after scores per dimension (track delta)
  IF pass: → done, write tests
  ELSE: apply remaining improvements + new ones

CYCLE 3 (final):
  Re-eval
  IF pass: → ship
  ELSE: → ship with KNOWN_GAPS section listing:
    - Which dimensions are still below 7
    - Which improvements couldn't be resolved
    - Why (e.g., "would require architectural change")
```

### Eval receipt schema

Each cycle produces a JSON receipt at `/tmp/cross-modal-eval-{name}-{ts}.json`:

```json
{
  "task": "...",
  "outputPath": "...",
  "cycle": 1,
  "timestamp": "...",
  "models": {
    "gpt-5.5": { "scores": {"dim": {"score": N, "feedback": "..."}}, "improvements": [...] },
    "opus-4-7": { "scores": {...}, "improvements": [...] },
    "deepseek-v4": { "scores": {...}, "improvements": [...] }
  },
  "aggregated": {
    "dimension_means": {"goal_achievement": 8.3, ...},
    "pass": true,
    "min_single_score": 6,
    "top_improvements": ["1. ...", ...],
    "model_agreement": {"improvement_1": ["gpt", "deepseek"], ...}
  }
}
```

### Cost guardrails

- Skip cross-modal eval if output < 200 tokens (trivial)
- Budget: 3 cycles × 3 models = 9 API calls max (~$2-5 for frontier models)
- If the skill is a thin wrapper around a single API call, one eval cycle is enough

## Phase 4: Tests (items 4-6)

NOW that eval has proven quality, write tests that lock it in:

**Unit tests** — every branch of deterministic logic. Mock external calls.
**Integration tests** — hit real endpoints. Catch bugs mocks hide.
**LLM evals** — quality/correctness for LLM steps. Lighter than cross-modal eval — test specific behaviors.

## Phase 5: Resolver + Check-Resolvable (items 7-9)

1. Add to skills/RESOLVER.md with trigger phrases users ACTUALLY type
2. Resolver eval: feed triggers, assert correct routing
3. Check-resolvable:
   - Skill reachable from skills/RESOLVER.md (not orphaned)
   - No MECE overlap with other skills
   - No DRY violations (shared logic in lib/, not copy-pasted)
   - No ambiguous trigger routing

## Phase 6: E2E + Brain Filing (items 10-11)

- E2E smoke: full pipeline from trigger to side effect
- Brain filing: add to brain/RESOLVER.md if the skill writes brain pages

## Phase 7: Verify

```bash
bun test run test/unit/<skill>.test.ts          # unit tests
cat /tmp/cross-modal-eval-<skill>-*.json | jq .aggregated.pass  # eval passed
grep "skills/<skill>" skills/RESOLVER.md                     # resolver entry
```

## Worked Example: Skillifying a "summarize-pr" Feature

```
Phase 0: Yes — invoked weekly, 50+ lines, clear trigger "summarize this PR"
Phase 1: Audit → SKILL.md missing, no tests, no resolver entry. Score: 1/11
Phase 2: Write SKILL.md + extract script to scripts/summarize-pr.ts
Phase 3: Cross-modal eval cycle 1:
  GPT-5.5: goal=6, depth=5, specificity=4 → "misses file-level diffs"
  Opus 4.7: goal=7, depth=6, specificity=5 → "no test plan in summary"
  DeepSeek V4: goal=6, depth=5, specificity=5 → "template feels generic"
  Aggregate: goal=6.3 FAIL, depth=5.3 FAIL
  Top improvements: add file-level changes, include test plan, use PR context
  → Apply fixes → Cycle 2: goal=8, depth=7.5, specificity=7 → PASS
Phase 4: Write 12 unit tests locking in the improved behavior
Phase 5: Add "summarize this PR" trigger to skills/RESOLVER.md
Phase 6: E2E test: feed a real PR URL → verify brain page created
Phase 7: All green. Score: 11/11
```

## Quality Gates

NOT properly skilled until:
- Cross-modal eval passes (all dimensions mean ≥ 7, no single score < 5)
- All tests pass (unit + integration + LLM evals)
- Resolver entry exists with real trigger phrases
- Check-resolvable shows no orphans, overlaps, or DRY violations
- Brain filing if applicable

## Anti-Patterns

- ❌ Writing tests before cross-modal eval (locks in mediocrity)
- ❌ Using budget models for eval (C student grading A student)
- ❌ Skipping eval "because the output looks fine" (your judgment isn't 3 models)
- ❌ Eval without fix cycle (vanity metrics)
- ❌ Code with no SKILL.md (invisible to resolver)
- ❌ Tests that reimplement production code (masks real bugs)
- ❌ Resolver entry with internal jargon (must mirror real user language)
- ❌ Two skills doing the same thing (merge or kill one)
- ❌ Running cross-modal eval on trivial outputs (< 200 tokens, not worth 9 API calls)
