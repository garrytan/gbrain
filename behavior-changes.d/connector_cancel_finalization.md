---
kind: fix
---
Cancelled managed Google syncs return their partial result and keep the checkpoint for resuming. Interrupted sweeps retain unresolved retry records and recovery state; a lost sync lease still refuses final bookkeeping.
