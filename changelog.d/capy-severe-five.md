---
important: data-loss
---
**Purging a page retires the facts extracted from it, `gbrain migrate embeddings` stops refusing on some databases, a growing transcript is no longer re-synthesized on every dream pass, legacy embedding labels no longer wipe valid vectors, and search says how far an upgrade's index rebuild has got.**

<!-- behavior-change: resynthesis_hold_6753 -->

### Fixed

- **Facts extracted from a purged page are retired with it** (#8859, reported by @ocscdsa). Facts the extractor filed on no page and that name the page only in their context stayed active after the page was retired or purged. Retire and purge now match them too. Facts left behind by earlier purges are not changed here.
- **`gbrain migrate embeddings` no longer always refuses with "Source census changed while acquiring locks"** on databases whose collation sorts source ids differently from code-unit order (#9307, reported by @ozabramov; first fixed by @Masashi-Ono0611 in #9310).
- **A growing transcript is re-synthesized at most twice a day** (#6753, reported by @andreineacsu). A transcript synthesized within `dream.synthesize.cooldown_hours` is held, so repeats drop from up to 24 a day to 2. The daily spend ceiling is unchanged ($120 worst case). Explicit `--input` and `--date` runs are never held.
- **Chunks stamped with a bare model label keep their vectors** (#8533, reported by @babyspectrum). The false-stamp guard, the projection preserve check and the stale-signature invalidation now share one rule: a bare label counts when its model name and width match the configured model; a different explicit provider prefix is still invalidated. Before, the last two nulled valid vectors and forced a paid re-embed.
- **Search says how far an upgrade's index rebuild has got** (#9192, reported by @jonahberg). While the rebuild runs, the partial-results notice gives pages done out of total, the measured rate and the command to watch progress, and the upgrade prints it once.

### Itemized changes

- `src/core/facts/gone-page-facts.ts`, `src/core/facts/subject-infer.ts`, `src/core/persistence/page-purge.ts`: extracted-from-page facts are expired and purged with their page.
- `src/commands/migrate-embeddings.ts`: the locked census is sorted the same way as the requested source list.
- `src/core/cycle/synthesize-completion.ts`, `src/core/cycle/synthesize.ts`: per-transcript re-synthesis hold.
- `src/core/embedding-invalidation.ts`, `src/core/engine-sql/chunks.ts`, `src/core/page-state/projections.ts`: one `chunkModelMatchesSql` rule.
- `src/core/search/retrieval-coverage.ts`, `src/core/ops/search.ts`, `src/core/interop-notices.ts`, v153's notice handler: rebuild progress.
- Tests: one new test per fix, on PGLite and Postgres where the bug is engine-specific; the #5051 test changes one assertion and its count.
