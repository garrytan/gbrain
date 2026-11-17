**`gbrain sync` stopped by SIGTERM or SIGHUP now records why its pass stopped.**

### Fixed
- A managed `gbrain sync` that gets SIGTERM or SIGHUP in the middle of a pass saves the pass as resumable with stop reason `terminated`, prints its result and resume command, and exits 143 (129 for SIGHUP). `gbrain sync status` reads `pass_terminated` instead of guessing `pass_interrupted`, and the drain's JSON stop reads `terminated` instead of `deadline`. A pass stopped this way that committed nothing still counts toward `pass_abandoned`. A second signal, or a save that takes longer than 3 seconds, exits as before; Ctrl-C and sync jobs inside `jobs work` are unchanged (GST-2869).

<!-- behavior-change: sync_sigterm_recorded_gst2869 -->
