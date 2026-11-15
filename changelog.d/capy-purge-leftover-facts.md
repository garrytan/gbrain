---
important: data-loss
---
**`gbrain doctor` finds the facts that purges left behind before #8859 was fixed, and `gbrain repair purged-page-facts` retires them after you approve the preview.**

### Fixed

- **Facts left active by older purges can be found and retired** (#8859 follow-up). Before the #8859 fix, purging a page left the facts extracted from it and filed on no page active, so recall kept returning claims from a removed page. The new doctor check `purged_page_facts` counts them, and `gbrain repair purged-page-facts` previews each one with its class and expires exactly the previewed rows on `--apply --expect <hash> --yes`. Rows of a page the purge ledger records are retired by default; rows of a page gone with no purge record need `--include-ambiguous`. Nothing changes on upgrade.
- **Purges match those facts through an index.** A new index on the head of a fact's context (migration v315) keeps a purge from scanning every fact in its source. The doctor check and the repair still read every page-extraction fact filed on no page.
- **The repair expires rows but writes no purge record**, so the same claim could be saved again later.

### Itemized changes

- `src/core/repair/purged-page-facts.ts`, `src/commands/doctor/checks/purged-page-facts.ts`: the repair kind (explicit-only, preview-bound, destructive consent) and the read-only check.
- `src/core/facts/gone-page-facts.ts`: the context match uses `contextHeadSql`, the expression v315 indexes.
- `src/core/schema-migrations/v315-facts-context-head-index.ts`: `idx_facts_context_head`, built concurrently on Postgres.
- Docs: `docs/guides/repair.md#purged-page-facts`.
- Tests: new `test/repair-purged-page-facts-8859.test.ts` (managed PGLite and Postgres, unmanaged PGLite).
