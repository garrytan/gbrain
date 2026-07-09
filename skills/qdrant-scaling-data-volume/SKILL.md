---
name: qdrant-scaling-data-volume
description: "Guides Qdrant data volume scaling decisions. Use when someone asks 'data doesn't fit on one node', 'too much data', 'need more storage', 'vertical or horizontal scaling', 'tenant scaling', 'time window rotation', or 'data growth exceeds capacity'."
allowed-tools:
  - Read
  - Grep
  - Glob
triggers:
  - "qdrant-scaling-data-volume"
  - "qdrant scaling data volume"
  - "awesome copilot qdrant scaling data volume"
---

# Scaling Data Volume

This document covers data volume scaling scenarios,
where the total size of the dataset exceeds the capacity of a single node.

## Tenant Scaling

If the use case is multi-tenant, meaning that each user only has access to a subset of the data,
and we never need to query across all the data, then we can use multi-tenancy patterns to scale.

The recommended way is to use multi-tenant workloads with payload partitioning, per-tenant indexes, and tiered multitenancy.

Learn more [Tenant Scaling](tenant-scaling/SKILL.md)

## Sliding Time Window

Some use-cases are based on a sliding time window, where only the most recent data is relevant.
For example an index for social media posts, where only the last 6 months of data require fast search.

Learn more [Sliding Time Window](sliding-time-window/SKILL.md)

## Global Search

Most general use-cases require global search across all data.
In these situations, we might need to fall back to vertical scaling,
and then horizontal scaling when we reach the limits of vertical scaling.


### Vertical Scaling

When data doesn't fit in a single node, the first approach is to scale the node itself — more RAM, better disk, quantization, mmap.
Exhaust vertical options before going horizontal, as horizontal scaling adds permanent operational complexity.

Learn more [Vertical Scaling](vertical-scaling/SKILL.md)

### Horizontal Scaling

When a single node can't hold the data even with quantization and mmap, distribute data across multiple nodes via sharding.

Learn more [Horizontal Scaling](horizontal-scaling/SKILL.md)


## Contract

This skill guarantees:

- Implements the upstream GitHub awesome-copilot skill intent for `qdrant-scaling-data-volume`: Guides Qdrant data volume scaling decisions. Use when someone asks
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
