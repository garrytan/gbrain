---
kind: fix
---
gbrain access rule migrate now stops at once and writes nothing when it runs in a process that does not own the brain, as on a Rust brain or when another process owns the brain. Before, it recorded the start of the migration and could commit the policy files, then failed at the store switch, and the unfinished migration blocked a move in the other direction.
