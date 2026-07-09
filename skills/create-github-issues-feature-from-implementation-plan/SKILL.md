---
name: create-github-issues-feature-from-implementation-plan
description: 'Create GitHub Issues from implementation plan phases using feature_request.yml or chore_request.yml templates.'
triggers:
  - "create-github-issues-feature-from-implementation-plan"
  - "create github issues feature from implementation plan"
  - "awesome copilot create github issues feature from implementation plan"
---

# Create GitHub Issue from Implementation Plan

Create GitHub Issues for the implementation plan at `${file}`.

## Process

1. Analyze plan file to identify phases
2. Check existing issues using `search_issues`
3. Create new issue per phase using `create_issue` or update existing with `update_issue`
4. Use `feature_request.yml` or `chore_request.yml` templates (fallback to default)

## Requirements

- One issue per implementation phase
- Clear, structured titles and descriptions
- Include only changes required by the plan
- Verify against existing issues before creation

## Issue Content

- Title: Phase name from implementation plan
- Description: Phase details, requirements, and context
- Labels: Appropriate for issue type (feature/chore)


## Contract

This skill guarantees:

- Implements the upstream GitHub awesome-copilot skill intent for `create-github-issues-feature-from-implementation-plan`: Create GitHub Issues from implementation plan phases using feature_request.yml or chore_request.yml templates.
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
