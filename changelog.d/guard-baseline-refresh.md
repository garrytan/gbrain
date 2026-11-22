**Contributors: CI's silent-failure check now catches three shapes it used to miss. Nothing you run or see changes.**

### Fixed
- The check that spots an empty fallback returned from a catch (`const rows = []; ... catch { return rows; }`) now looks at the variable the `return` can actually see. A same-named variable in an unrelated block used to hide a real empty fallback, or make a non-empty value look empty, and a catch parameter is no longer mistaken for an empty variable of the same name outside it.
- A catch that rethrows one kind of failure and then answers nothing for every other (`if (isEngineCapabilityRefusal(err)) throw err; return [];`) is now counted. It used to be skipped because any `if` before the last statement ended the check; an `if` that can answer or do other work still keeps a handler out.
- An inline opt-out with no reason (`catch { /* silent-read-ok: */ return []; }`) now fails with "needs a reason". The code after the comment used to be read as the reason, so it passed.
- `scripts/silent-read-catches-baseline.tsv` lists the 11 catches the fixed checks newly find (9 `catch_empty`, 2 `promise_catch_empty`) as known debt: 2527 sites become 2538 (`catch_empty` 1295 to 1304, `promise_catch_empty` 458 to 460, `capability_refusal_swallowed` stays 774). These are existing code, not new swallows; the fix is a typed degraded marker.
