**Every push to a Rust engine lane branch now runs the Rust CLI parity test.**

### Changed
- A new advisory CI workflow, `Rust CLI parity`, builds the Rust addon on Linux and runs `test/rust-cli-parity.serial.test.ts` with the addon required. It runs on every push to a `rust-engine/**` branch and on pull requests that change `src/**`, `rust/**`, the test or its install inputs. Before, lane branches never ran that test: the `Rust engine` workflow runs only on pull requests and on pushes to master, so a lane head that left a Rust `put` queued got a green run.
- Tests: `test/scripts/rust-cli-parity-workflow.test.ts` pins the new workflow's triggers, path lists, required-addon flag and command.
