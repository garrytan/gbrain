# Rust engine parity tests: completeness and correctness audit

Audited tree: `rust-engine/main` at `0ce95bbf7f` (`0ce95bbf7f9277daea1d4449fd3dd375d78e5143`), Nov 20, 2026.
Read-only audit. No test or product code changed. The mutation run used a local scratch branch that was never pushed.
Paths and line numbers refer to that trunk commit. Many of the test files named here exist only on `rust-engine/main`,
not yet on master.

## TL;DR
<!-- repo-paths: historical -->

We learned that the parity suite is a strong tool for one job, "Rust gives the same answer as PGLite on a small
fresh brain", and a weak tool for the job the swap needs, "Rust gives the right answer on the owner's production
brain, and nothing else broke on the way". You should gate the trunk on the checks that already exist (most of them do
not run on a trunk push), make a refusal or an empty answer fail a positive case, and add expected values so a bug that
both engines share can fail a test.

Top 5 issues, by production risk:

1. **A push to the trunk runs almost no gate.** Only the advisory Rust CLI check runs on `rust-engine/**` pushes. The
   parity Rust arm, the store tests, the export byte check, unit tests and every E2E file run on master, pull requests
   to master, the merge queue or a schedule, not on a trunk push. Four trunk E2E regressions from Nov 18 and 19 got
   through this gap (issue 2).
2. **A typed-member move drops the wrapper that the raw statement went through, and no guard sees it.** Four
   regressions: a hand-built test engine, a memo, a preparer deadline and an abort signal. Parity compares answers, so
   it cannot see any of them. Each has a cheap static guard (issue 2, table).
3. **The parity oracle is "same as PGLite", so a bug both engines share always passes.** Of the 96 findings in the
   behavior audit, 81 are in shared TypeScript above the engine and 11 are copied into the Rust store. The parity
   suite cannot catch any of those 92. Link counts and link types after an import are not pinned by any case. Two
   tests pin a known-wrong value as correct (issue 3).
4. **A green Rust result can mean "refused" or "empty".** The harness accepts a typed refusal before it checks that
   the target method ran, several cases stop in setup, the CLI test returns early on a refusal, and the tally pins
   are per-file floors, so one case can swap from equal to refused unseen (issue 4).
5. **The comparisons that do run are normalized and small.** Keys sorted, ids and timestamps masked, stderr
   dropped, MCP structured content ignored, markdown never byte-compared in CI. Fixtures are at most about 1,000
   ASCII pages, against a production brain of about 13,700 pages (issues 5 and 6).

Mutation catch rate: 23 of 29 reachable mutants caught (79%); 23 of 28 (82%) if M22 is an equivalent mutant. The parity files alone catch 22 of 29 (76%); the CLI parity test alone catches 6 of 29 (21%). 10 of the 23 caught mutants are caught by exactly one test file, and M01 (list order reversed) is caught only by the CLI test. Six survivors: tag order, soft-deleted keyword hit, graph default depth, re-added link context, restore timestamp, NUL in a title.

## Scope and method
<!-- repo-paths: historical -->

- Coverage, oracle correctness, fixture realism, durability and evals alignment were each read against the tree
  at `0ce95bbf7f`. Line numbers below refer to that commit.
- Mutation testing: 31 hand-written mutants of the Rust store (`rust/crates/gbrain-store/src/`), each a one-line
  change to a behavior a user can see (sort order, limit, privacy filter, soft delete, timestamps). For each mutant:
  build the addon, run all 145 `test/engine-parity/` files with the Rust arm on (PGLite plus Rust, no Postgres), then
  run `test/rust-cli-parity.serial.test.ts`. A mutant is caught if any file fails.
- Baseline at `0ce95bbf7f`, before any mutant: 145 parity files, 0 failed, tallies 1,289 equal and 60 stopped, 0
  diverged (matches `test/engine-parity/rust-tally.tsv`); Rust CLI parity 40 pass, 0 fail (37 equal, 1 refused).
  `cargo test --release -p gbrain-store`: 1,240 pass, 1 fail. The one failure
  (`page_columns::tests::writing_a_core_field_is_a_bug`) expects a `debug_assert!` panic, so it fails only in a
  release build; CI runs a debug build. It is an artifact of this run, not a defect.
- The cross-reference with the behavior audit (96 findings, branch `behavior-audit/nov21`,
  `docs/research/gbrain-behavior-audit.md`) classes each finding by whether a parity run could catch it.

## Mutation results
<!-- repo-paths: historical -->

