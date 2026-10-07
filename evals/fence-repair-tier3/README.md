# Tier 3 fence-repair eval (#6188 T4)

Measures how well a chat model repairs the facts and takes fences that the free repair rules (Tier 1) leave malformed, through the production Tier 3 path, and which models are accurate enough to be the default. The preregistration, its round 2 amendment, raw per-item results and verdicts live in gbrain-evals (`docs/benchmarks/2026-10-06-fence-repair-tier3*`).

## Current result

Round 2, measured 2026-10-06 at gbrain `7d75e08c` (prompt version 2: a model may answer HOLD; a corrective re-ask only after gate (a) or (e); Tier 1 `stray_empty_cell`; extra text cells and split claims held before the model). Three runs per model. Gate-pass and false-accept count the fences that reach the model: 33 of the 40 held-out repairable fences (99 attempts per model) and 55 of the 66 round 1 repairable fences (165). The preregistered bar is gate-pass at least 80% and false-accept at most 1%, and a model qualifies only if it meets it on both sets; the held-out set, written before the round 2 code, decides.

| Model | Held-out gate-pass | Held-out false-accept | Round 1 gate-pass | Round 1 false-accept | USD per repair | Latency p50 / p95 | Qualifies |
|---|---|---|---|---|---|---|---|
| `openai:gpt-6.1-sol` | 95/99 (96.0%) | 0/99 | 156/165 (94.5%) | 0/165 | $0.0026 | 3.7 s / 7.1 s | yes |
| `anthropic:claude-opus-5-5` | 95/99 (96.0%) | 0/99 | 157/165 (95.2%) | 0/165 | $0.0081 | 3.9 s / 10.9 s | yes |
| `anthropic:claude-fable-5-1` | 93/99 (93.9%) | 0/99 | 154/165 (93.3%) | 0/165 | $0.0210 | 6.6 s / 17.7 s | yes |
| `anthropic:claude-opus-4-7` | 96/99 (97.0%) | 0/99 | 162/165 (98.2%) | 3/165 (1.8%) | $0.0077 | 1.8 s / 4.5 s | no |
| `anthropic:claude-sonnet-5-5` | 96/99 (97.0%) | 3/99 (3.0%) | 144/165 (87.3%) | 3/165 (1.8%) | $0.0031 | 1.7 s / 3.0 s | no |

Held-out USD and latency shown. So `FENCE_REPAIR_MEASURED_MODELS` (`src/core/fence-repair/measured.ts`) is `openai:gpt-6.1-sol`, `anthropic:claude-opus-5-5`, `anthropic:claude-fable-5-1`: with `models.fence_repair` unset, an OpenAI key gets `gpt-6.1-sol` and an Anthropic key `claude-opus-5-5` (it ties `gpt-6.1-sol` on held-out gate-pass and beats Fable 5.1 on gate-pass, cost and speed). Every held repairable attempt of the three qualifying models was a HOLD; every false accept was a free-text cell in the wrong column. The free tiers repaired every stray-empty-cell fence exactly (18 held-out and 30 round 1 attempts per model). No answer ran out of output tokens and no re-ask ran.

Round 1 (prompt v1, 2026-10-06 at `171a7e24`) found the default then, `claude-opus-4-7`, writing a wrong cell in 8 of 198 repairs (4.0%); its findings led to the round 2 code.

## What's here

