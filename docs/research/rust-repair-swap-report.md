# Rust repair swap report (rust-engine/main d195da9b31, 2026-11-24)

- **We learned that every `gbrain repair` kind on a Rust brain either runs, or stops with a typed `engine_capability_missing` refusal that writes nothing.** No kind returns an empty answer in place of a refusal.
- **We learned that more kinds stop than the three rows below.** 18 kinds can preview but stop before their first page or fact write. You should read the table in section 1 as the swap's list of known stops.
- **We learned that two stops are on paths a normal brain can reach without naming a kind.** `visibility` is an automatic kind, and on a Rust brain its default preview stops at `repair visibility privacy scan`. `fences` is an automatic kind too, and its apply of a database-only page stops at publication. You should decide whether the Dec 1 opt-in swap accepts these two (section 3).
- The three rows in section 2 stay as named swap-report rows. Their owner is the post-freeze lane.

## Evidence

- Code: `rust-engine/main` at d195da9b31. The Rust addon was built from that commit (`bun run rust:build`).
- Rust arm run: 69 engine-parity files: every file that runs a repair kind, plus every `test/engine-parity/*repair*` file. Each ran as `GBRAIN_TEST_RUST_ARM=1 bun test --timeout 120000 <file>`. All 69 exited 0. The Rust arm compared 662 cases equal to PGLite, and 73 cases stopped on a typed refusal.
- Refusal sites: one more run of the 10 files that hold the repair stops. A temporary log line in the harness (not committed) printed each refusal's message, detail and stack, so each stop below names the exact line that refused.
- Empty brain: a temporary test (not committed) previewed all 67 kinds on an empty Rust brain. 61 previewed. `visibility` and `private-labels` refused with `engine_capability_missing`. `ghost-pages` and `legacy-twins` refused with `not_owner_host`, and `generations` and `open-facts` refused with `invalid_params`; those refusals come from the kinds' own input checks and are the same on PGLite.
- Nothing written: a temporary edit (not committed) of the three parity cases in section 2 read the pages back on Rust after each refusal. Section 2 gives the results.
- Limits: a kind marked served has a Rust case for the paths named. A path that no Rust case reaches is marked unproven. This report reads the parity suite and the code; it is not a full coverage proof.

## 1. Every repair kind on Rust

Status words:

- **served**: every Rust case for the kind is equal to PGLite.
- **preview-only**: the preview is equal; the apply stops by name before its first write.
- **partly served**: some items apply on Rust; other items stop by name.
- **stops at preview**: the plan stops by name before it reads anything.
- **unproven**: no Rust case reaches the path named; the empty-brain preview is the only evidence.

"Auto" means the kind runs in `gbrain repair --all` and in `doctor --remediate`. Every other kind is `explicit_only`: it runs only when the operator names it.

