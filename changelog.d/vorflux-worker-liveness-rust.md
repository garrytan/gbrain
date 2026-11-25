**A minion worker on a Rust brain now stays alive, and puts a claim back un-run when the pause marker appears or quiet hours begin, as it does on Postgres and PGLite.**

### Fixed
- A minion worker on a Rust brain used to stop as `db_dead` after about three health intervals, because its health probe ran raw SQL the Rust engine refuses. The probe now asks the engine's typed `pingStore`, which answers from the store on Rust and sends the same `SELECT 1` on Postgres and PGLite.
- A claim the worker handed back because the pause marker appeared after the claim, or because quiet hours began, now goes back to `delayed` on a Rust brain (one minute and fifteen minutes) with its lock cleared. Before, the raw statement was refused and the claim stayed active until its lock expired. On Postgres and PGLite the statements are unchanged.
