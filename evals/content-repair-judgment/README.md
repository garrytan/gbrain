# Content-repair judgment eval (#6377)

Measures which chat models may judge a `frontmatter_slug_conflict` hold that the deterministic tier leaves undecided: is the held file a duplicate of the page its `slug:` line names (`merge_into` a canonical), a stray line (`remove_slug`), or a case for a person (`needs_human`)? The result decides `CONTENT_REPAIR_MEASURED_MODELS` (`src/core/content-repair/measured.ts`). The preregistration is [`PREREGISTRATION.md`](PREREGISTRATION.md); raw results and the verdict are mirrored into gbrain-evals (`docs/benchmarks/2026-10-09-content-repair-judgment*`).

## Current result

Measured 2026-10-09 at gbrain `ac6e0868` (branch `capy/gbra72-content-repair`, prompt version 1) with the harness from the same change; three runs per model, 432 pair runs, $2.05 in all. Every model qualifies: no hard failure in 144 pair runs each, no unusable answer, every stray slug removed, every ambiguous pair deferred, and every adversarial pair answered `remove_slug` or `needs_human`. They differ on how many true duplicates they merge rather than defer.

| Model | Hard failures | True-duplicate accuracy | needs_human rate | USD per pair | Latency p50 / p95 | Qualifies |
|---|---|---|---|---|---|---|
| `anthropic:claude-opus-5-5` | 0/144 | 69/75 (92.0%) [83.6, 96.3] | 18.8% | $0.0088 | 3.0 s / 6.4 s | yes |
| `openai:gpt-6.1-sol` | 0/144 | 64/75 (85.3%) [75.6, 91.6] | 20.1% | $0.0022 | 2.7 s / 7.3 s | yes |
| `anthropic:claude-sonnet-5-5` | 0/144 | 60/75 (80.0%) [69.6, 87.5] | 24.3% | $0.0033 | 1.6 s / 2.4 s | yes |

So `CONTENT_REPAIR_MEASURED_MODELS` (`src/core/content-repair/measured.ts`) is `anthropic:claude-opus-5-5`, `openai:gpt-6.1-sol`, `anthropic:claude-sonnet-5-5`, best first by true-duplicate accuracy. Sonnet 5.5 sits exactly on the 80% bar (per run 84%, 80%, 76%), and the intervals of gpt-6.1-sol and Sonnet 5.5 reach below it, so the order of the two Anthropic models is settled and the rest is one true duplicate either way. Every true duplicate a model did not merge was a `needs_human`, almost all on pairs whose two hygiene notes each read "Duplicate of the other": the models read the pair as the same thing but the notes as disagreeing about which page is primary (see the `why` field in the mirrored result rows). The five pairs whose identity evidence sits past body line 60 were read through `mentions`: the three late-note duplicates were merged except `td-n-14`, which gpt-6.1-sol deferred in all three runs and Opus 5.5 in two, and the two late-evidence adversarial pairs were never merged (Opus 5.5 deferred `adv-08` in all three runs). Raw rows, `summary.json`, `summary.md` and `verdict.json` live in gbrain-evals (`docs/benchmarks/2026-10-09-content-repair-judgment/`); nothing is committed under `results/` here.

## What's here

| File | Role |
|---|---|
| `cases.ts` | 48 hand-written pairs: 25 true duplicates (15 with mutual hygiene notes, 3 of them past line 60; 3 with the held file as canonical; 10 with no notes), 10 stray slugs (compendia, template pages, copied pages, cross-type title tokens), 8 adversarial (same name at different employers, a `-2` suffix on a different person, forged duplicate notes, identity evidence only past line 60) and 5 ambiguous (sparse pages sharing a first name). Placeholder names only. |
| `generate-fixtures.ts` | Deterministic builder: `cases.ts` → `fixtures.jsonl` (committed): each file's path, slug and content, the canonical, and the expected verdict set (`best`, `acceptable`, `hard`). Regenerate after editing a case; the keyless test fails on drift. |
| `input.ts` | A fixture pair as the judgment input, through the production participant builder (`judgmentParticipant`): frontmatter with the `slug:` line, headings, the first 60 non-blank body lines and later lines mentioning the other page (`mentions`). |
| `check.ts` | The $0 instrument checks: set counts, placeholders, slug lines, canonicals, late evidence inside `mentions`. |
| `score.ts` | Pure grading and summaries: the grade of a verdict (`best`, `acceptable`, `guess`, `hard_failure`, `no_answer`), per-model and per-set counts, Wilson intervals, the decision rule and the ranking. |
| `report.ts` | The JSON report and the Markdown tables, including the proposed `CONTENT_REPAIR_MEASURED_MODELS`. |
| `harness.ts` | Runner: `--check` ($0), live (`--model`, `--run`, `--out`: the production `askJudgment` call per pair; no ledger, no memo) and `--score`. |

The keyless test is `test/eval-content-repair-judgment.test.ts`. It guards the instrument, not the score.

## Running

```bash
# Prove the instrument ($0, no key):
bun evals/content-repair-judgment/harness.ts --check

# One live run of one model (needs the provider key):
bun evals/content-repair-judgment/harness.ts --model anthropic:claude-opus-5-5 --run 1 --out results/opus-5-5-run1.jsonl

# Score saved runs ($0):
bun evals/content-repair-judgment/harness.ts --score results/*.jsonl --json summary.json --md summary.md
```

## Metrics

- **Hard failures** (preregistered): `remove_slug` on a true duplicate, `merge_into` on a stray or adversarial pair, or `merge_into` the wrong canonical. Zero required.
- **True-duplicate accuracy** (preregistered): `merge_into` with the right canonical over true-duplicate pair runs. At least 80% required.
- **needs_human rate**: deferrals over all pair runs; always acceptable.
- **No answer**: no usable verdict (malformed, truncated, refused, unavailable); safe, reported apart.
- **Cost and latency**: USD per pair run from gbrain's price table; wall time p50 and p95.

Ranking: qualifying models first, by true-duplicate accuracy, ties to the cheaper model.
