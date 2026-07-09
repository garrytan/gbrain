---
name: eas-workflows
description: EAS service (paid). Helps understand and write EAS workflow YAML files for Expo projects. Use this skill when the user asks about CI/CD or workflows in an Expo or EAS context, mentions .eas/workflows/, or wants help with EAS build pipelines or deployment automation.
allowed-tools: "Read,Write,Bash(node:*)"
version: 1.0.0
license: MIT License
---

# EAS Workflows Skill

> **EAS service - costs apply.** EAS Workflows run on Expo Application Services, a paid product with free-tier limits. Each workflow job consumes your plan's build/compute minutes, and jobs that build or submit also need paid Apple Developer and Google Play accounts. Review https://expo.dev/pricing before triggering runs.

Help developers write and edit EAS CI/CD workflow YAML files.

## Reference Documentation

Fetch these resources before generating or validating workflow files. First resolve this skill's directory, then use the fetch script in its `scripts/` directory. It is implemented using Node.js and caches responses using ETags for efficiency:

```bash
# Fetch resources
node <skill-dir>/scripts/fetch.js <url>
```

1. **JSON Schema** — https://api.expo.dev/v2/workflows/schema
   - It is NECESSARY to fetch this schema
   - Source of truth for validation
   - All job types and their required/optional parameters
   - Trigger types and configurations
   - Runner types, VM images, and all enums

2. **Syntax Documentation** — https://raw.githubusercontent.com/expo/expo/refs/heads/main/docs/pages/eas/workflows/syntax.mdx
   - Overview of workflow YAML syntax
   - Examples and English explanations
   - Expression syntax and contexts

3. **Pre-packaged Jobs** — https://raw.githubusercontent.com/expo/expo/refs/heads/main/docs/pages/eas/workflows/pre-packaged-jobs.mdx
   - Documentation for supported pre-packaged job types
   - Job-specific parameters and outputs

Do not rely on memorized values; these resources evolve as new features are added.

## Workflow File Location

Workflows live in `.eas/workflows/*.yml` (or `.yaml`).

## Top-Level Structure

A workflow file has these top-level keys:

- `name` — Display name for the workflow
- `on` — Triggers that start the workflow (at least one required)
- `jobs` — Job definitions (required)
- `defaults` — Shared defaults for all jobs
- `concurrency` — Control parallel workflow runs

Consult the schema for the full specification of each section.

## Expressions

Use `${{ }}` syntax for dynamic values. The schema defines available contexts:

- `github.*` — GitHub repository and event information
- `inputs.*` — Values from `workflow_dispatch` inputs
- `needs.*` — Outputs and status from dependent jobs
- `jobs.*` — Job outputs (alternative syntax)
- `steps.*` — Step outputs within custom jobs
- `workflow.*` — Workflow metadata

## Generating Workflows

When generating or editing workflows:

1. Fetch the schema to get current job types, parameters, and allowed values
2. Validate that required fields are present for each job type
3. Verify job references in `needs` and `after` exist in the workflow
4. Check that expressions reference valid contexts and outputs
5. Ensure `if` conditions respect the schema's length constraints

## Validation

After generating or editing a workflow file, validate it against the schema:

```sh
# Install dependencies if missing
[ -d "<skill-dir>/scripts/node_modules" ] || npm install --prefix <skill-dir>/scripts

node <skill-dir>/scripts/validate.js <workflow.yml> [workflow2.yml ...]
```

The validator fetches the latest schema and checks the YAML structure. Fix any reported errors before considering the workflow complete.

## Answering Questions

When users ask about available options (job types, triggers, runner types, etc.), fetch the schema and derive the answer from it rather than relying on potentially outdated information.


## Contract

This skill guarantees:

- Covers its source domain per the skill description: EAS service (paid). Helps understand and write EAS workflow YAML files for Expo projects. Use this skill when the user asks about CI/CD or workflows in an Expo or EAS context, mentions .eas/workflows/, or wants help with EAS build pipelines or deployment autom
- Loads only task-relevant references/scripts and keeps context lean.
- Produces concrete, source-grounded output: exact commands, code snippets, app configuration, token values, or platform steps as applicable.
- Never fabricates APIs, configuration keys, UI tokens, store metadata, or platform behavior not present in the source references or current project.

## Output Format

Lead with the actionable result. For implementation tasks, return the changed files/commands and verification result. For design/mobile guidance, return concise token/component/platform steps grounded in the skill references. Avoid dumping complete reference files; cite the relevant path and extract only the decisive snippet.

## Anti-Patterns

- Inventing APIs, store metadata, UI tokens, or platform capabilities.
- Copying large references into the response when a targeted excerpt is enough.
- Applying this skill outside its domain when a more specific skill exists.
- Skipping verification commands or platform checks after making changes.
