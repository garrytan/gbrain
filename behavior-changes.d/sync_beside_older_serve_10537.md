---
kind: fix
---
On a Postgres brain, gbrain sync no longer runs inside a live gbrain serve whose heartbeat shows an older gbrain build than the CLI. A serve keeps the code it started with, so after an upgrade its next lazy import could fail the sync with a missing-export error. The sync now runs in its own process beside that serve and prints one line naming both versions; restart the serve onto the installed build with gbrain upgrade --restart-only (add --stop-mcp for a serve an agent harness started, then reconnect gbrain there) to have syncs run inside it again. A delegated sync that still fails inside a serve on a missing export now stops with serve_build_skew and the same restart; on Postgres, GBRAIN_SYNC_NO_DELEGATE=1 runs the sync beside the serve meanwhile.
