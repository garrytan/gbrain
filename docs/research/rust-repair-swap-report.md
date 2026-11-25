# Rust repair swap report (rust-engine/main 78a31fe57e, 2026-11-25)

- **We learned that batch 14 made almost every `gbrain repair` kind run on a Rust brain.** 60 of 68 kinds are served: every Rust parity case for them is equal to PGLite. Every other path stops with a typed `engine_capability_missing` refusal that writes nothing. No kind returns an empty answer in place of a refusal.
- **We learned that the stop every opted-in user would have seen is gone.** The `visibility` default preview, which `gbrain repair --all` and `doctor --remediate` run, is equal on all 3 engines, also on an empty brain (lane 16). You should read the remaining stops in section 2 as stops of the apply step, which an operator reaches only with `--apply`, plus one explicit kind.
- The first version of this report (d195da9b31) listed 18 kinds as preview-only and named three swap-report rows. Batch 14 closed rows 38 and 39 (lane 16), the publication stop (lane 19) and the visibility preview stop (lane 16). Row 53, the page-visibility fallback, stays.

## Evidence

- Code: `rust-engine/main` at 78a31fe57e (batch 14 and two test-only fixes), merged into this branch. The Rust addon was built from the merged head (`bun run rust:build`).
- Rust arm run: the 31 engine-parity files that run a repair kind or are named `*repair*`. Each ran as `GBRAIN_TEST_RUST_ARM=1 bun test --timeout 120000 <file>`, and all 31 exited 0. The Rust arm compared 203 cases equal to PGLite, and 7 cases stopped on a typed refusal.
- Refusal sites: a temporary log line in the harness (not committed) printed the detail and stack of each of the 7 stops. Section 2 lists them.
- Empty brain: a temporary test (not committed) previewed all 68 kinds on an empty brain on PGLite and Rust. 63 previewed on Rust. `ghost-pages` and `legacy-twins` refused with `not_owner_host`, and `generations` and `open-facts` refused with `invalid_params`; those 4 come from the kinds' own input checks and are the same on PGLite. `slug-spelling` previews on PGLite and refuses on Rust with `engine_capability_missing` (RUST_ENGINE.md row 50).
- The `visibility` default preview has its own parity file, `test/engine-parity/repair-visibility-default.test.ts` (section 3).
- Limits: a kind marked served has a Rust case for the paths named. A path that no Rust case reaches is marked unproven. This report reads the parity suite and the code; it is not a full coverage proof.

## 1. Every repair kind on Rust

Status words:

- **served**: every Rust case for the kind is equal to PGLite.
- **preview-only**: the preview is equal; the apply stops by name before its first write.
- **partly served**: some items apply on Rust; other items stop by name.
- **stops**: the kind refuses on Rust before it reads anything.
- **unproven**: no Rust case reaches the path named; the empty-brain preview is the only evidence.

"Auto" means the kind runs in `gbrain repair --all` and in `doctor --remediate`. Every other kind is `explicit_only`: it runs only when the operator names it.

