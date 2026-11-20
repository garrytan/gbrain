**Trunk Dynamic CI now also decides whether a pull request needs the keyless harness check and the TLA+ specs.**

### Changed
- `harness-check.yml` and `tla-spec.yml` each get a pull-request-only `dynamic-ci` filter job in the same form as `test.yml`'s, and gate `keyless` and `tla` on it. In Learning mode nothing is skipped; pushes, the nightly run and dispatches always run both.