| Kind | Auto | Rust status | Evidence (Rust arm, d195da9b31) |
|---|---|---|---|
| timeline | yes | preview-only | Preview equal. The apply stops at `repair timeline page write` (`src/core/repair/timeline.ts:137`) when a row must be written into the page. |
| visibility | yes | stops at preview | The default preview (all classes) and the events, aliases and lineage classes stop at `repair visibility privacy scan` (`visibility.ts:397`), also on an empty brain. The facts class previews; its apply stops at `repair visibility page write` (`visibility.ts:529`). |
| safe-chunks | yes | served | Plan equal (`repair-page-scans`). No apply case. |
| contextual-mode | yes | served | Preview and apply equal (`repair-runner`). |
| connector-checkpoints | yes | served | Preview and apply equal (`repair-bookkeeping`, `repair-runner`). |
| access | yes | served | Equal on a brain with nothing to repair (`repair-page-reads`). No case with a page to fix. |
| request-indexes | yes | served | Equal (`repair-runner`). |
| connector-fences | yes | preview-only | Apply stops at `repair connector-fences page write` (`connector-fences.ts:95`). |
| take-supersession | yes | partly served | Pointer reprojection equal. A relink that changes the fence stops at `repair take-supersession page write` (`take-supersession.ts:303`). |
| orphan-bindings | yes | served | Equal on a brain with no bindings. The delete case cannot seed bindings on Rust (the seed is raw SQL), so the delete path is unproven. |
| embedding-effects | yes | served | Preview and apply equal (`repair-runner`). |
| attribution-backfill | yes | unproven | Previews on an empty brain. Its plan runs raw SQL (`attribution-backfill.ts:42-62`); no Rust case gives it rows. |
| planner-stats | yes | served | Preview and apply equal (`repair-runner`). |
| fences | yes | partly served | Previews equal. The apply of a checkout file on a legacy source is equal. The apply of a database-only page stops at publication (section 2, row 3). |
| slug-conflicts | yes | served | Previews equal (`repair-fence-kinds`). No apply case. |
| accepted-takes | no | preview-only | Preview equal. The restore stops at `repair accepted-takes page write` (`accepted-takes.ts:155`). |
| google-file-modes | no | served | Preview and apply equal. |
| stale-atoms | no | preview-only | Apply stops at `repair stale-atoms retirement` (`stale-atoms.ts:149`). |
| atoms-restore | no | served | Preview and restore equal. |
| atom-fence-rows | no | served | Equal (`repair-fence-scans`). |
| extractor-facts | no | preview-only | Apply stops at `repair extractor-facts fact write` (`extractor-facts.ts:222`). |
| unwithdrawn-facts | no | unproven | The parity seed stops on Rust (a raw statement in `withHeldPageKeys`). By the code, the preview stops at `repair unwithdrawn-facts fence evidence` (`unwithdrawn-facts.ts:107`) once a candidate has a page, and the apply stops at `repair unwithdrawn-facts fact write` (`:248`). |
| purged-page-facts | no | preview-only | Apply stops at `repair purged-page-facts expire` (`purged-page-facts.ts:152`). The seed that purges a real page stops at the retention purge (lane 13). |
| purged-change-reasons | no | served | Preview and apply equal. |
| conversation-labels | no | served | Preview and apply ran on Rust. The case then stops at its own read `listActiveFactIdsOfPage` (facts), which is in the test, not in the kind. |
| captured-facts | no | preview-only | Apply stops at `repair captured-facts page write` (`captured-facts.ts:302`). |
| agent-session-facts | no | served | Preview equal (the case title still says Rust refuses; the run shows equal). |
| redacted-facts | no | partly served | A database-only row restores equal. A fenced row stops at `repair redacted-facts page write` (`redacted-facts.ts:280`). |
| loop-facts | no | served | Equal. |
| ontology-facts | no | preview-only | Apply stops at `repair ontology-facts fact write` (capability `facts`, `ontology-facts.ts:140`). |
| facts-rehome | no | preview-only | Apply stops at `repair facts-rehome fact write` (`facts-rehome.ts:125`). |
| consolidate-ties | no | preview-only | Apply stops at `repair consolidate-ties fact write` (`consolidate-ties.ts:98`). |
| duplicate-facts | no | preview-only | Apply stops at `repair duplicate-facts page write` (`duplicate-facts.ts:173`). |
| orphan-children | no | served | Equal on a brain with nothing to repair. |
| failed-writes | no | served | Equal. |
| split-facts | no | preview-only | The apply stops at publication, the same stop as section 2 row 3 (`mergeOne`, `split-facts.ts:144`). |
| frontmatter | no | served | Plan equal (`repair-plan-scans`). No apply case. |
| timeline-comments | no | partly served | Database rows clean equal. A materialized bullet stops at `repair timeline-comments page write` (`timeline-comments.ts:105`). |
| timeline-order | no | preview-only | Apply stops at `repair timeline-order page write` (`timeline-order.ts:191`). |
| contact-rows | no | served | Equal. |
| managed-sync-orphans | no | served | Equal. |
| content-receipt-root | no | served | Equal on a brain with nothing to rebind. |
| frontmatter-keys | no | served | Preview equal; the apply refuses with the same code on every arm. |
| file-drift | no | served | Equal on a brain with no drift. The held-files case stops in its seed (`performManagedSync`, managed_persistence), so that path is unproven. |
| stuck-recovery | no | served | Preview equal; the apply refuses with the same code on every arm. |
| ghost-pages | no | served | Preview and apply equal on an owned brain. |
| origin-twins | no | served | Plan and merge mode equal. |
| moved-pages | no | stops at preview | A held pair is equal. A moved pair stops at `repair moved-pages access check` (section 2, row 2). |
| receipt-compaction | no | served | Equal. |
| aliases | no | served | Equal. |
| rename-identity | no | partly served | No pair: equal. An open pair stops at a raw statement with no step name (`member=executeRaw`, `src/core/sync-identity-downgrades.ts:148`). |
| overwritten-edits | no | preview-only | Apply stops at `repair overwritten-edits page write` (`overwritten-edits.ts:154`). |
| legacy-twins | no | served | Preview and merge equal on an owned brain. |
| missing-tables | no | served | Equal. |
| url-clone-fences | no | preview-only | Apply stops at `repair url-clone-fences page write` (`url-clone-fences.ts:240`). |
| segmented-mirror | no | served | Equal (no withdrawal case). |
| segmented-tiling | no | served | Plan equal. |
| uncommitted-deletions | no | served | Equal. |
| generations | no | served | Preview equal. |
| lost-fence-rows | no | preview-only | Apply stops at `repair lost-fence-rows page write` (`lost-fence-rows.ts:256`). |
| fact-claim-dates | no | preview-only | Apply stops at `repair fact-claim-dates fact write` or `... page write` (`fact-claim-dates.ts:222`). |
| provenance | no | unproven | Previews on an empty brain. No Rust case gives it rows; it reads `body_storage` through raw SQL (`provenance.ts:81`). |
| secret-spans | no | served | 18 cases equal (`repair-secret-spans`). |
| rows-behind | no | served | Equal on a brain with no owner binding. |
| facts-home | no | preview-only | Apply stops at `repair facts-home page write` (`facts-home.ts:110`). |
| private-labels | no | stops at preview | Section 2, row 1. |
| open-facts | no | stops at preview | The window preview stops at `repair open-facts privacy scan` (`open-facts.ts:267`). The named-row path is equal. |

