# `gbrain eval takes-quality` — reproducible cross-modal quality eval

`gbrain eval takes-quality` is a CI-able quality gate for the takes layer. Three frontier models
score a sample of takes against a 5-dimension rubric, the runner aggregates to
PASS / FAIL / INCONCLUSIVE, and the receipt persists to `eval_takes_quality_runs`
so a follow-up `trend` or `regress` can compare against history.

This doc is the consumer contract. The sibling [gbrain-evals](https://github.com/garrytan/gbrain-evals)
repo and any future CI gate read receipts shaped exactly like the JSON below.
Fields are additive-stable at `schema_version: 1`. A breaking shape change
bumps the version.

## Subcommands

| Command | Brain required? | Exit codes |
|---|---|---|
| `gbrain eval takes-quality run [flags]` | yes (samples takes) | 0 PASS, 1 FAIL, 2 INCONCLUSIVE |
| `gbrain eval takes-quality replay <receipt>` | **no** (disk-only) | 0 PASS, 1 FAIL, 2 INCONCLUSIVE |
| `gbrain eval takes-quality trend [flags]` | yes (reads runs table) | 0 |
| `gbrain eval takes-quality regress --against <receipt>` | yes | 0 OK, 1 regression |

`replay` is the only mode that runs without `DATABASE_URL` — it reads the
receipt file from disk and re-renders it. The other modes need the brain.

## `run` flags

| Flag | Default | Notes |
|---|---|---|
| `--limit N` | 100 | Random sample of N takes from the brain. |
| `--cycles N` | 3 (TTY) / 1 (non-TTY) | Up to N panel calls before giving up; early-stop on PASS or INCONCLUSIVE. |
| `--budget-usd N` | unset | Abort before next call's projected cost would exceed cap. Models without a `pricing.ts` entry fail loud rather than silently blowing the budget. |
| `--source db|fs` | `db` | `fs` is reserved; the runner refuses it and asks for `--source db`. |
| `--slug-prefix P` | unset | Filter takes to pages whose slug starts with P. |
| `--models a,b,c` | `openai:gpt-5.2,anthropic:claude-opus-4-7,google:gemini-2.5-flash` | Comma-separated panel. |
| `--json` | off | Emit the full receipt to stdout. |

## Receipt JSON shape (`schema_version: 1`)

```json
{
  "schema_version": 1,
  "ts": "2026-05-09T22:00:00.000Z",
  "rubric_version": "v1.0",
  "rubric_sha8": "abcd1234",
  "corpus": {
    "source": "db",
    "n_takes": 100,
    "slug_prefix": null,
    "corpus_sha8": "abcd1234"
  },
  "prompt_sha8": "abcd1234",
  "models_sha8": "abcd1234",
  "models": ["openai:gpt-5.2", "anthropic:claude-opus-4-7", "google:gemini-2.5-flash"],
  "cycles_run": 3,
  "successes_per_cycle": [3, 3, 2],
  "verdict": "pass",
  "scores": {
    "accuracy":            { "mean": 7.8, "min": 7, "max": 9, "scores": [9,7,7], "per_model": {...} },
    "attribution":         { "mean": 7.0, "min": 7, "max": 7, "scores": [7,7,7], "per_model": {...} },
    "weight_calibration":  { "mean": 7.5, "min": 7, "max": 8, "scores": [8,7,7], "per_model": {...} },
    "kind_classification": { "mean": 7.2, "min": 7, "max": 8, "scores": [7,8,7], "per_model": {...} },
    "signal_density":      { "mean": 7.0, "min": 6, "max": 8, "scores": [8,7,6], "per_model": {...} }
  },
  "overall_score": 7.3,
  "cost_usd": 1.85,
  "improvements": ["..."],
  "errors": [],
  "verdictMessage": "PASS: every dim mean >=7 and min >=5 ...",
  "protocol_version": 2,
  "correction_selection_rule": "corrected_if_valid",
  "corrections": [
    { "cycle": 0, "modelId": "google:gemini-2.5-flash", "first_error": "incomplete_scores: missing dim(s) [accuracy]", "corrected": "valid" }
  ]
}
```

### Field reference

- `schema_version` — locks the contract. Adding optional fields is additive
  and compatible. Renaming, removing, or changing semantics bumps the version.
- `rubric_version` + `rubric_sha8` — segregate trend rows by rubric epoch.
  When the rubric definition changes, both fields update,
  and trend mode groups runs accordingly so a stricter rubric doesn't
  silently look like a quality drop.
- `corpus.corpus_sha8` — fingerprint over the joined takes-text the judge
  saw. Determines whether two runs are over the "same" sample.
- `models_sha8` — fingerprint over the sorted model id list. Re-ordering
  models in `--models` doesn't change the sha (sort is stable).
- `successes_per_cycle` — count of contributing models per cycle. A model
  contributes when (a) its JSON parsed AND (b) every declared rubric dim
  has a finite score (a missing dim drops the whole contribution).
- `verdict` — `pass` if every dim mean >= 7 AND every dim min across
  contributing models >= 5; `fail` otherwise; `inconclusive` if fewer than
  2/3 models contributed complete scores.
- `protocol_version` — the eval protocol (absent on older receipts, read as
  1). Protocol 2 runs every judge with thinking off (so a judge-sized output
  cap is not spent on reasoning) and re-asks a malformed slot once. `regress`
  lists a protocol change among the dissimilar inputs.
- `corrections` — one entry per slot whose reply was malformed: unparseable
  (`parse_failed`, including an empty reply) or missing a dimension
  (`incomplete_scores`). The same model gets the same sample once more with
  the validator's error appended. `first_error` is the first attempt's
  failure; `corrected` is `valid`, `invalid` (with `corrected_error`), or
  `null` when the correction was not sent (`skipped_reason`: `budget` when the
  cap could not cover it, `aborted`). Under `correction_selection_rule:
  corrected_if_valid` a corrected reply replaces the first attempt only when
  it validates. Provider errors and valid low scores are never re-asked.
  Correction calls count toward `cost_usd` and the budget cap.
- `cost_usd` — sum of per-call cost via `pricing.ts` (a rate registered with
  `gbrain pricing set`, else the canonical table). An unpriced model with
  `--budget-usd` set refuses with `no_pricing` before any call fires; its fix
  is `gbrain pricing set <model> --input <usd/1M> --output <usd/1M> --source
  <url>`. Without a cap it runs with a warning and its spend is not counted.

## Receipt persistence

Receipts persist to **`eval_takes_quality_runs`** (the DB is authoritative)
AND to disk at `~/.gbrain/eval-receipts/takes-quality-<corpus>-<prompt>-<models>-<rubric>.json`
as a best-effort artifact. The DB row carries the full receipt JSON in the
`receipt_json` JSONB column, so when the disk artifact is gone, `replay`
can still reconstruct via `loadReceiptFromDb`.

The 4-sha primary key is unique (`UNIQUE` constraint) so re-running an
identical eval is `INSERT ... ON CONFLICT DO NOTHING` — idempotent.

## Trend output

Plain text (default):

```
ts                   rubric  verdict       overall  cost     corpus
─────────────────────────────────────────────────────────────────────────────
2026-05-09T22:00:00  v1.0    pass             7.3   $1.85   abcd1234
2026-05-08T18:30:00  v1.0    fail             6.8   $1.92   ef567890
```

JSON shape (`--json`):

```json
{
  "schema_version": 1,
  "rows": [
    { "id": 42, "ts": "...", "rubric_version": "v1.0", "verdict": "pass",
      "overall_score": 7.3, "cost_usd": 1.85, "corpus_sha8": "abcd1234" }
  ]
}
```

## Regress: gating CI on quality

```bash
# Capture a baseline.
gbrain eval takes-quality run --limit 100 --json \
  > .ci/takes-quality-baseline.json

# Later, after changing the extraction prompt:
gbrain eval takes-quality regress --against .ci/takes-quality-baseline.json \
  --threshold 0.5
# exit 0 → no regression past threshold
# exit 1 → some dim dropped > 0.5; CI fails
```

The threshold is the per-dim-mean drop counting as regression. Default 0.5.
Regress reuses the **same** model panel + slug prefix + source as the prior
receipt for an apples-to-apples compare. Diffs in `corpus_sha8` /
`prompt_sha8` / `rubric_sha8` / `protocol_version` are surfaced as informational warnings (the
runner doesn't refuse — that's the caller's call).

## Contract stability

The shape above is the read contract for downstream consumers. Anything
not listed (e.g. internal aggregator state, gateway providerMetadata) is
**not** in the receipt and may change without notice.

When you need to evolve the schema:
1. Additive optional field → no version bump; old consumers ignore the
   new key, new consumers read it.
2. Renamed or removed field, or changed semantics → bump
   `schema_version` to `2`; runner emits both shapes for one release as
   a deprecation runway.
