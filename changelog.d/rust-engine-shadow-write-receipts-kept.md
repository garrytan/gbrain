**Shadow mode no longer reads "measured" when a lost write sample could not be written down.**

### Fixed
- When the disk was full, the shadow worker could fail to write down the samples a command had lost and also fail to write its warning line, and then still delete the record of how many samples the command sent. The samples were then in no count and no warning, and `gbrain engine shadow status` could still read "measured". The worker now deletes that record (the sent count) only after every lost sample is written down. If it cannot, the record stays and status reads "no evidence".
- A sent count that could not be read (an I/O error or a half-written file) was treated as if there were none: nothing was reconciled and nothing was said. The worker now raises one `write_samples_unrecorded` warning naming the file and leaves it in place, and status reads "no evidence" until the file is removed.
- A command wrote its sent count twice on a clean exit. The worker had already removed the first, so the second one was left behind. It is now written once, and a write that failed is tried again when the command stops.

- The shadow worker removed a command's sent count before its own last save of results, so a result that only ever reached memory (a failed save) was lost with status still reading "measured". It now removes the sent count only after that save has landed; otherwise the sent count stays and the next worker counts it.
- A sample count that only a warning line named (a command that could not publish its sent count, a client worker that could not write its count) did not stop status from reading "measured". It now reads "no evidence" for the rest of that evidence epoch.

### Changed
- `gbrain engine shadow status` counts every sent count still on disk as a replay with no verdict (so no evidence), and lists them as `outstanding_receipts`. A sent count that names another evidence epoch than the current one counts the same way (commands write none, because they cannot know which epoch their worker opens, so only a hand-written one can).
- A sent count left by a command that has died is added once, as `uncomparable` with the new reason `receipt_orphaned`, by the next shadow worker that owns the store. It may count samples that were already compared as lost as well, never fewer. Each shadow save now lists the shadow directory once to find these. A kept sent count is counted whole, so it can count more samples as lost than were lost, never fewer; and the "no evidence" from a warning line lasts for the whole epoch even if the count was written down afterwards.
- Nothing about what counts as `comparable` changes, and a lost or uncompared sample is never counted as compared.

### Known limits
- The command's own warning line, when it cannot write its sent count and the disk refuses the warning too, and a client worker's in-memory count when both writes fail, are not covered here.
