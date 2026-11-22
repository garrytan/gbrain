**The benchmark crate no longer pins a `url` version with a known advisory (RUSTSEC-2026-0592).**

### Fixed
- `rust/bench/Cargo.lock` moves `url` from 2.5.8 to 2.5.9, the release that fixes RUSTSEC-2026-0592, and `form_urlencoded` from 1.2.2 to 1.2.3, which `url` 2.5.9 requires. The benchmark crate is not part of any shipped build, so installed gbrain is unaffected; the change clears the dependency scanner's finding.
