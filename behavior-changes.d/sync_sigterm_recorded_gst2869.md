---
kind: fix
---
gbrain sync stopped by SIGTERM or SIGHUP during a managed pass (an outer timeout, a supervisor stop, a closed terminal) now records the stop before it exits. The pass ends resumable with stop reason terminated, the drain stops terminated, gbrain sync status reads pass_terminated with the plain sync as its next step, and the run exits 143 (129 for SIGHUP). Before, the row was left open and status read pass_interrupted. A pass stopped this way that committed nothing still counts toward pass_abandoned, as a killed pass did. A second signal, or a save that takes longer than 3 seconds, exits as before. Ctrl-C and a sync job inside jobs work are unchanged.
