**On the Rust engine, the page purge's receipt now checks every store it keeps for what the purge left behind.**

### Added
- The Rust engine answers the receipt's store probes: the pages, facts, proposals, loops, aliases, eval candidates, files and write-gate holds still filed under the purged slug; the page's chunks, versions, takes and timeline entries; the review and trust proposals that name its facts; other requests, segment texts and queued effects that still carry its text. A store the Rust engine keeps no rows of reports none. The purge itself (`delete_page --purge`) still stops on the Rust engine at its remaining raw SQL and receipt reads.

### Changed
- The probes the receipt of a fact purge runs by fingerprint and by claim text still stop on the Rust engine, naming the probe.
