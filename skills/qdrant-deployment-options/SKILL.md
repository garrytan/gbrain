---
name: qdrant-deployment-options
description: "Guides Qdrant deployment selection. Use when someone asks 'how to deploy Qdrant', 'Docker vs Cloud', 'local mode', 'embedded Qdrant', 'Qdrant EDGE', 'which deployment option', 'self-hosted vs cloud', or 'need lowest latency deployment'. Also use when choosing between deployment types for a new project."
triggers:
  - "qdrant-deployment-options"
  - "qdrant deployment options"
  - "awesome copilot qdrant deployment options"
---

# Which Qdrant Deployment Do I Need?

Start with what you need: managed ops or full control? Network latency acceptable or not? Production or prototyping? The answer narrows to one of four options.


## Getting Started or Prototyping

Use when: building a prototype, running tests, CI/CD pipelines, or learning Qdrant.

- Use local mode (Python only): zero-dependency, in-memory or disk-persisted, no server needed [Local mode](https://search.qdrant.tech/md/documentation/quickstart/)
- Local mode data format is NOT compatible with server. Do not use for production or benchmarking.
- For a real server locally, use Docker [Quick start](https://search.qdrant.tech/md/documentation/quickstart/?s=download-and-run)


## Going to Production (Self-Hosted)

Use when: you need full control over infrastructure, data residency, or custom configuration.

- Docker is the default deployment. Full Qdrant Open Source feature set, minimal setup. [Quick start](https://search.qdrant.tech/md/documentation/quickstart/?s=download-and-run)
- You own operations: upgrades, backups, scaling, monitoring
- Must set up distributed mode manually for multi-node clusters [Distributed deployment](https://search.qdrant.tech/md/documentation/operations/distributed_deployment/)
- Consider Hybrid Cloud if you want Qdrant Cloud management on your infrastructure [Hybrid Cloud](https://search.qdrant.tech/md/documentation/hybrid-cloud/)


## Going to Production (Zero-Ops)

Use when: you want managed infrastructure with zero-downtime updates, automatic backups, and resharding without operating clusters yourself.

- Qdrant Cloud handles upgrades, scaling, backups, and monitoring [Qdrant Cloud](https://search.qdrant.tech/md/documentation/cloud-quickstart/)
- Supports multi-version upgrades automatically
- Provides features not available in self-hosted: `/sys_metrics`, managed resharding, pre-configured alerts


## Need Lowest Possible Latency

Use when: network round-trip to a server is unacceptable. Edge devices, in-process search, or latency-critical applications.

- Qdrant EDGE: in-process bindings to Qdrant shard-level functions, no network overhead [Qdrant EDGE](https://search.qdrant.tech/md/documentation/edge/edge-quickstart/)
- Same data format as server. Can sync with server via shard snapshots.
- Single-node feature set only. No distributed mode.


## What NOT to Do

- Use local mode for production or benchmarking (not optimized, incompatible data format)
- Self-host without monitoring and backup strategy (you will lose data or miss outages)
- Choose EDGE when you need distributed search (single-node only)
- Pick Hybrid Cloud unless you have data residency requirements (unnecessary Kubernetes complexity when Qdrant Cloud works)


## Contract

This skill guarantees:

- Implements the upstream GitHub awesome-copilot skill intent for `qdrant-deployment-options`: Guides Qdrant deployment selection. Use when someone asks
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
