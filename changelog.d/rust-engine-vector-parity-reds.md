**The vector parity test for the experimental Rust engine is green again, and it now proves every engine applies the trust floor.**

### Fixed
- `test/vector-embedding-parity.test.ts` still expected the Rust engine to refuse `minTrust` and `suppressFlagged`, which it has applied like PGLite and Postgres since the trust-floor change. The two Rust-only checks now assert that all three engines keep and drop the same rows under a trust floor and the flagged-page filter, and that Rust still refuses an unknown option and a floor that names no trust tier. No engine code changes.
