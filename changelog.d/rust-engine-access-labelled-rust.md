**On the Rust engine, a labelled-only member reads only the pages and facts that name it, as on PGLite.**

### Fixed
- On a brain with the Rust engine, a member that carries the labelled-only grant (`gbrain access member labelled-only <id> on`, or `gbrain access serves several --labelled-only`) reads only the pages whose readers name it or that a folder rule it satisfies covers, and only the facts of its own member page, with the same results as PGLite. Before, every read such a member made stopped with a typed refusal.
- On the Rust engine, fact reads by a member who satisfies a folder rule are answered instead of refused.
- Still refused on the Rust engine, before any read: a labelled-only member whose brain turns on `access.members_read_lineage`, and a labelled-only member's remote read floor.
