**Storage engines now report what they can do as a set of named capabilities, so code can ask for a capability instead of checking which engine it runs on.**

### Changed
- `BrainEngine.capabilities` is a read-only set of named capabilities (`raw_sql`, `persistence_journal`, `minion_queue`, `access_control`, `belief_ledger`, `single_owner`, `postgres_admin`, and one per storage domain). PGLite and Postgres report everything they support today, so nothing is refused and no behavior changes. `src/core/engine-capabilities.ts` holds the list and the table of what each operation, command, cycle phase and job handler needs; a name without a row needs raw SQL. Groundwork for the optional Rust engine (https://github.com/garrytan/gbrain/pull/9593, "PR sequence" step 5).
