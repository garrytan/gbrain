---
name: skillify
version: 1.1.0
description: |
  The meta skill. Turn any raw feature into a properly-skilled, tested,
  resolvable unit of agent capability. Cross-modal eval is the recommended
  Phase 3 quality gate: 3 frontier models from different providers critique
  the output, you iterate to quality, THEN write tests that lock in the
  proven-good behavior.
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

> **Relationship to `/cross-modal-review`:** That skill is the manual mid-flow
> "second opinion" gate (one model reviews work product before commit). This
> skill's Phase 3 below uses `gbrain eval cross-modal` instead — three
> different-provider frontier models score-and-iterate on a documented
> dimension list *before* tests cement behavior. Use `/cross-modal-review`
> for ad-hoc second opinions; use Phase 3 here when skillifying a feature.

## Contract

A feature is "properly skilled" when all 11 checklist items pass. Item 3
(cross-modal eval) is informational in v1.1.0 — it does not gate the
skillpack-check audit, but a missing or stale receipt is surfaced so the
user knows where the gate stands.

## The Checklist

```
□ 1.  SKILL.md           — skill file with frontmatter + contract + phases
□ 2.  Code               — deterministic script if applicable
□ 3.  Cross-modal eval   — 3 frontier models from 3 providers; informational
□ 4.  Unit tests         — cover every branch of deterministic logic
□ 5.  Integration tests  — exercise live endpoints
□ 6.  LLM evals          — quality/correctness cases for LLM-involving steps
□ 7.  Resolver trigger   — entry in skills/RESOLVER.md with real user trigger phrases
□ 8.  Resolver eval      — test that triggers route to this skill
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

Tests lock in behavior. If the behavior is mediocre, tests lock in mediocrity.
Cross-modal eval proves the quality bar FIRST, then tests cement it.

### Step 1: Pick a representative input

Choose the input that exercises the skill's hardest documented use case. If
unsure: use the primary trigger example from SKILL.md, or the most complex
real-world input from the last 7 days of memory files.

### Step 2: Run the skill, capture output

Run the skill on the representative input. The OUTPUT FILE is what gets
evaluated.

### Step 3: Run the eval gate

```bash
gbrain eval cross-modal \
  --task "What this skill is supposed to accomplish" \
  --output skills/<slug>/SKILL.md
```

The command runs 3 frontier models from 3 different providers in parallel,
scores the OUTPUT against the TASK on 5 documented dimensions, and writes a
receipt under `~/.gbrain/.gbrain/eval-receipts/<slug>-<sha8>.json` (the
sha-8 binds the receipt to the current SKILL.md content — re-running after
edits writes a new receipt).

**Default models** (override per slot via `--slot-a-model`, `--slot-b-model`,
`--slot-c-model`):

| Slot | Default | Provider |
|------|---------|----------|
| A | `openai:gpt-4o` | OpenAI |
| B | `anthropic:claude-opus-4-7` | Anthropic |
| C | `google:gemini-1.5-pro` | Google |

**These MUST be frontier models from DIFFERENT providers.** Using a single
provider's family or budget models defeats the purpose — different families
have less correlated blind spots. Refresh the list when a new model
generation ships.

**Pass criteria (BOTH must be true):**

1. Every dimension's mean across successful models ≥ 7.
2. No single model scored any dimension < 5 (the floor).

**Inconclusive:** fewer than 2 of 3 models returned parseable scores.
Receipt is still written (forensics) but the gate is not authoritative.
Exit code 2; CI wrappers should treat this as "did not run cleanly", not
"failed quality gate".

### Step 4: Cycle until you pass (≤3 cycles)

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

### Cycles + cost guardrails

- Default `--cycles 3` in TTY, `--cycles 1` in non-TTY (limits scripted
  bulk spend in CI loops).
- The command prints an estimated max-cost-per-cycle from a small pricing
  constant before each run. Real cost varies with prompt size; treat the
  estimate as a ceiling for default `--max-tokens 4000`.
- A `--budget-usd N` hard cap is a v0.27.x follow-up TODO.

### Provider configuration

Models resolve through the gbrain AI gateway. Configure once with:

```bash
gbrain providers test    # see what's configured
gbrain config            # set keys
```

Or set env vars: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`GOOGLE_GENERATIVE_AI_API_KEY`, `TOGETHER_API_KEY`, etc. The gateway reads
from `~/.gbrain/config.json` plus `process.env`.

### Cost expectations

3 cycles × 3 models = 9 frontier calls max per run. With Opus-class +
GPT-4o-class + Gemini-1.5-Pro, expect $1–3 per full run on default
`--max-tokens 4000`. Receipts include the per-call model identifiers so
you can audit retroactively.

### Skip cross-modal eval when:

- Output is < 200 tokens (trivial — not worth 9 API calls).
- The skill is a thin wrapper around a single API call (one cycle is enough).

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
bun test test/<skill>.test.ts                    # unit tests
gbrain skillify check skills/<slug>/scripts/<slug>.mjs --json | \
  jq '.[] | .items[] | select(.name | contains("Cross-modal"))'
ls ~/.gbrain/.gbrain/eval-receipts/              # receipt landed
gbrain check-resolvable --json | jq .ok          # resolver clean
```

