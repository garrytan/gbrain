# Rust trunk push gate

These scripts gate every push to `rust-engine/main`. They are checked in so the gate the trunk owner runs can be read and rerun: `.github` is frozen, so this gate covers checks that no CI workflow runs on a trunk push.

- `trunk-push-gate.sh <sha> <base>` is the full gate. A push may go out only when `pushgate-logs/<sha>/summary.txt` ends with `GATE PASS <sha> <seconds>`. A local pre-push hook checks that line. The steps are:
  - `e2e-full-ci`: a completed, successful `e2e.yml` run on the exact sha.
  - `test-full-ci`: a completed, successful `test.yml` run on the exact sha.
  - `cargo-test`: `cargo build --workspace --locked`, `cargo clippy --all-targets --locked -- -D warnings` and `cargo test --workspace --locked`.
  - `rust-build`: the napi addon, built for this tree.
  - `parity-arm`: every `test/engine-parity/*.test.ts` file, each in its own process, on all three arms. PGLite always runs; Postgres runs with `DATABASE_URL` on a fresh database; the Rust arm runs with `GBRAIN_TEST_RUST_ARM=1` against the addon. The step stops at the first red file. It runs with `TMPDIR` set to a symlink to a real folder (macOS reaches its temp folder through `/var` -> `/private/var`, and two tests broke only there); the folder is removed when the step ends.
  - `addon-serial`: `test/rust-export.serial.test.ts`, `test/rust-jsonb-key-order.serial.test.ts` and `test/rust-vector-search-cli.serial.test.ts`, each in its own process with the addon required and no skip allowed. No workflow runs them with the addon (`docs/research/rust-test-audit-r2.md`, item 10), and `.github` is frozen until 20:30Z Nov 24. When a `rust-engine.yml` step runs them, drop this step.
  - `addon-job`: the rest of what the `rust-engine.yml` addon job runs with the addon: `test/rust-cli-parity.serial.test.ts`, then `test/rust-engine-withdrawn-lead.test.ts` through `scripts/run-with-receipt.sh`, then `scripts/require-executed-tests.ts rust-store`. It runs with the same symlinked `TMPDIR`. First it reads the addon job out of the checked-out `rust-engine.yml` and goes red if that job names a test file, a script or a `GBRAIN_` variable the gate does not know, so the gate cannot fall behind the workflow again.
  - `unit-lane`, `e2e-selected`, `guard12` and `dupfn`.
- `trunk-docs-gate.sh <sha> <base>` gates a push that changes only docs, `changelog.d`, `TODOS.md` or the llms bundles. The base must already carry a full `GATE PASS`.
- `full-e2e-ci.sh` and `full-test-ci.sh` look up the CI run on the exact sha.
- `keys-unique.sh <worktree>` checks that every u8 key tag in `rust/crates/gbrain-store/src/keys.rs` is unique and follows the registry.
- `marker.sh` creates and checks the lock-priority marker. A marker holds a PID and an expiry, and a reader ignores it once that PID is dead or the expiry has passed.

The defaults point at the trunk owner's machine: `/var/tmp/trunk`, Postgres on `127.0.0.1:55434`. Override them with `GATE_REPO` and the variables at the top of each script.
