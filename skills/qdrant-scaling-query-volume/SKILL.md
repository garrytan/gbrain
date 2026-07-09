---
name: qdrant-scaling-query-volume
description: "Guides Qdrant query volume scaling. Use when someone asks 'query returns too many results', 'scroll performance', 'large limit values', 'paginating search results', 'fetching many vectors', or 'high cardinality results'."
triggers:
  - "qdrant-scaling-query-volume"
  - "qdrant scaling query volume"
  - "awesome copilot qdrant scaling query volume"
---

# Scaling for Query Volume

Problem: When a query has a large limit (e.g. 1000) and there are multiple shards (e.g. 10), naively each shard must return the full 1000 results — totaling 10,000 scored points transferred and merged. This is wasteful since data is randomly distributed across auto-shards.

## Core idea

Instead of asking every shard for the full limit, ask each shard for a smaller limit computed via Poisson distribution statistics, then merge. This is safe because auto-sharding guarantees random, independent data distribution.

## When it activates

- More than 1 shard
- Auto-sharding is in use (all queried shards share the same shard key)
- The request's limit + offset >= SHARD_QUERY_SUBSAMPLING_LIMIT (128)
- The query is not exact

## Key tradeoff

 The strategy trades a small probability of slightly incomplete results for a large reduction in inter-shard data transfer, especially for high-limit queries across many shards. The 1.2x safety factor and the 99.9% Poisson threshold keep the error rate very low — comparable to inaccuracies already introduced by approximate vector indices like HNSW.


## Contract

This skill guarantees:

- Implements the upstream GitHub awesome-copilot skill intent for `qdrant-scaling-query-volume`: Guides Qdrant query volume scaling. Use when someone asks
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
