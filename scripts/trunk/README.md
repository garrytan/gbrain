# Rust trunk push gate

These scripts gate every push to `rust-engine/main`. They are checked in so the gate the trunk owner runs can be read and rerun: `.github` is frozen, so this gate covers checks that no CI workflow runs on a trunk push.

- `trunk-push-gate.sh <sha> <base>` is the full gate. A push may go out only when `pushgate-logs/<sha>/summary.txt` ends with `GATE PASS <sha> <seconds>`. A local pre-push hook checks that line. The steps are:
  - `e2e-full-ci`: a completed, successful `e2e.yml` run on the exact sha.
  - `test-full-ci`: a completed, successful `test.yml` run on the exact sha.
  - `cargo-test`: `cargo build --workspace --locked`, `cargo clippy --all-targets --locked -- -D warnings` and `cargo test --workspace --locked`.
  - `rust-build`: the napi addon, built for this tree.
  - `parity-arm`: every `test/engine-parity/*.test.ts` file, each in its own process, on all three arms. PGLite always runs; Postgres runs with `DATABASE_URL` on a fresh database; the Rust arm runs with `GBRAIN_TEST_RUST_ARM=1` against the addon. The step stops at the first red file.
  - `unit-lane`, `e2e-selected`, `guard12` and `dupfn`.
- `trunk-docs-gate.sh <sha> <base>` gates a push that changes only docs, `changelog.d`, `TODOS.md` or the llms bundles. The base must already carry a full `GATE PASS`.
- `full-e2e-ci.sh` and `full-test-ci.sh` look up the CI run on the exact sha.
- `keys-unique.sh <worktree>` checks that every u8 key tag in `rust/crates/gbrain-store/src/keys.rs` is unique and follows the registry.
- `marker.sh` creates and checks the lock-priority marker. A marker holds a PID and an expiry, and a reader ignores it once that PID is dead or the expiry has passed.

The defaults point at the trunk owner's machine: `/var/tmp/trunk`, Postgres on `127.0.0.1:55434`. Override them with `GATE_REPO` and the variables at the top of each script.
