**Shadow mode no longer lets a cleanup worker from a replaced evidence epoch delete the new epoch's lost-window file.**

### Fixed
- When a shadow session crashes while a window of samples is open, the worker books the loss and leaves a small file (`write-owed.window-lost-<session>.json`) that keeps an older gbrain, reading the same folder, from reading that epoch as measured. If the epoch changed while a worker of the previous epoch was partway through its cleanup pass, that worker could delete the new epoch's file, and an older gbrain then read the write comparison as measured and passed swap criterion 5 although samples were lost. The cleanup now reads the epoch again under the lock it already holds and removes nothing when the epoch has moved. This build's own status always read the epoch as not measured; only an older gbrain sharing the folder was affected. Nothing a status page or the swap check counts changes.
- While a crashed session's samples are being settled, an I/O error reading its record stamped the settling worker's own process on the lost-window file instead of the session's serving process, which could let that file be removed too early. The settle now fails and is retried on the next save.

### Changed
- The pass that settles a crashed session's owed samples now does nothing for that round when one of its journals cannot be read, and runs again on its next turn. Before, it booked the owed count from the session's marker as if the journal were empty and the later fold counted the same samples again (6 counted for 3 owed). The only effect is a lower, correct count; no count, reason or status text is added or renamed.
- The same pass now decides which crashed sessions' children are gone before it reads their journals. Before, a child that wrote its last samples and exited between those two steps had its samples counted twice (6 counted for 3 owed). The only effect is a lower, correct count.

<!-- behavior-change: shadow_stale_blocker_epoch_guard -->
