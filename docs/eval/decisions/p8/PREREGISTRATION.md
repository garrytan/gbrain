# P8 held-out evaluation: preregistration

This file fixes, before any sealed data is opened, what the held-out runs for P8 compare, on which data, with which
models, and what result turns each switchable part on by default. The custodian (P0) runs the sealed splits; the
implementer never sees them. Dev results that informed these choices are in [DEV_RESULTS.md](DEV_RESULTS.md).

Changing a gate, a metric, a model or a split after a sealed cell has run requires a dated amendment in this file
with its reason, written before the next cell runs.

## Builds

- **Baseline:** gbrain master at the P8 pull request's merge base, pinned by SHA in each decision spec.
- **Candidate:** the P8 pull request head, pinned by SHA. Uncommitted edits are never measured.
- **Harness:** gbrain-evals `p0-heldout-harness`, plus the P8 dev harness additions on `p8-dev-evals` (Cat 40
  `--advertised` arms and mid-run tool lists, the write-cost runner, the withdrawal-review generator and the
  quote-grounding runner), pinned by SHA at the sealed run.
- Same-window controls: every build comparison runs baseline and candidate in the same window on the same machine
  class.

## Models

Newest frontier model of each family, per the eval model rules: `claude-opus-5-5`, `claude-sonnet-5-5`,
`gpt-6.1-sol`, `claude-fable-5-1`. No older generation is added: the dev runs share all four with the sealed runs.
`gpt-5.4-mini` is not run and no finding from it drives a decision. Results are reported Sonnet and GPT first (the
models people use most), then Opus and Fable. A model at or near 100% on every arm is reported as a ceiling and does
not count as evidence of no difference.

## Comparisons and gates

Every paid run starts with a metered 10% pilot; the full budget is extrapolated from the pilot and enforced by the
budget ledger. An underpowered, incomplete or invalid run never turns a default on.

### 1. Write-inference guard (part 1) — always on

- Evidence: CI only. `test/write-path-zero-llm.serial.test.ts`, `test/write-path-no-egress.serial.test.ts`,
  `test/op-write-inference.test.ts`, `scripts/check-ai-sdk-importers.ts`, the layering rule.
- Gate: every write-classified operation and CLI writer makes zero generative attempts before commit. No sealed run.

### 2. Write cost (part 1, published)

- Runner: `eval/runner/p8-write-cost.ts`. Unit: LongMemEval-S sessions written as extraction-eligible `note` pages
  through MCP `put_page`, plus one `remember` per page; background jobs drained afterwards.
- Arms: fact extraction on (default, headline) and off (floor). 1,000 pages per arm.
- Reported per 1,000 messages and per 1,000 pages: generative attempts, embedding tokens, dollars by model,
  `put_page` and `remember` latency p50/p95, job drain time, jobs outstanding after drain.
- Gate: commit-path generative attempts = 0 in both arms. The rest is published, not gated. Cost limit $50.

### 3. Semantic withdrawal review (part 2, `decide.slots.conflict.review_withdraw`)

- Data: withdrawal-review families from `eval/generators/p8-withdraw-review-gen.ts` with a sealed seed and disjoint
  names and attribute values (custodian-generated), plus at least 50 human-written paraphrase pairs. At least 200
  actionable families. About 30% of candidates are restatements; the rest are corrected values, negations, past-tense
  versions, compound claims and independent facts about the same person.
- Procedure: `gbrain decide calibrate --slot conflict --call-site review_withdraw` on the calibrate half, then
  `gbrain decide qualify` on the eval half (family-level Wilson bound). Neighbour retrieval measured with production
  embeddings (`text-embedding-3-large`, 1536 dimensions) against the lane's 0.80 cosine floor, by slice.
- Gates, all required:
  - action precision lower bound ≥ 0.90;
  - end-to-end recall (retrieval × classifier) ≥ 0.60, with retrieval and classifier recall reported separately;
  - zero proposals on corrected-value candidates;
  - N5 forget residue unchanged (`n5-forget-residue` contracts pass on the candidate).
- On pass: the kind turns on by default where the conflict slot is on (a TypeSafe key present). On fail: it ships off.
- Cost limit $30.

### 4. Duplicate review kinds (part 2, `review_duplicate_page`, `review_duplicate_entity`)

- Same protocol per kind, on pairs P5 (page duplicates) and P1 (entity leftovers) generate once those plans land.
  Each kind turns on only if its own qualification passes. Until P1/P5 enqueue candidates, both stay off. Cost limit
  $60.

### 5. `remember.replaces` (part 3) — on

- Evidence: conformance and race tests (`test/remember-replaces.test.ts`,
  `test/e2e/p8-memory-writes-postgres.test.ts`). Zero model calls. No sealed run.

### 6. Quote grounding (part 4, `think.quote_verify`, `dream.quote_verify`)

