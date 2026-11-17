**A large capture's receipt now reports the same date as the page slug it created, and five tests that failed now and then pass every run.**

### Fixed
- `gbrain capture --file` with a file over the page size limit took the slug date and the receipt's `captured_at` from two separate clock reads, so a capture that ran across UTC midnight could print a receipt dated one day for a page slug dated the next. Both now come from one timestamp. (#7980)
- The forget test for twin inline and segmented pages froze no clock, so a run that crossed UTC midnight stamped the two pages with different dates and failed. Both halves now run under one frozen time. (#8674)
- The sync dry-run test compared request rows read in no fixed order. It now orders them by id and compares whole rows, so it also catches a dry run that edits a request. (#8416)
- The private-queue recovery test gave its orphan job a 1 ms lease and relied on it running out before reconcile looked. The test now expires the lease explicitly. (#8739)
- The reranker failure test freed a random port and assumed nothing would take it again. It now points the dead endpoint at port 1, where nothing listens. (#9616)
