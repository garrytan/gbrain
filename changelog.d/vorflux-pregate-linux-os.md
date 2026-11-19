**Shipping a gbrain change no longer reruns the full test suite on the developer's machine when Linux CI already passed at the same code.**

### Changed
- For contributors: `.gstack/pregate.json` now records that the CI `test` and `e2e` jobs run on Linux, and each full run's `tree.json` now records the runner's OS, which gstack requires before it accepts the run. `/ship` reuses a passed CI run of those jobs only when the local machine runs the same operating system, and without this field it could not match them, so it ran the whole suite locally (about an hour). Nothing changes for gbrain users.
