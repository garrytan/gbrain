**`gbrain sync` stopped by SIGTERM or SIGHUP now records why its pass stopped.**

### Fixed
- A managed `gbrain sync` that gets SIGTERM or SIGHUP in the middle of a pass saves the pass as resumable with stop reason `terminated`, prints its result and resume command, and exits 143 (129 for SIGHUP). `gbrain sync status` reads `pass_terminated` instead of guessing `pass_interrupted`, and the drain's JSON stop reads `terminated` instead of `deadline`. A pass stopped this way that committed nothing still counts toward `pass_abandoned`. A second signal, or a save still running 3 seconds after the handler starts, exits as before. On PGLite the handler can start tens of seconds after the signal, as it already did before this change, so a supervisor that kills the process sooner leaves the pass open as today; it reads `pass_interrupted` and the plain sync resumes it. Ctrl-C and sync jobs inside `jobs work` are unchanged (GST-2869).
- On a read-only mirror, `gbrain repair file-drift --held` no longer names a `--prefer` preview for a held deleted page whose file differs either; it names `gbrain sources mirror-writable <id>` like the other mirror pages. The sync-unblock runbook's `pass_abandoned` row now says that a retry whose re-check changed the hold's code or file bytes still counts as progress once.

<!-- behavior-change: sync_sigterm_recorded_gst2869 -->
