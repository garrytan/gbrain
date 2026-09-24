# Situation-aware recall (experimental)

Situation-aware recall helps find an old memory when a new task uses different words. A saved dietary restriction, for example, might matter when choosing a restaurant. GBrain can build a small set of generated situation cues that point back to the original source.

Cues are retrieval metadata, not new facts. Search returns original evidence, and proactive context returns source pointers. Cue text does not become a page, fact, answer snippet, or injected explanation. This design is informed by [T-Mem](https://arxiv.org/abs/2606.15405); GBrain's implementation uses its own storage, authorization, generation jobs and search pipeline.

**Everything is off by default.** Ordinary keyless memory remains available. Enabling this feature does not enable automatic conversation capture. Generated associations can be wrong; do not treat an explicit similarity threshold as proof of calibrated accuracy.

**Say to your agent:** *"Preview situation-aware recall for this source, explain
the cost bounds, and wait for my approval before starting a build or enabling
reminders."*

## Before enabling

You need a configured, priced chat model and text embedding model, explicit source enrollment, and a build spending cap. Provider-backed construction sends source text and generated cues to those configured providers. Local storage does not make those calls local.

The exact OpenRouter generation route `openrouter:anthropic/claude-sonnet-4.6`
has a declared price of $3 per million input tokens and $15 per million output
tokens, verified against the [OpenRouter model catalog](https://openrouter.ai/api/v1/models)
on 2026-09-23. Router prices are explicit entries, never aliases to native vendor
prices; unlisted routes still refuse build admission. This price entry neither
selects a default model nor authorizes spending or enables generation.

The new gbrain-evals associative-retrieval category and cross-category comparison gate distinguish semantic-quality measurements from deterministic plumbing tests. Live quality and non-regression results must be collected for the selected models before promoting a configuration. No T-Mem result establishes a GBrain gain.

Administration is trusted-local only. HTTP and stdio agent-facing callers cannot configure, submit, cancel or resume cue builds through this operation, even with an admin token. They can use ordinary authorized search when the operator enables cue recall.

## Window policy and pipeline upgrades

The `situation-v3` pipeline constructs windows of at most 8,192 UTF-8 bytes,
including carried speaker attribution. It retains up to 640 bytes of overlap
and preserves Unicode code-point boundaries, splitting long turns as needed.
Each window spans at most three original chunks. The full eligible history is
windowed rather than trimmed. Grounding
still allows at most four spans, and generation still emits at most four cues
with a 1,200-token output limit. Windows execute serially.

This is a prospective construction-cost policy, not a measured retrieval gain.
Larger windows can reduce request overhead and serial build time, but increase
each window's reservation and make more evidence compete for the same four-cue
output limit. Preview bounds include JSON framing and worst-case escaping;
they are not measured provider charges or a whole-corpus cost estimate. Run the
chosen profile's cost and quality checks before enabling it.

Pipeline identity is part of both the cue signature and the independent read
and push calibration bindings. Existing `situation-v2` cues are not reused by
v3, and old builds cannot resume as v3 builds. Explicitly approve a new build
to regenerate cues, then recalibrate retrieval and reminders separately, even
when the embedding model is unchanged. There is no automatic backfill, budget
transfer, or refill of an old build's allowance. Canonical memories are unchanged.

## Inspect and enroll a source

```sh
gbrain memory-cues status --source-ids default

# Without --apply this previews configuration only.
gbrain memory-cues configure --source-ids default --generation-enabled
gbrain memory-cues configure --source-ids default --generation-enabled --apply

# Read-only preparation: no provider request or index build.
gbrain memory-cues preview --source-ids default --page-limit 100
```

`--source-ids` names explicit sources inside the selected brain. It is not cross-brain federation. Use the normal brain-routing options to select a different database. Missing/archived sources are rejected; no wildcard enrollment is implied.
Enrollment and an individual build accept at most 1,000 explicit sources; page
and window limits and the approved spending cap remain independently bounded.

## Submit a bounded build

```sh
# Example budget, deliberately supplied by the operator.
gbrain memory-cues build --source-ids default --page-limit 100 \
  --window-limit 8 --max-usd 2 --apply
```

The result identifies the build, job and durable budget owner. On PGLite, an
explicit build/resume also attempts one bounded pass while the CLI owns the
database and returns that progress. A running resident owner drains pending
passes; Postgres uses the existing Minion worker. No new daemon is installed.
Later passes resume from durable progress. Completed windows may be usable while
page coverage is partial. A valid empty cue set is recorded rather than retried
forever.

All passes, incremental updates and retries draw from the original durable allowance. Unknown model pricing, a missing owner, exhausted funds or revoked enrollment stop admission. An uncertain in-flight charge remains reserved after a crash; replay cannot refund it twice. Creating a new build with a new cap is a new explicit spending approval, not an automatic budget reset.

```sh
gbrain memory-cues status --source-ids default --build-id "$BUILD_ID"
gbrain memory-cues cancel --build-id "$BUILD_ID" --apply
gbrain memory-cues resume --build-id "$BUILD_ID" --apply
```

Resume preserves the original budget and rechecks source/model/consent state. Cancellation prevents later publication; an already-admitted provider request may still have incurred cost. Routine writes only schedule incremental work when enrollment and a usable approved build permit it. A failed cue job does not roll back a successful canonical memory write.

## Observe before admitting results

Choose an encoder-specific retrieval threshold from the evaluation process. There is no portable default threshold. The following commands require an operator-provided numeric value in `READ_THRESHOLD`:

```sh
gbrain memory-cues configure --read-mode shadow \
  --min-similarity "$READ_THRESHOLD" --apply
gbrain search "where should we go for dinner?" --explain

# Only after the selected configuration passes the evaluation gates:
gbrain memory-cues configure --read-mode on --apply
```

Shadow mode computes candidates and reports metadata without adding them to search results. On mode gives all cues together one bounded fusion vote, with at most one vote per source-qualified page. The default vote weight is 0.25; its allowed range is greater than zero through 0.5. More cues do not buy more votes.

Reranking can use a separately labeled cue view, but the source snippet and raw source similarity remain unchanged. A cue match does not establish that a similarly named page already exists or upgrade the source's factual confidence. Exact lookups and existing output-token budgets retain their contracts.

Each selected threshold is bound to its embedding descriptor and construction-pipeline version. Changing either the pipeline or the model, dimensions or vector representation invalidates it until explicitly chosen again. Old cue vectors are not searched in a different semantic space. Missing/stale cue indexes fall back to ordinary retrieval with diagnostic reasons; a core database outage remains an error.

For controlled evaluation, `configure --families scene` or `--families horizon`
selects one family from already generated cues without another model call.
The default is scene plus horizon. Reading bridge cues requires selecting
`bridge`; generating them additionally requires a build with `--include-bridge`.
Use a fresh build/index for that construction experiment rather than adding
another generation to the comparison baseline. Configuration changes need their
own quality checks; the family selector is not evidence that a variant improved.

## Proactive reminders are a separate choice

Situation reminders require both an explicit push opt-in and a separately chosen `PUSH_THRESHOLD`. Setting a retrieval threshold does not certify an old push threshold for a new model.

```sh
gbrain memory-cues configure --push-enabled \
  --push-min-similarity "$PUSH_THRESHOLD" --apply
```

The supported volunteer/turn-context/reflex paths can consider a situation even when no named entity is extracted. At most one situation pointer is added inside the existing shared page budget, with named-entity pointers taking priority. The visible reason is a fixed label, not the generated association. Source fetches remain the evidence path.

Existing harness capabilities, authentication and timeouts still apply. Configuring the feature is not proof that a harness injected anything; use its actual delivery tests and diagnostics. No new third-party harness support is implied.

OpenClaw's engine-free reflex also needs `GBRAIN_MEMORY_CUES_PUSH=1` in the
harness environment, or an explicit host situation-recall capability. This
attempt gate preserves the default no-entity/no-brain-access fast path. It does
not bypass the database push opt-in, source enrollment or separate calibration.
An entity-only host capability never silently falls through to another brain.

## Corrections, privacy and rollback

Cue publication binds the source incarnation, canonical revision, safe chunk snapshot and model. Reads check current scope and source state again after asynchronous ranking. Editing, re-chunking, reconciling, withdrawing or deleting a memory prevents an old worker from making its obsolete cues current. Identical slugs in different sources are different pages.

Remote recall retains ordinary private-page, source and safe-evidence policies. Proactive pointers are world-visible by default within the caller's authorized brain/source scope. Forgetting removes a fact from active recall; it does not promise physical erasure of old source files or backups.

```sh
# Disable paid generation, cue retrieval and situation reminders.
gbrain memory-cues configure --generation-enabled false \
  --read-mode off --push-enabled false --apply
gbrain doctor
```

Disabling does not delete canonical memories or require reversing an additive schema migration. The local doctor check reports uncalibrated, empty, stale, pending or blocked cue state without generating or repairing anything. Configuration changes alone do not establish that the live evaluation gates passed.
