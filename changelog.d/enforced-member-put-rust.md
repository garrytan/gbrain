**`gbrain put` under `GBRAIN_ENFORCED_MEMBER` now works on a Rust-engine brain.**

### Fixed
- On a Rust-engine brain, a put by an enforced member used to stop with "does not support executeRaw yet" whether or not the member could read the page. It now behaves as on PGLite and Postgres: a member the page lists writes the change and the readers list stays as it was, a member it does not list is refused with `enforced_member_refused` (exit 3) and nothing changes, and a member may create a new page where the folder rules let it read. The follow-up `gbrain get` by the member answers too.
- On a Rust-engine brain, a put that names no source on a brain of several members now prints the `placement` notice (which source took the page and who may read it). It was silently left out before.
- A put with `--source` under `GBRAIN_ENFORCED_MEMBER` checks the source through the typed source read instead of raw SQL.
