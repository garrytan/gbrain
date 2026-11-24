### For contributors
- The concurrency benchmark's lockfile (rust/concurrency-bench/Cargo.lock) moves the `url` crate from 2.5.8 to 2.5.9, which fixes RUSTSEC-2026-0592, so osv-scan passes again on every pull request. The same update brings `form_urlencoded` to 1.2.3 and adds the `sha2` dependency line the lockfile was missing.