| ID | Area | Mutation (Rust store) | Result | Failing parity files / CLI cases |
|---|---|---|---|---|
| M01 | list | listPages default sort reversed (oldest first) | CLI only (3 cases) |  |
| M02 | list | listPages returns limit+1 rows | caught | owner-only-reads, pages |
| M03 | list | listPages ignores the tag filter | caught | pages; CLI 1 |
| M04 | privacy | listPages ignores excludePrivate | caught | owner-only-reads, pages |
| M05 | pages | page drops effective_date_source | caught | pages; CLI 2 |
| M06 | pages | deleted_at null read back as empty string | caught | 6 files; CLI 6 |
| M07 | tags | readPageSnapshot tags not sorted | **survived** | no case adds tags out of order |
| M08 | privacy | get_tags ignores excludePrivate | unreachable | napi `getTags` calls `get_tags_query` (`rust/crates/gbrain-napi/src/families/tags.rs:25`); see M31 |
| M09 | facts | timestamps lose sub-millisecond digits | caught | facts |
| M10 | versions | getVersions oldest first | caught | private-page-reads, trust-tier-reads, versions-raw |
| M11 | versions | getVersions returns limit+1 | caught | versions-raw |
| M12 | links | link rows in reverse id order | caught | link-read-options |
| M13 | links | paged link read returns limit+1 | caught | link-read-options |
| M14 | privacy | link reads ignore link_private_ok | caught | link-read-options, unrestricted-member-page-reads |
| M15 | links | links from soft-deleted pages served | caught | links |
| M16 | timeline | getTimeline oldest first | caught | timeline; CLI 1 |
| M17 | timeline | getTimeline returns limit-1 | caught | search-reads, stats, timeline; CLI 2 |
| M18 | privacy | getTimeline serves private events | caught | timeline |
| M19 | search | keyword tie-break reversed | caught | keyword-visibility, search |
| M20 | search | keyword returns limit-1 | caught | keyword-visibility, search |
| M21 | privacy | keyword ignores excludePrivate | caught | 4 files |
| M22 | search | keyword serves a soft-deleted page | **survived** | likely equivalent; see notes |
| M23 | search | vector tie-break reversed | caught | search |
| M24 | resolve | resolveSlugs returns at most 4 fuzzy matches | caught | pages |
| M25 | graph | traverseGraph default depth 4, not 5 | **survived** | every case passes a depth |
| M26 | links | re-adding a link keeps the old context | **survived** | no case re-adds a link with new context |
| M27 | pages | restorePage does not bump updated_at | **survived** | timestamps are masked (issue 5) |
| M28 | sources | source rows lose last_sync_at | caught | source-resolver-reads |
| M29 | pages | countPages counts soft-deleted pages | unreachable | no TypeScript member calls napi `countPages`; Rust unit tests cover it |
| M30 | pages | putPage keeps NUL bytes in the title | **survived** | no fixture has a NUL byte (issue 6) |
| M31 | privacy | getTags (served path) ignores excludePrivate | caught | page-read-options, private-page-reads |

Counts exclude M08 and M29 (no TypeScript caller reaches the mutated code). Run: PGLite plus Rust, no Postgres, `0ce95bbf7f`.

What the table says:

- Thin protection: 10 of the 23 caught mutants fail exactly one file (M01, M09, M11, M12, M13, M15, M18, M23, M24,
  M28). Deleting or weakening that one file would let the bug through. Privacy filters are the best covered
  (M04, M14, M21, M31 each fail two or more files); M18 is the exception, caught by `timeline` alone.
- M01 shows the parity suite can miss a default sort: no parity case failed when the `listPages` default order was
  reversed. Only the CLI test, which is advisory (issue 1), saw it.
- Survivors map to issues already listed: M07 and M25 (cases always pass the argument or the sorted shape), M26 (no
  update path for a link), M27 (timestamps masked, issue 5), M30 (no NUL or unusual bytes in fixtures, issue 6).
- M22 is likely equivalent: `soft_delete_page` changes the page's tags revision, which unseals the text projection, so
  the served check in `rust/crates/gbrain-store/src/keyword/filters.rs` already hides the page. A soft-deleted page
  with a served projection (for example a re-index after delete) would expose it; this audit did not prove that state
  is reachable or unreachable.
- Not tested by mutation: the TypeScript code above the engine. A mutant there changes both arms the same way, so
  parity cannot catch it by design (issue 3).

## Top issues, ranked by production risk
<!-- repo-paths: historical -->

Risk: **High** means a wrong answer, a privacy leak or lost data could reach the owner's production brain at the
swap. **Medium** means a regression can slip past a check. **Low** is hygiene. Size: **S** under a day, **M** one to
three days, **L** more.

