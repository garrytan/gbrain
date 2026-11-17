**Seven small fixes from outside reports: Claude Code transcript ingest, date-only search windows, the unit runner's failure log, doctor's Hermes hook check, get_page grep on tables, skill-catalog rebuilds and Windows sync paths.**

### Fixed
- `gbrain transcripts ingest` skips the state files Claude Code 2.1 keeps inside each session directory, instead of failing each with `unknown format` and holding `--since last` back (#9365, reported and first fixed by @Masashi-Ono0611).
- A date-only `since` in search starts at UTC midnight, so a one-day window covers that UTC day whatever the database's timezone (#9533, reported and first fixed by @DanCanadian).
- The unit runner's `.context/test-failures.log` keeps each failing test's own error and diff instead of the next test's (#9315, reported and first fixed by @Masashi-Ono0611).
- `gbrain doctor` recognizes a gbrain turn-rule hook added by hand to an existing Hermes `hooks:` section, so `harness_wiring` no longer warns about it (#8846, reported and first fixed by @Masashi-Ono0611).
- `get_page` grep returns the matching table row instead of the whole table (#9104, reported and first fixed by @Masashi-Ono0611).
- `gbrain setup` keeps a skill catalog's `--routing` table when it rebuilds a stale catalog (#9332, reported and first fixed by @Masashi-Ono0611).
- Sync on Windows accepts a page whose stored path uses the other path separator, instead of refusing it with `page_identity_changed` (#9118, reported and first fixed by @yuriysan).
