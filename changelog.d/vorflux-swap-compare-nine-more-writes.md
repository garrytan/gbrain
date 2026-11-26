**Criterion 5 of the engine swap now compares nine more page and link writes, and a write it could not compare never counts as a match.**

### Changed
- The write comparison now covers 14 writes: the five from before plus `softDeletePage`, `softDeletePages`, `refreshPageBody`, `stripStaleFrontmatterKeys`, `setEmotionalWeightBatch`, `removeLinksByPagesAndSource`, `markPagesExtractedBatch`, `markPagesAttendanceBlocked` and `setPageEmbeddingSignature`. The comparison also reads three page columns it could not see before (`links_extracted_at`, `links_attendance_blocked_revision`, `embedding_signature`).
- The swap report prints one more line under criterion 5, `writes not compared (uncomparable), by reason: ...`, when any sampled write could not be compared. Only a `comparable` write counts toward the criterion.
- The swap report and the guide name the page and link writes that are still not compared (15 of them), including `restorePage`, `purgeDeletedPages` and `sealSegmentedPage`.

### Fixed
- A sampled write whose pages could not be named (an empty batch, a page id the brain did not know, a source left out) used to read back nothing from both engines and count as a match. It is now `uncomparable` (`target_unresolved`).
- A sampled write whose pages were not in the copy, or a link removal with no link to remove, used to count as a match. It is now `uncomparable` (`target_absent`, `nothing_to_compare`). This also tightens the existing `removeLink` comparison.
- Most callers of the new writes run inside a transaction, where only `put_page` is compared, so those samples are `uncomparable` (`in_transaction`); the guide lists which.
