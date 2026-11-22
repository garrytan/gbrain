**Contributors: CI's silent-failure check now catches one shape it used to miss. Nothing you run or see changes.**

### Fixed
- An inline opt-out with no reason (`catch { /* silent-read-ok: */ return []; }`) now fails with "needs a reason". The code after the comment used to be read as the reason, so it passed. No existing site relied on an empty inline reason, so `scripts/silent-read-catches-baseline.tsv` is unchanged and still counts 2527 sites (`catch_empty` 1295, `promise_catch_empty` 458, `capability_refusal_swallowed` 774).