### 1. High: the trunk gets almost no gate on push
<!-- repo-paths: historical -->

- `.github/workflows/rust-engine.yml` pushes only on `master` (`push:` block near line 64). `test.yml` pushes and
  takes pull requests only for `master`. `e2e.yml` runs on a push to `master`, the merge queue, the nightly schedule
  and a manual dispatch.
- The one workflow with a `rust-engine/**` push trigger is `.github/workflows/rust-cli-parity.yml` (line 25). It runs
  one file, `test/rust-cli-parity.serial.test.ts`, and its header calls it advisory. Its path list omits
  `test/engine-parity/**`, the tally and divergence files and `scripts/rust-census/**`.
- Lane branches reach the trunk without a pull request. So on a trunk push the Rust arm of the 145 parity files, the
  cargo store tests, the differential test, the export test, the unit lane and all E2E files do not run.
- Evidence that this matters now: issue 2. `test/e2e/sync-status-pglite.test.ts` fails at `0ce95bbf7f`
  (5 pass, 1 fail, `engine.listSourceRecords is not a function`; reproduced in this audit). It needs no Postgres. It
  was red on the trunk for about three days with no CI signal.
- Fix: add `rust-engine/main` to the push triggers of `rust-engine.yml`, `test.yml` (unit lane) and `e2e.yml`
  (diff-selected E2E through `scripts/select-e2e.ts`, as pull requests do). Size S, plus CI minutes (the addon cell
  is about 30 minutes).

### 2. High: a raw-to-typed move drops the wrapper the raw statement went through
<!-- repo-paths: historical -->

Track 2 moves `executeRaw` calls behind typed engine members. A raw call site often ran inside a wrapper that changed
how the statement ran: a memo, a deadline, an abort signal or a test fake that scripts `executeRaw`. The typed member
skips that wrapper unless someone adds it by hand. Four trunk regressions, from lane commits on Nov 18 and 19, came
from this, and master CI did not catch them:

| # | Lane commit | Wrapper lost | Symptom | Fix (on the trunk's local sync head, not yet pushed at audit time) |
|---|---|---|---|---|
| R1 | `e674407264` | Hand-built test engine | The hand-built engine in `test/e2e/sync-status-pglite.test.ts` has no `listSourceRecords`; the test throws | `e91de3df44` |
| R2 | `447dd37611` | Memo | `onceReads` in `src/core/persistence/authority.ts` answered the raw visibility probe once per access check. The typed `readWriteVisibilityProbe` is not memoised, so a write receipt costs 10 statements against a budget of 9 | `b1dafb9009` |
| R3 | `8b428a71da`, `62e3c555b6`, `a4698dca17`, `6e10a768a4` | Preparer deadline | `hasLabelledOnlyMember`, `readStoredPageTier`, `readSegmentedPageHead` and `readSourceIncarnation` are not in `TYPED_PREPARATION_READS` (`src/core/persistence/bounded-reads.ts:100`), so the bounded view hands them out unbounded and they run past the preparer's deadline | `dcdb4de3d9` |
| R4 | `34a11430c0` | Abort signal | The typed `getConfigValues` takes no signal (`src/core/engine.ts:3375`), so an aborted config read stays queued on a saturated pool | `48e9e9cd6b` (a signalled read on PGLite and Postgres goes back through `executeRaw`) |

Verified in this audit: the six lane commits exist and are ancestors of `0ce95bbf7f`; R1 fails at `0ce95bbf7f`
(above); the four R3 members are absent from `TYPED_PREPARATION_READS` at `0ce95bbf7f`; `getConfigValues` has no
signal parameter at `0ce95bbf7f`. Not verified: the four fix commits (not on the remote at audit time), and R2 to R4
at runtime (they need Postgres).

Why the parity suite missed them: a parity case compares what each arm returns. It does not count statements, check
a deadline, abort a read or build a fake engine. Each of the four is a property of the call path, not of the answer.

Why the existing guards missed them:

- R3 has a runtime guard: `test/e2e/typed-preparation-reads-guard-postgres.test.ts` observes every member a bounded
  view hands out (`observePreparationMembers`) and fails on a member that is neither typed nor in
  `UNBOUNDED_ALLOWED`. It was added in `4082eb04b2`, after the first R3 commit. It is a Postgres E2E file, so it does
  not run on a trunk push (issue 1), and it sees only the flows it imports. The landing process now runs it as landing
  gate 12 on every landing head (reported by the landing owner on Nov 20; no workflow file at `0ce95bbf7f` names it, so
  this audit did not verify it). That closes the R3 gap at landing time, not at push time.
  `test/typed-preparation-reads-sweep.test.ts` checks that each member in the set keeps the deadline; it cannot see a
  member missing from the set.
