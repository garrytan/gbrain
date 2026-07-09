---
name: qdrant-search-speed-optimization
description: "Diagnoses and fixes slow Qdrant search. Use when someone reports 'search is slow', 'high latency', 'queries take too long', 'low QPS', 'throughput too low', 'filtered search is slow', or 'search was fast but now it's slow'. Also use when search performance degrades after config changes or data growth."
triggers:
  - "qdrant-search-speed-optimization"
  - "qdrant search speed optimization"
  - "awesome copilot qdrant search speed optimization"
---

# Diagnose a problem

There the multiple possible reasons for search performance degradation. The most common ones are:

* Memory pressure: if the working set exceeds available RAM
* Complex requests (e.g. high `hnsw_ef`, complex filters without payload index)
* Competing background processes (e.g. optimizer still running after bulk upload)
* Problem with the cluster (e.g. network issues, hardware degradation)


## Single Query Too Slow (Latency)

Use when: individual queries take too long regardless of load.

### Diagnostic steps:

- Check if second run of the same request is significantly faster (indicates memory pressure)
- Try the same query with `with_payload: false` and `with_vectors: false` to see if payload retrieval is the bottleneck
- If request uses filters, try to remove them one by one to identify if a specific filter condition is the bottleneck

### Common fixes:

- Tune HNSW parameters: [Fine-tuning search](https://search.qdrant.tech/md/documentation/operations/optimize/?s=fine-tuning-search-parameters)
- Enable in-memory quantization: [Scalar quantization](https://search.qdrant.tech/md/documentation/manage-data/quantization/?s=scalar-quantization)
- Reduce Vector Dimensionality with Matryoshka Models: [Matryoshka Models](https://search.qdrant.tech/md/documentation/inference/?s=reduce-vector-dimensionality-with-matryoshka-models)
- Use oversampling + rescore for high-dimensional vectors [Search with quantization](https://search.qdrant.tech/md/documentation/manage-data/quantization/?s=searching-with-quantization)
- Enable io_uring for disk-heavy workloads on Linux [io_uring](https://qdrant.tech/articles/io_uring/)


## Can't Handle Enough QPS (Throughput)

Use when: system can't serve enough queries per second under load.

- Reduce segment count (`default_segment_number` to 2) [Maximizing throughput](https://search.qdrant.tech/md/documentation/operations/optimize/?s=maximizing-throughput)
- Use batch search API instead of single queries [Batch search](https://search.qdrant.tech/md/documentation/search/search/?s=batch-search-api)
- Enable quantization to reduce CPU cost [Scalar quantization](https://search.qdrant.tech/md/documentation/manage-data/quantization/?s=scalar-quantization)
- Add replicas to distribute read load [Replication](https://search.qdrant.tech/md/documentation/operations/distributed_deployment/?s=replication)


## Filtered Search Is Slow

Use when: filtered search is significantly slower than unfiltered. Most common SA complaint after memory.

- Create payload index on the filtered field [Payload index](https://search.qdrant.tech/md/documentation/manage-data/indexing/?s=payload-index)
- Use `is_tenant=true` for primary filtering condition: [Tenant index](https://search.qdrant.tech/md/documentation/manage-data/indexing/?s=tenant-index)
- Try ACORN algorithm for complex filters: [ACORN](https://search.qdrant.tech/md/documentation/search/search/?s=acorn-search-algorithm)
- Avoid using `nested` filtering conditions as a primary filter. It might force qdrant to read raw payload values instead of using index.
- If payload index was added after HNSW build, trigger re-index to create filterable subgraph links


## Optimize search performance with parallel updates

### Diagnostic steps

- Try to run the same query with `indexed_only=true` parameter, if the query is significantly faster, it means that the optimizer is still running and has not yet indexed all segments.
- If CPU or IO usage is high even with no queries, it also indicates that the optimizer is still running.

### Recommended configuration changes

- reduce `optimizer_cpu_budget` to reserve more CPU for queries
- Use `prevent_unoptimized=true` to prevent creating segments with a large amount of unindexed data for searches. Instead, once a segment reaches the so called indexing_threshold, all additional points will be added in ‘deferred state’. 

Learn more [here](https://search.qdrant.tech/md/documentation/search/low-latency-search/?s=query-indexed-data-only)


## What NOT to Do

- Set `always_ram=false` on quantization (disk thrashing on every search)
- Put HNSW on disk for latency-sensitive production (only for cold storage)
- Increase segment count for throughput (opposite: fewer = better)
- Create payload indexes on every field (wastes memory)
- Blame Qdrant before checking optimizer status


## Contract

This skill guarantees:

- Implements the upstream GitHub awesome-copilot skill intent for `qdrant-search-speed-optimization`: Diagnoses and fixes slow Qdrant search. Use when someone reports
- Uses only task-relevant references/scripts/assets from this skill directory.
- Produces source-grounded, concrete output: commands, code changes, configuration, review notes, diagrams, or checklists as the source skill requires.
- Does not invent APIs, tool behavior, repository facts, cloud settings, credentials, or user/project context not present in the repo or supplied by the user.

## Output Format

Lead with the actionable result. For implementation or automation tasks, list changed files/commands and verification output. For advisory/review tasks, return concise findings or steps with relevant paths. Do not dump whole reference files; cite the file path and include only the decisive excerpt.

## Anti-Patterns

- Applying this skill outside its documented domain when a narrower skill exists.
- Fabricating project structure, APIs, credentials, external account state, or cloud resources.
- Copying large references/assets into chat instead of using targeted excerpts.
- Skipping verification after code, config, or workflow changes.
