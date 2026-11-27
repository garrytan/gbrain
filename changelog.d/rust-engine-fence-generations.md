**Forgetting a fact under a write request on a Rust brain can now queue the follow-up work the receipt promises.**

### Changed
- When you forget a fact through a managed write, gbrain queues three follow-up jobs: update the withdrawal mirror, commit to git and refresh embeddings. That step is now one engine call instead of raw SQL. Postgres and PGLite send the same statement as before. A Rust brain stores the three jobs in the same transaction as the forget, so a forget that fails leaves none behind.
- The rest of a managed forget on a Rust brain still stops at its earlier statements until those are typed too.
- A fence write (the facts or takes projection that a forget, a put_page or a sync runs), a readable fence clearing its hold, and the held-fence list that `gbrain get` and doctor show now use typed engine calls instead of raw SQL. Postgres and PGLite send the same statements as before. On a Rust brain these calls now answer, and a fence write reaches the generation step before it stops; a whole fence write on a Rust brain still stops there until the generation records are typed too.
