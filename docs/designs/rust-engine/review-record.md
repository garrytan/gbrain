# Rust engine plan: review record

Companion to [../RUST_ENGINE.md](../RUST_ENGINE.md). The plan was reviewed with gstack /autoplan (CEO, DX and Eng phases; design skipped, no UI), then the shadow-mode revision had a focused CEO, DX and Eng review. The "Review requirements" blocks are binding on the PRs they name.

## Review requirements

Requirements accepted in review. Each restates a change made in the sections above and names its check.

<!-- autoplan-accepted:ceo -->
- Addon identity: the addon exports `target`, `engine_abi`, `engine_build` (digest of the `rust/` tree), `catalog_version` and `format_versions`; each release pins the exact SHA-256 per target in a generated manifest; the loader refuses any other file or any mismatch except under `GBRAIN_RUST_ENGINE_ADDON`. Verify: loader unit tests for a wrong digest, a wrong `engine_abi`, a wrong catalog or format version, and the override path, each giving `engine_unavailable` with its reason and no file opened in the brain directory.
- Addon path and upgrade: addons live at `<gbrain home>/engines/rust/<engine_build>/<target>.node`; `gbrain upgrade` and `self-upgrade` stage and verify the new addon before switching and keep the previous addon until the new one opens the brain; a raw `bun install -g` upgrade fetches in `post-upgrade` or reports `engine_unavailable` with the fix command and touches no data; `gbrain engine status` reports the addon digest, store format and index lag. Verify: the addon upgrade drill (online, offline, interrupted fetch) on darwin-arm64 and linux-x64-glibc before the preview.
- Backup and restore: `gbrain backup create` and `backup restore` work on Rust brains (PR 21b, `src/core/backup/`, `src/commands/backup.ts`); a full-store restore drill passes on both preview targets before D8. Verify: restore into an empty home, then the verification digest equals the source digest for every relation.
- Preview contract (D12): the preview is limited to darwin-arm64 and linux-x64-glibc, opens only with verified backup and restore and the staged upgrade, and Windows and other platforms come before PGLite deprecation on each.
- PGLite deprecation criteria 11 and 12: every PGLite-only surface (backup create and restore, agent-install setup, `init --pglite`, `pglite-repair`, `reinit-pglite`, eval harnesses constructing `PGLiteEngine`) has a Rust path or a stated replacement; an offline upgrade drill passes on each platform being deprecated.
- Checkpoint C1 after Phases 2, 3 and 4: inputs are `bakeoff.md`, a real-brain read benchmark run by the maintainer on their own exported brain against PGLite (aggregates only, no user switched), the Track 2 size per subsystem, and effort against the budget recorded at Phase 1 entry; outcomes continue, narrow or stop are recorded in `bakeoff.md`. Broad Track 2 (beyond the ratchet, search arms and the 24 shared baseline families) starts only after continue.
- First-value cohort: PGLite users on darwin-arm64 or linux-x64-glibc who hit the measured pain; named in the Phases section.
- Track 2 coordination: a `heads-up:` per T-PR naming files and baseline rows; wait or split when the merge process reports open PRs on the same files; `engine.ts` (2,890 lines, at its ceiling) grows by at most one line per domain with types in their own modules and the ceiling row change in the same PR; a `question:` to the merge process about other work following the D6 ratchet before the first T-PR.
- Phase 6 entry requires the Phase 3 exit, including the gbrain-evals changes landed and pinned; D11 names who lands gbrain-evals changes.
- Bake-off scope: add an idiomatic-SQLite slice (pages, chunks, links, one trigger family) judged on correctness burden, migration and maintenance as well as speed, and LanceDB filtered ANN with exact fallback with binary size counted; target machines and memory envelope are written in `bakeoff.md` before any Rust number.
- Crash isolation is stated honestly: `catch_unwind` with `panic = "unwind"` covers panics only; segfaults, aborts and dependency faults are a residual risk accepted for the preview; a sidecar is deferred unless preview crash reports show native faults. Verify: a test that a panicking export returns a typed error and the process keeps serving.
- Size numbers are re-measured at 9f1d54232d (5,324 raw-SQL lines in 1,174 files; persistence 1,487) and the PR 6 ratchet baseline is generated from the tree, never copied from the plan.
- Deferred items live in the plan's `## Deferred` section: option B, platforms beyond the two preview targets before the preview, the sidecar, the `gbrain_fts_input` fix, the evals stdio protocol and `oracle-ts` shim, LLM-judged categories as gates.
- Eval harness choice: the in-tree `gbrain eval` harnesses are the primary parity oracle; gbrain-evals runners through `engine-factory` are secondary for their categories.
<!-- /autoplan-accepted:ceo -->

<!-- autoplan-accepted:dx -->
- Development override (revises the CEO addon-identity requirement): under `GBRAIN_RUST_ENGINE_ADDON` the loader skips only the release digest pin; the `engine_abi`, `catalog_version` and store format checks still apply. Verify: a loader test with the override pointing at a wrong-ABI build gives `engine_unavailable` reason `abi_mismatch`, a fix to rebuild with `bun run rust:build`, and no file opened in the brain directory.
- Error contract: every Rust engine code and reason is a row in `src/core/error-registry.ts` with class, summary, why, reasons, suggestion, read-only default fix and docs anchor; `docs/guides/error-codes.md` is regenerated and `gbrain errors <code>` answers offline. Each envelope's `detail` carries the gbrain version, target, expected and found `engine_abi`, `engine_build`, `catalog_version` and store format, environment variable names without values, home-relative paths only, and whether anything was written. Verify: one test per code and reason checks the registry row, the rendered fix, the detail fields, and that no environment variable value or absolute home path appears.
- Fix per reason: `addon_missing`, `abi_mismatch` and `build_mismatch` fix with `gbrain engine install rust` (rebuild under the override) and one retry; `unsupported_platform` has no install fix, tells the user to use a supported preview host or keep PGLite, and says not to retry; `load_failed` allows one install retry, then report with a diagnostic id; `fetch_failed` allows one retry after connectivity returns with the active addon unchanged; `verification_failed` is reported and never bypassed; `newer_format` fixes with `gbrain upgrade` to the release named in `FORMAT` `created_by` and never rewrites the store; `unreadable` keeps the directory and restores from a verified backup; `upgrade_failed` leaves the old format and names the backup written before the upgrade. These reasons are added to decision D2.
- Capability refusals: a refusal at dispatch says nothing ran, names the operation, capability and engine, links the preview capability list, and leaves moving back to the user (`next: ask_user`, read-only preview `gbrain migrate --to pglite --plan`); an engine switch is never an automatic fix. The `raw_sql` backstop reports `detail.outcome` (`none` when the enclosing transaction rolled back, else `partial` or `unknown`) and its fix reads the write receipt before any resubmission.
- Native failures: `gbrain-napi` installs its own panic hook; it writes a sanitized trace without row content or argument values to `<gbrain home>/engines/rust/diagnostics/<id>.txt` with mode 0600, and the call returns `internal_error` with `detail.diagnostic_id` and `detail.outcome`; a panic in a write transaction aborts it and the wrapper reopens the store before the next call; HTTP MCP callers get only the diagnostic id. A cancellation after commit is reported as committed. A process-ending fault is recorded at the next open and reported by doctor `rust_engine_available` with the `engine_build` and the recovery result. Verify: an injected panic inside a write transaction returns `internal_error` with an id, rolls back, and the next call succeeds.
- Maintenance path: `gbrain doctor` and `doctor --fix` on a Rust brain take the owner lock and read `FORMAT` and records without opening derived indexes; `--fix` rebuilds derived state only and never writes records. Verify: drills where a corrupt derived index and a failed open-time replay are repaired by `doctor --fix`, and a newer `FORMAT` gives `newer_format` with no write.
- Migration surface: `migrate --to rust` and `migrate --to pglite` from a Rust brain use the graduation modes and usage line (`--plan` alias `--dry-run`, `--yes --expect <hash>`, `--status`, `--resume`, `--rollback-to-source`, `--json`, progress on stderr). The read-only plan lists the addon status and install step, disk space, estimated copy time, blockers with their fix, and the capability report of operations, commands, cycle phases and minion handlers lost on Rust with reasons. The command never prompts; without `--yes --expect <hash>` a caller gets the plan and exit 3 with the fix. The run report ends with one filtered vector search timed on the source before the copy and on the target after verification, using a stored chunk embedding as the query vector, printing both times and the result count only. Verify: a test that the plan `--json` carries these fields and a non-interactive run without `--expect` exits 3 with nothing written.
- Install and status: `gbrain engine install rust` is idempotent, has `--json`, and `--from <file>` imports a hand-copied addon verified against the same pinned digest (the offline path; the override stays development only). Each failure state (interrupted fetch, attestation unavailable, digest mismatch, no disk space or permission, first open of the new addon fails) leaves the active addon unchanged and maps to a reason above; addons older than the previous one are removed after the new one opens the brain. `gbrain engine status --json` adds, under `schema_version: 1`, the target and whether it is a preview target, the home-relative addon path, its digest and the pinned digest, store format, index lag and the capability report. Verify: an install failure drill per state.
- Preview docs (PR 23): `docs/ENGINES.md` gets a tested user quickstart with expected output per step (check target, `gbrain backup create`, `gbrain engine install rust`, `migrate --to rust --plan`, the run with `--yes --expect <hash>`, one search, `gbrain engine status`, the way back), the capability list and a RustEngine column in the capability matrix; `docs/guides/troubleshooting.md` gets a symptom row per code and reason; `INSTALL_FOR_AGENTS.md` says an agent never moves a brain to Rust unless the user asks; `README.md` states the limits and the reporting route (a GitHub issue titled `rust engine:` with `gbrain engine status --json` and `gbrain doctor --json` attached; no telemetry).
- Contributor quickstart (PR 1): `rust/README.md` names rustup as the only prerequisite, `bun run rust:build` (a `package.json` script entry) builds the addon and prints its path and the `GBRAIN_RUST_ENGINE_ADDON` line, shows one `GBRAIN_TEST_BACKEND=rust bun test <file>` command and how to unset the override, and records the measured first-build time.
- Time to first query: a drill on darwin-arm64 and linux-x64-glibc in a clean home with the 10k-page engine-graduation fixture, from `gbrain engine install rust` to the first search answered on Rust, following the PR 23 quickstart verbatim; target 5 minutes, measured time written in the preview docs. The contributor quickstart is timed in PR 1, with an edit, build and test loop under 1 minute.
- Large brains: the 8 GiB backup archive cap applies to Rust brains; above it the quiesced physical-copy runbook in `docs/guides/in-agent-setup.md` gains the Rust directory layout, and the restore drill covers one store above the cap by that path.
- Dogfood record: PGLite deprecation criterion 9 records dates, brain size bands and incidents in `docs/designs/rust-engine/preview-log.md`.
- Deferred, in the plan's `## Deferred` section: moving `Fix:` to the last line of the shared CLI renderer (repo-wide, never in a Rust PR), a preview issue template under `.github/ISSUE_TEMPLATE/`, and a `gbrain engine remove rust` command.
<!-- /autoplan-accepted:dx -->

<!-- autoplan-accepted:eng -->
- Writer admission and re-entry: a caller waits for the single-writer permit asynchronously before it uses a worker thread; an open write transaction runs its commands on its own transaction executor; the wait is bounded by `AbortSignal` or deadline and ends with the existing `cancelled` or `timeout` code with no permit or task left behind; a call on the outer engine inside its own `transaction(fn)` throws `internal_error` reason `transaction_reentry` (added to D2); `lockPageKeys` is a per-key async mutex held until the transaction ends. Verify: start far more concurrent writers than worker threads while the first transaction awaits and then makes another engine call; all finish or time out within the bound, cancelled waiters leave nothing behind, re-entry gives `transaction_reentry`, and `disconnect()` finishes cleanly.
- Lifecycle: `disconnect()` and the resident-consumer stop barrier stop admission, cancel queued tasks, wait a bounded time for running tasks and then close the store; a task cancelled after it started reports what it committed through the receipt. Verify: PR 1's Bun smoke covers shutdown with pending tasks, cancellation after start, process exit with pending native work, and a full or closing threadsafe-function queue, in Bun 1.4.4 and in a compiled executable.
- Snapshot contract: every search pins one record snapshot generation; text postings and vector entries carry the generation range in which they are valid and the search uses only entries valid at its generation; superseded entries are reclaimed after the oldest reader passes them; each candidate's indexed revision and its deleted, withdrawn and visibility state are checked against the record snapshot, and a mismatch drops it and uses the exact path for that arm, keeping the `vector_candidates_incomplete` reason. Verify: pause a search across a concurrent content and permission update; the paused reader returns correct results for its snapshot and never newer restricted content.
- Failure after commit: if the outbox apply fails while the process stays alive, the call reports the write as committed through its receipt, never as rolled back; the relation is marked behind; searches that touch it use the exact path until replay succeeds; replay runs in generation order and is idempotent; `gbrain engine status` and doctor report the lag. Verify: inject failures after the record commit, after the text apply and before the vector apply with the owner alive; check the receipt, later reads, replay to zero lag and an idempotent retry.
- Graduation adapter (PR 14b): an engine-neutral adapter under the custody state machine provides catalog inspection, canonical row export, counter and sequence transfer never below a consumed value, fencing, import and verification for PGLite and Rust; `migrate --to rust` and back cover PGLite brains only; Postgres to Rust is deferred. Verify: a PGLite to Rust to PGLite roundtrip at the Phase 5 exit verifies exactly on the domains so far, including consumed but unused sequence values, generated columns, withdrawals and database-only content.
- Schema migrations on Rust stores (PR 19, D7): each `Migration` carries a Rust disposition (`catalog_only`, `postgres_only` with a reason, or a Rust handler with its own verify); `src/core/migrate.ts` dispatches on it; per migration the catalog change, data handler and version ledger row commit in one store transaction, `FORMAT` is then rewritten by atomic rename and repaired from the records when behind; a check fails a migration above the Rust baseline with no disposition; before PR 19 the loader refuses a catalog mismatch. Verify: upgrade a previous-release Rust store containing legacy rows, interrupt each migration boundary, and check resumability, preserved data and truthful version markers.
- Fingerprints: PGLite and Postgres keep computing `gbrain_fact_fingerprint` and `_v1` in SQL, unchanged; the Rust engine computes both in its own code fuzzed against PGLite's SQL on non-ASCII, mixed-case and whitespace-class input; a shared or versioned change is deferred and needs the maintainer's yes. Verify: create withdrawals and purges, migrate to Rust, insert equivalent non-ASCII and mixed-case claims; they stay suppressed.
- Test arm: the Rust arm is selected by `scripts/rust-unit-arms.ts`, modeled on `scripts/postgres-unit-arms.ts`, running only files in `test/rust-unit-arms.txt` with `GBRAIN_TEST_BACKEND=rust`; an exhaustive engine-for-backend helper replaces two-way backend branches before a file is listed; every engine opened under the arm must report `kind === 'rust'`. Verify: a listed file that still has a two-way backend branch is refused by the listing check, and a file that opens an engine of another kind under the arm fails.
- CI coverage: `rust-engine.yml` path filters include the Rust tree, the engine interface and engine-sql files, `src/schema.sql`, `src/core/migrate.ts`, `src/core/schema-migrations/`, the graduation helpers, the test-arm harness and list, and the workflow itself; `full-ci.yml` dispatches `rust-engine.yml` on the final head. Verify: a trigger-selection check shows that a schema-only change and a capability-only change select the Rust lane.
- Member coverage: `src/core/rust-engine/members.ts` classifies every `BrainEngine` member with `satisfies Record<keyof BrainEngine, 'implemented' | Capability>`; an unimplemented member throws `engine_capability_missing` naming its capability; `check:rust-capability-coverage` derives from this table and the dispatch table. Verify: adding an interface member without a row fails `bun run typecheck`.
- Engine unions: every `'postgres' | 'pglite'` engine union (kind, config type, `migrate-engine.ts` target, `resolve-ipc.ts` config shape) gains `rust`; the constructor's unsupported-engine message names all three; the inventory `engines` record is `{ pglite, postgres, rust }` with no default for `rust`. Verify: an inventory row without `rust` fails typecheck, and the constructor message test lists three engines.
- Config-level owner check: `engineIsSingleOwner(cfg.engine)` answers the single-owner question where only config exists (owner socket and secret in `resolve-ipc.ts`, `graduation-serve-guard.ts`), and the kind-branch guard covers both forms. Verify: owner socket and secret paths resolve for a Rust config the same way as for PGLite.
- Rust backup (PR 21b): the snapshot is taken under the owner lock at one committed generation, with derived indexes carried with their generation or rebuilt on restore; the PGLite snapshot path is unchanged. Verify: the full-store restore drill gives equal relation digests and zero index lag after restore.
- Performance proof: each target has a named `rust/bench/` step printing machine, engine, data size, N, p50 and p99 beside PGLite on the same machine; write throughput is measured through `transaction(fn)` with the writer held across awaits and the outbox apply included; peak memory at 200k and 1M chunks is reported against the `bakeoff.md` envelope. Verify: the bake-off report shows each step's output for both preview targets.
- Docs: `docs/ENGINES.md` "Adding a new engine" gains a note that a non-SQL engine implements typed methods instead of a `SqlExecutor` (PR 8). Verify: PR 8 review.
- Numbers: the test count reads 790 of the 830 files that call `testBackends()`, re-measured at 9f1d54232d, and is re-measured again before the gate.
- Deferred, in the plan's `## Deferred` section: Postgres to Rust migration, and moving fact fingerprint computation out of SQL for all engines.
<!-- /autoplan-accepted:eng -->

<!-- autoplan-accepted:shadow -->
Cycle 2 (gate option D, the maintainer asked for shadow mode). Two focused review agents read the shadow-mode delta against the code: one with the CEO and DX lenses, one with the Eng lens. This was a focused delta review, not a full rerun of the interactive phases. All 21 findings were accepted and folded into "Shadow mode and swap", Phase S, PRs S1 to S5, "Shadow mode tests", D13 to D15, risks and open questions.
- Cutover changes the effective route: environment and service overrides are listed (names only) and block the swap; a fresh process probe confirms the engine after the switch. Verify: the route test.
- No readiness override in the preview; privacy, fingerprints, topology, platform, capabilities, recovery drills, caught-up following and final digests are never waived. Verify: a `NOT READY` plan cannot run.
- Readiness counts successful comparisons per operation class; errored, stale, inconclusive and dropped attempts are not coverage; any unresolved `rust_error` blocks. Verify: the evidence test.
- Evidence epochs bind readiness to the candidate build, comparator and policy. Verify: a build change resets readiness.
- A bounded in-memory replay buffer, separate from the metrics ledger, feeds `explain` and `bench`; expired samples are refused. Verify: the report canary scan and the expired-sample test.
- Start, swap, failback and delete follow the graduation `--plan` / `--yes --expect` / exit 3 / `--json` contract; swap has `--status` and `--resume`.
- `engine_swap_refused` has a per-reason recovery table before S4.
- The report opens with a decision brief; speed claims come only from paired bench samples with N and uncertainty.
- Evidence arrives early: C1 replays the maintainer's export against Postgres too (labeled snapshot replay); S2 ships a provisional read and search report; status shows the estimated remaining time.
- Shadow docs ship with S4 and swap docs with S5; agents may read status, reports and plans, but starting a shadow needs the user's request and a swap needs separate approval.
- Writer eligibility comes from durable writer observations, not heartbeats; the swap sets a durable, database-enforced fence through graduation custody that stays after cutover. Verify: the fence and eligibility tests.
- The shadow runs in a supervised child process while another engine is primary; the serving process never loads the addon. Verify: the isolation test with an aborting child.
- Reverse shadow is failback for a healthy Rust store only; an immutable pre-swap checkpoint and periodic recovery points cover corruption, with the loss interval stated and approved. Verify: the recovery drills.
- The wrapper is transaction-aware and publishes invalidations only after the outer commit, including committed writes with failed receipts. Verify: the commit capture test.
- Reconcile uses shared key bounds, deletes shadow-only keys, and never lets an older snapshot overwrite newer state. Verify: the reconcile test.
- Allocator state is copied and verified separately from rows. Verify: the allocator test.
- `stale` needs snapshot or generation evidence; otherwise `inconclusive`, and repairs never turn a mismatch into a match. Verify: the classification test.
- Privacy checks each returned item against the primary's read policy; an authorized top-k substitution is a ranking difference. Verify: the privacy test.
- Write comparisons run on a copy-on-write snapshot validated against the primary's preimage, else `write_uncomparable`. Verify: the write-compare test.
- Two observation seams (engine wrapper and pipeline observer); provider outputs are captured, and side effects are suppressed before they are scheduled. Verify: the no-side-effect test.
- The graduation adapter has `migration`, `live-shadow` and `reverse-shadow` policies; shadow stores run no workers. Verify: the policies test.
<!-- /autoplan-accepted:shadow -->
## Review record

