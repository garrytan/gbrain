**Criterion 5 of the engine swap now compares nine more page and link writes, and a write it could not compare never counts as a match.**

### Changed
- The write comparison now covers 14 writes: the five from before plus `softDeletePage`, `softDeletePages`, `refreshPageBody`, `stripStaleFrontmatterKeys`, `setEmotionalWeightBatch`, `removeLinksByPagesAndSource`, `markPagesExtractedBatch`, `markPagesAttendanceBlocked` and `setPageEmbeddingSignature`. Each of them counts toward criterion 5 like the first five. The comparison also reads three page columns it could not see before (`links_extracted_at`, `links_attendance_blocked_revision`, `embedding_signature`).
- The swap report and the guide name the page and link writes that are still not compared (15 of them, down from 24), including `restorePage`, `purgeDeletedPages` and `sealSegmentedPage`.
- The shadow evidence starts a new epoch (adapter version 13): comparisons counted under the old rules no longer count, so criterion 5 counts again from zero after the upgrade.
- While shadow mode runs, a sampled write of the nine new kinds does one more read before it saves, as the first five already did, so that save is a little slower.

### Fixed
- A sampled write whose pages could not be named (an empty batch, a page id the brain did not know, a source left out) used to read back nothing from both engines and count as a match. It is now `uncomparable`, with the new reason `target_unresolved`.
- A sampled write whose pages were not in the copy, or a link removal with no link to remove, used to count as a match. It is now `uncomparable` (`target_absent`, or the new reason `nothing_to_compare`). This also tightens the existing `removeLink` comparison: a removeLink that removes nothing is booked uncomparable (nothing_to_compare), not as a match; this lowers the compared-write count toward the bar. Both new reasons are uncomparable only: they never count as a match and never count toward criterion 5.
