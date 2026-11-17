**A design plan for an optional Rust storage engine is now in the docs; no code ships and nothing changes for any brain.**

### Added
- `docs/designs/RUST_ENGINE.md`: the plan for a third storage engine, written in Rust, behind the same engine contract as PGLite and Postgres. It covers the parity tests and gbrain-evals bake-off, a shadow mode that runs Rust beside an existing brain and generates a head-to-head report, an opt-in swap with a way back, and a public engine benchmark in gbrain-evals. Every switch it names ships off.
- `docs/designs/rust-engine/research/`: twelve read-only maps of the current code that the plan cites, and `docs/designs/rust-engine/review-record.md`: the review record for the plan.
