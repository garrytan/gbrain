**A test now kills a Rust brain in the middle of its writes, reopens it and checks that nothing acknowledged was lost.**

### Added
- A crash test for the Rust store, `scripts/rust-crash/`. It runs a seeded series of page saves, remembers, forgets and syncs in a separate process. It kills that process with SIGKILL partway through a disk write, just before or after a flush to disk, at a persistence step and between operations, then reopens the brain and compares it with a PGLite run of the same series. Every write the process acknowledged must still be there. A write that was still in flight must be either fully applied or absent, and the rest of the series must then finish with the same result.
- The Rust store has a test-only file backend that logs each disk write and flush and can stop at a chosen one so the test can kill it there. It is off unless `GBRAIN_TEST_RUST_CRASH_LOG` is set when a brain opens, so a normal brain opens exactly as before.
- Two CI jobs in the `Rust engine` workflow run the crash test on Linux, and on macOS whenever the workflow runs its macOS target, and a third builds the Rust addon with a deliberately non-durable commit and expects the test to catch it.

### Changed
- The libraries `gbrain-store` and `gbrain-sim` now forbid `unsafe` code. The `gbrain-napi` crate, the benchmark workspaces and the `keyword_scale` example in `gbrain-store` still hold `unsafe` code.
