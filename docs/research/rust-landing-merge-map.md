# Rust landing merge map: trunk + https://github.com/garrytan/gbrain/pull/9823

Trunk `rust-engine/main` 5f0b025b55, PR head d1190b8aeb, merge-base 7d45c5d17e. Measured with
`git -c merge.conflictStyle=diff3 merge --no-ff --no-commit d1190b8aeb` on the trunk. 170 files conflict, in 305 blocks.

Keep values: `trunk` = the trunk side as is; `pr` = the PR side; `merged` = both sides combined (summary in the last column);
`regenerated` = a generated file rebuilt from the merged tree. "Why" names the reason in one line.

Counts: merged 66, pr 3, regenerated 24, trunk 212.

A blanket "keep trunk" rule is wrong: the trunk lacks the land-1 (https://github.com/garrytan/gbrain/pull/9807) and land-2
(https://github.com/garrytan/gbrain/pull/9819) review fixes, so 120 blocks keep PR lines.

## Edits outside the conflict blocks

| File | Why |
|---|---|
| `src/core/engine-sql/write-attribution.ts` | Master https://github.com/garrytan/gbrain/pull/9704 put the owner-only take/timeline filter in SQL the trunk moved here; ported: optional excludePrivate on the take and timeline targets, ownerOnlyTakeAllowedSql('takes') / ownerOnlyTimelineAllowedSql('timeline_entries') appended through trustedSql. A clean merge would have dropped it. |
| `src/core/engine-sql/takes-reads.ts` | Same port for countMcpResolvedTakes: `${privatePagesFilterForCaller('p')}${ownerOnlyTakeAllowedSql('t')}`. |
| `rust/crates/gbrain-store/src/owner_only.rs` | Master #9704 privacy.rs semantics moved to the trunk's refactored file: the closed form also reads the held flag (a mark), so it keeps hiding after a source stops being owner-only. |
| `rust/crates/gbrain-store/src/facts/privacy.rs (test)` | Ported master's test: a mark keeps the closed form hiding; the per-row form hides only marked rows. |
| `src/core/schema-migrations/v329 -> v330-projection-jobs-byte-order-index.ts` | Collision: master released v329-serves-since-subsecond (v0.60.748.0). The trunk migration is renumbered to 330 (export, version, buildIndexOnline id), with its test and master-gaps doc. Needs the trunk owner's yes. |
| `test/migrations-golden.test.ts` | Removed the '328 is reserved for #9704' note; gaps = [17, 18, 19, 100]. |
| `rust/crates/gbrain-store/tests/facts_extractor_classify.rs` | Trunk test inserted its active duplicate after a `*` withdrawal; the PR side's gbrain_preserve_fact_withdrawal port (as Postgres does) saves that row expired. The duplicate now comes first. |
| `rust/crates/gbrain-store/tests/facts_review_guards.rs, tests/salience.rs, examples/keyword_scale.rs` | PR-side wire value ownerOnly 'lineage' is refused by the trunk's OwnerOnlyForm (off/fn/closed); changed to 'fn'. |
| `src/core/rust-engine/store-members/page-ops.ts` | Removed a duplicate checkBatch the merge produced; file equals the trunk. |
| `docs/ENGINES.md` | Bundle budget: dropped the trunk's duplicate 'Vector search' bullet (its one unique clause folded into 'Vectors and embeddings'), a redundant chunks parenthetical, and shortened the page_body sentence. |
| `scripts/check-engine-sql-dynamic.ts` | Added ownerOnlyTimelineAllowedSql to VETTED_BUILDERS (same reason as ownerOnlyTakeAllowedSql, timeline alias); without it the ported #9704 timeline filter fails the dynamic-SQL check. |
| `docs/architecture/key-files/engines-2-continued.md` | Merged text was 63318 bytes, over the 60000 cap; moved its last 5 entries (persistence-effect-scans, persistence-effect-worker, persistence-idle-probe, persistence-embedding-noop-settle, search-filters) to the top of engines-2-more.md. Now 57752 and 46359 bytes. |
| `test/rust-engine-shell.test.ts` | The PR's two 'early client call' tests assume a client can reach the owner socket while the store opens (the PR's _storeReady wait). The trunk's election opens the store before the socket listens, and the merge keeps the trunk engine, so the tests failed with ENOENT. Rewrote them to assert the trunk contract: no client connects while the open is pending, and the owner role is given up when the open fails or is abandoned. 14 pass. |

Not in this merge: the Rust store's `readRowAttribution` sends no `excludePrivate` for take and timeline rows. The trunk
owns that fix (`write_attribution.rs`) and lands it before its master sync.

## Blocks

| File | Block (line) | Keep | Why | Merged text |
|---|---|---|---|---|
| `README.md` | 1 (395) | merged | PR served-domain list is current; 'nothing selects it yet' changed to opt-in because constructEngine accepts engine 'rust' on trunk | PR served-domain list, with the opt-in wording |
| `TODOS.md` | 1 (3) | trunk | every line the PR adds is on the trunk side |  |
| `docs/ENGINES.md` | 1 (1701) | merged | Trunk code serves 30 capabilities (checked with trunk src); PR list had 22 | Full 30-capability list; persistence_journal held back |
| `docs/ENGINES.md` | 2 (1767) | pr | Trunk serves revertToVersion | PR two lines adding revertToVersion |
| `docs/ENGINES.md` | 3 (1844) | trunk | every line the PR adds is on the trunk side |  |
| `docs/ENGINES.md` | 4 (1865) | merged | Trunk vector bullets plus the PR bullet on raw-data, page-operation, salience, facts, ontology, chronicle and code-edge inputs | Trunk two vector bullets + PR privacy-input bullet |
| `docs/architecture/canonical-writers.tsv` | 1 (150) | trunk | every line the PR adds is on the trunk side |  |
| `docs/architecture/key-files/engines-2-continued.md` | 1 (25) | merged | Written from merged code: owner election and takeover, timeout reasons, served modules, still-refused members | Shell, store and owner-ipc bullets rewritten |
| `docs/architecture/key-files/security-continued.md` | 1 (12) | merged | Master's #9704 text (ownerOnlyTakeSql/TimelineSql, v328 mode, OWNER_ONLY_HELD) is current; the trunk's typed-member sentence is kept after the imessage e2e sentence. | PR (master) text plus the trunk sentence on ownerOnlySourcesPresent/sourceIsOwnerOnly reading through typed engine members. |
| `docs/designs/RUST_ENGINE.md` | 1 (725) | merged | Open-before-selection table: trunk rows 4 and 7 kept with numbers; PR rows 6, 10, 12, 16, 18, 19 still open on trunk added; PR rows 1,2,3,5 fixed, 7,8,11,13 stale (excludePrivate served), 9,14,15,17 not confirmed/fixed and dropped | Rows 4, 6, 7, 10, 12, 16, 18, 19 |
| `docs/designs/RUST_ENGINE_INTERFACES.md` | 1 (887) | merged | Trunk text; PR's move_slug_rows is an old name, the function is facts::rename_slug_rows | Trunk side with cascade::rename_slug_rows calls facts::rename_slug_rows |
| `llms-full.txt` | 1 (4612) | regenerated | Generated bundle; rebuilt with bun run build:llms from the merged docs. | Output of build:llms; 799984 of 800000 bytes after the ENGINES.md trim. |
| `llms-full.txt` | 2 (6355) | regenerated | Generated bundle; rebuilt with bun run build:llms from the merged docs. | Output of build:llms; 799984 of 800000 bytes after the ENGINES.md trim. |
| `llms-full.txt` | 3 (6421) | regenerated | Generated bundle; rebuilt with bun run build:llms from the merged docs. | Output of build:llms; 799984 of 800000 bytes after the ENGINES.md trim. |
| `llms-full.txt` | 4 (6498) | trunk | every line the PR adds is on the trunk side |  |
| `llms-full.txt` | 5 (6519) | regenerated | Generated bundle; rebuilt with bun run build:llms from the merged docs. | Output of build:llms; 799984 of 800000 bytes after the ENGINES.md trim. |
| `rust/crates/gbrain-napi/src/families/decide_proposals.rs` | 1 (1) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-napi/src/families/facts_cycle.rs` | 1 (1) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-napi/src/families/facts_purge.rs` | 1 (1) | trunk | every line the PR adds is already in the trunk file (moved) |  |
| `rust/crates/gbrain-napi/src/families/facts_repair.rs` | 1 (1) | trunk | the 5 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-napi/src/families/facts_trust.rs` | 1 (1) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-napi/src/families/facts_trust_reads.rs` | 1 (1) | trunk | the 3 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-napi/src/families/jobs.rs` | 1 (1) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-napi/src/families/jobs/spend_log.rs` | 1 (1) | trunk | the 2 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-napi/src/families/mod.rs` | 1 (32) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-napi/src/families/mod.rs` | 2 (59) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-napi/src/families/mod.rs` | 3 (98) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-napi/src/families/page_ops.rs` | 1 (18) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-napi/src/families/raw_files.rs` | 1 (3) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-napi/src/families/timeline_queries.rs` | 1 (3) | trunk | the 2 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-napi/src/families/timeline_queries.rs` | 2 (87) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-napi/src/families/trust.rs` | 1 (1) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-napi/src/families/trust_fence.rs` | 1 (1) | trunk | the 2 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-napi/src/families/trust_tier_reads.rs` | 1 (1) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-napi/src/families/write_guards.rs` | 1 (1) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/examples/keyword_scale.rs` | 1 (1) | trunk | The PR copy is the first, scan-only version of the tool; the trunk file is its later rewrite with the index modes and keeps every mode the PR had (load, queries, run). | Nothing added: the trunk file already covers the PR intent (50,000-page measurement) and the 23 listed lines are older doc/loop text. |
| `rust/crates/gbrain-store/src/aliases.rs` | 1 (32) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/aliases.rs` | 2 (66) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/cascade.rs` | 1 (37) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/chunk_queries.rs` | 1 (31) | merged | Trunk layout kept; PR intent is that the activation marker counts as served. | Trunk plus `use crate::keyword::served;`. |
| `rust/crates/gbrain-store/src/chunk_queries.rs` | 2 (198) | merged | Same intent as block 1, doc side. | Trunk plus doc text 'served (sealed, or the v153 activation marker)'. |
| `rust/crates/gbrain-store/src/chunk_queries.rs` | 3 (257) | merged | Trunk test code kept; the PR's older ChunkPageOptions initializer lacked trunk's exclude_private/require_safe_chunks. | Trunk plus doc text; the PR's marker test now fills `exclude_private: None, require_safe_chunks: false` so it compiles against trunk's struct. |
| `rust/crates/gbrain-store/src/chunks.rs` | 1 (1407) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/chunks.rs` | 2 (1426) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/cli_reads/mod.rs` | 1 (5) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/cli_reads/pg_text.rs` | 1 (1) | trunk | the 11 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/code_edges.rs` | 1 (33) | trunk | the 2 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/code_edges.rs` | 2 (587) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/code_edges/traversal_cache.rs` | 1 (1) | trunk | the 3 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/contradictions.rs` | 1 (14) | trunk | the 4 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/dream.rs` | 1 (8) | trunk | the 13 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/eval_capture/calibration_profiles.rs` | 1 (1) | merged | Trunk kept; PR adds refusal of non-finite reals. | Trunk plus `!x.is_finite()` refusal in `to_real`. |
| `rust/crates/gbrain-store/src/eval_capture/decide_proposals.rs` | 1 (1) | merged | Trunk kept; PR adds refusal of non-finite reals. | Trunk plus `!value.is_finite()` refusal in `real_arg`. |
| `rust/crates/gbrain-store/src/facts.rs` | 1 (11) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/facts.rs` | 2 (72) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/facts.rs` | 3 (83) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/facts.rs` | 4 (100) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/facts.rs` | 5 (127) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/facts.rs` | 6 (154) | merged | add/add file rebuilt from trunk (stage 2); PR adds with_query_stack import. | `with_query_stack` added to the `crate::keyword` import. |
| `rust/crates/gbrain-store/src/facts.rs` | 7 (276) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/facts.rs` | 8 (297) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/facts.rs` | 9 (947) | merged | Trunk write_fact kept; PR intent is to keep an earlier withdrawal across a rewrite. | `write_fact` stamps, then `preserve_withdrawal(tx, old, &mut stamped)` (new fn using `purge::earliest_withdrawal`), then `purge_ledger::refuse_purged`. Stale PR admits/listed/visibility_admits/world_only text dropped. |
| `rust/crates/gbrain-store/src/facts.rs` | 10 (1430) | merged | Trunk kept; PR intents added by hand onto trunk names. | Added PAGE_EXTRACTION_SOURCES, context_head, `expire_gone_page_facts`; keyword duplicate walk wrapped in `with_query_stack`; `source_session` cloned; hidden_by_policy and rename_slug_rows docs; `move_subject_in` call in rename_slug_rows; three tests (rename moves facts, retention purge expires facts, deep keyword duplicate walk). |
| `rust/crates/gbrain-store/src/facts/cycle.rs` | 1 (1) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/facts/doctor.rs` | 1 (1) | merged | Trunk kept; PR adds withdrawal-aware embedding input. | Trunk plus `withdrawn_for_embedding`. |
| `rust/crates/gbrain-store/src/facts/fence.rs` | 1 (1) | trunk | every line the PR adds is already in the trunk file (moved) |  |
| `rust/crates/gbrain-store/src/facts/generations.rs` | 1 (1) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/facts/loops.rs` | 1 (1) | merged | Trunk kept; PR adds a confidence-range check. | Trunk plus confidence-range refusal in `upsert_open_loop`, and a test. |
| `rust/crates/gbrain-store/src/facts/privacy.rs` | 1 (28) | trunk | the 5 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/facts/privacy.rs` | 2 (75) | trunk | Master #9704's OwnerOnly enum docs and closed-form arm; the trunk moved the enum to owner_only.rs (OwnerOnlyForm), where the held-flag rule is ported. | Trunk text; semantics in owner_only.rs fact_hidden Closed => guarded(). |
| `rust/crates/gbrain-store/src/facts/privacy.rs` | 3 (334) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/facts/privacy.rs` | 4 (350) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/facts/privacy.rs` | 5 (369) | trunk | PR dropped the always-true restricted flag; trunk's memory_mutation_reads passes a real floor.restricted, so the intent does not apply. | No change; trunk's `hidden_by_provenance_page(read,row,policy,restricted)` kept. |
| `rust/crates/gbrain-store/src/facts/privacy.rs` | 6 (412) | merged | add/add file rebuilt from trunk; PR adds the GBRA-574 bare-name-key rule. | Added `NAME_KEY_PAGE_DIRS` and the bare-name-key arm in `hidden_by_private_provenance`. |
| `rust/crates/gbrain-store/src/facts/privacy.rs` | 7 (542) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/facts/privacy.rs` | 8 (575) | trunk | Master's closed form reading the held flag; the trunk calls owner_only.page_hidden, whose Closed arm now returns guarded() (sources or a mark). | Trunk text; semantics in owner_only.rs page_hidden Closed => guarded(). |
| `rust/crates/gbrain-store/src/facts/privacy.rs` | 9 (770) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/facts/privacy.rs` | 10 (1183) | merged | PR test mapped to trunk names (OwnerOnly::Lineage -> OwnerOnlyForm::Fn). | Appended test `a_bare_entity_key_is_hidden_by_its_private_directory_page`; stale vault/mark test lines dropped. |
| `rust/crates/gbrain-store/src/facts/purge.rs` | 1 (1) | merged | Trunk kept; PR adds earliest-withdrawal lookup. | Trunk plus `pub(crate) fn earliest_withdrawal(read,row)`. |
| `rust/crates/gbrain-store/src/facts/reconcile.rs` | 1 (1) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/facts/relink_writes.rs` | 1 (1) | trunk | the 2 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/facts/repair.rs` | 1 (1) | trunk | every line the PR adds is already in the trunk file (moved) |  |
| `rust/crates/gbrain-store/src/facts/trust.rs` | 1 (1) | trunk | the 7 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/facts/trust_reads.rs` | 1 (1) | trunk | the 3 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/jobs.rs` | 1 (11) | trunk | the 6 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/jobs/checks.rs` | 1 (1) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/jobs/inbox.rs` | 1 (1) | trunk | the 2 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/jobs/oauth_clients.rs` | 1 (1) | trunk | the 19 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/jobs/reads.rs` | 1 (1) | trunk | the 2 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/jobs/status.rs` | 1 (1) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/jobs/subagent.rs` | 1 (1) | trunk | the 6 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/journal.rs` | 1 (213) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/journal.rs` | 2 (243) | trunk | every line the PR adds is already in the trunk file (moved) |  |
| `rust/crates/gbrain-store/src/journal.rs` | 3 (251) | trunk | every line the PR adds is already in the trunk file (moved) |  |
| `rust/crates/gbrain-store/src/journal.rs` | 4 (259) | trunk | every line the PR adds is already in the trunk file (moved) |  |
| `rust/crates/gbrain-store/src/journal.rs` | 5 (269) | trunk | every line the PR adds is already in the trunk file (moved) |  |
| `rust/crates/gbrain-store/src/journal.rs` | 6 (449) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/keys.rs` | 1 (85) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/keyword.rs` | 1 (70) | merged | Both re-exports are needed. | Both `pub use cjk::{...}` and `pub(crate) use filters::served;`. |
| `rust/crates/gbrain-store/src/keyword/page_search.rs` | 1 (31) | merged | Trunk kept; PR adds with_query_stack import. | Import list includes `with_query_stack`. |
| `rust/crates/gbrain-store/src/keyword/page_search.rs` | 2 (73) | merged | Trunk walk kept; PR runs it on a deep stack. | `keyword_pages` takes `visit: impl FnMut(PageRecord, Best)->bool + Send`; walk_chunks body wrapped in `with_query_stack(items, ...)`; `cjk_keyword_pages` left as trunk. |
| `rust/crates/gbrain-store/src/keyword/page_search.rs` | 3 (96) | merged | Trunk kept; deep-spawn test already present. | Test `a_deep_query_walks_every_page_on_one_deep_thread` kept; trunk text otherwise. |
| `rust/crates/gbrain-store/src/keyword/page_search.rs` | 4 (317) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/lib.rs` | 1 (56) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/lib.rs` | 2 (86) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/lib.rs` | 3 (485) | trunk | the 2 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/ontology.rs` | 1 (10) | merged | Trunk kept; PR compares the f32 floor. | Trunk plus f32 floor compare in `admits`, and a test. |
| `rust/crates/gbrain-store/src/page_body.rs` | 1 (962) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/page_body.rs` | 2 (1438) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/page_ops.rs` | 1 (11) | merged | add/add file rebuilt from trunk; PR names the first embedded chunk in the sampler. | `representative_chunk(read,page_id)` (lowest chunk_index with embed dims>0) used by `domain_bank_row`; doc updated; trunk `retrieved` kept. |
| `rust/crates/gbrain-store/src/page_ops.rs` | 2 (59) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/page_ops.rs` | 3 (77) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/page_ops.rs` | 4 (1411) | merged | Trunk purge kept; PR adds text/staging cleanup and fact expiry. | purge collects page_text_refs, removes page, delete_slug_stagings, delete_purged_texts, scrub_purged_slugs, `facts::expire_gone_page_facts` with write trust. |
| `rust/crates/gbrain-store/src/page_ops.rs` | 5 (2369) | merged | Trunk tests kept; PR sampler test added. PR's segmented-revert put_json variant not adopted (trunk snapshot_in does not refuse segmented pages). | Added `the_samplers_name_the_first_embedded_chunk`; trunk `revert_refuses_a_segmented_version_of_an_inline_page` kept. |
| `rust/crates/gbrain-store/src/pages.rs` | 1 (175) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/pages.rs` | 2 (448) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/pages.rs` | 3 (654) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/pages.rs` | 4 (682) | trunk | the 2 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/pages.rs` | 5 (1354) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/pages.rs` | 6 (2262) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/persistence.rs` | 1 (11) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/persistence.rs` | 2 (74) | merged | Trunk kept; PR adds NUL check and overflow-safe sums. | NUL check on principal_id; i128/checked_sub sums in `complete_write_row_in`. |
| `rust/crates/gbrain-store/src/persistence/effect_scans.rs` | 1 (1) | trunk | the 16 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/persistence/effects.rs` | 1 (1) | merged | Trunk kept; PR lowercases identifiers. Went one step beyond the PR: also lowercased the request id in trunk's `insert_withdrawal_effects_in`. | Lowercased request id, revision, source incarnation, worktree id. |
| `rust/crates/gbrain-store/src/persistence/housekeeping.rs` | 1 (1) | merged | Trunk kept; PR adds compaction byte count. | Trunk plus `compacted_bytes(r, effect_bytes)`. |
| `rust/crates/gbrain-store/src/persistence/projection_queue.rs` | 1 (1) | trunk | the 17 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/persistence/topology.rs` | 1 (1) | trunk | the 2 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/raw_files.rs` | 1 (17) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/raw_files.rs` | 2 (43) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/raw_files.rs` | 3 (69) | trunk | the 14 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/raw_files.rs` | 4 (642) | merged | Trunk kept (jsonb ordering moved to crate::jsonb); PR makes sourceIds a set returned in SQL order. | Doc updated; `get_raw_data` sorts and dedups scoped ids. Stale PR test `jsonb_orders_keys_by_length_then_bytes` dropped. |
| `rust/crates/gbrain-store/src/salience.rs` | 1 (146) | trunk | Trunk already has exclude_private and the owner_only.page_hidden check; the PR lines are docs only. | Trunk unchanged. |
| `rust/crates/gbrain-store/src/sources.rs` | 1 (108) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/telemetry.rs` | 1 (1) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/timeline_queries.rs` | 1 (3) | trunk | the 3 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/timeline_queries.rs` | 2 (27) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/timeline_queries.rs` | 3 (70) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/timeline_queries.rs` | 4 (97) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/timeline_queries.rs` | 5 (713) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/trust.rs` | 1 (32) | trunk | the 6 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/trust/proposals.rs` | 1 (1) | trunk | the 2 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/trust/tier_reads.rs` | 1 (1) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/trust/valid_time.rs` | 1 (1) | trunk | the 2 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/trust/withdrawals.rs` | 1 (1) | merged | Trunk kept; PR adds withdrawal listing and subject move. | Trunk plus `withdrawals_of(read,source_id,visibility,claim)` and `pub(crate) fn move_subject_in(tx,source_id,old_slug,new_slug)`. |
| `rust/crates/gbrain-store/src/trust/write_gate.rs` | 1 (1) | merged | Trunk kept; PR adds checked cutoff arithmetic. | Checked arithmetic in `delete_stale_write_gate_receipts`, and a test. |
| `rust/crates/gbrain-store/src/wanted_links.rs` | 1 (20) | trunk | the 3 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/wanted_links.rs` | 2 (447) | trunk | the 12 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/write_guards.rs` | 1 (1) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/write_trust.rs` | 1 (1) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/tests/calibration_profiles.rs` | 1 (1) | merged | Trunk file plus the PR test that a NaN or infinity in any of four profile columns is refused and stores no row. | Appended a_non_finite_native_number_is_refused_and_leaves_no_row after the trunk tests. |
| `rust/crates/gbrain-store/tests/decide_proposals.rs` | 1 (1) | merged | Trunk file (keeps the trunk PendingContradictionsFilter import and pending-contradiction test) plus the PR test that non-finite numbers are refused before a proposal takes an id. | Appended a_non_finite_native_number_is_refused_before_a_proposal_takes_an_id; dropped the older import line. |
| `rust/crates/gbrain-store/tests/facts.rs` | 1 (1) | trunk | Trunk already moved these policies to the new owner-only form ("fn"); the PR "lineage" value is the older spelling the trunk enum no longer accepts. | Nothing added. |
| `rust/crates/gbrain-store/tests/facts_cycle.rs` | 1 (1) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/tests/facts_doctor.rs` | 1 (1) | merged | Trunk file (keeps its stale-embedding count checks) plus the PR test that a claim withdrawn after it was saved leaves the embedding coverage count. | Appended embedding_coverage_leaves_out_a_claim_withdrawn_after_it_was_saved. |
| `rust/crates/gbrain-store/tests/facts_purge.rs` | 1 (1) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/tests/facts_trust.rs` | 1 (1) | trunk | the 2 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/tests/facts_trust_reads.rs` | 1 (1) | trunk | the 4 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/tests/jobs.rs` | 1 (1) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/tests/jobs_wake.rs` | 1 (1) | trunk | the 2 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/tests/ontology.rs` | 1 (1) | merged | Trunk file plus the PR test that a confidence floor is compared as the stored REAL. | Appended a_confidence_floor_is_compared_as_the_stored_real. |
| `rust/crates/gbrain-store/tests/page_ops.rs` | 1 (66) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/tests/page_ops.rs` | 2 (1431) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/tests/persistence.rs` | 1 (1) | merged | Trunk file (keeps the trunk write-cancellation tests and imports) plus the PR test that a NUL in a request principal id is refused. | Inserted a_principal_id_with_a_nul_byte_is_refused_before_a_duplicate_could_slip_in after the counters test. |
| `rust/crates/gbrain-store/tests/publication_effects.rs` | 1 (1) | merged | Trunk file (keeps the trunk claim and settle tests, which use the new signatures) plus the land-2 tests for canonical request ids, true-up counting, a worktree on an effect, and overflowing completion bytes. | Appended four tests unchanged: uppercase request id, true-up unfinished effect, worktree effect refusal, completion byte overflow; dropped the older no-claimable-kind test and imports. |
| `rust/crates/gbrain-store/tests/raw_files.rs` | 1 (1) | merged | Trunk file (keeps list_files test and listFiles doc line) plus the PR test that raw data comes back in SQL order and a repeated source reads once. | Inserted raw_data_comes_in_sql_order_and_a_repeated_source_reads_once before the refusals test. |
| `rust/crates/gbrain-store/tests/spend_log.rs` | 1 (1) | trunk | the 2 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/tests/stats.rs` | 1 (13) | trunk | Trunk policies use ..Default::default() for owner_only; the PR OwnerOnly::Lineage type no longer exists in the trunk. | Nothing added. |
| `rust/crates/gbrain-store/tests/stats.rs` | 2 (278) | trunk | Same: the PR block only adds the removed OwnerOnly::Lineage field and older clone-free asserts. | Nothing added. |
| `rust/crates/gbrain-store/tests/timeline_queries.rs` | 1 (13) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/tests/timeline_queries.rs` | 2 (369) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/tests/trust_tier_reads.rs` | 1 (1) | trunk | the 7 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/tests/valid_time.rs` | 1 (1) | trunk | the 8 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/tests/write_guards.rs` | 1 (1) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/docs/store/aliases.md` | 1 (24) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/docs/store/aliases.md` | 2 (68) | trunk | Trunk serves minTrust and suppressFlagged on resolveAliases and aliasCanonicalRefs (aliases.rs, aliases.ts); PR says refused | Trunk rows |
| `rust/docs/store/aliases.md` | 3 (108) | merged | PR facts::rename_slug_rows moves withdrawals first via move_subject_in; trunk contextualRetrieval bullet kept | PR facts-entry text + trunk contextualRetrieval bullet |
| `rust/docs/store/aliases.md` | 4 (129) | trunk | Trunk refusal text; PR refusal of minTrust/suppressFlagged is stale | Trunk side |
| `rust/docs/store/calibration-profiles.md` | 1 (1) | merged | Trunk text plus the PR NaN/infinity REAL refusal on reads and writes (merged code refuses); PR landing text dropped | Trunk with NaN bullet |
| `rust/docs/store/code_edges.md` | 1 (1) | trunk | Trunk text is current; PR text says not served yet | Trunk side |
| `rust/docs/store/decide-proposals.md` | 1 (1) | trunk | PR text is old landing text; transactions are served | Trunk side |
| `rust/docs/store/decide-store.md` | 1 (1) | trunk | decide-store.ts exists on trunk; PR says it arrives later | Trunk side |
| `rust/docs/store/facts.md` | 1 (10) | trunk | the 2 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/docs/store/facts.md` | 2 (40) | merged | Trunk text (purge ledger, fence overlay, held cells, withdrawal discovery) plus PR: NAME_KEY_PAGE_DIRS keyed-slug rule, withdrawal ledger guard in write_fact, rename moves withdrawals, expire_gone_page_facts, countFactEmbeddingCoverage skips withdrawn claims | Trunk plus 6 PR edits; PR old-landing refused/transaction text dropped |
| `rust/docs/store/jobs.md` | 1 (1) | trunk | the 4 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/docs/store/keyword.md` | 1 (1) | merged | Trunk text plus PR sentence that the engine serves no source delete | Trunk side with one sentence |
| `rust/docs/store/keyword.md` | 2 (871) | trunk | every line the PR adds is on the trunk side |  |
| `rust/docs/store/ontology.md` | 1 (1) | pr | Merged ontology.rs evaluates the supersede guard and compares minConfidence at f32; trunk text says guard always passes. takesHoldersAllowList reason rewritten to PGLite does not read them | PR guard text, f32 floor, rewritten ignored-options reason |
| `rust/docs/store/page_ops.md` | 1 (11) | merged | pages capability unreported while four members refuse (checked on trunk); trunk read scope kept | Capability sentence with four members + trunk read scope |
| `rust/docs/store/page_ops.md` | 2 (35) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/docs/store/page_ops.md` | 3 (72) | merged | Merged page_ops.rs picks representative chunk and retrieval record; purge expires facts and deletes body stagings and segment texts | Trunk retrieval records + PR representative_chunk_id and purge bullets |
| `rust/docs/store/persistence.md` | 1 (1) | merged | Trunk text plus PR NUL-in-principal-id refusal on insertWriteRequest (merged persistence.rs refuses) | Trunk with one clause |
| `rust/docs/store/raw_files.md` | 1 (1) | merged | Trunk text with PR getRawData row (byte order, repeated source read once; merged raw_files.rs sorts and dedups); trunk excludePrivate bullet kept | Trunk with PR getRawData row |
| `rust/docs/store/salience.md` | 1 (46) | trunk | Trunk applies excludePrivate on both reads and serves minTrust/suppressFlagged on getSalienceScores; removed one trunk sentence that said link and timeline reads still refuse excludePrivate | Trunk bullets |
| `rust/docs/store/spend-log.md` | 1 (1) | trunk | PR text is old landing text (transactions not served, partial oauth_clients) | Trunk side |
| `rust/docs/store/stats.md` | 1 (49) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/docs/store/timeline_queries.md` | 1 (17) | trunk | every line the PR adds is on the trunk side |  |
| `rust/docs/store/timeline_queries.md` | 2 (75) | trunk | every line the PR adds is on the trunk side |  |
| `rust/docs/store/timeline_queries.md` | 3 (178) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/docs/store/trust.md` | 1 (1) | merged | Trunk text plus PR: rename moves withdrawals, fact-write withdrawal guard built, deleteStaleWriteGateReceipts retention refusal | Trunk with three PR edits |
| `rust/docs/store/wanted-links.md` | 1 (1) | trunk | the 2 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/docs/store/write-guards.md` | 1 (1) | trunk | the 4 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/docs/store/write_trust.md` | 1 (1) | trunk | Trunk says transactions are served; PR says not served | Trunk side |
| `scripts/check-orphan-modules.mjs` | 1 (58) | trunk | The trunk wired the Rust engine into engine construction and removed its whole held list; holding the owner-ipc modules would now be stale entries, and the guard reports none of them as orphaned. | Nothing added; the 8 owner-ipc hold entries are not needed because those modules are reachable from the engine. |
| `scripts/core-world-reads-baseline.tsv` | 1 (928) | merged | Trunk lines kept; the PR's protocol.ts fs_import row is needed because protocol.ts now resolves symlinks with realpath. | Added the owner-ipc/protocol.ts fs_import row (symlink-resolving store path) between the election.ts and server.ts rows; guard check-core-world-reads passes. |
| `scripts/engine-raw-sql-baseline.tsv` | 1 (434) | merged | writeback-settings.ts keeps the trunk count (1); the PR row for facts/writeback-audience.ts (GST-3180) is added. | Trunk row plus `src/core/facts/writeback-audience.ts execute_raw 1`. |
| `scripts/engine-raw-sql-baseline.tsv` | 2 (621) | merged | compaction-pass.ts is 1 and concept-rebuild.ts is lowered to 11 to match the merged code; check-engine-raw-sql-ratchet passes (4596 sites, 1051 files). | Counts recomputed for the merged tree. |
| `scripts/postgres-arm-weights-postgres-only.json` | 1 (62) | trunk | every line the PR adds is on the trunk side |  |
| `scripts/postgres-arm-weights.json` | 1 (154) | trunk | The trunk already weights private-page-reads.test.ts (7062, measured) and persistence.test.ts, so the PR's 11000 guess adds nothing. | Nothing added. |
| `src/core/ops/attribution.ts` | 1 (21) | merged | Trunk import of worldOnlyFacts plus the type-only RowAttributionTarget import the PR side needs. | `import { worldOnlyFacts }` + `import type { RowAttributionTarget }`. |
| `src/core/ops/attribution.ts` | 2 (217) | merged | Port of master #9704: the take target carries excludePrivate so the owner-only take filter applies on the trunk's engine-sql path. | `{ kind: 'take', pageId, rowNum: ids.take, excludePrivate, ...holders }`. |
| `src/core/ops/attribution.ts` | 3 (229) | merged | Same #9704 port for the timeline target. | `{ kind: 'timeline', id, pageId, excludePrivate }`. |
| `src/core/ops/takes.ts` | 1 (26) | trunk | The trunk moved the count to the engine (countMcpResolvedTakes); the master filter is ported there (engine-sql/takes-reads.ts). | Trunk import line. |
| `src/core/ops/takes.ts` | 2 (266) | trunk | Trunk calls ctx.engine.countMcpResolvedTakes; master's inline SQL with ownerOnlyTakeAllowedSql moves into engine-sql/takes-reads.ts. | Trunk call; filter text in takes-reads.ts is `${privatePagesFilterForCaller('p')}${ownerOnlyTakeAllowedSql('t')}`. |
| `src/core/rust-engine.ts` | 1 (4) | trunk | every line the PR adds is already in the trunk file (moved) |  |
| `src/core/rust-engine.ts` | 2 (68) | trunk | every line the PR adds is on the trunk side |  |
| `src/core/rust-engine.ts` | 3 (134) | trunk | The trunk's election (_elect/_runElection) opens the store before the owner socket serves, so no call reaches an engine without a store and a failed open rejects the waiting calls; the PR's _storeReady wait is not needed. | Nothing added; also removed the stale _open and leaveRole code the auto-merge had brought back, so the file now equals the trunk. |
| `src/core/rust-engine.ts` | 4 (149) | trunk | every line the PR adds is on the trunk side |  |
| `src/core/rust-engine.ts` | 5 (177) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine.ts` | 6 (194) | trunk | the 5 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine.ts` | 7 (214) | trunk | the 2 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine.ts` | 8 (366) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine.ts` | 9 (391) | trunk | the 2 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine.ts` | 10 (407) | trunk | The trunk's storeFor/storeAfterElection already waits for the election and rejects when it fails, which is the PR's intent of not hanging on a failed open. | Nothing added. |
| `src/core/rust-engine.ts` | 11 (587) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine/owner-ipc/client.ts` | 1 (1) | merged | Trunk client (with its owner takeover and recover step) kept; the PR's caller-access record and the sent/not_sent/queued timeout stages added on top. | Sends the caller's access record with each call, reports timeouts as sent or not_sent (outcome unknown once sent), and updates the header comment; STORE_MEMBERS routing was already in the trunk. |
| `src/core/rust-engine/owner-ipc/codec.ts` | 1 (1) | merged | Trunk codec kept; the PR's own-property setter keeps a __proto__ field crossing the socket unchanged. | Added setOwn (defineProperty) and used it in encode and decode of object fields. |
| `src/core/rust-engine/owner-ipc/election.ts` | 1 (1) | trunk | the 4 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine/owner-ipc/owner-ops.ts` | 1 (1) | trunk | the 2 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine/owner-ipc/protocol.ts` | 1 (1) | merged | The PR file differs from the trunk only by additions, so the PR text (equal to trunk plus the fixes) was taken: access field on call/fn frames, deadline-outcome note, realpath-canonical lock and socket path, finished-frame cap counting. | Added the access frame field, canonicalDatabasePath for the lock and socket path, the finished-frame cap check, and their comments. |
| `src/core/rust-engine/owner-ipc/routes.ts` | 1 (1) | merged | Trunk text kept (takeover wording for ownerGone); only ownerCallTimeout is replaced with the PR's staged version (queued, not_sent, sent) so a timeout on a started call says the outcome is unknown. | Replaced ownerCallTimeout(member, ms, queued: boolean) with the staged version giving reasons not_started, not_sent and outcome_unknown. |
| `src/core/rust-engine/owner-ipc/server.ts` | 1 (1) | merged | Trunk server (per-connection fair lanes) kept; the PR's caller-access handling, staged timeout reasons, and the response_too_large member fix added on top. | Runs each call under the caller's access record (refusing a malformed one), passes queued/sent stage to ownerCallTimeout, names the member in oversize-result replies after reply drops the call, and updates the header comment. |
| `src/core/rust-engine/owner-ipc/whole-op.ts` | 1 (1) | trunk | the 4 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine/store-members/code-edges.ts` | 1 (11) | trunk | every line the PR adds is on the trunk side |  |
| `src/core/rust-engine/store-members/facts.ts` | 1 (7) | trunk | the 3 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine/store-members/facts.ts` | 2 (36) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine/store-members/facts.ts` | 3 (64) | trunk | the 15 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine/store-members/facts.ts` | 4 (480) | trunk | the 3 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine/store-members/keyword.ts` | 1 (6) | trunk | every line the PR adds is on the trunk side |  |
| `src/core/rust-engine/store-members/keyword.ts` | 2 (37) | trunk | every line the PR adds is on the trunk side |  |
| `src/core/rust-engine/store-members/page-ops.ts` | 1 (4) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine/store-members/page-ops.ts` | 2 (27) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine/store-members/page-ops.ts` | 3 (72) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine/store-members/page-ops.ts` | 4 (109) | trunk | the 2 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine/store-members/private-provenance.ts` | 1 (18) | trunk | the 4 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine/store-members/private-provenance.ts` | 2 (52) | merged | Trunk structure kept. ownerOnlyFormIn now reads ownerOnlyPageSql/ownerOnlyFactSql, so master's v328 'mode' render maps to 'fn'; with the trunk text it mapped to 'off' and the Rust read hid nothing. | Import `{ ownerOnlyFactSql, ownerOnlyPageSql }`; rowSql(alias,'fn'\|'mode') -> 'fn', rowSql(alias,'closed') -> 'closed', else 'off' (+7/-4 vs trunk). |
| `src/core/rust-engine/store-members/private-provenance.ts` | 3 (172) | trunk | every line the PR adds is on the trunk side |  |
| `src/core/rust-engine/store-members/private-provenance.ts` | 4 (188) | trunk | every line the PR adds is on the trunk side |  |
| `src/core/rust-engine/store-members/private-provenance.ts` | 5 (203) | trunk | every line the PR adds is on the trunk side |  |
| `src/core/rust-engine/store-members/private-provenance.ts` | 6 (234) | merged | Trunk structure kept. ownerOnlyFormIn now reads ownerOnlyPageSql/ownerOnlyFactSql, so master's v328 'mode' render maps to 'fn'; with the trunk text it mapped to 'off' and the Rust read hid nothing. | Import `{ ownerOnlyFactSql, ownerOnlyPageSql }`; rowSql(alias,'fn'\|'mode') -> 'fn', rowSql(alias,'closed') -> 'closed', else 'off' (+7/-4 vs trunk). |
| `src/core/rust-engine/store-members/private-provenance.ts` | 7 (256) | merged | Trunk structure kept. ownerOnlyFormIn now reads ownerOnlyPageSql/ownerOnlyFactSql, so master's v328 'mode' render maps to 'fn'; with the trunk text it mapped to 'off' and the Rust read hid nothing. | Import `{ ownerOnlyFactSql, ownerOnlyPageSql }`; rowSql(alias,'fn'\|'mode') -> 'fn', rowSql(alias,'closed') -> 'closed', else 'off' (+7/-4 vs trunk). |
| `src/core/rust-engine/store-members/private-provenance.ts` | 8 (317) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine/store-members/private-provenance.ts` | 9 (346) | trunk | the 12 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine/store-members/private-provenance.ts` | 10 (432) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine/store-members/private-provenance.ts` | 11 (458) | trunk | the 6 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine/store-members/private-provenance.ts` | 12 (518) | trunk | the 2 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine/store-members/private-provenance.ts` | 13 (588) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine/store-members/raw-files.ts` | 1 (2) | trunk | The trunk version is a superset: it also serves listFiles and its doc comment names it. | Nothing added. |
| `src/core/rust-engine/store-members/raw-files.ts` | 2 (23) | trunk | The trunk already serves all raw-file members, including listFiles and the page policy for getRawData (excludePrivate), where the PR refused excludePrivate. | Nothing added. |
| `src/core/rust-engine/store-members/salience.ts` | 1 (7) | trunk | The trunk already serves excludePrivate through the page policy for both salience reads, with the caller's readers considered. | Nothing added. |
| `src/core/rust-engine/store-members/salience.ts` | 2 (78) | trunk | The trunk's storePagePolicy call for getRecentSalience also passes callerReaders, a superset of the PR's call. | Nothing added. |
| `src/core/rust-engine/store-members/salience.ts` | 3 (100) | trunk | The trunk always sends exclude_private (null when none) for getRecentSalience, same effect as the PR's conditional spread. | Nothing added. |
| `src/core/rust-engine/store-members/stats.ts` | 1 (226) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine/store-members/timeline-queries.ts` | 1 (3) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine/store-members/timeline-queries.ts` | 2 (69) | trunk | every line the PR adds is on the trunk side |  |
| `src/core/schema-migrations/registry.generated.ts` | 1 (331) | regenerated | Generated by build:schema-migrations after the v330 renumber. | Both v329-serves-since-subsecond and v330-projection-jobs-byte-order-index; LATEST_SCHEMA_VERSION = 330. |
| `src/core/schema-migrations/registry.generated.ts` | 2 (664) | regenerated | Generated by build:schema-migrations after the v330 renumber. | Both v329-serves-since-subsecond and v330-projection-jobs-byte-order-index; LATEST_SCHEMA_VERSION = 330. |
| `src/core/search/private-visibility.ts` | 1 (35) | merged | Trunk import plus master's ownerOnlyTakeSql/ownerOnlyTimelineSql, which the #9704 take/timeline filters need. | Owner-only import line with ownerOnlyTakeSql, ownerOnlyTimelineSql added. |
| `test/engine-parity/coverage.tsv` | 1 (92) | regenerated | Generated; rebuilt with bun test/engine-parity/coverage.ts --write. | Generator output. |
| `test/engine-parity/coverage.tsv` | 2 (181) | regenerated | Generated; rebuilt with bun test/engine-parity/coverage.ts --write. | Generator output. |
| `test/engine-parity/coverage.tsv` | 3 (197) | trunk | every line the PR adds is on the trunk side |  |
| `test/engine-parity/coverage.tsv` | 4 (206) | regenerated | Generated; rebuilt with bun test/engine-parity/coverage.ts --write. | Generator output. |
| `test/engine-parity/coverage.tsv` | 5 (397) | trunk | every line the PR adds is on the trunk side |  |
| `test/engine-parity/coverage.tsv` | 6 (434) | regenerated | Generated; rebuilt with bun test/engine-parity/coverage.ts --write. | Generator output. |
| `test/engine-parity/coverage.tsv` | 7 (461) | trunk | every line the PR adds is on the trunk side |  |
| `test/engine-parity/coverage.tsv` | 8 (481) | regenerated | Generated; rebuilt with bun test/engine-parity/coverage.ts --write. | Generator output. |
| `test/engine-parity/coverage.tsv` | 9 (535) | regenerated | Generated; rebuilt with bun test/engine-parity/coverage.ts --write. | Generator output. |
| `test/engine-parity/coverage.tsv` | 10 (628) | regenerated | Generated; rebuilt with bun test/engine-parity/coverage.ts --write. | Generator output. |
| `test/engine-parity/coverage.tsv` | 11 (791) | trunk | every line the PR adds is on the trunk side |  |
| `test/engine-parity/coverage.tsv` | 12 (819) | regenerated | Generated; rebuilt with bun test/engine-parity/coverage.ts --write. | Generator output. |
| `test/engine-parity/coverage.tsv` | 13 (829) | regenerated | Generated; rebuilt with bun test/engine-parity/coverage.ts --write. | Generator output. |
| `test/engine-parity/coverage.tsv` | 14 (843) | regenerated | Generated; rebuilt with bun test/engine-parity/coverage.ts --write. | Generator output. |
| `test/engine-parity/coverage.tsv` | 15 (1237) | regenerated | Generated; rebuilt with bun test/engine-parity/coverage.ts --write. | Generator output. |
| `test/engine-parity/coverage.tsv` | 16 (1284) | regenerated | Generated; rebuilt with bun test/engine-parity/coverage.ts --write. | Generator output. |
| `test/engine-parity/coverage.tsv` | 17 (1295) | regenerated | Generated; rebuilt with bun test/engine-parity/coverage.ts --write. | Generator output. |
| `test/engine-parity/facts.test.ts` | 1 (857) | trunk | every line the PR adds is on the trunk side |  |
| `test/engine-parity/private-page-reads.test.ts` | 1 (1) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `test/engine-parity/reads-privacy.test.ts` | 1 (364) | trunk | every line the PR adds is on the trunk side |  |
| `test/engine-parity/search-privacy.test.ts` | 1 (1) | trunk | every line the PR adds is on the trunk side |  |
| `test/engine-parity/search-private-fence.test.ts` | 1 (1) | trunk | every line the PR adds is on the trunk side |  |
| `test/engine-parity/search.test.ts` | 1 (387) | trunk | every line the PR adds is on the trunk side |  |
| `test/engine-parity/search.test.ts` | 2 (1502) | trunk | every line the PR adds is on the trunk side |  |
| `test/engine-parity/timeline.test.ts` | 1 (997) | trunk | every line the PR adds is on the trunk side |  |
| `test/fixtures/goldens/migrations/records.json` | 1 (3) | regenerated | Golden; regenerated with GBRAIN_TEST_UPDATE_GOLDENS=1 after the v330 renumber. | Generator output; rerun without the flag passes. |
| `test/fixtures/goldens/migrations/records.json` | 2 (5367) | regenerated | Golden; regenerated with GBRAIN_TEST_UPDATE_GOLDENS=1 after the v330 renumber. | Generator output; rerun without the flag passes. |
| `test/fixtures/goldens/migrations/records.json` | 3 (5750) | regenerated | Golden; regenerated with GBRAIN_TEST_UPDATE_GOLDENS=1 after the v330 renumber. | Generator output; rerun without the flag passes. |
| `test/fixtures/goldens/sql-text/links.json` | 1 (785) | regenerated | Golden; master's closed/mode owner-only forms change the SQL text. | Generator output. |
| `test/fixtures/goldens/sql-text/pages.json` | 1 (1322) | regenerated | Same as links.json. | Generator output. |
| `test/import-private-hold-callers-7897.test.ts` | 1 (39) | pr | Both sides list owner-ops.ts as held; the PR's reason names the test that proves the owner keeps the client's hold option, and that test is kept below. | Used the PR's why text naming test/rust-owner-ipc.test.ts 'a whole import carries the client's holdNoncanonicalPrivate option...'. |
| `test/postgres-unit-arms.txt` | 1 (231) | trunk | every line the PR adds is on the trunk side |  |
| `test/rust-engine-store.test.ts` | 1 (26) | trunk | every line the PR adds is on the trunk side |  |
| `test/rust-engine-store.test.ts` | 2 (144) | trunk | the 2 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `test/rust-engine-store.test.ts` | 3 (158) | trunk | the 2 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `test/rust-engine-store.test.ts` | 4 (333) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `test/rust-engine-store.test.ts` | 5 (405) | trunk | every line the PR adds is on the trunk side |  |
| `test/rust-owner-ipc.test.ts` | 1 (1) | merged | Trunk test file kept (its tests match the trunk's real-Rust-owner and census wiring); the PR-only tests are added; the PR's test.skip cases for unwired shared code are dropped because the trunk runs them. | Added tests: __proto__ codec, symlink alias, whole import holds option, labelled-only access on owner (stub uses callerReaders like the trunk member), single-deadline timeout reasons, not_started reason, frame caps (3 tests + response_too_large), socket 0600/dir 0700 mode test under /tmp. |
