**Purging deleted pages with an age that is not a number, negative or infinite is now refused on every engine, so a bad age can no longer permanently erase every deleted page.**

### Fixed
- `gbrain pages purge-deleted`, the purge job and the maintenance cycle refuse an age that is NaN, negative, +Infinity or -Infinity with a clear `invalid_argument` error before they preview, carry or delete anything. Before, a negative age counted as 0 hours, so the purge removed every soft-deleted page, including the tombstones the belief ledger records, and on the Rust engine an age that was not a number did the same. Zero and positive ages work as before.
- On a Rust brain, a claim the ledger says was withdrawn no longer shows in the lead of a large page.
- The keyword-scale measurement tool refuses a brain that another process has open, instead of writing into it, and it builds on Windows again.

<!-- behavior-change: purge_age_refused_9823 -->
