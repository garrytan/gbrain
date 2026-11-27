**Shadow mode now compares writes made through the database handle inside a transaction, and keeps a transaction's calls in order beside a nested transaction that is still running.**

### Fixed
- Inside a transaction that shadow mode follows, a write made through the transaction's database handle, including raw statements, statements with interpolated fragments, prepared and cursor-style calls, and typed values, used to slip past the comparison. They now go through the same path as every other write, so they count toward the Rust swap check. Nothing to do on upgrade.
- When a nested transaction is still running, a sampled call of the outer transaction no longer jumps ahead of the calls that came before it. The follower waits for the nested transaction first, for at most 2 seconds, and holds the later calls of the outer transaction meanwhile. The cost is a write stall of up to 2 seconds beside a nested transaction that is still running while shadow mode is on.
- Rebuilding the vector index now runs its statements through the transaction's own raw-statement path, so shadow mode sees them.
