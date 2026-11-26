# The history repair reads (batch 6a)

The typed members the history repair kinds read and write through, so their previews run on a Rust brain. Each has
one SQL copy in `src/core/engine-sql/` and a store function here; the parity cases are in
`test/engine-parity/repair-history-kinds.test.ts`.

| Members | Repair kind | SQL | Store | Contract |
|---|---|---|---|---|
| `listVersionsByChangeReason`, `replaceVersionChangeReasons` | `purged-change-reasons` | `version-reasons.ts` | `src/repair_versions.rs` | The versions of a source's page rows (live or soft-deleted) whose `change_reason` is one of the texts, by id; the replace sets the replacement only on a named version that still holds the text it is named with and answers the ids set, by id. |
| `listRetainedVersionBodies` | `redacted-facts` | `version-reasons.ts` | `src/repair_versions.rs` | A page's versions with an inline body, newest first, at most `limit`. |
| `readArchivedVersionBody` | `accepted-takes` | `version-reasons.ts` | `src/repair_versions.rs` | The newest version of a page whose `receipt.archived.request_id` is the request. The store stamps `archived` only when the write context names a principal, the rule of `gbrain_stamp_version_attribution`. |
| `listOverwriteCandidates`, `listVersionsAfter`, `listOverwriteLivePages`, `readVersionContent` | `overwritten-edits` and its doctor check | `overwrite-reads.ts` | `src/repair_versions.rs` | A candidate is a version of a live page whose archiving request is a committed managed-sync import (`intent.kind`, or a compacted receipt of an imported file that is no connector database write) and whose writing request is a committed database write that published no file; no `git` effect carries the version's revision. Request JSON is read with SQL's `->>` text rule. Newest version first. |
| `listAcceptedTakeRemovals` | `accepted-takes` | `takes-reads.ts` | `src/trust/proposals.rs` | Accepted `forget` proposals on takes (not proposed by `takes_remove`, change `deactivated` or `replaced`) joined to the committed `takes_remove` request whose `intent.trust_accept` names them, with a page and a numeric `intent.row_num`, by proposal id. |
| `readTakeRowTier` | `accepted-takes` | `takes-reads.ts` | `src/takes/reads.rs` | The id and stored trust tier of the take in one row of a page. |
| `listRedactedFactCandidates`, `restoreRedactedFactTexts`, `listProjectedFenceRows` | `redacted-facts` | `fact-text-repair.ts` | `src/facts/text_repair.rs` | Active unsuperseded facts whose text holds `[redacted`, by (source, id); the restore rewrites a row only while text, visibility, entity, holding page and row number are as previewed (a fenced row only for the conversation extractor) and appends the marker to its context. |
| `listUnexpiredFactIds`, `lockFactRows`, `expireFactWithNote`, `expirePageFactsBySource`, `readMaxFactRowNum` | `conversation-labels` retirement | `fact-text-repair.ts` | `src/facts/text_repair.rs` | `lockFactRows` makes no store call: a store write transaction holds the whole store until it ends. Every write goes through `write_fact`, so the trust stamp and the withdrawal trigger run. |
| `listRestorableAtoms`, `countKeptAtomRetirements` | `atoms-restore` | `atom-restore-reads.ts` | `src/page_ops/atom_restore.rs` | `atomRetirementsSql` as rows: each re-extraction retirement of the sources with its origin, replacement and latest-generation flags. With an atom id only that atom; its origin group, and so its flags, are the same under the narrower SQL scope. |
| `listLivePagesBySourcePaths`, `listLivePagesByFileName`, `listLivePagesSharingFrontmatterId`, `hasSegmentedHistory`, `readLivePagesByIds` | `moved-pages` verdict and apply recheck | `moved-page-reads.ts` | `src/moved_page_reads.rs` | Slugs sort in byte order (the SQL's order under the C collation). |

`overwritten-edits` restores through `revert_version`, whose version read is `readPageVersionRow` (`overwrite-reads.ts`,
`src/pages.rs`); the `moved-pages` access comparison is `listPageAccessKeys` and the `private-labels` preview reads are
typed (repair-applies.md), so those run on every engine.

Steps that stay raw and refuse by name on an engine without raw SQL: the page writes of `accepted-takes` and a fenced
`redacted-facts` restore (the fence projection of the page write), the `private-labels` apply, and the `moved-pages`
fold (`mergeTwinInto`, batch 6b).