## Worked Example: Skillifying a "summarize-pr" Feature

```
Phase 0: Yes — invoked weekly, 50+ lines, clear trigger "summarize this PR"
Phase 1: Audit → SKILL.md missing, no tests, no resolver entry. Score: 1/11
Phase 2: Write SKILL.md + extract script to scripts/summarize-pr.ts
Phase 3: Cross-modal eval cycle 1 →
  GPT-4o: goal=6, depth=5, specificity=4 → "misses file-level diffs"
  Opus 4.7: goal=7, depth=6, specificity=5 → "no test plan in summary"
  Gemini 1.5 Pro: goal=6, depth=5, specificity=5 → "template feels generic"
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

- All required items pass (1-2, 4-10; 11 only when applicable).
- Cross-modal eval (item 3) has a current receipt OR is explicitly waived
  with rationale (item 3 is informational; not blocking, but a missing
  receipt is visible in the audit).
- All tests pass (unit + integration + LLM evals).
- Resolver entry exists with real trigger phrases.
- Check-resolvable shows no orphans, overlaps, or DRY violations.
- Brain filing if applicable.

## Output Format

Skillify produces three durable artifacts per skill:

1. **The skill tree on disk.** `skills/<slug>/SKILL.md`, `scripts/<slug>.mjs`,
   `routing-eval.jsonl`, plus a `test/<slug>.test.ts` skeleton. Generated by
   `gbrain skillify scaffold <name>` and refined by the human/agent into a
   real implementation.
2. **A cross-modal eval receipt** at
   `~/.gbrain/.gbrain/eval-receipts/<slug>-<sha8>.json`. The sha-8 binds the
   receipt to the current `SKILL.md` content. `gbrain skillify check`
   surfaces the status (`found` / `stale` / `missing`) as informational.
3. **An audit verdict** from `gbrain skillify check`: `properly skilled` |
   `close — create: <missing items>` | `needs skillify — run /skillify on
   <target>`. Score is `<passed>/<total>`. Required items gate the verdict;
   item 11 (cross-modal eval) is informational and never blocks PASS.

JSON output (`gbrain skillify check --json`) includes the same fields plus
the per-item detail string, so agents can route on the structured envelope
without parsing prose.

## Anti-Patterns

- ❌ Writing tests before cross-modal eval (locks in mediocrity)
- ❌ Using budget models for eval (C student grading A student)
- ❌ Using a single provider's family for all 3 slots (correlated blind spots)
- ❌ Skipping eval "because the output looks fine" (your judgment isn't 3 models)
- ❌ Eval without fix cycle (vanity metrics)
- ❌ Code with no SKILL.md (invisible to resolver)
- ❌ Tests that reimplement production code (masks real bugs)
- ❌ Resolver entry with internal jargon (must mirror real user language)
- ❌ Two skills doing the same thing (merge or kill one)
- ❌ Running cross-modal eval on trivial outputs (< 200 tokens, not worth 9 API calls)