Totals (67 kinds): 37 served, 18 preview-only, 5 partly served, 4 stop at preview, 3 unproven. Two of them are automatic kinds with a stop on a common path: `visibility` (stops at preview) and `fences` (partly served).

## 2. The three named swap-report rows

| | Row 1 | Row 2 | Row 3 |
|---|---|---|---|
| Kind | `private-labels` | `moved-pages` | `fences` (also `split-facts`) |
| Stop text on Rust | `repair private-labels privacy scan` | `repair moved-pages access check` | Observed in the parity case: `member=executeRaw capability=raw_sql outcome=none written=nothing`, message "...refused at publication on 3 claims, the limit (3); it is not claimed again." The settle step names `repair write publication (request <id> stays queued)` only when the request is still queued. |
| File:line | `src/core/repair/private-labels.ts:386` (plan, before any read) | `src/core/persistence/moved-pages.ts:286` (verdict, `pairRefusal`) | Refusal recorded at `src/core/persistence/coordinator.ts:404`; the raw statements are in `guardFenceRows`, `src/core/trust/fence-guard.ts:70-155`; the queued text is `src/core/repair/settle.ts:42` |
| RUST_ENGINE.md row | 38 | 39 | None. This stop has no row in the loss list yet. |
| Test that proves it fails closed | `test/engine-parity/repair-history-kinds.test.ts:463` checks the refusal text on Rust | `test/engine-parity/repair-history-kinds.test.ts:442` checks the refusal text on Rust | `test/engine-parity/repair-fence-kinds.test.ts:133` accepts either refusal text on Rust |
| Nothing written | The refusal detail says `written=nothing`. The test does not read the page back. A probe read it back: frontmatter `access: private` and the body were unchanged. | The refusal detail says `written=nothing`; the stop is in the preview. A probe read both pages back: both live and unchanged. | The refusal detail says `written=nothing`. The test does not read the page back. A probe read it back: the body was byte-identical and the broken fence was still broken (1 warning). |
| explicit_only | yes | yes | no: `fences` is an automatic kind. Only its apply reaches the stop, and `gbrain repair --all` previews unless `--apply` is passed. `split-facts` is explicit_only. |
| Owner | post-freeze lane | post-freeze lane | post-freeze lane |

