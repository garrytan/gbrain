# Search Contract v1

GBrain Search Contract v1 is an opt-in compatibility pin for the embedding
space and retrieval profile that produce persisted vectors and cached results.
It does not select a new model and it does not move inference into PostgreSQL.

## Ownership boundary

- GBrain's AI gateway creates document and query embeddings.
- PostgreSQL + pgvector store vectors and execute cosine-distance retrieval.
- GBrain fuses lexical, vector, graph, recency, and relational candidates.
- GBrain's search layer calls the reranker and fails open to hybrid/RRF order.

## Contract fields

A v1 snapshot records:

- embedding provider/model;
- dimensions;
- active pgvector column and `vector`/`halfvec` representation;
- cosine metric;
- symmetric, query/document, or query/passage input semantics;
- search mode and contextual-retrieval policy;
- reranker enablement, model, candidate count, timeout, and fail-open policy;
- autocut enablement and threshold.

The canonical JSON is stored in the DB config plane at
`search.contract.v1`. Its SHA-256 prefix is folded into query-cache identity.

## Commands

```bash
# Inspect current behavior and the pin
gbrain search contract check

# Pin current resolved behavior (idempotent)
gbrain search contract pin

# Replace a prior pin only after a deliberate migration
gbrain search contract pin --force
```

Ordinary CLI, daemon, MCP, sync, search, and embed startup fails closed when a
pin exists and the resolved runtime contract differs. Doctor, config recovery,
contract inspection, and `gbrain migrate embeddings` remain reachable.

`gbrain doctor` also checks page embedding signatures. Missing or stale
provenance warns with the supported repair command:

```bash
gbrain embed --stale --include-null-signature
```

A pending/null embedding remains valid during that controlled repair. Contract
pinning never requires clearing the model metadata column to null.

## Deliberate model migration

Never edit `embedding_model` over an existing vector space. Use:

```bash
gbrain migrate embeddings --to <provider:model> --dry-run
gbrain migrate embeddings --to <provider:model> --yes
```

The migration command probes the target, transitions schema when dimensions
change, invalidates stale vectors including legacy null-signature pages, purges
the query cache, and resumes the re-embed safely. After validation, replace the
pin explicitly with `gbrain search contract pin --force`.

Changing only the reranker does not require re-embedding, but it still changes
the contract and cache fingerprint. Benchmark retrieval quality before
re-pinning.
