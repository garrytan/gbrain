**The rest of the generation ledger runs on a Rust brain: the purge scrub, managed publications, the repair reads and the facts fence evidence and restore.**

### Changed
- The purge scrub of the generation ledger (the step that removes a purged page or a purged fact's text from stored generation history) now uses engine calls instead of raw SQL. Postgres and PGLite send the same statements as before.
- A Rust brain runs the scrub itself: it deletes the page's held fence results, clears the stored copies that name the page or carry the purged text, and drops the page's recorded fence blocks. Before, the scrub stopped at its first statement there.
- A managed publication (the generated pages of a managed brain, recorded before they are written and settled after) now uses engine calls instead of raw SQL. Postgres and PGLite send the same statements as before.
- A Rust brain runs a managed publication to the end: it records the activation, flips it when the generation goes live, settles each page and lists the pages still pending or left behind. Before, it stopped at its first statement there.
- The reads of `gbrain repair generations` (the restore plan, the lists it selects by `--run`, `--since`, `--key` and `--generation`, the held proposal and the source incarnations the preview binds) now use engine calls instead of raw SQL. Postgres and PGLite send the same statements as before, for every combination of selectors.
- A Rust brain answers those reads itself.
- The facts fence evidence (the check that a fact row was really in a page's `## Facts` fence before a write retires it, and the move of a kept row off a number a fence row claims) and the fence restore reads of `gbrain repair generations` now use engine calls instead of raw SQL. Postgres and PGLite send the same statements as before.
- A Rust brain answers the fence evidence and restore reads itself. Before, they stopped at their first statement there. A fact rows generation still stops on a Rust brain at one other read (its stored copies of the rows), which is a later change.
