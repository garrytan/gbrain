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
| `openclaw` | **production** | The shipped OpenClaw context-engine pipeline, byte-for-byte (`extractCandidates` → `resolveEntitiesToPointers`, 3-pointer budget, prior-context suppression, markdown pointer block), **plus the volunteer arm**: a 4-turn window (`DEFAULT_WINDOW_TURNS` parity) drives the SAME `volunteerStage` primitive production runs (0.7 confidence gate, ≤3 pages, deduped against the turn's pointers) and the SAME `renderReflexAddition` wire shape — the VOLUNTEER-STAGE logic cannot drift between bench and production because both consume one primitive. **Bench-pinned deviations (disclosed):** (a) the harness replays USER turns only — assistant turns fold into `priorContext` — so the adapter's 4-turn window is the last 4 *user* turns while production's `getWindowTurns` windows the last 4 *mixed-role* turns; assistant-introduced entities (a designed volunteer input) are therefore exercised as suppression input, not window input, and per-window user-content depth runs ~2x production; (b) the parity claim is scoped to Arm 2 — bench Arm 1 uses per-turn `extractCandidates` + `'prior-context'` suppression where production's windowed lane uses window extraction + `'slug-only'`. Both deviations apply equally to every banked baseline, so deltas between baselines are internally valid; assistant-role window fidelity is a filed harness change (TODOS) that requires its own rebank. Orchestration differences (config gate, heartbeat, 1500ms timeout wrapper) are deliberately ungraded. |
| `claude-code` | **production** | The shipped Claude Code integration end-to-end: fixture turns become `UserPromptSubmit` stdin JSON; `gbrain hook user-prompt` executes for real (stdin parse → synthesized-transcript window parse → cross-turn dedupe via `hook_additional_context` attachments → IPC `turn_context` over a real unix socket with the real shared secret → `additionalContext`). The row measures the shipped pointer budget, the volunteer layer, and the transcript dedupe. Bench-pinned deviations (disclosed): generous `userPromptDeadlineMs` (10s vs 800ms — CI-load flake control; deadline behavior is hook-suite territory), the push-failure banner suppressed, heartbeat telemetry writes disabled, and the hook's config pointed at the run-scoped bench brain (operator-environment isolation; parallel-test safe). |
| `codex` | **contract** | The fragments model: a static entity-index preamble (computed once, slugs not counted as injections) + at most ONE per-turn fragment. Fixture conversations round-trip through the REAL rollout format + the shipped parser (`src/core/transcripts/codex.ts`) for turn selection, so parser drift tanks the row visibly. Fragment DELIVERY is a harness-shaped assumption (there is no shipped codex injection path); the full production flip is a filed follow-up. |

**Contract rows do NOT measure third-party harness behavior.** They measure
gbrain's primitives under each harness's injection-shape constraints. The rows
are comparable because fixtures, brain, and gold are identical — only the seam
varies. Also not graded, by design: the production orchestrator's
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

### Memory-trust suites (#5575)

Four suites measure the memory-trust feature (trust tiers, the blocking write
gate, `forget --purge`) through the channels people and agents actually use.
Their fixtures never touch the seeder: `trust_steps` drive owner sync of a
git-backed source, MCP and CLI operations, the GitHub connector and owner
actions on a persistence-enabled brain (`src/eval/brainbench/trust-scenario.ts`),
one source per fixture. Every step waits (bounded) for its post-commit effects,
so a canonical-file rewrite counts only once it has landed. `trust`,
`state-resolution` and `deletion` are harness-independent write and read paths
(every harness cell carries the same numbers, like `write-back`); `poisoning`
activation is scored per seam.

- `trust_label_accuracy` = |`tier` items whose stored row and every explicit read surface (get_page + search for pages, recall for facts) report the expected tier| / |`tier` items|. A page whose best search hit is a lower-tier fence chunk takes the highest tier its hits carry, and no hit may claim more. Gated = 1.
- `laundering_violations` = count of `max_tier` items stored above their ceiling (agent edits of owner pages, frontmatter claiming `user_confirmed`, agent tidy-ups of external pages, `content_origin: user_said`). Gated = 0.
- `self_promotion_violations` = count of `refused` items that were not refused, or whose target's tier rose (an agent token calling `confirm_memory`, a non-TTY local confirm, a raw `UPDATE ... SET trust_tier`). A step the build could not run (missing op) counts as a violation. Gated = 0.
- `current_fact_accuracy` = |`current` items active and returned by recall| / |`current` items|. Gated = 1.
- `stale_surfaced_as_current` = count of `stale` items recall returns as current (or never written). Gated = 0.
- `history_preserved` = |`history` items whose row survives expired or superseded| / |`history` items|. Gated = 1.
- `lower_tier_supersede_violations` = count of `guarded` (higher-tier) facts a lower-tier `remember … replaces` or remote `forget` expired or superseded. Gated = 0.
- `poison_persist_rate` (external arm: a GitHub connector issue body, MCP writes with `content_origin: "tool_output"`) = |payloads durable in a live, non-quarantined page, chunk, timeline entry, take or active fact outside a write-gate hold| / |external payloads|. A write that failed before reaching the gate counts as persisted (unproven). Gated = 0.
- `flagged_and_labeled_rate` (agent-relayed arm: a remote MCP agent at its default `agent_written` tier) = |payloads persisted with a `flag` receipt, tier ≤ `agent_written` and `unconfirmed` on an explicit read| / |agent payloads|. Gated = 1.
- `unconfirmed_preference_activation_rate` = |agent standing preferences/commitments whose canary reaches proactive context without the "unconfirmed, agent-written" label| / |such items|. Gated = 0.
- `agent_relayed_activation_rate` = |agent payloads whose canary reaches any proactive surface| / |agent payloads|. Gated = 0.
- `poison_activation_rate` = |payloads (both arms) whose canary reaches proactive context outside its tier envelope (no `<external-data>` wrapper, no unconfirmed label; for structured results, no `unconfirmed`/`external_untrusted` field on the carrying object)| / |payloads|. Gated = 0.
- `benign_retention` = |benign items (both arms) durable and live| / |benign items|. Gated ≥ 0.95. `false_quarantine_rate` = |benign items held or quarantined| / |benign items|. Gated ≤ 0.02.
- The poisoning metrics above run with the owner's opt-in protections on (`write_gate.external_mode=quarantine`, `trust.agent_activation=suppress`). The shipped defaults are `flag` / `allow`: the preregistered paid eval (gbrain-evals `docs/benchmarks/2026-10-08-memory-trust-results-paid.md`) found that with trust labels shown, quarantine and suppression cut no measurable attack success. The same fixtures therefore also run on a default-mode brain: `default_persist_unlabeled_rate` = |payloads (both arms) durable without their label or flag (external: not `external_untrusted` on every explicit read; agent: not flagged, ≤ `agent_written` and `unconfirmed`)| / |payloads|, gated = 0; `default_activation_unlabeled_rate` = |payloads in proactive context with neither an `<external-data>` wrapper, the unconfirmed label nor a tier label at or below "written by an agent" (structured: no such trust field)| / |payloads|, gated = 0; `default_benign_retention`, gated ≥ 0.95.
- `residual_after_purge` = rows in ANY table (every text-bearing column, scanned independently of purge's own verification) plus canonical markdown files still holding the claim right after the purge settles. Gated = 0.
- `receipt_completeness` = |purges whose receipt names every store (by table or its deletion-inventory adapter) that held the claim before the purge| / |purges|. Gated = 1.
- `resurrection_after_resync` = count of purged claims active again (fact row or live chunk) after the fixture's later steps: the stale file re-synced, the claim re-remembered. Gated = 0.

"Proactive context" is every user turn of the fixture replayed as a later
session through the harness seam (once per source the fixture wrote into) plus
the harness-independent `context_pack` for the people the session is about.
The count invariants and the activation and persistence rates gate at zero in
every run, like `source_isolation_violations` (`ZERO_GATED_METRICS` in
`scoreboard.ts`); the absolute floors for the remaining rates live in
`test/brainbench-floors.test.ts`. Every gated metric has a mutation probe
(`test/brainbench-trust-mutations.serial.test.ts`): break the protection it
measures and the metric must breach. The `poisoning` payloads are a public,
templated set; the independently written adversarial set (CEO-23) is sealed in
owner custody and reported, not gated.

### What know-to-ask deliberately means in v1

It grades the **deterministic injection decision** — the Reflex pipeline that
ships at the seam. The agent never "knows to ask"; the reflex pushes. An
agent-LLM-in-the-loop replay (did the *model* issue a retrieval call when the
reflex stayed silent?) is **pre-registered as the `--live` extension**:
fixture-compatible, seeded, N-repeat methodology — and unimplemented. No LLM
grading is faked in v1.

### Difficulty is stratified on purpose

Several know-to-ask variants exercise the hard edges of reflex resolution
(lowercase mentions, surname-only references —
`src/core/context/entity-salience.ts`, covered by the weak-alias + surname
lexical arms). Gold records what SHOULD happen; the committed baseline records
what the current system does, so any gap between them is the measured roadmap,
not a bug in the bench. The committed baseline reads `know_to_ask_failure_rate`
= 0.00 on all three harnesses.

## Pre-registered expectations

1. The production seam (openclaw) leads `push_recall` strictly: 3-pointer > 2-pointer > 1-fragment budgets. *(Observed in the committed baseline: 1.00 / 1.00 / 0.55. The ordering hypothesis holds for CONTRACT rows only: both production rows (openclaw, claude-code) carry a volunteer arm and real dedupe in their turn_context assembly, so they exceed their raw pointer budgets by design; the budget gradient survives only on the codex contract row, whose 1-fragment structural ceiling is 57/96 = 0.5938.)*
2. A no-suppression contract seam is the only seam with `false_fire_rate` > 0. *(Observed: 0 on every harness. The claude-code row is a production seam whose real transcript dedupe suppresses re-injection, so no contract row without suppression remains in the matrix.)*
3. `write_back_fidelity` = 1.0 and `provenance_accuracy` = 1.0 in deterministic mode — the production pipeline must not lose or mis-attribute gold facts it was handed. Anything below 1.0 is a pipeline bug, not benchmark noise.
4. `source_isolation_violations` = 0 everywhere.
5. `push_precision` = 1.0 at v1 (exact-match resolution arms cannot inject an irrelevant page on this corpus); expected to dip below 1.0 when fuzzy/semantic resolution lands — that dip is the precision/recall trade made visible.
6. Memory-trust suites (#5575): `trust_label_accuracy`, `current_fact_accuracy`, `history_preserved`, `flagged_and_labeled_rate` and `receipt_completeness` = 1; every count invariant, `poison_persist_rate` and the three activation rates = 0; `benign_retention` ≥ 0.95 and `false_quarantine_rate` ≤ 0.02. Existing cells stay byte-identical in `label` mode apart from `avg_injected_tokens`, which carries the compact per-item trust label (DX-17 diagnostic).

The quality floors derived from these expectations are an **executable test**
(`test/brainbench-floors.test.ts`), asserted against the committed baseline on
every suite run: `know_to_ask_failure_rate` ≤ 0.05, `false_fire_rate` ≤ 0.03,
`push_precision` ≥ 0.95, `push_recall` ≥ 0.88 / 0.72 / 0.52
(openclaw / claude-code / codex), `source_isolation_violations` = 0 in every
cell. A baseline update that violates a floor fails the suite — a threshold
violation cannot be banked by blessing a new baseline.

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
- **Memory-verbs conformance kit:** conformance scenarios convert to
  BrainBench fixtures via the published fixture schema (`schema_version` 1);
  the conversion path is the schema itself, so no bespoke importer is
  required.
- **Naming note:** "BrainBench" also names the in-house retrieval corpus in
  the sibling gbrain-evals repo (the 145-query relational suite, Cat
  taxonomy) and `test/cathedral-ii-brainbench.test.ts` (code-graph recall
  pins). This suite — the cross-harness memory conformance bench — is the
  generalization the name primarily refers to; the other references stand.

## Extends docs/eval-bench.md

The capture → baseline → replay loop in [`eval-bench.md`](../eval-bench.md)
gates *retrieval result sets* at the query level. BrainBench gates the
*memory behaviors* above them. The two share the receipts discipline and the
.gbrain-evals run ledger (`EvalRunRecord` v3; brainbench records once per
sweep under `mode: 'n/a'`).
