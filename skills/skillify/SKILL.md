---
name: skillify
version: 2.0.0
description: |
  The meta skill. Turn any raw feature into a properly-skilled, tested,
  resolvable unit of agent capability. Idempotent: running on an existing
  skill improves it (bug fix, new input, quality pass) instead of starting
  from scratch. Every skill declares an EVAL CONTRACT (its goal +
  skill-specific dimensions + hard-fails) so the cross-modal eval judges
  THIS skill's real purpose, not generic slop. Cross-modal eval runs BEFORE
  tests: 3 frontier models from different providers critique the output
  against the contract, you iterate to quality, THEN write/update tests that
  lock in the proven-good behavior. NO-REGRESSION LAW: any edit to a skill
  must score >= the previous iteration's eval — forward only, never back.
  For skills that back a scheduled job, an edit MUST re-run a representative
  task and eval it before shipping.
eval_contract:
  goal: |
    Turn a raw feature or an edited skill into a properly-skilled, regression-proof
    unit: all 15 checklist items pass, the output clears its own eval contract, and
    the new eval scores >= the prior iteration. Excellent = another operator on any
    agent platform can run skillify and know exactly what passed, what the quality
    bar was, and that nothing silently regressed.
  dimensions:
    - "CHECKLIST_COVERAGE — are all 15 items actually checked, not just claimed?"
    - "CONTRACT_QUALITY — is the eval_contract goal concrete and the dimensions skill-specific (not generic)?"
    - "REGRESSION_RIGOR — is the new output compared to the prior baseline with a real delta?"
    - "IDEMPOTENCY — does an improve-run preserve what worked and fix only the delta?"
    - "GENERALITY — is the skill deployment-neutral (no hardcoded people or channels in the body)?"
    - "ACTIONABILITY — could another operator follow this without asking follow-ups?"
  hard_fails:
    - "Shipping a skill edit that scores worse than the prior iteration (regression)."
    - "Running cross-modal eval on generic dimensions for a high-stakes skill instead of its contract."
    - "Editing a schedule-backed skill without re-running and evaluating a representative task."
    - "Hardcoding one deployment's people or channels into the skill body instead of a neutral principle."
triggers:
  - "skillify this"
  - "skillify"
  - "is this a skill?"
  - "make this proper"
  - "add tests and evals for this"
  - "check skill completeness"
  - "run skillify on a skill"
  - "did this skill regress"
tools:
  - exec
  - read
  - write
  - edit
mutating: true
upstream: skillify@fc834ee
---

# Skillify — The Meta Skill

> **Relationship to `/cross-modal-review`:** That skill is the manual mid-flow
> "second opinion" gate (one model reviews work product before commit). This
> skill's Phase 3 below uses `gbrain eval cross-modal` instead — three
> different-provider frontier models score-and-iterate on a documented
> dimension list *before* tests cement behavior. Use `/cross-modal-review`
> for ad-hoc second opinions; use Phase 3 here when skillifying a feature.

## Contract

A feature is "properly skilled" when all 15 checklist items (0 + 1–14; 3b
rides with item 3) pass. `gbrain skillify check` audits the mechanical items
(1–11); items 0, 3b, 12, 13, and 14 are procedural gates the agent verifies
directly. Item 3 (cross-modal eval) is informational in the audit — it does
not gate `gbrain skillify check`, but a missing or stale receipt is surfaced
so the user knows where the gate stands.

**Idempotency guarantee:** skillify can run on the same skill any number of
times. Each run:

1. Detects existing artifacts (SKILL.md, tests, evals, code, resolver entries)
2. Identifies what's new: bug report, user feedback, new input, or quality gap
3. Improves existing files rather than rewriting from scratch
4. Preserves what works, fixes what's broken
5. Re-runs the checklist and only touches items that fail

**No-regression law:** any edit to a skill must score ≥ the previous
iteration's cross-modal eval on the same task and dimensions. Forward only,
never back (Phase 3.5).

## The Checklist

Other skills and workflows delegate to this checklist — reference items by
number (e.g. "run skillify items 4–6") against `skills/skillify/SKILL.md`.
The numbering is stable; additive changes only.

