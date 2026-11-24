**CI splits the test suite across machines using fresh run times, so far fewer new test files are packed without a measured timing and every unit shard fits its 600 s budget.**

### Changed
- The unit timing map now holds each file's median over the five newest complete master test runs. A map taken from the 2026-11-23 nightly run alone put all 40 unit shards at 621 s, over the 600 s budget; with the medians the largest shard is 571 s.
- The serial and end-to-end timing maps are re-measured from the 2026-11-23 nightly runs.
- Test files with no measured timing drop from 96 to 10 of 5,477 in the unit group, from 4 to 1 of 483 in the serial group and from 16 to 12 of 973 in the end-to-end group.
