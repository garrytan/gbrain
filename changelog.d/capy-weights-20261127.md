**CI packs its test shards with run times for 138 unit test files it had been guessing at, and with fresh timings for every serial and end-to-end test file.**

### Changed
- 138 unit test files that had no recorded run time now have one, taken as each file's median over five master test runs. Unit run times already on record are unchanged.
- Every serial and end-to-end test file's run time is refreshed from the 2026-11-27 nightly runs.
- Nothing changes for people using gbrain. This only affects how CI splits tests across machines.
