**A stuck shared-skills migration is reported as owed work everywhere, with a read-only first step, instead of being called history.**

### Fixed
- A migration that stopped three or more runs in a row on a source conflict and still owes host work (v0.53.0 today) is no longer called "history, not outstanding work" because a newer migration completed. `gbrain apply-migrations --list`, the notice on other commands and `gbrain serve` startup, and `gbrain doctor` (a warning) now say the same thing: the work is still owed, it does not clear without a person, and the first step is `gbrain apply-migrations --migration 0.53.0 --dry-run --json`, which lists each source's conflict and changes nothing. The forced retry is offered only for after the conflict is resolved, and that inspect command no longer refuses a wedged version as "not registered". Nothing runs the migration again by itself, and no exit status changes.

<!-- behavior-change: migration_host_work_owed -->
