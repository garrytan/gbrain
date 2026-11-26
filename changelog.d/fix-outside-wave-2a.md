**Seven fixes from outside reports: retired-worktree embedding effects, managed lint scope, legacy Git file modes, usage-ledger pricing overrides, the embedding model label, and unfinished source walks.**

<!-- behavior-change: embedding_effects_former_binding_10434 -->
<!-- behavior-change: managed_lint_sync_scope_10442 -->
<!-- behavior-change: git_door_legacy_sibling_mode_8321 -->
<!-- behavior-change: usage_ledger_pricing_overrides_10424 -->
<!-- behavior-change: migrate_embeddings_db_label_10231 -->
<!-- behavior-change: cycle_freshness_unfinished_walk_8577 -->

### Fixed
- `gbrain repair embedding-effects` can now settle a failed embedding effect recorded under a worktree that `gbrain sources writer deactivate` (or a transfer) retired, when this host owns the source's current binding and the page was deleted, moved on to a newer revision, or already has verified vectors. It never retries on the old worktree, and the settled outcome names the former worktree. Reported and first fixed by @thebergerking91 and @Masashi-Ono0611 (#10434, #10436).
- On a managed brain, directory lint (the cycle's lint phase included) now checks only the files managed sync imports, so plain folder READMEs, `skills/` bundles and `sync.exclude` matches no longer produce page-format warnings. Linting one named file is unchanged. Reported by @Kkkkkuro, first fixed by @Masashi-Ono0611 (#10442, #10446).
- A strict (`canonical: git`) source no longer refuses every write into a folder that holds a file Git recorded with the old `100664` mode; the rebuilt folder records that file as `100644`, as `git commit` would. Reported in #8321, first fixed by @javieraldape (#10429).
- The chat usage ledger (`get_usage`) now prices calls with the rates registered by `gbrain pricing set` (`pricing.overrides`), the same prices the budget meter caps with, instead of recording them as unpriced. Reported by @ikatsura, first fixed by @Masashi-Ono0611 (#10424, #10426).
- `gbrain migrate embeddings` no longer reports "nothing to migrate" while the database still records the embedding model under a different name (for example without its provider prefix); a run rewrites the stored name and re-embeds nothing whose vectors are already in the target space. Reported and first fixed by @dlmccoy (#10231).
- Doctor's `cycle_freshness` no longer reads a source as fully cycled while its bounded page walk is unfinished: it reports the live pages left after the walk's cursor, with the cursor in `details.source_windows`. Reported in #8577, first fixed by @javieraldape (#10326).