```
□ 0.  Eval contract      — skill declares goal + skill-specific dimensions + hard-fails (Phase 2.5)
□ 1.  SKILL.md           — skill file with frontmatter + contract + phases
□ 2.  Code               — deterministic script if applicable
□ 3.  Cross-modal eval   — 3 frontier models from 3 providers critique output vs the contract; informational in the audit
□ 3b. No-regression gate — new eval scores ≥ the previous iteration (forward only; Phase 3.5)
□ 4.  Unit tests         — cover every branch of deterministic logic
□ 5.  Integration tests  — exercise live endpoints
□ 6.  LLM evals          — quality/correctness cases for LLM-involving steps
□ 7.  Resolver trigger   — entry in skills/RESOLVER.md with real user trigger phrases
□ 8.  Resolver eval      — test that triggers route to this skill
□ 9.  Check-resolvable   — DRY + MECE audit, no orphans
□ 10. E2E test           — smoke test: trigger → side effect
□ 11. Brain filing       — if it writes pages, entry in brain/RESOLVER.md
□ 12. Scheduled-run observability — if the skill backs a cron/recurring job, runs route through minions so they are logged and inspectable (Phase 6)
□ 13. Scheduled-task re-run — if the skill backs a cron, an edit re-runs a representative task + evals it (Phase 3.5)
□ 14. Plugin membership   — record the skill in openclaw.plugin.json OR skills/plugin-exclusions.json (the membership test requires exactly one)
```

## Phase 0: Determine Mode (New vs Improve)

Before anything, determine the mode.

### Mode A: New Skill (no SKILL.md exists)

