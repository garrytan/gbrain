---
kind: fix
---
`gbrain sources writer status --json` renames each worktree's `heartbeat_at` to `owner_stamped_at`, because the column changes only when a host claims the worktree or a consumer stops cleanly, and adds `owner_live` and `owner_last_active`, which say whether the write owner is working now. A script that read `heartbeat_at` as a liveness signal should read `owner_live` and `owner_last_active` instead.