| Kind | Auto | Rust status | Evidence (Rust arm, 78a31fe57e) |
|---|---|---|---|
| timeline | yes | served | Preview and the page write equal (`repair-takes-timeline`). |
| visibility | yes | partly served | Default preview (all classes), the class previews and a named page equal; database-only fact rows (phase 4) apply on Rust through `tightenDatabaseFactVisibility`. Page items stop at `repair visibility page write` (`visibility.ts:508`), and a fenced fact row stops there too (`visibility.ts:244`). |
| safe-chunks | yes | served | Plan equal. |
| contextual-mode | yes | served | Preview and apply equal. |
| connector-checkpoints | yes | served | Preview and apply equal. |
| access | yes | served | Equal on a brain with nothing to repair. No case with a page to fix. |
| request-indexes | yes | served | Equal. |
| connector-fences | yes | served | Preview and the fence move equal. |
| take-supersession | yes | served | Relink and reprojection equal. |
| orphan-bindings | yes | served | Equal on a brain with no bindings. The delete case cannot seed bindings on Rust (the seed is raw SQL), so the delete path is unproven. |
| embedding-effects | yes | served | Preview and apply equal. |
| attribution-backfill | yes | unproven | Previews on an empty brain. Its plan runs raw SQL (`attribution-backfill.ts`); no Rust case gives it rows. |
| planner-stats | yes | served | Preview and apply equal. |
| fences | yes | served | Previews equal; both applies (checkout file on a legacy source, database-only page) equal. |
| slug-conflicts | yes | served | Previews equal. No apply case. |
| accepted-takes | no | served | Preview and restore equal. |
| google-file-modes | no | served | Preview and apply equal. |
| stale-atoms | no | served | Preview and retirement equal. |
| atoms-restore | no | served | Preview and restore equal. |
| atom-fence-rows | no | served | Equal. |
| extractor-facts | no | served | Preview and apply equal. |
| unwithdrawn-facts | no | preview-only | Preview equal. The apply stops at `repair unwithdrawn-facts fact write` (`unwithdrawn-facts.ts:243`). |
| purged-page-facts | no | served | Preview and apply equal. A case that first purges a real page stops in its seed at the retention purge (lane 13), not in the kind. |
| purged-change-reasons | no | served | Preview and apply equal. |
| conversation-labels | no | served | Preview and retirement equal. |
| captured-facts | no | served | Preview and apply equal. |
| agent-session-facts | no | served | Preview equal. |
| redacted-facts | no | served | A database-only row and a fenced row restore equal. |
| loop-facts | no | served | Equal. |
| ontology-facts | no | served | Preview and apply equal. |
| facts-rehome | no | served | Preview and apply equal. |
| consolidate-ties | no | served | Preview and apply equal. |
| duplicate-facts | no | served | Preview and the apply of a database-only group equal. |
| orphan-children | no | served | Equal on a brain with nothing to repair. |
| failed-writes | no | served | Equal. |
| split-facts | no | served | Merge equal. |
| frontmatter | no | served | Plan equal. No apply case. |
| timeline-comments | no | served | Database rows and a materialized bullet clean equal. |
| timeline-order | no | served | Preview and reorder equal. |
| contact-rows | no | served | Equal. |
| managed-sync-orphans | no | served | Equal. |
| content-receipt-root | no | served | Equal on a brain with nothing to rebind. |
| frontmatter-keys | no | served | Preview equal; the apply refuses with the same code on every arm. |
| file-drift | no | served | Equal on a brain with no drift. Two held-file cases stop in their seeds (`performManagedSync`, a raw statement), so those paths are unproven. |
| stuck-recovery | no | served | Preview equal; the apply refuses with the same code on every arm. |
| ghost-pages | no | served | Preview and apply equal on an owned brain. |
| origin-twins | no | served | Plan and merge mode equal. |
| moved-pages | no | served | A held pair and a moved pair equal. |
| receipt-compaction | no | served | Equal. |
| aliases | no | served | Equal. |
| rename-identity | no | served | No pair and an open pair equal. |
| slug-spelling | no | stops | Refuses on Rust with `member=executeRaw` (RUST_ENGINE.md row 50, legacy slug spellings). |
| overwritten-edits | no | served | Preview and restore equal. |
| legacy-twins | no | served | Preview and merge equal on an owned brain. |
| missing-tables | no | served | Equal. |
| url-clone-fences | no | served | Preview and apply equal. |
| segmented-mirror | no | served | Equal (no withdrawal case). |
| segmented-tiling | no | served | Plan equal. |
| uncommitted-deletions | no | served | Equal. |
| generations | no | served | Preview equal. |
| lost-fence-rows | no | served | Preview and restore equal. |
| fact-claim-dates | no | partly served | A database-only fact move applies equal. A page move stops at `repair fact-claim-dates page write` (`fact-claim-dates.ts:222`). |
| provenance | no | unproven | Previews on an empty brain. No Rust case gives it rows; it reads `body_storage` through raw SQL (`provenance.ts`). |
| secret-spans | no | served | 18 cases equal (`repair-secret-spans`). |
| rows-behind | no | served | Equal on a brain with no owner binding. |
| facts-home | no | served | Preview and the holding-page write equal. |
| private-labels | no | preview-only | Preview equal, including the pages a clear would expose (row 38). The apply stops at `repair private-labels page write` (`private-labels.ts:386`). |
| open-facts | no | preview-only | Preview equal. The apply and the undo stop at `repair open-facts privacy scan` (`open-facts.ts:211`, `:256`). |

Totals (68 kinds): 60 served, 3 preview-only, 2 partly served, 1 stops, 2 unproven. The only automatic kinds that are not fully served are `visibility` (its apply of page items) and `attribution-backfill` (unproven).

## 2. The stops that remain

