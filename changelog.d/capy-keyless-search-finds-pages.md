**Keyless search finds pages that hold most of the question's words.** On a brain with no embedding key, a question used to miss any page that lacked even one of its words whenever another page held all of them: "SSO Starter plan" found the pricing and decisions pages and never the call transcript that mentions SSO and Starter. Now, when the first page of results comes back shorter than the limit, search appends the pages that hold only some of the words. Every row search returned before stays exactly where it was, with the same score; the added rows come after it, never repeat a page or a collapsed copy of one, carry `keyword_fill: true` (also in lean remote rows), and `--explain-target` says the page matched only some of the words. The added rows come from the keyword search's own statement with the caller's options, so the caller's read policy applies exactly as before. Later pages (an offset above zero) are unchanged. On LongMemEval S run keyless, recall_all@10 rose from 80.6% to 91.1% with no question ranking worse. Brains with embeddings are unchanged.

<!-- behavior-change: keyless_any_word_fill_gst2735 -->

### Itemized changes

- `src/core/search/hybrid/keyword-only.ts`: after the keyless pipeline runs as before, a short first page gets the any-word fill appended: collapsed against the returned rows, scored below the last of them, within the limit and before the token budget.
- `src/core/search/keyword-identifier-probe.ts`: with `orFill`, a short set of all-words rows runs the any-word retry and returns its rows tagged `keyword_relaxed` and `keyword_fill`; a failed retry keeps the all-words rows and reports the keyword arm incomplete.
- `src/core/search/lean-rows.ts`: lean rows keep `keyword_fill`.
- `src/core/search/alias-fanout.ts`: a page the fill added moves up as the alias row when the alias search finds it.
- `src/core/search/explain-target.ts`: the fill shows as the `keyword_fill` arm, marked `relaxed`, and the reason says the page matched only some words.
- Tests: new `test/search/keyless-any-word-fill.test.ts` (PGLite and Postgres), including a property test that the rows with the fill on begin with exactly the rows returned with it off; the C5 and evidence off-path goldens and the export-surface golden gain the appended rows and fields only.
