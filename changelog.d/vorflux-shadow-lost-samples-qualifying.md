**Shadow mode no longer counts lost samples of writes it never compares against the compared-write share.**

### Fixed
- Shadow mode: when a command or `gbrain serve` exits before the shadow child reads every write sample, only the lost page and link writes (`putPage`, `deletePage`, `addLink`, `addLinksBatch`, `removeLink`) count as uncomparable `pipe_unflushed`. Lost samples of other writes, which the shadow sends as `capability_missing` anyway, now count under `capability_missing_by_family` as `pipe_unflushed_nonqualifying`. They stay counted and visible. On a synthetic workload most lost samples were other writes, so the compared share read about 1% when it was much higher.
- The same split applies when the next shadow child settles the sent count of a process that died (`receipt_orphaned` and `receipt_orphaned_nonqualifying`). Both counts are written in one append, so a failed write and its retry book each count once.
- The shadow child reads a sample's earlier-refusal count exactly as the serving process does, so a count the serving process could not read no longer hides lost page and link writes.
- A sent count written by an older version still counts every lost sample as `pipe_unflushed`, as before.
