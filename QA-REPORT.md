# Independent adversarial QA: github-source

Branch: `gh-github-source` plus QA fixes. Base: `ac402f55`.

Findings:

1. **major** — Delta cursor skipped history for newly added repos. Repro: sync repo A, add repo B containing an older issue, run delta sync; B's issue was omitted because one source-wide `since` cursor applied to B. Fix: `3149859c0b3dd6927c50dd7321711d64bdf94a9d`.
2. **major** — Import rejection was treated as successful skip. Repro: update item to produce a file over the 5 MB import limit; sync overwrote the mirror page and advanced the cursor despite no DB import. Fix: `3149859c0b3dd6927c50dd7321711d64bdf94a9d`.
3. **major** — Deleted-item webhook left stale pages. Repro: deliver signed `issues` action `deleted`; handler queued a fetch for the missing item, so the old page remained after GitHub returned 404. Fix: `3149859c0b3dd6927c50dd7321711d64bdf94a9d`.
4. **major** — Single-item webhook refresh could damage its disk page on import failure. Repro: refresh an existing item with an import-rejected payload; code wrote the final file before import completed. Fix: `3149859c0b3dd6927c50dd7321711d64bdf94a9d`; regression test: `8e53d0e0786cbcc65683a5bed75736a60a5dd296`.
5. **minor** — Review and review-comment bodies did not receive documented issue-number wikilinks. Repro: body contains `#88` or `#89`; description/comments link, review content stayed plain text. Fix: `3149859c0b3dd6927c50dd7321711d64bdf94a9d`.
6. **minor** — `sources status` reported API-backed GitHub mirror directory as a broken git clone. Repro: add `--kind github`, run status; `clone_state` was `no-git` instead of `not-applicable`. Fix: `3149859c0b3dd6927c50dd7321711d64bdf94a9d`.

Validation:

- `bun test test/github-source-page.test.ts test/github-source-materialize.test.ts`: **45 pass, 0 fail**.
- `bun run typecheck`: **pass**.
- `bun test test/sources-ops.test.ts`: **40 pass, 14 fail**. Failures are pre-existing Windows git-test harness failures, documented by prior branch commit `aa528945`; no GitHub-kind test failed.
- No real GitHub API calls made by GitHub-source tests; all GitHub fetches used offline fixtures.
