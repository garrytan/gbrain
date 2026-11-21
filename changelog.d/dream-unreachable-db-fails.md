**`gbrain dream` on a configured brain whose database can't be reached now fails instead of reporting a healthy cycle.**

### Fixed
- When the database could not be reached, the dream cycle skipped every DB phase and exited 0, so a scheduled run read as success while doing nothing. The report now carries `status: failed` and `reason: database_unreachable`, the run exits 1 through the same path as any failed cycle (including under `--json`), and it no longer prints "Brain is healthy". A machine with no gbrain config keeps its exit-0 filesystem-only run.
