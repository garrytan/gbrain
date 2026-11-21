**A Rust brain finishes a deferred chunk replacement and stamps its rebuild queue.**

### Fixed
- on a Rust brain, the step that finishes a page's deferred chunk replacement no longer stops with "does not support executeRaw yet": it seals the page, keeps the chunks the new body still holds, and holds off a second continuation as Postgres and PGLite do.
- on a Rust brain, the projection rebuild now re-keys, stamps, defers and fails its queued jobs instead of stopping on the same refusal.
- on a Rust brain, re-sealing a page's chunks (as an extraction receipt's page write does) no longer stops on the same refusal when it counts the chunks still waiting for an embedding.
- on a Rust brain, the background projection pass no longer stops on the same refusal when it picks the queued pages to rebuild.
- on a Rust brain, `gbrain export` now writes a frontmatter date as the same ISO date Postgres and PGLite write, instead of `{}`.
- on a Rust brain, a deferred chunk replacement that its time budget stops now hands the page back to the drain, so the page is sealed on the next pass instead of waiting about a minute for its claim to expire.
- on a Rust brain, an idle background writer now sees pages waiting for their search passages and builds them at once, as Postgres and PGLite do, instead of only when its idle wait reaches its cap.
