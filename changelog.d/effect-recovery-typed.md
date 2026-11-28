**`gbrain engine swap --plan` no longer warns that a managed brain on the Rust engine cannot retry a failing Git commit or push: it can, and the tests now prove it on every engine with no stand-in.**

### Changed
- The engine swap plan for a managed brain keeps its `managed_known_losses` field, but the list is now empty. The one loss it named (a failing Git effect on a Rust brain refused raw SQL) was already fixed by the typed recovery read; the plan text was stale.
- Tests: the Git hold parity cases run on the Rust engine with no stand-in for the recovery read, and a new parity case shows that a Git effect that holds a recovery record is retried with its record kept, never counted toward parking.