The probes were temporary edits, not committed. The post-freeze lane should add the read-back to each of the three tests, so each test proves "nothing written" by itself.

## 3. Findings for the swap decision

1. **`visibility` is automatic, and it stops on a Rust brain by default.** `gbrain repair --all` and `doctor --remediate` run it. Its default preview covers all classes, so it stops at `repair visibility privacy scan` before it reads anything, also on an empty brain. `runRepairKinds` (`src/commands/repair.ts:741`) records the kind as an error and runs the next kind, so the whole run does not stop. The run's exit code shows the error. The stop is safe (nothing read, nothing written), but every automatic run on a Rust brain reports it.
2. **The publication stop has no step name.** On Rust, the fences apply and the split-facts apply end with `member=executeRaw`, not `repair write publication`. The refusal is typed and writes nothing, but an operator does not see which step refused. The text `repair write publication` appears only when the request is still queued at settle.
3. **The publication stop has no RUST_ENGINE.md row.** Rows 38 and 39 exist. The `guardFenceRows` stop and the page-visibility fallback (section 4.3) have no row.
4. **Two more stops refuse a raw statement with no step name:** `rename-identity` with an open pair (`sync-identity-downgrades.ts:148`), and the `unwithdrawn-facts` parity seed. Both are explicit_only.

## 4. Inventory for the post-freeze privacy lane

### 4.1 What rows 38 and 39 need

Row 39, `moved-pages` access check. For two page ids, the comparison reads:

- `page_readers` (the normalized readers),
- `folder_rule_ids` (the folder rules stamped on the page),
- `frontmatter->'readable_by'`,
- `world`: `privateSnapshotFilterFragment` over the page's own type and frontmatter.

It compares the four values of the old page and the new page. It needs no caller policy.

Row 38, `private-labels`. The plan makes four kinds of reads through raw SQL:

- The label scan (`scanLabelled`, `private-labels.ts:122`): live pages of the selected sources whose `visibility` is `private`, or that have no `visibility` and match `privacyAliasSql`, paged by id, with the source's `canonical = git` flag.
- The restore read (`private-labels.ts:214`): live pages by id.
- The dependents read (`dependentsSql('clear')`, `src/core/repair/dependents-sql.ts`): the pages that the label window would expose. It evaluates `privacyPartSql` twice: on each candidate page as it is now, and on the candidate as it would be once the window's keys are removed from the listed pages (a "postimage" of `pages`).
- The re-embed reads (`reembedding`, `private-labels.ts:285-287`): `contextual_retrieval_mode` by id, and the pages with a chunk that has no vector.

The apply writes each page through `writeLabelPage` (the maintenance door, or the legacy import under the page lock).

### 4.2 What the Rust store already gives

The Rust store has more of the privacy predicate than the B6 notes said. In `rust/crates/gbrain-store/src/`:

- `facts/privacy.rs`:
  - `alias_private` is `privacyAliasSql`.
  - `snapshot_fields_allow` is `privateSnapshotFilterFragment` over a type and frontmatter.
  - `privacy_allows` is `privacyPartSql`: the page's own fields, `derived_origin_private` and `declared_lineage_private`.
  - `page_hidden` / `page_hidden_with` is the full page policy (member access, folder rules, owner-only, privacy part), driven by a `PrivacyPolicy`.
  - `stamped_rules` reads a page's folder rules, and `access_readers` normalizes its readers.
