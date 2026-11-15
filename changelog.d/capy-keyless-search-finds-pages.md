**Keyless search finds pages that hold most of the question's words.** On a brain with no embedding key, a question used to miss any page that lacked even one of its words whenever another page held all of them: "SSO Starter plan" found the pricing and decisions pages and never the call transcript that mentions SSO and Starter. Now, when the all-words matches leave the result short, an any-word match fills the rest. Fill pages come after everything search returned before, carry `keyword_relaxed: true`, and `--explain-target` says the page matched only some of the words. The fill runs the keyword search's own statement, so the caller's read policy applies exactly as before. On LongMemEval S run keyless, recall_all@10 rose from 80.6% to 91.1% with no question ranking worse. Brains with embeddings are unchanged.

<!-- behavior-change: keyless_any_word_fill_gst2735 -->

### Itemized changes

- `src/core/search/keyword-identifier-probe.ts`: with `orFill`, a short first page of all-words rows runs the any-word retry and appends its rows (tagged `keyword_relaxed` and `keyword_fill`, scored below the lowest all-words row).
- `src/core/search/hybrid/arms.ts`, `hybrid/keyword-only.ts`: hybrid search asks for the fill only on its keyword-only path; fill rows for pages another arm found are dropped, and the rest sort after every other row.
- `src/core/search/alias-fanout.ts`: a page the fill found moves up as the alias row when the alias search finds it.
- `src/core/search/explain-target.ts`: arm ranks from a fill row are marked `relaxed`, and the reason says the page matched only some words.
- Tests: new `test/search/keyless-any-word-fill.test.ts` (PGLite and Postgres); the keyless statement count, the C5 golden (pages appended only) and the lean-rows key comparison are updated.
