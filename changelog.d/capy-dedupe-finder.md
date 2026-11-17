**`gbrain dedupe --preview` shows which person and company pages are likely the same person or company, with the evidence, and changes nothing.**

### Added
- `gbrain dedupe --preview` lists groups of likely duplicate person and company pages: the same person in two sources, legacy accent spellings and root-level or agent-wiki copies inside one source, a one-word first-name page next to the full name, and two different names that share an id or address. Each group shows its evidence (which kind of key matched, never the value) and a class: clean, likely, weak, thin or conflict. `--json` prints a versioned format for scripts and benchmarks; `--kind` and `--source` narrow the list.
- `gbrain doctor` has a new `entity_duplicates` check that counts those groups.
- A schema pack can declare `identity_keys` on a page type: frontmatter fields that hold one id per person or company. Two pages with different values of such a field are never treated as one.

<!-- behavior-change: dedupe_preview_entity_duplicates -->