- `page_visibility.rs` (added 2026-11-24): `read_page_hidden_from_caller` (judges a live or soft-deleted row), `read_caller_page_access`, `read_write_visibility_probe` and `read_page_privacy_hidden`.
- `label_door.rs`: `list_origin_dependents` is `dependentsSql('remove')`, the postimage with the cleared rows removed.
- `access_rules.rs`: folder rules, pending coverage and policy revisions.

What is still missing:

- Row 39: a typed read that returns the four values for a list of page ids. Every piece exists (`access_readers`, `stamped_rules`, the frontmatter, `snapshot_fields_allow`).
- Row 38:
  - a typed label-scan list (with `alias_private`),
  - a live-pages-by-id read for the restore, if no served member fits,
  - the two re-embed reads,
  - the clear-mode dependents read. This is the hard part. `list_origin_dependents` removes the cleared rows. Clear mode keeps them, with the window's keys removed from their frontmatter. The helpers that `privacy_allows` calls (`derived_origin_private`, `declared_lineage_private`) read other pages from the store, so they need an overlay that returns the postimage frontmatter for the cleared pages.
- Both rows: the label write must publish on Rust. A page with a facts fence meets the same `guardFenceRows` raw statements as row 3. Until that guard is typed, the lane can serve only pages without a facts fence, or must type the guard too.

### 4.3 The page-visibility fallback

`authorizePageVisibility` (`src/core/persistence/page-visibility.ts:97-101`, `hiddenUnder`) asks `readLinkTargetPages` first. When the slug has no live row, only a soft-deleted one, it falls back to a raw statement with `writerReadPolicySql`. On Rust that statement refuses with `engine_capability_missing`, and nothing is written: `test/engine-parity/owner-write-privacy.test.ts:136` checks it on every arm.

`read_page_hidden_from_caller` already judges a soft-deleted row, so it can serve the fallback. It needs these things first:

- the stored writer's policy turned into a `PrivacyPolicy`: the identity (`writerIdentities`), the folder access (`folderAccessForAll`), the owner record (`storedOwnerSpeaksForItself`) and the hide flag (`entity_privacy`);
- multiple identities: `writerIdentities` returns one identity set per audience entry (GBRA-231) and `PrivacyPolicy` holds one. The lane can serve single-identity writers and keep the refusal for an audience write;
- a labelled-only writer: the store never creates a labelled-only member, so the member can refuse that case.

### 4.4 Revised estimate (estimate, not measured)

| Work | Days |
|---|---|
| Row 39: typed access-values read, napi, TypeScript member, 3-arm parity, read classes | 1 |
| Row 38: label scan, restore and re-embed reads | 1 |
| Row 38: clear-mode dependents with a postimage overlay through `privacy_allows`, plus 3-arm parity on derived, atom, concept and life-chronicle dependents | 2 to 3 |
| Row 38: apply on Rust for pages without a facts fence; a named stop for pages with one | 0.5 |
| Page-visibility fallback through `read_page_hidden_from_caller`, single identity | 1 to 1.5 |
| Read-back checks in the three tests, RUST_ENGINE.md rows, report update | 0.5 |
| **Total** | **6 to 7.5** |

Row 39 alone is about 1 day, because it reuses existing Rust code. Row 38 stays the large item, because of the clear-mode overlay. Typing `guardFenceRows` (row 3) is not in this estimate; it is a facts-lane item and would also serve the fences and split-facts applies.

## Out of scope

- `visibility` (events, aliases, lineage classes) and `open-facts` stop at the same kind of privacy scan. They need folder rules and fact privacy, so this inventory does not cover them.
- The preview-only kinds in section 1 stop at page or fact writes owned by other lanes (lane 7's page write, the facts lane). This report lists them and does not plan them.