| Stop on Rust | File:line | Kind | Auto | Test that pins it | RUST_ENGINE.md row |
|---|---|---|---|---|---|
| `repair visibility page write` | `src/core/repair/visibility.ts:508` (page items), `:244` (fenced fact row) | visibility | yes, but only `--apply` reaches it | `test/engine-parity/repair-visibility-default.test.ts` (refusal text, and the page's frontmatter read back unchanged) | 52 (closed for the preview) |
| `repair private-labels page write` | `src/core/repair/private-labels.ts:386` | private-labels | no | `test/engine-parity/repair-history-kinds.test.ts` | 38 (closed for the preview) |
| `repair open-facts privacy scan` | `src/core/repair/open-facts.ts:211`, `:256` | open-facts | no | `test/engine-parity/repair-facts-previews-3.test.ts` | none |
| `repair unwithdrawn-facts fact write` | `src/core/repair/unwithdrawn-facts.ts:243` | unwithdrawn-facts | no | none on the apply | none |
| `repair fact-claim-dates page write` | `src/core/repair/fact-claim-dates.ts:222` | fact-claim-dates | no | none on the page move | none |
| `member=executeRaw` | `src/core/repair/slug-spelling.ts` | slug-spelling | no | `test/engine-parity/repair-slug-spelling.test.ts` | 50 |
| `engine_capability_missing` (raw_sql) on a remote write over a slug with only a soft-deleted row | `src/core/persistence/page-visibility.ts:97-101` (`hiddenUnder`) | not a repair kind | n/a | `test/engine-parity/owner-write-privacy.test.ts` ("loss (32e-d-1 raw fallback)"), passes on the Rust arm at 78a31fe57e | 53 |

Each stop refuses before its first write (`outcome=none written=nothing`). Owner of the remaining repair stops: the post-freeze lane.

Rows closed since the first version of this report:

- Row 38, `private-labels` preview: lane 16, 9dc5dfb50d ("Rust brains can preview gbrain repair private-labels, including the pages a clear would expose"), on main through 1e1e2320e3.
- Row 39, `moved-pages` access check: lane 16, b5e12f74dd (`listPageAccessKeys`), on main through 1e1e2320e3.
- Row 51, the publication stop of the fences and split-facts applies: lane 19, 1e667f30ce ("Saving a page with a facts or takes table works on a Rust brain"), on main through 47cc5adf8b. The facts-fence guard (`src/core/trust/fence-guard.ts`) now runs through typed members, and both applies are equal on the Rust arm. The step-name gap goes with it: no refusal is left there to name.
- Row 52, the `visibility` default preview: lane 16, f238821209 ("Rust brains can preview gbrain repair visibility: events, aliases, atom lineage and named pages"), on main through 1e1e2320e3.

## 3. The visibility default preview

On a Rust brain every `gbrain repair --all` and `doctor --remediate` used to report an error for visibility, with nothing read or written. At 78a31fe57e it previews the same as PGLite and Postgres.

`test/engine-parity/repair-visibility-default.test.ts` runs on all 3 engines:

1. An empty brain: the default preview (all classes) lists nothing, equal on every arm.
2. An atom and a Life Chronicle event of a private origin, a page private by a privacy alias alone, and that page's open twin in another source: the default preview lists exactly the three pages, with `open_twins` 1, equal on every arm.
3. The apply of those page items: PGLite and Postgres apply them; Rust refuses at `repair visibility page write`, and the page's frontmatter reads back unchanged.

Fail-first: on rust-engine/main d195da9b31 (before batch 14), cases 1 and 2 fail on the Rust arm with `repair visibility privacy scan`; PGLite and Postgres run them.

Database-only fact rows (phase 4) now apply on Rust through `tightenDatabaseFactVisibility`. The rest of the apply still stops at `repair visibility page write` (`visibility.ts:508`; a fenced fact row at `:244`).

## 4. What is left for the post-freeze lane

- **Page writes of three explicit kinds.** `private-labels`, `fact-claim-dates` (page move) and `visibility` (page items, fenced fact rows) stop at their page write. Each needs its label or page write to publish on Rust.
- **Fact writes of two explicit kinds.** `unwithdrawn-facts` (apply) and `open-facts` (apply and undo) still lock and write facts through raw SQL.
- **The page-visibility fallback (row 32e-d-2; the loss that was row 53 of the repair close-out).** `read_page_hidden_from_caller` (`rust/crates/gbrain-store/src/page_visibility.rs`) already judges a soft-deleted row. It needs the stored writer's policy as a `PrivacyPolicy`: the identity (`writerIdentities`), the folder access, the owner record and the hide flag. `writerIdentities` returns one identity set per audience entry, and `PrivacyPolicy` holds one, so the lane can serve single-identity writers and keep the refusal for an audience write.
- **Unproven paths.** `attribution-backfill` and `provenance` need a Rust case with rows. `orphan-bindings` and `file-drift` need seeds that do not use raw SQL.
- **Estimate (estimate, not measured):** the page-visibility fallback is about 1 to 1.5 days. The page and fact writes depend on the page-write lane and are not estimated here.

## Out of scope

- `slug-spelling` is row 50's (legacy slug spellings), not a repair-lane item.
- The retention purge stop in a `purged-page-facts` seed belongs to lane 13.
