**CI unit tests run in 46 shards with the slow setup-layout suite split by shape, the nightly race hunt can use 36 shards, the shard-timing miner refreshes from a median of recent runs, and four tests that failed at random are fixed at the cause.**

### Fixed
- Shadow mode's status check could read a write-comparison tally as unchanged when it was saved again within one file-timestamp tick and kept its size and inode. It now compares the file's bytes too, so such a read is retried and then reported unresolved, never measured.
- Four tests that failed at random on busy CI runners no longer depend on how fast the runner is. Two timer tests (the shadow keeper's refusal burst, #10584, and the bounded write waiters) run on a test clock, the shadow tally test above is deterministic, and the owner-contact enrich budget at 100k pages is measured in thread CPU time, the same 500 ms budget.

### Changed
- `test/setup-brain-layout.test.ts` (up to 595 s, nearly a whole 600 s shard) is split into personal, company, transcripts and member-transcripts files with a shared fixture; every test moved unchanged. The unit matrix grows from 42 to 46 shards so a full timing refresh fits the shard budget.
- The nightly race hunt (every Postgres-arm test file, at least 3 times) may now use up to 36 shards of 55 minutes instead of 24, so the 971 files it covers run again instead of failing "race hunt over budget" with 2 left out. It still uses only as many shards as the files need.
- `bun run weights:mine` takes `--latest N` (the newest N successful master runs that ran the lane, as a median) and `--coverage-only` (keep every existing weight and add only files the map lacks). The weight-coverage check prints those commands.
