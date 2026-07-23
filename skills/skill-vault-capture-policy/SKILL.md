---
name: skill-vault-capture-policy
version: 1.0.0
description: |
  Use when the user wants a durable operational learning, new agent skill, or
  important environment/setup change to be captured into the Obsidian vault
  instead of left only in transient chat memory. Covers the capture rule,
  preferred page patterns, and index/log update obligations.
triggers:
  - "save this learning to the vault"
  - "capture this skill in Obsidian"
  - "record this workflow in my notes"
  - "put this setup change in the vault"
  - "should we add this to the knowledge base"
tools:
  - read_file
  - search_files
  - write_file
  - patch
mutating: true
---

# Skill Vault Capture Policy

## Contract

This skill guarantees:

- Durable operational learnings, newly adopted skills, and important environment/setup changes are captured into the Obsidian vault rather than left only in chat memory.
- An existing page is updated when the knowledge clearly belongs there; a new page is created only when the topic is distinct and likely to recur.
- Every new vault page is added to `index.md`.
- Every meaningful create/update appends a dated entry to `log.md`.
- Small linked pages are preferred over one giant running note.

## Phases

1. **Classify the learning.**
   - New gbrain operating rule, cost control, or embedding/provider change.
   - New agent-fork / harness / coding-tool integration fact.
   - New Obsidian vault workflow or structure decision.
   - New recurring agent skill that changes how the agent should operate here.

2. **Avoid duplicates.**
   - Search the vault for an existing page that already owns the topic.
   - If found, update it with a new section or dated note rather than creating a near-duplicate.

3. **Create when distinct.**
   - Place new pages under the vault schema: `_meta/` for operating notes, `concepts/` for workflows, `entities/` for tools/people.
   - Use YAML frontmatter and at least two `[[wikilinks]]` unless it is a short seed page.

4. **Update navigation.**
   - Add the page to `index.md` under the correct type heading.
   - Append a `## [YYYY-MM-DD] create|update | subject` entry to `log.md`.

5. **Report the capture.**
   - State which files changed and whether `index.md` / `log.md` were updated.

## Output Format

Use a short status block:

| Item | Status |
|---|---|
| Learning classified | type |
| Page created/updated | path |
| index.md updated | yes/no |
| log.md updated | yes/no |

## Anti-Patterns

- Leaving durable learnings only in chat memory.
- Creating a near-duplicate page instead of updating the existing one.
- Forgetting to update `index.md` and `log.md`.
- Writing one giant running note instead of small linked pages.
- Recording secrets, API keys, or raw credentials in the vault.

## Tools Used

- `read_file` — read `SCHEMA.md`, `index.md`, `log.md`, and target pages.
- `search_files` — find existing pages to avoid duplicates.
- `write_file` / `patch` — create or update vault pages and navigation.

## Safe Commands

```bash
# inspect vault navigation before writing
read SCHEMA.md index.md log.md
# create or update a page, then refresh catalog/log
# index.md: add [[page-slug]] under the matching type heading
# log.md: append ## [YYYY-MM-DD] create|update | subject
```

## Verification Checklist

- [ ] Vault schema/read files were checked before writing.
- [ ] Existing pages were searched to avoid duplicates.
- [ ] New/updated page has frontmatter and wikilinks.
- [ ] `index.md` updated for new pages.
- [ ] `log.md` appended for meaningful actions.
- [ ] No secrets or raw credentials were written.
