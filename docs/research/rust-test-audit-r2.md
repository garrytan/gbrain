# Rust engine parity tests: round 2 re-audit

Audited tree: `rust-engine/main` at `d940d53988` (`d940d5398886557ba47d46514db551260a69d7c6`), Nov 21, 2026.
Round 1, the audit of record: `docs/research/rust-test-audit.md`, against `0ce95bbf7f` (Nov 20). This round reads the
142 trunk commits since then. Read-only. No test or product code changed. The mutation run used a local scratch branch
that was never pushed. Paths and line numbers refer to `d940d53988` unless a line names another commit.

## TL;DR
<!-- repo-paths: historical -->

We learned that the tests got no better at catching Rust bugs since Nov 20, and the new Rust code is tested less well
than the old. The same 23 of 29 round 1 mutants are caught, by the same files. The suites catch only 4 of 9 reachable
mutants in Rust code that is new or changed since round 1. Of the 5 that survive, 3 (holding-page purge, the embedding
budget with an open reservation, whole-source withdrawals in a page snapshot) fail no test at all, Rust unit tests included.
None of the 20 round 1 fix items is done on the trunk; items 6 and 10, which decision B needs before shadow evidence counts,
are not started. You should land items 6 and 10 before Nov 26, put the trunk gate in a checked-in landing script now and
in the workflows after the freeze, and run the ranked-search gate and a 13.7k-page cell on Rust before Dec 1.

Top 5, by swap risk (full list of 10 at the end):

1. **Shadow evidence cannot count yet.** A refused or empty Rust answer still passes: no per-case outcome ledger (item 6)
   and the byte-exact export, jsonb and vector tests still run in no workflow (item 10).
2. **A trunk push still runs almost no Rust gate.** Addon-gated tests skip to green in the Test workflow, and the parity
   Rust arm, store tests and `cargo test` run on master and PRs only (items 1, 10, 16).
3. **The ranked-search gate has never run on Rust.** The evals repo pins a gbrain build with no Rust engine, no CI runs
   engine-bench, and `RUST_ENGINE.md` states two different bars (`:501` and `:508`).
4. **Nothing has measured Rust at production size.** No 10k or 13.7k cell, no memory number, no exact-vs-HNSW check
   (item 15); the CLI parity brain is 20 ASCII pages with no private or deleted page.
5. **New Rust code is weakly covered.** 4 of 9 reachable new mutants caught; R05, R08 and R11 caught by nothing.

Mutation: round 1 set, 23 of 29 reachable caught (79%), unchanged. New Rust mutants: 4 of 9 reachable (44%). Owner
socket (TypeScript): 9 of 9. All reachable: 36 of 47 (77%); Rust store only: 27 of 38 (71%). Adding `cargo test`, which
CI runs on master and PRs, catches 4 more (M07, M26, R04, R10).

Coverage: 1,177 engine methods all have a parity case (Rust serves 900, refuses 277), 32 of 221 CLI names are checked
on Rust (`--json` only), and 0 of 205 MCP tools have their envelope compared. Markdown and the MCP envelope are still not
byte-compared. Stops rose from 60 to 196; 19 stops map to no design row, so they have no owner and no date.

## Scope and method
<!-- repo-paths: historical -->

- Fix-item status: each of the 20 round 1 fix items was checked against the trunk files and the 142 commits in
  `0ce95bbf7f..d940d53988`. Lane branches that are not on the trunk do not count as done; where a lane head is known,
  the row names it.
- Coverage: `test/engine-parity/coverage.tsv` (generated), `test/engine-parity/rust-tally.tsv`, the CLI command table,
  the MCP operation list and the comparison code in the harness and the CLI parity test.
- Stopped pins: each of the 196 stops was mapped to a row of the "Open before `rust` can be selected" table in
  `docs/designs/RUST_ENGINE.md` through the capability that refuses.
- Mutation: the 31 round 1 mutants where the code still exists, plus new mutants for code added since Nov 20, each
  built into the addon and run against every parity file with the Rust arm on, the Rust CLI parity test and the tests of
  the area the mutant touches. Details are in "Mutation results".
- Tests that cannot fail, flaky tests and skips: read from the test files and workflows. Addon-gated files were run with
  no addon to show what CI sees.
- Evals: the gbrain-evals repository at `origin/main` `59b8ce1be`. No paid evaluation ran.
- Fixtures: measured with local scripts. No real brain was read.
- Spend: none. No paid model or API calls.

## Fix-item status
<!-- repo-paths: historical -->

Decision B says the Nov 26 read-only shadow counts as swap evidence only after items 6 and 10 land. **Neither has
landed.** So today a shadow report cannot count as swap evidence.

