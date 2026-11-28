**Shadow mode reduces write-sample loss caused by per-sample tally saves when an MCP stdio `gbrain serve` session closes after a burst of writes.**

### Fixed
- With shadow write sampling on, the shadow child saved its write tally to disk after every sample (about 6 ms each), so it read far fewer samples a second than a burst of remote writes produced. The rest waited in the serving process, which dropped them when its client closed the session; status counted them as lost (`pipe_unflushed`, `pipe_unflushed_nonqualifying`). The child now saves once per event-loop turn and keeps up; in bursts of up to 1,000 page writes, nothing was left to drop at exit. Lost samples are still counted the same way, and nothing you run changes.

<!-- behavior-change: shadow_child_tally_per_turn -->
