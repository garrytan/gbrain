# BrainBench — cross-harness memory conformance methodology

BrainBench generalizes gbrain's internal eval surface into a reproducible,
cross-harness benchmark for agent memory. It operationalizes the four failure
modes of the agent-memory thesis: **know-to-ask** (nobody has a push path),
**push precision/recall** (the intrusion budget must be enforced),
**write-back fidelity** (memory write is even less solved than read), and
**cross-session continuity** (continuity that survives the harness hop).
Every subsequent memory PR must move — or hold, with a recorded justification —
a BrainBench number to merge.

Operator quickstart, corpus layout, and fixture-authoring rules live in
[`evals/brainbench/README.md`](../../evals/brainbench/README.md). This document
is the methodology: what the numbers mean, what they deliberately do not mean,
and how the gate governs change.

## Seam disclosure (read this before comparing rows)

Every scoreboard row carries a `seam` column:

| Harness | Seam | What the row actually measures |
|---|---|---|
| `openclaw` | **production** | The shipped OpenClaw context-engine pipeline, byte-for-byte (`extractCandidates` → `resolveEntitiesToPointers`, 3-pointer budget, prior-context suppression, markdown pointer block). |
| `claude-code` | **contract** | gbrain's memory primitives driven through the UserPromptSubmit hook wire contract (`{prompt, session_id, cwd}` in → `{hookSpecificOutput.additionalContext}` out, exported from `src/eval/brainbench/adapters/claude-code.ts`). 2-pointer budget; NO conversation memory — a hook sees only the current prompt, so suppression is off and the re-injection cost is visible as `false_fire_rate`. |
| `codex` | **contract** | The fragments model: a static entity-index preamble (computed once, slugs not counted as injections) + at most ONE per-turn fragment. Measures how much push quality degrades when injection is mostly static. |

**Contract rows do NOT measure third-party harness behavior.** They measure
gbrain's primitives under each harness's injection-shape constraints. The rows
are comparable because fixtures, brain, and gold are identical — only the seam
contract varies. When a real integration lands (the hooks/fragments PR), its
adapter swaps transport (exec the real hook) and flips to `production` with
continuous numbers. Also not graded, by design: the production orchestrator's
config gate, integration heartbeat, and 1500 ms timeout wrapper.

All three adapters drive ONE shared pipeline (`adapters/shared.ts`) with
declarative configs — comparability is structural, not disciplined.

## Metrics (formulas)

All micro-averaged per (harness × suite) cell; registered in
`src/core/eval/metric-glossary.ts` (plain-English in
[`METRIC_GLOSSARY.md`](METRIC_GLOSSARY.md)); JSON output carries one
`_meta.metric_glossary` block.

- `know_to_ask_failure_rate` = |should-retrieve turns where injected ∩ (gold ∪ acceptable) = ∅| / |should-retrieve turns|. Lower better.
- `false_fire_rate` = |stay-silent turns with any injection| / |stay-silent turns|. Lower better. Anti-gaming companion: "always inject" cannot win both.
- `push_precision` = Σ|injected ∩ (gold ∪ acceptable)| / Σ|injected| over turns with injection. `acceptable_slugs` count for precision, not recall.
- `push_recall` = Σ|injected ∩ gold| / Σ|gold| over should-retrieve turns. Pointer budgets cap this by design.
- `write_back_fidelity` = |gold facts that survive the PRODUCTION conversation→memory pipeline and are keyword-findable with correct entity attribution| / |gold facts|. The deterministic mode injects a gold extractor at the pipeline's extractor seam so segmentation, batching, dedup, and provenance stamping execute shipped code with zero LLM calls.
- `provenance_accuracy` = |surviving facts with correct {source, source_session, source_markdown_slug}| / |surviving facts|.
- `continuity_rate` = |decision probes recalled by the reader| / |probes|, per READER harness. The writer fixture's decisions persist through the production write-back pipeline — which is harness-INDEPENDENT in v1 — so each pair preps once and every harness replays the read-only reader against the same persisted state (an ordered writer×reader sweep would rebuild byte-identical brains for identical scores). A probe succeeds via pointer injection or stored-fact keyword lookup. The per-writer axis activates when harness-specific write paths land.
- `source_isolation_violations` = count of injected slugs from a non-active source. **Gates at zero**, every run, regardless of baseline — cross-source leakage is the data-leak invariant. Granularity disclosure: detection is slug-keyed, so it catches injection of slugs seeded ONLY in a foreign source; a same-slug cross-source CONTENT leak would require the engine's source-scoped SQL itself to fail, which the engine-layer source-isolation fuzz (gbrain-evals Cat 22) covers directly.
- `avg_injected_tokens` = mean estimated tokens (chars/4) of injected context per replayed turn. Intrusion-budget diagnostic; reported, NOT gated (gating awaits calibration data — filed TODO).
- `extraction_recall` / `extraction_precision` — `--llm` runs only: the real extractor's output vs gold keyword probes.

### What know-to-ask deliberately means in v1

It grades the **deterministic injection decision** — the Reflex pipeline that
ships at the seam. The agent never "knows to ask"; the reflex pushes. An
agent-LLM-in-the-loop replay (did the *model* issue a retrieval call when the
reflex stayed silent?) is **pre-registered as the `--live` extension**:
fixture-compatible, seeded, N-repeat methodology — and unimplemented. No LLM
grading is faked in v1.

### Difficulty is stratified on purpose

