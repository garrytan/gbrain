**`gbrain doctor` checks for facts left behind by purged pages in about a second per million facts, instead of timing out on a large brain.** The `purged_page_facts` check used to run its exclusion tests (a withdrawal lookup that fingerprints each claim, plus the superseded and open-loop checks) on every active fact before asking whether the fact's page was gone, so on a brain with a few million facts it ran past its 15-second budget and reported nothing. It now finds the facts whose page is gone first and runs those tests only on them. It counts exactly what it counted before, and `gbrain repair purged-page-facts` is unchanged.

### Fixed

- Doctor `purged_page_facts`: on a generated brain with 1,000,000 active facts and nothing to report, the check took 6.7 to 7.0 s on Postgres and 24 to 26 s on PGLite, and now takes about 1.0 s on both.
