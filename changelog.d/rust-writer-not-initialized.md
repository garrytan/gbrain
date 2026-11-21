- A brain whose database has no persistence metadata row now gets a clear refusal from source topology changes, the reconcile preview and the reconcile backup list: writer_not_initialized, with gbrain doctor --json as the next step, and nothing changed. Before, these commands failed with a TypeError. A parity test pins the refusal on PGLite, Postgres and the Rust engine.

<!-- behavior-change: writer_not_initialized_refusal -->
