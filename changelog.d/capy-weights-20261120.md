**CI splits tests across machines using fresh timings, so 75 newer test files no longer run without a timing estimate.**

### Changed
- Refreshed the test timing maps that CI uses to balance test shards. Serial and end-to-end timings are re-measured in full. Unit timings keep every existing value and add the 75 files that had none, because a full unit re-measure puts `test/setup.test.ts` alone at 644 s, over the 600 s per-shard budget.
