---
kind: fix
---
gbrain dream and autopilot-cycle jobs now skip the sync phase of a source with config.syncEnabled=false (gbrain sources set-sync <id> off), reporting it as skipped with reason sync_disabled. Before, the cycle's sync phase synced it anyway, so gbrain dream --source <id> (the fix doctor's cycle_freshness check names) pulled and wrote a source whose sync was off, a Google source's paused contacts re-list included. Only an explicit gbrain sync --source <id> syncs such a source now. The cycle's other phases are unchanged.
