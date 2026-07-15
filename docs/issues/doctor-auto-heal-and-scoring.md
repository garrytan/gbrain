# Doctor Auto-Heal and Scoring Improvements

## Summary

The `gbrain doctor` health score system has several false-positive patterns and missing auto-heal capabilities. After the crash classification fix (shipped in this PR), these are the remaining improvements ranked by impact.

---

## 1. Frontmatter severity levels

### Problem

`NESTED_QUOTES` warnings dominate the frontmatter check (6,900+ of ~7,100 total issues). These are cosmetic YAML style issues — values like `title: "foo"` where the quotes are technically unnecessary. They don't affect sync, search, embedding, or any functionality.

By counting them the same as `YAML_PARSE` (actual parse failures) or `MISSING_OPEN` (missing frontmatter delimiters), the frontmatter check is perpetually WARN and the real issues are lost.

### Evidence

```
frontmatter_integrity: 7131 issues across 3 sources
  default: 7012 (NESTED_QUOTES=6922, YAML_PARSE=90)
  media-corpus: 16 (MISSING_OPEN=15, YAML_PARSE=1)
  zion-brain: 103 (MISSING_OPEN=14, NESTED_QUOTES=89)
```

Only 280 of 7,131 issues are real problems. 96% are cosmetic noise.

### Proposed Fix

- Introduce severity levels: `error` (YAML_PARSE, MISSING_OPEN) vs `info` (NESTED_QUOTES)
- Doctor WARN/FAIL only on error-level issues
- Report info-level in the message text but don't affect check status
- Optional `--pedantic` flag includes info-level in status

### Test Cases

| Frontmatter issues | Severity breakdown | Expected status |
|---|---|---|
| 0 issues | n/a | OK |
| 50 NESTED_QUOTES only | 0 error, 50 info | OK (with note) |
| 3 YAML_PARSE | 3 error | WARN |
| 6900 NESTED_QUOTES + 3 YAML_PARSE | 3 error, 6900 info | WARN (mentions 3 errors) |

---

## 2. Temporal contradiction awareness

### Problem

The contradiction probe flags temporal evolutions as contradictions. Example:

- Page A (April): "Considering option X"
- Page B (May): "Decided on option Y"

These aren't contradictions — they're the same topic evolving over time. The probe has no time awareness.

### Evidence

From a probe run on 50 queries with top-k=15:
- 120 contradictions detected (112 high, 8 medium)
- After manual review: ~60% were temporal evolutions, not real conflicts
- Pages have `effective_date` or `created` timestamps that could disambiguate

### Proposed Fix

- Pass `effective_date` / `created` to the judge prompt
- Add verdict: `temporal_supersession` (later claim supersedes earlier)
- When both pages have dates and claims overlap, bias toward temporal interpretation
- Already designed in PR #993

### Test Cases

| Page A date | Page A claim | Page B date | Page B claim | Expected verdict |
|---|---|---|---|---|
| 2026-04 | "Considering X" | 2026-05 | "Chose Y" | temporal_supersession |
| 2026-04 | "Revenue is $1M" | 2026-04 | "Revenue is $500K" | contradiction |
| null | "X is true" | null | "X is false" | contradiction |
| 2025-01 | "CEO of Company" | 2026-01 | "Former CEO" | temporal_supersession |

---

## 3. Multi-source drift baseline

### Problem

4,791 pages show "multi-source drift" due to a pre-v0.30.3 `putPage` routing bug. These pages exist at the `default` source but should be at a named source. The `sources rehome` command to fix this hasn't shipped yet.

Every doctor run shows WARN for ~4,800 pages nobody can fix.

### Proposed Fix

Allow `doctor.baselines` config to acknowledge known-unfixable counts:

```yaml
doctor:
  baselines:
    multi_source_drift: 4800
```

When actual drift ≤ baseline: OK. When drift exceeds baseline: WARN (new drift).

Store in `.gbrain/doctor-baselines.json` so it works without config too:

```json
{
  "multi_source_drift": { "count": 4800, "acknowledged_at": "2026-05-15", "reason": "pre-v0.30.3 putPage misroutes" }
}
```

### Test Cases

| Actual drift | Baseline | Expected |
|---|---|---|
| 4791 | 4800 | OK |
| 4900 | 4800 | WARN ("100 new drift beyond baseline") |
| 4791 | 0 (no baseline) | WARN (current behavior) |

---

## 4. Image assets acknowledgment

### Problem

When image files are missing from disk (stored externally, purged from git), the check permanently warns. No way to say "these are intentionally external."

### Proposed Fix

- `doctor --acknowledge image_assets` marks current missing count as accepted
- Stored in `.gbrain/doctor-baselines.json`
- WARN only for NEW missing images beyond acknowledged count
- Optional `image_assets.external_storage: true` config to skip disk check entirely

---

## 5. Auto-heal mode

### Problem

Many doctor warnings have known fixes that are safe to auto-apply:

| Warning | Auto-fix |
|---|---|
| Supervisor not running | Start supervisor |
| Stale embeddings | Submit `embed --stale` job |
| Extract coverage < 70% | Submit `extract all --skip-existing` job |
| Stale sync | Submit sync job |
| Effective date drift | Run `reindex-frontmatter` |

### Proposed Fix

`doctor --auto-heal` mode:

1. Run all checks
2. For fixable WARNs: submit fix as a job (not inline — via job queue)
3. Report what was fixed vs needs manual attention
4. Idempotent: check queue first, don't submit duplicates
5. Safety gate: never auto-heals FAILs, only WARNs

Config:

```yaml
doctor:
  autoHeal:
    enabled: true
    minInterval: "6h"
    skip:
      - image_assets
      - multi_source_drift
```

### Test Cases

| Check status | Auto-heal enabled | Job already queued | Expected |
|---|---|---|---|
| WARN: stale embeds | yes | no | Submit embed job |
| WARN: stale embeds | yes | yes | Skip (idempotent) |
| FAIL: max_crashes | yes | n/a | Don't auto-fix FAILs |
| WARN: stale embeds | no | n/a | Report only |
| WARN: image_assets | yes (but skipped) | n/a | Report only |

---

## 6. Score delta tracking

### Problem

No history — each `doctor` run is a snapshot. Can't tell if score is improving or degrading.

### Proposed Fix

- Write each run to `.gbrain/doctor-history.jsonl`:
  ```json
  {"ts":"2026-05-15T12:00:00Z","score":60,"brain_score":79,"checks":{"supervisor":"ok","embeddings":"ok",...}}
  ```
- `doctor --trend` shows last N scores with deltas
- `doctor --json` includes `previous_score` and `delta` fields

---

## 7. Weighted scoring

### Problem

Going from 99% → 100% embed coverage weighs the same as 50% → 51%. But the last percent is the hardest (oversized pages, rate limits).

### Proposed Fix

Threshold-based scoring:
- 100% = full points
- ≥95% = 90% of points
- ≥80% = 70% of points
- <80% = proportional

---

## Priority Order

1. Frontmatter severity levels (highest noise reduction)
2. Temporal contradiction awareness (highest false positive reduction, already designed)
3. Auto-heal mode (biggest long-term value)
4. Score delta tracking (enables monitoring)
5. Multi-source drift baseline (quality of life)
6. Image assets acknowledgment (quality of life)
7. Weighted scoring (nice to have)
