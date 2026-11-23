# Landing table v3.9 final, Nov 22-30 (v3.8 1:50 PM; v3.9 first cut 6:50 PM; v3.9 final written Sun Nov 22 about 7:10 PM PST by this machine's clock; due 8:15 PM)

**Changelog v3.9 first cut to v3.9 final (Ember ~6:55 PM):** (a) RP is re-cut from 16 to 8 parts under Minder's bundle rule (https://github.com/garrytan/gbrain/pull/9992#issuecomment-7082307675: at most 110 src files, 6K shared TS, 40K Rust-engine lines, under 2 MB review diff per landing); P's parts first (RP1-RP5), the swap-critical part next (RP6), then the rest (RP7-RP8); strict reviews stacked as Minder requires (comment 7082497110); no RP part before R2 lands. (b) a1 and a2 heads are ready by 9 AM Thu Nov 26. With both, **B is Thu Nov 26 2:55 PM, +2.1 h before the 5 PM cut, and nothing shadow-needed lands after the effective 3:30 PM cut (confirmed).** a1 and a2 are no longer listed as late. (c) is kept as a held fallback (section 4), not applied. Fixed in the model: R1 now sits at its real 12:06 PM landing (the first cut put it at 6:35 PM). v3.9 first cut is saved at /var/tmp/trunk/lt3k/landing-table-nov22-v3.9-first-backup.md.

Refs: master 1d77261c76 then release 5c9f3051 (v0.60.765.0, 6:21 PM PST). Trunk rust-engine/main b66e407760 (extract-mentions-rust, 3:28 PM). Batch 10 head 0ac99efc2f is on origin (not on main yet): vs b66e407760 it is 1,519 files, 634 src, +16,342 shared TS, +56,464 Rust-engine lines. All dates PST and ESTIMATES from my scheduler (/var/tmp/trunk/lt3k/sched3k.py) unless marked MEASURED. Read-only: no commits, no pushes, no messages. Settings: 3 review places, 4 strict bundles stacked, CI queue 25 min, one round, review 3.5 h + 0.5 h per extra head; planning rate 29.4 min (measured, 24 h).

## Summary (10 lines)

1. **B (last shadow-needed landing): Thu Nov 26 2:55 PM PST, +2.1 h before the 5 PM cut. Confirmed. Nothing shadow-needed lands after the effective 3:30 PM cut (91 shadow heads; last are a1 and a2 at 2:55 PM, 0.6 h before 3:30 PM).** Standing fallback: not needed, no change if applied. The cut is 5 PM Thu Nov 26 (docs/designs/RUST_ENGINE.md:356 gives only the date); the effective deadline is 3:30 PM because the release also needs one dispatched rust-engine.yml run at the tag commit with its run id and the linux-x64-glibc addon sha256 in the release notes (cut-day step, 1.5 h is my estimate).
2. **RP (661 src, 27.6K shared TS, 11.9K Rust-engine lines; 2.38 MB in all) is now 8 landings:** RP1 82 src / 5,987 TS, RP2 94 / 5,690, RP3 110 / 3,426, RP4 110 / 2,440, RP5 34 / 632 / 551 Rust, RP6 50 / 5,882, RP7 110 / 3,475 / 5,084 Rust, RP8 71 / 51 / 5,984 Rust; each under 0.45 MB. P's parts RP1-RP5 land Mon Nov 23 4:12 PM, 4:42 PM, 6:43 PM, 7:13 PM, 10:13 PM (P itself, transactions.ts and store-capabilities.ts, is in RP5; whole-op.ts in RP2). The swap-critical part RP6 (local-client.ts, resolve-ipc-binding.ts, resolve-ipc.ts: the e80474be10 and abf9ede6ac files outside P) lands Mon 10:43 PM; RP7 Tue 12:25 AM; RP8 Tue Nov 24 1:43 AM. R2 lands Mon Nov 23 7:43 AM in the model, 8.5 h before RP1; RP1 depends on R2 explicitly. P is on master by Mon 10:13 PM, far ahead of the Fri Nov 27 5 PM bound.
3. **A0 and post-A intake:** A0 (v2 list, RP, batch 11 heads) Tue Nov 24 7:55 PM, +21.1 h before Nov 25 5 PM. A1 (adds the land-2 snapshot) Sat Nov 28 10:25 AM. **Post-A intake on master by Sat Nov 28 10:25 AM** (was Sat 5:55 PM in the first cut). All Dec 1 swap-critical rows land before Dec 1; the last is Thu Nov 26 9:53 PM.
4. **Two-round risk: 0 of 0** (R1 and RA1 landed in one round each; no other Rust bundle has landed). B at 0% / 5% / 7.5% / 10% / 25% / 50% second rounds: Thu Nov 26 2:55 PM (+2.1 h) / 3:07 PM (+1.9 h) / 3:13 PM (+1.8 h) / **Thu 7:01 PM (-2.0 h, 3 late)** / Fri Nov 27 2:10 AM (-9.2 h, 12 late) / Fri 11:40 PM (-30.7 h, 24 late). Break-even about 7.5-10%. Standing fallback applied in each late row: no gain. Held fallback (c) restores +1.7 h at 10%, not at 25% (section 4).
5. **Why a1/a2 now land on time:** their heads are ready at 9 AM (not 5 PM Thu), so they take one review (4 h for a 2-head bundle), the 25 min CI queue and a slot, landing 2:55 PM. If the heads come at 11 AM: B 4:55 PM (+0.1 h, a1/a2 4:55 PM, after 3:30 PM); at 12 PM: 5:55 PM (-0.9 h); at 2 PM: 7:55 PM (-2.9 h); at 5 PM: 10:55 PM (-5.9 h). The 9 AM head time is therefore the latest that works.
6. **Rates (non-release PRs on master, re-measured 6:20 PM):** 29.4 min over 24 h (49 PRs), 24.0 min over 12 h, 22.9 min over 8 h, 40.6 min over 48 h, 44.1 min over 72 h; the 5.6 h before today's 8 AM window gave 84 min. B is unchanged from 22.9 to 59 min; at 84 min B is Fri Nov 27 3:07 PM (-22.1 h, 23 late) and at 90 min Fri 9:55 PM (-28.9 h): fallback applied, no gain.
7. **Today vs plan (to 6:20 PM):** 49 merges (45 PRs, 4 releases). Rust landings: R1 12:06 PM (planned 1:00 PM), #9974 12:48 PM (reverted 1:16 PM, back via #10092 2:25 PM), #10030 4:28 PM, RA1 #10089 4:29 PM (planned about 8 PM). v3.8 planned 2 by now; real 4. R2 is not landed (queue target 9 PM).
8. **Minder's shadow order (model):** #10001 Sun 10:15 PM; managed-gate 11:13 PM; S3 seed Mon 1:45 AM; shadow-follow PR 1 2:14 AM; #9944 2:43 AM; #9946 3:13 AM; #10099 3:42 AM; #10114 4:12 AM; resolver train #10115 4:41 AM; #10082 5:10 AM; core status #10117 Wed Nov 25 8:55 PM (policy.ts head Wed 5 PM); c-rust and 21b-rust (due Wed 5 PM) Wed 10:55 PM; pages_by_type fix Mon 8:55 PM; page-purge-rust b6fe90a45b Wed 4:55 PM and 5:30 PM; land-2 L2.1-L2.6 Wed Nov 25 7:00 AM to 1:25 PM.
9. **GBEV-3 rows (SWAP-CRITICAL Dec 1, none shadow):** page-mutation-reads e2282c75dd (lane 7: N6, N14, put_page, MCP add_timeline_entry) Thu Nov 26 11:24 AM; N5 OAuth DCR (lane 12) and N12 meetings (lane 11), due Wed 5 PM, Thu Nov 26 6:55 PM; N1 trusted-caller reads and 4 untraced gaps are HOLD (no owner; placeholders Thu 6:55 PM and 7:54 AM); fixed: CLI settle b1540aa9b9 (batch 10, land-2 part 1, Wed Nov 25 7:00 AM) and MCP get_tags 5e73926695 (inside page-purge-rust, Wed 5:30 PM).
10. Not in the dates: red CI, re-merges behind a stack change, #9946 and R2 DIRTY states, review time growth on the bigger RP parts (up to 5,987 shared TS each; I kept 3.5 h + 0.5 h per extra head), the cut-day build time after the tag, parity-space-harddelete (ready Thu 5 PM, unmarked). File: /var/tmp/trunk/landing-table-nov22-v3.md.

