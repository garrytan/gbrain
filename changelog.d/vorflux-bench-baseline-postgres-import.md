**The bake-off baseline benchmark can run against Postgres on a clean install again.**

### Fixed
- `rust/bench/baseline` with `--engine postgres` loaded a `postgres` package that a clean install does not have, so it stopped before it reached the database. It now loads the repo's vendored driver (`#postgres`), like the rest of gbrain. A new test checks that the driver loads before the database name is checked, and the test connects to nothing.
