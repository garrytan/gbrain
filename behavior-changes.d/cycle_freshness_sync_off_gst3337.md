---
kind: fix
---
Doctor's cycle_freshness check now lists a source with config.syncEnabled=false as sync off (not checked) instead of reporting it as never cycled, stale or failing, and never names it in its gbrain dream --source <id> fix. A check whose only stale sources have sync off reads ok. Before, a never-cycled source with sync off counted as stale, so anything acting on cycle freshness could pick it and run a dream on it.
