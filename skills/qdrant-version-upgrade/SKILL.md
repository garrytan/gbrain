---
name: qdrant-version-upgrade
description: "Guidance on how to upgrade your Qdrant version without interrupting the availability of your application and ensuring data integrity."
triggers:
  - "qdrant-version-upgrade"
  - "qdrant version upgrade"
  - "awesome copilot qdrant version upgrade"
---


# Qdrant Version Upgrade

Qdrant has the following guarantees about version compatibility:

- Major and minor versions of Qdrant and SDK are expected to match. For example, Qdrant 1.17.x is compatible with SDK 1.17.x.

- Qdrant is tested for backward compatibility between minor versions. For example, Qdrant 1.17.x should be compatible with SDK 1.16.x. Qdrant server 1.16.x is also expected to be compatible with SDK 1.17.x, but only for the subset of features that were available in 1.16.x.

- For migration to the next minor version, it is recommended to first upgrade the SDK to the next minor version and then upgrade the Qdrant server.

- Storage compatibility is only guaranteed for one minor version. For example, data stored with Qdrant 1.16.x is expected to be compatible with Qdrant 1.17.x. If you need to migrate more than one minor version, it is required do the upgrade step by step, one minor version at a time. For example, to migrate from 1.15.x to 1.17.x, you need to first upgrade to 1.16.x and then to 1.17.x. Note: Qdrant Cloud automates this process, so you can directly upgrade from 1.15.x to 1.17.x without intermediate steps.

- A Qdrant cluster with a replication factor of 2 or higher can be upgraded without downtime by performing a rolling upgrade. This means that you can upgrade one node at a time while the other nodes continue to serve requests. This allows you to maintain availability of your application during the upgrade process. More about replication factor: [Replication factor](https://search.qdrant.tech/md/documentation/operations/distributed_deployment/?s=replication-factor)

For managing Qdrant version upgrades in Qdrant Cloud, you can use the [qcloud](https://github.com/qdrant/qcloud-cli) CLI tool.


## Contract

This skill guarantees:

- Implements the upstream GitHub awesome-copilot skill intent for `qdrant-version-upgrade`: Guidance on how to upgrade your Qdrant version without interrupting the availability of your application and ensuring data integrity.
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
