---
keywords: gbrain, memory, search, knowledge, brain, wiki, page, slug
---

# GBrain Skills

## Slugs
- Personal notes: `mem/<topic>`
- Wiki / reference: `wiki/<topic>`
- Always search before writing to avoid duplicates.

## Write rules
- **Always use `async=1`** — sync write always times out from the client side.
- `write_memory` handles `async=1` automatically. Do not pass it manually.
- Same content hash → instant `skipped` response. Safe to retry writes.
- After a successful write, the page is **readable in <250 ms**.
- The page will appear in **keyword search after 60–90 seconds** (lex index lag).
- Do not interpret a 404 immediately after writing as failure — wait for index.

## Search modes
- `hybrid` (default): lex + semantic — best for established content
- `keyword`: exact word match — use for proper nouns, IDs, or **freshly written pages**
- `semantic`: concept match — use for fuzzy/conceptual queries

## Search fallback pattern
```
1. Try hybrid search
2. If empty AND content was recently written → retry with keyword mode
3. If still empty → content may not exist or index not yet updated
```

## Idempotent write pattern
```
1. search_memory(q=topic)
2. If found → write_memory(slug=existing_slug, ...)  ← upsert
3. If not found → write_memory(slug=mem/<new-slug>, ...)  ← create
```

## Vec search caveat
Semantic (vec) search occasionally times out due to OpenAI routing latency.
If `hybrid` returns empty on a query you expect to match, switch to `keyword`.
