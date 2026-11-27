**A Rust brain answers more sync and persistence reads the way PGLite and Postgres do.**

### Changed
- `listOrphanBindings` and `deleteOrphanBinding` on a Rust brain read and remove a source binding whose source is gone or holds another incarnation. Before, the Rust engine always answered "no orphans".
- The whole-source sync pass cursor (`declareSyncImportPageCursor`, `fetchSyncImportPageCursor`) is served on a Rust brain over its keyset read, instead of refusing.

### Fixed
- An entity name lookup on a Rust brain now shows the opening lines of sibling pages with the same name, as PGLite and Postgres do. Before, the Rust brain left them out. If the engine refuses the read, the refusal now reaches the caller.
- `gbrain sync --acknowledge-managed` and the cleanup a successful managed sync runs read and remove recorded managed-sync failures through typed engine members (`listSourceManagedSyncFailures`, `deleteManagedSyncFailureObservation`), so every engine answers them the same way.
- A managed sync, and the check for a moved checkout, on a Rust brain now refuse by naming the capability the Rust engine still holds (`managed_persistence`), instead of failing on an internal raw SQL refusal.
- Sync reads no longer take an engine refusal for an empty answer. A sync job's drain budget, the source a job's repo path names, whether a queued freshness sync is off, the queued embed-backfill count, the sources waiting for activation, the serve-side embed drain, and the rename remedy's brain id read through typed engine members; the removed-file slug check lets a refusal through. Where a read still runs raw SQL (the concurrent-drainer probe, the LISTEN probe), an `engine_capability_missing` refusal now reaches the caller instead of reading as "none".
- `sync status` freshness and the topology lock read through typed members (`listFreshnessTargets`, `listHostTopologyRows`, `listWorktreeMembers`), so a Rust brain answers them. A refused read of the live sync job in `gbrain sources writer movement` now reaches the caller.
- The tombstones a managed sync made that no live page backs (the ones an automatic purge keeps) are read through a typed member, `listUnreviewedSyncTombstones`, which a Rust brain serves from its store.
- A sync that downgrades a renamed file's identity records the old page through typed reads (`readIdentityDowngradeOldPage`, `countIdentityDowngradeCarry`) and the typed checkpoint writer, and the rename remedy reads both pages of the pair through `readIdentityRemedySide`. A Rust brain now records the pair and builds its remedy instead of refusing.

### Changed (tests)
- Tests: the sync-status, sync-pass and collate persistence parity cases seed their rows through typed writes (`writeOpCheckpointRecord`, the worktree claim store) or a harness stamp helper, so they run on all three engine arms.
- Tests: the collate parity cases for physical-root blockers, the deactivation preview of a managed brain, Git hold listings and managed-sync failure acknowledgement seed through typed members and run on all three engine arms. The refresh, moved-checkout and repair-frontmatter-holds cases are pinned by name on the Rust arm: `managed_persistence` is held for those callers.
- Tests: owner_host_stale is pinned by name on the Rust arm (`managed_persistence` held for callers): its waiting managed write is admitted only through admitWrite, which a Rust brain refuses. The unreviewed-tombstone tie case stays on the SQL arms, because a Rust brain cannot delete pages of two sources at one instant; the Rust store test covers the read.
