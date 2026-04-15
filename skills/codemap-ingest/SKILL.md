# Codemap Ingest Skill

Build a technical knowledge map for a codebase or a cross-system concept.

Use this when the user asks to:
- map a repo or subsystem into gbrain
- explain how a concept works across multiple codebases
- capture architecture knowledge discovered during a coding session
- turn code exploration into persistent brain pages

## Goal

Produce:
- one `system` page per repo or major subsystem
- one or more `concept` pages with `codemap` frontmatter
- typed links between systems and concepts

The map is an orientation layer. It does not replace grep or reading source.

## Workflow

1. **Read the brain first**
   - `gbrain search "<system or concept>"`
   - `gbrain query "what do we know about <system or concept>"`
   - `gbrain get <slug>` if a likely page already exists
2. **Explore the codebase just enough**
   - read the README
   - inspect the top-level tree
   - find build/test commands
   - identify key entry points and core abstractions
3. **Create or update the `system` page**
   - use `templates/system-page.md`
   - keep the architecture summary concise and agent-oriented
   - list grep-able paths in `key_entry_points`
4. **Create or update `concept` pages with `codemap`**
   - use `templates/concept-codemap-page.md`
   - add one codemap entry per system
   - each pointer needs `path`, `role`, and ideally `symbol`
5. **Verify before saving**
   - verify each central pointer with targeted grep/read
   - if a pointer moved, update it and record the change in timeline
   - if a pointer cannot be found, mark it `stale: true` instead of deleting it
6. **Cross-link**
   - `implements`
   - `depends_on`
   - `extends`
   - `contradicts`
   - `layer_of`
   - `prerequisite_for`
7. **Write back and sync**
   - `gbrain put_page`
   - `gbrain add_link`
   - `gbrain sync_brain` with `no_pull: true`

## Verification Protocol

For each pointer you plan to save:

1. Check the expected file path exists.
2. If `symbol` is present, grep the expected path for it.
3. If not found, grep the repo broadly for the symbol.
4. If found elsewhere, update the path and add a timeline note.
5. If not found anywhere, keep the pointer but set `stale: true`.

## Authoring Rules

- Prefer 3-8 high-value pointers over exhaustive dumps.
- `role` explains why the code matters for the concept.
- Keep compiled truth under roughly 400 words.
- Preserve vocabulary differences across systems in `vocabulary`.
- Store build/test commands on the `system` page, not in concept pages.
- When the user only asked a local code question, write back only if the discovered knowledge is likely to matter again.

## Templates

- `templates/system-page.md`
- `templates/concept-codemap-page.md`