<!-- autoplan-baseline-edits:ceo {"sourceSha256":"cc436571f82437799f94232b3796d788f322414c4138dff31d7670af019af7f7","replacements":[{"oldText":"A Rust engine cannot run Postgres SQL, and about 4,890 raw-SQL call-site lines sit outside the engines.","newText":"A Rust engine cannot run Postgres SQL, and about 5,300 raw-SQL call-site lines sit outside the engines (re-measured at 9f1d54232d; see \"Size\")."},{"oldText":"lets about 1,140 files bypass the typed methods (`research/01` section 9).","newText":"lets about 1,170 files bypass the typed methods (`research/01` section 9, re-measured at 9f1d54232d)."},{"oldText":"- About 4,890 `executeRaw` / `executeRawDirect` call-site lines in about 1,140 files outside the engine files, plus","newText":"- At 36bd05806a (`research/01` section 9): about 4,890 `executeRaw` / `executeRawDirect` call-site lines in about 1,140 files outside the engine files, plus"},{"oldText":"- Only 15 storage domains live in `src/core/engine-sql/`;","newText":"- Re-measured at 9f1d54232d with the pattern `executeRaw(Direct)?\\s*[<(]` over `src`, excluding `pglite-engine.ts`, `postgres-engine.ts`, `engine.ts` and `src/core/engine-sql/`: 5,324 lines in 1,174 files. The raw-SQL ratchet baseline (PR 6) is generated from the tree at its own commit, never copied from this plan.\n- Only 15 storage domains live in `src/core/engine-sql/`;"},{"oldText":"- The largest raw-SQL user is `src/core/persistence` (353 files, 83,826 lines, about 1,414 raw-SQL lines), then `commands`, `repair`, `facts`, `cycle`, `minions`, `trust`, `access` (`research/01`, `research/08`).","newText":"- The largest raw-SQL user is `src/core/persistence` (353 files, 83,862 lines, 1,487 raw-SQL lines at 9f1d54232d), then `src/commands` (614, of which `commands/doctor` 294), `core/repair` (334), `core/facts` (244), `core/minions` (204), `core/cycle` (167), `core/trust` (135), `core/shared-skills` (125), `core/page-state` (113), `core/belief` (109), `core/access` (108) and `core/search` (100) (`research/01`, `research/08`, re-counted with the pattern above). Persistence, page state and facts (1,844 lines together) gate Phase 7 and so the preview: their size sets the date of first user value."},{"oldText":"- Postgres-only administration is never moved; it needs `postgres_admin`.","newText":"- Postgres-only administration is never moved; it needs `postgres_admin`.\n- Coordination with the merge process, per T-PR: a `heads-up:` comment naming the subsystem, the files and the baseline rows before the branch is pushed. If the merge process reports open PRs on the same files, the T-PR waits or is cut smaller instead of racing them. Churn on master in the 30 days before 9f1d54232d (first-parent commits): `src/core/engine.ts` 21, `src/core/engine-sql/` 59, `src/core/persistence/` 279, `scripts/module-size-limits.tsv` 215.\n- `src/core/engine.ts` is 2,890 lines, exactly its `check:module-size` ceiling (`scripts/module-size-limits.tsv:19`). Each domain object adds at most one line to it, its types live in their own module, and the ceiling row change with its reason rides in the same PR under the `scripts/` heads-up.\n- Track 2 is written by the Rust engine effort and landed and sequenced by the merge process, which does not write code. Before the first T-PR, a `question:` to the merge process asks whether other work it lands should follow the D6 ratchet the same way, so SQL moves in one direction only."},{"oldText":"Track 2 runs in parallel from Phase 4 onward. Each phase lists entry and exit criteria.","newText":"Track 2 starts in Phase 4 with the raw-SQL ratchet (PR 6), the search arms and the 24 shared baseline method families. The rest of Track 2 starts only after Checkpoint C1. Each phase lists entry and exit criteria.\n\nFirst value goes to PGLite users on darwin-arm64 or linux-x64-glibc who hit the measured pain above (filtered vector latency, the HNSW memory ceiling, stale planner statistics, write throughput). The preview (Phase 8) is built for them."},{"oldText":"**Phase 1: toolchain and CI.** Entry: this plan approved.","newText":"**Phase 1: toolchain and CI.** Entry: this plan approved, and an effort budget through Checkpoint C1 recorded in this document by the maintainer (recorded: 8 calendar weeks or 25 merged PRs from PR 1, whichever comes first)."},{"oldText":"compare record stores (redb, bundled SQLite as a key-value store), ANN options (usearch with predicate filtering, an own HNSW, exact SIMD scan over roaring bitmaps)","newText":"compare record stores (redb, bundled SQLite as a key-value store, and a small idiomatic-SQLite slice: pages, chunks, links and one trigger family as real SQLite tables, constraints and triggers behind the same typed Rust methods), ANN options (usearch with predicate filtering, LanceDB filtered ANN with its exact-scan fallback, an own HNSW, exact SIMD scan over roaring bitmaps)"},{"oldText":"Exit: `docs/designs/rust-engine/bakeoff.md` names the choices with data, and they meet the performance targets below. The simplest option that meets them wins; an own HNSW only with a measured advantage.","newText":"Before any Rust number exists, `bakeoff.md` names the target machines and the memory envelope (proposed: a 16 GB darwin-arm64 laptop and an 8 GB linux-x64-glibc VM, with a resident-memory budget at 200k chunks written there). Exit: `docs/designs/rust-engine/bakeoff.md` names the choices with data, and they meet the performance targets below on those machines. The idiomatic-SQLite slice is judged on correctness burden (trigger and constraint parity), migration and maintenance as well as speed; adopting it changes the store design and is the maintainer's call (open question 2). LanceDB is judged with its binary size counted. The simplest option that meets the targets wins; an own HNSW only with a measured advantage."},{"oldText":"the raw-SQL and kind-branch ratchets run in `verify`; no change for any existing user.","newText":"the raw-SQL and kind-branch ratchets run in `verify`; no change for any existing user.\n\n**Checkpoint C1: continue, narrow or stop.** Entry: Phases 2, 3 and 4 done. Inputs: `bakeoff.md`; a real-brain read benchmark (the maintainer exports their own brain with `rust/scripts/export-corpus.ts` and runs the bake-off harness against PGLite on the same brain; only aggregate numbers are published and no user is switched); the Track 2 size per subsystem re-counted at that commit; effort spent against the Phase 1 budget. Outcomes, decided by the maintainer and recorded in `bakeoff.md`: continue (the rest of Track 2 starts); narrow (keep the ratchets, the capability set and the typed methods already landed, and pause Rust domain work); or stop (one PR removes `rust/`, the Rust test arm and the `rust` kind, and keeps the ratchets and typed methods, which help the existing engines)."},{"oldText":"**Phase 6: search parity.** Entry: Phase 5 done; Track 2 search arms landed.","newText":"**Phase 6: search parity.** Entry: Phase 5 done; Track 2 search arms landed; the Phase 3 exit met, including the gbrain-evals changes landed and pinned (D11)."},{"oldText":"the minimum jobs, doctor) is complete; D4 and D8 approved. Work: PRs 21 to 23: `migrate --to rust` and back, store format and doctor checks, released addons.","newText":"the minimum jobs, doctor) is complete; `gbrain backup create` and `backup restore` work on Rust brains (PR 21b) and a full-store restore drill passes on both preview targets; the addon upgrade drill passes (stage, verify, switch, keep the previous addon; an upgrade with no network leaves the brain working or refusing with `engine_unavailable`, with no data touched); D4, D8 and D12 approved. Work: PRs 21, 21b, 22 and 23: `migrate --to rust` and back, backup and restore, store format and doctor checks, released addons with a staged upgrade."},{"oldText":"10. Prebuilt addons exist for each platform being deprecated.","newText":"10. Prebuilt addons exist for each platform being deprecated.\n11. Every PGLite-only user surface has a Rust path or a stated replacement: `backup create` and `backup restore` (`src/core/backup/snapshot.ts` refuses non-PGLite brains today), agent-install setup (`src/core/agent-install/setup.ts`), `init --pglite`, `pglite-repair` and `reinit-pglite`, and the eval harnesses that construct `PGLiteEngine`.\n12. An upgrade with no network access leaves every Rust brain either working on its pinned addon or refusing with `engine_unavailable` and the fix command, with no data touched; proven by a drill on each platform."},{"oldText":"| 21 | `gbrain migrate --to rust` and back | graduation copier target side, inventory `engines.rust`, `src/commands/migrate-engine.ts` | none | D1 |","newText":"| 21 | `gbrain migrate --to rust` and back | graduation copier target side, inventory `engines.rust`, `src/commands/migrate-engine.ts` | none | D1 |\n| 21b | `gbrain backup create` and `backup restore` for Rust brains, with a full-store restore drill | `src/core/backup/`, `src/commands/backup.ts` | none | D1 |"},{"oldText":"| 22 | Released, attested engine addons and `gbrain engine install rust` | `release.yml`, `src/commands/engine*.ts`, post-upgrade refresh |","newText":"| 22 | Released, attested engine addons with a pinned digest manifest, `gbrain engine install rust` and a staged upgrade | `release.yml`, `src/cli/commands/engine.ts` (the `engine` dispatcher, which routes only `status` today), a new `src/commands/engine-install.ts`, `src/core/binary-self-update.ts` staging, post-upgrade refresh, `engine status` fields |"},{"oldText":"T-PRs start after PR 6 and run beside PRs 10 to 17.","newText":"T-PRs for the search arms and the 24 shared baseline families start after PR 6; the other T-PRs start after Checkpoint C1. Both run beside PRs 10 to 17."},{"oldText":"Its one advantage, crash isolation, is handled instead by: `catch_unwind` on every exported function (a panic becomes a typed error, never an abort), no `unsafe` outside vetted dependencies, fuzzing at the binding boundary, and a store that recovers at the next open after any process death.","newText":"Its one advantage is crash isolation, and in process that is only partly replaced. `catch_unwind` on every exported function, with `panic = \"unwind\"` in the release profile, turns a Rust panic into a typed error. It does not catch segfaults, aborts, allocation failures or faults inside native dependencies; those still end the process. The plan makes them rarer (no `unsafe` in gbrain crates without review, fuzzing at the binding boundary, `cargo deny` and `cargo audit`) and survivable (a store that recovers at the next open after any process death, proven by the crash robot), and accepts the residual risk for the preview. A sidecar is reconsidered if preview crash reports show native faults (see \"Deferred\")."},{"oldText":"or from `<gbrain home>/engines/rust/<engine_abi>/<target>.node`.","newText":"or from `<gbrain home>/engines/rust/<engine_build>/<target>.node`."},{"oldText":"The addon exports `target`, `engine_abi` (an integer bumped when the binding surface changes) and `build_commit`; a mismatch refuses the load.","newText":"The addon exports `target`, `engine_abi` (an integer bumped when the binding surface changes), `engine_build` (a digest of the `rust/` tree it was built from), `catalog_version` and the store `format_versions` it reads and writes. Each release carries a generated manifest pinning the exact SHA-256 of the addon for each target. The loader refuses any other file and any `engine_abi`, `catalog_version` or format mismatch, except under `GBRAIN_RUST_ENGINE_ADDON`. A release that leaves `rust/` unchanged carries the previous digests forward, so the installed addon stays valid."},{"oldText":"downloads the addon matching the running `engine_abi` and target","newText":"downloads the addon whose digest the running release's manifest pins for this target"},{"oldText":"stores it under `<gbrain home>/engines/rust/<engine_abi>/`.","newText":"stores it under `<gbrain home>/engines/rust/<engine_build>/`."},{"oldText":"- Upgrades: `engine_abi` changes only when the binding surface changes, so most upgrades keep using the installed addon. When a Rust brain needs a newer addon, `post-upgrade` fetches it before finishing; if the fetch fails, the upgrade still completes and the brain reports `engine_unavailable` with the install command and a doctor finding. Brains on PGLite or Postgres never trigger a fetch.","newText":"- Upgrades: a release that leaves `rust/` unchanged pins the same digest, so the installed addon keeps working. When the pinned digest changes and a Rust brain exists, `gbrain upgrade` and `self-upgrade` fetch and verify the new addon into its own `<engine_build>/` directory before switching, and keep the previous addon until the new one has opened the brain once. If that fetch fails, the binary upgrade still completes and the Rust brain reports `engine_unavailable` with the install command, as `post-upgrade` does; an upgrade never fails for want of the addon. A raw `bun install -g` upgrade has no staging step: `post-upgrade` fetches the addon, and if that fails the brain reports `engine_unavailable` with the install command and a doctor finding, with no data touched. `gbrain engine status` reports the addon digest, the store format and the index lag. Brains on PGLite or Postgres never trigger a fetch."},{"oldText":"Rollback path 2: `gbrain migrate --to pglite` copies the Rust brain back through the same copier and verification.","newText":"Rollback path 2: `gbrain migrate --to pglite` copies the Rust brain back through the same copier and verification.\n- Neither rollback path is disaster recovery: both need a readable Rust store. Recovery from a damaged store uses `gbrain backup create` and `backup restore`, extended to Rust brains in PR 21b (today `src/core/backup/snapshot.ts` refuses non-PGLite brains), and a full-store restore drill is a preview entry criterion."},{"oldText":"`abi_mismatch`, `unsupported_platform`","newText":"`abi_mismatch`, `build_mismatch`, `unsupported_platform`"},{"oldText":"- **D10. Eval spend and pins.** About $2 to regenerate the LongMemEval embedding cache, the pinned gbrain commit for parity runs, and the E1 to E4 thresholds as written.","newText":"- **D10. Eval spend and pins.** About $2 to regenerate the LongMemEval embedding cache, the pinned gbrain commit for parity runs, and the E1 to E4 thresholds as written.\n- **D11. gbrain-evals landing.** Who lands the Phase 3 gbrain-evals changes (the maintainer or a named lander), and pinning its `gbrain` dependency to one commit for parity runs. Needed by the Phase 3 exit, and so by E1.\n- **D12. Preview contract.** The preview targets darwin-arm64 and linux-x64-glibc only. It opens only with verified backup and restore and the staged addon upgrade. Windows and the other platforms come before PGLite deprecation on each, not before the preview. Needed by PR 23."},{"oldText":"1. Who lands gbrain-evals changes? The merge process covers this repository only, and the evals repository follows `gbrain#master` unpinned today.","newText":"1. Who lands gbrain-evals changes? The merge process covers this repository only, and the evals repository follows `gbrain#master` unpinned today. Proposed as D11: the maintainer lands them or names a lander, and parity runs pin gbrain to one commit; the Phase 3 exit, and so E1, waits for it."},{"oldText":"9. Should Rust brains get a user-facing `backup create` and `backup restore`, or is the existing `backup status|check` drill plus `migrate --to pglite` enough for the preview?","newText":"9. Resolved: Rust brains get `backup create` and `backup restore` (PR 21b) before the preview. The existing commands refuse non-PGLite brains, and `migrate --to pglite` needs a readable store, so it is not recovery."},{"oldText":"- **A native crash takes down the process.** Mitigation: `catch_unwind` on every export, fuzzed boundary, crash-safe store, no `unsafe` in gbrain crates without review.","newText":"- **A native crash takes down the process.** Mitigation: `catch_unwind` on every export (panics only), fuzzed boundary, crash-safe store, no `unsafe` in gbrain crates without review. Segfaults, aborts and dependency faults remain a residual risk, accepted for the preview; a sidecar is reconsidered if crash reports show them."},{"oldText":"- **Track 2 dominates the schedule.** About 4,890 call sites across many subsystems,","newText":"- **Track 2 dominates the schedule.** About 5,300 call-site lines across many subsystems,"},{"oldText":"- **CI cost.** A Rust lane plus a growing Rust test arm. Mitigation: path filters, one addon build per run reused by shards, and the added time reported in PR 1 and PR 9.","newText":"- **CI cost.** A Rust lane plus a growing Rust test arm. Mitigation: path filters, one addon build per run reused by shards, and the added time reported in PR 1 and PR 9.\n- **Time to first value.** The preview waits for Track 2 persistence, page state and facts (1,844 raw-SQL lines), so no user benefits for many PRs. Mitigation: Checkpoint C1 decides continue, narrow or stop with real-brain data and effort against budget; the named first cohort and two preview targets keep the preview small.\n- **Addon drift on upgrade.** A same-ABI addon with older behavior could load, or an upgrade could leave a Rust brain without a usable addon. Mitigation: the pinned digest manifest, the staged upgrade that keeps the previous addon, and the offline upgrade drill (criterion 12).\n\n## Deferred\n\n- Option B, a Rust accelerator inside the PGLite or Postgres engines: it changes existing engine behavior, which Rust PRs may not do. Revisit after the preview (open question 8).\n- Platforms beyond darwin-arm64 and linux-x64-glibc before the preview: PR 24 still lands before PGLite deprecation on each platform (D12).\n- A sidecar process binding: revisit only if preview crash reports show native faults.\n- The `gbrain_fts_input` keyword-arm fix (open question 5): a separate change for all engines, never inside a Rust PR.\n- A stdio driver protocol and an `oracle-ts` shim for gbrain-evals: not needed while the in-tree `gbrain eval` harnesses and `engine-factory` cover the gates.\n- LLM-judged gbrain-evals categories as gates: they stay reported in bands set beforehand (E4).\n\n## Review requirements\n\nRequirements accepted in review. Each restates a change made in the sections above and names its check."},{"oldText":"**Phase 5: core storage domains.** Entry: Phases 2 and 4 done.","newText":"**Phase 5: core storage domains.** Entry: Phases 2 and 4 done; Checkpoint C1 decided continue."},{"oldText":"7. When is Windows needed: before the preview or before PGLite deprecation on Windows?","newText":"7. When is Windows needed? Proposed in D12: after the preview, before PGLite deprecation on Windows. Confirm with D12."},{"oldText":"Recommended: attested release assets fetched only on request (`gbrain engine install rust`) plus a best-effort refresh in `post-upgrade` for Rust brains.","newText":"Recommended: attested release assets fetched only on request (`gbrain engine install rust`, `migrate --to rust`) or, for an existing Rust brain, when an upgrade changes the pinned digest (staged by `gbrain upgrade` and `self-upgrade`, best effort in `post-upgrade`)."},{"oldText":"Mitigation: attestation and hash verification pinned to this repository's release workflow, the same as the self-updating binary; fetch only on explicit request.","newText":"Mitigation: attestation and hash verification pinned to this repository's release workflow, the same as the self-updating binary, plus the per-release digest manifest; fetch only on explicit request or for an existing Rust brain whose pinned digest changed."},{"oldText":"- `cargo deny` and `cargo audit` in the Rust lane.","newText":"- `cargo deny` and `cargo audit` in the Rust lane.\n- Drills on darwin-arm64 and linux-x64-glibc before the preview: full-store `backup create` and `backup restore` into an empty home with per-relation digests equal; addon upgrade online, offline and with an interrupted fetch, each ending with the brain working or refusing with `engine_unavailable` and no data touched."}]} -->

<!-- autoplan-accepted:ceo -->
- Addon identity: the addon exports `target`, `engine_abi`, `engine_build` (digest of the `rust/` tree), `catalog_version` and `format_versions`; each release pins the exact SHA-256 per target in a generated manifest; the loader refuses any other file or any mismatch except under `GBRAIN_RUST_ENGINE_ADDON`. Verify: loader unit tests for a wrong digest, a wrong `engine_abi`, a wrong catalog or format version, and the override path, each giving `engine_unavailable` with its reason and no file opened in the brain directory.
- Addon path and upgrade: addons live at `<gbrain home>/engines/rust/<engine_build>/<target>.node`; `gbrain upgrade` and `self-upgrade` stage and verify the new addon before switching and keep the previous addon until the new one opens the brain; a raw `bun install -g` upgrade fetches in `post-upgrade` or reports `engine_unavailable` with the fix command and touches no data; `gbrain engine status` reports the addon digest, store format and index lag. Verify: the addon upgrade drill (online, offline, interrupted fetch) on darwin-arm64 and linux-x64-glibc before the preview.
- Backup and restore: `gbrain backup create` and `backup restore` work on Rust brains (PR 21b, `src/core/backup/`, `src/commands/backup.ts`); a full-store restore drill passes on both preview targets before D8. Verify: restore into an empty home, then the verification digest equals the source digest for every relation.
- Preview contract (D12): the preview is limited to darwin-arm64 and linux-x64-glibc, opens only with verified backup and restore and the staged upgrade, and Windows and other platforms come before PGLite deprecation on each.
- PGLite deprecation criteria 11 and 12: every PGLite-only surface (backup create and restore, agent-install setup, `init --pglite`, `pglite-repair`, `reinit-pglite`, eval harnesses constructing `PGLiteEngine`) has a Rust path or a stated replacement; an offline upgrade drill passes on each platform being deprecated.
- Checkpoint C1 after Phases 2, 3 and 4: inputs are `bakeoff.md`, a real-brain read benchmark run by the maintainer on their own exported brain against PGLite (aggregates only, no user switched), the Track 2 size per subsystem, and effort against the budget recorded at Phase 1 entry; outcomes continue, narrow or stop are recorded in `bakeoff.md`. Broad Track 2 (beyond the ratchet, search arms and the 24 shared baseline families) starts only after continue.
- First-value cohort: PGLite users on darwin-arm64 or linux-x64-glibc who hit the measured pain; named in the Phases section.
- Track 2 coordination: a `heads-up:` per T-PR naming files and baseline rows; wait or split when the merge process reports open PRs on the same files; `engine.ts` (2,890 lines, at its ceiling) grows by at most one line per domain with types in their own modules and the ceiling row change in the same PR; a `question:` to the merge process about other work following the D6 ratchet before the first T-PR.
- Phase 6 entry requires the Phase 3 exit, including the gbrain-evals changes landed and pinned; D11 names who lands gbrain-evals changes.
- Bake-off scope: add an idiomatic-SQLite slice (pages, chunks, links, one trigger family) judged on correctness burden, migration and maintenance as well as speed, and LanceDB filtered ANN with exact fallback with binary size counted; target machines and memory envelope are written in `bakeoff.md` before any Rust number.
- Crash isolation is stated honestly: `catch_unwind` with `panic = "unwind"` covers panics only; segfaults, aborts and dependency faults are a residual risk accepted for the preview; a sidecar is deferred unless preview crash reports show native faults. Verify: a test that a panicking export returns a typed error and the process keeps serving.
- Size numbers are re-measured at 9f1d54232d (5,324 raw-SQL lines in 1,174 files; persistence 1,487) and the PR 6 ratchet baseline is generated from the tree, never copied from the plan.
- Deferred items live in the plan's `## Deferred` section: option B, platforms beyond the two preview targets before the preview, the sidecar, the `gbrain_fts_input` fix, the evals stdio protocol and `oracle-ts` shim, LLM-judged categories as gates.
- Eval harness choice: the in-tree `gbrain eval` harnesses are the primary parity oracle; gbrain-evals runners through `engine-factory` are secondary for their categories.
<!-- /autoplan-accepted:ceo -->

### CEO review (Phase 1)

Run facts:
- Run this plan's /autoplan run, autoplan run 2, Phase 1. Mode: SELECTIVE EXPANSION.
- Plan base: origin/master 9f1d54232d (v0.60.733.0). Re-checked against origin/master f9377cabe4 for already-done work.
- Reviewed snapshot: `.gstack/tmp/autoplan/autoplan-ceo-dZmy2e/ceo-implementation.md` (470 lines, sha 74d339f7...), read in full.
- Host adaptations: no subagent launches and no user questions. The native CEO voice ran in host on the Step 0 snapshot (sha cc436571...). The outside voice (Codex) is not installed, so it is unavailable.
- CEO scope summary: `ceo-plans/2026-11-16-rust-engine.md` in the local gstack project directory (status ACTIVE).

