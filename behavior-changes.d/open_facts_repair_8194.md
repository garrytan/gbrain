---
kind: add
---
New command: gbrain repair open-facts opens facts that were saved private before facts.default_visibility became world, so remote callers that are not the brain owner can recall them. Nothing changes until the operator runs it on the brain host: preview with gbrain repair open-facts --source <id> --created-before <ISO-8601>, then apply exactly that preview with --apply --expect <hash>. Facts on private, member or quarantined pages, withdrawn, contested, expired or superseded facts stay private and are counted by reason. Each change is recorded in ~/.gbrain/repair/open-facts/, and --undo <ledger> makes the opened facts private again (what was already read stays read).
