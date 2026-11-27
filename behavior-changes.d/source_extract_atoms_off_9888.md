---
kind: add
---
New per-source switch: gbrain sources set-extract-atoms <id> off keeps that source's pages and transcripts out of provider-based atom extraction (the routine cycle, dream --drain and the autopilot auto-drain skip it) while its pages stay synced and searchable. gbrain doctor's extract_atoms_backlog check counts those pages apart (policy_excluded) instead of suggesting a drain. Every source stays on unless you turn it off.
