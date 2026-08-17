# gbrain eval suspected-contradictions

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

Each finding ships with a `resolution_command` field — addressable and
honest about what needs operator judgment:

- `gbrain takes supersede <slug> --row N --claim '<replacement>'` — newer
  take should replace the older one (intra_page kind). `--row` is the
  per-page row number and `--claim` is required; when the winning side has
  an unambiguous claim (temporal supersession where the newer side is
  itself a take) the command is fully paste-ready, otherwise it carries an
  explicit `<replacement claim>` placeholder for you to fill from the
  report — the classifier picks an action, not a winner, and will not
  fabricate a take from arbitrary chunk prose.
- `gbrain dream --phase synthesize --slug <slug>` — compiled_truth for
  the curated entity needs an update (cross_slug curated-vs-bulk).
- `# manual review: ...` — intentional-disagreement (debate) findings and
  judge-unsure findings render as a manual-review comment; a
  mark-as-debate subcommand does not exist yet, so nothing is minted that
  would fail when pasted.

Run `gbrain eval suspected-contradictions review --severity high` to
inspect findings without re-running the probe.

## Cost model

Default judge is `claude-haiku-4-5` at ~$1/Mtok in, $5/Mtok out. With
the v0.32.6 truncation at 1500 chars per pair, ~500 input + 80 output
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

## Temporal axis

The judge distinguishes real contradictions from legitimate change-over-time.
The verdict enum has six members (`no_contradiction | contradiction |
temporal_supersession | temporal_regression | temporal_evolution |
negation_artifact`), and `pages.effective_date` is threaded into the judge
prompt so the probe doesn't cry wolf on facts that simply changed.

The trajectory substrate builds on the same signal:
`gbrain eval trajectory <entity>` shows the chronological typed-claim
history with regressions flagged inline; `gbrain founder scorecard
<entity>` rolls up four signals (accuracy, consistency, growth
direction, red flags) into a stable JSON contract. MCP op
`find_trajectory` (read scope, visibility-filtered for remote callers)
exposes the same data to agents. The probe's `temporal_supersession`
verdict and the consolidate phase's `valid_until` writeback both
preserve the `auto-supersession.ts` "NEVER auto-applies" invariant
— the probe only emits paste-ready commands; only `consolidate`
writes `valid_until` (a grep guard pins this).

## See also

- Cost discipline: `docs/eval-bench.md` for the recommended nightly cadence
  + trend-tracking workflow.
