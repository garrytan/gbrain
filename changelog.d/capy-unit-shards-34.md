**CI runs the unit suite in 34 shards instead of 30, so every shard fits its 600-second budget again.**

### Changed
- Shard timing weights are refreshed from the median of five recent nightly Test runs (unit and serial) and the latest full E2E nightly. With those weights the heaviest of 30 shards packed to just over 600 seconds; with 34 shards each packs to about 529 seconds.
- The `test` job in test.yml and the `coverage-full-unit` job in e2e.yml both run 34 shards, and their coverage manifests expect all 34. A full run starts four more unit jobs than before.

### Fixed
- `bun run release:unstamp` no longer refuses a branch because master edited a published migration after the branch was cut. An edit the branch itself made to a published migration is still refused.
