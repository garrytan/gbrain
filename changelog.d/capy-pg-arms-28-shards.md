**The PostgreSQL test lane runs on 28 shards, so new test files no longer push it past its time budget.**

### Changed
- `scripts/postgres-unit-arms.ts`: `ARM_SHARDS` 28. In `.github/workflows/persistence-validation.yml`, the `unit-postgres-arms` matrix, job name and `run` argument follow it (pinned by `test/scripts/postgres-unit-arms.test.ts`, whose 570 s budget is unchanged). `scripts/postgres-arm-weights.json` is re-mined from the arms jobs of the five newest complete full runs, so every listed file has a measured weight. The largest shard drops from 554.9 s on 24 shards to 476.3 s on 28. Check names become `Unit-lane PostgreSQL arms N/28 / Bun …`, and none of them is a required check.
