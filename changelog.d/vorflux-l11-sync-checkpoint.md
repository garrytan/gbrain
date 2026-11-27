**A managed Git sync's checkpoint now has a typed engine call that a Rust brain also serves.**

### Changed
- The step that records where a managed Git sync got to (its last commit, last sync time, newest content time and slug mode) is now a typed engine call, `advanceSyncCheckpoint`, on PGLite, Postgres and Rust. It advances only a checkpoint that no other sync has moved, and reports a pinned slug mode that refused it. The managed sync switches to it in a later change.
