# Retrieval Architecture

Cortex combines vector search, keyword search, source scoping, graph traversal,
and reranking so company-brain answers are both relevant and permission-aware.

## Retrieval Stack

1. **Vector search** catches semantic matches.
2. **Keyword search** catches names, exact phrases, code identifiers, and literal
   customer language.
3. **Reciprocal Rank Fusion** merges vector and keyword candidates without a
   global hand-tuned weight.
4. **Source authorization** removes rows the current OAuth client cannot read.
5. **Graph traversal** follows typed edges for relationship questions.
6. **Reranking** reorders candidates when the active provider supports it.
7. **Deduplication and token budgeting** keep answers concise and cited.

## Why This Matters

Company-brain queries are often relational:

- "Who worked with this customer last quarter?"
- "Which team owns this incident?"
- "What changed since the last renewal call?"
- "Which source says this policy is approved?"

Vector-only retrieval misses relationships that are not directly embedded in a
chunk. Keyword-only retrieval misses paraphrases. Graph-only retrieval is sparse
until links accumulate. Cortex uses all three and keeps the authorization check
inside the retrieval pipeline.

## Source-Aware Ranking

Every indexed row carries a `source_id`. OAuth clients have one write source and
a federated-read set. Retrieval must apply that source closure before returning
results to CLI, UI, or MCP callers.

This is the SaaS safety boundary: relevance cannot outrank authorization.

## Query Pipeline

```text
intent classify
  -> optional expansion
  -> vector search
  -> keyword search
  -> RRF merge
  -> source authorization
  -> graph augmentation
  -> optional rerank
  -> token budget and dedup
  -> cited results
```

## Verification

Use focused retrieval tests for ranking behavior and the live SaaS smoke for
hosted MCP reachability:

```bash
bun test test/search*.test.ts
bun run smoke:saas-live -- --json
```

When retrieval changes affect source scoping, add a regression that proves an
OAuth client cannot see rows outside its federated-read set.
