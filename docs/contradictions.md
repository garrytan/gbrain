# gbrain eval suspected-contradictions (v0.33.0)

The contradiction probe samples retrieval results, asks an LLM judge whether
any pair contradicts on a factual claim relevant to the user's query, and
aggregates into a calibrated report. The output is data — the operator
decides what to act on. This doc covers the architecture, severity rubric,
how to interpret the headline number, and when to act.

## Why this exists

gbrain handles contradictions for *curated* pages via compiled-truth-plus-
timeline and source-boost: when `companies/acme.md` says MRR is $2M and a
chat transcript from 2024 says MRR was $50K, the curated page outranks the
chat. `takes.active` filtering hides explicitly-superseded takes. Recency
decay biases ranking toward fresher content per source-tier.

What none of those mechanisms measure: how often do unmarked semantic
contradictions actually surface in retrieval? Without a probe, every
"should we build the bigger swing (chunk-level `revises` field + ranking
change)" decision is vibes. The probe produces evidence.

## Architecture

```
        ┌──────────────────────────────────────┐
        │ gbrain eval suspected-contradictions │
        └──────────────────┬───────────────────┘
                           │
        ┌──────────────────▼───────────────────┐
        │ For each query: hybridSearch top-K   │
        │ → cross_slug_chunks + intra_page     │
        │   chunk-vs-take pairs                │
        └──────────────────┬───────────────────┘
                           │
        ┌──────────────────▼───────────────────┐
        │ Date pre-filter: skip pairs whose    │
        │ dates are >30d apart (Codex fix:     │
        │ same-paragraph-dual-date overrides)  │
        └──────────────────┬───────────────────┘
                           │
        ┌──────────────────▼───────────────────┐
        │ Persistent cache lookup              │
        │ (chunk_a_hash, chunk_b_hash, model,  │
        │  prompt_version, truncation_policy)  │
        └────────┬─────────┬────────────────────┘
              hit│         │miss
                 │         ▼
                 │   ┌─────────────────────────┐
                 │   │ LLM judge call          │
                 │   │ → JudgeVerdict          │
                 │   │ confidence floor ≥ 0.7  │
                 │   └─────────┬───────────────┘
                 │             │
                 ▼             ▼
        ┌──────────────────────────────────────┐
        │ Aggregate per-query + global stats   │
        │ Wilson 95% CI on headline %          │
        │ source-tier breakdown                │
        │ hot pages + resolution proposals     │
        └──────────────────┬───────────────────┘
                           │
                           ▼
                  ProbeReport JSON
                           │
        ┌──────────────────┼──────────────────────┬───────────────┐
        ▼                  ▼                      ▼               ▼
   doctor (M1)         MCP (M3)             synthesize (M2)   trend (M5)
   surfaces           find_contradictions    informational     persistent
   findings           op for agents          block in prompt   tracking
```

## Severity rubric

The judge assigns severity per finding:

| Level | Rubric | Example |
|---|---|---|
| `low` | naming/format differences | "Alice Smith" vs "A. Smith" |
| `medium` | factual values that may be stale | revenue figure, headcount, valuation |
| `high` | identity / structural claims | founder/CEO/CFO role, company status |

Doctor sorts findings by severity DESC. The MCP op accepts a severity filter
so agents can fetch just the high-priority items.

## How to interpret the headline number

The probe outputs `queries_with_contradiction / queries_evaluated` with a
Wilson 95% confidence interval:

```
Queries with >=1 contradiction: 12 / 50 (24%)  Wilson CI 95%: 14–37%
```

What this says: with 95% confidence, the true rate is between 14% and 37%.
The 24% point estimate is the most-likely-value but bounded by sampling
noise. **`small_sample_note` fires when n < 30** — at that scale the CI is
too wide to act on.

Decision criteria for the bigger swing (chunk-level `revises` field):

| Wilson CI lower bound | What it says | Action |
|---|---|---|
| < 5% | Source-boost + recency-decay + curated pages handle the load | Stop here; this is the right scope |
| 5–15% | Real but bounded | Operator decides whether the cost justifies the swing |
| > 15% | Real and substantial | Plan the bigger swing in v0.34+ |

## When to act on findings

Each finding ships with a `resolution_command` field — paste-ready:

- `gbrain takes supersede <slug> --row N` — newer take should replace
  the older chunk text on the same page (intra_page kind).
- `gbrain dream --phase synthesize --slug <slug>` — compiled_truth for
  the curated entity needs an update (cross_slug curated-vs-bulk).
- `gbrain takes mark-debate <slug> --row N` — intentional disagreement
  (e.g., two opinions you want to keep both of).
- `# manual review: <a> vs <b>` — judge wasn't sure; operator decides.

Run `gbrain eval suspected-contradictions review --severity high` to
inspect findings without re-running the probe.

## Cost model

Default judge is `claude-haiku-4-5` at ~$1/Mtok in, $5/Mtok out. With
the v0.33.0 truncation at 1500 chars per pair, ~500 input + 80 output
tokens per judge call. Budget cap defaults to $5 in TTY / $1 non-TTY.

- ~$0.0006 per judge call
- ~$0.005 per query (after date pre-filter + cache hits)
- ~$0.50 per 100 queries

The persistent cache means nightly runs against the same query set
pay near-zero on re-runs (until you bump PROMPT_VERSION).

## Trust posture

- Probe never mutates the brain. Runs only read pages/takes/chunks.
  Writes go only to `eval_contradictions_runs` and `eval_contradictions_cache`.
- MCP `find_contradictions` is read-scope. NOT in the subagent allowlist —
  user-initiated only, not autonomous-action surface.
- Build-fixture script is local-only. The redactor + `isCleanForCommit`
  gate makes accidental private-data commits hard, but the operator MUST
  inspect every redaction before commit.

## See also

- Plan: `~/.claude/plans/system-instruction-you-are-working-hashed-dewdrop.md`
- CHANGELOG: `## [0.33.0]` entry covers the whole release.
- Cost discipline: `docs/eval-bench.md` for the recommended nightly cadence
  + trend-tracking workflow.
