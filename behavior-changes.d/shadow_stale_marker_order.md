---
kind: fix
---
Shadow mode, the sampled comparison of the Rust engine against your brain, now decides which sessions are abandoned (a session record more than 10 minutes old whose session was closed or whose serving process is gone) before it reads the client journals. Before, it decided after the read, so a child that wrote its last samples between the read and the decision was counted twice (6 counted for 3 owed). The only effect is a lower, correct count of lost writes. Nothing you run changes, and no count, reason or status text is added or renamed.