Check:
- Will this be invoked 2+ times? (One-off work ≠ skill)
- Is there >20 lines of logic? (Trivial helpers don't need full infrastructure)
- Does it have a clear trigger phrase a user would actually say?

If ANY answer is no, it's a script, not a skill — stop here. Do not scaffold,
write a SKILL.md, run evals, or write tests for it. Tell the user why and move on.

Scope check (upper bound): one skill = one capability = one coherent trigger
family. If the target spans multiple distinct intents users would invoke
separately ("run the build" / "roll back the deploy" / "notify the team" are
three intents, not one), do NOT build one skill covering them all. Stop,
propose splitting into separate skillify targets, and ask the user which one
to skillify first.

DRY/MECE pre-check: before scaffolding, grep `skills/RESOLVER.md` and the
skill manifest for overlapping trigger phrases and near-duplicate
descriptions. If a proposed trigger collides with an existing skill, prefer
merging — add a trigger, mode, or phase to the existing skill, bump its minor
version, and run this checklist on the merged result — over creating a
near-duplicate. If you create a separate skill despite overlap, record the
one-sentence distinction in the new SKILL.md. `gbrain check-resolvable`
(Phase 5) is the backstop that catches what the pre-check misses.

### Mode B: Improve Existing Skill (SKILL.md exists)

This is the idempotent path. Triggered when running skillify on a skill that
already has a SKILL.md, when a bug was found, when the user gave feedback or
new input, or when a quality pass is requested.

**Improvement protocol:**

1. Read ALL existing artifacts: `skills/<slug>/SKILL.md`, the skill's script
   (whatever path SKILL.md references), `routing-eval.jsonl`, and
   `test/<slug>.test.ts`.
2. Identify the **delta** — what changed?
   - **Bug fix:** the user reported a specific failure. Add a test for the
     exact bug, fix the code, add a HARD RULE to SKILL.md to prevent recurrence.
   - **New input:** the user provided new context/requirements. Extend
     SKILL.md, update code, add tests for the new behavior.
   - **Quality pass:** no specific bug, just running the checklist again.
     Audit, cross-modal eval, fill gaps.
3. Apply changes surgically — edit existing files, don't rewrite them.
4. Re-run ALL existing tests to ensure no regressions.
5. Update the version in frontmatter (patch for bug fixes, minor for new
   capability).
6. Run the No-Regression Gate (Phase 3.5) before shipping.

**Bug fix template (add to the skill's SKILL.md):**

```markdown
## Bug: [Date] — [Short description]
- **What happened:** [Concrete failure]
- **Root cause:** [Why]
- **Fix:** [What changed]
- **Hard rule added:** [New constraint to prevent recurrence]
- **Tests added:** [List of new test cases]
```

## Phase 1: Audit

```
Feature: [name]
Code: [path]
Missing items: [check each of the 15]
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

## Phase 2.5: Eval Contract (item 0) — DEFINE THE GOAL + RUBRIC BEFORE EVALUATING

A cross-modal eval is only as good as what you ask it to judge. Generic
dimensions catch slop but miss whether the output achieves THIS skill's
specific purpose. Every skill carries an explicit **eval contract**: what the
skill is FOR, and HOW to tell if a given output is excellent vs. a failure.

### Every skill declares its eval contract in frontmatter

```yaml
eval_contract:
  goal: |
    One or two sentences: what this skill is supposed to achieve, for whom, and what
    "excellent" looks like in the real world. Be concrete and skill-specific.
  dimensions:
    - "DIMENSION_NAME — the specific question this dimension answers for THIS skill"
    # 3-6 dimensions, tuned to the skill. Example for a per-subject news briefing skill:
    # - "FACTUAL_INTEGRITY — is every claim true and verifiable?"
    # - "SUBJECT_ANCHOR — is each item tied to something concretely THIS subject's?"
    # - "WHY_IT_MATTERS — is the relevance real and specific, not a templated lane label?"
    # - "CLICKWORTHY — would the reader actually want to open these links?"
  hard_fails:
    - "A failure mode that auto-zeroes the eval regardless of other scores."
    # e.g. "Any fabricated fact = automatic 1."
```

### How to obtain the eval contract (in priority order)

1. **Read it from the skill.** If `eval_contract` already exists in frontmatter
   (or a clear Goal/Contract section in the body), use it. Idempotent runs
   reuse the same contract so scores compare apples-to-apples across
   iterations — this is what makes the no-regression gate meaningful.
2. **Infer it from context.** No declared contract? Derive the goal +
   dimensions from the SKILL.md body (Contract/Output Format), the scheduled
   task prompt that invokes it, recent user feedback (especially complaints —
   a complaint that a fact was wrong pins FACTUAL_INTEGRITY as a hard-fail
   dimension), and the representative output's audience.
3. **Ask the user when it's unclear.** If the goal or the bar for "excellent"
   is genuinely ambiguous and you can't infer it confidently, ASK — one tight
   question, then proceed. Do not guess a rubric for a high-stakes skill
   (anything whose output posts to a live channel or is read by others). A
   wrong rubric produces a confident-but-meaningless score.
4. **Write it back.** Once settled, persist the contract into the skill's
   `eval_contract` frontmatter so it's reused and versioned. Editing the
   contract is itself a skill edit — re-eval to confirm the new rubric still
   scores the current output forward.

### Wire the contract into the eval

Pass the contract's goal as `--task` and its dimensions as `--dimensions` to
`gbrain eval cross-modal`. The eval then measures the skill against ITS stated
purpose, not a generic checklist. State hard-fail conditions inside the task
text so judges zero the score when they fire ("If any claim is fabricated, the
output fails regardless of other qualities").

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
  --task "The eval contract's goal, including its hard-fail conditions" \
  --dimensions "dim_one,dim_two,dim_three" \
  --output skills/<slug>/SKILL.md
```

The command runs 3 frontier models from 3 different providers in parallel,
scores the OUTPUT against the TASK on the given dimensions (default: 5
standard dimensions when `--dimensions` is omitted), and writes a receipt
under `~/.gbrain/.gbrain/eval-receipts/<slug>-<sha8>.json` (the sha-8 binds
the receipt to the current SKILL.md content — re-running after edits writes a
new receipt, so every iteration leaves its own baseline).

**Default models** (override per slot via `--slot-a-model`, `--slot-b-model`,
`--slot-c-model`):

| Slot | Default | Provider |
|------|---------|----------|
| A | `openai:gpt-5.2` | OpenAI |
| B | `anthropic:claude-opus-4-7` | Anthropic |
| C | `deepseek:deepseek-v4-pro` | DeepSeek |

**These MUST be frontier models from DIFFERENT providers.** Using a single
provider's family or budget models defeats the purpose — different families
have less correlated blind spots. Model names drift; pin the live aliases at
run time. The *frontier-only, different-providers* rule is the durable part.

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

3 cycles × 3 models = 9 frontier calls max per run. Expect $1–3 per full run
on default `--max-tokens 4000` with frontier-class models. Receipts include
the per-call model identifiers so you can audit retroactively.

### Skip cross-modal eval when:

- Output is < 200 tokens (trivial — not worth 9 API calls).
- The skill is a thin wrapper around a single API call (one cycle is enough).

## Phase 3.5: No-Regression Gate + Scheduled-Task Re-Run (items 3b, 13) — THE FORWARD-ONLY LAW

A scheduled skill can regress silently and ship a bad output to a live
channel before anyone re-checks its quality. The law: **we only go forward.
An edit that scores worse than the last iteration is a REGRESSION and must
NOT ship — revert or re-fix.**

### 3b. No-Regression Gate (every skill edit, MANDATORY)

Absolute pass (every dimension mean ≥ 7, no single score < 5) is necessary
but NOT sufficient. The edited output must also beat the **previous
iteration's** eval on the same task and dimensions.

1. Find the most recent prior receipt. Receipts are bound to the SKILL.md
   content sha, so every iteration leaves its own file:
   ```bash
   ls -t ~/.gbrain/.gbrain/eval-receipts/<slug>-*.json | head -5
   ```
2. Read the baseline numbers from the prior receipt:
   ```bash
   jq '{overall: .aggregate.overall, dims: (.aggregate.dimensions | map_values(.mean))}' <prior-receipt>
   ```
3. Run the new eval on the edited output with the SAME `--task` and
   `--dimensions` as the prior run — apples to apples. Reusing the eval
   contract (Phase 2.5) makes this automatic.
4. Compare:
   - **FORWARD (ship):** new overall ≥ prior overall AND no dimension mean
     dropped by more than 0.5.
   - **REGRESSION (block):** new overall < prior, OR any dimension regressed
     by more than 0.5. Do NOT ship. Apply the top improvements and re-eval,
     or revert the edit. Log the regression.
5. If there is NO prior receipt (first-ever eval), the absolute pass (≥ 7) is
   the bar and this run becomes the baseline.
6. Record the before/after comparison (prior overall → new overall, verdict)
   in the commit or PR message so the forward-only history is auditable.

Exception: a pure deterministic bug fix whose behavior is fully locked by new
tests may skip the re-eval — but the Phase 7 re-verify still runs. Any edit
that changes prose, prompts, or output shape re-evals.

### 13. Scheduled-Task Re-Run (skills that back a cron, MANDATORY on edit)

Many skills are invoked by scheduled jobs (briefings, daily digests,
monitors, recurring reports). Editing such a skill is NOT done until you have
re-run a **representative live task** through the edited skill and eval'd the
real output it would have produced.

1. **Detect schedule backing:** check whether any cron entry or recurring
   minion job invokes the skill (`gbrain jobs list`, plus the scheduler
   config per `skills/conventions/cron-via-minions.md`). If ≥1 job references
   the skill, this gate applies.
2. **Pick the highest-bar representative task** — the input where quality is
   most visible and a regression is most consequential (the report the user
   reads most critically, the hardest documented path). The principle is
   constant; the specific input is your deployment's to choose — never
   hardcode it into the skill body.
3. **Run it for real, capture what it WOULD produce.** Write to a file — do
   NOT post to a live channel during a skillify test. Redirect the send to a
   temp file or use a dry-run flag.
4. **Cross-modal eval that output** (Phase 3) AND **run the No-Regression
   Gate (3b)** against the previous iteration's receipt for this task. Keep
   per-task baselines distinct with `--slug <skill>-<task>` so receipts don't
   collide with the skill's own SKILL.md receipts.
5. **Ship only if forward.** New score ≥ prior for that task. A worse score
   means the edit regressed the scheduled output — block and re-fix.
6. **Idempotency re-verify ("skills never silently break"):** after editing,
   re-run the Phase 1 audit + Phase 7 verify so EVERY checklist item is
   re-checked, not just the one you touched. Confirm:
   - all referenced scripts still exist and run (no dead paths),
   - the scheduled job still invokes the correct skill path,
   - tests still pass (no regressions),
   - the resolver entry still routes.
   If any item that previously passed now fails, the edit broke something —
   fix before shipping.

### Hard rule (add to any schedule-backed skill's SKILL.md)

```markdown
⛔ NO-REGRESSION + RE-RUN GATE: Any edit to this skill must (1) re-run a
representative scheduled task, (2) cross-modal eval the real output,
(3) score ≥ the previous iteration's receipt. A worse score does NOT ship.
We only go forward.
```

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

After creating or updating a skill, re-run `gbrain check-resolvable --json`
and resolve every flag: two skills confusable by the same trigger get
disambiguating trigger words or a merge; a skill whose triggers are a subset
of another's gets merged or made more specific.

## Phase 6: E2E + Brain Filing + Scheduled-Run Observability (items 10-12)

- E2E smoke: full pipeline from trigger to side effect
- Brain filing: add to brain/RESOLVER.md if the skill writes brain pages
- Scheduled-run observability: see below

### Scheduled-run observability (item 12) — for any schedule-backed skill

If the skill backs a cron or recurring job, the job MUST run through minions
(`gbrain jobs submit` from the cron line) rather than a bare shell pipeline,
so every run leaves a job record with status, progress, and logs — ghost
crons that run silently are the #1 source of observability bugs.

**Verification:**

```bash
gbrain jobs list             # the scheduled job appears with a status
gbrain jobs get <id>         # per-run progress + result is inspectable
```

Scheduling patterns live in `skills/conventions/cron-via-minions.md` and
`skills/cron-scheduler/SKILL.md`; job-lane mechanics in
`skills/minion-orchestrator/SKILL.md`.

## Phase 7: Verify

```bash
bun test test/<skill>.test.ts                    # unit tests
gbrain skillify check skills/<slug>/scripts/<slug>.mjs --json | \
  jq '.[] | .items[] | select(.name | contains("Cross-modal"))'
ls -t ~/.gbrain/.gbrain/eval-receipts/<slug>-*.json | head -2   # receipt landed; prior baseline visible
gbrain check-resolvable --json | jq .ok          # resolver clean
```

## Worked Example: Skillifying a "summarize-pr" Feature

```
Phase 0: Mode A — invoked weekly, 50+ lines, clear trigger "summarize this PR"
Phase 1: Audit → SKILL.md missing, no tests, no resolver entry. Score: 1/15
Phase 2: Write SKILL.md + extract script to scripts/summarize-pr.ts
Phase 2.5: Declare eval_contract — goal: reviewer-ready PR summary;
  dimensions: file_coverage, test_plan, specificity;
  hard-fail: any fabricated claim about the diff
Phase 3: Cross-modal eval cycle 1 (dimensions from the contract) →
  gpt-5.2: file_coverage=6, test_plan=4, specificity=5 → "misses file-level diffs"
  claude-opus-4-7: file_coverage=7, test_plan=5, specificity=5 → "no test plan in summary"
  deepseek-v4-pro: file_coverage=6, test_plan=5, specificity=5 → "template feels generic"
  Aggregate: file_coverage=6.3 FAIL, test_plan=4.7 FAIL
  Top improvements: add file-level changes, include test plan, use PR context
  → Apply fixes → Cycle 2: file_coverage=8, test_plan=7.5, specificity=7 → PASS
Phase 3.5: First-ever eval → the cycle-2 receipt becomes the baseline
Phase 4: Write 12 unit tests locking in the improved behavior
Phase 5: Add "summarize this PR" trigger to skills/RESOLVER.md
Phase 6: E2E test: feed a real PR URL → verify brain page created.
  Not schedule-backed → items 12–13 N/A
Phase 7: All green. Score: every applicable item passing
```

## Worked Example: Improving an Existing Skill (Bug Fix)

```
Input: the user reports the skill labeled a date with the wrong weekday
Skill: travel-brief (already has SKILL.md, code, an eval receipt)

Phase 0: Mode B (Improve) — SKILL.md exists, this is a bug fix
  Delta: the LLM composed day-of-week from reasoning instead of code

Phase 1: Audit existing artifacts
  SKILL.md ✓, code ✓, eval receipt ✓ (but weak — no day-of-week tests)
  Unit tests: ✗ (none existed)
  Integration tests: ✗ (none existed)
  → Missing: items 4, 5, 6. Plus the actual bug.

Phase 2: Fix the code
  - Added a getDayOfWeek(isoDate, tz) helper to the skill's script
  - Updated the formatter to use programmatic day names, never model output
  - Added HARD RULE to SKILL.md: "NEVER derive day-of-week from LLM reasoning"
  - Added a bug entry (template above): date, root cause, fix, tests
  - Bumped version 1.0.0 → 1.1.0

Phase 3: Cross-modal eval — skip (pure deterministic bug fix, behavior
  locked by new tests; prose unchanged)
Phase 3.5: Re-eval skipped per the 3b exception; Phase 7 re-verify still runs

Phase 4: Write tests
  - Unit tests covering every day of the week, timezone edges, formatting
  - Integration tests: state I/O, full pipeline, timezone crossing

Phase 5: Resolver — already routed ✓
Phase 6: E2E — existing pipeline still works ✓
Phase 7: All tests green. Bug fixed. Regression locked in.
```

## Quality Gates

NOT properly skilled until:

- All required items pass (1-2, 4-10; 11 only when applicable; 12-13 only
  when schedule-backed).
- An eval contract exists (item 0) — declared in frontmatter or written back
  after being inferred/asked (Phase 2.5).
- Cross-modal eval (item 3) has a current receipt OR is explicitly waived
  with rationale (item 3 is informational; not blocking, but a missing
  receipt is visible in the audit).
- **No-regression gate passes** (item 3b): new overall ≥ the prior
  iteration's overall; no dimension regressed by more than 0.5.
- **If schedule-backed:** a representative task was re-run, eval'd, and
  scored forward (item 13).
- All tests pass (unit + integration + LLM evals).
- Resolver entry exists with real trigger phrases.
- Check-resolvable shows no orphans, overlaps, or DRY violations.
- Brain filing if applicable.

## Output Format

Skillify produces three durable artifacts per skill:

1. **The skill tree on disk.** `skills/<slug>/SKILL.md` (carrying its
   `eval_contract`), `scripts/<slug>.mjs`, `routing-eval.jsonl`, plus a
   `test/<slug>.test.ts` skeleton. Generated by `gbrain skillify scaffold
   <name>` and refined by the agent into a real implementation.
2. **A cross-modal eval receipt lineage** at
   `~/.gbrain/.gbrain/eval-receipts/<slug>-<sha8>.json`. The sha-8 binds each
   receipt to the SKILL.md content that produced it, so prior receipts
   persist as the no-regression baselines (Phase 3.5). `gbrain skillify
   check` surfaces the current receipt's status (`found` / `stale` /
   `missing`) as informational.
3. **An audit verdict** from `gbrain skillify check`: `properly skilled` |
   `close — create: <missing items>` | `needs skillify — run /skillify on
   <target>`. Score is `<passed>/<total>`. Required items gate the verdict;
   the cross-modal item is informational and never blocks PASS.

JSON output (`gbrain skillify check --json`) includes the same fields plus
the per-item detail string, so agents can route on the structured envelope
without parsing prose.

## Anti-Patterns

- ❌ Writing tests before cross-modal eval (locks in mediocrity)
- ❌ Using budget models for eval (C student grading A student)
- ❌ Using a single provider's family for all 3 slots (correlated blind spots)
- ❌ Skipping eval "because the output looks fine" (your judgment isn't 3 models)
- ❌ Eval without fix cycle (vanity metrics)
- ❌ Evaluating a high-stakes skill on generic dimensions instead of its eval contract
- ❌ Code with no SKILL.md (invisible to resolver)
- ❌ Tests that reimplement production code (masks real bugs)
- ❌ Resolver entry with internal jargon (must mirror real user language)
- ❌ Two skills doing the same thing (merge or kill one)
- ❌ Running cross-modal eval on trivial outputs (< 200 tokens, not worth 9 API calls)
- ❌ Rewriting a skill from scratch when improving it (Mode B exists)
- ❌ Fixing a bug without adding a regression test for the exact bug
- ❌ Fixing a bug without adding a HARD RULE to SKILL.md to prevent recurrence
- ❌ Shipping a skill edit that scores worse than the last iteration (regression — we only go forward)
- ❌ Editing a schedule-backed skill without re-running a representative task and eval'ing its real output
- ❌ Hardcoding one deployment's people or channels into a skill body (declare the principle; let each deployment fill the specifics)
- ❌ Editing one checklist item and skipping the Phase 7 re-verify (silent breakage of items that used to pass)
