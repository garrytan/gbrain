**`gbrain doctor` now also refuses a missing brain behind a leftover lock, under `--alert`, and when the folder moves while doctor waits for the lock.**

### Fixed
- A brain folder with no `PG_VERSION` that still holds a leftover `.gbrain-lock` whose metadata is unreadable is refused as `brain_missing`, like any other missing datastore. Before, the leftover lock read as held, the folder test was skipped, and doctor built an empty brain.
- When the folder is moved or unmounted while doctor waits for the datastore's lock, doctor looks again once it holds the lock, refuses, releases it and creates no datastore. The empty `.gbrain-owner.lock` file beside the folder, and the folder's parent directories if the whole drive path is gone, can still be left behind.
- With `--alert` (and `--alert --json`) the refusal is the alert contract: exit 17, `alert.level` `act`, and an `alert.items` entry with code `brain_missing` and the same ask-the-user fix, so a monitor pages on it instead of seeing a bare exit 1. Without `--alert`, doctor still exits 1 with the same `brain_missing` envelope.

<!-- behavior-change: doctor_missing_brain_followup_10114 -->
