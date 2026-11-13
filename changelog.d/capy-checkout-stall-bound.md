**CI checkouts on Ubicloud runners retry a stalled fetch instead of hanging until the job times out.**

### Fixed
- Every checkout in a CI job on a Ubicloud runner now has a time limit (3 minutes, 6 for a full-history fetch). A checkout that runs past it is stopped and a second checkout step runs at once, so a stalled git fetch costs about three minutes instead of a timed-out job and a rerun of the whole Test run. This changes only CI; nothing users install changes.
