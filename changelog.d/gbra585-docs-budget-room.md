**Three agent-facing docs that had hit their size caps now have room again; no cap was raised.**

### Documentation
- The guard registry and self-test section moved out of `docs/TESTING.md` into its own page, `docs/ci-guards.md`. Links to its anchors, guard error messages and the guard baselines now point at the new page.
- The key-files entries for page windows and large page writes moved from `core-services-2-continued.md` to a new `core-services-2-page-window.md`, and the entries from `src/core/sql-query.ts` through `src/core/utils.ts` moved from `core-utilities-2.md` to a new `core-utilities-2-continued.md`. Each full page links its continuation from its last line.
- `llms-full.txt` links "Connect a hosted brain" (`docs/guides/hosted-harness-access.md`) instead of inlining it. It applies only once a brain runs on another machine, and the inlined AGENTS.md already routes those agents to it.
