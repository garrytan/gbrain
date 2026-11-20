**Contributors: CI now fails a change that adds a database read whose failure answers "nothing found" or "ok". Nothing you run or see changes.**

### Added
- `bun run check:silent-read-catches` (part of `bun run verify`) counts every `catch` and `.catch(...)` around a read whose handler answers `[]`, `{}`, null, 0, false, "ok" or an empty Map or Set, per function. A new one fails CI with the fix: return a typed degraded marker, use `checkError` in a doctor check, or write `// silent-read-ok: <reason>` where an empty answer is truly right.
- The existing sites are listed in `scripts/silent-read-catches-baseline.tsv`, each audited one with its finding; the counts only fall as each fix removes its row.
- docs/ci-guards.md explains the guard and how to add a rule.