- R2 was found by a statement budget in a Postgres E2E path. Same gap: it does not run on a trunk push.
- R1 is a PGLite file under `test/e2e/`, so only the E2E lane runs it.
- R4 has no guard.

Recommended guard per wrapper (build nothing now):

| Wrapper | Guard | Fits which existing guard | Cost |
|---|---|---|---|
| Preparer deadline (R3) | Keep `test/e2e/typed-preparation-reads-guard-postgres.test.ts` as landing gate 12 (it exists and runs on every landing head; count it, do not rebuild it). Its limits stay: it sees only the flows it imports, and `UNBOUNDED_ALLOWED` is allow by default. To close them, make the bounded view deny by default: wrap every member except a named list of writes and exemptions, and turn `UNBOUNDED_ALLOWED` into that list. Then a new preparer read is bounded unless someone names it. If a behavior change is not wanted, add a static lint instead: for every function that receives a `boundedReads(...)` result, each engine member it calls is in `TYPED_PREPARATION_READS` or `UNBOUNDED_ALLOWED`. | Existing: landing gate 12 (the guard test above). The deny-by-default change lives in `src/core/persistence/bounded-reads.ts` and keeps `test/typed-preparation-reads-sweep.test.ts` as its proof. The lint fits `scripts/check-engine-raw-sql-ratchet.ts`, which already walks `src/` with the TypeScript compiler API, and runs in `bun run verify`. | Existing gate: 0 (already paid). Deny by default: S to M (each write member must be named, and the sweep test grows). Static lint: M (it needs the call graph of each preparer, about 2 days). |
| Abort signal (R4) | A lint that every typed member called where a `signal` is in scope (a parameter or `opts.signal`) declares a `signal` option in `src/core/engine.ts`, or the call site carries a named exemption. At `0ce95bbf7f` at least 8 single-line `executeRaw` calls outside the engines pass a signal, and 26 lines in `src/core/engine.ts` already declare a `signal?: AbortSignal` option. | `scripts/check-engine-raw-sql-ratchet.ts` (same compiler-API walk), with exemptions in `scripts/engine-raw-sql-baseline.tsv` style notes. | M (needs the type checker to read member signatures). |
| Memo (R2) | A check that every read-only member in a memoised engine view has a memoised branch or a named exemption. For `onceReads`: parse the members in `AuthorityEngine` (`src/core/persistence/authority.ts:105`, a `Pick<BrainEngine, ...>`) and the `key === '...'` branches of `onceReads`, and fail on a read member with neither. Apply the same rule to the other memo views (`boundedReads` shared reads, the group-publish `preparationReads`). Also run the receipt statement budget on PGLite in the unit lane, so it runs without Postgres. | A new unit test next to `test/persistence-page-authority.test.ts`; the static half fits the `check-engine-raw-sql-ratchet.ts` walk. | S for `onceReads` alone, M for every memo view. |
| Hand-built test engine (R1) | A shared fake-engine helper that returns a Proxy and throws `fake engine has no <member>` on any member the test did not supply, plus a ratchet on hand casts. Better still, type each fake with the narrow engine type the code path declares (the `AuthorityEngine` pattern) using `satisfies`, so adding a member to the production type breaks the test at typecheck, not at run time. At `0ce95bbf7f` there are 644 `as unknown as BrainEngine` casts in 334 test files. | `test/helpers/queue-engine-members.ts` already fills missing queue members for fakes; extend that idea. The ratchet fits `scripts/lib/count-ratchet.ts` (the same mechanism as the raw SQL ratchet). | S for the helper and the ratchet; M to L to move the 644 casts, which the ratchet lets happen over time. |
| All four | Run the trunk gate (issue 1). Three of the four had a test that would fail; it did not run. Landing gate 12 now covers R3 at landing, but R1, R2 and R4 still wait for a master push or the nightly run. | `.github/workflows/e2e.yml`, `test.yml` | S |

### 3. High: "same as PGLite" cannot catch a shared bug
<!-- repo-paths: historical -->

- The parity harness compares each arm to the first SQL arm (`test/engine-parity/harness.ts:486-500`, `:539-600`).
  There is no expected-value column. 159 of 1,347 `parityTest` declarations have no `expect` and only return a value,
  so their PGLite answer is never checked against anything.
