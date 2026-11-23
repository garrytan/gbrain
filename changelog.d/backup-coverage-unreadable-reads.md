**The backup check no longer reports a confident answer when it could not read something.**

A backup-coverage read that fails now marks the verdict degraded, or the item unknown, in place of a confident answer. A healthy check prints exactly what it did before.

<!-- behavior-change: backup_coverage_failed_read_degraded -->

### Fixed
- An install receipt that exists but cannot be read now shows as an unknown bootstrap workspace and keeps the verdict in warn; before, `gbrain doctor` could report the backup as ok while the bootstrap repo went unchecked. A receipt behind a directory that cannot be searched counts as unreadable too. A missing receipt is still simply empty.
- A `gbrain.yml` that cannot be read (any read error except a missing file, also for a source inside the bootstrap workspace) now shows as an unknown `db_only` row instead of silently dropping the "these pages are not in git" row, and it keeps the verdict in warn.
- When the page and fact count cannot be read, the verdict is marked degraded ("the database was unreadable during the check") instead of keeping a stale "young brain" count that silenced backup coaching.
- When a full refresh fails and the check falls back to the cached verdict, it now marks that verdict degraded and drops the cached page and fact count, so `gbrain doctor` no longer says "Not urgent yet" on stale information.
