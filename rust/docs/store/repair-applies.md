# The repair applies and privacy scans

The typed members that let the applies of `gbrain repair consolidate-ties`, `duplicate-facts`, `extractor-facts`,
`fact-claim-dates`, `purged-page-facts`, `url-clone-fences`, the database-only `visibility` facts class and
`moved-pages`, the twin merge of `legacy-twins` and `origin-twins`, and the previews of `visibility`, `open-facts` and `private-labels`, run on a Rust brain. Each has one SQL
copy in `src/core/engine-sql/` (the statement its caller ran, unchanged) and a store function here. The parity cases are
in `test/engine-parity/repair-facts-previews-2.test.ts`, `-3`, `-4`, `repair-history-kinds.test.ts`,
`tie-purge-files-links-facts.test.ts`, `repair-owner-kinds.test.ts` and `twin-merge-rows.test.ts`.

| Members | Caller | SQL | Store | Contract |
|---|---|---|---|---|
| `restoreConsolidationTie`, `listLiveDuplicateRows`, `supersedeDuplicateFacts`, `linkStruckDuplicateFacts`, `listCommittedRestorePages`, `listActivePositionedFactIds`, `readFactRestorePage`, `restoreExtractorFact`, `moveFactClaimDates`, `lockApprovedFacts`, `expireApprovedFacts`, `tightenDatabaseFactVisibility`, `detachFenceRowFacts`, `hasDatabaseOnlyClaim` | the fact applies | `repair-applies.ts` | `src/facts/repair_applies.rs` | Each write reads the rows the statement's `WHERE` names and saves the changed ones through `write_fact`, so the trust stamp, the withdrawal guard, the purge guard and the unique indexes run as for the `UPDATE`. `now()` is the store clock, read once per call. `lockApprovedFacts` makes no store call: a store write transaction holds the whole store. A `timestamptz` argument is parsed as text (a JS `Date` arrives as its ISO text, milliseconds, as postgres.js sends it). |
| `listPageAccessKeys` | `moved-pages` | `repair-applies.ts` | `src/facts/repair_applies.rs` | Per page: `page_readers` (`gbrain_access_readers`), the folder rule ids the last stamp kept, `readable_by` and the snapshot filter. |
| `listCheckoutFilePages`, `listTypePageBodies`, `readSourceCloneRow` | label writes, `page-to-link`, the url-clone check | `repair-applies.ts` | `src/facts/repair_applies.rs` | Byte order for slugs; `listTypePageBodies` ties on page id. |
| `readPageVersionRow` | `revert_version` (`overwritten-edits`) | `overwrite-reads.ts` | `src/pages.rs` | The whole version row, as `createVersion` returns one. |
| `readAtomGeneration`, `recordAtomGenerationBump` | `stale-atoms` | `atom-generation.ts` | `src/persistence/op_checkpoint.rs` | The `managed-atoms-generation` ledger row; the bump drops the source page's `managed-atoms` runs of other content. The store keeps no `extract_atoms_page_state` rows, so that delete finds nothing. |
| `listPageRelationshipKeys`, `moveTwinRelations`, `moveTwinPageRows`, `moveTwinFacts`, `recordSlugRename` | the twin merge (`legacy-twins`, `origin-twins`) | `twin-merge.ts` | `src/twin_merge.rs` | Twin merge: the twin's loser link and transition rows (`listTwinMergeLosers`) go, then its other rows point at the survivor; rows between the pair stay. Timeline rows that repeat a survivor row, event projections on a date the survivor has, raw data of a source the survivor has, page aliases the survivor has and the twin's import-owned tags stay on the twin. A moved tag advances both pages' revisions; a claim change alone does not. A moved timeline row is rewritten as an update and the event index follows it. A moved fact goes through `write_fact`. Moved ids answer in id order. A move that would point a row at a page that does not exist is refused (`constraint_violation`), as the foreign keys refuse it. |
| `listAtomLineageRows`, `listChronicleEventVisibilityRows`, `listAliasOnlyPrivatePages`, `listConceptLineageRows`, `listConceptInputRows`, `listNamedVisibilityRows`, `listOpenTwinRows` | `visibility` preview | `visibility-scans.ts`, `facts-repair.ts`, `open-twins.ts` | `src/facts/visibility_scans.rs` | `length(compiled_truth)` counts characters (null for a segmented page). `folderRestrictedSql` and the open twins' folder rules read the live pending coverage. The store keeps no `page_label_guards` rows, so `guarded` is false. |
| `listOpenFactsWindow`, `countOpenFactReasons` | `open-facts` preview | `open-facts-scans.ts` | `src/facts/open_facts_scans.rs` | The class and the first reason in `openFactsReasonSql` order; a withdrawal or purge tombstone of either visibility counts. |
| `listLabelledPages`, `listLiveLabelRows`, `listClearDependents`, `listContextualRetrievalModes`, `listUnembeddedChunkPages` | `private-labels` preview | `private-label-scans.ts` | `src/facts/private_label_scans.rs` | The dependents read judges each candidate on a shadowed read of the store (the window's label keys removed from the cleared pages), as `dependentsSql('clear')` shadows `pages`. |

Ties a statement leaves to the planner (`listOpenTwinRows`' `min(source_id)` and order, `readUntakenWaitingJobs`'
equal ages) break by bytes here.

Steps that stay raw and refuse by name on an engine without raw SQL: a fenced fact's or a page's label write in
`visibility`, the `open-facts` apply and `--undo`, the `private-labels` apply, the `moved-pages` fold (its `page_versions` move), a `fact-claim-dates` page move, and the
fence projection of a page write (`take-supersession`, `accepted-takes`, `redacted-facts`, `lost-fence-rows`).
