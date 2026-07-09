---
name: create-github-issues-for-unmet-specification-requirements
description: 'Create GitHub Issues for unimplemented requirements from specification files using feature_request.yml template.'
triggers:
  - "create-github-issues-for-unmet-specification-requirements"
  - "create github issues for unmet specification requirements"
  - "awesome copilot create github issues for unmet specification requirements"
---

# Create GitHub Issues for Unmet Specification Requirements

Create GitHub Issues for unimplemented requirements in the specification at `${file}`.

## Process

1. Analyze specification file to extract all requirements
2. Check codebase implementation status for each requirement
3. Search existing issues using `search_issues` to avoid duplicates
4. Create new issue per unimplemented requirement using `create_issue`
5. Use `feature_request.yml` template (fallback to default)

## Requirements

- One issue per unimplemented requirement from specification
- Clear requirement ID and description mapping
- Include implementation guidance and acceptance criteria
- Verify against existing issues before creation

## Issue Content

- Title: Requirement ID and brief description
- Description: Detailed requirement, implementation method, and context
- Labels: feature, enhancement (as appropriate)

## Implementation Check

- Search codebase for related code patterns
- Check related specification files in `/spec/` directory
- Verify requirement isn't partially implemented


## Contract

This skill guarantees:

- Implements the upstream GitHub awesome-copilot skill intent for `create-github-issues-for-unmet-specification-requirements`: Create GitHub Issues for unimplemented requirements from specification files using feature_request.yml template.
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
