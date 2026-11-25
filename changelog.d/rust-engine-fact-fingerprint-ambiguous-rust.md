**The checks that a purge or a withdrawal of one spelling of a claim never reaches a look-alike spelling now also run against the Rust engine.**

### Tests
- The parity cases for the withdrawal guard and the fact, fence-row and take purge guards no longer insert or read rows with raw SQL. They seed the purge tombstones through the typed purge writes and read the facts back through the typed fact list. So they now run on the Rust engine too, which gives the same answers as PGLite and Postgres. Engine behavior does not change.
