---
name: react18-legacy-context
description: 'Provides the complete migration pattern for React legacy context API (contextTypes, childContextTypes, getChildContext) to the modern createContext API. Use this skill whenever migrating legacy context in class components - this is always a cross-file migration requiring the provider AND all consumers to be updated together. Use it before touching any contextTypes or childContextTypes code, because migrating only the provider without the consumers (or vice versa) will cause a runtime failure. Always read this skill before writing any context migration - the cross-file coordination steps here prevent the most common context migration bugs.'
triggers:
  - "react18-legacy-context"
  - "react18 legacy context"
  - "awesome copilot react18 legacy context"
---

# React 18 Legacy Context Migration

Legacy context (`contextTypes`, `childContextTypes`, `getChildContext`) was deprecated in React 16.3 and warns in React 18.3.1. It is **removed in React 19**.

## This Is Always a Cross-File Migration

Unlike most other migrations that touch one file at a time, context migration requires coordinating:
1. Create the context object (usually a new file)
2. Update the **provider** component
3. Update **every consumer** component

Missing any consumer leaves the app broken - it will read from the wrong context or get `undefined`.

## Migration Steps (Always Follow This Order)

```
Step 1: Find the provider (childContextTypes + getChildContext)
Step 2: Find ALL consumers (contextTypes)
Step 3: Create the context file
Step 4: Update the provider
Step 5: Update each consumer (class components → contextType, function components → useContext)
Step 6: Verify - run the app, check no legacy context warnings remain
```

## Scan Commands

```bash
# Find all providers
grep -rn "childContextTypes\|getChildContext" src/ --include="*.js" --include="*.jsx" | grep -v "\.test\."

# Find all consumers
grep -rn "contextTypes\s*=" src/ --include="*.js" --include="*.jsx" | grep -v "\.test\."

# Find this.context usage (may be legacy or modern - check which)
grep -rn "this\.context\." src/ --include="*.js" --include="*.jsx" | grep -v "\.test\."
```

## Reference Files

- **`references/single-context.md`** - complete migration for one context (theme, auth, etc.) with provider + class consumer + function consumer
- **`references/multi-context.md`** - apps with multiple legacy contexts (nested providers, multiple consumers of different contexts)
- **`references/context-file-template.md`** - the standard file structure for a new context module


## Contract

This skill guarantees:

- Implements the upstream GitHub awesome-copilot skill intent for `react18-legacy-context`: Provides the complete migration pattern for React legacy context API (contextTypes, childContextTypes, getChildContext) to the modern createContext API. Use this skill whenever migrating legacy context in class component
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
