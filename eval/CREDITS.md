# BrainBench credits

## Core team

- **garrytan** — BrainBench v1 + v1.1 architecture, adapter interface,
  extraction regex residuals (v0.10.5), multi-axis type-accuracy runner
- **Claude Opus 4.7** — pair programming, test coverage, documentation

## External query authors (Tier 5.5)

No human external authors yet. The Tier 5.5 query set currently comprises
50 synthetic queries labeled `author: "synthetic-outsider-v1"` as a
placeholder. Real submissions via `eval/external-authors/<handle>/queries.json`
PRs supersede synthetic entries.

**Want to be credited here?** See `eval/CONTRIBUTING.md`.

## External adapters

No third-party adapters yet. The shipping adapter set:

- `gbrain-after` — gbrain v0.10.3+ (internal; the system under test)
- `hybrid-nograph` — gbrain hybrid search with graph layer disabled
  (internal comparator; closest apples-to-apples to `gbrain-after`)
- `ripgrep-bm25` — classic IR baseline built in an afternoon
- `vector-only` — commodity vector RAG, same embedder as gbrain

Third-party submissions (mem0, supermemory, Letta, Cognee, etc.) via
`eval/runner/adapters/<adapter>.ts` PRs. See `eval/CONTRIBUTING.md` for
the adapter interface and submission flow.

## Data

- Corpus generator: Claude Opus
- Canonical world: `eval/data/world-v1/` (committed, 240 entities)
- Generation cost: ~$3.14 USD (one-time)

## Inspiration

- **SWE-bench** — taught us that a benchmark's credibility comes from real
  baselines, not from the authoring team saying nice things about their
  own stack
- **Codex** — cold-read critique that "this isn't a standard, it's an
  internal test" drove the Phase 2 external-baselines work that became
  the headline of this PR
- **MTEB** — embedding-model reproducibility card pattern; we copy the
  "pin every version in every scorecard" discipline
