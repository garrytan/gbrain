**Forgetting a fact for good (`gbrain forget <id> --purge`) on a Rust brain now says up front what it still lacks, and changes nothing.**

### Changed
- On a Rust brain the purge used to record its write request and then stop partway through, on a refusal that named no owner and no date. It now checks a written list of everything the purge needs before it touches anything: it refuses first, names the first thing the Rust engine does not serve yet, who is bringing it and by when, and the brain is left exactly as it was. The same check guards `--status --continue`, which also writes. A dry run and `--match` only read, so they still run. Postgres and PGLite are not affected.
- The list covers a page stored as segments and a staged upload too, and it follows the order the purge reaches things. Every part of it now names who brings it and by when.
