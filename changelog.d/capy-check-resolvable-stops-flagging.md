**`gbrain check-resolvable` stops reporting three kinds of false alarm on large skill trees, and its `--fix --dry-run` preview now proposes only edits for findings the same run reports (GST-3155).**

### Fixed
- A bolded bullet in a workspace `AGENTS.md` such as `- **memory**: search first` is no longer read as a routing row for a skill named `memory`, so it no longer shows up as `missing_file skills/memory/SKILL.md`. A list row there still routes when `skills/<name>/SKILL.md` exists, and list rows in `skills/RESOLVER.md` always count.
- A skill whose folder name differs from the `name:` in its frontmatter is no longer reported as `orphan_trigger`: the check now finds it in manifest.json by its path as well as its name.
- A manifest.json entry whose SKILL.md was deleted is reported once as `missing_file` naming manifest.json, instead of `unreachable`.
- `gbrain check-resolvable --fix` applies only the DRY replacements its report lists. It no longer inserts brain-first callouts, which only `gbrain doctor --fix` reports and repairs. A DRY replacement also stops at headings and code fences, so one matched line no longer replaces the whole section around it.
