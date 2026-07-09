---
name: what-context-needed
description: 'Ask Copilot what files it needs to see before answering a question'
triggers:
  - "what-context-needed"
  - "what context needed"
  - "awesome copilot what context needed"
---

# What Context Do You Need?

Before answering my question, tell me what files you need to see.

## My Question

{{question}}

## Instructions

1. Based on my question, list the files you would need to examine
2. Explain why each file is relevant
3. Note any files you've already seen in this conversation
4. Identify what you're uncertain about

## Output Format

```markdown
## Files I Need

### Must See (required for accurate answer)
- `path/to/file.ts` — [why needed]

### Should See (helpful for complete answer)
- `path/to/file.ts` — [why helpful]

### Already Have
- `path/to/file.ts` — [from earlier in conversation]

### Uncertainties
- [What I'm not sure about without seeing the code]
```

After I provide these files, I'll ask my question again.


## Contract

This skill guarantees:

- Implements the upstream GitHub awesome-copilot skill intent for `what-context-needed`: Ask Copilot what files it needs to see before answering a question
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
