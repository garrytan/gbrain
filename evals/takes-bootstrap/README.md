# takes-bootstrap classifier eval (TODO-E graduation instrument)

The 100+-case eval that gates the takes-bootstrap autopilot tier
(`TODOS.md` TODO-E: the tier stays `manual_only` until a live run of this
suite GRADUATES).

## What's here

| File | Role |
|---|---|
| `generate-corpus.mjs` | Deterministic builder: 41 hand-authored archetypes × 3 label-invariant placeholder variants → `corpus.jsonl` (123 cases). Regenerate after editing archetypes; the keyless CI test fails on drift. |
| `corpus.jsonl` | Committed labeled corpus. Categories: fact / take / bet / hunch / mixed, plus the precision classes — empty (nothing extractable), attribution traps (someone else's opinion must never surface as the holder's take), adversarial (prompt injection in content, pasted JSON noise, over-extraction bait). |
| `scorer.ts` | Pure scoring + graduation verdict (`SCORER_VERSION 1`): per-kind precision ≥ 0.80 and recall ≥ 0.70, zero malformed cases (a case whose output can't be parsed is a FAILURE, never a skip — the denominator never shrinks silently), zero forbid violations. |
| `harness.mjs` | Runner. LIVE mode drives the REAL production path per case — `extractTakesFromPages` (consent gate → prompt → `parseClaimsJson` → `addTakesBatch`) against a throwaway PGLite brain — and writes a predictions JSONL. REPLAY mode re-scores a saved predictions file at $0. Keyless environments refuse loudly. |

Keyless CI validation lives at `test/eval-takes-bootstrap.test.ts` (corpus
integrity, scorer arithmetic, graduation boundary, and an oracle pass
proving every label is satisfiable). It guards the instrument, not the
score.

## Running

```bash
# Live (spends ~123 Haiku-class calls; needs a chat-capable key):
bun evals/takes-bootstrap/harness.mjs --out results.jsonl

# Re-score a saved run ($0):
bun evals/takes-bootstrap/harness.mjs --replay results.jsonl

# Bounded smoke:
bun evals/takes-bootstrap/harness.mjs --max 10
```

Exit 0 = GRADUATED; exit 1 = report printed with the failing bars; exit 2 =
infrastructure (keyless / gateway lost mid-run — partial results are never
scored).

## Graduation protocol

1. Run live; commit the predictions JSONL alongside the PR that flips the
   autopilot tier (the replay mode keeps the receipt re-scoreable forever).
2. The tier flip PR must reference the passing report (per-kind table) and
   strike TODO-E.
3. Corpus growth: add archetypes (not raw cases) so variants stay
   label-invariant; the CI floors keep every precision class represented.

Per the North Star eval discipline: this scores FEATURE value — does the
classifier produce correct, correctly-attributed, correctly-weighted takes
rows for gbrain users — not a model bake-off.
