**Contributors: CI's silent-failure check now also catches two shapes it used to miss. Nothing you run or see changes.**

### Fixed
- The check that flags a database read whose failure is turned into a quiet default for a Rust brain now sees a raw-SQL call reached through a promise that a callback hands back (for example a transaction callback returning `Promise.all(...)`), and a fallback returned from a loop, `switch` or block before the refusal is rethrown. Both used to slip through. It also stops flagging one handler (`withDrainLease`) whose only fire-and-forget raw calls already carry their own `.catch`.
- The check that spots an empty fallback returned from a catch (`const rows = []; ... catch { return rows; }`) now looks at the variable the `return` can actually see. A same-named variable in an unrelated block used to hide a real empty fallback, or make a non-empty value look empty.
- `scripts/silent-read-catches-baseline.tsv` lists the 7 catches the fixed check newly finds as known debt and drops one it no longer counts. These are existing code, not new swallows; each row's fix is `rethrowCapabilityRefusal(err)`.
