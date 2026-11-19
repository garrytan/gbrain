**gbrain's own tests now check who can read what when a brain's sharing changes.**

### Tests
- The sharing-contract matrix now runs in gbrain's test suite. It covers 14 ways a personal brain can become shared or stay personal, 7 kinds of caller, 9 kinds of content and 10 read paths. Pull requests run a fixed sample of it on PGLite, the end-to-end suite runs the same sample on Postgres, and the full matrix of 11,392 cells runs on PGLite in the full CI run and nightly.
- The 24 cells known to break the contract today are pinned, each group with its reason: 8 are the documented wait until the next archive run, while `archive_rescope_pending` is reported, and 16 come from calling the member-add library function with no re-scope hook, which no command or route does. A new bad cell fails the run, and so does a pinned cell that starts holding.
