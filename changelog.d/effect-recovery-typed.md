**`gbrain engine swap --plan` now names the two real gaps a managed brain has on the Rust engine, and no longer warns about a failing Git commit or push, which a Rust brain retries like any other engine.**

### Changed
- The engine swap plan for a managed brain lists two known losses on the Rust engine: removing a page can stop before it commits, and a write on a rooted source no writer has claimed can stop after it claims the source, leaving it claimed with no write. The old entry (a failing Git effect refused raw SQL) is gone; the typed recovery read already fixed it.
- Tests: the Git hold parity cases run on the Rust engine with no stand-in for the recovery read, and a new parity case shows that a Git effect that holds a recovery record is retried with its record kept, never counted toward parking.
