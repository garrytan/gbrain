**When a scoped graph walk or typed hop chain ends early, the next call it suggests now keeps the caller's source scope.**

### Fixed
- `traverse_graph` returns a `graph_walk_truncated` notice when a walk stops at its cap, with a ready-to-run retry one level shallower. That retry dropped the caller's `source_id` and `all_sources`, so an agent that followed it walked its default source instead of the one it asked for. The retry now carries both, and still leaves them out when the call didn't set them (#8498).
- The same holds for a `hops` chain that finds no edges, stops at an empty hop or hits a chain cap: its suggested `traverse_graph` call now keeps `source_id` and `all_sources` (#8498).

### Tests
- `test/degraded-stamp-paths.serial.test.ts` checks the retry for a walk scoped to one source, an all-sources walk and an unscoped walk.
- `test/traverse-graph-hops.test.ts` checks the no_edges and empty_hop suggestions for the same three cases.
