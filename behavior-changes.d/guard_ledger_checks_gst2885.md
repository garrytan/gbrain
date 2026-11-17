---
kind: add
---
New doctor check `guard_ledger_checks` (Postgres only). It fails when a purge or withdrawal guard still lacks its ledger check, which happens when another role owned the guard at the v318 upgrade. It names the owning role and the fix. A migration run now prints a `guards:` line when it cannot re-create a guard for a reason other than another role owning it, where it used to stay silent. PGLite and brains whose guards are current see no change.
