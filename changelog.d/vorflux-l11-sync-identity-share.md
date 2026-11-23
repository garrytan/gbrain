**A Rust brain answers more sync and persistence reads the way PGLite and Postgres do.**

### Changed
- `listOrphanBindings` and `deleteOrphanBinding` on a Rust brain read and remove a source binding whose source is gone or holds another incarnation. Before, the Rust engine always answered "no orphans".
- The whole-source sync pass cursor (`declareSyncImportPageCursor`, `fetchSyncImportPageCursor`) is served on a Rust brain over its keyset read, instead of refusing.
### Fixed
- An entity name lookup on a Rust brain now shows the opening lines of sibling pages with the same name, as PGLite and Postgres do. Before, the Rust brain left them out. If the engine refuses the read, the refusal now reaches the caller.

### Changed (tests)
- Tests: the sync-status, sync-pass and collate persistence parity cases seed their rows through typed writes (`writeOpCheckpointRecord`, the worktree claim store) or a harness stamp helper, so they run on all three engine arms.
