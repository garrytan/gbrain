---
name: copilot-usage-metrics
description: Retrieve and display GitHub Copilot usage metrics for organizations and enterprises using the GitHub CLI and REST API.
triggers:
  - "copilot-usage-metrics"
  - "copilot usage metrics"
  - "awesome copilot copilot usage metrics"
---

# Copilot Usage Metrics

You are a skill that retrieves and displays GitHub Copilot usage metrics using the GitHub CLI (`gh`).

## When to use this skill

Use this skill when the user asks about:
- Copilot usage metrics, adoption, or statistics
- How many people are using Copilot in their org or enterprise
- Copilot acceptance rates, suggestions, or chat usage
- Per-user Copilot usage breakdowns
- Copilot usage on a specific date

## How to use this skill

1. Determine whether the user wants **organization** or **enterprise** level metrics.
2. Ask for the org name or enterprise slug if not provided.
3. Determine if they want **aggregated** metrics or **per-user** metrics.
4. Determine if they want metrics for a **specific day** (YYYY-MM-DD format) or general/recent metrics.
5. Run the appropriate script from this skill's directory.

## Available scripts

### Organization metrics

- `get-org-metrics.sh <org> [day]` — Get aggregated Copilot usage metrics for an organization. Optionally pass a specific day in YYYY-MM-DD format.
- `get-org-user-metrics.sh <org> [day]` — Get per-user Copilot usage metrics for an organization. Optionally pass a specific day.

### Enterprise metrics

- `get-enterprise-metrics.sh <enterprise> [day]` — Get aggregated Copilot usage metrics for an enterprise. Optionally pass a specific day.
- `get-enterprise-user-metrics.sh <enterprise> [day]` — Get per-user Copilot usage metrics for an enterprise. Optionally pass a specific day.

## Formatting the output

When presenting results to the user:
- Summarize key metrics: total active users, acceptance rate, total suggestions, total chat interactions
- Use tables for per-user breakdowns
- Highlight trends if comparing multiple days
- Note that metrics data is available starting from October 10, 2025, and historical data is accessible for up to 1 year

## Important notes

- These API endpoints require **GitHub Enterprise Cloud**.
- The user must have appropriate permissions (enterprise owner, billing manager, or a token with `manage_billing:copilot` / `read:enterprise` scope).
- The "Copilot usage metrics" policy must be enabled in enterprise settings.
- If the API returns 403, advise the user to check their token permissions and enterprise policy settings.


## Contract

This skill guarantees:

- Implements the upstream GitHub awesome-copilot skill intent for `copilot-usage-metrics`: Retrieve and display GitHub Copilot usage metrics for organizations and enterprises using the GitHub CLI and REST API.
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
