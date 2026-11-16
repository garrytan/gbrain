---
kind: fix
---
gbrain setup claude-code no longer exits 1 with turn_hook_not_loaded on a re-run, and doctor's harness_wiring no longer warns that the per-turn hook is missing, when Claude Code has rewritten ~/.claude/settings.json and dropped the _gbrain key from gbrain's hook entries. The check now recognises a hook entry that gbrain setup wrote (its setup receipt owns the entry) with or without that key. Nothing to do after upgrading; if you saw the warning, your hook was already working.
