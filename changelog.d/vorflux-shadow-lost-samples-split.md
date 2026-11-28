**Shadow mode no longer counts tag and other non-page writes as uncomparable page and link writes when a sample line is cut short or a shadow worker has no evidence epoch of its own.**

### Fixed
- When a write sample line reached the shadow child cut short, every sample the line stood for was counted as an uncomparable page or link write (`line_unreadable`), even when the line was for a tag or another write the shadow never compares. Only the page and link writes in it now count as `line_unreadable`; the rest is counted as `capability_missing` under `line_unreadable_nonqualifying`, the same split the session's owed record already used.
- A shadow child that is not the store's owner, or whose evidence epoch was replaced, hands its settled samples to the owner as lost lines. Those lines did not say which samples were page and link writes, so when the session ended early the owner booked the rest of it as uncomparable `receipt_orphaned` instead of `receipt_orphaned_nonqualifying` for the non-page writes. The lines now mark each page and link write (`q: 1`), and the owner books the rest by kind.

### Changed
- Both fixes only move counts from uncomparable to capability_missing for writes that are not page or link writes; the totals do not change, and neither does the rule swap criterion 5 passes on. Lines written by an older gbrain carry no mark and are still counted the old, stricter way. `line_unreadable_nonqualifying` is a new name in the capability_missing breakdown that `gbrain engine shadow status` and the swap report show.

<!-- behavior-change: shadow_lost_samples_split -->
