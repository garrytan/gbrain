**On the experimental Rust engine, a git sync now records the commit it reached and makes its page reads through typed engine members, so the next sync reads only the changes. A first sync on Rust still stops at the access-policy read until that read is typed too.**

### Changed
- Five reads and writes that a git sync made as raw SQL are now typed engine members: recording the commit a sync reached, listing a source's pages that have a file path, the two rename-detection reads, and the read that finds large or `embed_skip` pages for the sync receipt. PGLite and Postgres run the same SQL as before.
- A git sync also checks the source's saved path, last commit and page count through members the Rust engine already served.
- The Rust engine now keeps a page's embedding hold (its held state and reason), so the sync receipt shows the same held pages, state and reason as PGLite and Postgres.
- The record a fact purge leaves of each purged change reason (a commit and a file path, never the text) is now read and written through typed engine members, and the Rust engine stores it. A sync, `gbrain repair purged-change-reasons` and a version snapshot read it the same way on every engine.
- An incremental sync on the Rust engine still stops, at the read of purged change-reason commits. That is the next step.
