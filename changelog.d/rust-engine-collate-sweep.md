**On an experimental Rust brain, a Wakeshift forget queued for a member's user now waits while that member still exists, as it does on PGLite and Postgres. Before, a Rust brain queued the forget even for a live member.**

### Fixed
- `queueWakeForget` with a member id on a Rust brain reads the access member in the same write: it queues only when no member with exactly that id is still there (a disabled member counts, a removed one does not). A member id with a NUL byte is refused. PGLite and Postgres send the same SQL as before.
