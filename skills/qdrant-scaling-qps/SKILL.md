---
name: qdrant-scaling-qps
description: "Guides Qdrant query throughput (QPS) scaling. Use when someone asks 'how to increase QPS', 'need more throughput', 'queries per second too low', 'batch search', 'read replicas', or 'how to handle more concurrent queries'."
triggers:
  - "qdrant-scaling-qps"
  - "qdrant scaling qps"
  - "awesome copilot qdrant scaling qps"
---

# Scaling for Query Throughput (QPS)

Throughput scaling means handling more parallel queries per second. 
This is different from latency - throughput and latency are opposite tuning directions and cannot be optimized simultaneously on the same node.

High throughput favors fewer, larger segments so each query touches less overhead.


## Performance Tuning for Higher RPS

- Use fewer, larger segments (`default_segment_number: 2`) [Maximizing throughput](https://search.qdrant.tech/md/documentation/operations/optimize/?s=maximizing-throughput)
- Enable quantization with `always_ram=true` to reduce disk IO [Quantization](https://search.qdrant.tech/md/documentation/manage-data/quantization/)
- Use batch search API to amortize overhead [Batch search](https://search.qdrant.tech/md/documentation/search/search/?s=batch-search-api)

## Minimize impact of Update Workloads

- Configure update throughput control (v1.17+) to prevent unoptimized searches degrading reads [Low latency search](https://search.qdrant.tech/md/documentation/search/low-latency-search/)
- Set `optimizer_cpu_budget` to limit indexing CPUs (e.g. `2` on an 8-CPU node reserves 6 for queries)
- Configure delayed read fan-out (v1.17+) for tail latency [Delayed fan-outs](https://search.qdrant.tech/md/documentation/search/low-latency-search/?s=use-delayed-fan-outs)



## Horizontal Scaling for Throughput

If a single node is saturated on CPU after applying the tuning above, scale horizontally with read replicas.

- Shard replicas serve queries from replicated shards, distributing read load across nodes
- Each replica adds independent query capacity without re-sharding
- Use `replication_factor: 2+` and route reads to replicas [Distributed deployment](https://search.qdrant.tech/md/documentation/operations/distributed_deployment/?s=replication)

See also [Horizontal Scaling](../scaling-data-volume/horizontal-scaling/SKILL.md) for general horizontal scaling guidance.


## Disk I/O Bottlenecks

If it is not possible to keep all vectors in RAM, disk I/O can become the bottleneck for throughput. 
In this case:

- Upgrade to provisioned IOPS or local NVMe first. See impact of disk performance to vector search in [Disk performance article](https://qdrant.tech/articles/memory-consumption/)
- Use `io_uring` on Linux (kernel 5.11+) [io_uring article](https://qdrant.tech/articles/io_uring/)
- In case of quantized vectors, prefer global rescoring over per-segment rescoring to reduce disk reads. Example in the [tutorial](https://search.qdrant.tech/md/documentation/tutorials-operations/large-scale-search/?s=search-query)
- Configure higher number of search threads to parallelize disk reads. Default is `cpu_count - 1`, which is optimal for RAM-based search but may be too low for disk-based search. See [configuration reference](https://search.qdrant.tech/md/documentation/operations/configuration/?s=configuration-options)
- If still saturated, scale out horizontally (each node adds independent IOPS)


## What NOT to Do

- Do not expect to optimize throughput and latency simultaneously on the same node
- Do not use many small segments for throughput workloads (increases per-query overhead)
- Do not scale horizontally when IOPS-bound without also upgrading disk tier
- Do not run at >90% RAM (OS cache eviction = severe performance degradation)


## Contract

This skill guarantees:

- Implements the upstream GitHub awesome-copilot skill intent for `qdrant-scaling-qps`: Guides Qdrant query throughput (QPS) scaling. Use when someone asks
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
