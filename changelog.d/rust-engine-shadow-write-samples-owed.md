**Shadow status can no longer read "measured" while a sampled write is unaccounted for, whatever kills a worker.**

### Fixed
- After a host crash, a killed shadow worker, a worker whose results could not be saved, or a disk that stopped taking writes, `gbrain engine shadow status` could read "measured" while some sampled writes were in no count. The proof that nothing was missing (a sent count, a warning line) was not tied to the results it vouched for. Each session now has a durable record of how many samples were handed to its worker, written before any of them is sent, and the worker settles each sample in the same atomic write as the count it adds. Status reads "measured" only when, for every session, nothing owed is unsettled; a session with nothing in flight blocks nothing, so a long-running brain still reads "measured" between samples.
- A worker whose evidence epoch was replaced by a newer worker's no longer leaves its session blocked for as long as it runs: its results are handed to the new owner as lost lines that name the session.
- A shadow save that had landed in the file but not on disk (its directory flush failed) could be reported as saved at the next try without ever being flushed. It is now flushed first.
- A write line the worker could not read is counted once as `uncomparable` (`line_unreadable`), so it cannot hold its session open.

### Changed
- A sent count (`write-sent.*`) is replaced by an owed record (`write-owed.<session>.json`). `gbrain engine shadow status --json` lists unsettled sessions as `outstanding_sessions` (at most 8) and counts each once in `unresolved_replays`. Receipts, warning lines and lost lines with no session from an older version are still read, and read as no evidence for the epoch.
- A session whose worker is gone (it was seen to exit, its process is not running, or its record is closed or abandoned for more than 10 minutes) is settled by the next shadow worker that owns the store: what it never settled is added once as `uncomparable` with reason `receipt_orphaned`. A worker whose saves keep failing for 60 seconds while it holds results it could not save exits, and its replacement books them. A client or replaced worker writes its lost lines at most every 2 seconds, not once per 256 results.
- `gbrain engine swap --to rust --plan` waits up to 60 seconds for a moment when every sample is settled and takes the first such read; if there is none, criterion 5 reads "brain busy: no 60 s lull with all samples settled; retry when idle". The worker keeps up only below about 19 samples a second on the machine this was measured on, so a brain that writes faster than that never has such a moment, and a long sync-import holds the check closed until it finishes.
- A new nullable column `write_protocol` on `engine_writer_observations` records which build wrote each writer row (this build writes 2). The swap's writer check (criterion 11) counts a row in the current evidence epoch with no value, or a lower one, as an unknown write path and refuses. No row is rewritten and nothing is backfilled. On a brain where the migration has not run, the check cannot read the evidence and the swap refuses.
- The shadow comparator version is bumped, so the next shadow worker opens a new evidence epoch; shadow days restart for brains running this build.
- Nothing about what counts as `comparable` changes, and a lost or uncompared sample is never counted as compared. The comparison bar and the sampling defaults are unchanged.

### Known limits
- A serving process that is killed outright loses the samples it had accepted but not yet handed to the pipe: the count is too low, and no mismatch is hidden.
- A reused process number can hold a session open for up to 10 minutes.
- A worker that dies in the middle of a replay counts that one sample twice, never fewer.
