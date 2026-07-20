---
name: slides
description: Create strategic HTML presentations with Chart.js, design tokens, responsive layouts, copywriting formulas, and contextual slide strategies.
argument-hint: "[topic] [slide-count]"
metadata:
  author: claudekit
  version: "1.0.0"
---

# Slides

Strategic HTML presentation design with data visualization.

## When to Use

- Marketing presentations and pitch decks
- Data-driven slides with Chart.js
- Strategic slide design with layout patterns
- Copywriting-optimized presentation content

## Subcommands

| Subcommand | Description | Reference |
|------------|-------------|-----------|
| `create` | Create strategic presentation slides | `references/create.md` |

## References (Knowledge Base)

| Topic | File |
|-------|------|
| Layout Patterns | `references/layout-patterns.md` |
| HTML Template | `references/html-template.md` |
| Copywriting Formulas | `references/copywriting-formulas.md` |
| Slide Strategies | `references/slide-strategies.md` |

## Routing

1. Parse subcommand from `$ARGUMENTS` (first word)
2. Load corresponding `references/{subcommand}.md`
3. Execute with remaining arguments


## Contract

This skill guarantees:

- Covers its domain per the skill description: Create strategic HTML presentations with Chart.js, design tokens, responsive layouts, copywriting formulas, and contextual slide strategies.
- Loads only the reference/scripts files the current task needs, keeping context lean.
- Produces concrete, file-anchored output (named tokens, code, commands) rather than vague guidance.
- Never fabricates design values, component names, or API calls not present in the source or the task.

## Output Format

Replies lead with the actionable result: the token/system/code or the exact command used. Quote the brief's words verbatim when they pin a requirement. Keep planning in thinking; surface only high-confidence directions. Do not dump full source files when a doc link or the decisive snippet suffices.

## Anti-Patterns

- Inventing token values, component names, or APIs not in the source.
- Dumping entire reference/source files into context when a targeted excerpt suffices.
- Applying the skill's language where the brief explicitly wants something else.
- Treating out-of-scope tasks as in-scope.
