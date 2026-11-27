**A second gbrain process on a Rust brain now stops `extract_atoms` before it pays for the model call.**

### Fixed
- When one gbrain process owns a Rust brain and a second process connects to it, the second process could run `extract_atoms`, pay for every model call, and then lose all the atoms, because saving them needs a transaction that the owner connection refuses. The dream cycle paid again on every run. The second process now refuses up front with `engine_capability_missing` (reason `transactions`) before the first model call, dry runs included. The process that owns the brain is unchanged and still extracts.
