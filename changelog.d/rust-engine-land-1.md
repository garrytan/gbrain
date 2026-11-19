**The Rust engine's store now serves contradiction, dream, raw-file and code-edge reads and writes instead of refusing them.**

Nothing selects the Rust engine yet. No default path (PGLite, Postgres) loads this code, and nothing outside the Rust engine's own files imports it. It is the first of several Rust-engine landings.

### Added
- The Rust store gains the contradictions, dream, raw-file and code-edge domains with their `store-members` TypeScript members. 18 `BrainEngine` members in `test/engine-parity/coverage.tsv` go from refusing to serving.
- The Rust store also gains a job queue with spend log, OAuth clients and synthesis completions, telemetry, chat and field usage, wanted links and write guards. These have Rust tests but no TypeScript member yet, so nothing calls them.

### Fixed
- In the Rust job queue, a NUL byte in a queue name or in a spend `client_id` or `budget_key` is refused instead of letting another queue claim the job or another owner count its spend.
- A child job whose token totals would overflow its parent's integer range now refuses to complete instead of wrapping the parent's total.
