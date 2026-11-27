### For contributors
- The Rust design doc now lists the parity cases that test a SQL-only path (Postgres function overloads, a dropped Postgres trigger, and the purge's raw-only tables) as named permanent losses, with what a Rust brain does instead. Each listed case points to its row, and a new test fails when a row names a case that no longer exists.
