---
important: data-loss
---
**Repairs keep a page's safety flag or quarantine, `gbrain facts relink` keeps a fact's origin and exact dates, and consolidate no longer ends a fact because it was said again.**

### Fixed
- `gbrain repair rows-behind` and the other managed file repairs no longer strip the write gate's `instruction_like` flag or quarantine from a page. A repair now publishes through the same write gate a sync of those bytes runs, with the file's path, so an owner allow rule scoped to that path holds during a repair as it does during sync. Rows-behind and overwritten-edits comparisons ignore those database-only markers, so a flagged page is no longer reported behind its own file. Under `write_gate.external_mode=reject`, a repair of external instruction-like content now refuses with `write_gate_rejected`, as sync already holds that file, and the refusal names `gbrain trust allow --source <id> --uri-prefix <path>` (#9511).
- `gbrain facts relink` no longer re-stamps a fact's trust tier and write origin with the relink request, and no longer rounds its `valid_from` and `valid_until` to the second. The page's facts table carries the stored instant to the millisecond, so the page projection writes the same instant back. A fact stored finer than a millisecond is left unlinked and counted `claim_unfenceable` instead of being rounded (#9260).
- The upkeep consolidate step no longer ends a fact at the next copy of the same claim. A fact now ends at the next fact in its cluster that says something else, by claim text and typed value, so a restated value stays active from the date it was first stated, every copy ends together when the value changes, and a typed metric whose value changed under the same wording still ends the older value. Facts consolidated before this release keep the dates they have.

<!-- behavior-change: repair_write_gate_markers_9511 -->
<!-- behavior-change: relink_keeps_fact_instant_9260 -->
<!-- behavior-change: consolidate_restatement_stays_open -->
