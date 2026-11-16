**`gbrain upgrade` and the stable release notes now start with a short summary of the behaviour changes since the version you had.**

### Added
- Once the new version is installed, `gbrain upgrade` (through `gbrain post-upgrade`) prints the summary before its migrations run: the changes that need you first, then changed defaults, then a count of fixes and additions, and a pointer to `gbrain doctor --only behavior_changes` for the full text. Each change shows its first sentence. Under `--json` the summary goes to stderr with the other human lines, so the JSON document on stdout is unchanged.
- When stable moves, its GitHub release notes open with the same summary for the range since the previous stable release, above the changelog entries. A summary too long for the page by itself is left out, so the notes always fit.
- Rows written before `kind:` existed are counted as not classified yet. The generated behaviour-change table now carries each row's `kind`, so new rows land in the right group.
