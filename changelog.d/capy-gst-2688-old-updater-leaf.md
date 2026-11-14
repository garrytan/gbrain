---
important: regression
---
**Upgrading from an older release (about v0.60.150 to v0.60.248) no longer ends in exit 1, and doctor no longer reports a stopped serve as a second running build.**

### Fixed
- `gbrain upgrade` run from an older release finishes with exit 0 again. Those releases load one more file from the new install into the old process after the swap, and that file pulled in code needing functions the old process didn't have, so the upgrade printed an `internal_error` and exited 1 even though the new binary and its migrations were in place. That file now loads nothing but the line it prints (GST-2688).
- `gbrain doctor`'s `runtime_build_skew` check no longer counts a process that has already exited as a running build. An older serve stopped with SIGTERM can leave its heartbeat row looking fresh for up to 30 seconds; a row whose process the check can prove is gone (same machine boot, pid gone or reused) is now skipped, while a row it can't prove dead still counts (GST-2688).
