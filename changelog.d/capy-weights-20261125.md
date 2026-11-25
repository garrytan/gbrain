**CI splits its test shards using timings from the 2026-11-25 nightly runs, so fewer test files are placed by a guessed duration.**

### For contributors
- The unit, serial and E2E shard weight maps (`scripts/test-weights.json`, `scripts/serial-weights.json`, `scripts/e2e-weights.json`) are re-mined from the scheduled Test run 45568356657 and the scheduled E2E run 45559088509. Test files with no recorded timing drop from 77 to 37 of 5,587 in the unit lane, from 5 to 2 of 487 in the serial lane and from 13 to 7 of 982 in the E2E lane.
- The heaviest unit shard is planned at 589.7 s against the 600 s shard budget. That shard holds one file, `test/setup.test.ts`, so it needs splitting or speeding up before it grows further; raising the shard count does not shrink it.
