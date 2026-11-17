**Cancelled Google syncs preserve their partial progress and retry state.**

### Fixed

- Cancelled Google syncs return their partial result and keep the checkpoint for the next run. Interrupted sweeps retain retry and recovery records, and a lost sync lease still refuses final bookkeeping.

<!-- behavior-change: connector_cancel_finalization -->