System audit:
- `BrainEngine` is one interface (`src/core/engine.ts:830`) with a `kind` union (`:832`), `transaction(fn)` (`:849`) and the open `executeRaw` seam (`:2714`). `engine.ts` is 2,890 lines, exactly its ceiling (`scripts/module-size-limits.tsv:19`).
- Construction knows only `pglite` and `postgres` (`src/core/engine-construct.ts:12,16,23`). `DATABASE_URL` infers postgres (`src/core/config.ts:738-745`).
- Raw SQL outside the engines: 5,324 lines in 1,174 files. Persistence alone: 353 files, 83,862 lines, 1,487 raw-SQL lines. 268 `kind ===`/`!==` branches. 831 test files use `testBackends`.
- PGLite-only surfaces: backup (`src/core/backup/snapshot.ts:23,139`), agent-install setup (`src/core/agent-install/setup.ts:5,76`), `init --pglite` (`src/commands/init.ts:56`), `pglite-repair` (`src/cli/command-table.ts:175`), LongMemEval (`src/commands/eval-longmemeval.ts:143`).
- Native addon prior art exists: the lock addon (`src/core/persistence/native-lock.ts:94`) with prebuilds for 8 targets. The release matrix is at `.github/workflows/release.yml:128-132`; binary self-update at `src/core/binary-self-update.ts:24-27`.
- The `engine` command dispatcher (`src/cli/commands/engine.ts:11`) routes only `status` today.
- No Rust work is on master: `git log origin/master --since=2026-11-10 -- rust src/core/rust-engine.ts` is empty.

Landscape (web results, treated as untrusted input):
- napi-rs support for Bun is best effort, and `bun build --compile` with addons is experimental. The plan already makes PR 1 prove `process.dlopen` in a compiled binary first.
- LanceDB offers filtered ANN with an exact-scan fallback. usearch has no native metadata filter; tantivy is lexical only. LanceDB was added to the bake-off.

#### 0A. Premises

| # | Premise | Evidence | Status |
|---|---|---|---|
| 1 | A third engine fits behind one interface | `src/core/engine.ts:830` | verified |
| 2 | Construction is a two-case switch that can take a third case | `src/core/engine-construct.ts:12` | verified |
| 3 | Raw SQL outside the engines blocks a non-SQL engine | 5,324 lines measured; `src/core/engine.ts:2714` | verified (number corrected) |
| 4 | A capability table already exists to gate subsystems | `src/core/engine-sql/executor.ts:53,81` | verified |
| 5 | Measured PGLite pain is real | `TODOS.md:50`, `TODOS.md:209`, `TODOS.md:556` | verified |
| 6 | Native addons already ship from this repo | `src/core/persistence/native-lock.ts:94` | verified |
| 7 | Migration can reuse the graduation copier | `src/commands/migrate-graduation.ts:11-12,80` | verified |
| 8 | `migrate --to` lacks a rust target today | `src/commands/migrate-engine.ts:44` | verified |
| 9 | Backup works only for PGLite | `src/core/backup/snapshot.ts:139` | verified (plan amended, PR 21b) |
| 10 | gbrain-evals follows gbrain master unpinned | `docs/designs/rust-engine/research/11-gbrain-evals.md:25` | verified (D11 added) |
| 11 | Tests can grow a third backend arm | `test/helpers/test-backends.ts:4,15,20` | verified |
| 12 | Bun version floor supports `process.dlopen` | `package.json:261-262` | verified |

unverified=0

Reality rows:

REALITY: premise-table pass 12 premises checked against code, unverified=0; BrainEngine seam, kind union, executeRaw, PGLite-only backup all confirmed src/core/engine.ts:830
REALITY: already-done pass git fetch to origin/master f9377cabe4; no rust/ tree, no rust-engine module, no Rust engine work landed src/core/engine-construct.ts:12
REALITY: surface-check finding migrate --to accepts postgres, supabase, pglite only; engine dispatcher routes only status; backup create/restore exist but refuse non-PGLite brains; plan amended (PR 21b, PR 22 paths) src/cli/commands/engine.ts:11
REALITY: binding-decisions pass gstack-decision-search returned none; user direction and the merge process guide recorded as binding constraints and applied docs/designs/RUST_ENGINE.md:47
REALITY: numbers finding raw-SQL size re-measured [measured: rg over src] to 5,324 lines in 1,174 files versus the cited 4,890; engine.ts at its 2890 ceiling; plan amended and ratchet baseline regenerated at PR 6 [re-measure before gate] scripts/module-size-limits.tsv:19
REALITY: deferred-asks pass no linked issue; deferred items listed with reasons in the plan Deferred section docs/designs/RUST_ENGINE.md:445
REALITY: pr-count finding ship-policy has no pr_count so the default is one PR per wave; the merge process requires small PRs, so the plan splits into about 45 PRs and each extra PR costs one queue slot and a heads-up where shared files move .gstack/ship-policy.json:1
REALITY: transaction-semantics pass no driver or pool change to existing engines; Rust transaction wrapper mirrors the existing transaction(fn) contract; crash robot gets a Rust cell src/core/engine.ts:849
REALITY: units pass the only unit or accuracy change is vector storage (f32, or f16 for halfvec columns); its consumers, the 1e-6 cosine rule and recall@10 against exact, are stated beside it and the f16 and quantization choices are re-tuned in the bake-off docs/designs/RUST_ENGINE.md:122
REALITY: perf-table finding targets had no named machine or memory envelope; amended so bakeoff.md names machines and envelope before any Rust number, with PGLite and Postgres baselines on the same machine scripts/scale/budgets.json:1
REALITY: recall pass plan requires recall@10 against exact at filter selectivities 100 to 0.1 percent and per-source scope buckets docs/designs/RUST_ENGINE.md:259
REALITY: prior-art pass napi-rs Bun support is best effort (diverge because PR 1 proves dlopen in a compiled exe first); LanceDB filtered ANN adopted into the bake-off src/core/persistence/native-lock.ts:94
REALITY: contract-assumptions finding gbrain-evals depends on gbrain master unpinned; D11 pins one commit and names a lander before the Phase 3 exit docs/designs/rust-engine/research/11-gbrain-evals.md:25
REALITY: dependency-fallback pass without the addon the engine reports engine_unavailable and nothing else changes; without D11 Phase 6 waits; without C1 continue broad Track 2 does not start src/core/engine-construct.ts:16
REALITY: obligation-tiers pass must-ship for preview is PRs 1 to 23 with 21b; next is PR 24; deferred list in the plan; budget recorded at Phase 1 entry and checked at C1 docs/designs/RUST_ENGINE.md:265

PLAN_REALITY: phase=ceo rows=15/15 missing=none unverified=0 verdict=complete

#### 0B. Existing code leverage
- Everything above the engine is reused unchanged: operations, MCP, fusion, chunkers, the persistence coordinator and the error contract.
- Reused pieces: the capability table, the graduation copier, the native-lock addon build and prebuild pattern, binary self-update attestation, the `testBackends` matrix and the engine-sql baselines (`scripts/engine-sql-baseline.tsv`).

#### 0C. Dream state
- Today: two SQL engines; PGLite hits the WASM heap cap, planner statistics problems and per-statement overhead.
- This plan: a third embedded engine with coded access paths and the same answers, and a closed engine seam that helps all engines.
- 12-month ideal: Rust is the default embedded engine; PGLite is retired; the seam is fully typed.

#### 0C-bis. Alternatives
- Option A (typed engine plus Track 2): kept.
- Option B (Rust accelerator inside existing engines): deferred. It changes existing engine behavior, which Rust PRs may not do.
- Sidecar process: deferred; in process with honest crash text is simpler.
- Idiomatic SQLite as the store: added as a bake-off slice; adoption is the maintainer's call (open question 2).