| # | Item | Status | Proof at `d940d53988` | Still missing |
|---|---|---|---|---|
| 6 | Per-case outcome ledger; a served case that newly refuses fails; a refused setup fails | Not started | `checkRustArm` (`test/engine-parity/harness.ts:546-600`) counts a terminal typed refusal as `refused` and returns (`:592-594`). `test/engine-parity/rust-tally.ts:68-74` checks per-file totals only. `test/rust-cli-parity.serial.test.ts:353-357` returns on a refused member with no assertion. Setup refusals still end cases early: `cli-reads-export.test.ts:236-243`, `import-path.test.ts:165-172`. No commit in range touches a ledger. | The whole item. |
| 10 | Export, jsonb key-order and vector CLI tests in the addon lane | Not started | The addon step (`.github/workflows/rust-engine.yml:293-312`) lists store, shell, differential, `test/engine-parity/*.test.ts` and the CLI parity file. `rust-export.serial.test.ts`, `rust-jsonb-key-order.serial.test.ts` and `rust-vector-search-cli.serial.test.ts` are in no workflow; each skips with no addon (`describe.skipIf(!HAVE_ADDON)`). | The workflow line (after the `.github/` freeze ends 20:30Z Nov 24), or the landing gate first. |
| 1 | Push triggers for `rust-engine/main` | Partial | `rust-cli-parity.yml:24-25` runs on `rust-engine/**` pushes (advisory, one file). `rust-engine.yml:63-64`, `test.yml:4-5`, `e2e.yml:4-5` still push on `master` only. No pre-push hook or script in the tree runs the Rust gate. Process rule since 9:45 AM PST Nov 21: a lane handoff cites a green `test.yml` run on the exact head plus green Rust CLI parity. That rule is outside the repository. | Workflow triggers (after the freeze); a checked-in landing gate. |
| 2 | Bounded preparer view denies by default, or a lint | Not started | `src/core/persistence/bounded-reads.ts:139-144` still passes a non-typed member through (`value.bind(target)`). Landing gate 12, `test/e2e/typed-preparation-reads-guard-postgres.test.ts` (`4082eb04b2`, `489c5a92a5`), is a runtime guard on Postgres; it is not deny-by-default. | Deny by default or the static lint. |
| 3 | Signal lint | Not started | `scripts/check-engine-raw-sql-ratchet.ts` has no `signal` rule. | The whole lint. |
| 4 | Memo coverage check; receipt statement budget on PGLite | Partial | `b1dafb9009` adds `readWriteVisibilityProbe` to `onceReads` (`src/core/persistence/authority.ts:310-312`). No check that a memo view covers every member. | The coverage check; the PGLite budget test (not found). |
| 5 | Fake engine that throws on a missing member; ratchet the cast | Not started | No such helper in `test/helpers/`. `as unknown as BrainEngine`: 675 matches in `test/` and `scripts/lib/` (round 1: 644 in 334 files). No ratchet. | The helper and the ratchet. The cast count grew by 31. |
| 7 | Expected values in the harness; spec goldens | Not started | The only expectation is a divergence row (`harness.ts:561-621`). | The whole item. |
| 8 | Rewrite the two tests that pin a wrong value | Partial | `bf7b5c0276` rewrites the take case in `rust-jsonb-key-order.serial.test.ts` to compare with PGLite. `rust-engine-differential.test.ts:113-116` still pins the mixed-case delete as `equal`. | The mixed-case delete case. |
| 9 | Read-throw fault injection on both arms | Not started | `src/core/verbs/entity-card.ts:764-766` and `src/core/search/hybrid.ts:596-599` unchanged; no fault injection in the harness. | The whole item. |
| 11 | Byte compare stdout, stderr, exit code; whole MCP envelope; markdown; fixed clock | Not started | The CLI test compares normalized `--json` only (`rust-cli-parity.serial.test.ts:109-156`, `:360-367`). No MCP envelope or markdown compare. | The whole item. |
| 12 | Census at the trunk head, with new families, in CI | Not started on trunk | Census work is on branch `rust-engine/rust-census` (`5297558efc`), not on the trunk. No workflow runs the census. | Land or redo at the trunk head; run in CI. |
| 13 | Order and limit oracles with non-tied keys; tag order; soft-deleted projection | Not started | No commit in range. | The whole item. |
| 14 | Unicode, tie and limit cases; private pages in the CLI brain; 1 MiB | Partial | Unicode title cases exist (`title-fuzzy-unicode.test.ts`, `entity-fuzzy.test.ts`). A 1 MiB + 1 page exists in one parity file (`trust-tier-reads.test.ts:508`). The CLI brain (`test/fixtures/rust-cli-parity-brain/`) has no private page, no deleted page and no non-ASCII byte. | CLI brain cases; tie and limit cases. |
| 15 | 10k-page Rust scale cell; exact vs HNSW | Not started | `scale-tier.yml:167` matrix is `[pglite, postgres]`; `scripts/scale/budgets.json` has no Rust key. | The whole item. |
| 16 | Owner failover, clients and IPC tests in the addon lane; ENOSPC; concurrent writes; backup and restore | Not started | `rust-engine.yml` names no owner test. With no addon, `rust-owner-failover.test.ts` and `rust-owner-clients.test.ts` exit 0 with every addon case skipped. No ENOSPC fault in `rust/crates/gbrain-sim/src`. | The whole item. Decision C ruled yes. |
| 17 | One lane with PGLite, Postgres and Rust, with a locale check | Not started | `rust-engine.yml` sets no `DATABASE_URL`; no collation check in `test/helpers/test-backends.ts`. Design row 21 (decide-store order under a non-C collation, due Nov 25) is the same risk. | The whole item. |
| 18 | LongMemEval margin; top-5 identity check | Mostly done, in the evals repo | On gbrain-evals `origin/main` `59b8ce1be`: `RUST_RECALL_DELTA = 0.018` (`eval/runner/engine-bench/lme-recall.ts:86`, from `b396b5e95`); -0.02 stays only as a secondary row (`:88`). Top-5 identity: `:423-434`, `:494-495`. The power fix `1ea0173ad` (0.0183) is on unmerged branch `engine-bench-recall-equal-or-better`. | Merge or drop `1ea0173ad`. Reconcile the two bars in `RUST_ENGINE.md` (see "Evals"). |
| 19 | `toStrictEqual` where shape is a contract; exact error codes; graph golden `--check` in CI | Not started | `toStrictEqual` in `test/engine-parity/`: 0. No workflow runs `rust/scripts/graph-parity-golden.ts --check`. | The whole item. |
| 20 | Import-to-links golden | Not started | No commit in range to `import-writes.test.ts`, `src/core/link-extraction.ts` or `src/core/link-reconciliation.ts`. | The whole item. |

