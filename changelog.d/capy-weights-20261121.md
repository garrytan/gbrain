**CI splits tests across machines using last night's timings, so far fewer new test files run without a measured timing.**

### Changed
- Re-measured all three test timing maps (unit, serial and end-to-end) that CI uses to balance test shards, from the 2026-11-22 nightly runs. Test files with no measured timing drop from 93 to 25 in the unit lane, 1 to 0 in serial and 15 to 6 in end-to-end, and every unit shard still fits its 600 s budget.
