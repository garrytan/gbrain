**When a graph walk scoped to one source, or to all sources, stops at its size cap, the suggested shallower retry now keeps that scope.**

### Fixed
- `traverse_graph` returns a `graph_walk_truncated` notice when a walk stops at its cap, with a ready-to-run retry one level shallower. That retry dropped the caller's `source_id` and `all_sources`, so an agent that followed it walked its default source instead of the one it asked for. The retry now carries both, and still leaves them out when the call didn't set them (#8498).

### Tests
- `test/degraded-stamp-paths.serial.test.ts` checks the retry for a walk scoped to one source, an all-sources walk and an unscoped walk.
