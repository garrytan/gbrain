**A blocked managed sync now names the same blocking page write on every database engine.**

### Fixed
- When a managed sync could not save its checkpoint, it named "the first" page write still open or failed, and `gbrain sync status` listed up to 20 of them. The query did not say which rows came first, so Postgres named whichever row it met first on disk, which could be a later write than the one PGLite and the Rust engine named. Each check now takes rows in write order: recovery rows first, then open writes, then failed ones, each by write order. The pass check that guards a sync pass picks the same way.

### Blast radius
- On Postgres and PGLite, the blocking write a sync names and the 20 that `gbrain sync status` lists can change to the earliest ones. The check reads a little more when a run has many open or failed writes; a 3,000-write run in 240,000 other rows reads in about 4 ms.
