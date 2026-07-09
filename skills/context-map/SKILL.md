---
name: context-map
description: 'Generate a map of all files relevant to a task before making changes'
triggers:
  - "context-map"
  - "context map"
  - "awesome copilot context map"
---

# Context Map

Before implementing any changes, analyze the codebase and create a context map.

## Task

{{task_description}}

## Instructions

1. Search the codebase for files related to this task
2. Identify direct dependencies (imports/exports)
3. Find related tests
4. Look for similar patterns in existing code

## Output Format

```markdown
## Context Map

### Files to Modify
| File | Purpose | Changes Needed |
|------|---------|----------------|
| path/to/file | description | what changes |

### Dependencies (may need updates)
| File | Relationship |
|------|--------------|
| path/to/dep | imports X from modified file |

### Test Files
| Test | Coverage |
|------|----------|
| path/to/test | tests affected functionality |

### Reference Patterns
| File | Pattern |
|------|---------|
| path/to/similar | example to follow |

### Risk Assessment
- [ ] Breaking changes to public API
- [ ] Database migrations needed
- [ ] Configuration changes required
```

Do not proceed with implementation until this map is reviewed.


## Contract

This skill guarantees:

- Implements the upstream GitHub awesome-copilot skill intent for `context-map`: Generate a map of all files relevant to a task before making changes
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
