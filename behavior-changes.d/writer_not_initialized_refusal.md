---
kind: fix
---
When a brain's database has no persistence metadata row, source lifecycle changes that take the topology lock (gbrain sources add, claim, archive and the other source lifecycle commands, managed clones and worktree refreshes), the reconcile preview and the reconcile backup list and removal now refuse with writer_not_initialized and a gbrain doctor --json fix, and change nothing. Before, they failed with a TypeError that named no cause and no next step, or the backup list and the reconcile preview went on without the brain's identity until they failed the same way.
