# takes-bootstrap classifier eval (TODO-E graduation instrument)

The 100+-case eval that gates the takes-bootstrap autopilot tier
(`TODOS.md` TODO-E: the tier stays `manual_only` until a live run of this
suite GRADUATES).

## What's here

| File | Role |
|---|---|
| `generate-corpus.mjs` | Deterministic builder: 41 hand-authored archetypes × 3 label-invariant placeholder variants → `corpus.jsonl` (123 cases). Every page passes the production eligibility filter (`briefing` or `writing` type, body over 200 chars: `# <title>`, the archetype text, then a shared follow-up task list the labels treat as non-claims) and carries a neutral slug, so the prompt never names the label. Regenerate after editing archetypes; the keyless CI test fails on drift. |
| `corpus.jsonl` | Committed labeled corpus. Categories: fact / take / bet / hunch / mixed, plus the precision classes — empty (nothing extractable), attribution traps (someone else's opinion must never surface as the holder's take), adversarial (prompt injection in content, pasted JSON noise, over-extraction bait). |
| `scorer.ts` | Pure scoring + graduation verdict (`SCORER_VERSION 1`): per-kind precision ≥ 0.80 and recall ≥ 0.70, zero malformed cases (a case whose output can't be parsed is a FAILURE, never a skip — the denominator never shrinks silently), zero forbid violations. The report also breaks results down per variant (123 rows) and per archetype (41 rows); a variant passes when every expected claim matched, every prediction was precise and no forbid pattern fired. |
| `run-case.ts` | One case through the REAL production path: seeds the page into the brain and its markdown file into the brain repo, runs `extractTakesFromPages` (consent gate → eligibility selector → prompt → `parseClaimsJson` → md-first fence write → DB mirror) and reads the takes back from the page's fence. A case the extractor did not classify is a harness error, never a score. |
| `harness.mjs` | Runner. LIVE mode configures the gateway with the shared eval bootstrap, runs every case through `run-case.ts` against a throwaway PGLite brain and temp brain repo, and writes a predictions JSONL. It prints a spend estimate first, refuses when the estimate exceeds `--max-usd` (default $1), and enforces the same cap as a hard ceiling. REPLAY mode re-scores a saved predictions file at $0. Keyless environments refuse loudly. |

Keyless CI validation lives at `test/eval-takes-bootstrap.test.ts` (corpus
integrity and production eligibility, scorer arithmetic, graduation
boundary, `--max` replay slicing, and an oracle pass proving every label is
satisfiable) and `test/eval-takes-bootstrap-harness.test.ts` (a corpus case
run through `run-case.ts` with a stubbed classifier: the classifier is
called and the take lands in the fence and the takes table). They guard the
instrument, not the score.

## Running

```bash
# Live (123 calls on anthropic:claude-haiku-4-5, about $0.10-0.25; needs a chat-capable key):
bun evals/takes-bootstrap/harness.mjs --out results.jsonl [--model <provider:model>] [--max-usd 1]

# Re-score a saved run ($0):
bun evals/takes-bootstrap/harness.mjs --replay results.jsonl

# Bounded smoke (runs and scores corpus.slice(0, 10)):
bun evals/takes-bootstrap/harness.mjs --max 10
```

Exit 0 = GRADUATED; exit 1 = report printed with the failing bars; exit 2 =
infrastructure (keyless, unpriced model, estimate over the cap, spend cap
reached, or a case the extractor did not classify — partial results are
never scored).

## Graduation protocol

1. Run live; commit the predictions JSONL alongside the PR that flips the
   autopilot tier (the replay mode keeps the receipt re-scoreable forever).
2. The tier flip PR must reference the passing report (per-kind table) and
   strike TODO-E.
3. Corpus growth: add archetypes (not raw cases) so variants stay
   label-invariant; the CI floors keep every precision class represented.

Per the North Star eval discipline: this scores FEATURE value — does the
classifier produce correct, correctly-attributed, correctly-weighted takes
rows for foresights users — not a model bake-off.