- Behavior audit cross-reference (96 findings): 81 are in shared TypeScript above the engine (both arms run the same
  code), 11 are copied into the Rust store (Rust is a port of the PGLite SQL), 2 are where Rust differs or refuses,
  1 is not on the Rust path, 1 is unknown. The parity suite cannot catch the 92 in the first two classes. The lists
  are in "Behavior audit cross-reference" below.
- Two tests pin a wrong value as correct: `test/rust-jsonb-key-order.serial.test.ts` (frontmatter key order,
  behavior finding pages-04) and `test/rust-engine-differential.test.ts:113-120` (mixed-case delete, pages-01).
- Fail-soft reads rethrow only a capability refusal: `rethrowCapabilityMissing` in `src/core/verbs/entity-card.ts`
  (`failOpen`, `:764-766`) and `rethrowCapabilityRefusal` in `src/core/search/hybrid.ts` (for example the backlink
  stage, `:596-599`). A
  real read error is swallowed the same way on both arms, and no parity case injects one.
- Link counts and link types after an import are not pinned by any parity case. Link typing (`inferLinkType` in
  `src/core/link-extraction.ts`, the schema-pack rules in `src/core/schema-pack/link-inference.ts`) and link
  reconciliation (`src/core/link-reconciliation.ts`) run in TypeScript above the engine, so both arms get the same
  links, right or wrong. `test/engine-parity/import-writes.test.ts` and `import-path.test.ts` call
  `importFromContent` but never read links back; `cli-reads-import.test.ts` checks only `listLinkPageMetadata`.
  Two outside reports fit this gap and parity cannot catch either: an import that creates 0 links, and wrong link
  types on passive voice, a verb in another sentence, "partner at" read as `invested_in`, and tense. The unit test
  `test/link-extraction.test.ts:912-919` pins "partner at" plus "advises" as `invested_in` on purpose, so that one is
  a product decision, not only a test gap. This audit did not reproduce the 0-links report.
- Fix: let a case declare an expected value (harness change, L); spec-oracle goldens for the C2 findings (M); rewrite
  the two pins (S); read-throw fault injection on both arms (M); an import-to-links golden (item 20).

### 4. High: a green Rust result can mean refused or empty
<!-- repo-paths: historical -->

- `checkRustArm` accepts a terminal typed refusal and returns (`test/engine-parity/harness.ts:546-567`) before the
  declared-method check (`:573-574`). There is no per-case ledger of which member may refuse.
- Setup refusals end positive cases early: `test/engine-parity/cli-reads-export.test.ts:238-242`,
  `test/engine-parity/import-path.test.ts:168-182`, `test/engine-parity/write-misc.test.ts:199-213` and `:335-349`.
- Some Rust adapter members return a constant empty answer (`src/core/rust-engine/store-members/write-misc.ts:50-159`),
  and the matching cases run on a fresh, empty brain, so the constant passes.
- `test/rust-cli-parity.serial.test.ts:353-357` records any typed read refusal as `refused` and returns with no
  assertion; it also returns on "no Rust engine". An equal command that starts refusing passes.
- The tally pins are floors per file (`test/engine-parity/rust-tally.ts:68-74`). A case that goes from equal to
  refused while another goes the other way leaves the file total unchanged and passes. An improvement passes without
  a repin.
- Fix: a per-case outcome ledger (expected outcome, member and phase) for the parity files and the CLI test; fail a
  refused setup; assert a non-empty control in every positive read case. M, then fixture work M to L.

### 5. High: the comparisons that run are normalized; markdown and MCP are not byte-compared
<!-- repo-paths: historical -->

- CLI check: sorts keys and masks values (`test/rust-cli-parity.serial.test.ts:124-142`), drops stderr
  (`:360-367`), allows a 1e-6 relative difference (`:150-160`) and swaps in the reference salience score after a
  1e-4 check (`:173-184`).
- Census (`scripts/rust-census/`, manual, not in any workflow): trims output, compares stdout only, and its MCP
  compare ignores `structuredContent` and non-text blocks. `scripts/rust-census/normalize.ts` masks any numeric id,
  any string under a timestamp-like key, UUIDs in free text and every `engine` key, decodes any base64 JSON string as
  a cursor, and its id masks are not one-to-one. Its last report is pinned 977 commits behind this tree and shows
  22 CLI and 8 MCP answers that differ with no refusal.
- `test/rust-export.serial.test.ts` (byte-exact export) and `test/rust-jsonb-key-order.serial.test.ts` skip without
  the addon, and no workflow builds the addon for them, so they skip everywhere.
