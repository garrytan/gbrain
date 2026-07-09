---
name: qdrant-monitoring-debugging
description: "Diagnoses Qdrant production issues using metrics and observability tools. Use when someone reports 'optimizer stuck', 'indexing too slow', 'memory too high', 'OOM crash', 'queries are slow', 'latency spike', or 'search was fast now it's slow'. Also use when performance degrades without obvious config changes."
triggers:
  - "qdrant-monitoring-debugging"
  - "qdrant monitoring debugging"
  - "awesome copilot qdrant monitoring debugging"
---

# How to Debug Qdrant with Metrics

First check optimizer status. Most production issues trace back to active optimizations competing for resources. If optimizer is clean, check memory, then request metrics.


## Optimizer Stuck or Too Slow

Use when: optimizer running for hours, not finishing, or showing errors.

- Use `/collections/{collection_name}/optimizations` endpoint (v1.17+) to check status [Optimization monitoring](https://search.qdrant.tech/md/documentation/operations/optimizer/?s=optimization-monitoring)
- Query with optional detail flags: `?with=queued,completed,idle_segments`
- Returns: queued optimizations count, active optimizer type, involved segments, progress tracking
- Web UI has an Optimizations tab with timeline view and per-task duration metrics [Web UI](https://search.qdrant.tech/md/documentation/operations/optimizer/?s=web-ui)
- If `optimizer_status` shows an error in collection info, check logs for disk full or corrupted segments
- Large merges and HNSW rebuilds legitimately take hours on big datasets. Check progress before assuming it's stuck.


## Memory Seems Too High

Use when: memory exceeds expectations, node crashes with OOM, or memory keeps growing.

- Process memory metrics available via `/metrics` (RSS, allocated bytes, page faults)
- Qdrant uses two types of RAM: resident memory (data structures, quantized vectors) and OS page cache (cached disk reads). Page cache filling available RAM is normal. [Memory article](https://qdrant.tech/articles/memory-consumption/)
- If resident memory (RSSAnon) exceeds 80% of total RAM, investigate
- Check `/telemetry` for per-collection breakdown of point counts and vector configurations
- Estimate expected memory: `num_vectors * dimensions * 4 bytes * 1.5` for vectors, plus payload and index overhead [Capacity planning](https://search.qdrant.tech/md/documentation/operations/capacity-planning/)
- Common causes of unexpected growth: quantized vectors with `always_ram=true`, too many payload indexes, large `max_segment_size` during optimization


## Queries Are Slow

Use when: queries slower than expected and you need to identify the cause.

- Track `rest_responses_avg_duration_seconds` and `rest_responses_max_duration_seconds` per endpoint
- Use histogram metric `rest_responses_duration_seconds` (v1.8+) for percentile analysis in Grafana
- Equivalent gRPC metrics with `grpc_responses_` prefix
- Check optimizer status first. Active optimizations compete for CPU and I/O, degrading search latency.
- Check segment count via collection info. Too many unmerged segments after bulk upload causes slower search.
- Compare filtered vs unfiltered query times. Large gap means missing payload index. [Payload index](https://search.qdrant.tech/md/documentation/manage-data/indexing/?s=payload-index)


## What NOT to Do

- Ignore optimizer status when debugging slow queries (most common root cause)
- Assume memory leak when page cache fills RAM (normal OS behavior)
- Make config changes while optimizer is running (causes cascading re-optimizations)
- Blame Qdrant before checking if bulk upload just finished (unmerged segments)


## Contract

This skill guarantees:

- Implements the upstream GitHub awesome-copilot skill intent for `qdrant-monitoring-debugging`: Diagnoses Qdrant production issues using metrics and observability tools. Use when someone reports
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
