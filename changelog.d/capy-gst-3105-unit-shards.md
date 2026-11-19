**The unit tests now run on 40 shards instead of 36, so every shard fits its time budget again.**

### Changed
- CI's unit suite runs on 40 shards (20 jobs, two shards each) in `test.yml`, and the nightly coverage run in `e2e.yml` uses the same 40. The shard weights were re-measured from five complete master test runs (5,238 test files). With 36 shards the largest one was predicted at 612.7 s, over the 600 s budget; with 40 it is 571.7 s.
- From 40 shards up, the largest shard is `test/setup.test.ts` on its own, so more shards cannot make it smaller.
