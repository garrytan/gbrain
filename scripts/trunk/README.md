# Rust trunk push gate

These scripts gate every push to `rust-engine/main`. They are checked in so the gate the trunk owner runs can be read and rerun: `.github` is frozen, so this gate covers checks that no CI workflow runs on a trunk push.

- `trunk-push-gate.sh <sha> <base>` is the full gate. A push may go out only when `pushgate-logs/<sha>/summary.txt` ends with `GATE PASS <sha> <seconds>`. A local pre-push hook checks that line. The steps are:
  - `cargo-test`: `cargo build --workspace --locked`, `cargo clippy --all-targets --locked -- -D warnings` and `cargo test --workspace --locked`.
  - `rust-build`: the napi addon, built for this tree.
  - `parity-arm`: every `test/engine-parity/*.test.ts` file, each in its own process, on all three arms. PGLite always runs; Postgres runs with `DATABASE_URL` on a fresh database; the Rust arm runs with `GBRAIN_TEST_RUST_ARM=1` against the addon. The step stops at the first red file.
  - `addon-serial`: `test/rust-export.serial.test.ts`, `test/rust-jsonb-key-order.serial.test.ts` and `test/rust-vector-search-cli.serial.test.ts`, each in its own process with the addon required and no skip allowed. No workflow runs them with the addon (`docs/research/rust-test-audit-r2.md`, item 10), and `.github` is frozen until 20:30Z Nov 24. When a `rust-engine.yml` step runs them, drop this step.
  - `addon-job`: everything else the `rust-engine.yml` addon job runs with the addon (the CLI parity, token and member, MCP receipt and withdrawn-lead tests, with a receipt directory), after a check that the workflow's addon job names no test file, script or `GBRAIN_` variable the gate does not run. `parity-arm` and `addon-job` run with `TMPDIR` reached through a symlink, as macOS reaches it.
  - `unit-lane`, `e2e-selected`, `guard12` and `dupfn`.
  - `rust-engine-ci` and `rust-cli-parity-ci` (`rust-ci-green.sh <sha> <workflow>`): the `rust-engine.yml` and `rust-cli-parity.yml` workflows have a completed successful run on the exact sha; the script waits up to 3 hours for a queued run. The gate dispatches no `test.yml` or `e2e.yml` run (the CI rule of 2026-11-23).
- `trunk-docs-gate.sh <sha> <base>` gates a push that changes only docs, `changelog.d`, `TODOS.md` or the llms bundles. The base must already carry a full `GATE PASS`.
- `rust-ci-green.sh` looks up a Rust workflow run on the exact sha. `full-e2e-ci.sh` and `full-test-ci.sh` are the old lookups for `e2e.yml` and `test.yml`, no longer called by the gate.
- `keys-unique.sh <worktree>` checks that every u8 key tag in `rust/crates/gbrain-store/src/keys.rs` is unique and follows the registry.
- `marker.sh` creates and checks the lock-priority marker. A marker holds a PID and an expiry, and a reader ignores it once that PID is dead or the expiry has passed.

The defaults point at the trunk owner's machine: `/var/tmp/trunk`, Postgres on `127.0.0.1:55434`. Override them with `GATE_REPO` and the variables at the top of each script.
