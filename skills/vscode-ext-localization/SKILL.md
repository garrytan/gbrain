---
name: vscode-ext-localization
description: 'Guidelines for proper localization of VS Code extensions, following VS Code extension development guidelines, libraries and good practices'
triggers:
  - "vscode-ext-localization"
  - "vscode ext localization"
  - "awesome copilot vscode ext localization"
---

# VS Code extension localization

This skill helps you localize every aspect of VS Code extensions

## When to use this skill

Use this skill when you need to:
- Localize new or existing contributed configurations (settings), commands, menus, views or walkthroughs
- Localize new or existing messages or other string resources contained in extension source code that are displayed to the end user

# Instructions

VS Code localization is composed by three different approaches, depending on the resource that is being localized. When a new localizable resource is created or updated, the corresponding localization for all currently available languages must be created/updated.

1. Configurations like Settings, Commands, Menus, Views, ViewsWelcome, Walkthrough Titles and Descriptions, defined in `package.json`
  -> An exclusive `package.nls.LANGID.json` file, like `package.nls.pt-br.json` of Brazilian Portuguese (`pt-br`) localization
2. Walkthrough content (defined in its own `Markdown` files)
  -> An exclusive `Markdown` file like `walkthrough/someStep.pt-br.md` for Brazilian Portuguese localization
3. Messages and string located in extension source code (JavaScript or TypeScript files)
  -> An exclusive `bundle.l10n.pt-br.json` for Brazilian Portuguese localization


## Contract

This skill guarantees:

- Implements the upstream GitHub awesome-copilot skill intent for `vscode-ext-localization`: Guidelines for proper localization of VS Code extensions, following VS Code extension development guidelines, libraries and good practices
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
