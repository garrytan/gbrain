**On a Rust brain, the owner's own remote writes and a plain member's rewrite of a page that names its readers now work.**

### Changed
- On the Rust engine, the owner's own `put_page` through a bound token now works, both for a new page and for a rewrite of a page that is already private, with the same result as PGLite and Postgres. A rewrite of a private page that names no visibility keeps it private. Before, it stopped with `engine_capability_missing` because the write check read the page's privacy with raw SQL.
- A plain member's `put_page` over an existing page that names the member as a reader now works on the Rust engine too. The write check asked for the page with raw SQL, and now uses two typed reads, `readPagePrivacyHidden` and `readLinkTargetPages`. A page that has only a soft-deleted row is still judged by the old statement, so a write never republishes a deleted private page. On Postgres these reads, and the write check's opening probe, end at the page-preparation time limit as the raw statements did.
- The Rust engine's check of a writer's read policy now also accepts the owner's own policy. Every other policy shape is still refused the same way. Nothing to do on upgrade.

### Known gap
- On the Rust engine, a remote write to a page that has only a soft-deleted row, or no row, can still be refused with `engine_capability_missing` when the earlier checks in `authorizePageVisibility` have not already decided it, because that case is still judged with a raw statement. A page with a live row is judged through the typed reads.