- Markdown outputs (`gbrain get` text mode, `compile-context`, `report`, `publish`, `eval compare --md`, MCP
  `get_page` markdown) are not byte-compared on any arm in CI.
- Only 32 of 244 CLI command names are checked on Rust in CI, `--json` only, with no Postgres arm.
- Order-hiding oracles: for example `test/engine-parity/config-ingest.test.ts:203-229` sorts a "newest first" read and
  returns only the length of a limited read; `test/engine-parity/entity-identities.test.ts:297-309` returns a copy
  of the expected keys, not the actual order; the vector compare in `test/engine-parity/search.test.ts:364-384`
  checks only the hot axis. The mutation run confirms this class: see M01 and M07.
- Fix: run the export and jsonb tests in the addon lane (S); pin the CLI results per command (S); byte-compare
  stdout, stderr and exit code, and the whole MCP envelope, with fixed clocks (M); regenerate the census, fix its
  masks to a path allowlist and run it in CI (M).

### 6. High: fixtures are small, ASCII and fresh
<!-- repo-paths: historical -->

- The CLI and census brain is 20 ASCII pages (156 to 511 bytes) with no private pages and no vectors. The largest
  parity seed is about 1,000 pages. The one documented production brain has about 13,700 pages and 16,300 links.
- Missing cases: NFC versus NFD, right-to-left text, zero-width characters, 12 or more tied rows, crossing the
  100-row cap, a 1 MiB body boundary. No locale is set in CI. `scripts/scale/run.ts:47` has no Rust option.
- Rust uses an exact vector scan; Postgres uses HNSW. No suite runs at a size where they can differ.
- Fix: boundary and Unicode cases (S each); a 10k-page Rust scale cell (M); private pages in the CLI brain (S).

### 7. High: durability and owner-process tests do not run in CI for the swap path
<!-- repo-paths: historical -->

- The cargo simulator covers power loss, torn writes and lying fsync, and runs in CI. Good.
- The owner process failover, clients and IPC tests skip in CI (`test/rust-owner-failover.test.ts:27`). Every CLI
  write on a swapped brain goes through that path.
- No ENOSPC fault (`rust/crates/gbrain-sim/src/disk.rs`), no Rust cell in the crash robot, no backup and restore
  test on a Rust store, no CI job with concurrent writes on.
- Migration into Rust: trunk has no `importRelation` and graduation has no Rust relation
  (`src/core/persistence/graduation-inventory.ts:16-17`). A seed and import branch exists (see Corrections) but is
  not on the trunk.
- Fix: move the owner tests into the addon lane (S); add an ENOSPC fault kind (S); a concurrent-writes CI job (S);
  a backup and restore test (S).

### 8. Medium: no run uses all three arms together
<!-- repo-paths: historical -->

- The Rust arm runs with no `DATABASE_URL` (`rust-engine.yml:291-301`), so it compares Rust with PGLite only. The
  Postgres arm runs in `persistence-validation.yml` `unit-postgres-arms`, skipped on pull requests, without Rust.
- PGLite sorts text in C order; the Postgres CI image uses `en_US.utf8`. A Rust result that matches PGLite can differ
  from Postgres, and no job checks it.
- Fix: one lane with the Rust arm and `DATABASE_URL` set, with a `SHOW lc_collate` assertion. M.

### 9. Medium: gbrain-evals and the design disagree on "equal"
<!-- repo-paths: historical -->

- The engine-bench LongMemEval gate lets Rust lose up to 0.02 recall (`RUST_RECALL_MARGIN = -0.02` in the evals
  repo, `eval/runner/engine-bench/lme-recall.ts:82`). The design says equal or better
  (`docs/designs/RUST_ENGINE.md:12` and `:479`). The evals gate would approve a result the design rejects.
- No Rust evals run exists yet. There is no shared fixture and no shared definition of done between the two repos.
- Fix: set the margin to 0 or record a dated amendment (S, decision); add a top-5 identity check (S).

### 10. Medium: other oracle gaps
<!-- repo-paths: historical -->

- Bun `toEqual` ignores missing versus `undefined`, array holes, prototypes and key, Map and Set order. It does not
  ignore null versus missing or array order.
- Catch-any-error helpers accept the wrong failure (for example `test/engine-parity/open-loops.test.ts:194-211`).
- `rust/scripts/graph-parity-golden.ts --check` is not in CI, so the graph golden can go stale.
- Fix: S each.

## Behavior audit cross-reference
<!-- repo-paths: historical -->

Source: the behavior audit on branch `behavior-audit/nov21`, `docs/research/gbrain-behavior-audit.md`, 96 findings.