Count: 0 done on the trunk, 1 mostly done in the evals repo (18), 4 partial (1, 4, 8, 14), 15 not started.

## Mutation results
<!-- repo-paths: historical -->

Method as in round 1, at `d940d53988`: each mutant is a one-line change to behavior a user can see, built into the
addon (each Rust mutant gave a distinct addon hash), then run against every `test/engine-parity/` file with the Rust arm
on (PGLite plus Rust, no Postgres), `test/rust-cli-parity.serial.test.ts`, the four other files the addon lane runs, and
20 owner socket test files with and without the addon. `cargo test -p gbrain-store` ran as an extra check on mutants the
TypeScript suites missed.

Clean baseline: 0 failures in 161 parity files, the CLI test (40 cases), the 4 lane files and the 20 owner files (with
and without the addon); `cargo test -p gbrain-store`: 1,269 passed. The baseline tally equals `rust-tally.tsv` on every
row: 160 files, 1,305 equal, 196 stopped, 0 diverged. The logs do not name which cases stopped: the harness counts a stop
silently and Bun prints every case as `(pass)`.

| Set | Reachable | Caught | Survived | Change |
|---|---|---|---|---|
| Round 1 mutants M01-M31 | 29 (M08, M29 unreachable) | 23 (79%): parity 22, CLI 6, M01 by CLI only, 10 by one file only | M07, M22, M25, M26, M27, M30 | Identical to round 1; page-write-readers now also catches M06 |
| New Rust mutants R01-R11 | 9 (R01, R02 unreachable) | 4 (44%), each by one parity file | R04, R05, R08, R10, R11 | New |
| Owner socket mutants S01-S09 (TypeScript) | 9 | 9 (100%), all by `test/rust-owner-*` files, none by parity or CLI | none | New |
| All | 47 | 36 (77%) | 11 | |

All 31 round 1 mutations still apply verbatim, in the same functions. New mutants:

