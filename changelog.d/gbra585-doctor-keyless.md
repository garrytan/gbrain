**Doctor now warns when a shared source or a live key no longer reaches anyone, and search on a brain set up without embeddings is no longer marked degraded.**

<!-- behavior-change: keyless_by_choice_not_degraded_gbra585 -->

### Added
- Two read-only doctor checks for brains several people use: `access_shared_source_unread` (a source bound to no member holds pages that no enabled member's live key reads) and `access_disabled_member_credentials` (live tokens or OAuth clients bound to a disabled or removed member). Each names a count and a few ids, never content, and shows a read-only command to look closer. Both read every member's keys, so they run only on the brain host, and a remote `run_doctor` that names either one is refused with the `gbrain doctor --only <check>` command to run there.

### Changed
- On a brain whose embeddings were turned off on purpose (`gbrain init --no-embedding`), search, query, find_experts and recall run keyword-only by design, so they no longer carry the `[gbrain degraded: …]` stamp or a `degraded_recall` notice, and an empty result says the search was keyword-only and that no page the caller can read holds the words within that search's filters. A brain with no embedding provider configured, timeouts and failed search arms are stamped as before; `_meta.retrieval` is unchanged.
