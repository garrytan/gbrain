**Two tests that failed CI runs on unrelated changes now pass on a busy runner.** Neither changed what it checks.

### Tests

- `test/proactive-brief.test.ts`: the two tests that check a delivered brief writes its `context_volunteer_events` rows went through `turnContextWithBrief`, which gives the brief only 300 ms of wall clock from the start of the request. On a slow runner the base assembly used up that time, the brief came back empty, nothing was delivered or logged, and the row check saw `[]`. `turnContextWithBrief` now takes an optional clock (it still defaults to the 300 ms cutoff), and those two tests pass the same wide test clock the file's other brief tests already use. A probe that slows every query by 60 ms fails the old test and passes the new one.
- `test/skill-resolver-hook-lane.test.ts`: the 5 MB Hermes history test compared one timed run of a small turn with one timed run of the 5 MB turn against the 50 ms lane deadline. Each run varies by 20 to 30 ms on an idle machine and more on a loaded one, so one descheduled turn could fail it (it failed 1 run in 5 under load locally). It now times three runs of each and compares the fastest of each, with the same 50 ms bar.
