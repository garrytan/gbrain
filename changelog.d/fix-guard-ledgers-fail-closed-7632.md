---
important: security
---
**A restricted Postgres write role can no longer save purged or withdrawn content again by lacking a read policy on the purge and withdrawal ledgers: the guard now refuses the write with a message naming the policy to add.**

<!-- behavior-change: guard_ledgers_fail_closed_7632 -->

### Fixed
- The seven purge and withdrawal guard triggers (facts, takes, pages, segment derivations and the derivation sweep's scope note) read their ledgers as the writing role. A role with write policies on the guarded table but no policy on the ledger read it as empty, so a purged claim, take, page or derivation could be stored again while the purge reported done, and a withdrawn fact could be saved or set active again. Each guard now refuses such a role with `writer_coordinator_required` (`unreadable_state`), the same refusal the writer fences and derived-state maintainers use, and its hint names the table and the docs/ENGINES.md recipe. The guards keep running with the writer's own rights (no SECURITY DEFINER). Migration v318 applies it to existing brains. Owners, roles that bypass row-level security and PGLite see no change. (#7632, #7659)
- Check after upgrading on Postgres: v318 can only replace a guard function the migrating role owns. One owned by another role stays fail-open, and v318 names it in a single stderr line starting `guards:`. docs/ENGINES.md ("Purge and withdrawal guards") has a query that lists the seven guards and whether each now fails closed. For any that doesn't, its owner runs `ALTER FUNCTION public.<name>() OWNER TO <the role gbrain migrates as>`, then `gbrain apply-migrations --yes` (or the next gbrain start) replaces it.
