**On a Rust brain, `gbrain doctor` now reports pages written database-only to an unbound source and the Git checkouts bound to this host, instead of reporting them empty.**

### Fixed
- The doctor's `unbound_source` check read an answer that was always empty on the Rust engine, even when pages were marked database-only. The Rust engine now counts those pages per source, in byte order of the source id.
- The doctor's `foreign_writers` check read the host's bound checkouts and the pending Git effects with raw SQL. It hid the refusal, so on a Rust brain it skipped the bound checkouts without saying so. Both reads are now typed engine reads; PGLite and Postgres send the same SQL as before.
