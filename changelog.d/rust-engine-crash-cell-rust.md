**A test now kills a Rust brain in the middle of its writes, reopens it and checks that nothing acknowledged was lost.**

### Added
- A crash test for the Rust store, `scripts/rust-crash/`. It runs a seeded series of page saves, remembers, forgets and syncs in a separate process. It kills that process with SIGKILL partway through a disk write, just before or after a flush to disk, at a persistence step and between operations, then reopens the brain and compares it with a PGLite run of the same series. Every write the process acknowledged must still be there. A write that was still in flight must be either fully applied or absent, and the rest of the series must then finish with the same result.
- The Rust store has a test-only file backend that logs each disk write and flush and can stop at a chosen one so the test can kill it there. It is built only into a separate test addon (`bun run rust:build --crash-points`). The release addon does not contain it and ignores the test's environment variables, and CI checks that on every addon build.
- The `Rust engine` workflow gains a `crash-cell` job that builds the test addon and runs the crash test on Linux, and on macOS whenever the workflow runs its macOS target, and a `crash-cell-plant` job that builds the test addon with a deliberately non-durable commit and expects the test to catch it. The crash test fails when any kind of kill falls below its minimum count.
- `bun run rust:build` takes a lock for the checkout (`rust/target/.rust-build.lock`) from the cargo build through the copy, so a release build and a `--crash-points` build started together wait for each other instead of swapping outputs. A lock left by a build that died is taken over.

### Changed
- The libraries `gbrain-store` and `gbrain-sim` now forbid `unsafe` code. The `gbrain-napi` crate, the benchmark workspaces and the `keyword_scale` example in `gbrain-store` still hold `unsafe` code.
