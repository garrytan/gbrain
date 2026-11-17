---
kind: fix
---
A gbrain sources refresh whose process is gone and whose row has stayed in syncing for a whole refresh sync budget (sources.refresh_sync_budget_ms, 5 minutes by default) is now completed by the owner on its own, the way a refresh whose budget runs out completes with members still behind. Writes to its sources stop being refused with worktree_refreshing, the row records completed_by owner_reclaim and lists the lagging sources in sync_deferred, and each of those catches up on its next sync. Before, such a row refused every write to the checkout until someone ran gbrain sources refresh. A refresh whose process is still running is never touched.
