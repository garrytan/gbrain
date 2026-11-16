**The check that runs before every search stays fast while a large brain's pages wait to be rebuilt after an upgrade from before v0.51.**

### Fixed
- After an upgrade from before v0.51, pages still answering from their old index were walked one by one by the readiness check that runs before every search, so the check cost 21 ms on a test brain with 20,000 such pages and 126 to 149 ms with 200,000. A new partial index (migration v317) holds only the pages that are out of search, so the check now takes about 2 ms and the index is empty once the rebuild finishes. On Postgres the index builds without blocking writes; nothing is rewritten. Follow-up to #9472 (#9192).
