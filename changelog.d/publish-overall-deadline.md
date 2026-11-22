---
important: regression
---
**A brain checkout whose unpushed commits hold many secret-looking values publishes again instead of holding the push lock for minutes and stopping past its budget.**

### Fixed
- Planning the redaction of unpushed commits searched every known value across the rest of each file, once per hit, so a file with many distinct values took time that grew with hits × values × file size: 1,000 values in a 2 MB file took about 40 seconds, and larger ranges ran for many minutes at full CPU while holding the push lock. It now walks each file once, with the same result.
- `--scan-timeout` (default 300 s) now bounds the whole publish: the secret scan, the redaction, the scan of the rebuilt commits and the redaction's wait for the commit lock share it, instead of each getting a fresh budget. A publish holds the push lock for at most that long plus one fetch or push already under way.
- The background retry after a managed checkout's publish runs past its budget now gets 2 times the budget (`--scan-timeout 600`, at most 10 minutes holding the push lock) instead of 4 times.
