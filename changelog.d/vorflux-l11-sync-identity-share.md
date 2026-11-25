**A Rust brain answers more sync and persistence reads the way PGLite and Postgres do.**

### Changed
- `listOrphanBindings` and `deleteOrphanBinding` on a Rust brain read and remove a source binding whose source is gone or holds another incarnation. Before, the Rust engine always answered "no orphans".
- The whole-source sync pass cursor (`declareSyncImportPageCursor`, `fetchSyncImportPageCursor`) is served on a Rust brain over its keyset read, instead of refusing.

### Fixed
- An entity name lookup on a Rust brain now shows the opening lines of sibling pages with the same name, as PGLite and Postgres do. Before, the Rust brain left them out. If the engine refuses the read, the refusal now reaches the caller.
- `gbrain sync --acknowledge-managed` and the cleanup a successful managed sync runs read and remove recorded managed-sync failures through typed engine members (`listSourceManagedSyncFailures`, `deleteManagedSyncFailureObservation`), so every engine answers them the same way.
- A managed sync, and the check for a moved checkout, on a Rust brain now refuse by naming the capability the Rust engine still holds (`managed_persistence`), instead of failing on an internal raw SQL refusal.

### Changed (tests)
- Tests: the sync-status, sync-pass and collate persistence parity cases seed their rows through typed writes (`writeOpCheckpointRecord`, the worktree claim store) or a harness stamp helper, so they run on all three engine arms.
- Tests: the collate parity cases for physical-root blockers, the deactivation preview of a managed brain, Git hold listings and managed-sync failure acknowledgement seed through typed members and run on all three engine arms. The refresh, moved-checkout and repair-frontmatter-holds cases are pinned by name on the Rust arm: `managed_persistence` is held for those callers.
