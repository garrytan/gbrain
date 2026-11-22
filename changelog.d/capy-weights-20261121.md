**CI splits tests across machines using last night's timings, so newer test files no longer run without a timing estimate.**

### Changed
- Re-measured all three test timing maps (unit, serial and end-to-end) that CI uses to balance test shards, from the 2026-11-22 nightly runs. Test files with no timing drop from 60 to 25 in the unit lane, 1 to 0 in serial and 9 to 6 in end-to-end, and every unit shard still fits its 600 s budget.
