---
kind: fix
---
gbrain sync status --json now has an automatic_sync field. enabled is false when the source has config.syncEnabled=false (gbrain sources set-sync <id> off): autopilot's per-source cycle, the freshness loop and gbrain sync --all skip it, and only an explicit gbrain sync --source <id> syncs it. Then why says so and fix previews gbrain sources set-sync <id> on --dry-run, which is the owner's call. The plain-text status prints an automatic sync: OFF line. State, reason and next are unchanged.
