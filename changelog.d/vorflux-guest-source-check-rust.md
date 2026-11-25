**On a Rust brain, `gbrain guests grant-owner-clients` now stops with a refusal that names what is missing (guest-source records), not a raw-SQL refusal.**

### Changed
- The command's guest-source check is a typed engine member, `hasGuestSourceRow`. PGLite and Postgres send the same statement as before, so their output does not change.
- A Rust brain keeps no guest-source records yet, so it refuses the check with `engine_capability_missing` (capability `guest_sources`). As before, it writes nothing and grants nothing. Blast radius: guests grant-owner-clients still refuses on a Rust brain, now with a typed guest_sources refusal (a named loss until Rust stores guest sources).
- Tests: `test/engine-parity/guests-grant-owner-clients.test.ts` checks a guest source and a source that is not a guest source on every engine arm, including the Rust refusal and the CLI's stderr and exit code for it.
