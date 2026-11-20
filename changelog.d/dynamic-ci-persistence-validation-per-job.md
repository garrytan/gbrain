**Trunk Dynamic CI now decides the persistence crash robot and convergence lanes separately on pull requests, so a crash-robot flake no longer decides whether convergence runs.**

### Changed
- `persistence-validation.yml` asks Trunk Dynamic CI about `crash-robot` and `convergence` one by one, and `test.yml` calls it ungated. Pushes, the nightly run and the full-ci dispatch still run every lane. `check-dynamic-ci.ts` accepts a filter job in a reusable workflow, and `trunk-io/dynamic-ci` moves to v1 (v0.1.12).
