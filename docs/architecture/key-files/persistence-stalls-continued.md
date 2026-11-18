# Managed sync and persistence stalls (continued)

[Subsystem index](../KEY_FILES.md) · [Previous entries](persistence-stalls.md). Read only the entries relevant to your change.
Current behavior and load-bearing invariants; history belongs in Git and CHANGELOG.

- `src/core/persistence/sync-discovery.ts` (#6349 staged catch-up) — when an incremental delta (not `--full`, not company) exceeds the cursor bound (100,000 entries, 16 MiB; `_setCursorBoundForTest` lowers it), `stagedSyncTarget` gallops forward over `git rev-list --first-parent last..HEAD`, verifying every candidate's delta from the last synced commit against the bound (a net delta is not monotone, so no binary search), and discovery reruns pinned at the furthest fitting commit with no working-tree entries, recording `stagedHead`; the cursor carries it and `SyncResult.staged { target, head, stages }` reports it. One commit alone above the bound refuses `request_too_large` naming the commit. `commands/sync/perform.ts` loops a drain stage by stage to HEAD (the drain's one extra HEAD-moved pass is skipped for a staged result). Tests: `test/sync-staged-catchup.test.ts`.
