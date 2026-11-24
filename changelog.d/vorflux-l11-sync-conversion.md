**A Rust brain now records which blocked writes a managed sync converted.**

### Changed
- Recording a sync conversion (the log `gbrain sync status` reads) is a typed engine member, `recordSyncConversion`. PGLite and Postgres send the same statement as before. The Rust engine stores the same record, in the same JSON key order, where before it refused the write.
- Tests: `test/engine-parity/git-holds.test.ts` checks the log on every engine arm, including the bound and the stored record text.
