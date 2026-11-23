**The Rust engine plan now aims for a Rust engine that matches today's engines on the maintainer's own brain by Dec 1, 2026, merges to master default off, and defines what "equal or better" means for ranked search.**

### Changed
- `docs/designs/RUST_ENGINE.md` (D21): the first goal is 1x parity by 2026-12-01. On the maintainer's own brain, the Rust engine must give the same CLI, JSON and MCP output and the same markdown brain format as today, and pass the engine parity suite for every method that brain uses. It runs in shadow mode first, then by an opt-in swap. The store bake-off takes 2 days, SQL removal starts now by subsystem, and a "Dec 1 schedule" table lists the workstreams and milestones.
- D22 records the maintainer's Nov 17 rulings: the owner process lands before the freeze, Dec 1 uses one writer, PGLite's `stale` rule applies, names are kept, and the concurrent-writer store comes after parity.
- D23: Rust engine code merges to master when it works and stays default off. Performance is measured and reported but gates only turning Rust on by default, later. Under the C1 ruling, speed does not block the Dec 1 opt-in swap.
- D24 defines "equal or better" for ranked-search recall: the 95% paired lower bound against each TypeScript engine is at least −0.018 (the smallest detectable difference at N = 470), with identical top-k ids counted as ties. It gates only the later default-on decision.
- This is a plan change only. No code ships and nothing changes for any brain.
