# Rust landing merge map: trunk + https://github.com/garrytan/gbrain/pull/9823

Trunk `rust-engine/main` 0ce95bbf7f, PR head d1190b8aeb, merge-base 9c6d42a8ad. Measured with
`git -c merge.conflictStyle=diff3 merge --no-ff --no-commit d1190b8aeb` on the trunk. 76 files conflict, in 147 blocks.

This map is the reference for the merge after https://github.com/garrytan/gbrain/pull/9823 lands. The trunk keeps its own
v331 projection-jobs byte-order migration; no migration is renumbered.

Keep values: `trunk` = the trunk side as is; `pr` = the PR side; `merged` = both sides combined (summary in the last column);
`regenerated` = a generated file rebuilt from the merged tree. "Why" names the reason in one line.

Counts: merged 24, pr 6, regenerated 26, trunk 91.

A blanket "keep trunk" rule is wrong. The trunk already has master through
https://github.com/garrytan/gbrain/pull/9819 and its own owner-IPC work, but not the PR's owner-IPC fixes
(caller access record, staged timeouts, realpath lock, frame caps), the facts, page-body and keyword fixes, or a current
capability list in docs/ENGINES.md. 30 blocks keep PR lines.

Gate on the merged tree (git tree 4f9e9fa0e5): cargo fmt, clippy and test; rust build; typecheck; search goldens; build-llms;
`bun run verify` (104 of 104); Rust unit lanes; engine parity on PGLite, Rust and Postgres pages; CLI parity; owner-IPC units;
migrations; orphan modules; module size. All pass. llms-full.txt is 799984 bytes, 16 under the 800000 cap.

## Edits outside the conflict blocks

| File | Why |
|---|---|
| `rust/crates/gbrain-store/src/facts/privacy.rs (test)` | The PR test uses `OwnerOnly::Lineage`, which the trunk removed; changed to `OwnerOnlyForm::Fn`. The PR test `a_bare_entity_key_is_hidden_by_its_private_directory_page` is kept. |
| `rust/crates/gbrain-store/tests/salience.rs` | PR wire value `"ownerOnly": "lineage"` is refused by the trunk `OwnerOnlyForm` (off, fn, closed); changed to `"fn"`. |
| `test/rust-engine-shell.test.ts` | The PR's two early-client tests assume a client reaches the owner socket while the store opens. The trunk election opens the store before the socket listens, so the tests expect the refusal. |
| `docs/architecture/key-files/engines-2-continued.md, engines-2-more.md` | Merged text was over the 60000-byte cap; 5 entries (persistence-effect-scans, persistence-effect-worker, persistence-idle-probe, persistence-embedding-noop-settle, store-members/search-filters) moved to engines-2-more.md. Now 57752 bytes. |
| `docs/ENGINES.md` | Bundle budget: the trunk's duplicate "Vector search" bullet is dropped (its one unique clause folded into the vectors bullet), and the page_body sentence says `sweepSegments` is served. |

Not needed on this trunk (the trunk already has them): the master owner-only take and timeline port in write-attribution.ts and
takes-reads.ts, the owner_only.rs closed-form mark, the facts_extractor_classify order fix, the `ownerOnlyTimelineAllowedSql`
VETTED_BUILDERS row in scripts/check-engine-sql-dynamic.ts, and the migrations-golden gap edit (the trunk lists gaps 17, 18, 19, 100, 330).

## Blocks

