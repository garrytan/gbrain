**Shadow mode no longer loses a sampled write from its write comparison count.**

### Fixed
- A sampled write that never reached a verdict used to vanish from the write comparison count: one the shadow could not hand to its child when mirroring stopped, one still being read back when the process disconnected, and replays still queued when the shadow child hit its exit deadline. Each is now counted as uncomparable with a named reason (`send_shed`, `readback_abandoned`, `child_exit_deadline`). A lost sample can only make the swap's write check stricter, never pass it.
- The swap guide now says that above about a 0.05 write sample rate, bursts of writes only add `queue_full` (uncomparable) samples.
