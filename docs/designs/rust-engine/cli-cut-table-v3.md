# Landing cut table v3: rust-engine/cli-members-next onto rust-engine/main

- Trunk head measured against: origin/rust-engine/main 6f42ade30c (fetched 2026-11-21, about 10:45 PM PST). It is 108 commits past the join base cac1af275f (RA1 round-2 fixes and master sync 10). It is not b220b0df91; main moved after the brief.
- cli head: 4746dfd39b. Merge base with main: cac1af275f, the main side of the join da99c637a7.
- What main lacks (`git diff 6f42ade30c...4746dfd39b`): 1,623 files, of which 688 are src files. That is +16,918 lines of shared TS, +5,830 of Rust-engine TS (src/core/rust-engine/) and +67,407 of Rust (rust/).
- A trial merge of 4746dfd39b into 6f42ade30c conflicts in 28 files. Thirteen of them are under src/ or rust/, listed at the end.
- Caps: at most 40 src files per cut (src/ only; rust/ is counted on its own, as in v1/v2) and at most 2,000 added lines of shared TS (src/ outside src/core/rust-engine/). No cut in this table breaks a cap. The three byte-order sweeps and doctor slice 14 stay under the caps only because they are split by file.

## TL;DR

- The swap-critical content fits in 4 cuts (cuts 1-4). Cut 5 is left free. No owner decision is needed on the 5-cut limit.
- Everything else needs 32 more cuts (cuts 6-37), so the total is 37. That is about 3 times the trunk's ~12-cut model from item 120, because the line has grown since then: the sweeps, the admin and OAuth lanes, the join, lane 8 and lane 4.
- The bound is the 40-src-file cap. Shared TS is never the binding limit except in doctor slice 14 part 2 (+1,849).
- The new order: in the cli history, cliW and cliX now sit after the join (inside brief-reads 90c4d76bc0). In the landing order they still go first, as cuts 3 and 4. Their landed form, the post-join merge, already uses main's members (the merge dropped the lane's copies of listFactsFromQuotedPages, listActivationVerdictRows, listFactIdsAtTrustRank/Floor and readPageTypesByIds). By name it needs only main 6f42 (cut 4 also needs cut 3). The join content itself (J, cut 35) comes after all pre-join cuts.

## Swap-critical cuts (1-4)

"Chain" figures come from a merge-tree cherry-pick chain of the original commits onto 6f42ade30c, each measured against the tree before it. They are upper bounds: conflict markers and lines the join later dropped inflate them. "Landed" figures for cuts 3-4 come from the actual post-join merge 90c4d76bc0 plus its fixes.

