**Added: the Rust engine shadow now checks privacy, reruns unclear mismatches and measures vector recall, so the swap's readiness reads real evidence.**

### Added
- Each sampled read carries the caller's access record. A Rust row the primary's own answer did not hold is checked on the primary with its read policy, by id and chunk identity only. A page the caller may not read pauses mirroring and fails readiness.
- An unexplained mismatch is rerun on both engines behind a barrier on the follow stream. A rerun that still differs is a divergence, and one that cannot run stays counted as unexplained.
- Vector recall is scored against the primary's own exact scan, at most once a minute, and appears after 30 scored samples.
- A check or a score is accepted only when the primary's write position is unchanged and no transaction in flight at the start has committed since; otherwise both engines are run again, up to three times, and a sample that keeps moving stays unresolved and counts as unexplained. Busy brains clear fewer samples.
- Nothing changes unless shadow mode is on. The comparator version is now 3, so an existing shadow opens a fresh evidence epoch.
