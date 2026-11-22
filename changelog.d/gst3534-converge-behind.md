**A managed sync now finishes while another writer keeps committing: it checkpoints the newest commit it fully settled, and the next sync imports the rest.**

### Fixed
- A managed sync pass whose source got a new commit before every round no longer ends `not_converged` every time. When HEAD has moved past the newest round that finished its imports, the last round reads that round's commit again; if every path there is settled and no write of the source is open, it checkpoints that commit. `gbrain sync status` reads `pass_unfinished` with `convergence.stamped_behind` (the commit and the HEAD the pass saw) until the next plain sync imports the newer commits, and until then the source is never idle, even paused under `sync.admission=classify_only` or with HEAD reset to that commit. (GST-3534)

<!-- behavior-change: sync_stamp_behind_gst3534 -->
