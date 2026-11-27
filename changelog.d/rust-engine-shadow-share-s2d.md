**Shadow status can no longer read "measured" after a disk refuses an owed record and the shadow worker exits.**

### Fixed
- When the disk refused the owed record of a shadow session (a full disk, an I/O error) and the worker then exited, the serving command threw away the count it had not been able to write when it started the next worker, so `gbrain engine shadow status` could read "measured" with samples in no file, even after the disk recovered. The command now keeps the exact record per session, retries it (every 0.1 s at first, slowing to every 5 s) until the disk takes it, publishes it at once when the process exits, and removes nothing while it is unwritten. The next shadow worker books what was never settled once, as `uncomparable` (`receipt_orphaned`).
- The moment a record write fails, the command leaves a marker file, `write-pending.<session>.json`, in the shadow state directory (a hard link to a file that is already there, its directory entry flushed). While a marker exists, status reads no evidence and names the file and the step to take; no worker settles, prunes or removes that session. Every removal of an owed file (the worker's own finish, the orphan pass, the settlement pruning) now re-reads the record and the marker under the shadow tally lock before it deletes, and the command publishes a record and clears its marker under the same lock, so a removal that was already under way cannot delete a newer record.
- A sample refused while no worker runs (the restart backoff, a failed spawn), whose refusal could not be written down either, is now made owed in a record of its own (kept, marked and retried like any other) instead of waiting only in the sampler's memory.

### Changed
- `gbrain engine shadow status` and the swap report print `pending_markers` (the paths) and the operator step when a marker exists: confirm the disk is healthy, delete the marker file, then restart shadow. On a managed or owner-operated brain, this step goes through Capy Workflow Improver, never to the brain's owner by hand. Nothing clears a marker automatically.
- Nothing about what counts as `comparable` changes, mirroring does not pause and no default changes.

### Known limits
- The hard-link call itself can fail (a full disk can refuse a directory entry); the record is still kept and retried, but status cannot see it until the disk takes it.
- A serving process killed before its first failed write loses the samples it had accepted but not yet written down (the count is too low, and no mismatch is hidden). If it dies while a marker exists, the marker stays and status reads no evidence until an operator deletes it.
