**A Rust engine shadow seed of a large brain can now be given more time, and a seed that stopped can start over with one command.**

### Added
- `gbrain engine shadow seed` takes `--budget-minutes <n>` (or `GBRAIN_SHADOW_SEED_BUDGET_MINUTES`; `0` or `none` means no limit) and `--batch-rows <n>`. The defaults stay 30 minutes and 500 rows. Before, a seed that ran past 30 minutes always stopped, so a brain too large to copy in 30 minutes could not be seeded.
- `gbrain engine shadow seed --restart` deletes the partial Rust store that a stopped seed left and seeds again from the start. Before, every rerun refused that store and the only way back was `gbrain engine shadow stop --delete`. It refuses a finished seed, a store another process holds and a store path that is a symbolic link. A seed still never resumes part-way, because every row it copies must come from one snapshot of the brain.

### Changed
- When a seed runs past its budget, the message names the flag that raises it and the `--restart` command to run.
