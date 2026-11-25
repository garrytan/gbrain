**Shadow mode now records its page and link write comparisons, so swap readiness criterion 5 can finally collect evidence.**

### Added
- The results of the write comparisons that shadow mode runs on a throwaway Rust store are now kept in `write-comparisons.json` beside the other shadow evidence, counted per evidence epoch. `gbrain engine shadow status` reports `write_comparisons.state` as `measured` once a comparison has a result, with its counts by outcome and by reason, and says how many replays have no result yet.
- The file is changed only under one lock shared by every shadow process, and each update adds that process's own unsaved results to what the file holds at that moment. One process can no longer overwrite a difference another process saved, a result whose save failed is kept and added later, and an epoch's totals are never restarted or lost.
- Before a replay starts, the shadow child writes its process id into an in-flight list and refuses the replay if that write fails, counting the sample `uncomparable` (`mark_unwritten`). While any replay has no recorded result, status reads no evidence and criterion 5 stays `missing` instead of passing.

### Changed
- A replay that was running when its process was killed counts as `unexplained_difference`, because it could have been a mismatch whose result was lost. This fails closed, and the cost is that a hard kill of the shadow child during a replay fails criterion 5 for that epoch.
- The write sampler and its pre-read are on again. A sampled write outside a transaction waits at most 2 seconds for one small read of the rows it touches before it runs, and a slow read lets the write go ahead untouched. About 5% of direct page and link writes are sampled (`gbrain engine shadow start --write-sample-rate <rate>` changes it).
- The status line and the swap report no longer say that comparisons are not recorded. They still say that a criterion 5 pass covers page and link writes only, and the pass rule (zero unexplained differences on at least 1,000 comparable writes) is unchanged.

### Fixed
- On a Postgres brain, the data fence now checks the origin page of a link as well as its two pages, type and source, so another process's link between the same two pages with another origin is no longer taken for the write's own link and can no longer fail criterion 5 by mistake. A link that names no origin counts as the write's own only when the stored link has none.
- A withdrawn or purged fact now also covers a `putPage` target that does not exist yet, so a new page in such a source is counted `uncomparable` on PGLite and Postgres instead of showing a false difference.
