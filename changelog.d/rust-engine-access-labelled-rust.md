**On the Rust engine, a labelled-only member reads only the pages and facts that name it, as on PGLite.**

### Fixed
- On a brain with the Rust engine, a member that carries the labelled-only grant (`gbrain access member labelled-only <id> on`, or `gbrain access serves several --labelled-only`) reads only the pages whose readers name it or that a folder rule it satisfies covers, and only the facts of its own member page, with the same results as PGLite. Before, every read such a member made stopped with a typed refusal.
- On the Rust engine, fact reads by a member who satisfies a folder rule are answered instead of refused, except a world-only fact list (what remote recall sends), which still refuses for such a member unless it is labelled-only. A labelled-only member's recall is answered as on PGLite. `get_page` as of a date still refuses on the Rust engine for a labelled-only member.
- A labelled-only member whose rule was moved, but whose pages are not yet restamped, no longer reads a page the move has not labelled.
- Three labelled-only reads are still refused on the Rust engine, before any read. They are a member whose brain turns on `access.members_read_lineage`, a member read for an audience of several, and a member's remote read floor.
- One difference remains, and it fails closed. After a folder rule moves away from a folder and before that folder's pages are restamped, the Rust engine hides those pages from a labelled-only member, while PGLite still shows them from the old stamp.
- On the Rust engine, page history (`get_versions`) no longer shows the reason for a change whose next version the reader may not see, as on PGLite.
