# EmbeddingGemma follow-up evaluation

This is a bounded experiment for the pending upstream decision. It uses the
frozen CC0 corpus in `dataset.json` and real 768-dimensional vectors from a
local Ollama `embeddinggemma:latest` model. It does not establish production
acceptance or authorize re-embedding a brain.

The completed real-model run is documented in [the results report](results/README.md).
That page links the compact [report](results/report.json) and the lossless,
sanitized [full evidence bundle](results/evidence.json.gz).

After the coordinator reviews the harness, run it from the repository root
with a local Ollama base URL and a directory that does not already exist:

```bash
bun evals/embeddinggemma-follow-up/run.ts \
  --endpoint <LOCAL_OLLAMA_BASE_URL> \
  --out <NEW_EVIDENCE_DIRECTORY>
```

The command refuses a non-loopback endpoint, credentials, and an existing
output directory. It copies the frozen dataset and writes `evidence.json` only
after the full run succeeds. The evidence stores selected-model metadata,
hashes, exact sanitized embedding inputs, vectors, rankings, relevance metrics,
latencies, and warm-state details. It omits endpoint addresses, request
headers, credentials, other Ollama tags, and local output paths. A failed run
can leave the copied dataset in its new directory; choose another new directory
for a retry.

Arms run in fixed order. One separately timed primer runs before all arms. A
and B share A's immutable raw-document vectors; B's
indexing result explicitly records that reuse and its source timing. C indexes
the same chunks with the real dataset titles. Query calls clear GBrain's query
cache and run serially three times per query. A model already loaded at startup
is recorded; all arms run warm after the primer, so the report makes no
cold-latency claim. The selected model must remain GPU-resident after the
primer. The harness never unloads a model or changes Ollama configuration.

This harness covers only the isolated A/B/C retrieval comparison and its
sanitized evidence. It does not test real GBrain imports, persisted provenance,
title-edit invalidation, or legacy-vector refresh. The current proposal's
operator procedure is in the [Ollama provider guide](../../docs/integrations/embedding-providers.md#ollama-local)
and [embedding refresh guide](../../docs/guides/embedding-migration.md#embeddinggemma-document-format-refresh-proposal);
the [results note](results/README.md) marks these numbers as historical. Upstream
maintainer direction, merge/release and production acceptance remain pending.
No production acceptance threshold is implied; the small frozen corpus is not
the fresh production acceptance set owned by #99.

Offline checks, with no model calls:

```bash
bun test evals/embeddinggemma-follow-up/metrics.test.ts evals/embeddinggemma-follow-up/dataset.test.ts evals/embeddinggemma-follow-up/run.test.ts
bun run typecheck
```

`run.test.ts` uses only a disposable fake Ollama process with synthetic vectors
to assert the request formatting, sequencing, and output sanitization. Its
vectors are test fixtures and never count as retrieval-quality evidence.
