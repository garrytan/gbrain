---
kind: fix
---
Shadow mode, the sampled comparison of the Rust engine against your brain, lost write samples when a gbrain serve session over MCP stdio took a burst of writes and its client then closed the session. The shadow child saved its count after every sample and fell behind, and the samples still waiting in the serving process were dropped at exit and counted as lost. The child now saves once per event-loop turn and keeps up, so far fewer samples are lost and more are compared. Lost samples are still counted the same way, and nothing you run changes.
