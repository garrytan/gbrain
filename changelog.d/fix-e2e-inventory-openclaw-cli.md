**A ship check no longer refuses every pull request's CI evidence because of the real-gateway OpenClaw test, which only nightly and full-corpus runs execute.**

### Fixed
- The remote gate's test list (`scripts/pregate-remote-gate.sh --list`) leaves out `test/e2e/openclaw-skill-resolver-real.test.ts`, as it already leaves out the keyed Tier 2 file. That file needs the OpenClaw CLI and runs only in e2e.yml's full-corpus `openclaw-skill-resolver` job, so a labelled head's E2E run never lists it and every carry was refused with `inventory_uncovered`. A new test fails when any E2E file that only full-corpus jobs run is left in the list.
