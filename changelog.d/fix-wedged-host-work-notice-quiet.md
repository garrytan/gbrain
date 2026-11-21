**Ordinary commands stop repeating a notice about a migration that is waiting on a person's decision.**

### Fixed
- A brain whose v0.53.0 shared-skills migration is stopped on a source conflict (skills with no skillpack.json, for example) no longer prints a `migrations_pending` notice on every `remember`, `recall`, `stats` or other ordinary command when no newer migration has run since. Settling that conflict needs a person, so the repeated notice changed nothing. `gbrain doctor` still warns about it with the read-only step that lists each source's conflict, `gbrain apply-migrations` and `post-upgrade` still report it, and `gbrain serve` still names it once at startup.
- A migration that has not run yet, or only partly ran, is named again on a brain where the stopped v0.53.0 is also present. Before, the v0.53.0 message replaced theirs.

<!-- behavior-change: migration_host_work_notice_quiet -->
