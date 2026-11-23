**The rest of the Rust storage engine's code is now on master, and nothing selects it yet.**

### Added
- The Rust store crate's remaining modules (access members, rules and tokens, OAuth clients, generations, session state, repair scans, shared-skill catalog and the others), the `gbrain-napi` addon crate with its smoke cases, the store's tests and benches, and the design docs under `rust/docs`. Every file under `rust/` is the Rust trunk's version.

### Fixed
- Ten Rust documentation files now match the code: the `Brain.open` options and the `page_ambiguous` error in `rust/README.md`, the store format number (5, not 1) in five store docs, the compact projection-job encoding, the write receipts that pages, versions, facts and takes carry, and the keyword index follow-up.

### For contributors
- No brain behaves differently after this lands: the default engines are unchanged and the Rust engine stays unselectable until the TypeScript adapter lands.
