---
name: next-intl-add-language
description: 'Add new language to a Next.js + next-intl application'
triggers:
  - "next-intl-add-language"
  - "next intl add language"
  - "awesome copilot next intl add language"
---

This is a guide to add a new language to a Next.js project using next-intl for internationalization,

- For i18n, the application uses next-intl.
- All translations are in the directory `./messages`.
- The UI component is `src/components/language-toggle.tsx`.
- Routing and middleware configuration are handled in:
  - `src/i18n/routing.ts`
  - `src/middleware.ts`

When adding a new language:

- Translate all the content of `en.json` to the new language. The goal is to have all the JSON entries in the new language for a complete translation.
- Add the path in `routing.ts` and `middleware.ts`.
- Add the language to `language-toggle.tsx`.


## Contract

This skill guarantees:

- Implements the upstream GitHub awesome-copilot skill intent for `next-intl-add-language`: Add new language to a Next.js + next-intl application
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
