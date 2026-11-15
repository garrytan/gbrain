**Doctor's Git checks now finish on large brains, and a check that could not see everything says health unknown instead of ok.**

### Changed
- `db_ahead_of_git` and `strict_facts_outside_git` read the 800 most recently changed pages of each source instead of every page, and their messages say how far back they looked. `gbrain sources git-gap <source-id>` still reads every page.
- When that census runs out of its time budget or cannot run, `db_ahead_of_git`, `strict_facts_outside_git` and `git_index_lag` now report a warning with health unknown instead of ok.
- Doctor runs the checks that catch lost writes before its full scans.

### Fixed
- `strict_facts_outside_git` no longer says every fact has a Git home when a fenced fact sits on a page older than that window. It reports health unknown, and `gbrain sources git-gap <source-id>` counts the whole source.

<!-- behavior-change: doctor_git_gap_unknown_gbra541 -->