| Cut | Contents | Src files | +shared TS | +Rust-engine TS | +Rust | Depends on | Strict? (forcing file) |
|---|---|---|---|---|---|---|---|
| 1 | Access members base. cli merge 672f667736 (write-request-members 98c6d87bad, with b1540aa9b9 d01fc23712 7ca20d6859) + cli merge cb18f4daf0 (access-member-writes c4f981be36: access members, groups, credential bindings; store access_members.rs, store-members/access-members.ts), as the join resolved them | 27 | +786 (chain) | +308 | +1,720 | Main only. Re-cut edits: rename MemberBindingVia to main's LiveMemberVia; drop the fence names readFenceOriginGone, lockGenerationKey, clearFenceHoldRows, readFenceHoldFiles (06336c42ea, cut 6) from the coverage lists; take the join's access-control.ts, which uses main's members (−173 lines against the chain form) | Strict: access + persistence + .github. Forcing files: src/core/access/caller.ts, access/members.ts, engine-sql/access-control.ts, commands/auth.ts, token-mint.ts, engine-sql/persistence-journal.ts, .github/workflows/rust-engine.yml |
| 2 | shared_skill_* families: store shared_skill_members.rs, shared_skill_publication.rs, shared_skill_catalog.rs; store-members/shared-skill-members.ts, engine-sql shared-skill-members.ts, shared-skills/*.ts callers. 16 commits: 1a96367745 63795e712b 88255cac02 0372930fc8 f3a762ed9c 364bd959e8 7013963679 f4749f5b34 eb01204b9d bdfd6d75d3 c19a848230 51f209aa34 44c090a74c 88f89e034c 735d541180 86b9ab296e | 24 | +682 | +174 | +2,800 | Cut 1 only (18 names, e.g. access_members.rs member_key/all_members/keys::ACCESS_MEMBERS; store-members/access-members.ts PG_CODE/asPostgresError/MEMBER_DATES; readWriteRequestsByRequestId). Nothing else outside main | Strict: persistence + access. Forcing files: src/core/persistence/skill-activation.ts, protocol.ts, bundle-files.ts, blocking-effects.ts, activation.ts; grants/model.ts, shared-skills/membership-authority.ts |
| 3 | cliW: d2671f1342 (ontology-propose) 7787268012 (hot-memory meta) 30232f54c3 (privacy-hold reply) 0740badd2c (quote reads) e5257f4afa (timeline re-insert) d2b4b85f37 (chunk-reuse republish) 65b3f8a992 (timeline-add) d1ec6f64c1 (write-path-stops), in the form 90c4d76bc0 landed them; plus the cliW guard rows of 24fab7775e (writer census for engine-sql/timeline.ts, write attribution for persistence/canonical-projections.ts, the source-read tag in test/rust-engine-shell.test.ts) | Landed ~23 (15 own + 6 shared hubs + new fact-pool.ts, facts-recall.ts). Chain 24 | Landed +96 own, up to +289 with the hub lines it shares with cut 4. Chain +352 | Landed +85 to +176. Chain +160 | Landed +430 to +618. Chain +1,071 | Main only. The only cli-only names are hub spreads in store-members/index.ts (derivedGenerations, factsProvenance, derivationTrust): drop them at re-cut, because cuts 6 and 17 add them. Also re-pin RUST_KNOWN_STOP in test/engine-parity/timeline-add.test.ts to main's line in page-state/projections.ts (lane 8 later moves it to :651) | Strict: persistence (src/core/persistence/semantic-pages.ts), and Ember's call on d2671f1342 (src/core/trust/privacy-hold-reply.ts: who may read a privacy hold) |
| 4 | cliX: d1ec6f64c1..38343e2fa2 = hidden-refusals-2 0ea77f47bd (b1ed614266 efeb078093 44dbd9ecb3 123c8c70ee 58f2be32e8 e1bc4cf454 1fc9d2e14e 20402af891 a47dbececd 8530166f4d 972fe89df6 0ea77f47bd) + brief-reads 38343e2fa2, in the 90c4d76bc0 landed form (br_fix: listSlotRows on Rust, newest-facts sort key) + 9a1d15fd4d (brief remote floor) + the proactive-brief part of d3ef798f0a (open-loop id tiebreak, test/brief-loop-rank-tiebreak.test.ts) | Landed ~31 (25 own + 6 hubs). Chain 31 | Landed +558 to +767. Chain +1,091 | Landed +214 to +244. Chain +262 | Landed +2,772 to +2,827. Chain +3,584 | Cut 3 (history order, and the stream and quote names cliW adds). Otherwise main only: the cli-only names it touches are import-line and coverage-list entries (entity resolver types, referrer list names), which are re-cut edits | Path rule: not strict (no access/persistence/sync/migration/install/.github file). Recommended strict for access content: src/core/rust-engine/store-members/private-provenance.ts (reflexPolicy moves there) and search/ignored-privacy-labels.ts |
| 5 | Empty, reserved for the trunk. Slack if cut 3 or 4 grows after the real port | - | - | - | - | - | - |

If the trunk takes hidden-refusals-2 0ea77f47bd at its own intake, as item 123 says, cut 4 shrinks to brief-reads alone: 10 src files, +181 shared TS, +97 RE TS, +968 Rust (diff 0ea77f47bd..38343e2fa2). Hidden-refusals-2 by itself is 28 src files, +490 shared TS, +146 RE TS, +1,652 Rust.

## Cuts 6-37 (everything else, behind B3b, git_protocol and repair-rust)

These cuts keep cli first-parent order, so each one sits on the cuts before it. Sizes use each unit's own first-parent diff, limited to the files that still change on main plus the earlier cuts (taken from the chain). Line counts are each unit's original added lines. They do not include the join's adaptation, about +242 shared TS, +45 RE TS and +789 Rust spread over about 95 src files that these cuts already touch.

"Depends on" lists the earlier cuts whose new names this cut uses, with the count of shared names (6+ characters, not on main, import lines skipped). Every cut also depends textually on the cut before it through the hub files (engine.ts, pglite-engine.ts, postgres-engine.ts, rust-engine/members.ts, store-members/index.ts).

| Cut | Contents (first-parent units) | Src | +shared TS | +RE TS | +Rust | Depends on (cuts, names) | Strict? (forcing file) | Blast radius notes |
|---|---|---|---|---|---|---|---|---|
| 6 | 7e65273568 census-member-callers, 0ee9882f77 effect-worker, 06336c42ea fence-generations, ed07044f46 census, 9bae29daf8 session-delta-reads, 59a17053f0 derived-generations, e54b06864d write-attribution-reads | 34 | 1,067 | 393 | 5,329 | main only | Strict, persistence: src/core/engine-sql/persistence-journal.ts, persistence-effect-scans.ts | LOOSER TEST: test/engine-parity/fact-provenance.test.ts:51 now accepts the fact id as a number or a numeric string (bigint) and compares by Number(). Before the join (9bae29daf8) it asserted `typeof r.id === 'number'`; the join (da99c637a7) also switched the call to main's positional form listFactProvenance(SRC, ids). Main-overlap: page_embedding_budget.rs conflicts with new main |
| 7 | 656e7543ee / 86e8125a68 / c37b426665 rust-credentials, a1f77f5ac6, e6c7309ee4, 82b1a4520b, e719e37dd8, d8d9956871 (OAuth and old token conversion), 6f6f1b4441 backlinks-group-page | 34 | 1,265 | 241 | 2,832 | 1 (5), 2 (1) | Strict, access: src/commands/auth.ts, access/attest-sources.ts, token-mint.ts | listAccessTokens keeps this line's signature (Ember ruling A, Nov 21): `listAccessTokens(): Promise<AccessTokenListRow[]>` (engine-sql/access-credentials.ts: named columns, dates normalized, the token hash never returned, plus the GST-2898 grant columns when present). rust-engine/main has `listAccessTokens(): Promise<AccessTokenRow[]>` (engine-sql/write-misc.ts, `SELECT *` with an open column bag, so the hash column rides along); master has no member and runs the raw `SELECT * FROM access_tokens` in its callers. Callers that read a column outside the named set get undefined. |
| 8 | 91ed4dde12 referrer-cursor | 24 | 103 | 37 | 104 | 7 (25) | Strict, access + persistence: src/core/access/open-pages.ts, persistence/deactivation.ts | - |
| 9 | babb4b8e97 resolve-relational (1) | 21 | 570 | 186 | 1,568 | main only | Strict, sync: src/commands/sync/perform.ts, engine-sql/sync-hold-reads.ts | Use main's findFuzzyEntityCandidates / findExactBasenameCandidates where it is the same SQL |
| 10 | d4c363313d resolve-relational (2): access-rule policy, job principal, purge epoch | 28 | 549 | 159 | 2,447 | 2 (1), 9 (1) | Strict, access + sync: src/core/access/policy.ts, commands/sync/full.ts | - |
| 11 | 5ba8b739b5 source-order sweep, part 1/3 (src/commands/* .. src/core/minions) | 40 | 60 | 0 | 69 | 7 (5), 10 (2) | Strict, migrations + install: src/commands/migrate-engine.ts, frontmatter-install-hook.ts | Split sweep: test/source-id-order-collation.test.ts exemption map must follow each part |
| 12 | 5ba8b739b5 part 2/3 (src/core/notifier .. sync-pending) | 40 | 52 | 11 | 0 | 10, 11 | Strict, persistence: src/core/persistence/admin-intent.ts, sync-holds.ts | Split sweep (see 11) |
| 13 | 5ba8b739b5 part 3/3 + c7485f7f1a / 287fb9cf53 / ded98ca976 / fc0e6e6922 notifier-rust + 8d81648da8 / 30750dcd6c access-rule-writes-2 | 36 | 1,139 | 396 | 4,030 | 1 (17), 10 (30), 11 | Strict, access + migrations: src/core/access/policy-migrate.ts; store access_rules.rs | - |
| 14 | b12bbb305b parity-en-us, 413616d84b purge-stale-checkpoints (1/3) | 11 | 5 | 19 | 1,734 | 1, 9, 10, 13 | Strict, access: src/core/access/actor.ts, labelled-only.ts | - |
| 15 | 6284f56c0e / c9ea21da60 purge-stale-checkpoints, 850f21056b, aac3ce82af, 3ebdd3234a timeline-held-rows, 7defb7ac03, 7d4eebf173, 51142d3459 access-member-writes 1/4 (Rust, minus what cut 2 took) | 39 | 609 | 337 | 4,148 (upper bound: counts shared-skill Rust that cut 2 already holds) | 2 (147), 14 (17), 6 (12), 1, 9, 10 | Strict, sync: src/commands/sync/full.ts, holds.ts, rename-reconcile.ts | 3ebdd3234a must use main's page-scoped listHeldRows (item 109) |
| 16 | 447953601d / 3be6cf070e / 8dc1722e16 access-member-writes 2-4/4 (labelled-only and generation parts), ec6cf7ca3b session-cap-tiebreak, d9e2bcedef generation-writes 1/3 | 31 | 1,101 | 217 | 3,360 | 2 (78), 15 (39), 6 (19), 1 (16) | Strict, install + persistence + access: INSTALL_FOR_AGENTS.md, docs/INSTALL.md, src/core/persistence/journal.ts | rust-engine/members.ts crosses the 1,500 unlisted cap about here (estimate), so the module-size row must arrive in this cut or the one before |
| 17 | 9857216795 / be396b7353 generation-writes 2-3/3 | 31 | 781 | 234 | 0 | 16 (36), 6 (9) | Strict, persistence: src/core/persistence/derived-retirement-hold.ts | - |
| 18 | d616eed613 doctor slice 14, part 1/4 (doctor/checks a..p + its Rust) | 40 | 98 | 0 | 4,672 | 15 (1) | Strict, persistence: store persistence.rs, persistence/housekeeping.rs | Doctor slice 14 split by file. Its four parts must land back to back |
| 19 | d616eed613 part 2/4 (doctor/checks p..z, engine-sql doctor-*) | 28 | 1,849 | 0 | 0 | 18 (94) | Strict, access: src/core/access/labelled-only.ts | Closest cut to the 2K TS cap; the join adaptation could push it toward 2K |
| 20 | d616eed613 part 3/4 (engine-sql doctor-persistence .. repair) | 40 | 1,447 | 0 | 0 | 18, 19 | Strict, migrations: src/core/persistence/connector-checkpoint-migration.ts | - |
| 21 | d616eed613 part 4/4 + b0f5ac93f6, 4e5a7fdb4b, eeb091f6b7, 31826e4607, 38aa0577b2 (doctor slices 16-19) | 35 | 302 | 718 | 2,484 | 18, 19, 20 | Strict, persistence + sync: engine-sql/persistence-journal.ts, sync-hold-op.ts | RUST_ENGINE.md row 35: four doctor checks from main refuse typed on a Rust brain (pinned in test/rust-cli-parity.serial.test.ts) |
| 22 | 9da00dcdc9 doctor 20, 736e2a926e rust-token-member-binding, 238963b4f7 doctor 21, 26eb1b92d3 doctor 22 | 35 | 552 | 162 | 1,679 | 1 (16), 18, 7, 10, 13, 21 | Strict, .github + access: .github/workflows/rust-engine.yml, src/commands/auth.ts | - |
| 23 | 706153524b doctor 23, 5d13a7b578 doctor 24-25, 7041c045b3 26, d896b5e9b2 27, 0024e7a36e 28, c8cd914dfc 29, 4fdc784eef 30, eadcfd654b token-grant-gaps | 38 | 936 | 307 | 4,540 | 18 (11), 1 (10), 7, 22, 16 | Strict, migrations + access: connector-checkpoint-migration.ts; token grants | RUST_ENGINE.md row 36: main's read-shared switch writes read_shared_revision through raw SQL (grants/service.ts:310, lifecycle.ts:32, legacy-token.ts:227); this cut's typed grant writes do not cover them |
| 24 | efc99f3f35 grant-stops, ab8b2f2dc7 slice 31, 3eb6e19e12, aaa5cc5009 slice 32, 2ea6456e62 access-reads, c231d6c992 slices 33-40, 932324b281 / 330d620bce sweep-reads | 35 | 530 | 198 | 2,002 | 18 (7), 23, 10, 13, 21 | Strict, persistence: src/core/persistence/identity.ts, engine-sql/persistence-state.ts | dd34a151be (slice 38, inside c231d6c992) must use main's readRetirementHop (item 109) |
| 25 | f2283364a4 take-trust-reads-2, 0288e61df6, 7a1a853c86, ba3a73e639 trust-scan-cursor | 27 | 205 | 160 | 1,236 | 24, 18, 10 | Strict, persistence: src/core/persistence/takes-prepare.ts | - |
| 26 | 5e4d19af8b collate-sweep, part 1/3 | 40 | 175 | 0 | 36 | 1, 19, 20 | Strict, migrations: test/fixtures/goldens/migrations/records.json (v333 byte-order indexes) | Split sweep: test/helpers/byte-order.ts and the collate test must cover only the landed part |
| 27 | 5e4d19af8b part 2/3 | 40 | 103 | 0 | 0 | 26 (text) | Strict, persistence + sync: engine-sql/persistence-journal.ts, sync-hold-reads.ts | Split sweep |
| 28 | 5e4d19af8b part 3/3 + e918aa8c4c (typed-read deadlines) + 6c4811e655 (census guards) | 37 | 169 | 0 | 0 | 24, 9, 10, 23 | Strict, migrations: src/core/schema-migrations/*.generated.ts | - |
| 29 | 87ff6589b1 collate-sweep-2, part 1/3 | 40 | 86 | 0 | 0 | 28 (text) | Strict, migrations: src/commands/migrate-engine.ts | Split sweep |
| 30 | 87ff6589b1 part 2/3 | 40 | 102 | 0 | 0 | 29 (text) | Not strict | Split sweep |
| 31 | 87ff6589b1 part 3/3 + 90ab2fd5d2 (purge records and embedding holds) | 22 | 38 | 0 | 8 | 14 | Strict, migrations: src/core/shared-skills/migration-members.ts | - |
| 32 | 778cba8233 serve-http-rust, 34e724a11b notifier-followups, 0b8fde313c oauth-http-rust, 19b47b66ae admin-routes-rust | 34 | 1,099 | 228 | 3,099 | 7 (25), 1, 22, 25 | Strict, access: src/commands/auth.ts, access/attest-sources.ts | - |
| 33 | 352c94b5b6 admin-unowned-rust, ca4dbc5811 admin-followups-rust (+ the admin-unowned-http realpath test part of d3ef798f0a) | 29 | 221 | 90 | 767 | 1 (14), 32, 19 | Strict, access + persistence: src/core/access/actor.ts, persistence/authority.ts | - |
| 34 | de72811022 sync-anchor | 18 | 92 | 69 | 752 | 13, 14, 15, 10 | Strict, sync: src/commands/sync/full.ts, preflight.ts | pages.rs and valid_time.rs conflict with new main |
| 35 | J: join residual. Join edits not owned by any earlier cut (19 src files, e.g. entities/identity-decisions.ts, access/handover.ts, grants/read-shared.ts, fence-repair/uncommitted-op.ts, delegated-policy-handle.ts removal, embedding_holds drop (item 103), calibration flip (item 96)) + d76b18766b (loss rows) 0294b2fdfe 3af6acffee 3c72fae727 32d23b6fcf f69e569fd5 | 26 | 110 | 0 | 84 | 18 (12), 9, 10, and most earlier cuts | Strict, .github + access + sync: .github/workflows/persistence-validation.yml, access/handover.ts, commands/sync/imports.ts | RUST_ENGINE.md rows 34-36 (capability losses from the join, owners lane 5/7, lane 14, lane 1, due 5 PM PST Nov 25). Row 34: syncIdentityDecisions returns early on Rust (identity-decisions.ts:355), and derivation_inputs is not kept. Row 35: four main doctor checks refuse on Rust. Row 36: read_shared_revision raw SQL. Row 37 on main (connector recovery, d10f8e9f15) was renumbered around them, which gives a text conflict in RUST_ENGINE.md |
| 36 | 4968a31e74 lane 8 rust-belief-ledger (b2c8653c92) + ff872805b8 | 37 | 736 | 480 | 6,094 | 23 (4), 3 (factsQuoted, factsRecall, keepsCustomSetting), 10, 13, 14, 18 | Strict, persistence: src/core/persistence/page-purge.ts, intent-redaction.ts | MODULE BLOAT: engine.ts was 6,420 lines at the join and is 6,539 at 4746 (main 5,403). rust-engine/members.ts ceiling row was 1,803 at the join and is 1,863 now (main 1,301, unlisted cap 1,500). The peel (item 131.4, due 5 PM PST Nov 24) is due after this cut and cut 37. Re-pin timeline-add RUST_KNOWN_STOP to projections.ts:651 |
| 37 | d30a71653f lane 4 memory-records-rest (5d4dabf8fd) + c598d1505b + 4746dfd39b | 29 | 111 | 935 | 10,715 | 3 (5), 4 (3), 6 (8), 10 (6), 16 (5), 36 (3) | Strict, access + persistence: store access_rules.rs, src/core/persistence/mirror-read-only.ts | Largest Rust cut (10.7K). Same module-bloat note as cut 36. Migration v326 kept main's file (item 136) |

Sanity check: summing the per-cut hub growth gives engine.ts about 6,590 and members.ts about 1,870 after cut 37. The real files at 4746 are 6,539 and 1,863, so the line method is close.

## Longest dependency chain

- By shared names (at least 3 names per link): 7 cuts long: 1 → 2 → 15 → 16 → 23 → 24 → 28.
- Counting single-name links too: 19 cuts long (1 → 2 → 7 → 11 → 13 → 14 → 15 → 18 → 19 → 20 → 21 → 22 → 23 → 24 → 25 → 32 → 33 → 35 → 37). Many single-name links are weak.
- In practice the line is serial. Every cut that adds an engine member edits the same five hub files, so each cut rebases on the one before it. Expect one cut in flight at a time, not waves.

## Which cuts are swap-critical

- Cuts 1, 2, 3, 4. Cut 2 needs cut 1. Cut 4 needs cut 3. Cuts 1 and 3 need only main.
- Cuts 1+2 together are 44 src files, and cuts 3+4 together are 49 to 54. So none of them can merge into one cut under the 40-file cap.

## Caps

- No cut breaks a cap as planned.
- The cuts that only fit because they are split:
  - doctor slice 14, d616eed613: 129 src files, +3,491 shared TS. It becomes cuts 18-21.
  - source-order sweep, 5ba8b739b5: 84 src files. It becomes cuts 11-13.
  - collate-sweep, 5e4d19af8b: 109 src files. It becomes cuts 26-28.
  - collate-sweep-2, 87ff6589b1: 102 src files. It becomes cuts 29-31.
- The split points are by file path, not by subsystem. The real split needs the sweep tests (source-id-order-collation exemption map, collate-engine-sql cases) to move with each part.
- Optional, not blocking: the owner could waive the file cap for the three mechanical sweeps (a few lines per file, under 450 shared TS each). That would save 6 cuts (37 → 31).

## Decision needed

None for the 5-cut limit. The swap-critical content needs 4 cuts. Rulings (Ember, Nov 21 ~11:05 PM PST): A keep this line's listAccessTokens signature (cut 7 Blast radius names the change); B the trunk does NOT take 0ea77f47bd separately (it reaches main with this line; cut 4 stays ~31 files); C no file-cap waiver, 37 cuts stand. Earlier note: whether the trunk takes 0ea77f47bd at intake (which shrinks cut 4).

## Conflicts with the new main 6f42ade30c (src/ and rust/) and the cuts that hit them

- src/core/engine.ts, pglite-engine.ts, rust-engine/members.ts: almost every cut.
- store-members/page-body.ts: cut 36.
- facts.rs: cuts 6, 10, 13, 15, 16, 23-25, 36, 37.
- page_ops.rs: cuts 7, 9, 13, 18-21, 36.
- pages.rs: cuts 6, 15, 16, 34, 36.
- trust/withdrawals.rs: cuts 13, 36, 37.
- facts/purge_ledger.rs: cuts 23, 36.
- cli_reads/entities.rs: cuts 7, 24.
- page_embedding_budget.rs: cut 6.
- tests/valid_time.rs: cut 34.
- The other conflicts are docs, guards and test lists (RUST_ENGINE.md, module-size-limits.tsv, coverage.tsv, rust-tally.tsv, postgres-unit-arms.txt, goldens).

## Method and what is a guess

- Measured with git, not built. No build or test run.
- Swap-critical cuts: a merge-tree cherry-pick chain onto 6f42ade30c (same method as estimate120), plus the landed brief-reads merge for cuts 3-4.
- Cuts 6-37: per first-parent unit (102 cli first-parent commits not on main, minus the swap content and the join), greedily packed in order under both caps.
- Dependencies: names of 6 or more characters in a cut's added lines (import and comment lines skipped) that main lacks, traced to the first earlier cut that adds them.
- Strict calls are by path: access, persistence, sync, migration, install or .github.
- Guesses and limits:
  - Line counts are original-commit lines. Cuts 1, 2, 15 and 16 are upper bounds, because the join trimmed or took main's members, and cut 15's Rust double-counts shared-skill files.
  - The join adaptation (about +242 shared TS over about 95 files) is folded into cuts 6-34 and not counted per cut.
  - The cuts 3/4 split of the 6 shared hub files is my estimate.
  - Split parts of the sweeps and of doctor slice 14 are by file path.
  - The name check misses short names and signature changes.
  - Main-overlap rulings from main-overlap.md (123 "use main" sites) were not re-checked against 6f42.
- Scratch: /var/tmp/cuts/ (chain.log, rest_chain.log, units2.tsv, cuts.json, deps.json). The scratch worktree /var/tmp/wt-cuts was removed. The merge-tree runs left dangling commit objects in the repo (no refs).

## Shadow-needed marks (added Nov 22, ~3 AM PST, for the trunk's item (d))

Cut table v3 was measured at 4746dfd39b against rust-engine/main 6f42ade30c. The accepted head is now 77b86168de. The two commits after 4746dfd39b are not in any cut: the peel 1f7f4a3691 (no behaviour change) and the darwin timeout 77b86168de (CI only). They land after cut 37, and neither is shadow-needed.

How a cut was marked. A cut is shadow-needed if:
- it is swap-critical (cuts 1-4); or
- without it, a shadow comparison in docs/designs/RUST_ENGINE.md "Shadow mode and swap" gives `capability_missing`, `rust_error`, `diverged` or `privacy_diverged` on a personal brain. Those comparisons are: deterministic reads (get_page, list, backlinks, timeline, find, stats, facts reads, the memory verbs), which must match exactly, order included; ranked arms; the per-item privacy check; sampled typed writes; and fact fingerprints and withdrawals. Readiness criterion 2 allows no `capability_missing` in the last 7 days. Criterion 3 allows no unexplained `diverged`. Criterion 6 allows no `privacy_diverged`.
- Ember's sweep ruling: the sweep reads are needed for the Nov 26 shadow release.

What a mark does not cover:
- No cut carries shadow-mode code. src/shadow lives on rust-engine-shadow, rust-engine/shadow-s3 and rust-engine/shadow-follow. Those branches are based on an older main, and their added src lines call none of the 538 engine members that only this line has.
- Not shadow-needed: doctor, admin HTTP, OAuth and serve on Rust, sync workers, and token bindings. A shadow store never runs sync, job or maintenance workers. It gets the caller-access context captured on the primary, so it never authenticates a token itself. Doctor and serve on a Rust brain matter only after a swap.
- The marks come from commit subjects and the shadow design text. I did not build or run anything for them. "Weak" means the reason is plausible but not traced to a specific comparison.

| Cut | Name | Src files | Depends on (cuts) | Shadow-needed | Reason |
|---|---|---|---|---|---|
| 1 | Access members base (write-request-members, access-member-writes) | 27 | main only | yes | Swap-critical. Also privacy: the Rust store must hold access members and groups to filter reads like the primary |
| 2 | shared_skill_* families | 24 | 1 | yes | Swap-critical |
| 3 | cliW (ontology-propose .. write-path-stops, landed form) | ~23 | main only | yes | Swap-critical. Quote reads, timeline re-insert and privacy-hold reply are compared reads |
| 4 | cliX (hidden-refusals-2 0ea77f47bd + brief-reads, brief floor, loop tiebreak) | ~31 | 3 | yes | Swap-critical. Hidden refusals on Rust are `capability_missing` |
| 5 | Empty, reserved for the trunk | - | - | - | - |
| 6 | census-member-callers, effect-worker, fence-generations, census, session-delta-reads, derived-generations, write-attribution-reads | 34 | main only | yes | Fact provenance reads (facts reads) on Rust. Adds the hub names derivedGenerations and factsProvenance that cut 3 drops at re-cut |
| 7 | rust-credentials, OAuth and old-token conversion, backlinks-group-page | 34 | 1, 2 | yes | backlinks-group-page 6f6f1b4441: get_backlinks for a group page and entity referrers on Rust. The credential and OAuth parts are not needed for shadow |
| 8 | referrer-cursor | 24 | 7 | yes | Postgres backlinks paging keeps every page, and source lists come out in byte order. Backlinks must match exactly, order included |
| 9 | resolve-relational (1): entity resolution, relational recall, sync status reads | 21 | main only | yes | `recall` and `entity` (memory verbs) on Rust |
| 10 | resolve-relational (2): access-rule policy, job principal, purge epoch | 28 | 2, 9 | yes | Privacy: access-rule policy reads on Rust |
| 11 | source-order sweep 1/3 | 40 | 7, 10 | yes | Byte order for source ids on a Postgres primary. Without it, list order differs from Rust on non-C locales (`diverged`) |
| 12 | source-order sweep 2/3 | 40 | 10, 11 | yes | Same as 11 |
| 13 | source-order sweep 3/3 + notifier-rust + access-rule-writes-2 | 36 | 1, 10, 11 | yes | Privacy: the Rust store keeps folder rules and policy revisions. Also the byte-order sweep |
| 14 | parity-en-us, purge-stale-checkpoints 1/3 | 11 | 1, 9, 10, 13 | yes (weak) | Access lists in byte order. The Rust store keeps reason tombstones and page-embedding holds that the follower imports |
| 15 | purge-stale-checkpoints 2/3, entity-card-timeline-refusal, smoke-resolve-slugs, timeline-held-rows, chronicle-utc, lane6-output-gaps, access-member-writes 1/4 | 39 | 2, 14, 6, 1, 9, 10 | yes | The entity card and timeline match on every engine. Chronicle dates are UTC. Five more output gaps are closed |
| 16 | access-member-writes 2-4/4, session-cap-tiebreak, generation-writes 1/3 | 31 | 2, 15, 6, 1 | yes | Privacy: labelled-only members on Rust. Rust reads generation before-states and derived-row trust |
| 17 | generation-writes 2-3/3 | 31 | 16, 6 | yes (weak) | Completes cut 16. The derivation-trust members feed the trust labels on facts and recall reads |
| 18 | doctor slice 14, part 1/4 | 40 | 15 | no | Doctor only. Cuts 19, 24, 25 and 35 use its names |
| 19 | doctor slice 14, part 2/4 | 28 | 18 | no | Doctor only |
| 20 | doctor slice 14, part 3/4 | 40 | 18, 19 | no | Doctor only |
| 21 | doctor slice 14, part 4/4 + doctor slices 16-19 | 35 | 18, 19, 20 | no | Doctor only |
| 22 | doctor 20-22, rust-token-member-binding | 35 | 1, 18, 7, 10, 13, 21 | no | Doctor, and token binding (the shadow does not authenticate) |
| 23 | doctor 23-30, token-grant-gaps | 38 | 18, 1, 7, 22, 16 | no | Doctor, and grants |
| 24 | grant-stops, doctor slices 31-40, access-reads, sweep-reads 932324b281 + 330d620bce | 35 | 18, 23, 10, 13, 21 | yes | Ember's ruling: the sweep reads are needed for the Nov 26 shadow release (link and timeline extraction on Rust). The grant and doctor parts are not needed |
| 25 | take-trust-reads-2, sweep page-ref read, countLivePages, trust-scan-cursor | 27 | 24, 18, 10 | yes | Take reads and take vector search on Rust (deterministic and ranked). The sweep's page-ref read |
| 26 | collate-sweep 1/3 | 40 | 1, 19, 20 | yes | Postgres lists sort text keys by byte, as PGLite and Rust do. Exact-order match on a Postgres primary |
| 27 | collate-sweep 2/3 | 40 | 26 | yes | Same as 26 |
| 28 | collate-sweep 3/3, typed-read deadlines, census guards | 37 | 24, 9, 10, 23 | yes | Same as 26 |
| 29 | collate-sweep-2 1/3 | 40 | 28 | yes | Same as 26 |
| 30 | collate-sweep-2 2/3 | 40 | 29 | yes | Same as 26 |
| 31 | collate-sweep-2 3/3 + purge records and embedding holds apart | 22 | 14 | yes | Same as 26. The Rust store keeps purge records and embedding holds as separate state, which the follower imports |
| 32 | serve-http-rust, notifier-followups, oauth-http-rust, admin-routes-rust | 34 | 7, 1, 22, 25 | no | HTTP, OAuth and admin on a Rust brain. Needed only after a swap |
| 33 | admin-unowned-rust, admin-followups-rust | 29 | 1, 32, 19 | no | Admin on a Rust brain |
| 34 | sync-anchor | 18 | 13, 14, 15, 10 | no | Git sync on a Rust brain. The shadow store never runs sync |
| 35 | J: join residual + d76b18766b, 0294b2fdfe, 3af6acffee, 3c72fae727, 32d23b6fcf, f69e569fd5 | 26 | 18, 9, 10, most earlier cuts | yes (as a base) | No shadow feature of its own. Cuts 36 and 37 sit on its adaptation to main's members. It also records the loss rows 34-36 that a shadow report shows as `capability_missing` |
| 36 | lane 8 rust-belief-ledger + ff872805b8 | 37 | 23, 3, 10, 13, 14, 18 | yes | The belief ledger, fact purges and page purges on Rust. Readiness criterion 7 needs the withdrawal and purge suppression test to pass after a swap |
| 37 | lane 4 memory-records-rest + c598d1505b + 4746dfd39b | 29 | 3, 4, 6, 10, 16, 36 | yes | `remember` and `forget` (memory verbs), and fact writes and repairs (sampled write comparisons) on Rust |

Summary: 27 of the 36 used cuts are shadow-needed (1-4, 6-17, 24-31, 35-37). Cuts 14 and 17 are marked "weak". 9 cuts are not needed: 18-23 (doctor and grants) and 32-34 (HTTP, admin and sync).

Order note: the no-cuts still sit in the serial chain. Cuts 24, 25 and 35 use names from cut 18. Every cut edits the same five hub files. So in the current order, every cut lands before cuts 36 and 37. To land the shadow cuts sooner, the trunk could try to move cuts 32-34 after cut 37. That needs a re-cut and a check, because they share hub files with cuts 35-37. Cuts 18-23 cannot move without also moving 24-25.