- Hermetic: planted fabricated, speaker-swapped, near-match and supported quotes per writer
  (`test/think-quote-verify.test.ts`, `test/cycle-synthesize-verify.test.ts`, concept and pattern tests).
  Gate: planted fabricated quotes persisted = 0.
- Paid: `eval/runner/p8-quote-grounding.ts` — `gbrain think` (`claude-sonnet-5-5`) on held-out quote-eliciting and
  natural questions over amara-life-v1 and sealed-confirmation-v2 that were never used in dev, sized to at least 300
  supported quote spans, clustered by question. An independent judge (`gpt-6.1-sol`) labels each span against the
  exact evidence the model was given.
- Gate: supported spans wrongly flagged, Wilson 95% upper bound ≤ 5% (span level), with the question-clustered bound
  reported. Supported information lost is reported. Cost limit $80.
- On fail: the kill switches ship off.

### 7. Advertised tool surface (part 5, `mcp.advertised_surface`, new installs only)

- Cat 40 (`eval/runner/cat40-model-ladder.ts`), gbrain arm, callable surface `full` in every arm, advertised
  `full` (control) vs `starter` vs `verbs`, the four models above, 2 repeats, uncapped tool results.
- Data: a new seed-disjoint world from P0 with at least 100 tasks, including at least 20 hidden-tool tasks that need
  an operation outside the starter set (for example `add_link`, `find_trajectory`, takes search). Memory-only and
  page-authoring strata reported separately.
- Gates for an arm, all required, against the same-window `full` control:
  - pooled success no more than 3 points below control (paired task-bootstrap 95% interval reported);
  - no rise in leaks or context exposures;
  - hidden-tool family success no more than 5 points below control.
  Token and dollar cuts are reported as a sanity check only.
- Decision: among passing arms, the narrower wins and becomes `NEW_INSTALL_ADVERTISED_SURFACE`; if `verbs` wins,
  `rate_answer` joins it as the eighth verb. If neither passes, fresh installs keep advertising `full`.
- Cost limit $800, about 8 hours on Ubicloud.

## Total

About $1,020 across the sealed runs, under the $1,200 program cap including pilots and retries.

## Amendments

### 2026-10-05: custodian-written paraphrase pairs for the withdrawal review (section 3)

Written before P0 generated any sealed withdrawal-review data.

- **Change.** The at least 50 human-written paraphrase pairs in section 3 become at least 50 custodian-written
  pairs. P0 writes them with a model from a family that is neither the reviewer's (TypeSafe Jev, the `conflict`
  slot provider) nor the extraction default's (Anthropic, `facts.extraction_model`), and not the dev generator's
  (OpenAI, `p8-withdraw-review-gen@1`): Google Gemini. P0 spot-checks every pair before it enters the sealed set
  and drops or rewrites any pair whose label is wrong or whose wording repeats the dev generator's templates.
- **Reason.** No human is available to write the pairs. A family different from the reviewer, the extraction
  model and the dev generator keeps the sealed paraphrases from sharing one model's habits with the system that
  judges them or the data the threshold was tuned on.
- **Disclosure.** The verdict record and the PR state that the paraphrase pairs are model-written and
  custodian-checked, not human-written. Every other gate in section 3 is unchanged.

### 2026-10-05: quote grounding retest on fresh sealed quotes (section 6)

Written after the section 6 sealed run failed and before any retest data exists.

- **Change.** One retest of section 6 on a fresh sealed set: new held-out questions and quote spans the second
  custodian writes, disjoint from the dev questions and from the first sealed set, sized to at least 300 supported
  spans and clustered by question. The build is the frozen SHA reported with this amendment. Gate, metric, think
  model, judge and cost limit are unchanged: supported spans wrongly flagged, Wilson 95% upper bound ≤ 5%.
- **What changed in the build.** Matcher gaps the second custodian found in the first run's false flags, described
  without sealed text: link display text kept as `[Name]`, the source's inner `"` written as `'`, editorial brackets
  in or at the end of a word, and (a policy decision) the user's question counted as a grounding source. Unit tests
  in `test/think-quote-verify.test.ts`.
- **Reason.** The first sealed run's text informed these fixes, so it can no longer test them; only fresh quotes can.
- **Outcome.** PASS turns `think.quote_verify` and `dream.quote_verify` on by default; FAIL keeps them opt-in. The
  first run's FAIL stays in the verdict record either way.

### 2026-10-05: Fable at 1 repeat in Cat 40 (section 7)

Written after the Opus, Sonnet and GPT cells finished and before any `claude-fable-5-1` sealed cell runs.

- **Change.** `claude-fable-5-1` runs 1 repeat per task in each arm (`full`, `starter`, `verbs`) instead of 2. The
  other three models keep their 2 repeats. The world, arms, gates, paired task-bootstrap and decision rule are
  unchanged.
- **Reason.** Cost: at 2 repeats the Fable cell would take P8's sealed runs past the program cap.
- **Disclosure.** The verdict record and the PR state that Fable ran 1 repeat per task while the other models ran 2,
  and report Fable's per-model results with that repeat count.
