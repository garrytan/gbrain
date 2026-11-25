# The repair applies and privacy scans

The typed members that let the applies of `gbrain repair consolidate-ties`, `duplicate-facts`, `extractor-facts`,
`fact-claim-dates`, `purged-page-facts`, `url-clone-fences`, the database-only `visibility` facts class and
`moved-pages`, and the previews of `visibility`, `open-facts` and `private-labels`, run on a Rust brain. Each has one SQL
copy in `src/core/engine-sql/` (the statement its caller ran, unchanged) and a store function here. The parity cases are
in `test/engine-parity/repair-facts-previews-2.test.ts`, `-3`, `-4`, `repair-history-kinds.test.ts` and
`tie-purge-files-links-facts.test.ts`.

| Members | Caller | SQL | Store | Contract |
|---|---|---|---|---|
| `restoreConsolidationTie`, `listLiveDuplicateRows`, `supersedeDuplicateFacts`, `linkStruckDuplicateFacts`, `listCommittedRestorePages`, `listActivePositionedFactIds`, `readFactRestorePage`, `restoreExtractorFact`, `moveFactClaimDates`, `lockApprovedFacts`, `expireApprovedFacts`, `tightenDatabaseFactVisibility`, `detachFenceRowFacts`, `hasDatabaseOnlyClaim` | the fact applies | `repair-applies.ts` | `src/facts/repair_applies.rs` | Each write reads the rows the statement's `WHERE` names and saves the changed ones through `write_fact`, so the trust stamp, the withdrawal guard, the purge guard and the unique indexes run as for the `UPDATE`. `now()` is the store clock, read once per call. `lockApprovedFacts` makes no store call: a store write transaction holds the whole store. A `timestamptz` argument is parsed as text (a JS `Date` arrives as its ISO text, milliseconds, as postgres.js sends it). |
| `listPageAccessKeys` | `moved-pages` | `repair-applies.ts` | `src/facts/repair_applies.rs` | Per page: `page_readers` (`gbrain_access_readers`), the folder rule ids the last stamp kept, `readable_by` and the snapshot filter. |
| `readSourceCloneRow` | the url-clone check | `repair-applies.ts` | `src/facts/repair_applies.rs` | The source row, archived or not. |
| `readPageVersionRow` | `revert_version` (`overwritten-edits`) | `overwrite-reads.ts` | `src/pages.rs` | The whole version row, as `createVersion` returns one. |
| `readAtomGeneration`, `recordAtomGenerationBump` | `stale-atoms` | `atom-generation.ts` | `src/persistence/op_checkpoint.rs` | The `managed-atoms-generation` ledger row; the bump drops the source page's `managed-atoms` runs of other content. The store keeps no `extract_atoms_page_state` rows, so that delete finds nothing. |
| `listAtomLineageRows`, `listChronicleEventVisibilityRows`, `listAliasOnlyPrivatePages`, `listConceptLineageRows`, `listConceptInputRows`, `listNamedVisibilityRows`, `listOpenTwinRows` | `visibility` preview | `visibility-scans.ts`, `facts-repair.ts`, `open-twins.ts` | `src/facts/visibility_scans.rs` | `length(compiled_truth)` counts characters (null for a segmented page). `folderRestrictedSql` and the open twins' folder rules read the live pending coverage. The store keeps no `page_label_guards` rows, so `guarded` is false. |
| `listOpenFactsWindow`, `countOpenFactReasons` | `open-facts` preview | `open-facts-scans.ts` | `src/facts/open_facts_scans.rs` | The class and the first reason in `openFactsReasonSql` order; a withdrawal or purge tombstone of either visibility counts. |
| `listLabelledPages`, `listLiveLabelRows`, `listClearDependents`, `listContextualRetrievalModes`, `listUnembeddedChunkPages` | `private-labels` preview | `private-label-scans.ts` | `src/facts/private_label_scans.rs` | The dependents read judges each candidate on a shadowed read of the store (the window's label keys removed from the cleared pages), as `dependentsSql('clear')` shadows `pages`. |

Ties a statement leaves to the planner (`listOpenTwinRows`' `min(source_id)` and order, `readUntakenWaitingJobs`'
equal ages) break by bytes here.

Steps that stay raw and refuse by name on an engine without raw SQL: a fenced fact's or a page's label write in
`visibility`, the `open-facts` apply and `--undo`, the `private-labels` apply, a `fact-claim-dates` page move, and the
fence projection of a page write (`take-supersession`, `accepted-takes`, `redacted-facts`, `lost-fence-rows`).