Several know-to-ask variants exercise documented v1 reflex limits (lowercase
mentions, surname-only references — `src/core/context/entity-salience.ts`).
Gold records what SHOULD happen; the committed baseline records what the
current system does (`know_to_ask_failure_rate` ≈ 0.15 at v1). The gap is the
measured roadmap, not a bug in the bench.

## Pre-registered expectations (v1, recorded before the first published run)

1. The production seam (openclaw) leads `push_recall` strictly: 3-pointer > 2-pointer > 1-fragment budgets. *(Observed at landing: 0.81 / 0.65 / 0.45.)*
2. The no-suppression contract (claude-code) is the only seam with `false_fire_rate` > 0. *(Observed: 0.02–0.03.)*
3. `write_back_fidelity` = 1.0 and `provenance_accuracy` = 1.0 in deterministic mode — the production pipeline must not lose or mis-attribute gold facts it was handed. Anything below 1.0 is a pipeline bug, not benchmark noise.
4. `source_isolation_violations` = 0 everywhere.
5. `push_precision` = 1.0 at v1 (exact-match resolution arms cannot inject an irrelevant page on this corpus); expected to dip below 1.0 when fuzzy/semantic resolution lands — that dip is the precision/recall trade made visible.

## Determinism & statistical posture

The harness is deterministic end-to-end: regex extraction + SQL resolution
(zero LLM, zero embeddings — facts seed with NULL embeddings; keyword/alias
arms carry retrieval), seeded PRNG corpus, one in-memory PGLite reset between
fixtures. Two runs produce identical metrics, so N-repeat error bars are
meaningless here (stddev = 0 by construction, the gbrain-evals "deterministic
adapters" convention) and the gate can be exact: **any flipped gold item is a
real behavior change.** Bootstrap/CI discipline applies to the future `--live`
and `--llm` published runs, which are model-stochastic.

## Gate governance (decision 4 — why a PR can't self-approve)

CI (`.github/workflows/test.yml` `brainbench` job, local parity
`scripts/ci-brainbench-gate.sh`) fetches the baseline **from main**
(`git show origin/master:evals/brainbench/baselines/main.json`) and compares
HEAD's fresh run against it:

- **Same `fixtures_hash`** → count-aware gate: any newly-failed gold item, any
  adverse gated-metric move, or any isolation violation fails (exit 1).
- **Different hash** (the PR changed fixtures) → **corpus-bless mode**: the
  PR's committed baseline must EXACTLY match HEAD's actual run (the file
  cannot lie; exit 2 until `--update-baseline` is re-run), and any adverse
  move vs main's baseline requires a `justification` string in the committed
  baseline — visible in the PR diff, judged by the reviewer.
- `--allow-regression "reason"` is the local one-off escape hatch; the reason
  is recorded in the run output. It is not available to CI.

The committed baseline is diff-stable by construction (metrics rounded to 4
decimals, keys sorted, receipts excluded; the run CONFIG — holdout/llm/
harness/suite sets — is bound into it, and comparisons across mismatched
configs are inconclusive). Same-hash hardening: any committed-baseline edit
without a fixture change must byte-match the actual run (receipts-backed), a
regressing receipts-backed update still needs a `justification`, gold_total
may not move at all under an unchanged corpus, and the CI script refuses a
working-tree baseline deletion. Holdout fixtures (~15%) are excluded from the
gate and scored only in published runs (`--include-holdout`).

Accepted residuals (review-enforced, by design): a `justification` string is
judged by the human reviewer, not parsed; count-preserving corpus dilution
(replacing hard fixtures with easy ones at equal gold_total) is visible only
in the fixture diff; and the ratchet does not auto-tighten — improvements
aren't banked into main's baseline until a PR updates it (a regression back
to the stale baseline level passes; periodic re-baselining is the operator's
job, filed as a TODO).

## Gold methodology

Gold derives from the corpus generator (the same PRNG step that authors a turn
authors its annotation, so gold-vs-text drift is structurally impossible for
generated fixtures), plus hand-authored spike fixtures that froze the schema.
A 10% double-label validation pass (independent agent review of fixture text vs
gold, blind to the generator's intent) is run at corpus-change time; its
receipt is recorded in the corpus `_ledger.json` and any disagreement is a
fixture bug to fix, not a tolerance to average over.

## Interop

- **Foreign runners (gbrain-evals):** the subprocess contract is
  `gbrain eval brainbench --fixtures DIR --gold DIR --json --out FILE`;
  schemas in `evals/brainbench/schema/`. The sibling gbrain-evals repo wires
  this as `eval/runner/brainbench-memory.ts` with a published scorecard.
- **Memory-verbs conformance kit (Cathedral 1):** conformance scenarios
  convert to BrainBench fixtures via the published fixture schema
  (`schema_version` 1) once that wave lands — the conversion path is the
  schema itself; no bespoke importer is required.
- **Naming note:** "BrainBench" historically also names the in-house
  retrieval corpus in the sibling gbrain-evals repo (the 145-query relational
  suite, Cat taxonomy) and `test/cathedral-ii-brainbench.test.ts` (v0.20.0
  code-graph recall pins). This suite — the cross-harness memory conformance
  bench — is the generalization the name now primarily refers to; the older
  references stand unchanged.

## Extends docs/eval-bench.md

The capture → baseline → replay loop in [`eval-bench.md`](../eval-bench.md)
gates *retrieval result sets* at the query level. BrainBench gates the
*memory behaviors* above them. The two share the receipts discipline and the
.gbrain-evals run ledger (`EvalRunRecord` v3; brainbench records once per
sweep under `mode: 'n/a'`).
