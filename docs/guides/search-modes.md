# Search Modes

## Goal

Use the canonical retrieval flow for normal agent answers, and use keyword,
hybrid, and direct page reads as lower-level tools when they are the right fit.

## What the User Gets

Without this: the agent can answer from snippets that cut through meaning or
treat graph orientation as truth. With this: the agent discovers candidates
cheaply, reads bounded canonical evidence, and answers only from supported
context.

## Canonical Retrieval Modes

```
on user_asks_about(topic):
    if exact_selector_or_known_slug(topic):
        # MODE 0: Exact canonical read
        result = mbrain read-context --selectors '[...]'
        # Use mbrain get <slug> only when a full Markdown page is needed.

    elif asks_only_whether_memory_mentions(topic):
        # MODE 1: Mention/existence probe
        result = mbrain retrieve-context "{topic}"
        # search/query metadata may also be used for existence only.
        # Disclose that the answer is probe/candidate metadata.

    else:
        # MODE 2: Normal agent Q&A
        probe = mbrain retrieve-context "{question}"
        read = mbrain read-context --selectors '<probe.required_reads json>'
        # Answer only from read.canonical_reads when answer_ready is true.
```

## Lower-Level Tools

These tools remain available, but they are not the default evidence boundary for
factual answers.

| Mode | Command | Needs Embeddings | Best For | Evidence Status |
|------|---------|------------------|----------|-----------------|
| Probe | `mbrain retrieve-context "..."` | Optional | Candidate grouping, scope/route planning, required reads | Candidate plan |
| Canonical read | `mbrain read-context --selectors '[...]'` | No | Bounded answer evidence | Answer evidence |
| Keyword | `mbrain search "term"` | No | Known names, slugs, dates, exact terms | Candidate chunks |
| Hybrid | `mbrain query "..."` | Yes | Conceptual or cross-cutting discovery | Candidate chunks |
| Full page | `mbrain get <slug>` | No | Complete Markdown page escape hatch | Canonical full page |

## Decision Notes

1. **Search/query return chunks.** Treat chunks as candidate pointers. Run
   `retrieve_context` or `read_context` before making factual claims.
2. **Exact selectors skip fuzzy discovery.** If you already know the slug,
   section id, source ref, task id, profile-memory id, or personal-episode id,
   go straight to `read_context`.
3. **Context maps and backlinks orient.** They can explain relationships,
   recommend reads, or help rank candidates, but they are not canonical truth.
4. **Mention/existence questions are narrower.** For "did anyone mention Y?",
   probe/search metadata can answer existence if you disclose that it is
   candidate metadata and do not infer meaning without a canonical read.
5. **Keyword search works without embeddings.** If hybrid search misses results
   but keyword search finds them, embedding coverage may be incomplete.
6. **Full pages are an escape hatch.** Use `mbrain get <slug>` when the user
   asks for the complete page or when a bounded selector read is insufficient.

## How to Verify

1. Run `mbrain retrieve-context "Pedro"` and confirm it returns candidates plus
   `required_reads`.
2. Run `mbrain read-context --selectors '<required_reads json>'` and confirm it
   returns `canonical_reads` and `answer_ready`.
3. Run `mbrain search "Pedro"` and confirm it returns candidate chunks with slug
   references, not answer-ready evidence.
4. Run `mbrain query "who works at fintech companies"` and confirm it returns
   semantic candidate chunks when embeddings are available.
5. Run `mbrain get pedro-franceschi` when you need the complete canonical page.

---
*Part of the [MBrain Skillpack](../MBRAIN_SKILLPACK.md).*
