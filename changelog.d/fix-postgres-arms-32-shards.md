**The PostgreSQL arms CI job now runs on 32 shards instead of 28, so master's Test run is green again.**

### Fixed
- Two recent changes added enough PostgreSQL arm test time that two of the 28 `unit-postgres-arms` shards went past the 570 s per-shard budget (570.4 s and 570.2 s), which failed `test/scripts/postgres-unit-arms.test.ts` on master.
- `ARM_SHARDS` in `scripts/postgres-unit-arms.ts` is now 32, and the `persistence-validation.yml` matrix, job name and `run` argument follow it. The largest shard drops to 499.6 s with both arms and 337.0 s in the Postgres-only mode. The budget and the test are unchanged.
- Check names become `Unit-lane PostgreSQL arms N/32 / Bun …`, and none of them is a required check.
