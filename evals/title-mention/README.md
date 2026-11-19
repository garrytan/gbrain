# Title-mention corpus

A manual retrieval corpus for the title-subject boost: 72 placeholder pages
under `corpus/` (events, finance, hiring, leases, ...) and 144 questions in
`queries.jsonl`, four per page:

| `family` | Query shape |
|---|---|
| `title-substring` | the page title alone |
| `question-wrapped-title` | the title inside a short question |
| `long-form-wrapper` | the title inside a long natural-language request |
| `mention-other-gold` | a query naming one page whose gold answer is another |

No test runner or CI job reads this directory. The boost itself is owned by
`test/search/title-mention-boost.test.ts` and
`test/search/general-title-mention-boost.test.ts`.

Run it against a scratch brain:

```bash
foresights import evals/title-mention/corpus
foresights eval retrieval-quality evals/title-mention/queries.jsonl --json
```

`foresights eval retrieval-quality` reports every family, but its default gate
(`DEFAULT_GATE` in `src/eval/retrieval-quality/harness.ts`) floors only
`title-substring` among these (Hit@1 >= 0.95); the other three families are
reported, not gated.
