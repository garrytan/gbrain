---
kind: fix
---
A managed gbrain sources refresh now holds the checkout's refresh lock only for its own import and the links of the pages it imported. The stale-link backlog that its member syncs used to derive under the lock (up to 1,000 pages per run) is now derived after the lock is released, with the same page cap and time budget. Other refreshes of the checkout stop failing with refresh_in_progress while that backlog drains. The --json result adds phase_ms, lock_held_ms and link_backlog.
