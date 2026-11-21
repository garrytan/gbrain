**The Rust engine's design docs under `rust/docs/` are now left out of /ship's code review, the same as `docs/`; nothing changes for users.**

### Changed
- `.gstack/ship-policy.json` now lists `rust/docs/**` next to `docs/**` in `review_exclude_paths`, so a large Rust change stays under the review pass's 2,000,000-byte limit. Rust code, tests and config are still reviewed in full, and the documentation audit and the privacy and secret-scan checks still read those docs.