| Class | Count | Can the parity suite catch it? | IDs |
|---|---|---|---|
| C1 shared TypeScript above the engine | 81 | No. Both arms run the same code. | contract-01 to contract-10, graph-01 to graph-08, graph-10, graph-11, graph-13 to graph-16, health-2 to health-6, health-9 to health-11, LC-1 to LC-11, memory-01, memory-02, memory-04, memory-05, memory-07, memory-08, memory-09, memory-11 to memory-14, pages-02, pages-03, pages-06, pages-08 to pages-13, privacy-2, privacy-4, privacy-5, privacy-6, RET-01 to RET-06, RET-08 to RET-15 |
| C2 copied into the Rust store | 11 | No. Rust reproduces the PGLite answer. | memory-03, pages-05, pages-07 (suspected), RET-07, graph-09, health-7, health-8, privacy-3 (mixed), graph-12, memory-10 (suspected), pages-04 |
| C3 Rust differs or refuses | 2 | Yes, as a difference or a refusal, but a test pins pages-01 as equal | pages-01, privacy-1 |
| C4 not on the Rust path | 1 | Not applicable | health-1 (partly) |
| Unknown | 1 | Not settled | memory-06 |

For each C2 finding, the TypeScript fix and the Rust fix must ship in the same change, or parity fails. The Rust
files that must move in step: `stats.rs` (about lines 278-349), `link_queries.rs` (about 962-990),
`trust/stamp.rs` (about 154-165), `jsonb.rs`, `pages.rs` (`validate_slug` about 507-540, and about 909-945 and
1420-1422), `keyword/tsearch.rs` and `facts.rs` (about line 181), all under `rust/crates/gbrain-store/src/`.

No test at `0ce95bbf7f` asserts the correct value for any of the 96.

## Proposed fix items
<!-- repo-paths: historical -->

Owner area is a file or path family. Ordered by risk, then size.

| # | Item | Owner area | Size | Issue |
|---|---|---|---|---|
| 1 | Add `rust-engine/main` to push triggers of the Rust gate, the unit lane and diff-selected E2E | `.github/workflows/rust-engine.yml`, `test.yml`, `e2e.yml`, `rust-cli-parity.yml` | S | 1, 2 |
| 2 | Bounded preparer view denies by default (or a static preparer-member lint); keeps landing gate 12 (the existing guard test) as the runtime check | `src/core/persistence/bounded-reads.ts`, `scripts/check-engine-raw-sql-ratchet.ts` | S to M | 2 |
| 3 | Signal lint: a typed replacement of a signalled raw read takes a signal | `scripts/check-engine-raw-sql-ratchet.ts`, `src/core/engine.ts` | M | 2 |
| 4 | Memo coverage check for `onceReads` and other memo views; receipt statement budget on PGLite | `src/core/persistence/authority.ts`, `test/persistence-page-authority.test.ts` | S to M | 2 |
| 5 | Fake-engine helper that throws on a missing member; ratchet `as unknown as BrainEngine`; `satisfies` narrow engine types | `test/helpers/`, `scripts/lib/count-ratchet.ts` | S, then M to L | 2 |
| 6 | Per-case outcome ledger for parity and CLI; fail a new refusal of a served case; fail refused setup | `test/engine-parity/harness.ts`, `test/engine-parity/rust-tally.ts`, `test/rust-cli-parity.serial.test.ts` | M | 4 |
| 7 | Expected-value support in the harness; spec-oracle goldens for C2 findings | `test/engine-parity/harness.ts`, `test/engine-parity/` | L, M | 3 |
| 8 | Rewrite the two tests that pin a wrong value | `test/rust-jsonb-key-order.serial.test.ts`, `test/rust-engine-differential.test.ts` | S | 3 |
| 9 | Read-throw fault injection on both arms (a non-refusal error must give a degraded marker) | `test/engine-parity/harness.ts`, `src/core/verbs/entity-card.ts`, `src/core/search/hybrid.ts` | M | 3 |
| 10 | Run the export, jsonb key-order and vector CLI tests in the addon lane | `.github/workflows/rust-engine.yml` | S | 5 |
| 11 | Byte-compare stdout, stderr and exit code; whole MCP envelope; markdown outputs; fixed clock | `test/rust-cli-parity.serial.test.ts`, `scripts/rust-census/` | M | 5 |
| 12 | Regenerate the census at the trunk head, add `dedupe`, `identity`, `secrets`, path-allowlist masks, run it in CI | `scripts/rust-census/` | M | 5 |
| 13 | Order and limit oracles with non-tied keys; tag insertion order; a soft-deleted page with a served projection | `test/engine-parity/pages.test.ts`, `config-ingest.test.ts`, `search.test.ts` and siblings | S to M | 5, mutation |
| 14 | Unicode, tie and limit boundary cases; private pages in the CLI brain; 1 MiB boundary | `test/engine-parity/`, `test/fixtures/rust-cli-parity-brain/` | S each | 6 |
| 15 | 10k-page Rust scale cell; exact versus HNSW check | `scripts/scale/`, `.github/workflows/scale-tier.yml` | M | 6 |
| 16 | Owner failover, clients and IPC tests in the addon lane; ENOSPC fault; concurrent-writes job; backup and restore | `.github/workflows/rust-engine.yml`, `rust/crates/gbrain-sim/` | S each | 7 |
| 17 | One lane with PGLite, Postgres and Rust, with a locale assertion | `.github/workflows/rust-engine.yml`, `test/helpers/test-backends.ts` | M | 8 |
| 18 | LongMemEval margin to 0 (or a dated amendment) and a top-5 identity check | evals `eval/runner/engine-bench/lme-recall.ts` | S | 9 |
| 19 | `toStrictEqual` where shape is contractual; exact error codes in negative helpers; graph golden `--check` in CI | `test/engine-parity/`, `rust/scripts/graph-parity-golden.ts` | S each | 10 |
| 20 | Import-to-links golden: import a small fixed set of markdown pages, then assert the exact link count and each (from, to, type) row against a hand-written expected file, on every arm; include passive voice, a verb in another sentence, an investor phrase and past tense | `test/engine-parity/import-writes.test.ts` or a new golden, `src/core/link-extraction.ts`, `src/core/link-reconciliation.ts` | M | 3 |

