**The nightly cycle now records what it learned, and `gbrain learned` shows it.**

<!-- behavior-change: learned_view_nightly_ledger -->

### Added
- A new cycle phase, `learning_derive`, runs after the other maintenance phases and before purge. It notes each new thing the cycle learned (a fact an extractor added, a promise someone made you, a pair of facts that disagree, a thin page that enrichment filled, and a Facts row you typed yourself) as a pointer in a new `learning_items` table. It stores ids only, never the text, and records each thing once, however many cycles run.
- `gbrain learned` (MCP tool `learned`) lists what was learned that you have not seen yet, newest first, at most 15 lines, each rendered from the live fact, loop, proposal or page. Something you forgot, purged or made private drops out. `--since <date>` lists everything since then, and `--stats` shows, per night, how many items you kept or saw without undoing. Remote callers see only what their token can read, and other sources stay out.
- Works on a brain with no git repository, and on PGLite and Postgres. A brain whose schema is behind gets a `migrations_pending` refusal from `learned` and a skipped phase; an engine without raw SQL gets `engine_capability_missing`.
