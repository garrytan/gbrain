**`gbrain claims check` no longer misreads `$2,100,000` or `$2.01M`, and it tells you which allowed-claims pages it could not use and why.**

### Fixed
- A comma between digits is part of the number, so `ARR is $2,100,000 and we have 12 paying customers` is checked as two numbers, not four, and no longer reads as a conflict.
- A scaled decimal equals the same amount written out: `$2.01M` matches `$2,010,000`.
- Newer `type: facts` pages without `claims: allowed` no longer crowd allowed-claims pages out of the 200-page limit.
- `gbrain sources set-precedence` no longer loses a change another process makes to the same source's settings at the same moment.

### Changed
- `check_claims` lists each readable allowed-claims page it could not use under `skipped`, with the reason (quarantined, outside source, written by an agent, stored in segments, or a source that is not approved), and `gbrain claims check` prints them.
