---
kind: fix
---
A managed sync pass whose source keeps receiving commits from another writer no longer ends not_converged every time. When HEAD has moved past the newest round that finished its imports, the last round reads that round's commit again and, if everything there is settled and no write of the source is open, checkpoints that older commit. gbrain sync status then reads pass_unfinished with the new convergence.stamped_behind field (the checkpointed commit and the HEAD the pass saw), and the next plain sync imports the newer commits. Until it does, that source is never idle.
