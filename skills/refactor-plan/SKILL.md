---
name: refactor-plan
description: 'Create a concrete plan before starting a multi-file refactor. Use when the user asks to plan, sequence, scope, or safely execute a refactor across multiple files; always investigate first, output the plan, and wait for confirmation before making code changes.'
triggers:
  - "refactor-plan"
  - "refactor plan"
  - "awesome copilot refactor plan"
---

# Refactor Plan

Create a detailed plan before making any code changes.

## Instructions

1. Do not edit files while preparing the plan.
2. Search the codebase to understand the current state. Read enough implementation, tests, configuration, and docs to make the plan specific to the repository.
3. Identify affected files, ownership boundaries, dependencies, and likely hidden coupling.
4. Plan changes in a safe sequence. Prefer contracts and types first, then implementations, then callers, then tests, then cleanup.
5. Include verification steps between phases and a final validation command.
6. Include rollback or recovery steps for the riskiest phases.
7. Output the complete plan using the format below.
8. Stop after the plan and ask for confirmation before implementing. If the user already asked you to implement, still produce the plan first and wait for confirmation unless they explicitly said to continue without review after the plan.

If the request is too ambiguous to plan safely, ask concise clarifying questions instead of editing files.

## Output Format

```markdown
## Refactor Plan: [title]

### Current State
[Brief description of how things work now]

### Target State
[Brief description of how things will work after]

### Affected Files
| File | Change Type | Dependencies |
|------|-------------|--------------|
| path | modify/create/delete | blocks X, blocked by Y |

### Execution Plan

#### Phase 1: Types and Interfaces
- [ ] Step 1.1: [action] in `file.ts`
- [ ] Verify: [how to check it worked]

#### Phase 2: Implementation
- [ ] Step 2.1: [action] in `file.ts`
- [ ] Verify: [how to check]

#### Phase 3: Tests
- [ ] Step 3.1: Update tests in `file.test.ts`
- [ ] Verify: Run `npm test`

#### Phase 4: Cleanup
- [ ] Remove deprecated code
- [ ] Update documentation

### Rollback Plan
If something fails:
1. [Step to undo]
2. [Step to undo]

### Risks
- [Potential issue and mitigation]
```

After the plan, ask: "Shall I proceed with Phase 1?"


## Contract

This skill guarantees:

- Implements the upstream GitHub awesome-copilot skill intent for `refactor-plan`: Create a concrete plan before starting a multi-file refactor. Use when the user asks to plan, sequence, scope, or safely execute a refactor across multiple files; always investigate first, output the plan, and wait for c
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
