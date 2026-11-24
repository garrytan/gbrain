**On a Rust brain, the brain owner's own remote write of a new page is no longer refused.**

### Changed
- On the Rust engine, the owner's own `put_page` of a new page through a bound token now works, with the same result as PGLite and Postgres. Before, it stopped with `engine_capability_missing` because the write check read the page's privacy with raw SQL. The check now asks the engine for it through a new typed read, `readPagePrivacyHidden`. Nothing to do on upgrade.
- The owner's rewrite of a page that already exists and is private is still refused on the Rust engine. A follow-up change fixes that.
