**On the Rust engine, deleting a private page now keeps the pages derived from it private, a purge refuses before it writes anything, and a write stuck behind another one now says why.**

### Fixed
- On the Rust engine, a soft delete of a private page now labels the pages derived from it `visibility: private`, as PGLite and Postgres do. Before, the origin lookup refused on that engine and the refusal was swallowed, so the derived page could open to readers once its origin was gone.
- On the Rust engine, `delete_page --purge` stops with a named `engine_capability_missing` refusal before any write, and the page stays live and unchanged. Before, it soft-deleted the page and parked it as `derived_origin_unchecked` and then failed.
- delete_page's origin, dependent, checkout and label-guard reads now go through typed engine members on every engine (engine-sql/label-door.ts). An engine that refuses one of them now surfaces the refusal instead of reading it as "no origin".
- On the Rust engine, the head-blocker probe now answers. A queued write held behind an earlier one names the request that holds it, and whether the write may be claimed now. Before, the probe refused on that engine and the refusal was swallowed, so the claimable answer was silently empty.
- On the Rust engine, the read of open rename identity downgrades now answers, with the live slug at each new path. Before, it refused on that engine as soon as one record existed.
- On the Rust engine, the list of open rename identity downgrades (used by `gbrain sync status` and doctor) now says whether `gbrain restore` can bring each old page back. Before, the restore check read the source through raw SQL, which that engine refuses, so the list failed.
- The writer admin lock is now read through the typed config read everywhere: engine graduation, `sources writer deactivate` and the refusal inside claim, activation and transfer. Before, those three read the config table through raw SQL, which the Rust engine refuses.
- The head-blocker probe's reads now go through typed engine members on every engine (engine-sql/head-blocker.ts), and a refusal from them is surfaced instead of read as "no blocker".
