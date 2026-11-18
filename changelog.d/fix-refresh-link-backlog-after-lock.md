**A managed `gbrain sources refresh` that brings in a few files now holds the checkout's refresh lock for about a second instead of minutes, and reports where its time went.**

### Fixed
- After its import, a refresh's member sync used to derive links for up to 1,000 pages of the source's stale-link backlog while the refresh still held the lock. That took minutes on a large brain, and other refreshes of the checkout failed with `refresh_in_progress` meanwhile. Now the lock covers only the pages the refresh imported. The rest of the sync's link budget (the same 1,000 pages and 5 minutes) is spent on the backlog after the lock is released, so an uncontended run drains as much as before. Only one backlog drain per source runs at a time: a refresh that finds one running skips its own. A failed drain never fails the refresh. (GST-3107)

### Added
- `gbrain sources refresh --json` reports `phase_ms` (whole milliseconds for each phase the run reached: `fetch`, `precheck`, `drain`, `merge`, `sync`, `tail`, `backlog`), `lock_held_ms` and `link_backlog` (each member's backlog drain: `drained` with `pages` and `remaining`, `skipped` or `failed`). `GBRAIN_DEBUG=1` prints the phase times on stderr.

<!-- behavior-change: refresh_link_backlog_after_lock_gst3107 -->
