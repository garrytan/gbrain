**Contributors: CI's silent-failure check now catches two shapes it used to miss. Nothing you run or see changes.**

### Fixed
- A catch that rethrows one kind of failure and then answers nothing for every other (`if (isEngineCapabilityRefusal(err)) throw err; return [];`) is now counted. It used to be skipped because any `if` before the last statement ended the check; an `if` that can answer or do other work still keeps a handler out.
- An inline opt-out with no reason (`catch { /* silent-read-ok: */ return []; }`) now fails with "needs a reason". The code after the comment used to be read as the reason, so it passed.
- `scripts/silent-read-catches-baseline.tsv` lists the 11 catches the fixed check newly finds (9 `catch_empty`, 2 `promise_catch_empty`) as known debt: 2527 sites become 2538 (`catch_empty` 1295 to 1304, `promise_catch_empty` 458 to 460, `capability_refusal_swallowed` stays 774). These are existing code, not new swallows; the fix is a typed degraded marker.
