**On a Rust brain, `gbrain trust scan` now saves its progress: a scan that stops resumes where it stopped, and doctor `trust_scan` reports the same unscanned rows as on Postgres and PGLite.**

### Fixed
- On a Rust brain, `gbrain trust scan` stopped at its first step: its cursor, its check for claimed sources and its id ceilings were raw database reads the Rust engine cannot run. They are now typed engine methods every engine serves, so the scan saves its cursor after each batch and a scan that was stopped continues from it on the next run.
- On a Rust brain, doctor `trust_scan` read "no cursor" when its cursor read failed, and could report a finished scan as never started. The read is now a typed engine method, and a failure shows as a failure.
- A new Rust brain records the write gate's scan baseline, as Postgres and PGLite do, so doctor `trust_scan` does not count rows the gate already checked. A Rust brain made before this change has no baseline and gets no backfill: no released build makes a Rust brain, and shadow mode starts from builds that have this change.
- On Postgres with a linguistic collation such as en_US, `gbrain trust scan` listed the claimed sources it waits on in a different order from PGLite and Rust: it skipped hyphens when sorting. Every engine now lists them in byte order.
