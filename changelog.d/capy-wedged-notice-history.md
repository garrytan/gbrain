---
important: regression
---
**Commands no longer print a "wedged" migration notice asking for a forced retry once a newer migration has completed since; doctor and apply-migrations name each source still in conflict and its next step instead.**

### Fixed
- Since v0.60.725.0 every ordinary command (remember, recall, config get and the rest) printed `Upgrade migration(s) 0.53.0 failed several runs in a row and are wedged` with an ask-the-user `--force-retry` fix on a brain whose upgrade ledger held three old partial runs of a migration, even though a newer migration had completed since and `gbrain apply-migrations` called it history. The notice now follows apply-migrations: such a wedge is history and ordinary commands print nothing about it. A wedge with no newer migration past it still gets the notice.
- The shared-skills migration (v0.53.0) reports a source conflict where an operator looks, and never advises a forced retry: `gbrain doctor` (connected) warns with each source in conflict, its code and its next step, and goes quiet once none is left; `gbrain apply-migrations --dry-run`, `--yes` and `post-upgrade` name the same sources. They read the migration's own read-only preview, which takes under a second on a brain with five sources of 20,000 files each.
- A source conflict now carries a code. `shared_skills_unmanifested` (`gbrain errors shared_skills_unmanifested`) means a source's `skills/` folder holds skills with no `skillpack.json` declaring them: declare the ones to share in a `skillpack.json` at the source's root, or keep the source out of shared-skills adoption with `gbrain sources shared-skills <id> off`. Other conflicts carry the code of the error that stopped the inventory.
- A named run of a wedged v0.53.0 (`gbrain apply-migrations --migration 0.53.0 --yes`) still refuses, now with the read-only preview as its fix instead of a forced retry.

### Tests
- A source with no local path (a database-only source such as the conversation archive's) is pinned never to answer a path lookup, on PGLite and Postgres.

<!-- behavior-change: migration_wedge_notice_history -->