| File | Block (line) | Keep | Why | Merged text |
|---|---|---|---|---|
| `.claude-plugin/plugin.json` | 1 (3) | trunk | Release stamp or release text: the trunk side is newer; PRs carry no version. |  |
| `.codex-plugin/plugin.json` | 1 (3) | trunk | Release stamp or release text: the trunk side is newer; PRs carry no version. |  |
| `BOOTSTRAP_FOR_AGENTS.md` | 1 (1) | trunk | Release stamp or release text: the trunk side is newer; PRs carry no version. |  |
| `CHANGELOG.md` | 1 (13) | trunk | Release stamp or release text: the trunk side is newer; PRs carry no version. |  |
| `README.md` | 1 (395) | merged | PR served-domain list is current; 'nothing selects it yet' changed to opt-in because constructEngine accepts engine 'rust' on trunk | PR served-domain list, with the opt-in wording |
| `TODOS.md` | 1 (3) | trunk | every line the PR adds is on the trunk side |  |
| `VERSION` | 1 (1) | trunk | Release stamp or release text: the trunk side is newer; PRs carry no version. |  |
| `docs/ENGINES.md` | 1 (1701) | merged | Trunk listed 20 capabilities; `servedCapabilities()` on the trunk reports 30. The PR adds the one-owner-process bullet and the client wording. | The 30-capability list, the owner-process bullet, and "a second engine on an open directory becomes the owner's client". |
| `docs/ENGINES.md` | 2 (1767) | pr | The trunk serves `revertToVersion`, `upsertEventProjection`; `page_versions`, `chunks` and `timeline` are reported. | PR lines: revertToVersion listed, the three capabilities reported. |
| `docs/ENGINES.md` | 3 (1844) | trunk | every line the PR adds is on the trunk side |  |
| `docs/ENGINES.md` | 4 (1865) | merged | Trunk vector bullets kept; the PR bullet on privacy inputs of the raw-data, page-operation, salience, facts, ontology, chronicle and code-edge reads added. | Trunk bullets plus the PR privacy-input bullet. |
| `docs/architecture/canonical-writers.tsv` | 1 (150) | trunk | every line the PR adds is on the trunk side |  |
| `docs/architecture/key-files/engines-2-continued.md` | 1 (25) | merged | Written from merged code: owner election and takeover, timeout reasons, served modules, still-refused members | Shell, store and owner-ipc bullets rewritten |
| `docs/designs/RUST_ENGINE.md` | 1 (725) | merged | Open-before-selection table: trunk rows 4 and 7 kept with numbers; PR rows 6, 10, 12, 16, 18, 19 still open on trunk added; PR rows 1,2,3,5 fixed, 7,8,11,13 stale (excludePrivate served), 9,14,15,17 not confirmed/fixed and dropped | Rows 4, 6, 7, 10, 12, 16, 18, 19 |
| `docs/designs/RUST_ENGINE_INTERFACES.md` | 1 (887) | merged | Trunk text with the PR wording: the rename cascade is built, so `cascade::rename_slug_rows` calls `facts::rename_slug_rows` (the signature stays `rename_slug_rows`, as in the code). | Trunk side; "fill in" replaced by "`cascade::rename_slug_rows` calls". |
| `llms-full.txt` | 1 (4612) | regenerated | Generated bundle; rebuilt with `bun run build:llms` from the merged docs (799984 of 800000 bytes). |  |
| `llms-full.txt` | 2 (6355) | regenerated | Generated bundle; rebuilt with `bun run build:llms` from the merged docs (799984 of 800000 bytes). |  |
| `llms-full.txt` | 3 (6421) | regenerated | Generated bundle; rebuilt with `bun run build:llms` from the merged docs (799984 of 800000 bytes). |  |
| `llms-full.txt` | 4 (6498) | regenerated | Generated bundle; rebuilt with `bun run build:llms` from the merged docs (799984 of 800000 bytes). |  |
| `llms-full.txt` | 5 (6519) | regenerated | Generated bundle; rebuilt with `bun run build:llms` from the merged docs (799984 of 800000 bytes). |  |
| `openclaw.plugin.json` | 1 (4) | trunk | Release stamp or release text: the trunk side is newer; PRs carry no version. |  |
| `package.json` | 1 (269) | trunk | Release stamp or release text: the trunk side is newer; PRs carry no version. |  |
| `plugin-variants/gbrain-coding/.claude-plugin/plugin.json` | 1 (3) | trunk | Release stamp or release text: the trunk side is newer; PRs carry no version. |  |
| `plugin-variants/gbrain-coding/.codex-plugin/plugin.json` | 1 (3) | trunk | Release stamp or release text: the trunk side is newer; PRs carry no version. |  |
| `plugin-variants/gbrain-coding/README.md` | 1 (1) | trunk | Release stamp or release text: the trunk side is newer; PRs carry no version. |  |
| `plugin-variants/gbrain-daily/.claude-plugin/plugin.json` | 1 (3) | trunk | Release stamp or release text: the trunk side is newer; PRs carry no version. |  |
| `plugin-variants/gbrain-daily/.codex-plugin/plugin.json` | 1 (3) | trunk | Release stamp or release text: the trunk side is newer; PRs carry no version. |  |
| `plugin-variants/gbrain-daily/README.md` | 1 (1) | trunk | Release stamp or release text: the trunk side is newer; PRs carry no version. |  |
| `plugin/README.md` | 1 (1) | trunk | Release stamp or release text: the trunk side is newer; PRs carry no version. |  |
| `rust/crates/gbrain-napi/src/families/page_ops.rs` | 1 (18) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-napi/src/families/timeline_queries.rs` | 1 (3) | trunk | the 2 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-napi/src/families/timeline_queries.rs` | 2 (87) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/examples/keyword_scale.rs` | 1 (1) | merged | Trunk file kept; the trunk `OwnerOnlyForm` (off, fn, closed) refuses the old wire value `lineage`. | One edit: `"ownerOnly": "lineage"` changed to `"fn"`. |
| `rust/crates/gbrain-store/src/aliases.rs` | 1 (32) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/chunk_queries.rs` | 1 (31) | merged | Trunk layout kept; PR intent is that the activation marker counts as served. | Trunk plus `use crate::keyword::served;`. |
| `rust/crates/gbrain-store/src/chunk_queries.rs` | 2 (198) | merged | Same intent as block 1, doc side. | Trunk plus doc text 'served (sealed, or the v153 activation marker)'. |
| `rust/crates/gbrain-store/src/chunk_queries.rs` | 3 (257) | merged | Trunk test code kept; the PR's older ChunkPageOptions initializer lacked trunk's exclude_private/require_safe_chunks. | Trunk plus doc text; the PR's marker test now fills `exclude_private: None, require_safe_chunks: false` so it compiles against trunk's struct. |
| `rust/crates/gbrain-store/src/chunks.rs` | 1 (1407) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/chunks.rs` | 2 (1426) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/keyword.rs` | 1 (70) | merged | Both re-exports are needed. | Both `pub use cjk::{...}` and `pub(crate) use filters::served;`. |
| `rust/crates/gbrain-store/src/keyword/page_search.rs` | 1 (31) | pr | The PR import list is the trunk list plus `with_query_stack`, which block 2 needs. | PR side. |
| `rust/crates/gbrain-store/src/keyword/page_search.rs` | 2 (73) | merged | Trunk walk kept; PR runs it on a deep stack. | `keyword_pages` takes `visit: impl FnMut(PageRecord, Best)->bool + Send`; walk_chunks body wrapped in `with_query_stack(items, ...)`; `cjk_keyword_pages` left as trunk. |
| `rust/crates/gbrain-store/src/keyword/page_search.rs` | 3 (96) | merged | Trunk kept; deep-spawn test already present. | Test `a_deep_query_walks_every_page_on_one_deep_thread` kept; trunk text otherwise. |
| `rust/crates/gbrain-store/src/keyword/page_search.rs` | 4 (317) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/page_ops.rs` | 1 (11) | merged | add/add file rebuilt from trunk; PR names the first embedded chunk in the sampler. | `representative_chunk(read,page_id)` (lowest chunk_index with embed dims>0) used by `domain_bank_row`; doc updated; trunk `retrieved` kept. |
| `rust/crates/gbrain-store/src/page_ops.rs` | 2 (59) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/page_ops.rs` | 3 (77) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/page_ops.rs` | 4 (1411) | merged | Trunk purge kept; PR adds text/staging cleanup and fact expiry. | purge collects page_text_refs, removes page, delete_slug_stagings, delete_purged_texts, scrub_purged_slugs, `facts::expire_gone_page_facts` with write trust. |
| `rust/crates/gbrain-store/src/page_ops.rs` | 5 (2371) | merged | Trunk tests kept; PR sampler test added. PR's segmented-revert put_json variant not adopted (trunk snapshot_in does not refuse segmented pages). | Added `the_samplers_name_the_first_embedded_chunk`; trunk `revert_refuses_a_segmented_version_of_an_inline_page` kept. |
| `rust/crates/gbrain-store/src/pages.rs` | 1 (629) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/raw_files.rs` | 1 (380) | merged | Trunk applies the page policy in `getRawData`; the PR fix keeps SQL order and returns a repeated source id once. | Doc comment names the SQL order (`COLLATE "C"`); ids sorted and deduplicated before the walk. |
| `rust/crates/gbrain-store/src/salience.rs` | 1 (146) | trunk | Trunk already has exclude_private and the owner_only.page_hidden check; the PR lines are docs only. |  |
| `rust/crates/gbrain-store/src/timeline_queries.rs` | 1 (3) | trunk | the 3 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/timeline_queries.rs` | 2 (27) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/timeline_queries.rs` | 3 (70) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/crates/gbrain-store/src/timeline_queries.rs` | 4 (97) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/src/timeline_queries.rs` | 5 (713) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/tests/page_ops.rs` | 1 (66) | trunk | the 1 PR-only line(s) came from older text the trunk later rewrote |  |
| `rust/crates/gbrain-store/tests/page_ops.rs` | 2 (1436) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/tests/stats.rs` | 1 (13) | trunk | Trunk policies use ..Default::default() for owner_only; the PR OwnerOnly::Lineage type no longer exists in the trunk. |  |
| `rust/crates/gbrain-store/tests/stats.rs` | 2 (278) | trunk | Same: the PR block only adds the removed OwnerOnly::Lineage field and older clone-free asserts. |  |
| `rust/crates/gbrain-store/tests/timeline_queries.rs` | 1 (13) | trunk | every line the PR adds is on the trunk side |  |
| `rust/crates/gbrain-store/tests/timeline_queries.rs` | 2 (369) | trunk | every line the PR adds is on the trunk side |  |
| `rust/docs/store/aliases.md` | 1 (24) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/docs/store/keyword.md` | 1 (1) | merged | Trunk text plus PR sentence that the engine serves no source delete | Trunk side with one sentence |
| `rust/docs/store/keyword.md` | 2 (871) | trunk | every line the PR adds is on the trunk side |  |
| `rust/docs/store/page_ops.md` | 1 (11) | trunk | The trunk side already has the pages-capability sentence; the PR read-scope text is older. |  |
| `rust/docs/store/page_ops.md` | 2 (35) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/docs/store/page_ops.md` | 3 (72) | merged | Merged page_ops.rs picks representative chunk and retrieval record; purge expires facts and deletes body stagings and segment texts | Trunk retrieval records + PR representative_chunk_id and purge bullets |
| `rust/docs/store/salience.md` | 1 (46) | merged | Trunk bullets kept; the trunk sentence that links and timeline reads still refuse `excludePrivate` is stale, so it is removed. | Trunk bullet without that sentence. |
| `rust/docs/store/stats.md` | 1 (49) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `rust/docs/store/timeline_queries.md` | 1 (17) | trunk | every line the PR adds is on the trunk side |  |
| `rust/docs/store/timeline_queries.md` | 2 (75) | trunk | every line the PR adds is on the trunk side |  |
| `rust/docs/store/timeline_queries.md` | 3 (178) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `scripts/check-orphan-modules.mjs` | 1 (58) | trunk | The trunk wired the Rust engine into engine construction and removed its whole held list; holding the owner-ipc modules would now be stale entries, and the guard reports none of them as orphaned. |  |
| `scripts/core-world-reads-baseline.tsv` | 1 (928) | pr | Trunk rows plus the PR fs_import row: protocol.ts now resolves symlinks with realpath. | PR side; `check:core-world-reads` passes. |
| `scripts/postgres-arm-weights-postgres-only.json` | 1 (62) | trunk | every line the PR adds is on the trunk side |  |
| `scripts/postgres-arm-weights.json` | 1 (154) | trunk | The trunk already weights private-page-reads.test.ts (7062, measured) and persistence.test.ts, so the PR's 11000 guess adds nothing. |  |
| `src/core/behavior-changes.generated.ts` | 1 (189) | regenerated | Generated from changelog.d; rebuilt by `bun run regen:all`; the output equals the trunk side (trunk release entries). |  |
| `src/core/behavior-changes.generated.ts` | 2 (383) | regenerated | Generated from changelog.d; rebuilt by `bun run regen:all`; the output equals the trunk side (trunk release entries). |  |
| `src/core/rust-engine.ts` | 1 (4) | trunk | every line the PR adds is already in the trunk file (moved) |  |
| `src/core/rust-engine.ts` | 2 (68) | trunk | every line the PR adds is on the trunk side |  |
| `src/core/rust-engine.ts` | 3 (134) | trunk | The trunk's election (_elect/_runElection) opens the store before the owner socket serves, so no call reaches an engine without a store and a failed open rejects the waiting calls; the PR's _storeReady wait is not needed. |  |
| `src/core/rust-engine.ts` | 4 (149) | trunk | every line the PR adds is on the trunk side |  |
| `src/core/rust-engine.ts` | 5 (177) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine.ts` | 6 (194) | trunk | the 5 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine.ts` | 7 (214) | trunk | the 2 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine.ts` | 8 (366) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine.ts` | 9 (391) | trunk | the 2 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine.ts` | 10 (407) | trunk | The trunk's storeFor/storeAfterElection already waits for the election and rejects when it fails, which is the PR's intent of not hanging on a failed open. |  |
| `src/core/rust-engine.ts` | 11 (587) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine/owner-ipc/client.ts` | 1 (1) | merged | Trunk client (with its owner takeover and recover step) kept; the PR's caller-access record and the sent/not_sent/queued timeout stages added on top. | Sends the caller's access record with each call, reports timeouts as sent or not_sent (outcome unknown once sent), and updates the header comment; STORE_MEMBERS routing was already in the trunk. |
| `src/core/rust-engine/owner-ipc/codec.ts` | 1 (1) | pr | The PR side is the trunk codec plus the own-property setter, so a `__proto__` field crosses the socket unchanged. | PR side. |
| `src/core/rust-engine/owner-ipc/election.ts` | 1 (1) | trunk | the 4 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine/owner-ipc/owner-ops.ts` | 1 (1) | trunk | the 2 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine/owner-ipc/protocol.ts` | 1 (1) | pr | The PR side is the trunk text plus its fixes: access field on call frames, deadline-outcome note, realpath lock and socket path, finished-frame cap. | PR side. |
| `src/core/rust-engine/owner-ipc/routes.ts` | 1 (1) | merged | Trunk text kept (takeover wording for ownerGone); only ownerCallTimeout is replaced with the PR's staged version (queued, not_sent, sent) so a timeout on a started call says the outcome is unknown. | Replaced ownerCallTimeout(member, ms, queued: boolean) with the staged version giving reasons not_started, not_sent and outcome_unknown. |
| `src/core/rust-engine/owner-ipc/server.ts` | 1 (1) | merged | Trunk server (per-connection fair lanes) kept; the PR's caller-access handling, staged timeout reasons, and the response_too_large member fix added on top. | Runs each call under the caller's access record (refusing a malformed one), passes queued/sent stage to ownerCallTimeout, names the member in oversize-result replies after reply drops the call, and updates the header comment. |
| `src/core/rust-engine/owner-ipc/whole-op.ts` | 1 (1) | trunk | the 4 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine/store-members/keyword.ts` | 1 (6) | trunk | every line the PR adds is on the trunk side |  |
| `src/core/rust-engine/store-members/keyword.ts` | 2 (37) | trunk | every line the PR adds is on the trunk side |  |
| `src/core/rust-engine/store-members/page-ops.ts` | 1 (4) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine/store-members/page-ops.ts` | 2 (27) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine/store-members/page-ops.ts` | 3 (72) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine/store-members/page-ops.ts` | 4 (109) | trunk | the 2 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine/store-members/salience.ts` | 1 (7) | trunk | The trunk already serves excludePrivate through the page policy for both salience reads, with the caller's readers considered. |  |
| `src/core/rust-engine/store-members/salience.ts` | 2 (78) | trunk | The trunk's storePagePolicy call for getRecentSalience also passes callerReaders, a superset of the PR's call. |  |
| `src/core/rust-engine/store-members/salience.ts` | 3 (100) | trunk | The trunk always sends exclude_private (null when none) for getRecentSalience, same effect as the PR's conditional spread. |  |
| `src/core/rust-engine/store-members/stats.ts` | 1 (226) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine/store-members/timeline-queries.ts` | 1 (3) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `src/core/rust-engine/store-members/timeline-queries.ts` | 2 (69) | trunk | every line the PR adds is on the trunk side |  |
| `templates/bootstrap/template-repo/README.md` | 1 (3) | trunk | Release stamp or release text: the trunk side is newer; PRs carry no version. |  |
| `test/engine-parity/coverage.tsv` | 1 (92) | regenerated | Generated; rebuilt with `bun test/engine-parity/coverage.ts --write`; the output equals the trunk side. |  |
| `test/engine-parity/coverage.tsv` | 2 (181) | regenerated | Generated; rebuilt with `bun test/engine-parity/coverage.ts --write`; the output equals the trunk side. |  |
| `test/engine-parity/coverage.tsv` | 3 (197) | regenerated | Generated; rebuilt with `bun test/engine-parity/coverage.ts --write`; the output equals the trunk side. |  |
| `test/engine-parity/coverage.tsv` | 4 (206) | regenerated | Generated; rebuilt with `bun test/engine-parity/coverage.ts --write`; the output equals the trunk side. |  |
| `test/engine-parity/coverage.tsv` | 5 (397) | regenerated | Generated; rebuilt with `bun test/engine-parity/coverage.ts --write`; the output equals the trunk side. |  |
| `test/engine-parity/coverage.tsv` | 6 (434) | regenerated | Generated; rebuilt with `bun test/engine-parity/coverage.ts --write`; the output equals the trunk side. |  |
| `test/engine-parity/coverage.tsv` | 7 (461) | regenerated | Generated; rebuilt with `bun test/engine-parity/coverage.ts --write`; the output equals the trunk side. |  |
| `test/engine-parity/coverage.tsv` | 8 (481) | regenerated | Generated; rebuilt with `bun test/engine-parity/coverage.ts --write`; the output equals the trunk side. |  |
| `test/engine-parity/coverage.tsv` | 9 (535) | regenerated | Generated; rebuilt with `bun test/engine-parity/coverage.ts --write`; the output equals the trunk side. |  |
| `test/engine-parity/coverage.tsv` | 10 (688) | regenerated | Generated; rebuilt with `bun test/engine-parity/coverage.ts --write`; the output equals the trunk side. |  |
| `test/engine-parity/coverage.tsv` | 11 (743) | regenerated | Generated; rebuilt with `bun test/engine-parity/coverage.ts --write`; the output equals the trunk side. |  |
| `test/engine-parity/coverage.tsv` | 12 (775) | regenerated | Generated; rebuilt with `bun test/engine-parity/coverage.ts --write`; the output equals the trunk side. |  |
| `test/engine-parity/coverage.tsv` | 13 (790) | regenerated | Generated; rebuilt with `bun test/engine-parity/coverage.ts --write`; the output equals the trunk side. |  |
| `test/engine-parity/coverage.tsv` | 14 (847) | regenerated | Generated; rebuilt with `bun test/engine-parity/coverage.ts --write`; the output equals the trunk side. |  |
| `test/engine-parity/coverage.tsv` | 15 (875) | regenerated | Generated; rebuilt with `bun test/engine-parity/coverage.ts --write`; the output equals the trunk side. |  |
| `test/engine-parity/coverage.tsv` | 16 (885) | regenerated | Generated; rebuilt with `bun test/engine-parity/coverage.ts --write`; the output equals the trunk side. |  |
| `test/engine-parity/coverage.tsv` | 17 (901) | regenerated | Generated; rebuilt with `bun test/engine-parity/coverage.ts --write`; the output equals the trunk side. |  |
| `test/engine-parity/coverage.tsv` | 18 (1310) | regenerated | Generated; rebuilt with `bun test/engine-parity/coverage.ts --write`; the output equals the trunk side. |  |
| `test/engine-parity/coverage.tsv` | 19 (1321) | regenerated | Generated; rebuilt with `bun test/engine-parity/coverage.ts --write`; the output equals the trunk side. |  |
| `test/engine-parity/facts.test.ts` | 1 (857) | trunk | every line the PR adds is on the trunk side |  |
| `test/engine-parity/private-page-reads.test.ts` | 1 (1) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `test/engine-parity/reads-privacy.test.ts` | 1 (364) | trunk | every line the PR adds is on the trunk side |  |
| `test/engine-parity/search-privacy.test.ts` | 1 (1) | trunk | every line the PR adds is on the trunk side |  |
| `test/engine-parity/search-private-fence.test.ts` | 1 (1) | trunk | every line the PR adds is on the trunk side |  |
| `test/engine-parity/search.test.ts` | 1 (387) | trunk | every line the PR adds is on the trunk side |  |
| `test/engine-parity/search.test.ts` | 2 (1502) | trunk | every line the PR adds is on the trunk side |  |
| `test/engine-parity/timeline.test.ts` | 1 (997) | trunk | every line the PR adds is on the trunk side |  |
| `test/import-private-hold-callers-7897.test.ts` | 1 (39) | pr | Both sides list owner-ops.ts as held; the PR's reason names the test that proves the owner keeps the client's hold option, and that test is kept below. | Used the PR's why text naming test/rust-owner-ipc.test.ts 'a whole import carries the client's holdNoncanonicalPrivate option...'. |
| `test/postgres-unit-arms.txt` | 1 (233) | trunk | every line the PR adds is on the trunk side |  |
| `test/rust-engine-store.test.ts` | 1 (26) | trunk | every line the PR adds is on the trunk side |  |
| `test/rust-engine-store.test.ts` | 2 (144) | trunk | the 2 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `test/rust-engine-store.test.ts` | 3 (158) | trunk | the 2 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `test/rust-engine-store.test.ts` | 4 (333) | trunk | the 1 PR-only line(s) came from older land/master text the trunk later rewrote |  |
| `test/rust-engine-store.test.ts` | 5 (405) | trunk | every line the PR adds is on the trunk side |  |
| `test/rust-owner-ipc.test.ts` | 1 (1) | merged | Trunk test file kept (its tests match the trunk's real-Rust-owner and census wiring); the PR-only tests are added; the PR's test.skip cases for unwired shared code are dropped because the trunk runs them. | Added tests: __proto__ codec, symlink alias, whole import holds option, labelled-only access on owner (stub uses callerReaders like the trunk member), single-deadline timeout reasons, not_started reason, frame caps (3 tests + response_too_large), socket 0600/dir 0700 mode test under /tmp. |
