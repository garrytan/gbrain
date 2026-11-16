**Stable now waits for a green upgrade test from every recent stable release.**

### Changed
- The daily stable check promotes a release only after the upgrade matrix ran green on that release's exact tag and tree. With no run yet it starts one; a red run holds stable with a warning and is not started again by the schedule.
- The upgrade matrix's full run also upgrades from the stable releases users may still be on, which are the last 8 stable releases plus the newest one of each older month, back 6 months. A test run from before this change no longer counts.
- While the upgrade matrix's own break issue is open, stable holds. Only a security or data-loss fix that fails on no from-version the issue doesn't name may pass it.
- `promote-stable.yml` takes an optional `matrix_run_url`, checks it the same way and records it as `matrix_run` in `stable.json` and the stable tag. A maintainer can still promote without one, recorded as `matrix_run: null`.