| ID | Area | Mutation | Where | Result |
|---|---|---|---|---|
| R01, R02 | purge age (#9953) | `purgeDeletedPages` accepts a NaN, infinite or negative age | `rust/crates/gbrain-store/src/page_ops.rs:972` | Unreachable: the TypeScript member checks the age first (`src/core/rust-engine/store-members/page-ops.ts:126`). `cargo` catches both. |
| R03 | purge | `purgeDeletedPages` ignores `excludeIds` | `page_ops.rs:986` | Caught: `pages` |
| R04 | purge | purging a page no longer expires its facts | `page_ops.rs:1029` | Survived. `cargo` catches it. The only parity purge with facts (`facts.test.ts:1271`) compares aliases. |
| R05 | facts purge | holding-page purges also tombstone facts with no entity | `facts/holding_purges.rs:78` | **Survived; nothing catches it** |
| R06 | facts purge | `insertFactPurge` overwrites an existing tombstone | `facts/purge_ledger.rs:243` | Caught: `fact-purge-ledger` |
| R07 | facts purge | `planFactPurgeIds` drops the unbacked-name-key rule | `facts/purge.rs:315` | Caught: `facts-purge` |
| R08 | embedding budget | a reservation ignores money already reserved | `page_embedding_budget.rs:273` | **Survived; nothing catches it.** Every parity reserve runs on a fresh or settled row, never with an open reservation. |
| R09 | embedding budget | settling a reservation does not book the spend | `page_embedding_budget.rs:350` | Caught: `page-embedding-budget` |
| R10 | samplers | representative chunk is the highest-index embedded chunk | `page_ops.rs:678` | Survived. `cargo` catches it. Sampler parity cases seed no embedded chunk. |
| R11 | withdrawals | a page snapshot drops whole-source (`*`) withdrawals | `trust/withdrawals.rs:257` | **Survived; nothing catches it.** `trust-withdrawals` inserts `*` withdrawals but never reads a snapshot. |
| S01-S09 | owner socket | peer uid check off or fail-open, remote write sent, a write classed as a read, all calls treated as reads, a lost write marked retryable, no re-election after owner exit, close not waiting for started calls, one connection over the limit | `src/core/rust-engine/owner-ipc/server.ts`, `client.ts`, `routes.ts`, `typed-member-classes.ts` | All caught by owner tests, also with no addon |

Round 1 survivors, one line each: M07 (unsorted snapshot tags; `cargo` catches it), M22 (likely equivalent; a soft
delete already drops the page from the served text), M25 (every case passes a graph depth), M26 (no case re-adds a link
with a new context; `cargo` catches it), M27 (timestamps masked), M30 (no NUL byte in any title). Still caught by nothing:
M22, M25, M27, M30, R05, R08, R11.

Where these tests run in CI (read from the workflows, not seen in a run): `cargo test --locked` and the parity Rust arm
run in `rust-engine.yml` on master pushes and PRs. The `rust-owner-*` files run in the `test.yml` unit shards, which never
build the addon, so their addon-only cases (failover, clients, the real-owner blocks of `rust-owner-ipc`) skip in CI. The
S mutants are all still caught without the addon.

## Coverage at `d940d53988`
<!-- repo-paths: historical -->

| Surface | Total | Has a Rust parity case | Byte-exact on Rust | Change since round 1 |
|---|---|---|---|---|
| `BrainEngine` methods | 1,177 | 1,177 called by a harness case: Rust serves 900, refuses 277 (facts 205) | 0. Every compare is `toEqual`, which ignores key order (`harness.ts:527`, `:606`). | Coverage stays complete by count. |
| CLI command names | 221 (136 in the command table plus names derived from operations) | 32: 31 in `COMMANDS` plus `put` | 0. `--json` only, normalized. No text output compared. | No change (round 1: 32). |
| MCP tools | 205 | 0 compared as tools. `get_page` has one partial frontmatter check that passes on a typed refusal (`rust-jsonb-key-order.serial.test.ts:152-156`). | 0 envelopes. | No change. |

- Parity files: 160 in the tally (161 files; `coverage.test.ts` has no case). 1,305 equal, 196 stopped, 0 diverged
  (both divergence TSVs in `test/rust-expected-divergence/` are empty). Round 1: 144 rows, 1,289 equal, 60 stopped.
- Of the +136 stops, 132 are in nine new `*-sites` files that pin typed refusals of facts, dream, files and tail
  members, and 4 are in other new files. One case in `reads-privacy` moved from equal to stopped.
- "Covered" in `coverage.tsv` means each arm calls the method. It does not mean Rust gave the same answer, and it does
  not mean a byte check. 632 methods have exactly one case.
- **Markdown outputs and the whole MCP envelope are still not byte-compared.** The only byte compares are
  `rust-export.serial.test.ts:87-108` (exported files) and `rust-jsonb-key-order.serial.test.ts:152-154` (12 JSON
  surfaces, key order kept). Neither runs in any workflow (item 10). The evals repo's `surface-parity.ts` stage compares
  bytes on a 65-page corpus, but it runs by hand and its pinned gbrain build has no Rust engine.
- CLI normalization (`rust-cli-parity.serial.test.ts`): UUIDs, timestamps, clock keys and id keys masked (`:109-132`),
  temp paths replaced (`:144`), keys sorted (`:136`), relative number tolerance 1e-6 (`:150-156`), plus two named
  adjustments (`:173`, `:194`). Rust stderr is not compared.

Full lists (one row per method, command and tool) were produced for this audit and are summarized here; the uncovered
CLI names are 189 of 221.

## Stopped pins
<!-- repo-paths: historical -->

A stop has no owner or date field in the test tree. The harness counts a case that ends on a typed
`engine_capability_missing` refusal (`harness.ts:567-597`), and `rust-tally.tsv` pins only a per-file count. The
owner and due dates live in the last cell of each "Open before `rust` can be selected" row of `RUST_ENGINE.md`, added
by `9dbf4bd3d4`. So an owner and date are per capability family, never per case. Mapping each stopped file to a row
through its refused capability:

| Group | Stops | Files |
|---|---|---|
| Owner and date for the whole row (rows 27, 31, 32) | 24 | write-misc 16, persistence-declaration 3, put-source-fork 2, write-attribution 2, reads-privacy 1 |
| Owner; date for only part of the row (row 25: 26 of 205 facts members due Nov 27; row 29: identity 4 due Nov 25) | 148 | facts-purge-sites 27, facts-conversation-sites 22, facts-rest-sites 19, facts-cycle-sites 15, fact-purge-sites 14, facts-repair-sites 14, dream-cycle-sites 9, family-tail-sites 8, entity-identities 5, files-ops-sites 4, import-path 3, facts-purge 2, facts-repair 2, pages 2, forget-reach-reads 1, entity-reads 1 |
| Owner, no date (rows 22, 30) | 5 | extract-takes 2, trust-tier-reads 2, chunks 1 |
| **No row, so no owner and no date** | **19** | raw-sql 4, jobs-queue 2, owner-only-marks 2, traversal-cache 2; 1 each: cli-reads-export, jobs, lifecycle, repair-frontmatter-holds, retrieval-coverage, search-privacy, segmented-body, transaction-settings, trust-write-gate |

Total 196 in 37 files. No date has passed yet. The stop-bearing dates are 5 PM PST Nov 25 (rows 27, 29 identity 4, 31)
and 5 PM PST Nov 27 (row 25 purge and derivation members, row 32). Row 21 (decide-store order under a non-C collation,
owner trunk, due Nov 25) and row 33 (landing gap, due Nov 23) are not stop rows.

The 19 unowned stops are mostly `raw_sql` refusals (an engine-wide refusal that has no row) and the `minion_queue`
family (no row). The clean baseline in this audit matched every pinned row,
but no log names the stopped cases, so a case can move from equal to stopped in one file while another case moves the
other way, and no one sees it (item 6).

## Tests that cannot fail
<!-- repo-paths: historical -->

| Test | Why it cannot fail on the bug | CI lane | Fix | Size |
|---|---|---|---|---|
| Addon-gated Rust files with no addon | Run with no addon, `rust-owner-clients`, `rust-owner-failover`, `rust-embedding-effect`, `rust-init-embedding-config`, `rust-embedding-vector-presence`, `rust-engine-spend-rollback`, `rust-withdrawal-effects`, `rust-fence-holds` and `rust-engine-addon-loader` exit 0 with 0 or 1 pass and the rest skipped (the no-addon owner cases still catch every owner socket mutant; the skipped cases are failover, clients and real-owner runs). `test.yml` never builds the addon or sets `GBRAIN_TEST_RUST_ADDON_REQUIRED`. Only `rust-engine.yml` and `rust-cli-parity.yml` set it. | Test unit lane (skips) | Set `GBRAIN_TEST_RUST_ADDON_REQUIRED=1` whenever `rust/` or `src/core/rust-engine/` changes, and add these files to the addon lane. | M |
| `test/rust-engine-privacy-pin.test.ts:82-157` (lane 8 source-text pin) | Reads `privacy.rs` and `owner_only.rs` and asserts substrings and digests. A logic flip that keeps the literals passes; a harmless rewrite fails. | Unit lane, PR and master | Keep it as a change tripwire; add one behavior case per literal on the Rust store. | M |
| `test/rust-owner-ipc-read-classes.test.ts:137`, `:251`, `:326` | Scans source text for SQL write tokens; never runs the owner. A write behind a helper it does not follow passes. | Unit lane | Run each read member once through the owner and assert that no row changed. | M |
| `takes.test.ts` 3-arm case on lane 5 head `d5ee54cecc` (not on the trunk) | Passes on PGLite, Postgres and Rust with the old addon too, so it is a regression pin, not a repro. The engine path does not reach the native fix. The native red/green tests are the real proof. | Not on trunk | Label it a pin in the file; do not count it as a repro. | S |
| `test/rank-entities.test.ts:309-314` | `.catch(() => {})` on the handler, then asserts only that the links table has rows. A refusal and a success both pass. | Unit lane, PGLite only | Assert the outcome code is `invalid_params`. | S |
| `test/rank-entities.test.ts:165-181` | Sound on PGLite, but never runs on the Rust arm, so a Rust error with another code passes. | Unit lane, PGLite only | Add the case to the Rust arm. | S |
| `test/rust-cli-parity.serial.test.ts:340`, `:355`, `:387-389` | A refused command records `refused` and passes. A Rust brain that refuses every command passes this file. | Addon lane (master), `rust-cli-parity.yml` | Count refusals against a committed list; fail a new one (item 6). | M |
| Rust CLI parity alone (lane 10 reds) | Lane reds reached handoff with only the advisory Rust CLI parity check green. Since 9:45 AM PST Nov 21 the process requires a green `test.yml` run on the exact head too. That rule is not checked in. | Process | Check in the rule as a landing gate script (item 1). | S |
| `test/rust-engine-owner-only-form-in.test.ts:13-22` | Feeds the parser the SQL text that the same TS module renders, so a rendering change the parser still reads passes. | Unit lane | Feed the rendered SQL to the store and assert hidden rows. | S |
| `rust-tally.ts:56` | `checkRustTally` returns no check when the run is partial. A filtered local run passes silently. Files pinned at 0 equal (12 files) pass while their stops do not rise. | Parity | Fail a partial run in CI mode. | S |
| `test/engine-parity/fact-visibility-widening.test.ts:43-44` | Compares each read to `reads.since!`; two undefined reads are equal. | Unit lane | Assert `reads.since` is an array first. | S |
| `test/engine-parity/page-visibility.test.ts:211-212`, `rust-vector-search-cli.serial.test.ts:101` | `every` over a possibly empty array; a swallowed parse error. Both have a guard elsewhere, so low risk. | Unit / serial | Add a length check. | S |

## Flaky, timing, skipped and serial tests
<!-- repo-paths: historical -->

Timing. Four commits since round 1 fixed flakes in place (`af14736a73`, `6792c7b1a5`, `fba3be5d5a`, `1459c952ca`). None
added a shared clock. Open timing risks:

| Test | Kind | Fix | Size |
|---|---|---|---|
| `test/rust-owner-ipc.test.ts:220` | Wall-clock bound under 1 s on a refusal path | Assert the codes only | S |
| `test/rust-owner-ipc-orphans.test.ts:81-143` (deadlines of 80-500 ms), `:96`, `:168`, `:188`, `:192` (`Bun.sleep` then `expect(answered).toBe(false)`) | Wall-clock deadline; sleep as a negative proof | Gate on the owner's queue stats | M |
| `test/rust-engine-shell.test.ts:244` (3 s hang budget), `:378` (sleep then assert) | Hang timeout; negative sleep | Wait on the owner's `closed` promise | S |
| `test/engine-parity/jobs-queue.test.ts` (9 sites), `jobs-wake.test.ts:88`, `:557`, `decide-store.test.ts:346` | Sleep-separated timestamps; can tie on one clock tick, the class `6792c7b1a5` fixed | Explicit timestamps | M |
| `test/engine-parity/code-eval-salience.test.ts:198-200`, `jobs-status.test.ts:188-203`, `takes.test.ts:667`, `trust-write-gate.test.ts:37-38` | Real-clock waits | Injected clock | M |
| `test/engine-parity/title-fuzzy-like-bound.test.ts:40`, `test/persistence-consumer-scheduling.test.ts:433-434`, `:969-970`, `:1029`, `:1048` | Elapsed-time bounds both ways | Fake timer or gate | M |

Skips. Every addon-gated Rust file skips to green with no addon (table above). `vector-embedding-parity.test.ts:719`,
`:747`, `:814` skip when the Rust arm is on; whether they should run on Rust is not decided in the tree.

Serial and lane gaps:

- The serial job excludes pull requests (`test.yml`, `if: github.event_name != 'pull_request'`). So no `*.serial.test.ts`
  file runs on a PR: CLI parity is the exception, because the two Rust workflows run it.
- `rust-export`, `rust-jsonb-key-order`, `rust-vector-search-cli` and `rust-engine-lock-owner` serial files run on the
  serial lane only, where there is no addon, so they skip.
- A push to `rust-engine/main` runs `rust-cli-parity.yml` only. The parity Rust arm, the store, shell, differential and
  owner tests run on master pushes and PRs to master (`rust-engine.yml`). Unit, serial and E2E lanes do not run on a
  trunk push.
- The addon lane runs 5 named files plus the parity glob (`rust-engine.yml:300-312`, `:321`). It does not run owner IPC,
  owner clients, failover, export, jsonb or vector CLI files.

## Evals: engine-parity vs the engine-bench oracle
<!-- repo-paths: historical -->

- Engine parity checks that Rust gives the same answer as PGLite on small fixtures. It never measures ranking quality.
- Engine-bench (gbrain-evals `origin/main` `59b8ce1be`, `eval/runner/engine-bench/`) has six stages: correctness,
  surface parity (65 pages, 54 steps, byte compare), LongMemEval recall (500 questions, top 5, paired bootstrap, top-5
  identity), perf at 10k pages, counted runs and the launch log.
- **No engine-bench run has measured the Rust engine.** The evals repo pins gbrain `7f162344652` (v0.60.748.0), which has
  no Rust engine in `engine-factory.ts`; its own unit test asserts that `rust` is refused (`rust_kind_unsupported`).
  The setup script needs `GBRAIN_REF` set by hand. No committed receipt shows a Rust run.
- No CI runs engine-bench against Rust, in either repo.
- The ranked-search gate has two bars on one page: `RUST_ENGINE.md:501` (E1) says R@5 "at least both" TypeScript values;
  `:508` (from `867870a8de`) says the 95% paired lower bound is at least -0.018 against each TypeScript engine. The
  evals code matches `:508`. The doc does not say which bar wins.
- Item 18: the -0.02 margin is no longer the gate (see the fix-item table). The open part is commit `1ea0173ad`
  (power threshold 0.0183) on an unmerged branch, so the constant a counted run uses depends on which branch lands.
- Rust vectors are an exact scan (`rust/crates/gbrain-store/src/vectors.rs:13`); Postgres uses HNSW
  (`src/schema.sql:409`). An exact scan can return a different top 5 than HNSW. The identity check counts that as a
  difference, so the counted run must say whether the reference is exact or HNSW.

| Behavior | Engine parity | Engine-bench | Gap |
|---|---|---|---|
| Ranked search quality, paired, 500 questions | No | Yes, by hand only | Never run on Rust |
| Top-5 identity | No | Yes | Never run on Rust |
| Byte-identical CLI and MCP output | `--json` normalized, 20 pages | Surface parity, 65 pages, by hand | Markdown and envelope never byte-checked on Rust |
| Speed and memory at 10k+ | No | `perf.ts`, by hand | No Rust cell anywhere |
| Exact vs HNSW recall | No | No | Neither |
| Owner process, concurrent writers | Yes, but not in the addon lane | No | Runs nowhere with an addon |
| Private pages in ranked search | Yes, small | No (keyword arm, no private pages) | Not at scale |
| CJK keyword search | `search-cjk.test.ts` only | No | Thin |

## Real data shape vs fixtures
<!-- repo-paths: historical -->

The production brain has about 13,700 pages on Postgres, with non-ASCII text and big pages. The fixtures:

| Fixture | Pages | Largest page | Non-ASCII | Private / deleted | Sources |
|---|---|---|---|---|---|
| CLI parity brain (`test/fixtures/rust-cli-parity-brain/`) | 20 | 511 bytes | none | none / none | 1 |
| Scale fixture at 10k (`scripts/scale/fixture.ts`) | 10,000 | 1,622 bytes | none | none / none | 2 |
| Parity harness cases | built per case | up to 1 MiB + 1 (`trust-tier-reads.test.ts:508`) | CJK in 4 files, emoji in 4, Latin accents in 14 | in many files | per case |

What the fixtures miss:

- Unicode: no RTL text and no combining marks in any fixture; no NFC/NFD pair of the same title; no sort-order oracle
  with non-ASCII titles. Risks: title and slug matching, collation order (design row 21 is one case), byte vs character
  offsets at a chunk boundary inside a multi-byte character.
- Big pages: no Rust CLI brain page near the 1 MiB inline limit (`PAGE_INLINE_MAX_BYTES`,
  `rust/crates/gbrain-store/src/version_prune.rs:31`), and none that splits into many chunks.
- Scale: no Rust run at 10k or 13.7k pages. Slow paths, memory, graph traversal and backlinks at production link
  density are unmeasured on Rust.
- Vectors: parity uses one-hot basis vectors at 1,536 or 900 dimensions; production uses 1,024. Near-ties in cosine order,
  where exact and HNSW differ, never occur in a fixture.
- Shape: the CLI brain has one source, 4 frontmatter keys, the longest slug is 31 characters, and it has no private or
  deleted page, so the commands users run are never checked on Rust against those states.

## Top 10 gaps, ranked by swap risk
<!-- repo-paths: historical -->

| # | Gap | Proposed owner | Size |
|---|---|---|---|
| 1 | A refused or empty Rust answer passes, so the Nov 26 shadow cannot count (decision B): land item 6 (per-case ledger, CLI refusal list) and item 10. | Parity harness (`test/engine-parity/harness.ts`, `rust-tally.ts`, `rust-cli-parity.serial.test.ts`); trunk | M |
| 2 | A trunk push runs no parity Rust arm, no `cargo test`, no unit, serial or E2E lane; addon-gated files skip to green (items 1, 10, 16). Check the gate into a landing script now; add workflow triggers and `GBRAIN_TEST_RUST_ADDON_REQUIRED=1` after 20:30Z Nov 24. | Landing gate script, then `.github/workflows/rust-engine.yml`, `test.yml` | S now, S after freeze |
| 3 | The ranked-search gate has never run on Rust: the evals pin has no Rust engine, no CI runs engine-bench, and `RUST_ENGINE.md:501` and `:508` state two bars. Pick one bar, land or drop `1ea0173ad`, bump the evals pin, run the counted stage once on Rust. | Evals `eval/runner/engine-bench/`; `RUST_ENGINE.md` owner | M |
| 4 | Nothing measures Rust at production size: no 10k or 13.7k cell, no memory number, no exact-vs-HNSW recall (item 15). | `scripts/scale/`, `scale-tier.yml` (report-only cell) | M |
| 5 | New Rust code is weakly covered: R05 (holding purge), R08 (budget with an open reservation can overspend), R11 (whole-source withdrawals missing from snapshots) fail no test; R04 and R10 only `cargo`. Add one parity case each. | Lane 4 (facts purge, `page-embedding-budget`, `trust-withdrawals` parity files) | S each |
| 6 | The oracle is "same as PGLite", so shared bugs pass and import-to-links stays unpinned (items 7, 20). | Parity harness expected values; `test/engine-parity/import-writes.test.ts` golden | L |
| 7 | Fixtures miss production shape: no NFC/NFD pair, RTL, combining marks or non-ASCII sort oracle; no near-1 MiB page or private or deleted page in the CLI brain; collation order (row 21) (item 14, 17). | `test/fixtures/rust-cli-parity-brain/`; a unicode parity file; the 3-engine lane | M |
| 8 | CLI text and markdown and MCP envelopes are never byte-compared on Rust; 189 of 221 CLI names and all 205 MCP tools have no Rust output check (item 11). | `rust-cli-parity.serial.test.ts`; a new MCP envelope parity file | L |
| 9 | 196 stops (60 in round 1); 19 map to no design row (raw_sql, minion_queue and others), and 148 sit in rows dated only in part; the facts row has 205 members with 26 dated before Dec 1. Add owner and due columns to `rust-tally.tsv` or a stop list. | `RUST_ENGINE.md` capability rows; `test/engine-parity/rust-tally.tsv` | S |
| 10 | Typed-member move guards are still missing (items 2, 3, 5): bounded preparer view allows by default, no signal lint, hand casts grew 644 to 675. Only landing gate 12 guards one case. Also fix the tests that cannot fail (privacy-pin source text, `rank-entities.test.ts:309-314`). | `src/core/persistence/bounded-reads.ts`, `scripts/check-engine-raw-sql-ratchet.ts`, `test/helpers/` | M |

## Corrections to round 1 and not verified
<!-- repo-paths: historical -->

- Round 1 said 145 parity files and its tally had 144 rows. Both are right: one file, `coverage.test.ts`, has no Rust
  arm. Today: 161 files, 160 rows.
- Round 1 line numbers moved. The ranked-search text it cited at `RUST_ENGINE.md:12` and `:479` is now at `:13`, `:23`,
  `:501`, `:506` and `:508`; the swap criteria are at `:627-644` (criterion 1 at `:636`).
- Round 1 fix item 18 pointed at `RUST_RECALL_MARGIN = -0.02` (`lme-recall.ts:82`). That constant is gone on the evals
  repo's `origin/main`; the evals repo's local `main` in this sandbox was stale, so read `origin/main`.

Not verified:

- Which of the 196 cases stop: the logs do not name them, so the stop-to-row mapping is per file, from each file's
  refused capability, and is not per case.
- No Postgres arm ran in the mutation check; CI lane placement is read from the workflow files, not seen in a run.
- The lane 10 reds that reached handoff with only Rust CLI parity green were not mapped to single tests. Lane 8's
  `bench-save-repro` and lane 5's `takes.test.ts` pin are on lane branches, not on the trunk.
- The landing gate script is not in the repository, so what it runs on each landing head (including gate 12) is as
  reported by the process owner, not read.
- No search for a counted engine-bench run on Rust beyond committed receipts; none was found.
- Production brain shape beyond the page count is not measured; no real brain was read.
