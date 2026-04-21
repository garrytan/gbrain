---
name: testing
version: 1.0.0
description: |
  Skill validation framework. Validates every skill has SKILL.md with frontmatter,
  every reference exists, every env var is declared. The testing contract for the
  skill system itself.
triggers:
  - "validate skills"
  - "test skills"
  - "skill health check"
  - "run conformance tests"
tools:
  - search
  - list_pages
mutating: false
---

# Testing Skill — Skill Validation Framework

## Contract

This skill guarantees:
- Every skill directory has a SKILL.md file
- Every SKILL.md has valid YAML frontmatter (name, description)
- Every SKILL.md has required sections (Contract, Anti-Patterns, Output Format)
- manifest.json lists every skill directory
- RESOLVER.md references every skill in the manifest
- No MECE violations (duplicate triggers across skills)

## Phases

1. **Walk skills directory.** List all subdirectories containing SKILL.md.
2. **Validate frontmatter.** Parse YAML, check required fields.
3. **Validate sections.** Check for Contract, Anti-Patterns, Output Format headings.
4. **Check manifest.** Every skill directory must be listed in manifest.json.
5. **Check resolver.** Every manifest skill must have a RESOLVER.md entry.
6. **Report results.**

Automated: `bun test test/skills-conformance.test.ts test/resolver.test.ts`

## Output Format

```
Skill Validation Report
========================
Skills found: N
Conformance: N/N pass
Manifest coverage: N/N
Resolver coverage: N/N
MECE violations: N

Issues:
- {skill}: {issue}
```

## Anti-Patterns

- Skipping validation after adding a new skill
- Adding skills to manifest without adding to resolver
- Creating skills without the conformance template
