# Takes Quality Evaluation

`cortex eval takes-quality` is the reproducible quality gate for Cortex
synthesized takes. It samples tenant-approved takes, scores them against a
multi-dimension rubric, writes a receipt, and can compare future runs against
that receipt.

## Commands

| Command | Data Required | Exit Codes |
|---|---|---|
| `cortex eval takes-quality run [flags]` | Tenant sample | `0` pass, `1` fail, `2` inconclusive |
| `cortex eval takes-quality replay <receipt>` | Receipt file only | `0` pass, `1` fail, `2` inconclusive |
| `cortex eval takes-quality trend [flags]` | Tenant receipts table | `0` |
| `cortex eval takes-quality regress --against <receipt>` | Tenant sample and prior receipt | `0` ok, `1` regression |

## Rubric

The default rubric scores five dimensions:

| Dimension | What It Measures |
|---|---|
| Accuracy | The take follows the cited source material |
| Attribution | Claims are grounded in traceable sources |
| Weight calibration | Confidence and importance match the evidence |
| Kind classification | Fact, preference, policy, opinion, and decision types are labeled correctly |
| Signal density | The take is useful without padding |

A run passes when every dimension mean is at least `7` and every contributing
model's minimum score is at least `5`. A run is inconclusive when fewer than
two of three panel models return complete parseable scores.

## Run Flags

| Flag | Default | Notes |
|---|---|---|
| `--limit N` | `100` | Sample size |
| `--cycles N` | `3` in TTY, `1` in CI | Maximum panel cycles |
| `--budget-usd N` | unset | Abort before exceeding budget |
| `--source db|fs` | `db` | Corpus source |
| `--slug-prefix P` | unset | Limit sample to a source or team prefix |
| `--models a,b,c` | managed default panel | Override judge panel |
| `--json` | off | Emit the full receipt to stdout |

Example:

```bash
cortex eval takes-quality run \
  --limit 100 \
  --budget-usd 10 \
  --slug-prefix sales/ \
  --json > .ci/evals/takes-quality-baseline.json
```

## Receipt Shape

```json
{
  "schema_version": 1,
  "ts": "2026-05-09T22:00:00.000Z",
  "rubric_version": "v1.0",
  "rubric_sha8": "abcd1234",
  "corpus": {
    "source": "db",
    "n_takes": 100,
    "slug_prefix": "sales/",
    "corpus_sha8": "abcd1234"
  },
  "prompt_sha8": "abcd1234",
  "models_sha8": "abcd1234",
  "models": ["openai:gpt-4o", "anthropic:claude-opus-4-7", "google:gemini-1.5-pro"],
  "cycles_run": 1,
  "successes_per_cycle": [3],
  "verdict": "pass",
  "scores": {
    "accuracy": { "mean": 7.8, "min": 7, "max": 9, "scores": [9, 7, 7] },
    "attribution": { "mean": 7.0, "min": 7, "max": 7, "scores": [7, 7, 7] },
    "weight_calibration": { "mean": 7.5, "min": 7, "max": 8, "scores": [8, 7, 7] },
    "kind_classification": { "mean": 7.2, "min": 7, "max": 8, "scores": [7, 8, 7] },
    "signal_density": { "mean": 7.0, "min": 6, "max": 8, "scores": [8, 7, 6] }
  },
  "overall_score": 7.3,
  "cost_usd": 1.85,
  "improvements": [],
  "errors": [],
  "verdictMessage": "PASS"
}
```

The shape is additive-stable at `schema_version: 1`. Breaking changes require a
new schema version and a compatibility window.

## Persistence

Receipts are written to the tenant database and, when configured, to a managed
artifact location. The database copy is authoritative for trend and regression
views.

The uniqueness key is:

- corpus hash
- prompt hash
- model-panel hash
- rubric hash

Re-running the same evaluation is idempotent.

## Regression Gate

```bash
cortex eval takes-quality regress \
  --against .ci/evals/takes-quality-baseline.json \
  --threshold 0.5
```

The threshold is the maximum allowed per-dimension mean drop. Regression mode
reuses the model panel, slug prefix, source, and rubric from the baseline so the
comparison is fair.

## Trend Output

```bash
cortex eval takes-quality trend --json
```

```json
{
  "schema_version": 1,
  "rows": [
    {
      "id": 42,
      "ts": "2026-05-09T22:00:00.000Z",
      "rubric_version": "v1.0",
      "verdict": "pass",
      "overall_score": 7.3,
      "cost_usd": 1.85,
      "corpus_sha8": "abcd1234"
    }
  ]
}
```

Use trend output in the dashboard quality tab and in investor-demo runbooks so
quality movement is visible instead of anecdotal.
