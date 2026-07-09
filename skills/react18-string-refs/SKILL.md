---
name: react18-string-refs
description: 'Provides exact migration patterns for React string refs (ref="name" + this.refs.name) to React.createRef() in class components. Use this skill whenever migrating string ref usage - including single element refs, multiple refs in a component, refs in lists, callback refs, and refs passed to child components. Always use this skill before writing any ref migration code - the multiple-refs-in-list pattern is particularly tricky and this skill prevents the most common mistakes. Use it for React 18.3.1 migration (string refs warn) and React 19 migration (string refs removed).'
triggers:
  - "react18-string-refs"
  - "react18 string refs"
  - "awesome copilot react18 string refs"
---

# React 18 String Refs Migration

String refs (`ref="myInput"` + `this.refs.myInput`) were deprecated in React 16.3, warn in React 18.3.1, and are **removed in React 19**.

## Quick Pattern Map

| Pattern | Reference |
|---|---|
| Single ref on a DOM element | [→ patterns.md#single-ref](references/patterns.md#single-ref) |
| Multiple refs in one component | [→ patterns.md#multiple-refs](references/patterns.md#multiple-refs) |
| Refs in a list / dynamic refs | [→ patterns.md#list-refs](references/patterns.md#list-refs) |
| Callback refs (alternative approach) | [→ patterns.md#callback-refs](references/patterns.md#callback-refs) |
| Ref passed to a child component | [→ patterns.md#forwarded-refs](references/patterns.md#forwarded-refs) |

## Scan Command

```bash
# Find all string ref assignments in JSX
grep -rn 'ref="' src/ --include="*.js" --include="*.jsx" | grep -v "\.test\."

# Find all this.refs accessors
grep -rn "this\.refs\." src/ --include="*.js" --include="*.jsx" | grep -v "\.test\."
```

Both should be migrated together - find the `ref="name"` and the `this.refs.name` accesses for each component as a pair.

## The Migration Rule

Every string ref migrates to `React.createRef()`:

1. Add `refName = React.createRef();` as a class field (or in constructor)
2. Replace `ref="refName"` → `ref={this.refName}` in JSX
3. Replace `this.refs.refName` → `this.refName.current` everywhere

Read `references/patterns.md` for the full before/after for each case.


## Contract

This skill guarantees:

- Implements the upstream GitHub awesome-copilot skill intent for `react18-string-refs`: Provides exact migration patterns for React string refs (ref=
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
