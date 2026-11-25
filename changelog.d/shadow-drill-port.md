**`gbrain engine shadow drill` proves a Rust shadow store can be copied and opened again, and the Rust engine swap check now reads the release's eval gates from a pinned, hash-checked file.**

### Added
- `gbrain engine shadow drill [--backup] [--evals] [--json]`: `--backup` copies the shadow's own Rust store at one committed moment while the shadow keeps following, checks the copy without opening it normally, opens it once, runs one keyword search on it, deletes the copy and records the result under the shadow directory. `--evals` downloads the final eval-gates file pinned to the release the shadow's evidence started on, checks its SHA-256 and keeps a copy. With neither flag both run. Nothing changes unless a shadow directory exists.
- Swap readiness criterion 10 reads what the drill kept, offline: a passed drill in the current evidence epoch, and eval gates E1 to E3 that are final and match the epoch's build, addon and platform. When one half is not a pass the swap prints its reason (for example `backup_drill_failed:no_probe_term`, `eval_gates_addon_mismatch`, or `backup_drill_missing` when a drill was refused before it copied anything and no earlier record exists).
- A new `eval-gates-pin` workflow attaches `gbrain-eval-gates.pin.json` to each release once gbrain-evals publishes its final eval file. The release asset check now accepts extra assets such as that pin.
- The Rust engine workflow also runs the store snapshot and shadow drill tests against the real addon.
- New error code `shadow_drill_failed`, with a `reason` that says why a drill did not run or did not pass.

### Fixed
- The drill refuses to run with an addon other than the one the evidence epoch started on, never recreates a shadow directory that `stop --delete` removed, and never passes a copy with pages unless a keyword search ran on it, and requires a hit once the copy's keyword index is complete.
