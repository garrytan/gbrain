**On the experimental Rust engine, `gbrain apply-migrations` and `gbrain upgrade` now get past the v0.11.0 job-queue smoke check and the v0.12.2 JSON repair, as on PGLite; nothing selects the Rust engine yet, so PGLite and Postgres brains are unchanged.**

### Fixed
- On a Rust brain, the upgrade migrations lock is now a file beside the brain, as on PGLite, instead of an open connection. The open connection made the upgrade itself the brain's owner, so the v0.11.0 smoke check it starts could not reach the brain and failed with `owner_unavailable`.
- On a Rust brain, `gbrain repair-jsonb` reports nothing to repair, as on PGLite, instead of stopping with "No database URL".