#### 0D. Scope proposals (SELECTIVE EXPANSION)
15 proposals: 12 accepted, 2 deferred, 1 skipped (handing Track 2 to other contributors changes the merge process's role). The full table is in the CEO scope summary.

#### 0E. Mode
SELECTIVE EXPANSION: hold the user's structure (third engine, this repository, PGLite deprecation after parity, gbrain-evals in the proof, landing through the merge process) and add only what completeness needs.

#### 0F. Temporal interrogation
- Hour 1: PR 1 proves the addon loads in a compiled binary on each target.
- Week 1 to month 1: bake-off and Track 2 ratchets; C1 decides continue, narrow or stop.
- Month 6: preview for the named cohort on two targets, with backup and staged upgrade.

#### 0G. Spec pass (in host, not a subagent launch)
- Dimensions: completeness, consistency, clarity, scope, feasibility. Score 8/10.
- 4 issues found, 4 fixed: D4 and the "Downloaded native code" risk contradicted the staged upgrade fetch; Phase 5 entry lacked the C1 continue outcome; open question 7 was not reconciled with D12; testing lacked the restore and upgrade drills. Remaining: 0.

#### 0H. Native CEO voice
- Input matched `ceo cc436571...`. Verdict: direction sound; revise before approving the full program.
- High: addon compatibility (same-ABI drift, offline upgrade). Accepted: digest manifest, `engine_build` path, staged upgrade.
- High: recovery (backup refuses non-PGLite; rollback needs a readable store). Accepted: PR 21b and a restore drill.
- High: time to value (no budget, no stop point, no cohort). Accepted: budget, Checkpoint C1, named cohort.
- High: gbrain-evals has no lander, and Phase 6 did not require Phase 3. Accepted: D11 and the Phase 6 entry.
- Medium: idiomatic SQLite missing from alternatives. Accepted: bake-off slice.
- Medium: crash-isolation claim overstated. Accepted: corrected text.

#### 0I. Consensus

```
CEO DUAL VOICES: CONSENSUS TABLE [subagent-only]
  Dimension                             Claude                     Codex  Consensus
  1. Premises valid?                    yes, numbers corrected     N/A    N/A
  2. Right problem to solve?            yes                        N/A    N/A
  3. Scope calibration correct?         no until C1 and cohort     N/A    N/A
  4. Alternatives sufficiently explored? no until SQLite slice     N/A    N/A
  5. Competitive/market risks covered?  partly, LanceDB added      N/A    N/A
  6. 6-month trajectory sound?          yes after backup, upgrade  N/A    N/A
Outside voice unavailable (not installed): six Consensus cells N/A, never CONFIRMED.
```

#### Review sections

1. Architecture. One finding: addon identity was only `engine_abi`, so a same-ABI addon with older behavior could load. Fixed with `engine_build`, `catalog_version`, `format_versions` and the pinned manifest.

```
gbrain release -> manifest {target -> sha256}
  loader: path <home>/engines/rust/<engine_build>/<target>.node
     sha256 ok? abi ok? catalog ok? format ok? -> load
     else -> engine_unavailable(reason) ; brain untouched
```

2. Errors and rescue. Mapped 9 paths; gaps on backup and upgrade, now closed (registry below).
3. Security. One High finding: downloaded native code. Mitigated by attestation pinned to the release workflow, the digest manifest and fetch only on request or digest change. Visibility parity stays a blocker.
4. Data and edge cases. Mapped: interrupted migration, offline upgrade, damaged store, empty brain, very large brain past the PGLite ceiling. Damaged store was unhandled; PR 21b closes it.
5. Code quality. One finding: `engine.ts` is at its size ceiling. Fixed with the one-line-per-domain rule and the ceiling row in the same PR.
6. Tests. Diagram below; one gap (restore and upgrade drills), fixed in Testing and proof.

```
engine tests x {pglite, postgres, rust}  (rust arm grows only)
exactness fixtures from PGLite -> rust crates
gbrain eval (primary) + gbrain-evals via engine-factory (secondary, pinned D11)
drills: restore digest equality; upgrade online/offline/interrupted
```

7. Performance. One finding: no named machines or memory envelope. Fixed in Phase 2.
8. Observability. One gap: no way to see the addon in use. Fixed: `engine status` reports digest, store format and index lag.
9. Deployment. Three risks: addon drift, Track 2 conflicts with other work on shared files, CI cost. Mitigations are in the plan.
10. Future. Reversibility 4/5: the engine is opt-in and `migrate --to pglite` exists; C1 can stop the effort with one PR. Debt items: 2 (residual native crash risk, Track 2 size).
11. Design. SKIPPED (no UI scope).

#### NOT in scope
- Option B accelerator: changes existing engines.
- Platforms beyond two targets before the preview: PR 24 lands before deprecation on each.
- Sidecar binding: only if crash reports show native faults.
- `gbrain_fts_input` fix: separate change for all engines.
- gbrain-evals stdio protocol and `oracle-ts` shim: not needed for the gates.
- LLM-judged categories as gates: reported in bands only.
- Postgres deprecation: a later plan.

#### What already exists
| Sub-problem | Existing code |
|---|---|
| Engine interface | `src/core/engine.ts:830` |
| Capability gating | `src/core/engine-sql/executor.ts:53` |
| Engine selection | `src/core/engine-construct.ts:12` |
| Engine migration | `src/commands/migrate-engine.ts:44`, `src/commands/migrate-graduation.ts:11` |
| Native addon build | `src/core/persistence/native-lock.ts:94` |
| Release and attestation | `.github/workflows/release.yml:128`, `src/core/binary-self-update.ts:24` |
| Backup | `src/core/backup/snapshot.ts:23` (PGLite only) |
| Test matrix | `test/helpers/test-backends.ts:4` |

#### Error and rescue registry
| Error | Trigger | Rescue | Status |
|---|---|---|---|
| `engine_unavailable` (missing addon) | addon not installed | install command and doctor finding | planned |
| `abi_mismatch` | binding surface changed | staged upgrade fetch | planned |
| `build_mismatch` | digest not in manifest | refuse; reinstall | added |
| `unsupported_platform` | no prebuild | stay on PGLite | planned |
| Offline upgrade | no network on upgrade | previous addon kept or refuse, data untouched | added |
| Damaged store | crash or disk fault | `backup restore` (PR 21b) | added |
| Native panic | Rust panic | `catch_unwind` typed error | planned |
| Native segfault | dependency fault | process ends; store recovers at next open | accepted risk |
| `executeRaw` on Rust | untyped subsystem | typed error; capability gate | planned |

0 critical gaps remaining.

#### Failure modes registry
| Failure | Impact | Mitigation | Critical gap |
|---|---|---|---|
| Same-ABI addon drift | wrong answers | digest manifest | no |
| Upgrade without addon | brain unusable | staged upgrade, drill | no |
| Store corruption | data loss | backup and restore drill | no |
| Track 2 never ends | no user value | C1 with budget | no |
| Evals unlanded | E1 blocked | D11 | no |
| Native crash | process ends | recovery at open, crash robot | no |
| Visibility differs | privacy breach | blocker in contract tests | no |

7 total, 0 critical gaps.

#### Dream state delta
After this plan: a third opt-in engine on two platforms with backup, staged upgrade and the parity proof, and a partly typed seam. Left for the 12-month ideal: Windows and other platforms, PGLite retirement, the rest of Track 2, the Rust engine as default.

#### Stale diagram audit
The architecture and directory diagrams in the plan still match the amended text. 0 stale diagrams.

#### Implementation tasks
Carried by the plan's PR table (PRs 1 to 24 plus 21b and the T-PRs). No separate list.

#### Completion summary

```
  +====================================================================+
  |            MEGA PLAN REVIEW: COMPLETION SUMMARY                    |
  +====================================================================+
  | Mode selected        | SELECTIVE EXPANSION                         |
  | System Audit         | seam open (5,324 raw-SQL lines); backup and |
  |                      | agent setup PGLite-only; engine.ts at cap   |
  | Step 0               | option A kept; C1, D11, D12, backup, addon  |
  | Section 1  (Arch)    | 1 issue found                               |
  | Section 2  (Errors)  | 9 error paths mapped, 0 GAPS                |
  | Section 3  (Security)| 1 issue found, 1 High severity              |
  | Section 4  (Data/UX) | 5 edge cases mapped, 0 unhandled            |
  | Section 5  (Quality) | 1 issue found                               |
  | Section 6  (Tests)   | Diagram produced, 0 gaps                    |
  | Section 7  (Perf)    | 1 issue found                               |
  | Section 8  (Observ)  | 1 gap found (fixed)                         |
  | Section 9  (Deploy)  | 3 risks flagged                             |
  | Section 10 (Future)  | Reversibility: 4/5, debt items: 2           |
  | Section 11 (Design)  | SKIPPED (no UI scope)                       |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (7 items)                           |
  | What already exists  | written                                     |
  | Dream state delta    | written                                     |
  | Error/rescue registry| 9 rows, 0 CRITICAL GAPS                     |
  | Failure modes        | 7 total, 0 CRITICAL GAPS                    |
  | TODOS.md updates     | 0 items proposed (plan Deferred section)    |
  | Scope proposals      | 15 proposed, 12 accepted (SEL)              |
  | CEO plan             | written                                     |
  | Outside voice        | codex unavailable (not installed)           |
  | Lake Score           | 12/14 recommendations chose complete option |
  | Diagrams produced    | 2 (addon load flow, test layers)            |
  | Stale diagrams found | 0                                           |
  | Unresolved decisions | 0                                           |
  | Reality rows         | 15/15 rows (PLAN_REALITY), 0 unverified     |
  +====================================================================+
```

#### Taste decisions
- Checkpoint C1 gates broad Track 2. Alternative: start all T-PRs after PR 6 as first written.
- Preview contract D12: two targets, backup and staged upgrade required, Windows later. Alternative: a broader preview with more platforms.
- Idiomatic-SQLite slice in the bake-off. Alternative: compare key-value stores only.

USER CHALLENGES: None.

Phase 2 (Design) skip: the UI-scope signal came only from a word-pair heuristic; the plan has no rendered surface and no visual files. DX scope: yes.

<!-- autoplan-baseline-edits:dx {"sourceSha256":"36abed1fa568a039111f1ed1ff8c2c2e6111c0849f6266118c5d2da92bb6388c","replacements":[{"oldText":"The loader refuses any other file and any `engine_abi`, `catalog_version` or format mismatch, except under `GBRAIN_RUST_ENGINE_ADDON`.","newText":"The loader refuses any other file and any `engine_abi`, `catalog_version` or format mismatch. Under `GBRAIN_RUST_ENGINE_ADDON` only the release digest pin is skipped; the `engine_abi`, catalog and format checks still apply, so a stale local build fails with its reason instead of opening the store."},{"oldText":"gives `engine_unavailable` (decision D2) with the fix command, and nothing else changes.","newText":"gives `engine_unavailable` (decision D2) with the fix for its reason (\"Error contract for the Rust engine\" below), and nothing else changes."},{"oldText":"PgBouncer handling) needs `postgres_admin` and stays unavailable on Rust by design.","newText":"PgBouncer handling) needs `postgres_admin` and stays unavailable on Rust by design.\n\n### Error contract for the Rust engine\n\n- Every new code and reason is a row in `src/core/error-registry.ts` (class, summary, why, reasons, suggestion, default read-only fix, docs anchor). `bun run build:error-codes` regenerates `docs/guides/error-codes.md`, and `gbrain errors <code>` answers offline. Errors use the existing envelope (`docs/protocol/AGENT_OPERATOR_v1.md`): stderr and a non-zero exit on the CLI, one `--json` document, `isError` over MCP.\n- Each envelope's `detail` carries caller-safe context: the gbrain version, the target, expected and found `engine_abi`, `engine_build`, `catalog_version` and store format, the names (never the values) of the environment variables that mattered, and home-relative paths only. Every refusal says whether anything was written.\n- One fix per reason:\n\n| Code and reason | Fix | Actor, `next` | Recovery |\n|---|---|---|---|\n| `engine_unavailable` `addon_missing` | `gbrain engine install rust`; verify with `gbrain engine status --json` | agent, `run` | nothing was touched; retry the failed call once after the install |\n| `engine_unavailable` `abi_mismatch`, `build_mismatch` | `gbrain engine install rust` (fetches the addon this release pins) | agent, `run` | as above; under `GBRAIN_RUST_ENGINE_ADDON` the fix says to rebuild with `bun run rust:build` instead |\n| `engine_unavailable` `unsupported_platform` | none to run: no addon exists for this target; open the brain on a supported preview host, or keep this brain on PGLite | user, `tell_user_to_run` | do not retry the install on this target |\n| `engine_unavailable` `load_failed` | `gbrain engine install rust` once; if it fails again, report with `detail.diagnostic_id` | agent, `run`, then `report` | one retry; the sanitized loader cause is in `detail` |\n| `engine_unavailable` `fetch_failed` | after connectivity returns, `gbrain engine install rust` once | agent, `run` | the staged download was discarded and the active addon is unchanged; one retry, then report |\n| `engine_unavailable` `verification_failed` | none; report it; there is never a bypass | user, `report` | the downloaded file is deleted and the active addon is unchanged |\n| `engine_capability_missing` before dispatch | none to run on this brain: tell the user the operation is not in the preview, with the capability list anchor; moving back is the user's choice, previewed read-only with `gbrain migrate --to pglite --plan` | user, `ask_user` | nothing ran |\n| `engine_capability_missing` `raw_sql` (backstop) | read the write receipt (`gbrain write-request -- <id>`) before any resubmission | agent, `run` (read only) | `detail.outcome` is `none` when the enclosing transaction rolled back, else `partial` or `unknown`; reconcile before retrying |\n| `engine_store_format_unsupported` `newer_format` | `gbrain upgrade` to at least the release named in `FORMAT` `created_by` | user, `tell_user_to_run` | the store is never downgraded or rewritten |\n| `engine_store_format_unsupported` `unreadable` | keep the directory as it is; restore from a verified backup (`gbrain backup restore`) | user, `ask_user` | nothing was written |\n| `engine_store_format_unsupported` `upgrade_failed` | none to run; the store stays at its old format and `detail` names the backup written before the upgrade | user, `report` | the old format remains readable by the previous release |\n\n- Caught panics: `gbrain-napi` installs its own panic hook, because the default hook prints the payload to stderr. The hook writes a sanitized trace (no row content, no argument values) to `<gbrain home>/engines/rust/diagnostics/<id>.txt` with mode 0600 and the call returns `internal_error` naming the operation, with `detail.diagnostic_id` and `detail.outcome`. A panic inside a write transaction aborts it; the wrapper then closes and reopens the store, which runs open-time recovery, before the next call. Over HTTP MCP only the diagnostic id is returned.\n- A cancellation that arrives after commit reports the write as committed through its receipt, never as cancelled.\n- Faults that end the process (segfaults, aborts) cannot be caught. The next open records that the previous owner ended without closing the store, and doctor `rust_engine_available` reports it with the `engine_build` and the recovery result.\n- Maintenance path: `gbrain doctor` and `doctor --fix` on a Rust brain take the owner lock and read `FORMAT` and the records without opening the derived indexes, so a corrupt index or a failed open-time replay can still be inspected and rebuilt. `--fix` rebuilds derived state only and never writes records.\n- Human output keeps the shared renderer (`Error [code]`, `Fix:`, `Why:`, `Docs:`); agents read `fix` from the `--json` document.\n- The reasons added here (`fetch_failed`, `verification_failed`, `newer_format`, `unreadable`, `upgrade_failed`) are part of decision D2."},{"oldText":"refused before touching anything when the addon is unavailable.","newText":"refused before touching anything when the addon is unavailable.\n- `migrate --to rust`, and `migrate --to pglite` from a Rust brain, have the graduation modes and usage line: `--plan` (alias `--dry-run`, read-only), `--yes --expect <hash>`, `--status`, `--resume`, `--rollback-to-source`, and `--json` with progress on stderr. The plan lists the addon status and its install step, the disk space needed, the estimated copy time, blockers with their fix (for example a live `gbrain serve` and how to stop it), and the capability report: each operation, command, cycle phase and minion handler the brain would lose on Rust, with its reason.\n- The command never prompts. A missing addon is installed by the run only as a step listed in the plan. A caller without `--yes --expect <hash>` gets the plan and exit 3 with the fix.\n- The run report ends with one filtered vector search timed on the source before the copy and on the target after verification. It uses a stored chunk embedding as the query vector, so no provider is called, and prints both times and the result count only."},{"oldText":"`gbrain engine status` reports the addon digest, the store format and the index lag.","newText":"`gbrain engine status` (and its `--json` document, as additive fields under `schema_version: 1`) reports the target and whether it is a preview target, the addon path (home-relative), its digest and the pinned digest, the store format, the index lag and the capability report."},{"oldText":"`migrate --to rust` offers the same step.","newText":"`migrate --to rust` offers the same step. `gbrain engine install rust` is idempotent (an installed, verified addon exits 0) and has a `--json` form. `gbrain engine install rust --from <file>` imports an addon copied by hand and verifies it against the same pinned digest; it is the offline path, and `GBRAIN_RUST_ENGINE_ADDON` stays a development override. Each install failure state (interrupted fetch, attestation unavailable, digest mismatch, no disk space or permission, the new addon failing its first open) leaves the active addon unchanged and maps to a reason in the error contract. After the new addon has opened the brain, addons older than the previous one are removed."},{"oldText":"| 22 | Released, attested engine addons with a pinned digest manifest, `gbrain engine install rust` and a staged upgrade |","newText":"| 22 | Released, attested engine addons with a pinned digest manifest, `gbrain engine install rust` (with `--from <file>` for offline import) and a staged upgrade |"},{"oldText":"| 23 | Rust engine preview documentation | `docs/ENGINES.md` (new section, capability matrix row), `README.md` limits | none | D8 |","newText":"| 23 | Rust engine preview documentation | `docs/ENGINES.md` (new section with a tested user quickstart: check the target, `gbrain backup create`, `gbrain engine install rust`, `gbrain migrate --to rust --plan`, then `--yes --expect <hash>`, one search, `gbrain engine status`, and the way back; expected output for each step; the capability list; a RustEngine column in the capability matrix), `docs/guides/troubleshooting.md` symptom rows for each new code and reason, `INSTALL_FOR_AGENTS.md` (an agent never moves a brain to Rust unless the user asks), `README.md` limits, how to report a preview problem (a GitHub issue titled `rust engine:` with `gbrain engine status --json` and `gbrain doctor --json` attached; no telemetry) | none | D8 |"},{"oldText":"`rust-toolchain.toml`, `Cargo.lock`, `deny.toml`;","newText":"`rust-toolchain.toml`, `Cargo.lock`, `deny.toml`; `rust/README.md` contributor quickstart (rustup is the only prerequisite; `bun run rust:build` builds the addon and prints its path and the `GBRAIN_RUST_ENGINE_ADDON` line; one `GBRAIN_TEST_BACKEND=rust bun test <file>` command; how to unset the override; the measured first-build time); a `rust:build` script entry in `package.json`;"},{"oldText":"an interrupted fetch, each ending with the brain working or refusing with `engine_unavailable` and no data touched.","newText":"an interrupted fetch, each ending with the brain working or refusing with `engine_unavailable` and no data touched.\n- Time-to-first-query drill on both preview targets, in a clean home with the 10k-page engine-graduation fixture: from `gbrain engine install rust` to the first search answered on Rust, following the PR 23 quickstart verbatim. Target: 5 minutes. The measured time is written in the preview docs. The PR 1 contributor quickstart is timed the same way (first build reported; edit, build and test loop under 1 minute).\n- Failure drills: a corrupt derived index and a failed open-time replay are repaired by `doctor --fix` through the maintenance path; a newer `FORMAT` gives `newer_format` with no write; an injected panic inside a write transaction returns `internal_error` with a diagnostic id, rolls back, and the next call succeeds; each `engine install` failure state leaves the active addon unchanged.\n- Error rows: one test per code and reason checks the registry row, the rendered `fix`, the `detail` context, and that no environment variable value and no absolute home path appears in the envelope or the diagnostic file."},{"oldText":"a full-store restore drill is a preview entry criterion.","newText":"a full-store restore drill is a preview entry criterion. The 8 GiB archive cap (`src/core/backup/archive.ts`) applies to Rust brains too; above it, the quiesced physical-copy runbook (`docs/guides/in-agent-setup.md`, \"Large or non-standard brains\") gains the Rust directory layout, and the restore drill covers one store above the cap by that path."},{"oldText":"no open P1 bug against the engine.","newText":"no open P1 bug against the engine. Dates, brain size bands and incidents are recorded in `docs/designs/rust-engine/preview-log.md`."},{"oldText":"`engine_store_format_unsupported` (newer or unreadable store format). Needed by PRs 8 and 19.","newText":"`engine_store_format_unsupported` (newer or unreadable store format). Needed by PRs 8 and 19. Review added the reasons `fetch_failed` and `verification_failed` (`engine_unavailable`, PR 22) and `newer_format`, `unreadable` and `upgrade_failed` (`engine_store_format_unsupported`)."},{"oldText":"LLM-judged gbrain-evals categories as gates: they stay reported in bands set beforehand (E4).","newText":"LLM-judged gbrain-evals categories as gates: they stay reported in bands set beforehand (E4).\n- Moving the `Fix:` line to the last line of the shared CLI error renderer (`src/core/agent-output.ts` prints it second): a change for every command, never inside a Rust PR. Agents read `fix` from `--json`.\n- A Rust preview issue template under `.github/ISSUE_TEMPLATE/`: the preview docs name the reporting route instead.\n- A `gbrain engine remove rust` command: removing an addon by hand is enough for the preview."}]} -->

<!-- autoplan-accepted:dx -->
- Development override (revises the CEO addon-identity requirement): under `GBRAIN_RUST_ENGINE_ADDON` the loader skips only the release digest pin; the `engine_abi`, `catalog_version` and store format checks still apply. Verify: a loader test with the override pointing at a wrong-ABI build gives `engine_unavailable` reason `abi_mismatch`, a fix to rebuild with `bun run rust:build`, and no file opened in the brain directory.
- Error contract: every Rust engine code and reason is a row in `src/core/error-registry.ts` with class, summary, why, reasons, suggestion, read-only default fix and docs anchor; `docs/guides/error-codes.md` is regenerated and `gbrain errors <code>` answers offline. Each envelope's `detail` carries the gbrain version, target, expected and found `engine_abi`, `engine_build`, `catalog_version` and store format, environment variable names without values, home-relative paths only, and whether anything was written. Verify: one test per code and reason checks the registry row, the rendered fix, the detail fields, and that no environment variable value or absolute home path appears.
- Fix per reason: `addon_missing`, `abi_mismatch` and `build_mismatch` fix with `gbrain engine install rust` (rebuild under the override) and one retry; `unsupported_platform` has no install fix, tells the user to use a supported preview host or keep PGLite, and says not to retry; `load_failed` allows one install retry, then report with a diagnostic id; `fetch_failed` allows one retry after connectivity returns with the active addon unchanged; `verification_failed` is reported and never bypassed; `newer_format` fixes with `gbrain upgrade` to the release named in `FORMAT` `created_by` and never rewrites the store; `unreadable` keeps the directory and restores from a verified backup; `upgrade_failed` leaves the old format and names the backup written before the upgrade. These reasons are added to decision D2.
- Capability refusals: a refusal at dispatch says nothing ran, names the operation, capability and engine, links the preview capability list, and leaves moving back to the user (`next: ask_user`, read-only preview `gbrain migrate --to pglite --plan`); an engine switch is never an automatic fix. The `raw_sql` backstop reports `detail.outcome` (`none` when the enclosing transaction rolled back, else `partial` or `unknown`) and its fix reads the write receipt before any resubmission.
- Native failures: `gbrain-napi` installs its own panic hook; it writes a sanitized trace without row content or argument values to `<gbrain home>/engines/rust/diagnostics/<id>.txt` with mode 0600, and the call returns `internal_error` with `detail.diagnostic_id` and `detail.outcome`; a panic in a write transaction aborts it and the wrapper reopens the store before the next call; HTTP MCP callers get only the diagnostic id. A cancellation after commit is reported as committed. A process-ending fault is recorded at the next open and reported by doctor `rust_engine_available` with the `engine_build` and the recovery result. Verify: an injected panic inside a write transaction returns `internal_error` with an id, rolls back, and the next call succeeds.
- Maintenance path: `gbrain doctor` and `doctor --fix` on a Rust brain take the owner lock and read `FORMAT` and records without opening derived indexes; `--fix` rebuilds derived state only and never writes records. Verify: drills where a corrupt derived index and a failed open-time replay are repaired by `doctor --fix`, and a newer `FORMAT` gives `newer_format` with no write.
- Migration surface: `migrate --to rust` and `migrate --to pglite` from a Rust brain use the graduation modes and usage line (`--plan` alias `--dry-run`, `--yes --expect <hash>`, `--status`, `--resume`, `--rollback-to-source`, `--json`, progress on stderr). The read-only plan lists the addon status and install step, disk space, estimated copy time, blockers with their fix, and the capability report of operations, commands, cycle phases and minion handlers lost on Rust with reasons. The command never prompts; without `--yes --expect <hash>` a caller gets the plan and exit 3 with the fix. The run report ends with one filtered vector search timed on the source before the copy and on the target after verification, using a stored chunk embedding as the query vector, printing both times and the result count only. Verify: a test that the plan `--json` carries these fields and a non-interactive run without `--expect` exits 3 with nothing written.
- Install and status: `gbrain engine install rust` is idempotent, has `--json`, and `--from <file>` imports a hand-copied addon verified against the same pinned digest (the offline path; the override stays development only). Each failure state (interrupted fetch, attestation unavailable, digest mismatch, no disk space or permission, first open of the new addon fails) leaves the active addon unchanged and maps to a reason above; addons older than the previous one are removed after the new one opens the brain. `gbrain engine status --json` adds, under `schema_version: 1`, the target and whether it is a preview target, the home-relative addon path, its digest and the pinned digest, store format, index lag and the capability report. Verify: an install failure drill per state.
- Preview docs (PR 23): `docs/ENGINES.md` gets a tested user quickstart with expected output per step (check target, `gbrain backup create`, `gbrain engine install rust`, `migrate --to rust --plan`, the run with `--yes --expect <hash>`, one search, `gbrain engine status`, the way back), the capability list and a RustEngine column in the capability matrix; `docs/guides/troubleshooting.md` gets a symptom row per code and reason; `INSTALL_FOR_AGENTS.md` says an agent never moves a brain to Rust unless the user asks; `README.md` states the limits and the reporting route (a GitHub issue titled `rust engine:` with `gbrain engine status --json` and `gbrain doctor --json` attached; no telemetry).
- Contributor quickstart (PR 1): `rust/README.md` names rustup as the only prerequisite, `bun run rust:build` (a `package.json` script entry) builds the addon and prints its path and the `GBRAIN_RUST_ENGINE_ADDON` line, shows one `GBRAIN_TEST_BACKEND=rust bun test <file>` command and how to unset the override, and records the measured first-build time.
- Time to first query: a drill on darwin-arm64 and linux-x64-glibc in a clean home with the 10k-page engine-graduation fixture, from `gbrain engine install rust` to the first search answered on Rust, following the PR 23 quickstart verbatim; target 5 minutes, measured time written in the preview docs. The contributor quickstart is timed in PR 1, with an edit, build and test loop under 1 minute.
- Large brains: the 8 GiB backup archive cap applies to Rust brains; above it the quiesced physical-copy runbook in `docs/guides/in-agent-setup.md` gains the Rust directory layout, and the restore drill covers one store above the cap by that path.
- Dogfood record: PGLite deprecation criterion 9 records dates, brain size bands and incidents in `docs/designs/rust-engine/preview-log.md`.
- Deferred, in the plan's `## Deferred` section: moving `Fix:` to the last line of the shared CLI renderer (repo-wide, never in a Rust PR), a preview issue template under `.github/ISSUE_TEMPLATE/`, and a `gbrain engine remove rust` command.
<!-- /autoplan-accepted:dx -->

### DX review (Phase 2.5)

Run facts:
- Run this plan's /autoplan run, autoplan run 2, Phase 2.5. Mode: DX POLISH. Rubric: `agent-ready-v1`.
- Reviewed snapshot: `.gstack/tmp/autoplan/autoplan-dx-Ij2Ltz/dx-implementation.md` (sha 74d339f7...), read in full. Methodology read in full (1,870 lines).
- Product type: developer tool. A CLI and an in-process storage engine (a native addon behind `BrainEngine`), used by people and by agents through `--json` and MCP.
- Grounding read in the checkout: `README.md`, `docs/ENGINES.md` (engine status, adding an engine, capability matrix), `docs/protocol/AGENT_OPERATOR_v1.md` (error envelope, `Action`, exit codes), `docs/guides/troubleshooting.md` (symptom table), `src/core/error-registry.ts`, `src/core/agent-output.ts`, `src/cli/cli-error.ts`, `src/cli/commands/engine.ts`, `src/commands/migrate-engine.ts`, `src/commands/migrate-graduation.ts`, `src/commands/diag.ts`, `src/core/backup/archive.ts`, `CONTRIBUTING.md`, the gbrain-evals README.
- Web research was unavailable in this host. Benchmarks for outside tools are reference knowledge, labeled as estimates (P1).
- Voices: native DX subagent completed (INPUT matched `dx 74d339f7...`), 8 findings. Codex not installed: outside voice unavailable.

#### Developer persona card

```
PERSONA: the PGLite power user who runs gbrain through an agent
  Who:       a developer or agent operator with a personal brain on PGLite,
             darwin-arm64 or linux-x64-glibc, 10k to 200k chunks
  Context:   gbrain runs under an agent (MCP or CLI with --json) and a
             `gbrain serve`; the user acts in a terminal when the agent asks
  Pain:      filtered vector search in hundreds of ms, the HNSW memory
             ceiling, stale planner statistics, slow writes
  Tolerance: will run 3 to 5 commands and wait a few minutes, once; will not
             read source code or debug a native crash
  Success:   the same answers, visibly faster, and a sure way back
SECOND PERSONA: the contributor building the engine (Rust and TypeScript),
  who needs one build command and one test command
```

#### Empathy narrative

I run my brain on PGLite and my agent talks to it all day. Search with a date filter got slow as the brain grew, and last week an index build ran out of memory. I read that gbrain has a Rust engine preview. I open the README and see a line about limits, then hunt through `docs/ENGINES.md` for the steps. I want to know before I start what I lose: will my nightly dream cycle still run? Nothing tells me. I run `gbrain migrate --to rust` and it refuses because `gbrain serve` holds the lock. Which process, and how do I bring my agent back afterwards? I stop it, try again, and get a plan hash. I am not sure whether the run will also download the engine or stop and ask me while my agent waits. The copy starts with no estimate. Twenty minutes later my first search returns, and I cannot tell if it is faster. The next day my agent reports `engine_capability_missing` with a capability name and nothing it can do. That is the moment I think about going back. After this review, the quickstart gives me each command with its expected output, the plan tells me the time, the blockers and every feature the brain would lose, the run never prompts, and it ends by timing the same filtered search on both engines.

#### Competitive DX benchmark

| Tool | Start → result | Time + evidence type | DX choice | Source |
|---|---|---|---|---|
| gbrain on PGLite (today) | `gbrain init --pglite --no-embedding` → working brain | 1 to 2 min, estimate from the documented steps | zero-config default | `README.md` install section (repo) |
| gbrain PGLite → Postgres graduation | `migrate --to postgres --plan`, then `--yes --expect <hash>` → brain on Postgres | 10 to 30 min including database setup, estimate | read-only plan, plan hash, status, resume, rollback | `CONTRIBUTING.md` "Local graduation smoke" (repo) |
| SQLite with sqlite-vec | load the extension, create a vector table, run a KNN query | 2 to 5 min, reference knowledge, not web-verified | one file, one extension | reference knowledge |
| LanceDB (embedded) | install the package, connect to a directory, create a table, search | 2 to 5 min, reference knowledge, not web-verified | embedded directory store, filtered ANN | reference knowledge |
| Chroma (embedded) | install the package, open a persistent client, add, query | 2 to 5 min, reference knowledge, not web-verified | in-process default, server optional | reference knowledge |
| gbrain Rust engine, plan before review | read docs, install addon, migrate, first search | about 20 min, estimate (no binary exists) | opt-in move of an existing brain | this plan |
| gbrain Rust engine, plan after review | quickstart, `engine install rust`, `migrate --to rust --plan`, run, search | target 5 min on the 10k-page fixture, to be measured by the drill | plan with time, blockers and capability report; timed search at the end | this plan, "Testing and proof" |

The fair comparison is a move of an existing brain, not a fresh store, so the Rust engine is measured against graduation (10 to 30 min) and a fresh embedded store (2 to 5 min). Target tier: Competitive.

#### Magical moment specification

- Moment: the first search on Rust is visibly faster on the user's own brain.
- Vehicle: the `migrate --to rust` run report. It ends with one filtered vector search timed on the source before the copy and on the target after verification, with a stored chunk embedding as the query vector (no provider call, no spend), printing both times and the result count only.
- Uses existing parts: the graduation run report, the engine's vector search, the stored embeddings. No new command.
- TASTE DECISION (see below). Alternative: the quickstart asks the user to run `gbrain diag --json` before and after.

#### Developer journey map

Preview user:

| Stage | What the developer does | Friction before review | Resolution in the plan |
|---|---|---|---|
| Discover | reads `README.md` limits and `docs/ENGINES.md` | no quickstart, no list of what is missing on Rust, no agent rule | PR 23: tested quickstart with expected output, capability list, troubleshooting rows, `INSTALL_FOR_AGENTS.md` rule that an agent never moves a brain to Rust unless the user asks |
| Install | `gbrain engine install rust` | failure states, offline install and idempotence unspecified | idempotent, `--json`, `--from <file>` offline import, one reason and fix per failure state, active addon unchanged on failure |
| Hello world | `gbrain migrate --to rust` | modes unspecified, possible prompt, serve-lock refusal without a fix, no time estimate, no visible win | graduation modes, read-only plan with blockers and fixes, time, disk and capability report; never prompts (exit 3 with the fix); timed search at the end |
| Real usage | daily queries, cycles, jobs | a refused operation names a capability and offers nothing | per-reason fixes; dispatch refusals say nothing ran; skipped phases listed in the plan and in `engine status` |
| Debug | an error, a panic, a broken index | no trace for panics; doctor cannot reach a store that fails to open | panic hook with a private diagnostic file and id; maintenance path for doctor; failure drills |
| Upgrade | `gbrain upgrade`, a downgrade, an offline machine | covered by CEO for success paths; failure states and downgrade vague | `fetch_failed`, `verification_failed`, `newer_format`, `upgrade_failed` with fixes; old addons pruned |

Contributor:

| Stage | Before review | Resolution in the plan |
|---|---|---|
| Discover | `CONTRIBUTING.md` has no Rust path | `rust/README.md` from PR 1 |
| Install | toolchain pinned, prerequisites unstated | rustup is the only prerequisite; first-build time measured and written |
| Hello world | no command that builds a loadable `.node` and runs one test | `bun run rust:build` prints the path and the `GBRAIN_RUST_ENGINE_ADDON` line; one `GBRAIN_TEST_BACKEND=rust bun test <file>` |
| Real usage | test arm list exists | unchanged: add the file to `test/rust-unit-arms.txt` |
| Debug | a stale local build could skip compatibility checks under the override | the override skips only the digest pin; a stale build fails with `abi_mismatch` and the fix says to rebuild |
| Upgrade | `rust-toolchain.toml` pin | unchanged |

#### First-time developer confusion report

Preview user, following the plan as written before review:

- T+0:00 Reads the README limits line. Where are the steps? Addressed: PR 23 quickstart.
- T+0:03 Finds the `docs/ENGINES.md` section. What stops working on Rust? Addressed: capability list and the plan's capability report.
- T+0:06 Runs `gbrain migrate --to rust`. Does it download the engine, and will it stop to ask while my agent waits? Addressed: install is a planned step; the command never prompts.
- T+0:07 Refused: `gbrain serve` holds the lock. Which process, and how do I restart my agent? Addressed: blockers with their fix in the plan.
- T+0:10 The copy runs with no estimate. Addressed: estimated time and disk space in the plan; progress on stderr.
- T+0:20 First search returns. Is it faster? Addressed: timed search in the run report.
- T+1 day: `engine_capability_missing` from the agent with nothing to do. Addressed: per-reason fix; nothing ran; moving back is the user's choice.
- T+1 week: after `gbrain upgrade` the brain refuses with `engine_unavailable`. Which reason, and is it safe to retry? Addressed: reason table and retry bounds.

Contributor:

- T+0:00 Clones, looks for how to build the engine. Addressed: `rust/README.md`.
- T+0:10 Builds with cargo, cannot find the `.node` or the variable to set. Addressed: `bun run rust:build` prints both.
- T+0:15 A test fails oddly after pulling master; the local build is stale. Addressed: the override keeps the ABI and format checks.

#### TTHW assessment

- Preview user, before review: about 20 min, an estimate (no binary exists): finding the steps, the serve-lock refusal, the plan and run, an unestimated copy. Tier: Red Flag.
- Target: 5 min from `gbrain engine install rust` to the first search answered on Rust, on the 10k-page engine-graduation fixture in a clean home on both preview targets, following the quickstart verbatim. Tier: Competitive. Measured by the time-to-first-query drill and written in the preview docs. Larger brains report their measured copy time instead of a target.
- Contributor: before review, undetermined (no build-to-test path). Target: first build time measured and written in `rust/README.md`; edit, build and test loop under 1 min.
- TASTE DECISION on the target (see below).

#### Pass 1: Getting started (5 → 8)

- Finding: no copy-paste path from an existing PGLite brain to a search on Rust, for users or contributors (native finding 6 agrees). Decision: PR 23 user quickstart with expected output per step; PR 1 contributor quickstart and `rust:build`. Mechanical, P1.
- Finding: the migration's first run can surprise (serve lock, addon download, no estimate). Decision: graduation modes and a plan that lists blockers with fixes, time, disk and the capability report; never prompts. Mechanical, P5.
- Not 10: the copy time for large brains is real and cannot be hidden; the 5-minute target holds only for the 10k-page fixture.

#### Pass 2: API and CLI design (7 → 8)

- Kept: `engine: "rust"`, `migrate --to rust`, `engine install rust`, `engine status`, `GBRAIN_TEST_BACKEND=rust` and `GBRAIN_RUST_ENGINE_ADDON` are consistent and guessable, and reuse existing verbs.
- Finding: capability discovery is a contributor metric (`check:rust-capability-coverage`), not a user surface (native finding 7). Decision: a capability report in the migration plan and in `engine status --json`, as additive fields; no new MCP operation. Mechanical, P1.
- Finding: `migrate --to rust` mode set was implicit; the legacy `migrate --to pglite` copier has no plan, status or resume. Decision: both directions for Rust brains use the graduation modes and usage line. Mechanical, P5.
- Finding: `engine install rust` had no `--json`, idempotence or offline form. Decision: idempotent, `--json`, `--from <file>`. TASTE DECISION for `--from`.

#### Pass 3: Error messages and debugging (5 → 7)

```
ERROR PATH MATRIX (agent-ready-v1), plan before review
Path                                   | Class       | what | fix  | recovery | code | context | trace | redaction | channel | Cap
engine_unavailable at open (5 reasons) | unavailable | pass | fail | fail     | pass | fail    | N/A   | pass      | pass    | CAP6:fix,recovery,context
engine_capability_missing (dispatch    | unavailable | pass | fail | fail     | pass | fail    | N/A   | pass      | pass    | CAP6:fix,recovery
  and raw_sql backstop)
migrate --to rust refusal or failure   | caller      | pass | fail | pass     | pass | fail    | N/A   | pass      | pass    | CAP6:fix,context
engine_store_format_unsupported, and   | unavailable | fail | fail | fail     | pass | fail    | fail  | pass      | pass    | CAP6:fix,recovery,trace
  doctor on a store that fails to open
Unexpected: native panic or            | server      | fail | fail | fail     | fail | fail    | fail  | fail      | pass    | CAP6:trace,recovery
  process-ending fault
```

- N/A reasons: trace applies only to unexpected failures; the first three paths are expected refusals. Redaction for the panic path fails because the default Rust panic hook prints the payload to stderr before `catch_unwind` returns.
- No CAP4: no secret leak, no failure reported as success, no unsafe fix and no terminal block were found. The migration has a non-interactive path (`--yes --expect`), and the plan now states the command never prompts.
- What an agent saw before, for a dispatch refusal: `Error [engine_capability_missing]: this operation needs persistence_journal`, with no fix and no statement that nothing ran. After: `Fix:` names no command for the agent, `next: ask_user`, `user_message` says the operation is not in the preview and links the capability list, `detail.outcome: none`; moving back is previewed read-only with `gbrain migrate --to pglite --plan` only if the user chooses.
- What an agent saw before, for a caught panic: a typed error with no code, id or outcome. After: `internal_error` naming the operation, `detail.diagnostic_id`, `detail.outcome`, a 0600 diagnostic file on the host, and the fix to read the write receipt before any resubmission.
- Corrected unsupported-target line: `Fix: no Rust addon exists for linux-arm64-glibc; open this brain on a supported preview host or keep it on PGLite. Do not retry the install here.`
- Decision: the "Error contract for the Rust engine" subsection, one fix per reason, `detail` context, panic hook, outcome on the backstop, maintenance path, cancellation after commit reported as committed, failure drills and a test per code and reason. Mechanical, P1. Native findings 1 to 5 agree and are folded in.
- Permission and safety model: destructive steps keep `--yes --expect <hash>`; downloaded code is verified against the pinned digest and attestation with no bypass; the development override keeps the ABI and format checks. Debug aids: `GBRAIN_DEBUG=1`, `gbrain diag --json`, `gbrain doctor --json`, `gbrain errors <code>`.
- Why 7, not 8: the shared renderer prints `Fix:` on the second line of four (`src/core/agent-output.ts`, verified), not first or last; changing it changes every command, so it is deferred and agents read `fix` from `--json` (TASTE DECISION). Process-ending native faults stay uncatchable; they get a next-open record, not a trace.

DX TRIAGE: 5 CAP6 findings, 0 CAP4.

#### Pass 4: Documentation and learning (4 → 8)

- Finding: PR 23 named destinations only. Decision: the quickstart with expected output, the capability list, a RustEngine column in the capability matrix, troubleshooting symptom rows for each code and reason, the `INSTALL_FOR_AGENTS.md` rule, the reporting route. Error rows come from the registry, so `docs/guides/error-codes.md` and `gbrain errors <code>` stay in step. Mechanical, P1.
- Not 10: docs are written in PR 23, late; earlier PRs rely on this design doc and `rust/README.md`.

#### Pass 5: Upgrade and migration path (7 → 8)

- Kept from CEO: pinned digests, staged upgrade, previous addon kept, offline drill, backup and restore.
- Finding: install and upgrade failure states, downgrade to an older release and the 8 GiB backup cap for large Rust brains were unspecified (native findings 5 and 8; the cap verified at `src/core/backup/archive.ts:11`). Decision: reasons and fixes per state, `newer_format` naming the release to upgrade to, pruning addons older than the previous one, the physical-copy runbook for stores over the cap with a drill. Mechanical, P1.

#### Pass 6: Developer environment and tooling (5 → 8)

- Finding: no contributor command builds a loadable addon and runs one test; the override bypassed compatibility checks. Decision: `rust/README.md`, `bun run rust:build`, the override skips only the digest pin. Mechanical, P1 and P5. Default `bun test` and `bun run verify` still need no Rust toolchain (unchanged).

#### Pass 7: Community and ecosystem (3 → 6)

- Finding: "preview crash reports" drive the sidecar decision, but no route for them existed. Decision: PR 23 names the route (a GitHub issue titled `rust engine:` with `engine status --json` and `doctor --json` attached; no telemetry). Mechanical, P5.
- Not higher: no issue template (deferred, it touches `.github/`), and the preview cohort is small by design (D12).

#### Pass 8: DX measurement and feedback loops (5 → 7)

- Finding: no TTHW measurement; criterion 9's dogfood had no record. Decision: the time-to-first-query drill on both targets; `docs/designs/rust-engine/preview-log.md` for dates, size bands and incidents. Mechanical, P1.
- Not higher: no usage telemetry by design; feedback depends on issues and the maintainer's log.

#### Native voice reconciliation

All 8 native findings were accepted. Two claims were checked in the checkout first: the 8 GiB backup cap (`src/core/backup/archive.ts:11`, and `backup_too_large` in `src/core/error-registry.ts`) and the `Fix:` line placement (`src/core/agent-output.ts:874`, `src/cli/cli-error.ts:67`). Both hold. Finding 1's placement point is accepted as a finding with the fix deferred (repo-wide renderer). Findings 3 and 5 added reasons to D2. Finding 8's offline path became `engine install rust --from <file>`. The native voice's error-path rows that the plan now covers are in the error contract table; existing domain errors (constraints, authorization, read-only) are reused unchanged and were not re-graded.

#### Consensus table

```
DX DUAL VOICES: CONSENSUS TABLE [subagent-only]
Dimension                              | Claude subagent                         | Codex | Consensus
1. Getting started under 5 min?        | No: no walkthrough; TTHW undetermined   | N/A   | N/A
2. API/CLI naming guessable?           | Yes (7/10); capability discovery gap     | N/A   | N/A
3. Error messages actionable?          | No: 5 High CAP6 findings, no CAP4        | N/A   | N/A
4. Docs findable and complete?         | No (5/10): examples, troubleshooting     | N/A   | N/A
5. Upgrade path safe?                  | Partly: install and upgrade failures     | N/A   | N/A
6. Dev environment friction-free?      | No: no contributor build-to-test path    | N/A   | N/A
```

Codex is not installed, so every consensus cell is N/A (voice coverage missing). The subagent column agrees with this review on all six rows.

#### NOT in scope

- Moving `Fix:` to the last line in the shared CLI renderer: every command changes; never inside a Rust PR.
- A preview issue template under `.github/ISSUE_TEMPLATE/`: the docs name the route.
- `gbrain engine remove rust`: deleting the addon directory is enough for the preview.
- Usage telemetry: gbrain has none; feedback comes from issues and the preview log.
- A Champion-tier (under 2 min) TTHW: copying and indexing an existing brain cannot honestly meet it.
- A new MCP operation for capabilities: `engine status --json` and the migration plan cover it.

#### What already exists

- The error envelope, `Action` with `actor` and `next`, exit codes and the `--json` fallback (`docs/protocol/AGENT_OPERATOR_v1.md`); the registry with generated docs and `gbrain errors <code>` (`src/core/error-registry.ts`, `src/core/error-docs.ts`).
- Graduation modes: `--plan`, `--yes --expect`, `--status`, `--resume`, `--rollback-to-source`, `--json`, progress on stderr (`src/commands/migrate-graduation.ts`).
- `gbrain engine status [--json] [--probe]` with `schema_version: 1` (`docs/ENGINES.md`).
- `gbrain diag --json` with a timed search section (`src/commands/diag.ts`); `GBRAIN_DEBUG=1`.
- The quiesced physical-copy runbook for brains over the backup cap (`docs/guides/in-agent-setup.md`).
- The troubleshooting symptom table format (`docs/guides/troubleshooting.md`).
- Binary self-update verification (SHA-256 plus attestation) in `src/core/binary-self-update.ts`.

#### TODOS.md updates

None proposed. Deferred DX items are in the plan's `## Deferred` section, as for the CEO phase (no user questions in this host).

#### Implementation Tasks

Synthesized from this review's findings. Effort assumes features at about 30x and docs at about 50x human to CC time.

- [ ] **T1 (P1, human: ~2d / CC: ~1h)** Rust engine error contract: registry rows for every code and reason, `detail` context, per-reason fixes, a test per row
  - Surfaced by: Pass 3, CAP6 on all five paths; native findings 1, 2, 5
  - Files: `src/core/error-registry.ts`, `src/core/rust-engine/loader.ts`, `src/core/rust-engine.ts`, `docs/guides/error-codes.md`
  - Verify: `bun test` for the per-code tests; `bun run build:error-codes` leaves no diff
- [ ] **T2 (P1, human: ~1d / CC: ~30min)** Panic hook, diagnostic file and id, rollback and reopen after a caught panic
  - Surfaced by: Pass 3 unexpected path; native finding 4
  - Files: `rust/crates/gbrain-napi`, `src/core/rust-engine/`
  - Verify: injected-panic drill returns `internal_error` with an id and the next call succeeds
- [ ] **T3 (P1, human: ~1d / CC: ~30min)** Doctor maintenance path that works when normal open fails
  - Surfaced by: native finding 3
  - Files: `rust/crates/gbrain-store`, doctor checks, `src/core/rust-engine/`
  - Verify: corrupt-index and failed-replay drills repaired by `doctor --fix`
- [ ] **T4 (P1, human: ~1d / CC: ~30min)** `migrate --to rust` graduation modes, plan contents, capability report, never prompts, timed search at the end
  - Surfaced by: Pass 1, Pass 2; native finding 7
  - Files: `src/commands/migrate-graduation.ts`, `src/core/persistence/graduation-*.ts`
  - Verify: plan `--json` lists blockers, time, disk and lost capabilities; a non-interactive run without `--expect` exits 3
- [ ] **T5 (P1, human: ~1d / CC: ~30min)** `engine install rust` idempotence, `--json`, `--from <file>`, failure states, addon pruning; `engine status` fields
  - Surfaced by: Pass 2, Pass 5; native findings 5, 8
  - Files: `src/commands/engine-install.ts`, `src/commands/engine-status.ts`, `src/cli/commands/engine.ts`
  - Verify: install failure drills leave the active addon unchanged
- [ ] **T6 (P1, human: ~1d / CC: ~20min)** PR 23 preview docs with the tested quickstart, capability list, troubleshooting rows, agent rule, reporting route
  - Surfaced by: Pass 1, Pass 4, Pass 7; native finding 6
  - Files: `docs/ENGINES.md`, `docs/guides/troubleshooting.md`, `INSTALL_FOR_AGENTS.md`, `README.md`
  - Verify: the time-to-first-query drill follows the quickstart verbatim
- [ ] **T7 (P1, human: ~4h / CC: ~15min)** Contributor quickstart and `rust:build`; override keeps compatibility checks
  - Surfaced by: Pass 6; native findings 6, 8
  - Files: `rust/README.md`, `package.json` scripts, `src/core/rust-engine/loader.ts`
  - Verify: timed in PR 1; loader test for a wrong-ABI build under the override
- [ ] **T8 (P2, human: ~1d / CC: ~30min)** Rust layout in the physical-copy runbook and a restore drill above the 8 GiB cap
  - Surfaced by: Pass 5; native finding 8
  - Files: `docs/guides/in-agent-setup.md`, `src/core/backup/`
  - Verify: restore drill digests equal
- [ ] **T9 (P2, human: ~2h / CC: ~10min)** Time-to-first-query drill and `preview-log.md`
  - Surfaced by: Pass 8
  - Files: `scripts/` drill, `docs/designs/rust-engine/preview-log.md`
  - Verify: measured time written in the preview docs

#### DX Implementation Checklist

```
DX IMPLEMENTATION CHECKLIST
============================
[x] Time to hello world < 5 min (target, measured by the drill on the 10k fixture)
[x] Installation is one command (gbrain engine install rust; installs of gbrain itself unchanged)
[x] First run produces meaningful output (plan with time, blockers, capability report)
[x] Magical moment delivered via the migrate run report's timed search
[x] Every error message meets the agent-ready error contract (Pass 3), except Fix-line placement in human output (deferred, repo-wide)
[x] API/CLI naming is guessable without docs
[x] Every parameter has a sensible default (database_path, addon location)
[x] Docs have copy-paste examples that actually work (quickstart run verbatim by the drill)
[x] Examples show real use cases (a filtered search on the user's own brain)
[x] Upgrade path documented with migration guide (staged upgrade, way back, reasons)
[ ] Breaking changes have deprecation warnings + codemods: N/A until PR 25 (PGLite deprecation, deprecations.d)
[x] TypeScript types included (BrainEngine, typed envelopes)
[x] Works in CI/CD without special configuration (default runs need no Rust; the Rust lane is path-filtered)
[x] Free tier available: N/A, open source, no account
[x] Changelog exists and is maintained (changelog.d fragment per PR)
[x] Search works in documentation: repo docs plus gbrain errors <code> offline
[ ] Community channel exists and is monitored: GitHub issues only; no dedicated channel (deferred)
```

#### Taste decisions

- Timed search in the migration run report (magical moment). Alternative: the quickstart tells users to run `gbrain diag --json` before and after.
- Keep the shared renderer's `Fix:` placement; agents read `fix` from `--json`. Alternative: a Rust-only renderer that prints `Fix:` last, which would make Rust errors look different from every other code.
- `engine install rust --from <file>` for offline machines. Alternative: document manual cache population only.
- TTHW target 5 min on the 10k fixture (Competitive). Alternatives: under 2 min (not credible for a copy plus index build) or no number.

USER CHALLENGES: None. Every accepted change stays inside the user's direction (third engine, opt-in, PGLite deprecation later).

### Eng review (Phase 3)

INPUT: eng ef6418b306cecfe1d77a2bcb368c2f2cc763c730e30edfacf3f9561aa5884e57 (amendment checkpoint `eng-implementation.md`, 520 lines). Methodology: plan-eng-review read 2108/2108 to EOF. Native subagent voice: completed, INPUT matched the snapshot. Outside voice (codex): unavailable, not installed. Scope signals: db, perf, search, dependency.

Mode: FULL_REVIEW. Scope accepted as-is.

#### Step 0. Scope challenge

Premise table (every factual claim the plan's engineering rests on, checked at 9f1d54232d):

| # | Premise | Claim | Receipt | Verdict |
|---|---|---|---|---|
| 1 | One engine seam | `BrainEngine` with `kind: 'postgres' \| 'pglite'` and `transaction<T>` | `src/core/engine.ts:832-849` | verified |
| 2 | Raw SQL escape hatch is on the interface | `executeRaw` with signal, timeout, deadline, jitOff, prepare | `src/core/engine.ts:2714-2718` | verified |
| 3 | `engine.ts` is at its size ceiling | 2,890 lines, ceiling 2890 | `scripts/module-size-limits.tsv:19` | verified |
| 4 | engine-sql migration state | 15 migrated domains, 54 members still own SQL | `scripts/engine-sql-baseline.tsv:1` | verified |
| 5 | Direct kind comparisons | 268 in `src` | `src/core/persistence/unbound-source.ts:119` | verified |
| 6 | Engine construction is two-way | `config.engine \|\| 'postgres'`, pglite and postgres cases, "SQLite is not supported" | `src/core/engine-construct.ts:10-23` | verified |
| 7 | Database URL forces Postgres | env var implies `'postgres'` | `src/core/config.ts:738-745` | verified |
| 8 | Test matrix is two-way and env-selected | `TestBackend = 'pglite' \| 'postgres'`; unknown backends throw | `test/helpers/test-backends.ts:4-21` | verified |
| 9 | Test files branch two ways on backend | `backend === 'postgres' ? url : undefined` builds PGLite otherwise | `test/trust-release-strict-home-gst2676.test.ts:69-70` | verified |
| 10 | PGLite transaction holds keys across awaits | `withHeldPageKeys`, tx engine clone | `src/core/pglite-engine.ts:1209-1212` | verified |
| 11 | Owner model keys on config, not only engine | `cfg.engine === 'pglite'` before an engine exists | `src/core/context/resolve-ipc.ts:404` | verified |
| 12 | Graduation helpers are SQL on both sides | catalog columns, sequences, verify queries | `src/core/persistence/graduation-copy.ts:250` | verified |
| 13 | Migration runner selects SQL per kind | `m.sqlFor?.[engine.kind] ?? m.sql`, then handler and verify | `src/core/migrate.ts:546-548` | verified |
| 14 | Fingerprint is SQL with host `lower()` and POSIX classes | `gbrain_fact_fingerprint`, `_v1` | `src/core/facts/withdrawal-schema.ts:23-37` | verified |
| 15 | full-ci dispatches two workflows only | `test.yml` and `e2e.yml` | `.github/workflows/full-ci.yml:46-47` | verified |
| 16 | Backup is PGLite-only | refuses with `pglite_required`; 8 GiB archive cap | `src/core/backup/snapshot.ts:138-143` | verified |
| 17 | Release targets | `bun-darwin-arm64`, `bun-linux-x64` | `.github/workflows/release.yml:160-170` | verified |
| 18 | Native addon loader pattern exists | `loadBindingSync()` | `src/core/persistence/native-lock.ts:94` | verified |

unverified=0

What already solves each sub-problem:
- Owner lock, owner IPC, consumer election: reused via the `single_owner` capability (`src/core/persistence/consumer-election.ts`).
- Typed SQL boundary for Postgres-dialect engines: `src/core/engine-sql/` with `SqlExecutor` and `DialectCapabilities`; Track 2 extends it.
- Runner-selected test arms: `scripts/postgres-unit-arms.ts` with `test/postgres-unit-arms.txt`; the Rust arm copies this pattern.
- Expected divergence: `EXPECTED_FAILURES` with `test.failing` (`test/helpers/two-engine.ts:308`).
- Graduation custody, inventory, digest and verify: `src/core/persistence/graduation-*.ts`; kept, with an engine-neutral adapter under it.
- Native addon build, prebuild and load: `native/locks/` and `native-lock.ts`.
- Attested download: `src/core/binary-self-update.ts`.
- Crash robot and refresh-barrier spec: `scripts/persistence/README.md`, `spec/tla/refresh-barrier/`.

Complexity check: the plan touches far more than 8 files and adds many modules and crates, so the gate trips. Auto-decided `plan-eng-review-structure`: "Original arrangement" (one engine, about 45 small PRs, two tracks, Checkpoint C1) over "Smaller arrangement" (Rust index accelerator only). The smaller shape is option B, which the plan already rejected for changing existing engines and the user direction rules out. Scope accepted as-is; the review adds PR 14b and amends existing rows.

Reality rows:

REALITY: premise-table pass 18 premises checked against code at 9f1d54232d, unverified=0; seam, unions, SQL escape hatch, test matrix, graduation SQL and migration dispatch confirmed src/core/engine.ts:830
REALITY: already-done pass git fetch to origin/master a278ddf458; no rust/ tree; no rust-engine, napi or Rust engine commits since 2026-10-01 src/core/engine-construct.ts:10-23
REALITY: surface-check finding GBRAIN_TEST_BACKEND=rust throws today; migrate --to accepts postgres, supabase, pglite only; full-ci dispatches only test.yml and e2e.yml, so a separate Rust workflow never runs under full-ci; plan amended (PR 9 runner, full-ci dispatch, trigger check) test/helpers/test-backends.ts:20
REALITY: binding-decisions pass gstack-decision-search returned none; the user direction and the merge process guide stay binding; no overruled default is reintroduced docs/designs/RUST_ENGINE.md:45
REALITY: numbers finding 268 kind comparisons [measured: rg over src]; 15 migrated and 54 method rows [measured: scripts/engine-sql-baseline.tsv]; 830 files call testBackends, not 831, and 790 of them call executeRaw [measured: rg over test]; 296 two-way backend ternaries in 258 files [measured: rg over test]; plan amended [re-measure before gate] scripts/engine-sql-baseline.tsv:1
REALITY: deferred-asks pass no linked issue; the plan Deferred section gains Postgres to Rust migration and a shared fingerprint change, each with its reason docs/designs/RUST_ENGINE.md:478
REALITY: pr-count finding ship-policy has no pr_count so the default is one PR per wave; the merge process requires small PRs; this review adds PR 14b, one more queue slot with a persistence heads-up .gstack/ship-policy.json:1
REALITY: prior-art pass napi-rs on Bun is best effort and threadsafe-function shutdown, cancellation after start and exit with pending work need runtime tests (https://napi.rs/docs/more/troubleshooting); diverge because PR 1 proves each lifecycle case in Bun before engine code src/core/persistence/native-lock.ts:94
REALITY: transaction-semantics finding PGLite holds page keys across awaits through a tx engine clone; a Rust writer held across awaits on a shared worker pool can starve and re-entry can deadlock; amended with async admission, a transaction executor and a re-entry refusal; crash robot keeps its Rust cell src/core/pglite-engine.ts:1209
REALITY: contract-assumptions finding graduation copy and verify assume Postgres catalogs and sequences; the migration runner assumes SQL; fingerprint normalization depends on the host lower(); amended with a graduation adapter, a Rust migration disposition and unchanged SQL fingerprints on Postgres src/core/persistence/graduation-copy.ts:250
REALITY: units pass vector storage units unchanged from the CEO phase; raw f32 at 1M chunks and 1,024 dimensions is about 3.8 GiB [estimated] beside the 7.6 GiB HNSW figure; cosine 1e-6 and recall@10 consumers unchanged docs/ENGINES.md:236-238
REALITY: perf-table finding targets had no named bench step and writes were not measured with the writer held across awaits plus the outbox apply; amended with named rust/bench steps, same-machine PGLite, p50 and p99, and peak memory against the envelope scripts/scale/budgets.json:1
REALITY: recall pass recall@10 against exact across selectivity and scope buckets stays; a behind index or a revision mismatch falls back to the exact path and keeps the vector_candidates_incomplete reason src/core/ops/search.ts:1022
REALITY: dependency-fallback pass without the addon the engine reports engine_unavailable; without D11 Phase 6 waits; without PR 14b migrate --to rust does not ship; before PR 19 the loader refuses a catalog mismatch and dev stores are rebuilt src/core/engine-construct.ts:16
REALITY: obligation-tiers pass must-ship for the preview is PRs 1 to 23 with 14b and 21b plus the accepted eng requirements; next is PR 24; deferred items in the plan; budget recorded at Phase 1 entry and checked at C1 src/core/backup/snapshot.ts:138

PLAN_REALITY: phase=eng rows=15/15 missing=none unverified=0 verdict=complete

#### Step 0.5. Dual voices

ENG DUAL VOICES: CONSENSUS TABLE [subagent-only]

| Dimension | Claude subagent | Codex | Consensus |
|---|---|---|---|
| Architecture sound | seam sound; snapshot, post-commit, graduation and migration contracts missing | N/A | N/A |
| Test coverage sufficient | no; test arm can pass on PGLite; CI filters miss schema changes | N/A | N/A |
| Performance risks named with a budget or bench | partly; no bench step per target, write path under held writer unmeasured | N/A | N/A |
| Security threats covered | snapshot leak of newer restricted content was open | N/A | N/A |
| Error paths handled | no post-commit failure contract; re-entry hangs | N/A | N/A |
| Deployment risk manageable | yes, with full-ci wiring and the staged addon upgrade | N/A | N/A |

Codex is not installed, so every consensus cell is N/A. Native voice verdict: rework before implementation; the rework is folded into the plan below.

Native voice reconciliation (every cited file:line checked against the checkout):

| # | Native finding | Check | Disposition |
|---|---|---|---|
| 1 | P1 records and derived indexes lack a shared snapshot contract | design gap, confirmed by the plan's "One commit point" text | accepted: generation-ranged index entries, revision backstop, exact fallback, isolation test |
| 2 | P1 index apply failure after commit has no live-process contract | confirmed | accepted: committed receipt, relation marked behind, exact path until replay, fault injection test |
| 3 | P1 relation API does not support the migration roundtrip | `graduation-digest.ts:87`, `graduation-copy.ts:250`, `graduation-verify.ts:67-135` all issue SQL, confirmed | accepted: engine-neutral graduation adapter, PR 14b early roundtrip, Postgres to Rust deferred |
| 4 | P1 catalog versioning is not a migration strategy | `migrate.ts:546-605` selects SQL then runs handler and verify, confirmed | accepted: Rust disposition per migration, ordering of records, ledger and `FORMAT`, upgrade test |
| 5 | P1 shared fingerprint function can change Postgres | `withdrawal-schema.ts:23-37` uses `pg_catalog.lower` and `[[:space:]]`, confirmed | accepted: Postgres and PGLite keep SQL; Rust fuzzed against PGLite; shared change deferred |
| 6 | P1 async transaction scheduling can starve the writer | confirmed by the plan's worker-pool rule plus `transaction(fn)` held across awaits | accepted: async permit before any worker, transaction executor, bounded wait, test |
| 7 | P2 Rust CI filters miss breaking changes | `full-ci.yml:46-47` dispatches only `test.yml` and `e2e.yml`, confirmed | accepted: widened filters, full-ci dispatch, trigger-selection check |
| 8 | P2 approval inputs unresolved | C1 effort cap, corpus and spend, gbrain-evals owner | queued for the Phase 4 final gate with recommendations (Unresolved decisions below) |

#### Section 1. Architecture

```
            CLI / MCP operations / cycle / minions (unchanged TypeScript)
                                |
                    dispatch capability check  <-- engine-capabilities.ts
                                |                  members.ts (every BrainEngine member)
                          BrainEngine seam
           +--------------------+---------------------+
           |                    |                     |
     PGLiteEngine         PostgresEngine          RustEngine (wrapper, TS)
           |                    |                     |  loader.ts (dlopen, digest, abi)
     engine-sql/ (SqlExecutor, Postgres dialect)      |  admission: async writer permit
           |                    |                     |  transaction executor
       PGLite WASM          postgres.js               v
                                                gbrain-napi (async tasks, panic hook)
                                                      |
                     +-----------+-----------+--------+---------+------------+
                     |           |           |                  |            |
               gbrain-store  gbrain-domain  gbrain-text   gbrain-vector  gbrain-graph / gbrain-trgm
               records,      trigger hooks  postings      ANN + exact     BFS, trigrams
               counters,     write scope    (generation   scan, bitmaps
               outbox, FORMAT               ranges)       (generation ranges)

  Migration:  graduation custody state machine -> graduation adapter (PGLite | Rust)
  Schema:     migrate.ts -> sqlFor (PGLite, Postgres) | Rust disposition (catalog_only, postgres_only, handler+verify)
```

Findings:
- A1 (P1, native 1). No snapshot contract between records and derived indexes; an older reader could see newer indexed content or permissions. Fix accepted: entries carry generation ranges, readers filter at their snapshot, reclamation after the oldest reader, revision backstop and exact fallback.
- A2 (P1, native 2). No live-process contract for an index apply failure after commit. Fix accepted: committed receipt, relation marked behind, exact path until idempotent replay.
- A3 (P1, native 3). Graduation reuse was overstated; helpers are SQL. Fix accepted: engine-neutral adapter (PR 14b), PGLite to Rust and back only; Postgres to Rust deferred.
- A4 (P1, native 4). No schema and data migration strategy for Rust stores. Fix accepted: Rust disposition per `Migration`, one store transaction per migration, `FORMAT` repaired from records, a check for missing dispositions.
- A5 (P1, native 6 plus this review). Writer held across awaits on a shared pool can starve; a call on the outer engine inside `transaction(fn)` deadlocks. Fix accepted: async permit, transaction executor, bounded wait with existing `cancelled` and `timeout`, `internal_error` reason `transaction_reentry` (added to D2).
- A6 (P2). Worker pool lifecycle on `disconnect()` and the consumer stop barrier was unspecified, and Bun threadsafe-function lifecycle is best effort. Fix accepted: drain, cancel and close order; PR 1 smoke covers the four Bun cases.
- A7 (P2). `single_owner` as a capability misses config-level checks in `resolve-ipc.ts:404,437` and `graduation-serve-guard.ts:33`. Fix accepted: `engineIsSingleOwner(cfg.engine)`.
- A8 (P2). Backup for Rust cannot reuse the PGLite physical snapshot (`snapshot.ts:138-149`). Fix accepted: a snapshot under the owner lock at one committed generation.
- A9 (P1, native 5). Moving the fingerprint into one PGLite-matched function would change future Postgres fingerprints. Fix accepted: SQL stays on both Postgres-dialect engines.

Design twice:
- Chosen: in-process napi engine implementing typed `BrainEngine` methods, with domain rules (triggers, guards) in Rust. One commit point, no SQL, owner model reused.
- Second shape: Rust as a typed relation store under the existing TypeScript domain logic (a `SqlExecutor`-like boundary that takes relation reads and writes, with triggers kept in TypeScript). Smaller Rust surface and shared domain code, but every domain method becomes many boundary crossings, trigger semantics move to TypeScript for all engines (a behavior change for existing engines), and transaction-held-across-awaits costs grow per row. Kept the chosen shape; the relation API stays for tests, migration and digests.

Red flags screen: (1) hidden shared state: index generations, addressed by A1; (2) two sources of truth: records and indexes, addressed by A1 and A2; (3) lock held across await: A5; (4) silent fallthrough to another engine: test arm (Section 3) and `byEngineKind`; (5) config and runtime disagree: A7; (6) dependency assumed from another repo: gbrain-evals pin (D11); (7) unbounded memory: generation ranges and 1M vectors (Section 4); (8) hand-synced list: capability coverage, addressed by the member table.

Distribution: unchanged from CEO and DX (attested assets, pinned digest manifest, staged upgrade, `--from <file>`). No new install path.

One realistic production failure per new path:

| Path | Failure | Handled after review |
|---|---|---|
| Loader | stale local build under the override | refused by abi, catalog and format checks |
| Writer admission | 50 writers queue while a transaction awaits | async permit, executor; bounded wait gives `timeout` |
| Outbox apply | disk full after record commit | committed receipt; relation behind; exact path; replay |
| Search | reader paused across a permission change | generation filter plus revision backstop |
| Schema migration | handler interrupted mid-migration | one store transaction; ledger and `FORMAT` truthful |
| Graduation | target sequence below a consumed source value | adapter transfers counters at or above the max consumed |
| Backup | copy taken while the outbox is behind | snapshot at one committed generation, indexes rebuilt on restore |
| Shutdown | process exit with pending native tasks | stop admission, cancel, bounded drain; PR 1 smoke |

#### Section 2. Code quality

- Q1 (P2). Capability coverage was a hand-synced list. Fix accepted: `src/core/rust-engine/members.ts` typed `satisfies Record<keyof BrainEngine, 'implemented' | Capability>`; coverage derived from it.
- Q2 (P2). The two-engine unions live in several files (config, `migrate-engine.ts`, `resolve-ipc.ts:368`, the inventory `engines` record) and the constructor message names two engines. Fix accepted: all gain `rust`; the inventory has no default for `rust`.
- Q3 (P3). `docs/ENGINES.md` "Adding a new engine" step 3 assumes a Postgres-dialect `SqlExecutor`. Fix accepted: PR 8 adds a non-SQL engine note.

Shared-code rubric: the review reuses `scripts/postgres-unit-arms.ts`, `EXPECTED_FAILURES`, the graduation custody state machine and existing error codes (`cancelled`, `timeout`, `internal_error`) instead of adding parallel ones. One reason (`transaction_reentry`) is added under D2.

#### Section 3. Tests

Code path and user flow coverage (planned tests after this review):

```
CODE PATHS                                            USER FLOWS
constructEngine('rust')                               gbrain engine install rust
 +- addon missing / abi / format  [★★ TESTED] loader   +- each failure state      [★★ TESTED] drills
 +- loaded, capabilities          [★★ TESTED] PR 8     +- offline upgrade         [→E2E] drill
RustEngine.transaction(fn)                            gbrain migrate --to rust (PGLite)
 +- nested savepoint / abort       [★★★ TESTED] arm     +- --plan json fields      [★★ TESTED]
 +- re-entry on outer engine       [★★ TESTED] new      +- no --expect, exit 3     [★★ TESTED]
 +- writers > workers, cancel      [★★★ TESTED] new     +- roundtrip and back      [→E2E] PR 14b, PR 21
 +- disconnect with pending tasks  [★★ TESTED] PR 1     +- from Postgres           [GAP] deferred by design
write commit -> outbox apply                          search on a Rust brain
 +- SIGKILL between                [★★★ TESTED] robot   +- after own write         [★★★ TESTED] arm
 +- live failure after commit      [★★★ TESTED] new     +- paused reader, perm chg [★★★ TESTED] new
 +- replay idempotent              [★★ TESTED] new      +- E1 parity               [→EVAL] E1
schema migration on Rust store                        backup create / restore (Rust)
 +- disposition missing            [★★ TESTED] check    +- restore drill           [→E2E] PR 21b
 +- interrupted, resumable         [★★★ TESTED] new     +- above 8 GiB runbook     [→E2E] drill
fingerprint on Rust                                   remember / forget / withdraw
 +- fuzz vs PGLite SQL             [★★★ TESTED] PR 13   +- suppressed after move   [★★★ TESTED] new
test arm selection                                    CI
 +- rust label opens PGLite        [★★ TESTED] assert   +- schema-only change runs Rust lane [★★ TESTED] check
```

COVERAGE: 26 paths, 25 planned with a test, 1 GAP (Postgres to Rust, deferred by design).
QUALITY: 10 at ★★★ (behavior and edge cases), 11 at ★★, 5 routed to E2E or EVAL.

Test gaps found (before amendment):
- G1 (CRITICAL). Test arm false green: 296 `backend === 'postgres' ?` ternaries in 258 files build PGLite for any other backend. Fix: runner, helper, kind assertion, listing check.
- G2. Rust CI path filters miss schema, interface and harness changes; full-ci does not dispatch the Rust workflow.
- G3. No live failure-after-commit test.
- G4. No snapshot isolation test across a permission change.
- G5. No writer starvation, cancellation or re-entry test.
- G6. No Rust store migration upgrade test.
- G7. No fingerprint suppression test across migration with non-ASCII claims.
- G8. No early migration roundtrip.

Value cards:
- Kind assertion. Value: protects=a Rust arm that cannot pass on PGLite; fails_when=any engine opened under the Rust arm has another kind; why_new=two-way branches fall through silently today; seam=none; no_claim=Rust correctness of the file's behavior.
- Failure after commit. Value: protects=no resubmission of a committed write and no stale search; fails_when=receipt says rolled back or search uses a behind index; why_new=the plan only covered process death; seam=none; no_claim=disk-full handling in the record store itself.
- Paused reader. Value: protects=callers never read newer restricted content; fails_when=a reader at N returns N+1 content or scores; why_new=indexes and records had no shared snapshot; seam=none; no_claim=Postgres or PGLite isolation.
- Writer admission. Value: protects=bounded completion with more writers than workers; fails_when=any writer hangs past its bound or a permit leaks on cancel; why_new=transaction held across awaits on a shared pool; seam=none; no_claim=throughput targets.
- Migration upgrade. Value: protects=existing Rust stores across releases; fails_when=data lost, step not resumable, or version markers ahead of data; why_new=catalog versioning had no data path; seam=none; no_claim=Postgres migrations.
- Fingerprint suppression. Value: protects=forgotten facts stay forgotten; fails_when=an equivalent claim is accepted after a move; why_new=Rust computes the fingerprint outside SQL; seam=none; no_claim=cross-host Postgres equivalence.
- Early roundtrip. Value: protects=graduation adapter correctness before the preview; fails_when=any relation digest differs or a sequence goes below a consumed value; why_new=helpers were SQL-only; seam=none; no_claim=Postgres to Rust.
- Trigger-selection check. Value: protects=the Rust lane runs on changes that can break it; fails_when=a schema-only or capability-only diff skips the lane; why_new=filters were Rust-only; seam=none; no_claim=lane runtime.

Tests made obsolete: none. No existing test is retired; `testBackends()` keeps its current behavior when `GBRAIN_TEST_BACKEND` is unset or names a Postgres arm.

REGRESSION RULE: applied. Every change to shared files (`test-backends.ts`, `migrate.ts`, `schema-migrations/types.ts`, the graduation helpers, `full-ci.yml`, the engine unions) is gated by the existing PGLite and Postgres arms passing unchanged in the same PR, plus `test/graduation-inventory.test.ts` and `test/e2e/engine-parity.test.ts`.

Test plan artifact: kept in the reviewer's local gstack project directory (`eng-review-test-plan-20261117-015207.md`); the test plan above is the committed copy.

#### Section 4. Performance

Scale: 10k, 200k and 1M chunks given by the plan; brain-level write rates for real users unknown until C1's real-brain benchmark.
- P1. Write path: every write holds the single writer across awaits and applies the outbox before return, so the "committed writes at least 3x PGLite" target could fail on apply cost. Fix accepted: bench through `transaction(fn)` with the writer held, outbox apply included.
- P2. Memory: raw f32 at 1M chunks and 1,024 dimensions is about 3.8 GiB [estimated] before any graph; generation-ranged entries add superseded entries until reclamation, and a long reader pins them. Fix accepted: peak memory reported against the `bakeoff.md` envelope at 200k and 1M; reclamation after the oldest reader.
- P3. Targets had no named bench step. Fix accepted: one `rust/bench/` step per target printing machine, engine, size, N, p50 and p99 with PGLite on the same machine.
- N+1: the relation API and graduation adapter page in primary-key keyset order; no per-row boundary crossing on the hot paths. Caching: none added; derived indexes are the cache and are rebuildable.

#### NOT in scope

- Postgres to Rust migration (deferred; needs multi-host fencing and per-host fingerprint equivalence).
- A shared TypeScript fingerprint or versioned normalization for all engines (deferred; needs the maintainer's yes).
- Any change to PGLite or Postgres behavior; Track 2 moves SQL without changing it.
- A sidecar process binding (deferred by the CEO phase).

#### What already exists

Reused without change: the operation layer, MCP, fusion, chunkers, the persistence coordinator, the error envelope, the owner lock and IPC, `scripts/postgres-unit-arms.ts` as the runner pattern, `EXPECTED_FAILURES`, the graduation custody state machine and inventory, `binary-self-update.ts` verification, and the crash robot.

#### Failure modes registry

| Failure | Test | Handling | Silent? | Critical gap before review |
|---|---|---|---|---|
| Rust arm passes on PGLite | kind assertion | file fails | yes | CRITICAL |
| Index apply fails after commit, process alive | fault injection | receipt committed, exact path, replay | yes | CRITICAL |
| Older reader sees newer restricted content | paused reader | generation filter, backstop | yes | CRITICAL |
| Fingerprint drift un-forgets a fact | suppression test | SQL unchanged on Postgres; Rust fuzzed | yes | CRITICAL |
| Writer starvation | admission test | async permit, executor, timeout | no (hang) | gap |
| Re-entry deadlock | re-entry test | `transaction_reentry` | no (hang) | gap |
| Migration interrupted on Rust store | upgrade test | one transaction per migration | no | gap |
| Sequence reissued after migration | roundtrip | adapter keeps max consumed | yes | gap |
| Rust lane skipped on schema change | trigger check | widened filters, full-ci | yes | gap |

Critical gaps flagged: 4, all closed by accepted requirements.

#### Unresolved decisions

Unresolved decisions that may bite you later (queued for the Phase 4 final gate; the plan already makes each a Phase 1 or Phase 3 entry input):
- U1 (D11). Who lands and pins the gbrain-evals changes. Options: the maintainer lands them (least coordination); a named delegate (parallel work, needs confirmed access and ownership). Recommendation: the maintainer lands them unless a delegate is named.
- U2 (Phase 1 entry, resolved at the final gate: 8 calendar weeks or 25 merged PRs). The effort budget through Checkpoint C1. Recommendation: 8 calendar weeks or 25 merged PRs from PR 1, whichever comes first, checked at C1 [estimated].
- U3 (D10 and open question 3). The 1M benchmark corpus and spend. Recommendation: a permissively licensed public text corpus cut to 1M chunks and embedded once at 1,024 dimensions, kept as a fixture outside the repository, with a spend cap of $50 [estimated] beside the $2 LongMemEval cache.

#### TODOS

TODOS.md updates: none proposed. Per the merge process guide, deferrals go in the plan's `## Deferred` section instead of TODOS.md; this review adds two rows there.

#### Implementation Tasks

Synthesized from this review's findings. Effort assumes architecture and test work (ratios about 5x to 50x).

- [ ] **T1 (P1, human: ~3d / CC: ~3h)** Test harness: Rust arm runner, engine-for-backend helper, kind assertion, listing check
  - Surfaced by: Section 3, G1
  - Files: `scripts/rust-unit-arms.ts`, `test/helpers/test-backends.ts`, `test/rust-unit-arms.txt`
  - Verify: a listed file with a two-way branch is refused; an engine of another kind under the arm fails the file
- [ ] **T2 (P1, human: ~1w / CC: ~1d)** Store and indexes: generation-ranged entries, revision backstop, exact fallback
  - Surfaced by: Section 1, A1
  - Files: `rust/crates/gbrain-text`, `rust/crates/gbrain-vector`, `rust/crates/gbrain-store`
  - Verify: paused reader test across a content and permission update
- [ ] **T3 (P1, human: ~4d / CC: ~4h)** Store: failure-after-commit state, behind marking, idempotent replay
  - Surfaced by: Section 1, A2
  - Files: `rust/crates/gbrain-store`, `src/core/rust-engine/`
  - Verify: fault injection after commit, after text apply and before vector apply
- [ ] **T4 (P1, human: ~3d / CC: ~3h)** Binding: async writer admission, transaction executor, re-entry refusal, lifecycle
  - Surfaced by: Section 1, A5 and A6
  - Files: `rust/crates/gbrain-napi`, `src/core/rust-engine.ts`, `src/core/error-registry.ts`
  - Verify: writers far above worker count; re-entry gives `transaction_reentry`; PR 1 Bun lifecycle smoke
- [ ] **T5 (P1, human: ~1w / CC: ~1d)** Graduation: engine-neutral adapter and early roundtrip
  - Surfaced by: Section 1, A3
  - Files: `src/core/persistence/graduation-digest.ts`, `graduation-copy.ts`, `graduation-verify.ts`, `src/core/rust-engine/`
  - Verify: PGLite to Rust to PGLite roundtrip with consumed sequences, generated columns, withdrawals
- [ ] **T6 (P1, human: ~4d / CC: ~4h)** Migrations: Rust disposition, dispatch, ordering, missing-disposition check
  - Surfaced by: Section 1, A4
  - Files: `src/core/schema-migrations/types.ts`, `src/core/migrate.ts`, `rust/crates/gbrain-store`
  - Verify: upgrade a previous-release Rust store with legacy rows, interrupting each boundary
- [ ] **T7 (P1, human: ~2d / CC: ~2h)** Facts: Rust fingerprint fuzzed against PGLite SQL; suppression test
  - Surfaced by: Section 1, A9
  - Files: `rust/crates/gbrain-domain`, `rust/fixtures/`
  - Verify: withdrawals before a move suppress equivalent non-ASCII claims after it
- [ ] **T8 (P2, human: ~1d / CC: ~1h)** Engine shell: `members.ts` table; coverage derived from it
  - Surfaced by: Section 2, Q1
  - Files: `src/core/rust-engine/members.ts`, `scripts/check-rust-capability-coverage.ts`
  - Verify: adding an interface member fails `bun run typecheck` until classified
- [ ] **T9 (P2, human: ~1d / CC: ~1h)** Engine unions and constructor message
  - Surfaced by: Section 2, Q2
  - Files: `src/core/engine.ts`, `src/core/engine-construct.ts`, `src/core/config.ts`, `src/commands/migrate-engine.ts`, `src/core/context/resolve-ipc.ts`, `src/core/persistence/graduation-inventory.ts`
  - Verify: an inventory row without `rust` fails typecheck
- [ ] **T10 (P2, human: ~1d / CC: ~1h)** Owner model: config-level `engineIsSingleOwner`
  - Surfaced by: Section 1, A7
  - Files: `src/core/context/resolve-ipc.ts`, `src/core/persistence/graduation-serve-guard.ts`
  - Verify: owner socket and secret paths resolve for a Rust config
- [ ] **T11 (P2, human: ~1d / CC: ~1h)** CI: widened filters, full-ci dispatch, trigger-selection check
  - Surfaced by: Section 3, G2
  - Files: `.github/workflows/rust-engine.yml`, `.github/workflows/full-ci.yml`
  - Verify: a schema-only diff selects the Rust lane
- [ ] **T12 (P2, human: ~2d / CC: ~2h)** Backup: Rust snapshot at one committed generation
  - Surfaced by: Section 1, A8
  - Files: `src/core/backup/`, `src/commands/backup.ts`
  - Verify: full-store restore drill with equal relation digests
- [ ] **T13 (P2, human: ~2d / CC: ~2h)** Bench: named step per target, held-writer write bench, memory against envelope
  - Surfaced by: Section 4, P1 to P3
  - Files: `rust/bench/`, `docs/designs/rust-engine/bakeoff.md`
  - Verify: each step prints machine, engine, size, N, p50 and p99 beside PGLite
- [ ] **T14 (P3, human: ~1h / CC: ~10min)** Docs: non-SQL note in "Adding a new engine"
  - Surfaced by: Section 2, Q3
  - Files: `docs/ENGINES.md`
  - Verify: docs review in PR 8

#### Worktree parallelization

| Lane | Tasks | Modules | Depends on |
|---|---|---|---|
| A | T11 then T4 smoke | `.github/`, `rust/crates/gbrain-napi` | none (PR 1) |
| B | T8, T9, T14 | `src/core/engine*`, `src/core/rust-engine/` | PR 1 |
| C | T1 | `test/helpers/`, `scripts/` | Lane B |
| D | T13 | `rust/bench/` | PR 1 |
| E | T2, T3, T4 rest | `rust/crates/` | Phase 2 bake-off |
| F | T5, T6 | `src/core/persistence/graduation-*`, `src/core/migrate.ts` | Lane E |
| G | T7, T10, T12 | facts crate, `resolve-ipc.ts`, `src/core/backup/` | Lane E |

Execution order: launch A alone (toolchain first). Then B and D in parallel. Then C. After the bake-off, E; then F and G in parallel. Conflict flags: `src/core/engine.ts` (B, F through domain objects), `src/core/rust-engine/` (B, E, F); sequence through the merge process with heads-up comments. 7 lanes, 4 parallel, 3 sequential.

#### Completion summary

- Step 0: Scope Challenge: scope accepted as-is
- Reality rows: 15/15 applicable rows emitted (`PLAN_REALITY: phase=eng rows=15/15 missing=none unverified=0 verdict=complete`), 0 unverified premises
- Architecture Review: 9 issues found
- Code Quality Review: 3 issues found
- Test Review: diagram produced, 8 gaps identified
- Performance Review: 3 issues found
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 0 items proposed to user (deferrals in the plan's `## Deferred`)
- Failure modes: 4 critical gaps flagged
- Unresolved decisions: 3 in this review
- Outside voice: codex, unavailable (not installed)
- Parallelization: 7 lanes, 4 parallel / 3 sequential
- Lake Score: 9/9 (every accepted fix chose the complete option)

#### Taste decisions

- Snapshot contract by generation-ranged index entries with a revision backstop. Alternative: validate candidates against records and retry only, which uses less memory but can miss items whose index entry was replaced.
- Postgres to Rust migration deferred. Alternative: design multi-host source fencing now, which grows the preview for a cohort it does not target.
- Re-entry refused as `internal_error` reason `transaction_reentry` under D2. Alternatives: route outer-engine calls into the open transaction (hides bugs), or a new top-level code (one more registry row and doc anchor).
- Graduation adapter as its own PR 14b in Phase 5 with an early roundtrip. Alternative: build it inside PR 21, which finds adapter bugs only at the preview.
- Fingerprints stay in SQL on PGLite and Postgres. Alternative: a versioned v2 normalization for all engines now, which needs legacy matching and the maintainer's yes.
- Original arrangement kept at the complexity gate. Alternative: the smaller accelerator-only arrangement (option B).

USER CHALLENGES: None. Every accepted change keeps the user's direction: a third engine, embedded Rust replacements, PGLite deprecation later, work in garrytan/gbrain with gbrain-evals in the plan.

<!-- autoplan-baseline-edits:eng {"sourceSha256":"b73350256550439287bd9b01e84fb19f6d3e882f229405ad0f36a5cb745cb55e","replacements":[{"oldText":"- `transaction(fn)` keeps its shape: the wrapper opens a Rust write transaction handle and passes `fn` a transaction-bound clone of the engine, the same pattern `PostgresEngine` uses. Nested calls map to savepoints, an abort rolls back, `readOnly` refuses writes (`research/01` section 6). `AbortSignal` maps to a cancellation token checked between steps.","newText":"- `transaction(fn)` keeps its shape: the wrapper opens a Rust write transaction handle and passes `fn` a transaction-bound clone of the engine, the same pattern `PostgresEngine` uses. Nested calls map to savepoints, an abort rolls back, `readOnly` refuses writes (`research/01` section 6). `AbortSignal` maps to a cancellation token checked between steps.\n- Writer admission is starvation free. A caller waits for the single-writer permit asynchronously, on the JavaScript side, before it uses any worker thread. An open write transaction runs its commands on its own transaction executor, so the worker pool size never decides whether the transaction that holds the writer can finish. The wait is bounded by the caller's `AbortSignal` or deadline and ends with the existing `cancelled` or `timeout` code; a cancelled waiter leaves no permit or queued task behind.\n- Re-entry is refused. A call on the outer engine from inside its own `transaction(fn)` would wait forever for the writer it already holds. The wrapper detects it and throws `internal_error` with reason `transaction_reentry` (added to decision D2) instead of hanging. `lockPageKeys` maps to a per-key async mutex held until the transaction ends.\n- Lifecycle. `disconnect()` and the resident-consumer stop barrier stop admission, cancel queued tasks, wait a bounded time for running tasks, and then close the store. A task cancelled after it started reports what it committed through the receipt. PR 1 proves the Bun behavior this needs before any engine code: shutdown with pending tasks, cancellation after start, process exit with pending native work, and a threadsafe-function queue that is full or closing."},{"oldText":"- One commit point. A write commits records, counters and outbox entries in one store transaction, then applies the outbox to the text and vector indexes before the call returns. A search issued after a write returns sees it, as today. If the process dies between commit and apply, the open catches the indexes up before serving reads. Search re-checks deleted, withdrawn and visibility state against the record snapshot before returning.","newText":"- One commit point. A write commits records, counters and outbox entries in one store transaction, then applies the outbox to the text and vector indexes, in generation order, before the call returns. A search issued after a write returns sees it, as today. If the process dies between commit and apply, the open catches the indexes up before serving reads.\n- Snapshot contract for search. Every search pins one record snapshot generation N. Text postings and vector entries carry the generation range in which they are valid, and the search uses only entries valid at N, so a reader at N never sees content, scores or permissions from N+1. Superseded entries are reclaimed only after the oldest open reader has passed their generation. As a backstop, each candidate's indexed revision is checked against the record at N, and deleted, withdrawn and visibility state is re-checked there before ranking; a mismatch drops the candidate and the search continues with the exact path for that arm, reporting the existing `vector_candidates_incomplete` reason when it cannot fill the page.\n- Failure after commit. If applying the outbox fails while the process stays alive (disk full, an index error, cancellation), the write is still committed: the call reports it as committed through its receipt and never as rolled back. The relation is marked behind at that generation; searches that touch it use the exact path for the affected arm until replay succeeds; replay retries in generation order and is idempotent; `gbrain engine status` and doctor report the lag."},{"oldText":"Keeping Postgres relation names and columns makes the graduation inventory, digests and verification reusable as they are.","newText":"Keeping Postgres relation names and columns lets the graduation inventory, digests and verification be reused through an engine-neutral adapter (\"Migration and rollback\"); the current helpers issue catalog and sequence SQL and cannot run on Rust unchanged."},{"oldText":"- Those paths branch on `engine.kind === 'pglite'` today. Track 1 replaces those branches with one capability, `single_owner`, which PGLite and Rust report, so the Rust engine reuses the code instead of copying it.","newText":"- Those paths branch on `engine.kind === 'pglite'` today. Track 1 replaces those branches with one capability, `single_owner`, which PGLite and Rust report, so the Rust engine reuses the code instead of copying it. Some of these checks run on the config before any engine exists (`src/core/context/resolve-ipc.ts` keys the owner socket and secret on `cfg.engine === 'pglite'`; `src/core/persistence/graduation-serve-guard.ts` does the same), so a config-level helper, `engineIsSingleOwner(cfg.engine)`, answers the same question there, and both forms are covered by the kind-branch guard."},{"oldText":"`constructEngine` (`src/core/engine-construct.ts`) gains a `rust` case. `BrainEngine.kind` (`src/core/engine.ts:832`) gains `'rust'`.","newText":"`constructEngine` (`src/core/engine-construct.ts`) gains a `rust` case and its unsupported-engine message names all three engines. `BrainEngine.kind` (`src/core/engine.ts:832`) gains `'rust'`, and so does every other `'postgres' | 'pglite'` engine union (the config type in `src/core/config.ts`, `targetEngine` in `src/commands/migrate-engine.ts`, the config shape in `src/core/context/resolve-ipc.ts`). The graduation inventory's `engines` record becomes `{ pglite, postgres, rust }` with no default for `rust`, so a row that does not say how Rust stores it fails to compile."},{"oldText":"- `check:rust-capability-coverage` prints the share of operations, commands, phases and handlers available on Rust. It is the progress number and the first PGLite-deprecation criterion.","newText":"- Every `BrainEngine` member is classified in `src/core/rust-engine/members.ts`, a table typed `satisfies Record<keyof BrainEngine, 'implemented' | Capability>`. A new interface member fails to compile until it is classified, so the list cannot drift by hand. A member not yet implemented throws `engine_capability_missing` naming its capability.\n- `check:rust-capability-coverage` prints the share of operations, commands, phases and handlers available on Rust. It is the progress number and the first PGLite-deprecation criterion. It is derived from the member table and the dispatch table, not kept as a separate list."},{"oldText":"Migration carries stored fingerprints verbatim. Track 2 moves the computation into one TypeScript function proven equal to PGLite's SQL on a fuzz corpus that includes non-ASCII text, and every engine stores the passed value.","newText":"Migration carries stored fingerprints verbatim. PGLite and Postgres keep computing it in SQL, unchanged, because existing Postgres fingerprints depend on that host's `lower()` and whitespace classes. The Rust engine computes `gbrain_fact_fingerprint` and `gbrain_fact_fingerprint_v1` in its own code, fuzzed against PGLite's SQL on a corpus with non-ASCII text, mixed case and every whitespace class. Moving the computation out of SQL for all engines, or a versioned normalization, is a separate change that needs the maintainer's yes."},{"oldText":"790 of the 831 files that call `testBackends()`","newText":"790 of the 830 files that call `testBackends()` (re-measured at 9f1d54232d)"},{"oldText":"Exit: the CI lane is green; a trivial addon loads in Bun 1.4.4 and in a `bun build --compile` executable through `process.dlopen`; async tasks, typed arrays and panic-to-error work in Bun;","newText":"Exit: the CI lane is green; a trivial addon loads in Bun 1.4.4 and in a `bun build --compile` executable through `process.dlopen`; async tasks, typed arrays and panic-to-error work in Bun; shutdown with pending tasks, cancellation after start, process exit with pending native work and a full or closing threadsafe-function queue behave as the lifecycle rules above require;"},{"oldText":"Work: PRs 10 to 14 implement","newText":"Work: PRs 10 to 14b implement"},{"oldText":"Exit: the domain tests, `test/e2e/engine-parity.test.ts` cases for those domains and the trigger parity matrix pass on the Rust arm.","newText":"Exit: the domain tests, `test/e2e/engine-parity.test.ts` cases for those domains and the trigger parity matrix pass on the Rust arm; a small PGLite to Rust to PGLite roundtrip through the graduation adapter verifies exactly on the domains implemented so far, including consumed but unused sequence values, generated columns, withdrawals and database-only content."},{"oldText":"`.github/workflows/rust-engine.yml` (path-filtered to `rust/**` and `src/core/rust-engine*`;","newText":"`.github/workflows/rust-engine.yml` (path-filtered to `rust/**`, `src/core/rust-engine*`, `src/core/engine.ts`, `src/core/engine-*.ts`, `src/core/engine-sql/**`, `src/schema.sql`, `src/core/migrate.ts`, `src/core/schema-migrations/**`, `src/core/persistence/graduation-*.ts`, `test/helpers/test-backends.ts`, `test/rust-unit-arms.txt`, `scripts/rust-unit-arms.ts` and the workflow itself;"},{"oldText":"| 8 | Rust engine shell, refusing everything with typed errors | `src/core/rust-engine.ts`, `src/core/rust-engine/`, `engine-construct.ts`, `kind` union, config value,","newText":"| 8 | Rust engine shell, refusing everything with typed errors | `src/core/rust-engine.ts`, `src/core/rust-engine/` (including `members.ts`), `engine-construct.ts`, `kind` union and every other two-engine union, inventory `engines.rust` type, config value, `docs/ENGINES.md` \"Adding a new engine\" note that a non-SQL engine implements typed methods instead of a `SqlExecutor`,"},{"oldText":"| 9 | Rust test arm | `test/helpers/test-backends.ts` (`GBRAIN_TEST_BACKEND=rust` selects the arm for files in `test/rust-unit-arms.txt`; never implicit), `rust-engine.yml` job | test harness, `.github/` | none |","newText":"| 9 | Rust test arm | `test/helpers/test-backends.ts` (`GBRAIN_TEST_BACKEND=rust` selects the arm for files in `test/rust-unit-arms.txt`; never implicit), `scripts/rust-unit-arms.ts`, an exhaustive engine-for-backend test helper and the Rust-kind assertion, `rust-engine.yml` job, `.github/workflows/full-ci.yml` dispatching `rust-engine.yml` only when the same path filter matches (estimate: about 10 minutes per OS for a cold addon build and 3 minutes with the cache, on two OSes in parallel; PR 1 reports the measured time), a trigger-selection check | test harness, `.github/` | none |"},{"oldText":"| 14 | Segmented page bodies, salience, health, titles | `gbrain-domain` | none | none |","newText":"| 14 | Segmented page bodies, salience, health, titles | `gbrain-domain` | none | none |\n| 14b | Engine-neutral graduation adapter and an early PGLite to Rust to PGLite roundtrip on the domains so far | `src/core/persistence/graduation-*.ts` (catalog inspection, canonical rows, counters, fencing and verification through the adapter), `src/core/rust-engine/` | `persistence/` | none |"},{"oldText":"| 19 | Store format version, index lag and rebuild checks | `gbrain-store`, doctor checks | doctor goldens | D2 |","newText":"| 19 | Store format version, schema migration dispatch for Rust stores, index lag and rebuild checks | `gbrain-store`, `src/core/migrate.ts` and `src/core/schema-migrations/types.ts` (Rust disposition per migration), doctor checks | doctor goldens, `migrate.ts` | D2, D7 |"},{"oldText":"| 21 | `gbrain migrate --to rust` and back | graduation copier target side, inventory `engines.rust`, `src/commands/migrate-engine.ts` | none | D1 |","newText":"| 21 | `gbrain migrate --to rust` and back, PGLite brains only | the graduation adapter from PR 14b on both directions, inventory `engines.rust` rows, `src/commands/migrate-engine.ts` | none | D1 |"},{"oldText":"| 21b | `gbrain backup create` and `backup restore` for Rust brains, with a full-store restore drill | `src/core/backup/`, `src/commands/backup.ts` | none | D1 |","newText":"| 21b | `gbrain backup create` and `backup restore` for Rust brains, with a full-store restore drill | `src/core/backup/` (a Rust snapshot taken under the owner lock at one committed generation, with derived indexes carried with their generation or rebuilt; the PGLite snapshot path unchanged), `src/commands/backup.ts` | none | D1 |"},{"oldText":"- A Rust cell joins `scale-tier.yml`. Benchmarks report; CI gates on relative regressions.","newText":"- Each target has a named step in `rust/bench/` that prints machine, engine, data size, N, p50 and p99, with PGLite measured on the same machine in the same run. Write throughput is measured through `transaction(fn)` with the writer held across awaits and includes the outbox apply before return. Peak resident memory at 200k and 1M chunks is reported against the memory envelope in `bakeoff.md` (f32 vectors at 1M chunks and 1,024 dimensions are about 3.8 GiB raw before any graph).\n- A Rust cell joins `scale-tier.yml`. Benchmarks report; CI gates on relative regressions."},{"oldText":"- Crash: SIGKILL between record commit and index apply, during import, during migration copy and during index rebuild; the open recovers, index lag returns to zero, and a deleted or withdrawn item is never returned.","newText":"- Crash: SIGKILL between record commit and index apply, during import, during migration copy and during index rebuild; the open recovers, index lag returns to zero, and a deleted or withdrawn item is never returned.\n- Failure after commit without a crash: inject a failure after the record commit, after the text apply and before the vector apply while the owner stays alive; the receipt says committed, later reads are correct, replay brings the lag to zero, and a retried write is idempotent.\n- Snapshot isolation: pause a search across a concurrent content and permission update; the paused reader returns correct results for its snapshot and never newer restricted content.\n- Writer admission: start far more concurrent writers than worker threads while the first transaction awaits and then makes another engine call; all finish or time out within the bound, a cancelled waiter leaves nothing behind, re-entry gives `transaction_reentry`, and `disconnect()` finishes cleanly.\n- Fingerprints: create withdrawals and purges before a change, then insert equivalent non-ASCII and mixed-case claims on Rust after migration; they stay suppressed."},{"oldText":"- `testBackends()` (`test/helpers/test-backends.ts:15`) gains a `rust` backend selected only by `GBRAIN_TEST_BACKEND=rust` and only for files listed in `test/rust-unit-arms.txt`. Default developer runs are unchanged and need no Rust toolchain. Selecting `rust` without a loadable addon fails loudly, as `requirePostgresTestDatabase` does for Postgres.","newText":"- `testBackends()` (`test/helpers/test-backends.ts:15`) gains a `rust` backend selected only by `GBRAIN_TEST_BACKEND=rust` and only for files listed in `test/rust-unit-arms.txt`. Default developer runs are unchanged and need no Rust toolchain. Selecting `rust` without a loadable addon fails loudly, as `requirePostgresTestDatabase` does for Postgres.\n- Most test files choose their engine with a two-way branch such as `backend === 'postgres' ? requirePostgresTestDatabase() : undefined`, which would build a PGLite brain under a `[rust]` label and pass. So the arm is selected by a runner, `scripts/rust-unit-arms.ts`, modeled on `scripts/postgres-unit-arms.ts`, which runs only the listed files with `GBRAIN_TEST_BACKEND=rust`; an exhaustive engine-for-backend helper replaces the two-way branch in a file before it is listed; and every engine opened under the Rust arm must report `kind === 'rust'`, or the file fails. A check refuses a listed file that still has a two-way backend branch."},{"oldText":"- The source side reads through the existing engine, so PGLite and Postgres brains can both move. The target side writes through the Rust `importRelation` batch API in primary-key keyset order. Derived indexes build after the copy; embeddings are carried, never re-embedded.","newText":"- The graduation helpers issue SQL on both sides today (catalog columns in `graduation-digest.ts`, sequence positions in `graduation-copy.ts`, metadata, counts and sequences in `graduation-verify.ts`). An engine-neutral graduation adapter keeps the custody state machine and replaces those assumptions: catalog inspection, canonical row export, counter and sequence transfer (never below a consumed value), fencing, import and verification, implemented for PGLite and Rust (PR 14b).\n- The preview moves PGLite brains to Rust and back. The target side writes through the Rust `importRelation` batch API in primary-key keyset order. Derived indexes build after the copy; embeddings are carried, never re-embedded. Postgres to Rust is deferred until multi-host source fencing and per-host fingerprint equivalence are designed."},{"oldText":"- The inventory gains an `engines.rust` column. A migration that adds a relation already fails `test/graduation-inventory.test.ts` until it has a row; after the preview it must also say how Rust stores it (decision D7).","newText":"- The inventory gains an `engines.rust` column. A migration that adds a relation already fails `test/graduation-inventory.test.ts` until it has a row; after the preview it must also say how Rust stores it (decision D7).\n- Schema migrations on Rust stores. Each `Migration` (`src/core/schema-migrations/types.ts`) gains a Rust disposition: `catalog_only` (an additive change the catalog absorbs), `postgres_only` (an explicit no-op with its reason), or a Rust handler with its own verify through typed methods or the relation API. The runner in `src/core/migrate.ts` dispatches on it, since the SQL path and SQL-issuing handlers cannot run on Rust. Per migration, the catalog change, the data handler and the version ledger row commit in one store transaction; `FORMAT` is then rewritten by atomic rename, and an open that finds `FORMAT` behind the records repairs it from the records. A check fails a migration above the Rust baseline that has no disposition. Before PR 19, a catalog mismatch is refused by the loader and development stores are rebuilt."},{"oldText":"- **D7. Schema change policy after the preview.** A migration that adds or changes a relation also adds its Rust catalog and inventory entries in the same PR;","newText":"- **D7. Schema change policy after the preview.** A migration that adds or changes a relation also adds its Rust catalog and inventory entries and its Rust disposition (`catalog_only`, `postgres_only` or a Rust handler with verify) in the same PR;"},{"oldText":"- A `gbrain engine remove rust` command: removing an addon by hand is enough for the preview.","newText":"- A `gbrain engine remove rust` command: removing an addon by hand is enough for the preview.\n- `gbrain migrate --to rust` from a Postgres brain: it needs multi-host source fencing and per-host fingerprint equivalence; the preview cohort is PGLite users.\n- Moving fact fingerprint computation out of SQL for all engines, or a versioned normalization: it can change Postgres behavior, so it needs its own change and the maintainer's yes."},{"oldText":"and `newer_format`, `unreadable` and `upgrade_failed` (`engine_store_format_unsupported`).","newText":"and `newer_format`, `unreadable` and `upgrade_failed` (`engine_store_format_unsupported`). Eng review added the reason `transaction_reentry` on the existing `internal_error` code (PR 8)."}]} -->

<!-- autoplan-accepted:eng -->
- Writer admission and re-entry: a caller waits for the single-writer permit asynchronously before it uses a worker thread; an open write transaction runs its commands on its own transaction executor; the wait is bounded by `AbortSignal` or deadline and ends with the existing `cancelled` or `timeout` code with no permit or task left behind; a call on the outer engine inside its own `transaction(fn)` throws `internal_error` reason `transaction_reentry` (added to D2); `lockPageKeys` is a per-key async mutex held until the transaction ends. Verify: start far more concurrent writers than worker threads while the first transaction awaits and then makes another engine call; all finish or time out within the bound, cancelled waiters leave nothing behind, re-entry gives `transaction_reentry`, and `disconnect()` finishes cleanly.
- Lifecycle: `disconnect()` and the resident-consumer stop barrier stop admission, cancel queued tasks, wait a bounded time for running tasks and then close the store; a task cancelled after it started reports what it committed through the receipt. Verify: PR 1's Bun smoke covers shutdown with pending tasks, cancellation after start, process exit with pending native work, and a full or closing threadsafe-function queue, in Bun 1.4.4 and in a compiled executable.
- Snapshot contract: every search pins one record snapshot generation; text postings and vector entries carry the generation range in which they are valid and the search uses only entries valid at its generation; superseded entries are reclaimed after the oldest reader passes them; each candidate's indexed revision and its deleted, withdrawn and visibility state are checked against the record snapshot, and a mismatch drops it and uses the exact path for that arm, keeping the `vector_candidates_incomplete` reason. Verify: pause a search across a concurrent content and permission update; the paused reader returns correct results for its snapshot and never newer restricted content.
- Failure after commit: if the outbox apply fails while the process stays alive, the call reports the write as committed through its receipt, never as rolled back; the relation is marked behind; searches that touch it use the exact path until replay succeeds; replay runs in generation order and is idempotent; `gbrain engine status` and doctor report the lag. Verify: inject failures after the record commit, after the text apply and before the vector apply with the owner alive; check the receipt, later reads, replay to zero lag and an idempotent retry.
- Graduation adapter (PR 14b): an engine-neutral adapter under the custody state machine provides catalog inspection, canonical row export, counter and sequence transfer never below a consumed value, fencing, import and verification for PGLite and Rust; `migrate --to rust` and back cover PGLite brains only; Postgres to Rust is deferred. Verify: a PGLite to Rust to PGLite roundtrip at the Phase 5 exit verifies exactly on the domains so far, including consumed but unused sequence values, generated columns, withdrawals and database-only content.
- Schema migrations on Rust stores (PR 19, D7): each `Migration` carries a Rust disposition (`catalog_only`, `postgres_only` with a reason, or a Rust handler with its own verify); `src/core/migrate.ts` dispatches on it; per migration the catalog change, data handler and version ledger row commit in one store transaction, `FORMAT` is then rewritten by atomic rename and repaired from the records when behind; a check fails a migration above the Rust baseline with no disposition; before PR 19 the loader refuses a catalog mismatch. Verify: upgrade a previous-release Rust store containing legacy rows, interrupt each migration boundary, and check resumability, preserved data and truthful version markers.
- Fingerprints: PGLite and Postgres keep computing `gbrain_fact_fingerprint` and `_v1` in SQL, unchanged; the Rust engine computes both in its own code fuzzed against PGLite's SQL on non-ASCII, mixed-case and whitespace-class input; a shared or versioned change is deferred and needs the maintainer's yes. Verify: create withdrawals and purges, migrate to Rust, insert equivalent non-ASCII and mixed-case claims; they stay suppressed.
- Test arm: the Rust arm is selected by `scripts/rust-unit-arms.ts`, modeled on `scripts/postgres-unit-arms.ts`, running only files in `test/rust-unit-arms.txt` with `GBRAIN_TEST_BACKEND=rust`; an exhaustive engine-for-backend helper replaces two-way backend branches before a file is listed; every engine opened under the arm must report `kind === 'rust'`. Verify: a listed file that still has a two-way backend branch is refused by the listing check, and a file that opens an engine of another kind under the arm fails.
- CI coverage: `rust-engine.yml` path filters include the Rust tree, the engine interface and engine-sql files, `src/schema.sql`, `src/core/migrate.ts`, `src/core/schema-migrations/`, the graduation helpers, the test-arm harness and list, and the workflow itself; `full-ci.yml` dispatches `rust-engine.yml` on the final head. Verify: a trigger-selection check shows that a schema-only change and a capability-only change select the Rust lane.
- Member coverage: `src/core/rust-engine/members.ts` classifies every `BrainEngine` member with `satisfies Record<keyof BrainEngine, 'implemented' | Capability>`; an unimplemented member throws `engine_capability_missing` naming its capability; `check:rust-capability-coverage` derives from this table and the dispatch table. Verify: adding an interface member without a row fails `bun run typecheck`.
- Engine unions: every `'postgres' | 'pglite'` engine union (kind, config type, `migrate-engine.ts` target, `resolve-ipc.ts` config shape) gains `rust`; the constructor's unsupported-engine message names all three; the inventory `engines` record is `{ pglite, postgres, rust }` with no default for `rust`. Verify: an inventory row without `rust` fails typecheck, and the constructor message test lists three engines.
- Config-level owner check: `engineIsSingleOwner(cfg.engine)` answers the single-owner question where only config exists (owner socket and secret in `resolve-ipc.ts`, `graduation-serve-guard.ts`), and the kind-branch guard covers both forms. Verify: owner socket and secret paths resolve for a Rust config the same way as for PGLite.
- Rust backup (PR 21b): the snapshot is taken under the owner lock at one committed generation, with derived indexes carried with their generation or rebuilt on restore; the PGLite snapshot path is unchanged. Verify: the full-store restore drill gives equal relation digests and zero index lag after restore.
- Performance proof: each target has a named `rust/bench/` step printing machine, engine, data size, N, p50 and p99 beside PGLite on the same machine; write throughput is measured through `transaction(fn)` with the writer held across awaits and the outbox apply included; peak memory at 200k and 1M chunks is reported against the `bakeoff.md` envelope. Verify: the bake-off report shows each step's output for both preview targets.
- Docs: `docs/ENGINES.md` "Adding a new engine" gains a note that a non-SQL engine implements typed methods instead of a `SqlExecutor` (PR 8). Verify: PR 8 review.
- Numbers: the test count reads 790 of the 830 files that call `testBackends()`, re-measured at 9f1d54232d, and is re-measured again before the gate.
- Deferred, in the plan's `## Deferred` section: Postgres to Rust migration, and moving fact fingerprint computation out of SQL for all engines.
<!-- /autoplan-accepted:eng -->

## Decision Audit Trail

<!-- AUTONOMOUS DECISION LOG -->

| # | Phase | Decision | Class | Principle | Rationale | Rejected |
|---|---|---|---|---|---|---|
| 1 | CEO | Keep option A | Mechanical | P6 | Binding user direction; B changes existing engines | Option B first |
| 2 | CEO | Addon identity, digest manifest, staged upgrade | Mechanical | P1 | Same-ABI drift and offline upgrade were unhandled | ABI-only check |
| 3 | CEO | PR 21b backup and restore, restore drill | Mechanical | P1 | Backup refuses non-PGLite; rollback needs a readable store | Rely on `migrate --to pglite` |
| 4 | CEO | Checkpoint C1 gates broad Track 2 | Taste | P3 | Time to value needs a stop point with data | T-PRs after PR 6 |
| 5 | CEO | D12 preview on two targets | Taste | P3 | Smallest preview that is safe to recover | Broader preview |
| 6 | CEO | D11 gbrain-evals landing and pin; Phase 6 needs Phase 3 | Mechanical | P1 | E1 depends on gbrain-evals | Leave owner open |
| 7 | CEO | Idiomatic-SQLite slice in bake-off | Taste | P1 | Missing alternative | KV-only comparison |
| 8 | CEO | LanceDB in bake-off | Mechanical | P2 | Off-the-shelf filtered ANN | usearch only |
| 9 | CEO | Correct crash-isolation text | Mechanical | P5 | `catch_unwind` covers panics only | Keep claim |
| 10 | CEO | Deprecation criteria 11 and 12 | Mechanical | P1 | PGLite-only surfaces exist | Criteria 1 to 10 only |
| 11 | CEO | Track 2 coordination protocol | Mechanical | P1 | Shared-file churn and size ceiling | No protocol |
| 12 | CEO | Re-measured numbers | Mechanical | P5 | Figures were from an older commit | Old figures |
| 13 | CEO | In-tree `gbrain eval` primary, gbrain-evals secondary | Mechanical | P4 | Fewer moving parts for gates | stdio protocol now |
| 14 | CEO | Do not hand Track 2 to other contributors | Mechanical | P6 | The merge process does not write code | Hand off |
| 15 | CEO | Skip Phase 2 (Design) | Mechanical | P5 | Heuristic false positive; no UI | Run design review |
| 16 | DX | Error contract subsection: fix per reason, detail context, registry rows, test per row | Mechanical | P1 | Five CAP6 paths had no actionable fix or context | Generic install fix for every reason |
| 17 | DX | Panic hook, private diagnostic file and id, rollback and reopen | Mechanical | P1 | Default hook prints to stderr; no trace or outcome | `catch_unwind` alone |
| 18 | DX | Doctor maintenance path when normal open fails | Mechanical | P1 | Doctor could not reach a broken store | Rely on restore only |
| 19 | DX | Override skips only the digest pin | Mechanical | P5 | Stale local builds slipped past ABI and format checks (revises CEO text) | Override skips every check |
| 20 | DX | `migrate --to rust` graduation modes, full plan contents, never prompts | Mechanical | P5 | First run had a lock refusal, possible prompt, no estimate | Implicit modes |
| 21 | DX | Capability report in the plan and `engine status --json` | Mechanical | P1 | Capability discovery was contributor-only | New MCP operation |
| 22 | DX | Timed search in the migrate run report | Taste | P1 | Shows the win on the user's own brain | Tell users to run `gbrain diag --json` |
| 23 | DX | `engine install rust` idempotent, `--json`, failure states, pruning | Mechanical | P1 | Failure states and repeat runs unspecified | Leave to implementation |
| 24 | DX | `engine install rust --from <file>` | Taste | P3 | Offline machines need a verified path | Manual cache population |
| 25 | DX | PR 23 tested quickstart, capability list, troubleshooting rows, agent rule, reporting route | Mechanical | P1 | Docs listed destinations only | Write docs at the end without content rules |
| 26 | DX | `rust/README.md` and `bun run rust:build` in PR 1 | Mechanical | P1 | No contributor build-to-test path | Cargo instructions only |
| 27 | DX | TTHW target 5 min, measured by a drill | Taste | P3 | Competitive tier fits a copy plus index build | Under 2 min, or no number |
| 28 | DX | Rust layout in the physical-copy runbook and a drill above 8 GiB | Mechanical | P1 | Backup cap is real (`archive.ts:11`) | Raise the cap |
| 29 | DX | `preview-log.md` for criterion 9 | Mechanical | P5 | Dogfood had no record | Unrecorded dogfood |
| 30 | DX | Keep the shared `Fix:` placement; defer the move | Taste | P5 | A move changes every command | Rust-only renderer |
| 31 | DX | Defer issue template and `engine remove rust` | Mechanical | P3 | Touches `.github/`; deleting the directory suffices | Add in PR 23 |
| 32 | Eng | Keep the original arrangement at the complexity gate | Taste | P6 | Smaller shape is option B, ruled out by the user direction | Accelerator-only arrangement |
| 33 | Eng | Snapshot contract: generation-ranged index entries, revision backstop, exact fallback | Taste | P1 | Older readers could see newer restricted content | Validate and retry only |
| 34 | Eng | Failure after commit: committed receipt, relation behind, exact path, idempotent replay | Mechanical | P1 | Live index failure had no contract | Report as a transaction failure |
| 35 | Eng | Graduation adapter in PR 14b with an early roundtrip; PGLite brains only | Taste | P3 | Helpers issue catalog and sequence SQL | Build inside PR 21 |
| 36 | Eng | Rust disposition per migration, one store transaction, FORMAT repaired from records | Mechanical | P1 | Catalog versioning had no data path | Catalog version only |
| 37 | Eng | Fingerprints stay in SQL on PGLite and Postgres; Rust fuzzed against PGLite | Taste | P5 | A shared function could change Postgres | Shared TypeScript function now |
| 38 | Eng | Async writer admission, transaction executor, `transaction_reentry` under D2 | Mechanical | P1 | Pool starvation and re-entry deadlock | Synchronous lock wait on workers |
| 39 | Eng | Bun lifecycle cases in PR 1; drain order on disconnect | Mechanical | P1 | napi-rs on Bun is best effort | Prove later |
| 40 | Eng | Config-level `engineIsSingleOwner` | Mechanical | P1 | Owner paths key on config before an engine exists | Engine capability only |
| 41 | Eng | Rust backup at one committed generation under the owner lock | Mechanical | P1 | PGLite physical snapshot does not apply | Reuse snapshot.ts |
| 42 | Eng | Runner-selected Rust arm, engine-for-backend helper, kind assertion, listing check | Mechanical | P1 | Two-way branches build PGLite under a rust label | Env value in testBackends only |
| 43 | Eng | Widened Rust CI filters, full-ci dispatch, trigger-selection check | Mechanical | P1 | full-ci dispatches test.yml and e2e.yml only | Rust-only filters |
| 44 | Eng | `members.ts` classifies every BrainEngine member; coverage derived | Mechanical | P5 | Hand-synced list drifts | Separate coverage list |
| 45 | Eng | All engine unions gain rust; inventory rust key has no default | Mechanical | P5 | Several two-engine unions | Kind union only |
| 46 | Eng | Named bench step per target; held-writer write bench; memory against envelope | Mechanical | P1 | Targets had no bench step | Targets without steps |
| 47 | Eng | Non-SQL note in ENGINES.md "Adding a new engine" | Mechanical | P5 | Step 3 assumes a SqlExecutor | Leave the doc |
| 48 | Eng | Queue gbrain-evals owner, C1 effort cap and corpus spend for the final gate | Mechanical | P6 | User decisions; not invented | Default them silently |
| 49 | CEO | Shadow mode is the recommended route for existing brains; swap only on READY | User | P6 | The maintainer asked for it | Direct migrate only |
| 50 | DX | Route-level cutover with override detection and a fresh-process probe | Mechanical | P1 | Env overrides beat config.json | Config-only switch |
| 51 | CEO | No readiness override in the preview | Taste | P1 | Hard gates must not be waivable | Generic override |
| 52 | CEO | Per-class successful-evidence counting; rust_error blocks | Mechanical | P1 | Errors escaped the gates | Count attempts |
| 53 | CEO | Evidence epochs per candidate build and policy | Mechanical | P1 | Old builds polluted the window | One rolling window |
| 54 | DX | In-memory replay buffer for explain and bench | Mechanical | P5 | Ledger cannot replay | Durable replay store |
| 55 | DX | Graduation command contract for all shadow and swap mutations | Mechanical | P5 | Consistency | Ad hoc flags |
| 56 | DX | Recovery table for engine_swap_refused | Mechanical | P1 | Reasons lacked fixes | Reasons only |
| 57 | CEO | Decision brief at the top of the report; paired bench for speed | Mechanical | P1 | Report was an artifact list | Charts first |
| 58 | CEO | Early evidence: C1 Postgres replay and a provisional S2 report | Taste | P3 | Value sooner | Wait for S1-S4 |
| 59 | DX | Docs ship with S4 and S5; agent rules | Mechanical | P5 | Commands shipped before docs | S6 at the end |
| 60 | Eng | Durable writer observations and a database-enforced swap fence | Taste | P1 | Heartbeats vanish; no fence means split brain | Heartbeat check |
| 61 | Eng | Shadow in a supervised child process | Taste | P1 | Native faults would kill the primary | In-process shadow |
| 62 | Eng | Recovery points beside the reverse shadow | Taste | P1 | Reverse shadow copies corruption | Reverse shadow only |
| 63 | Eng | Transaction-aware wrapper; invalidations after outer commit | Mechanical | P1 | Proxy missed callback writes | Bounded-read Proxy |
| 64 | Eng | Shared-bound reconcile intervals with deletes and ordering | Mechanical | P1 | Batches shift; upsert misses deletes | Per-side batches |
| 65 | Eng | Allocator manifests verified separately | Mechanical | P1 | Rows do not carry sequence state | Row digests only |
| 66 | Eng | stale needs generation evidence, else inconclusive | Mechanical | P1 | Revision strings excuse bugs | Revision compare |
| 67 | Eng | Per-item authorization check for privacy | Mechanical | P1 | Top-k shifts are not leaks | Set difference |
| 68 | Eng | Write compare on a preimage-validated copy-on-write snapshot | Mechanical | P1 | Replay after follow conflicts | Rollback on live shadow |
| 69 | Eng | Two observation seams; captured provider outputs; suppressed side effects | Mechanical | P1 | Context and fusion live above the engine | Engine wrapper only |
| 70 | Eng | Adapter policies migration, live-shadow, reverse-shadow | Mechanical | P1 | Migration transforms break live copies | One policy |

## DX Review Scorecard

```
+====================================================================+
|              DX PLAN REVIEW: SCORECARD                              |
+====================================================================+
| Dimension            | Score  | Prior  | Trend  |
|----------------------|--------|--------|--------|
| Getting Started      | 8/10   | 5/10   | up 3   |
| API/CLI/SDK          | 8/10   | 7/10   | up 1   |
| Error Messages       | 7/10   | 5/10   | up 2   |
| Documentation        | 8/10   | 4/10   | up 4   |
| Upgrade Path         | 8/10   | 7/10   | up 1   |
| Dev Environment      | 8/10   | 5/10   | up 3   |
| Community            | 6/10   | 3/10   | up 3   |
| DX Measurement       | 7/10   | 5/10   | up 2   |
+--------------------------------------------------------------------+
| TTHW                 | 5 min target | about 20 min estimate (before) |
| Competitive Rank     | Competitive (target)                         |
| Magical Moment       | designed, via the migrate run report        |
| Product Type         | developer tool: CLI plus in-process engine  |
| Mode                 | POLISH                                       |
| Overall DX           | 7.5/10 | 5.1/10 | up 2.4 |
+====================================================================+
| DX PRINCIPLE COVERAGE                                               |
| Zero Friction      | covered (quickstart, one install command)      |
| Learn by Doing     | covered (expected output per step)             |
| Fight Uncertainty  | covered (plan with time, blockers, capability report) |
| Opinionated + Escape Hatches | covered (defaults; --from, override, way back) |
| Code in Context    | covered (quickstart on the user's own brain)   |
| Magical Moments    | covered (timed search)                         |
+====================================================================+
```

Errors stop at 7: the shared renderer's `Fix:` placement is deferred and process-ending native faults get a next-open record, not a trace. Community stops at 6: GitHub issues only, no template yet, a small preview cohort by design.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` (via autoplan) | Scope & strategy | 1 (not persisted) | CLEAR | 15 proposals, 12 accepted, 2 deferred |
| Outside Review | codex, autoplan CEO, DX and Eng phases | Independent 2nd opinion | 0 | unavailable | codex not installed; no completed external review |
| Eng Review | `/plan-eng-review` (via autoplan) | Architecture & tests (required) | 1 (not persisted) | CLEAR (PLAN) | 23 issues, 4 critical gaps, all folded into the plan; 3 decisions queued for the final gate |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | skipped | no UI scope |
| DX Review | `/plan-devex-review` (via autoplan) | Developer experience gaps | 1 (not persisted) | CLEAR (POLISH) | score: 5.1/10 → 7.5/10, TTHW: ~20 min → 5 min; 16 decisions, 3 deferred |

- **OUTSIDE COVERAGE:** codex, CEO phase, unavailable (not installed), no completed external review. codex, DX phase, unavailable (not installed), no completed external review. codex, Eng phase, unavailable (not installed), no completed external review. Native in-host voices completed: CEO with 6 findings, DX with 8 findings, Eng with 8 findings (7 accepted, 1 queued as user decisions); native findings do not count as outside coverage.
- **CYCLE 2 (shadow mode):** focused delta review by two review agents (CEO+DX lens, Eng lens), not a full interactive rerun; 21 findings, all accepted; 6 shadow decisions (S1-S6) added to the gate.
- **VERDICT:** CEO + DX + ENG CLEARED for planning, cycle 2 included. The maintainer answered the final gate on 2026-11-16 with every recommendation (gate revision 2).

**DECISIONS OPEN AT REVIEW TIME (since resolved):** these three were open when the review ended. The maintainer settled all three at the final gate; the "Approval record" in [`../RUST_ENGINE.md`](../RUST_ENGINE.md) records the outcome, and D11 now names the gbrain-evals maintainer agent as the lander.
- U1 (D11): who lands and pins the gbrain-evals changes; recommended: the maintainer, unless a delegate is named.
- U2 (Phase 1 entry): effort budget through Checkpoint C1; recommended: 8 calendar weeks or 25 merged PRs from PR 1, whichever comes first.
- U3 (D10, open question 3): 1M benchmark corpus and spend; recommended: a permissively licensed public corpus embedded once at 1,024 dimensions, kept outside the repository, spend cap $50.
