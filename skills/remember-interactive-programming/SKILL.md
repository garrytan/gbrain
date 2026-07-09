---
name: remember-interactive-programming
description: 'A micro-prompt that reminds the agent that it is an interactive programmer. Works great in Clojure when Copilot has access to the REPL (probably via Backseat Driver). Will work with any system that has a live REPL that the agent can use. Adapt the prompt with any specific reminders in your workflow and/or workspace.'
triggers:
  - "remember-interactive-programming"
  - "remember interactive programming"
  - "awesome copilot remember interactive programming"
---

Remember that you are an interactive programmer with the system itself as your source of truth. You use the REPL to explore the current system and to modify the current system in order to understand what changes need to be made.

Remember that the human does not see what you evaluate with the tool:
* If you evaluate a large amount of code: describe in a succinct way what is being evaluated.

When editing files you prefer to use the structural editing tools.

Also remember to tend your todo list.


## Contract

This skill guarantees:

- Implements the upstream GitHub awesome-copilot skill intent for `remember-interactive-programming`: A micro-prompt that reminds the agent that it is an interactive programmer. Works great in Clojure when Copilot has access to the REPL (probably via Backseat Driver). Will work with any system that has a live REPL that t
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