## Decisions for the owner
<!-- repo-paths: historical -->

Rulings recorded Nov 20 by the owner of the swap work, except A.

- A. Swap date: open, for the project owner. The project owner ruled an opt-in swap on Dec 1 (12:15 PM PST
  Nov 19). Criterion 1 (`docs/designs/RUST_ENGINE.md:607` at `0ce95bbf7f`) needs 14 days of shadow in one epoch. A shadow that
  starts Nov 26 gives 5 days by Dec 1. The conflict goes to the project owner.
- B. Shadow scope: yes. Read-only shadow starts Nov 26. Its report counts as swap evidence only after fix items 6 and
  10 land, because today an empty or refused read can look equal.
- C. Owner-process tests: yes. Owner failover, clients and IPC tests run in the addon lane on every change to
  `rust/**` (fix item 16).
- D. Evals margin: yes, equal or better. The design says "equal or better" (`docs/designs/RUST_ENGINE.md:12`) and
  "not \"within N points\"" (`:479`), line numbers at `0ce95bbf7f`. The evals margin of -0.02 (`RUST_RECALL_MARGIN` in the evals repo,
  `eval/runner/engine-bench/lme-recall.ts:82`) is out of line and goes to the evals owners (fix item 18).
- E. Trunk gate: yes. Workflow files are frozen until 20:30Z Nov 24, so the trunk push gate goes into the landing gate
  script and the pre-push hook first, and into the workflow files after the freeze (fix item 1).

## Corrections and not verified
<!-- repo-paths: historical -->

- Shadow code: it is not on the trunk at `0ce95bbf7f`, but branches exist. `rust-engine-shadow` (`a7ba3f71aa`) has
  read-only shadow (`src/shadow/`, `src/commands/engine-shadow.ts`, and tests `rust-engine-shadow.test.ts` and
  `rust-engine-shadow.serial.test.ts`). Its report verdict is always NOT READY, and its real-child test runs with no
  addon, so it asserts only `addon_unavailable`. Its classifier ignores score, rank, similarity, distance,
  `rrf_score` and `ts_rank` on ranked reads, and its `privacy_diverged` class flags only a `source_id` outside scope.
  `rust-engine/shadow-s3` has a Rust store seed and `importRelation` (`seed.rs`). `rust-engine/migrate-engine-rust`
  (`57e2f4a115`) also exists. None is merged into the trunk.
- Not run: the Postgres arm in the mutation run (no local Postgres); cargo tests per mutant (too slow; 11 minutes a
  run); runtime repros of R2 to R4 (they need Postgres); the four wrapper fix commits (not on the remote at audit
  time).
- The census numbers come from its last report, pinned 977 commits behind this tree.
- Mutation testing samples 31 mutants in the Rust store only. It says nothing about the TypeScript side, where 81 of
  the 96 behavior findings live.
