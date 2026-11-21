**`gbrain doctor` now says so when your brain's datastore is missing, instead of quietly creating an empty one and reporting healthy.**

### Fixed
- When the config names a PGLite datastore that is not there (an unmounted drive, a moved folder), `gbrain doctor`, `doctor --json` and `doctor --only connection --json` now stop before connecting, exit non-zero and print a `brain_missing` error (reason `missing_brain`, the same one `gbrain serve`'s status mode gives). Nothing is created on disk. Before, doctor built a new empty brain at that path, migrated it, and reported status healthy, health score 100, "Connected, 0 pages", and the next `gbrain serve` opened that empty brain. Mount the drive, move the folder back, or update `database_path`; a new empty brain is `gbrain init`, your decision. `doctor --fast` and filesystem-only `doctor --only` checks never connect and still run. One case is not covered yet. A brain folder with no `PG_VERSION` that holds a stale, corrupt `.gbrain-lock` and an old-format `.gbrain-owner.json` still gets an empty brain from doctor, and a follow-up fix is planned.

<!-- behavior-change: doctor_missing_brain_health1 -->
