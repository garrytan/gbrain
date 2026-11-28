---
kind: fix
---
Shadow mode, the sampled comparison of the Rust engine against your brain, no longer counts a session's samples twice when the session record is more than 10 minutes old and its child writes its last samples while the cleanup pass runs (6 counted for 3 owed). The cleanup pass now decides which sessions are abandoned before it reads the journals. The only effect is a lower, correct count of lost writes. Nothing you run changes, and no count, reason or status text is added or renamed.
