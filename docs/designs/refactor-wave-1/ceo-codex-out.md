Static review at `608a174dc`. The plan measures code volume, then assumes that volume explains the defect rate.

1. **High — The investment thesis is unproven.**  
   I reproduced the 165 commits touching both engines; 37 have “wave” in their subject. In this repository, a commit is often a package of unrelated fixes. Co-editing does not establish duplicated implementation effort, parity defects, or their customer impact. Nor does the plan identify whether local reliability, hosted isolation, retrieval quality, or setup friction constrains adoption.

   **Recommendation:** Classify a bounded sample of recent fixes by actual cause and customer consequence. Prioritize domains by recurring failures and repair effort. Add outcome measures—such as fewer engine-specific regressions and shorter fix lead time—alongside structural checks.

2. **High — “One integrated PR” has become permission to combine unrelated investments.**  
   Consolidating storage, replacing schema construction, reorganizing migrations, and decomposing seven command/pipeline functions have different benefits and failure modes. Nothing establishes that rewriting CLI dispatch or doctor orchestration is necessary to eliminate duplicated storage logic. Their inclusion increases integration work and makes a production regression harder to isolate.

   **Recommendation:** Keep one integrated PR, but give it one primary objective: eliminate duplicated implementation in explicitly selected storage domains. Include supporting schema, migration, and command changes only where that objective requires them. Defer independent W4 cleanups unless the defect analysis justifies their inclusion.

3. **Critical — The proposed SQL abstraction does not yet specify the semantics that protect stored memory.**  
   Output normalization cannot solve input-binding differences. The existing [JSONB helper](src/core/sql-query.ts:72) documents how a pre-stringified parameter can succeed on PGLite while becoming a JSON string scalar on Postgres. [PGLite transactions](src/core/pglite-engine.ts:1718) also carry checkpoint admission, cached statements, and savepoint-aware guards; [Postgres transactions](src/core/postgres-engine.ts:566) preserve connection routing. Saying these remain engine-owned does not demonstrate that migrated calls still enter them correctly.

   **Recommendation:** Define and test the executor contract before mass extraction: parameter encoding, transaction ownership, nested rollback, cancellation, retry ownership, and scoped connections. Complete one representative transactional write domain inside the collector before converting the rest. Shared implementation can make both engines consistently wrong.

4. **High — W2 mistakes textual differences for a schema deficit.**  
   The 75-versus-47 count ignores schema fragments imported by [pglite-schema.ts](src/core/pglite-schema.ts:1). The existing [drift test](test/e2e/schema-drift.test.ts:55) explicitly permits `file_migration_ledger` only on Postgres and documents intentional index differences. Requiring identical table sets changes that contract. Generating from Postgres SQL also makes every future Postgres-specific construct the subtraction transform’s responsibility.

   **Recommendation:** Inventory actual initialized schemas first. Preserve intentional differences through explicit capability rules. Compare shared neutral schema fragments against a subtractive generator before choosing the architecture. Require equivalent supported behavior, not unconditional catalog identity.

5. **High — The integration strategy underestimates semantic conflicts.**  
   Move-dominant commits help review; they do not make concurrent fixes mechanical. An upstream fix can modify the old implementation after its replacement has been extracted. A clean merge can preserve the wrapper while losing the substance. Baselines captured before development also become stale as legitimate fixes land.

   **Recommendation:** Integrate continuously into the collector, retain temporary forwarding exports where useful, and assign ownership for mapping intervening fixes into moved code. Reserve a short final landing window. Compare the collector against the same final base revision, account explicitly for upstream behavior changes, and run the full gate on the actual candidate.

6. **High — The 300-line rule creates undisclosed scope and rewards cosmetic decomposition.**  
   Beyond the named targets, touched files contain [cli.main](src/cli.ts:450) at 415 lines, [performFullSync](src/commands/sync.ts:4056) at 436, and [hybridSearchCached](src/core/search/hybrid.ts:2432) at 437. The acceptance criterion therefore requires additional work. Moving 46 mutable locals into one shared `SyncRun` object can satisfy the length limit while preserving the same coupling.

   **Recommendation:** Enumerate the complete acceptance scope before implementation. Require narrow phase inputs, explicit outputs, and ownership of mutations. Treat length as a review signal; make reduced coupling and preserved invariants the actual pass conditions.

7. **High — The verification plan overvalues snapshots and undervalues installed brains.**  
   A route-table snapshot does not prove authorization or middleware behavior; the [OAuth preflight code](src/commands/serve-http.ts:618) documents an existing failure caused by downstream middleware interaction. A SQL hash misses migration handlers: [migration 165](src/core/migrate.ts:6657) has empty `sql` and performs its work in a handler. Fresh-install equality does not establish upgrade or interrupted-upgrade safety.

   **Recommendation:** Map existing tests to the changed contracts and fill specific gaps: authenticated request outcomes, transactional failure/recovery, supported old-database upgrades, and migration handler behavior. Normalize nondeterministic snapshot fields explicitly. Establish a rollback procedure that accounts for databases opened by the candidate. Zero test deletions is a constraint, not evidence of sufficient coverage.

8. **High — “Behavior preserving” excludes economically important behavior from its measurements.**  
   Identical search IDs and scores can coexist with more provider calls, slower responses, or broken cache reuse. HEAD itself changes PGLite statement caching and page-lock reuse; those are directly exposed to W1. A correctness-green refactor can still make large local brains materially less usable.

   **Recommendation:** Add bounded before/after checks for representative import/write throughput, search latency, SQL round trips, provider calls, and cold startup. Exercise warm and cold caches. Set acceptable regression budgets before implementation.

9. **Medium — W3 relocates the merge bottleneck without resolving allocation.**  
   Every new migration still edits the static registry, and concurrent branches still compete for the next version. Splitting 175 entries improves navigation but does not establish the claimed conflict reduction.

   **Recommendation:** Specify version allocation and registry reconciliation for concurrent branches. Consider generating the committed static registry deterministically from migration files. Preserve handlers, engine overrides, verification hooks, and execution metadata—not just SQL strings.

10. **High — W5 addresses enforcement mechanics while ignoring why the existing ratchet was bypassed.**  
    The [current guard](scripts/check-module-size.sh:1) explicitly permits raising ceilings through a TSV edit. The engine and sync notes record repeated increases and integration adjustments. Adding a function allowlist creates another editable ceiling unless review policy changes.

    **Recommendation:** Require a concrete justification for exceptions and enforce the architectural result directly—for example, prohibit domain SQL from returning to adapters after that domain migrates. Measure duplicated ownership and shared mutable state alongside size.

Recommendation: Revise before implementation and keep one bounded integrated PR centered on proven storage defect sources, because the current plan bundles independent refactors while its acceptance criteria cannot establish preserved durability, reduced maintenance cost, or safe integration with ongoing fix waves.
