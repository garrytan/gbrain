**`gbrain transcripts archive` no longer has a day page refused by the write gate over its name, and a run exits 1 exactly when its `errors` list is not empty.**

### Fixed
- Day page names always pass the write gate. A cron job name cut at 24 characters no longer ends in a hyphen, and a label's repeated hyphens fold into one and its leading or trailing hyphen drops.
- Every day a run fails to write is listed in the run's `errors` (in `--json`) with its `day` and `code`, and a shared brain with no owner lists the `archive_owner_unset` hold there too. `run` and `backfill` exit 1 exactly when that list is not empty, and 0 otherwise.
- `--dry-run` reports `write_mode: coordinator` when the real run would write through the write coordinator, even before the archive source exists.
- Days recorded by `gbrain transcripts archive adopt-legacy` are still skipped after the brain turns shared and the archive moves to its owner-only source.
