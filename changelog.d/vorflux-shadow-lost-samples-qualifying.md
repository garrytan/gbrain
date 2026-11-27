**Shadow mode no longer counts lost samples of writes it never compares against the compared-write share.**

### Fixed
- Shadow mode: when a command or `gbrain serve` exits before the shadow child reads every write sample, only the lost page and link writes (`putPage`, `deletePage`, `addLink`, `addLinksBatch`, `removeLink`) count as uncomparable `pipe_unflushed`. Lost samples of other writes, which the shadow sends as `capability_missing` anyway, now count under `capability_missing_by_family` as `pipe_unflushed_nonqualifying`. They stay counted, visible and settled. On a synthetic workload most lost samples were other writes, so the compared share read about 1% when it was much higher.
- The owed record a command writes now also states how many owed samples were page and link writes (`owed_qualifying`), and the write tally keeps the part of each session's settled count that was (`settled_qualifying`, in the same save). When the next shadow child settles a gone session, it splits the unsettled samples the same way (`receipt_orphaned` and `receipt_orphaned_nonqualifying`).
- An owed record written by an older version still counts every lost sample as `pipe_unflushed`, as before.
