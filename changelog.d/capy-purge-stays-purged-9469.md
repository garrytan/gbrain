---
important: security
---
**A page its owner purged stays purged after a restore, even when the purge waited behind a private derived page.**

When an owner purges a page that a derived page depends on for its privacy, the purge waits until that derived page can be labelled private. Before this change, if an automatic purge removed the page first, or the next purge run failed or was deferred, the page was deleted without the purge records that tell a restore to delete it again, so restoring an older backup brought its text back. gbrain now remembers that the owner's purge is owed, by page id only, and whichever run finally removes the page writes those records, on repo brains and on brains without a repository. Restoring the page clears the reminder, so a page its owner brings back is never purged later by it.

A restore now also removes the same rows a live page purge removes. Replaying a purge from the purge mirror used to delete the page but leave its write requests, file rows, derived generation items and their effects, which still held the purged text. Replay and the live purge now share one sweep. If replay cannot finish a sweep (a store that does not exist on the brain aside), the restore stops with `purge_replay_incomplete` and names the purge it could not replay, instead of reporting success. A new doctor warning, `purge_mirror`, says when recent purges are missing from this machine's purge mirror (for example when gbrain runs in a home directory that is removed after each run), so a restore from an older backup would not replay them. The fix is to give every writer one durable `GBRAIN_HOME`. Thanks to @oakleaf for the replay and purge mirror findings (#9469).

<!-- behavior-change: owner_purge_tombstones_survive_9469 -->

### Fixed

- An owner purge that waited behind a private derived page writes its purge records whichever later run removes the page (an automatic expiry, or a run after a failed or deferred one), on every brain.
- Restore-time purge replay removes write requests, file rows, derived generation items and their effects, the same rows the live purge removes, and fails with `purge_replay_incomplete` instead of reporting a partial sweep as done.

### Added

- Doctor check `purge_mirror`: a warning (never a failure) when purges recorded in the last 30 days have no line in this machine's purge mirror. It prints counts and the mirror's path, never a page name or text.
