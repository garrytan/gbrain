**The rest of the generation ledger runs on a Rust brain: the purge scrub and managed publications.**

### Changed
- The purge scrub of the generation ledger (the step that removes a purged page or a purged fact's text from stored generation history) now uses engine calls instead of raw SQL. Postgres and PGLite send the same statements as before.
- A Rust brain runs the scrub itself: it deletes the page's held fence results, clears the stored copies that name the page or carry the purged text, and drops the page's recorded fence blocks. Before, the scrub stopped at its first statement there.
- A managed publication (the generated pages of a managed brain, recorded before they are written and settled after) now uses engine calls instead of raw SQL. Postgres and PGLite send the same statements as before.
- A Rust brain runs a managed publication to the end: it records the activation, flips it when the generation goes live, settles each page and lists the pages still pending or left behind. Before, it stopped at its first statement there.
