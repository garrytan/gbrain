**The nightly race hunt plans with measured times and always runs every listed PostgreSQL test first, so a change to a widely used test helper no longer leaves listed tests unrun.**

### Fixed
- `scripts/stress/iteration-weights.json` is re-measured from the 24 race-hunt shards of the 2026-11-19 nightly (1,024 files). The planner had expected 1,320 runner-minutes for that night, and the shards took 905 including setup; the new estimate for the same work is 1,040.
- When the 3-iteration floor fills, the files listed in `test/postgres-unit-arms.txt` are scheduled before the importers of changed helpers. On 2026-11-19, six changed helpers added 1,078 importers, the floor filled in alphabetical order, and 193 listed files never ran. Replayed with this change, every listed file runs; 24 importers still don't fit and fail the job by name, as before.