| File | Role |
|---|---|
| `cases.ts` | Round 1: 78 hand-written cases. Each is one page whose fence round 1's Tier 1 left with a residual reason a model could clear (`short_row`, `no_header`, `row_before_header`, `extra_cells`, `header_unmapped`), with the whole repaired section written by hand. Sets: 66 `repairable` (a correct repair exists and passes every gate), 9 `adversarial` (the only correct outcome is to stay held: 6 `ambiguous` with two readings the gates cannot tell apart, 3 `unrecoverable` missing a required value) and 3 `gate_limited` (a person would repair them, but the gates forbid the correct table; diagnostic). Unchanged since the preregistered run; the free tiers now decide 17 of them (`FREE_TIER_PATH` in `oracle.ts`). Placeholder names only. |
| `heldout-cases.ts` | Round 2's held-out set: 52 cases written after round 1 and before any round 2 code result, with the same class mix on new pages (40 repairable) plus 6 ambiguous, 4 split-claim (a claim cut in two by an unescaped pipe; the correct outcome is to stay held) and 2 unrecoverable adversarials. The free tiers decide 12 of them. |
| `generate-fixtures.ts` | Deterministic builder: `cases.ts` → `fixtures.jsonl` and `heldout-cases.ts` → `heldout.jsonl` (both committed). Regenerate after editing a case; the keyless test fails on drift. |
| `run-case.ts` | One fixture through the production path: the page becomes a stored-page target, `analyzeFences` runs the free tiers, and `runTier3` makes the model call with the brain's real daily ledger and attempt store (prompt v2, where the model may answer HOLD, held as `llm_declined`; one call per fence; a corrective re-ask only after gate (a) or (e); gates (a)-(g); Tier 1 fixed point). A fence the free tiers repair or hold is reported with that tier. Nothing re-implements a tier or a gate. |
| `oracle.ts` | The $0 label check: a scripted model answers with each ground truth (or adversarial probe) and the real gates must agree with the label; the free tiers must decide the `FREE_TIER_PATH` fixtures as listed; a HOLD answer to every Tier 3 fixture must be held as `llm_declined`. |
| `score.ts` | Pure scoring: the cell-level match rule, the preregistered Tier 3 rates, the whole-path rates (a free-tier repair counting as repaired), wrong writes per tier, how adversarial fences were held, Wilson intervals and the decision rule. |
| `harness.ts` | Runner: `--oracle`, live (`--model`, `--run`, `--out`) and `--score`; every mode takes `--fixtures fixtures.jsonl` (default) or `--fixtures heldout.jsonl`. |

The keyless test is `test/eval-fence-repair-tier3.test.ts` (fixture freshness and coverage floors for both sets, the oracle on both, scorer arithmetic). It guards the instrument, not the score.

## Running

```bash
# Prove every label against the production gates ($0, no key):
bun evals/fence-repair-tier3/harness.ts --oracle
bun evals/fence-repair-tier3/harness.ts --oracle --fixtures heldout.jsonl

# One live run of one model on a fresh throwaway brain (needs the provider key):
bun evals/fence-repair-tier3/harness.ts --fixtures heldout.jsonl --model anthropic:claude-opus-5-5 --run 1 --out results/heldout-opus-5-5-run1.jsonl --max-usd 10
bun evals/fence-repair-tier3/harness.ts --model default --run 1 --out results/default-run1.jsonl   # gbrain's own models.fence_repair resolution

# Score saved runs ($0), one set at a time:
bun evals/fence-repair-tier3/harness.ts --score results/heldout-*.jsonl --json summary-heldout.json
```

A live run sets `models.fence_repair` on its brain (unset for `default`, which resolves to the first measured model with a provider key and refuses to run when there is none), registers list prices gbrain's table lacks in `pricing.overrides` (as `gbrain pricing set` would; none today), and sets `fences.repair.max_usd_per_day` to `--max-usd`, which the daily ledger enforces as a hard ceiling. The per-page cap stays at the production default, so a call the cap cannot cover is refused exactly as in production. A provider error is retried twice after a pause, as the next maintenance run would retry it. Each result row records the tier and outcome (repaired, or held with its gate or failure class), the match against the ground truth, per-call tokens, ledger-priced USD, latency and the model's answer text.

Exit codes: 0 done, 1 oracle violation, 2 infrastructure (no key or no measured model, cap reached, a fixture that already compiles).

## Metrics

- **Gate-pass rate** (preregistered): repairable fences that reached Tier 3 and whose repair passed every gate, over repairable fences that reached Tier 3. A HOLD counts as not repaired.
- **False-accept rate** (preregistered): of those, repairs not matching the ground truth. A match means the same non-empty cell text in the same columns (spacing ignored) and identical text outside the fences.
- **Whole path** (reported): the same rates over every repairable fence, a free-tier repair counting as repaired; **end to end** adds wrong writes per tier.
- **Held correctly** (reported): adversarial fences that stayed held, by kind and by how (before the model, HOLD, a gate, the output budget).
- **USD per repair**: ledger-priced spend on repairable fences that reached the model over their repairs. **Latency**: wall time of the Tier 3 step per fence that made a call (p50, p95).
