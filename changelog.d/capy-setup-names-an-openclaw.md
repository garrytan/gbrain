**When an OpenClaw command hangs during `gbrain setup openclaw`, the error now says it timed out instead of quoting whatever the command last printed.**

### Fixed
- `gbrain setup openclaw` gives each `openclaw` call 120 seconds. A call stopped at that limit now ends its error line with "timed out after 120 s", so a stalled install, enable or inspect step reads as a stall to rerun and not as a broken command. The skill-resolver plugin and the per-turn rule plugin share this one runner.
- The real-gateway skill-resolver test prints setup's JSON output when setup fails, so a failed nightly run names the refused step and command.
