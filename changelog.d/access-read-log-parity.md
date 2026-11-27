**`gbrain access log` and `gbrain access who-read` are now tested to give the same answers on PGLite, Postgres and the Rust engine.**

### Changed
- A new three-engine test writes a batch of member reads and checks that `gbrain access log` and `gbrain access who-read` list them in the same order, with the same member, window, source and limit filters and the same per-reader tally, and that the retention prune deletes by age first and then keeps only the newest rows. A second test checks that a read command whose engine refuses the read stops on the refusal instead of printing an empty list. No behavior changes.