## 1. The cut, and the cut-day steps

- **Cut:** 5 PM PST Thu Nov 26. Rule from Ember: every shadow item that changes the comparator or the addon must be in the Nov 26 shadow release build; after that release no addon-changing release on the owner shadow before Dec 1 (a new evidence epoch restarts the 5-day clock, so READY would pass Dec 1).
- **Cut-day steps (not landings):** (1) pick the tag commit after the last shadow landing on master; (2) dispatch ONE rust-engine.yml run at the tag commit (artifact retention 90 days; the retention change goes to Minder on its PR); (3) put the run id and the linux-x64-glibc addon sha256 in the release notes (producers ba676fb5 supplies the text); (4) build and publish. Steps 2-3 are about 1.5 h (estimate; the darwin addon job alone has a 45-minute timeout), so the effective landing deadline is 3:30 PM Thu. Build time after the tag is not modelled.
- Producers ba676fb5 rows: 21b-rust (restore Rust, about 420 + 280 test lines) and c-rust (snapshot/drill Rust), each due Wed Nov 25 5 PM; a1 and a2, heads ready by 9 AM Thu Nov 26 (the rows' sizes are my estimates; ba676fb5 is not a branch in the repo).

## 2. The dates

| Date | v3.9 final (plan of record) | v3.9 first cut | Deadline |
|---|---|---|---|
| (A0) Gap zero: v2 list, RP, batch 11 heads | Tue Nov 24 7:55 PM | Wed Nov 25 5:43 AM | Nov 25 5 PM: meets by 21.1 h |
| (A1) A0 plus the land-2 snapshot (batch 10) | Sat Nov 28 10:25 AM | Sat Nov 28 5:55 PM | none |
| **Post-A intake on master by** | **Sat Nov 28 10:25 AM** | Sat Nov 28 5:55 PM | before the swap |
| (B) Last shadow-needed landing | **Thu Nov 26 2:55 PM** | Thu Nov 26 10:55 PM | Nov 26 5 PM: **meets by 2.1 h** |
| Shadow items after the 5 PM cut | 0 | 2 | none allowed |
| Shadow items after the effective 3:30 PM cut | **0** | 5 | none allowed |
| Standing fallback | not needed (no change if applied) | applied, no gain | |
| Last Dec 1 swap-critical landing | Thu Nov 26 9:53 PM | Fri Nov 27 3:55 AM | before Dec 1: meets |

Shadow set: 91 heads (conservative: all 6 land-2 parts and all 8 RP parts count as shadow-needed; the 3 swap-critical shadow rows, the 5 recut heads, the chain, producers rows, page-purge, batch 11 S heads). Margin to the effective 3:30 PM: a1 and a2 0.6 h; everything else 9.6 h or more (recut heads Thu 7:25 AM).

## 3. A dated slot for every shadow-needed item

Margin = hours before (+) or after (-) the 5 PM Thu Nov 26 cut; none is after the effective 3:30 PM.

| Item | Owner | Head / due | Master landing (PST) | Margin |
|---|---|---|---|---|
| #10001 shadow mode (e4f492febe) | shadow lane | queued since Nov 21 3:04 PM; merge master posted 6:22 PM Sun | Sun Nov 22 10:15 PM | +3.8 d |
| managed-storage start-gate (shadow-managed-gate 40655ff7cc) | shadow lane | exists, follows #10001 | Sun Nov 22 11:13 PM | +3.7 d |
| S3 seed PR (shadow-s3 14d9fe2b34), stacked, strict slot right after #10001 | shadow lane | open now (handoff was 5 PM Nov 24) | Mon Nov 23 1:45 AM | +3.6 d |
| shadow-follow PR 1 (c786e766da), stacked on S3 | shadow lane | open now | Mon Nov 23 2:14 AM | +3.6 d |
| Minder queue after the chain (not ours): #9944, #9946 (core), #10099, #10114, resolver train #10115, #10082 | Minder / core | #9946 head a4e0228be9 | Mon 2:43 AM, 3:13 AM, 3:42 AM, 4:12 AM, 4:41 AM, 5:10 AM | n/a |
| core status PR #10117 (4e9075a2ae, stacked on shadow-follow, 19 files +463/-36) + policy.ts and policyHash | core | head ready Wed Nov 25 5 PM (policy.ts frozen from it) | Wed Nov 25 8:55 PM | +20.1 h |
| c-rust (snapshot/drill Rust) | producers ba676fb5 | due Wed Nov 25 5 PM | Wed Nov 25 10:55 PM (with 21b) | +18.1 h |
| 21b-rust (restore Rust) | producers ba676fb5 | due Wed Nov 25 5 PM | Wed Nov 25 10:55 PM | +18.1 h |
| a1 and a2 (one 2-head bundle) | producers ba676fb5 | **heads ready by 9 AM Thu Nov 26** | **Thu Nov 26 2:55 PM** | **+2.1 h** |
| pages_by_type tie-break (type COLLATE C), 3 engines | trunk | on main by Mon Nov 23 5 PM, rides land-2 | Mon Nov 23 8:55 PM (own slot; free if folded into a land-2 part) | +68.1 h |
| page-purge-rust b6fe90a45b, landing 1 of 2 (119 src, 3,986 shared TS; Ember: 121 src, about 2.6K TS each) | W6 / lane 13 | batch 11 first; batch 11 on main Mon 12 PM (estimate) | Wed Nov 25 4:55 PM | +24.1 h |
| page-purge-rust, landing 2 of 2 | W6 / lane 13 | same | Wed Nov 25 5:30 PM | +23.5 h |
| land-2 snapshot L2.1 (cuts 1-4; carries write-settle b1540aa9b9), L2.2-L2.6 | trunk | batch 10 on main about 9 PM Sun; builders after RP | L2.1 Wed Nov 25 7:00 AM; L2.2 7:43 AM; L2.3 9:55 AM; L2.4 10:30 AM; L2.5 11:13 AM; L2.6 1:25 PM | +34.0 h to +27.6 h |
| RP1-RP5 (P chain: transactions.ts, store-capabilities.ts, whole-op.ts and their closure), RP6 (swap-critical), RP7-RP8 (rest); after R2 | trunk | start after batch 10 on main; 2 builders at 1.5 h a part | Mon Nov 23 4:12 PM, 4:42 PM, 6:43 PM, 7:13 PM, 10:13 PM; RP6 10:43 PM; RP7 Tue 12:25 AM; RP8 1:43 AM | +3.0 d to +63 h |
| extract-mentions-rust b66e407760 (57 files, 19 src, 633 shared TS, 2,571 Rust-engine lines) | lane 6 | on main 3:28 PM; ready now | Sun Nov 22 10:44 PM | +3.8 d |
| single-consumer-rust | lane 8 | due Mon Nov 23 5 PM | Tue Nov 24 3:12 AM | +61.8 h |
| rust-init-plain with ucr (ucr never lands without it) | lane 8 | due Mon Nov 23 5 PM | Tue Nov 24 4:25 AM (one landing) | +60.6 h |
| recut: doctor-join-checks (ab1990b18a) | lane 6 | head exists | Wed Nov 25 2:43 PM | +26.3 h |
| recut: derivation-inputs-rust (after derivation-trust) | lane 7 | Mon 5 PM | Thu Nov 26 2:00 AM | +15.0 h |
| recut: sync-stamp-connectors (34057d8e2f; depends on land-2 part 1), route-gaps-2, identity-entity-keys | lanes 11, 12, 5 | Mon 5 PM | Thu Nov 26 7:25 AM | +9.6 h |
| access stack 178a49695f (row 32d-2a, due Tue Nov 25 5 PM; carries attest 68a9eb84e5) | lane 6 | after batch 11 | Thu Nov 26 2:00 AM | +15.0 h |
| fingerprint-proptest e2b9776c53; entity-private-stops 8a531f6c75 | lane 4; lane 11 | batch 11 | Thu Nov 26 4:00 AM | +13.0 h |
| lane-1 chain: B2a, B2b, B4 coll-pa3, ams member-sources, gitproto, S01 | lane 1 and others | v2 list | B2a Tue Nov 24 2:13 AM; B2b 2:42 AM; B4 9:42 AM; gitproto 8:30 PM; ams Wed Nov 25 12:43 AM; S01 6:25 AM | +34.6 h or more |
| R1, RA1, R2, RA2 + RB, N4 + N4st (+ N3st) | trunk | R1 landed 12:06 PM; RA1 landed 4:29 PM; R2 queue target 9 PM | RA2 + RB Sun 7:24 PM; R2 Mon 7:43 AM; N4 Mon 3:13 PM; N4st 3:43 PM | +3.1 d or more |

Full head-level list of the 91 shadow heads with dates is in section 9.

## 4. Fallback, held fallback (c), and what could go late

Standing fallback (gethealth, memrec[1], memrec[2], rsswap, sweepf and every other non-shadow item behind the shadow items, all before Dec 1): **no change**; non-shadow work is already ranked behind shadow work (it lands Thu Nov 26 11:24 AM to 9:53 PM). Nothing is late in the plan of record, so it is not applied.

**Held fallback (c), not applied:** used only if the second-round rate passes about 7.5% (3 recut heads land Thu 7:01 PM at 10%): fold page-purge-rust into land-2 (7 parts, one landing fewer) or ask Minder for a fifth strict slot. At 10% each restores B to Thu Nov 26 3:19 PM (+1.7 h) with nothing after 3:30 PM. At 25% neither helps (Fri Nov 27 2:10 AM and 11:51 PM); that case needs a smaller shadow set. Smaller options measured and not needed now: land-2 with only part 1 shadow-needed (B unchanged; parts 2-6 move behind, Thu 6:25 PM to Fri 3:55 AM, post-swap), status PR #10117 ready now (no change to B).

**What would go late (each tested):** a1/a2 heads later than 9 AM (see summary line 5); RP at 2K (16 parts): B Thu 7:54 PM, 3 late; RP additive (no absorb of N5-N18): Thu 7:25 PM, 3 late; 84 min a landing or slower: B Fri Nov 27 3:07 PM, 23 late.

## 5. GBEV-3 rows (SWAP-CRITICAL for Dec 1; none shadow-needed)

The Nov 26 shadow mirrors only the 20 read members in SHADOW_READ_MEMBERS (src/shadow/reads.ts:12-33 on shadow-s3 14d9fe2b34), no writes, no OAuth, no meetings. Source: /var/tmp/trunk/gbev3-map.md; owners as ruled by Ember.

| GBEV-3 item | Failing site | Fix / owner | Master landing (PST) | Before Dec 1 |
|---|---|---|---|---|
| N6 put_page refused (7 raw-SQL gaps; 3 traced), MCP add_timeline_entry, CLI put_page, N14 round trip (put_page part) | page-mutations.ts:198, :355, :597 | lane 7 page-mutation-reads e2282c75dd (17 src, 337 shared TS, 1,852 Rust-engine lines, +3,516/-146); ready head after main merge by Mon Nov 23 12 PM; batch 11 first with page-purge-rust | Thu Nov 26 11:24 AM (after land-2 part 6; same date if with land-2) | yes |
| N5 OAuth DCR registration | oauth-provider.ts registerClient :372-525, registerClientManual :1178-1268 | lane 12 rust-engine/oauth-dcr-rust, due Wed Nov 25 5 PM (size E: 3 src, 400 TS, 300 Rust) | Thu Nov 26 6:55 PM | yes |
| N12 meetings-source.ts:297 (and :141) | meetings-source.ts | lane 11, fold onto sync-stamp-connectors-recut or a new branch, due Wed Nov 25 5 PM (E: 2 src, 120 TS) | Thu Nov 26 6:55 PM (bundled with N5) | yes |
| N1 trusted-caller reads (13 of 13) | not traced | HOLD: owner after the GBEV-98 file | placeholder Thu Nov 26 6:55 PM (as if the head were ready Wed 5 PM; E: 3 src, 150 TS) | yes, if an owner lands a head by Wed 5 PM |
| 4 untraced put_page / round-trip gaps | not traced | HOLD: owner after GBEV-98 | placeholder Thu Nov 26 7:54 AM (E: 4 src, 200 TS) | yes, same condition |
| CLI add_link / add_timeline_entry settle (get_write_request refused) | ops/persistence.ts:103 | FIXED in batch 10: b1540aa9b9 (in land-2 part 1 per the cut table) | Wed Nov 25 7:00 AM (L2.1) | yes |
| MCP get_tags on a new page | ops/tags.ts:90 | FIXED: lane 13 5e73926695, inside page-purge-rust b6fe90a45b | Wed Nov 25 5:30 PM (page-purge landing 2) | yes |

Daily budget-ledger switch-on (Dec 1, not shadow, lane 10): Thu Nov 26 8:55 PM on the due basis.

## 6. Land-2 snapshot (batch 10 + extract-mentions content), split by caps

Measured by git (batch 10 head 0ac99efc2f vs master, files in src/ and rust/): 3,506 files, 1,434 src, 53.9K shared TS, 18.5K Rust-engine TS, 125.4K Rust lines. Not carried by another landing: RP closure (659 src files), files carried earlier (152), RA1/RA2/RB Rust (61 files), the ucr stack (157 files; separate landing UCR with rust-init-plain), the recut doctor-join head (10), extract-mentions (15; own landing, on main). **Remainder: 575 src, 12.5K shared TS, 80.7K Rust-engine lines, 100.7K changed lines = 4.83 MB.** At Minder's bundle rule that is 6 parts (src cap binds): L2.1-L2.6, about 96 src, 2.1K TS, 13.5K Rust, 0.8 MB each. It replaces the 37 cli cuts and the batch 10 heads (rebuild-path, row40/41, capped-count, sync-checkpoint, read-shared-revision, cli-credentials) as landings; dates Wed Nov 25 7:00 AM to 1:25 PM. RP and land-2 both touch the engine hubs, so land-2's net size may be smaller. All 6 parts are treated as shadow-needed (conservative).

## 7. RP, 8 parts

Closure method (v3.8): seeds are transactions.ts, store-capabilities.ts, owner-ipc/whole-op.ts and the src files of bf72f8062c, ed84648428, 8133529074, d9d7a3f563, e80474be10 and abf9ede6ac; follow relative imports through files that differ between master and main; drop files an earlier landing carries; add back the six commits' own files and provider.ts. 661 src, 27,583 shared TS, 11,933 Rust-engine lines, 2.38 MB. Split dependency-first at the bundle rule; P's closure (429 files) first.

| Part | Role | Src | Shared TS | Rust-engine lines | Review MB | Lands (PST) | Carries |
|---|---|---|---|---|---|---|---|
| RP1 | P chain | 82 | 5,987 | 130 | 0.34 | Mon Nov 23 4:12 PM | Rust lib.rs + transactions.rs (36 lines over RA1) and the leaf TS closure |
| RP2 | P chain | 94 | 5,690 | 184 | 0.43 | Mon Nov 23 4:42 PM | whole-op.ts, owner-ipc client.ts, journal.ts, errors.ts (e80474be10, abf9ede6ac, d9d7a3f563) and closure files |
| RP3 | P chain | 110 | 3,426 | 0 | 0.28 | Mon Nov 23 6:43 PM | closure files, with part of e80474be10's files |
| RP4 | P chain | 110 | 2,440 | 0 | 0.22 | Mon Nov 23 7:13 PM | closure files (engine-sql members and persistence seam) |
| RP5 | P chain | 34 | 632 | 551 | 0.09 | Mon Nov 23 10:13 PM | store-members/transactions.ts and store-capabilities.ts (bf72f8062c, ed84648428, 8133529074, d9d7a3f563), rust-engine.ts, provider.ts (persistence_journal gate) |
| RP6 | swap-critical | 50 | 5,882 | 0 | 0.29 | Mon Nov 23 10:43 PM | local-client.ts (Rust delegation), mcp/resolve-ipc-binding.ts (Rust socket bind), context/resolve-ipc.ts (e80474be10, abf9ede6ac) |
| RP7 | rest | 110 | 3,475 | 5,084 | 0.42 | Tue Nov 24 12:25 AM | remaining closure |
| RP8 | rest | 71 | 51 | 5,984 | 0.31 | Tue Nov 24 1:43 AM | remaining Rust-engine TS |

e80474be10 (14 src files +1,146/-14; 3 test files +445/-2): RP2, RP3, RP5, RP6 (codec.ts and protocol.ts identical on master). abf9ede6ac (4 src files +50/-10; 1 test file +176/-1): RP2, RP6. All eight parts are under the caps (src at most 110, shared TS at most 5,987, Rust-engine lines at most 5,984, 0.43 MB at most). Reviews are stacked as Minder requires (each later strict bundle merges the heads ahead; one round on the riskiest head; a second only for a blocking finding). RP1 depends on R2, RA1, RA2 + RB, N4 and N4st. Post-RP: f0000aad's master PR (shared owner-probe helper, delegate gates) targets Tue Nov 25 5 PM; the trunk reconciles it with inspectRustOwner at the next sync after it lands.

## 8. Second rounds, rates, today

Bundles that took a second round: **0 of 0**. Second-round rate p multiplies review time by (1 + p) on every strict bundle; Minder allows a second round only for a blocking-bar finding. The standing fallback is applied in every late row and never changes B.

| Second-round rate | A0 | B | Late (after 5 PM) | After 3:30 PM |
|---|---|---|---|---|
| 0% | Tue Nov 24 7:55 PM | Thu Nov 26 2:55 PM (+2.1 h) | 0 | 0 |
| 5% | Tue Nov 24 9:28 PM | Thu Nov 26 3:07 PM (+1.9 h) | 0 | 0 |
| 7.5% | not run | Thu Nov 26 3:13 PM (+1.8 h) | 0 | 0 |
| 10% | Tue Nov 24 11:40 PM | Thu Nov 26 7:01 PM (-2.0 h): fallback applied, no gain; held fallback (c) +1.7 h | 3 (the recut heads) | 3 |
| 25% | Wed Nov 25 5:55 AM | Fri Nov 27 2:10 AM (-9.2 h) | 12 | 14 |
| 50% | Wed Nov 25 2:24 PM (A0 misses) | Fri Nov 27 11:40 PM (-30.7 h) | 24 | 26 |

Rates: 22.9 min, 29.4 min (planning), 40.6, 44.1 and 59 min all give B Thu Nov 26 2:55 PM (+2.1 h; A0 Tue Nov 24 7:55 PM to 11:14 PM); 84 min Fri Nov 27 3:07 PM (-22.1 h, 23 late); 90 min Fri Nov 27 9:55 PM (-28.9 h, 27 late). Other changes: 3 or 5 bundles in flight, no CI queue time, review 3.5 h flat (B Thu 2:25 PM, +2.6 h), batch 11 on main Mon 6 PM or Tue 6 AM, 1 builder, RP parts 3 h and land-2 parts 5 h each, page-purge folded into land-2, #10117 ready now: B unchanged (+2.1 h).

**Today's real count (MEASURED: git log origin/master --first-parent and gh, 6:20 PM):** 49 merges since midnight (45 PRs, 4 releases #10054, #10065, #10079, #10116). Rust-labelled landings: R1 12:06 PM, #9974 12:48 PM (reverted 1:16 PM, back via #10092 2:25 PM), #10030 4:28 PM, RA1 #10089 4:29 PM. v3.8 planned 2 by now (R1, #9974); real 4. Planned from now to midnight: #10001 10:15 PM, extract-mentions 10:44 PM, managed-gate 11:13 PM, RA2 + RB 7:24 PM. PR states (gh, 6:25 PM): #10001 e4f492febe OPEN, #9946 a4e0228be9 OPEN, #9992 (R2) e2eff93432 OPEN. R2 is planned to queue about 9 PM.

## 9. Shadow heads, in landing order (91 heads)

| Head | Master landing | Margin to the cut | Flag |
|---|---|---|---|
| #9967 | Sun Nov 22 12:06 PM | +4.2 d |  |
| #10028 | Sun Nov 22 12:06 PM | +4.2 d |  |
| #9971 | Sun Nov 22 12:06 PM | +4.2 d |  |
| RA1 | Sun Nov 22 4:29 PM | +4.0 d |  |
| PA1 | Sun Nov 22 6:49 PM | +3.9 d |  |
| RA2 | Sun Nov 22 7:24 PM | +3.9 d |  |
| RB | Sun Nov 22 7:24 PM | +3.9 d |  |
| PA2 | Sun Nov 22 7:53 PM | +3.9 d |  |
| #10001 shadow mode (e4f492febe) | Sun Nov 22 10:15 PM | +3.8 d |  |
| extract-mentions-rust b66e407760 | Sun Nov 22 10:44 PM | +3.8 d |  |
| managed-storage start-gate (shadow-managed-gate 40655ff7cc) | Sun Nov 22 11:13 PM | +3.7 d |  |
| S3 seed PR (shadow-s3 14d9fe2b34) | Mon Nov 23 1:45 AM | +3.6 d |  |
| shadow-follow PR 1 (c786e766da) | Mon Nov 23 2:14 AM | +3.6 d |  |
| #9946 CLI connect | Mon Nov 23 3:13 AM | +3.6 d |  |
| N3 (#9992) | Mon Nov 23 7:43 AM | +3.4 d |  |
| S2b-ns (#9991) | Mon Nov 23 7:43 AM | +3.4 d |  |
| S2b-st (#9989) | Mon Nov 23 7:43 AM | +3.4 d |  |
| PB | Mon Nov 23 2:43 PM | +3.1 d |  |
| p9974 | Mon Nov 23 3:13 PM | +3.1 d |  |
| N3st | Mon Nov 23 3:13 PM | +3.1 d |  |
| N4 | Mon Nov 23 3:13 PM | +3.1 d |  |
| N4st | Mon Nov 23 3:43 PM | +3.1 d |  |
| RP1 | Mon Nov 23 4:12 PM | +3.0 d |  |
| RP2 | Mon Nov 23 4:42 PM | +3.0 d |  |
| C03 | Mon Nov 23 5:11 PM | +71.8 h |  |
| C01 | Mon Nov 23 5:40 PM | +71.3 h |  |
| C03b | Mon Nov 23 6:10 PM | +70.8 h |  |
| RP3 | Mon Nov 23 6:43 PM | +70.3 h |  |
| RP4 | Mon Nov 23 7:13 PM | +69.8 h |  |
| C02 | Mon Nov 23 7:42 PM | +69.3 h |  |
| pages_by_type tie-break (type COLLATE C), 3 engines | Mon Nov 23 8:55 PM | +68.1 h |  |
| RP5 | Mon Nov 23 10:13 PM | +66.8 h |  |
| RP6 | Mon Nov 23 10:43 PM | +66.3 h |  |
| RP7 | Tue Nov 24 12:25 AM | +64.6 h |  |
| RP8 | Tue Nov 24 1:43 AM | +63.3 h |  |
| B2a | Tue Nov 24 2:13 AM | +62.8 h |  |
| B2b | Tue Nov 24 2:42 AM | +62.3 h |  |
| single-consumer-rust | Tue Nov 24 3:12 AM | +61.8 h |  |
| Nx1 | Tue Nov 24 3:41 AM | +61.3 h |  |
| Nx2 | Tue Nov 24 3:41 AM | +61.3 h |  |
| ucr (unbound-claim-rust 58d310f948) | Tue Nov 24 4:25 AM | +60.6 h |  |
| rust-init-plain | Tue Nov 24 4:25 AM | +60.6 h |  |
| forget-rust | Tue Nov 24 5:43 AM | +59.3 h |  |
| vpre | Tue Nov 24 7:11 AM | +57.8 h |  |
| repair-rust.1 | Tue Nov 24 8:43 AM | +56.3 h |  |
| repair-rust.2 | Tue Nov 24 9:13 AM | +55.8 h |  |
| B4 | Tue Nov 24 9:42 AM | +55.3 h |  |
| sync-stamp-callers | Tue Nov 24 12:13 PM | +52.8 h |  |
| lane11-intake | Tue Nov 24 2:13 PM | +50.8 h |  |
| head2-worktree-terms.1 | Tue Nov 24 2:13 PM | +50.8 h |  |
| head2-worktree-terms.2 | Tue Nov 24 2:55 PM | +50.1 h |  |
| journal-and-segmented-purge | Tue Nov 24 7:55 PM | +45.1 h |  |
| batch9-fixups | Tue Nov 24 7:55 PM | +45.1 h |  |
| sync-adaptations | Tue Nov 24 7:55 PM | +45.1 h |  |
| gitproto | Tue Nov 24 8:30 PM | +44.5 h |  |
| B3b | Tue Nov 24 11:25 PM | +41.6 h |  |
| S05 | Wed Nov 25 12:00 AM | +41.0 h |  |
| ams | Wed Nov 25 12:43 AM | +40.3 h |  |
| S06 | Wed Nov 25 2:55 AM | +38.1 h |  |
| SW1 | Wed Nov 25 3:30 AM | +37.5 h |  |
| SW2 | Wed Nov 25 4:13 AM | +36.8 h |  |
| S01 | Wed Nov 25 6:25 AM | +34.6 h |  |
| L2.1 | Wed Nov 25 7:00 AM | +34.0 h |  |
| L2.2 | Wed Nov 25 7:43 AM | +33.3 h |  |
| L2.3 | Wed Nov 25 9:55 AM | +31.1 h |  |
| L2.4 | Wed Nov 25 10:30 AM | +30.5 h |  |
| L2.5 | Wed Nov 25 11:13 AM | +29.8 h |  |
| L2.6 | Wed Nov 25 1:25 PM | +27.6 h |  |
| compact-receipt | Wed Nov 25 2:00 PM | +27.0 h |  |
| doctor-join-checks-recut ab1990b18a | Wed Nov 25 2:43 PM | +26.3 h |  |
| page-purge-rust b6fe90a45b, landing 1 of 2 | Wed Nov 25 4:55 PM | +24.1 h |  |
| page-purge-rust b6fe90a45b, landing 2 of 2 | Wed Nov 25 5:30 PM | +23.5 h |  |
| identity-restore-rust | Wed Nov 25 7:30 PM | +21.5 h |  |
| chronicle-decision-rust | Wed Nov 25 7:30 PM | +21.5 h |  |
| core status PR #10117 (4e9075a2ae) + policy.ts | Wed Nov 25 8:55 PM | +20.1 h |  |
| c-rust (snapshot/drill Rust, producers ba676fb5) | Wed Nov 25 10:55 PM | +18.1 h |  |
| 21b-rust (restore Rust, producers ba676fb5) | Wed Nov 25 10:55 PM | +18.1 h |  |
| derivation-inputs-rust-recut | Thu Nov 26 2:00 AM | +15.0 h |  |
| access stack 178a49695f (row 32d-2a, with attest 68a9eb84e5) | Thu Nov 26 2:00 AM | +15.0 h |  |
| audit-pins | Thu Nov 26 2:00 AM | +15.0 h |  |
| key-tag-registry | Thu Nov 26 4:00 AM | +13.0 h |  |
| fingerprint-proptest | Thu Nov 26 4:00 AM | +13.0 h |  |
| entity-private-stops | Thu Nov 26 4:00 AM | +13.0 h |  |
| entity-variants-rust | Thu Nov 26 5:25 AM | +11.6 h |  |
| chronicle-reads-rebased | Thu Nov 26 5:25 AM | +11.6 h |  |
| identity-drift-rust | Thu Nov 26 5:25 AM | +11.6 h |  |
| sync-stamp-connectors-recut (34057d8e2f) | Thu Nov 26 7:25 AM | +9.6 h |  |
| route-gaps-2-rust-recut | Thu Nov 26 7:25 AM | +9.6 h |  |
| identity-entity-keys-rust-recut | Thu Nov 26 7:25 AM | +9.6 h |  |
| a1 (producers ba676fb5) | Thu Nov 26 2:55 PM | +2.1 h |  |
| a2 (producers ba676fb5) | Thu Nov 26 2:55 PM | +2.1 h |  |

## 10. Bundle list and stack order (62 Rust landings)

Mark: S, NOT, or "S (forced)" when a shadow head is built on it. Strict = any head strict. Src, Shared TS and Rust lines are sums; Review MB = changed lines x 48 B. RP and land-2 parts are measured by git; the producers rows, the status PR policy part, the GBEV rows, the swap-critical rows and the ledger are estimates.

| # | Lands (PST) | Bundle | Src | Shared TS | Rust lines | Review MB | Strict | Makes Rust answer | Owner | Mark | Kind |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Sun Nov 22 12:06 PM | R1: #9967 + #10028 + #9971 | 7 | 65 | 5 | 0.03 | yes | yes | core 04ad9c8f, trunk | S |  |
| 2 | Sun Nov 22 4:29 PM | RA1 | 0 | 0 | 37,439 | 1.86 | no | no | trunk | S |  |
| 3 | Sun Nov 22 7:24 PM | RA2 + RB | 5 | 0 | 26,974 | 1.36 | no | no | trunk | S |  |
| 4 | Sun Nov 22 10:15 PM | #10001 shadow mode (e4f492febe) | 25 | 1,885 | 0 | 0.15 | yes | no | shadow lane (Minder queue) | S |  |
| 5 | Sun Nov 22 10:44 PM | extract-mentions-rust b66e407760 | 19 | 633 | 2,571 | 0.25 | yes | yes | lane 6 | S |  |
| 6 | Sun Nov 22 11:13 PM | managed-storage start-gate (shadow-managed-gate 40655ff7cc) | 4 | 120 | 0 | 0.03 | yes | no | shadow lane | S |  |
| 7 | Mon Nov 23 1:45 AM | S3 seed PR (shadow-s3 14d9fe2b34) | 9 | 624 | 8,555 | 0.49 | yes | yes | shadow lane (S3) | S |  |
| 8 | Mon Nov 23 2:14 AM | shadow-follow PR 1 (c786e766da) | 19 | 1,983 | 13,043 | 0.86 | yes | yes | shadow lane | S |  |
| 9 | Mon Nov 23 3:13 AM | #9946 CLI connect | 30 | 224 | 52 | 0.11 | yes | yes | core 04ad9c8f | S |  |
| 10 | Mon Nov 23 7:43 AM | R2: N3 (#9992) + S2b-ns (#9991) + S2b-st (#9989) | 90 | 3,679 | 653 | 0.68 | yes | yes | trunk | S |  |
| 11 | Mon Nov 23 3:13 PM | p9974 + N3st + N4 | 42 | 1,484 | 37 | 0.11 | yes | yes | trunk | S |  |
| 12 | Mon Nov 23 3:43 PM | N4st | 12 | 300 | 7 | 0.01 | yes | yes | trunk | S |  |
| 13 | Mon Nov 23 4:12 PM | RP1 | 82 | 5,987 | 130 | 0.34 | yes | yes | trunk (lanes 2, 8, 10 content) | S |  |
| 14 | Mon Nov 23 4:42 PM | RP2 | 94 | 5,690 | 184 | 0.43 | yes | yes | trunk (lanes 2, 8, 10 content) | S |  |
| 15 | Mon Nov 23 6:43 PM | RP3 | 110 | 3,426 | 0 | 0.28 | yes | no | trunk (lanes 2, 8, 10 content) | S |  |
| 16 | Mon Nov 23 7:13 PM | RP4 | 110 | 2,440 | 0 | 0.22 | yes | no | trunk (lanes 2, 8, 10 content) | S |  |
| 17 | Mon Nov 23 8:55 PM | pages_by_type tie-break (type COLLATE C), 3 engines | 3 | 40 | 60 | 0.01 | yes | yes | trunk | S |  |
| 18 | Mon Nov 23 10:13 PM | RP5 | 34 | 632 | 551 | 0.09 | yes | yes | trunk (lanes 2, 8, 10 content) | S |  |
| 19 | Mon Nov 23 10:43 PM | RP6 | 50 | 5,882 | 0 | 0.29 | yes | no | trunk (lanes 2, 8, 10 content) | S |  |
| 20 | Tue Nov 24 12:25 AM | RP7 | 110 | 3,475 | 5,084 | 0.42 | yes | yes | trunk (lanes 2, 8, 10 content) | S |  |
| 21 | Tue Nov 24 1:43 AM | RP8 | 71 | 51 | 5,984 | 0.31 | yes | yes | trunk (lanes 2, 8, 10 content) | S |  |
| 22 | Tue Nov 24 3:12 AM | single-consumer-rust | 8 | 150 | 300 | 0.03 | yes | yes | lane 8 | S | SWAP-CRITICAL (not shadow) |
| 23 | Tue Nov 24 3:41 AM | Nx1 + Nx2 | 44 | 800 | 0 | 0.04 | no | no | trunk | S |  |
| 24 | Tue Nov 24 4:25 AM | UCR: ucr (unbound-claim-rust 58d310f948) + rust-init-plain | 19 | 342 | 403 | 0.06 | yes | yes | lane 8 | S |  |
| 25 | Tue Nov 24 5:13 AM | entity-key-rows | 1 | 0 | 530 | 0.04 | yes | yes | trunk | NOT |  |
| 26 | Tue Nov 24 5:43 AM | forget-rust | 6 | 8 | 234 | 0.03 | yes | yes | trunk | S |  |
| 27 | Tue Nov 24 7:55 AM | generation-writes | 46 | 1,616 | 8,202 | 0.67 | yes | yes | trunk | NOT |  |
| 28 | Tue Nov 24 8:43 AM | repair-rust.1 | 91 | 2,274 | 7,834 | 0.70 | yes | yes | trunk | S |  |
| 29 | Tue Nov 24 9:13 AM | repair-rust.2 | 91 | 2,274 | 7,834 | 0.70 | yes | yes | trunk | S |  |
| 30 | Tue Nov 24 11:25 AM | rust-rebuild-path | 61 | 1,359 | 9,912 | 0.74 | yes | yes | trunk | NOT |  |
| 31 | Tue Nov 24 12:13 PM | sync-stamp-callers | 7 | 17 | 83 | 0.01 | yes | yes | trunk | S |  |
| 32 | Tue Nov 24 2:13 PM | lane11-intake + head2-worktree-terms.1 | 108 | 2,384 | 10,898 | 0.99 | yes | yes | trunk | S |  |
| 33 | Tue Nov 24 2:55 PM | head2-worktree-terms.2 | 78 | 1,981 | 9,550 | 0.85 | yes | yes | trunk | S |  |
| 34 | Tue Nov 24 5:43 PM | R9-rest + R9-ci | 0 | 0 | 0 | 0.86 | yes | no | trunk | NOT |  |
| 35 | Tue Nov 24 7:55 PM | journal-and-segmented-purge + batch9-fixups + sync-adaptations | 109 | 792 | 1,217 | 0.44 | yes | yes | trunk | S |  |
| 36 | Wed Nov 25 7:00 AM | L2.1 | 96 | 2,081 | 13,452 | 0.81 | yes | yes | trunk (batch 10 snapshot) | S |  |
| 37 | Wed Nov 25 7:43 AM | L2.2 | 96 | 2,081 | 13,452 | 0.81 | yes | yes | trunk (batch 10 snapshot) | S |  |
| 38 | Wed Nov 25 9:55 AM | L2.3 | 96 | 2,081 | 13,452 | 0.81 | yes | yes | trunk (batch 10 snapshot) | S |  |
| 39 | Wed Nov 25 10:30 AM | L2.4 | 96 | 2,081 | 13,452 | 0.81 | yes | yes | trunk (batch 10 snapshot) | S |  |
| 40 | Wed Nov 25 11:13 AM | L2.5 | 96 | 2,081 | 13,452 | 0.81 | yes | yes | trunk (batch 10 snapshot) | S |  |
| 41 | Wed Nov 25 1:25 PM | L2.6 | 96 | 2,081 | 13,452 | 0.81 | yes | yes | trunk (batch 10 snapshot) | S |  |
| 42 | Wed Nov 25 2:00 PM | compact-receipt | 80 | 2,331 | 6,985 | 0.83 | yes | yes | lane 7 | S |  |
| 43 | Wed Nov 25 2:43 PM | doctor-join-checks-recut ab1990b18a | 11 | 132 | 539 | 0.06 | yes | yes | lane 6 | S |  |
| 44 | Wed Nov 25 4:55 PM | page-purge-rust b6fe90a45b, landing 1 of 2 | 60 | 1,993 | 8,980 | 0.80 | yes | yes | W6 / lane 13 | S |  |
| 45 | Wed Nov 25 5:30 PM | page-purge-rust b6fe90a45b, landing 2 of 2 | 59 | 1,993 | 8,981 | 0.80 | yes | yes | W6 / lane 13 | S |  |
| 46 | Wed Nov 25 7:30 PM | identity-restore-rust + chronicle-decision-rust | 92 | 1,902 | 7,576 | 0.65 | yes | yes | lane 9, lane 7 | S |  |
| 47 | Wed Nov 25 8:55 PM | core status PR #10117 (4e9075a2ae) + policy.ts | 9 | 434 | 0 | 0.03 | yes | no | core (#10117) | S |  |
| 48 | Wed Nov 25 10:55 PM | c-rust (snapshot/drill Rust, producers ba676fb5) + 21b-rust (restore Rust, producers ba676fb5) | 5 | 100 | 1,020 | 0.08 | yes | yes | producers ba676fb5 | S |  |
| 49 | Thu Nov 26 2:00 AM | derivation-inputs-rust-recut + access stack 178a49695f (row 32d-2a, with attest 68a9eb84e5) + audit-pins | 49 | 1,265 | 8,683 | 0.76 | yes | yes | lane 7, lane 6 (a9fd5b22 relay), trunk | S |  |
| 50 | Thu Nov 26 4:00 AM | key-tag-registry + fingerprint-proptest + entity-private-stops | 2 | 0 | 6,013 | 0.31 | yes | yes | trunk, lane 4, lane 11 | S |  |
| 51 | Thu Nov 26 5:25 AM | entity-variants-rust + chronicle-reads-rebased + identity-drift-rust | 95 | 2,232 | 7,868 | 0.74 | yes | yes | lane 6, lane 9 | S |  |
| 52 | Thu Nov 26 7:25 AM | sync-stamp-connectors-recut (34057d8e2f) + route-gaps-2-rust-recut + identity-entity-keys-rust-recut | 30 | 109 | 1,911 | 0.14 | yes | yes | lane 11, lane 12, lane 5 | S |  |
| 53 | Thu Nov 26 7:54 AM | GBEV 4 untraced put_page/round-trip gaps (HOLD) | 4 | 200 | 100 | 0.03 | yes | yes | HOLD, owner after GBEV-98 | NOT | SWAP-CRITICAL (not shadow) |
| 54 | Thu Nov 26 11:24 AM | page-mutation-reads e2282c75dd (N6, N14, put_page, MCP add_timeline_entry) | 17 | 337 | 1,852 | 0.18 | yes | yes | lane 7 | NOT | SWAP-CRITICAL (not shadow) |
| 55 | Thu Nov 26 2:55 PM | a1 (producers ba676fb5) + a2 (producers ba676fb5) | 6 | 200 | 800 | 0.07 | yes | yes | producers ba676fb5 | S |  |
| 56 | Thu Nov 26 6:55 PM | GBEV N5 OAuth DCR registration (oauth-dcr-rust) + GBEV N12 meetings-source.ts:297 + GBEV N1 trusted-caller reads (HOLD) | 8 | 670 | 400 | 0.09 | yes | yes | lane 12 (oauth-dcr-rust), lane 11, HOLD, owner after GBEV-98 | NOT | SWAP-CRITICAL (not shadow) |
| 57 | Thu Nov 26 8:55 PM | daily-budget-ledger | 26 | 480 | 1,300 | 0.12 | yes | yes | lane 10 | NOT | SWAP-CRITICAL (not shadow) |
| 58 | Fri Nov 27 7:25 PM | managed-root-snapshot | 8 | 150 | 300 | 0.03 | yes | yes | trunk | NOT |  |
| 59 | Fri Nov 27 9:25 PM | managed-sources-import | 24 | 600 | 1,500 | 0.14 | yes | yes | trunk | NOT |  |
| 60 | Sat Nov 28 7:55 AM | writer-release-rust | 36 | 654 | 2,189 | 0.19 | yes | yes | lane 8 | NOT |  |
| 61 | Sat Nov 28 9:00 AM | managed-journal-effects-chronicle + upsertopenloop-abort-seam | 17 | 420 | 600 | 0.08 | yes | yes | trunk | NOT |  |
| 62 | Sat Nov 28 10:25 AM | generation-writes-test + mutant-guards + sync-stamp-rest | 2 | 15 | 0 | 0.01 | yes | no | lane 7, lane 4 | NOT |  |

## 11. Measured vs estimated, open points

MEASURED: merges per window; today's merges; PR states (gh); sizes of #10001, S3 seed, shadow-follow, managed-gate, #10117, page-mutation-reads, page-purge-rust b6fe90a45b, fingerprint-proptest, entity-private-stops, access stack, doctor-join-checks-recut, extract-mentions, batch 10 vs master and vs main; the RP closure and its 8-part split; the land-2 remainder.
ESTIMATED: every landing date; review and second-round times; the 25 min CI queue; builders (2, RP 1.5 h and land-2 2.5 h a part, from about 9 PM when batch 10 is on main); batch 11 on main Mon 12 PM; sizes of producers rows (c-rust, 21b, a1, a2), GBEV N5, N12, N1 and the untraced gaps; the readiness of due-dated heads at their due time (a1 and a2 at 9 AM Thu); the cut-day run (1.5 h); that all land-2 parts and RP parts are shadow-needed (conservative).
Open points: (1) the plan has less than 10% second-round slack; the 3 recut heads, a1/a2 and the status chain are the first to slip; (2) a1/a2 at 9 AM is a hard condition: each hour later costs an hour; (3) parity-space-harddelete (ready Thu Nov 26 5 PM, from the fingerprint-proptest notes) is unmarked; if shadow-needed it lands after the cut; (4) the foreign Minder queue (#9944, #10099, #10114, #10115, #10082) is modelled as one non-strict slot each; (5) RP parts now run up to 5,987 shared TS per review (v3.8: 2K); (6) producers ba676fb5 is not a branch in the repo.
Files: /var/tmp/trunk/lt3k/ (sched3k.py, run3k.py, gen3k5.py, write3k.py, parts6k2.json, land2.json), /var/tmp/trunk/lt3k-*.json measurements.
