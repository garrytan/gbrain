**Contributors working on the Rust engine can now set up an Ubuntu machine with one command: `scripts/dev/rust-engine-bootstrap.sh` installs the pinned Bun, Postgres 16 with pgvector, Rust and the napi-rs CLI, and prints a pass/fail line per step.**

### Added
- `scripts/dev/rust-engine-bootstrap.sh`: a non-interactive, rerunnable dev setup for Ubuntu. It installs the Bun version from `package.json`, starts Postgres 16 with pgvector and a test database, installs the Rust stable toolchain and the napi-rs CLI, runs `bun install`, and writes `~/.gbrain-rust-dev.env`. It does not change gbrain itself.
- `docs/research/rust-engine/dev-environment.md`: how to run the script, what each step does, how to run the engine parity tests, measured timings and known problems.
