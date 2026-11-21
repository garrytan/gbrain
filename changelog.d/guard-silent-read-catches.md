**Contributors: CI now fails a change that adds a database read whose failure answers "nothing found" or "ok". Nothing you run or see changes.**

### Added
- `bun run check:silent-read-catches` (part of `bun run verify`) counts every `catch` and `.catch(...)` around a read whose handler answers `[]`, `{}`, null, 0, false, "ok" or an empty Map or Set, per function. A new one fails CI, and the fix is to return a typed degraded marker, use `checkError` in a doctor check, or write `// silent-read-ok: <reason>` where an empty answer is truly right.
- The same check counts each `try`/`catch` and inline `.catch(fn)` around a raw-SQL engine call (directly or inside a callback the try awaits) that can fall back before it rethrows a capability refusal, so a Rust brain's "I cannot run this" is not turned into a quiet default. A new one fails CI; the fix is `rethrowCapabilityRefusal(err)` first, or `// capability-refusal-ok: <reason>`.
- The existing sites are listed in `scripts/silent-read-catches-baseline.tsv`, each audited one with its finding; the counts only fall as each fix removes its row.
- docs/ci-guards.md explains the guard and how to add a rule.
