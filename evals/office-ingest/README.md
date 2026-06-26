# Office-ingest retrieval sanity-eval

A **runnable scaffold**, not a verdict. It imports a corpus of office documents
(PDF/DOCX/PPTX/XLSX/ODT/ODS/ODP/HTML/CSV) into a throwaway brain and scores
keyword retrieval against a labeled query set — `hit@k` and `MRR`.

## What this is — and isn't

- **Is:** a reproducible way to ask *"does office content import and come back
  when I search for it?"* over **your** corpus, with **your** labeled queries.
- **Is NOT:** BrainBench, and not a "gbrain is better than X" claim. Per gbrain's
  eval discipline (`docs/eval/`), "best" is a **whole-system** claim proven across
  the full BrainBench suite — never by one feature's harness. This measures
  capability + retrievability, not superiority.
- **Honest gap:** it ships with **no real corpus**. The numbers it prints are
  only as meaningful as the labeled corpus you feed it. Until then it's plumbing.

## Run

```bash
bun evals/office-ingest/harness.ts --corpus <dir-of-office-docs> --queries <file.jsonl> [--k 5]
```

- `--corpus` — a directory of office files (walked recursively; only office
  extensions are imported). Auto-starts the Docling sidecar.
- `--queries` — JSONL, one object per line:

```jsonl
{"query": "how much revenue in Q4", "expect_substring": "two hundred fifty million"}
{"query": "regional headcount table", "expect_slug": "hr/headcount.xlsx"}
```

Each query is scored a hit if `expect_slug` (exact page slug) or
`expect_substring` (case-insensitive, in the chunk text) appears in the top-`k`.

> Scoring runs over keyword FTS, which is **AND-matched** — a multi-word query
> only matches chunks containing *all* its terms. Use high-signal terms, or swap
> in semantic `hybridSearch` (see Scope notes).

Output is JSON: `hit_at_k`, `mrr`, and a per-query breakdown.

## Scope notes / honest extensions

- **Scoring is keyword (FTS).** Robust + needs no embedder. Swapping in semantic
  (`hybridSearch`) or cross-modal (`search_by_image`) scoring is a documented
  next step — semantic needs the text embedder configured, cross-modal needs a
  multimodal embedder (Voyage) + image queries.
- **A real eval needs labels.** Relevance judgments (which doc/passage answers
  each query) are the expensive part; this harness consumes them but does not
  invent them.
- To make this a *credible* office-retrieval eval, bring: a representative corpus
  (real messy docs — scans, merged tables, big decks) + a query set with
  human-checked expected answers. Then the printed metrics mean something.
