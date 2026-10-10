# Hermes draft validation record

This is a **draft integration candidate, not a full-parity or merge-readiness attestation**. It addresses the implementation requested in [#6065](https://github.com/garrytan/gbrain/issues/6065) and [#6216](https://github.com/garrytan/gbrain/issues/6216); neither issue should be closed solely on this record.

- GBrain implementation base: `d4dc2d4d831503739e3c1551fdb01b4108457731`.
- Native provider/manager contract target: `NousResearch/hermes-agent@46d7718a52ff33accb15dc0501736fbdb6833cab`.
- Local validation: macOS arm64, Bun 1.4.2, Python 3.12; isolated homes, synthetic SQLite/PGLite data, and a disposable loopback PostgreSQL instance. No live brain/profile installation was changed.
- An independent Sol review and follow-up reviewed source and existing execution evidence. Follow-up closed the three runtime findings described below; it did not execute the tests itself.

## CI follow-up

The first GitHub `verify` job ([run 38025588088](https://github.com/garrytan/gbrain/actions/runs/38025588088/job/114135633904), draft head `507fa9367ad956d7888922bd491e731520350e23` tested in its merge commit) **passed typecheck and 76 of 77 checks**. Its sole failing check identified two test fixtures that needed canonical `beforeAll`/`afterAll` engine ownership; those fixtures were repaired without adding allowlist exceptions. The targeted isolation guard now passes both files, and their 11 tests pass.

The first native-provider CI run exposed a separate real defect: initializing the last-wake timestamp to zero skipped the first delta on a newly booted runner whose monotonic clock had not reached the default cadence. The provider now distinguishes an unobserved wake with `None`; a deterministic zero-clock regression was red before the fix. After repair, **all 25 native-provider tests and all 4 native-manager acceptance tests pass locally**. The full local isolation scan still timed out; the targeted pass is not a claim that the entire scan ran successfully.

At draft head `71a1a86081066cf7a3f5769a17dee1daacadcafc`, the [native-provider workflow](https://github.com/garrytan/gbrain/actions/runs/38026605918) passed, including real loopback contracts, managed-writer reconciliation, and native MemoryManager acceptance. The [repository verify job](https://github.com/garrytan/gbrain/actions/runs/38026605833/job/114138880548) also passed. The [E2E workflow](https://github.com/garrytan/gbrain/actions/runs/38026605859) succeeded but explicitly skipped key-gated LLM tests because fork secrets were unavailable; workflow success does not establish those scenarios.

Four unit shards on that head exposed additional integration-contract failures: installer prose was parsed as a nonexistent `gbrain connection` command; two CLI dispatch goldens lacked the new Hermes route; the new capture field exceeded existing schema-size budgets; and the tools-JSON golden lacked that optional capture field. The follow-up quotes the connection name, deliberately updates the Hermes route entries and capture schema golden, and compacts schema descriptions without raising budgets or dropping consent/routing guidance. All **114 tests across the five affected contract suites pass locally (543 assertions)** using the repository's supported PGLite snapshot setup. The tools-JSON diff contains only capture metadata and its derived byte count/hash. Generated tool catalog and operation manifest were regenerated. CI on the follow-up commit is still required.

The contributor gate is intentionally red for external PRs: upstream maintainers incorporate contributions into their fix-wave PRs. No maintainer override is requested or applied by this draft. The local failed attempts below remain historical evidence and are not erased by these narrower successes.

## Earlier local execution evidence

Failure labels in this table describe those specific attempts, not the newer CI results above.

| Check | Observed result | Boundary |
| --- | --- | --- |
| Combined Hermes, harness-onboarding, CLI JSON, transcript-retitle, and stdio-lifecycle suites | 139 passed, 1 PostgreSQL-only skip, 0 failed; 423 assertions across 15 files | Focused coverage, not the full repository suite |
| `bun test --timeout=60000 test/hermes-ambient-capture.test.ts` with safe PostgreSQL opt-in | 6 passed, 0 failed; 66 assertions | Includes the consent-lock transaction race; registered in `test/postgres-unit-arms.txt` for CI |
| `python test/hermes-python/native_manager_acceptance.py` | Earlier isolated runs passed all 4 tests, including the schema-valid correction rerun. A later combined validation attempt timed out starting the fixture and ran 0 tests | Actual installer, native MemoryManager, native MCP discovery/registry, and native skill_view; **not a model conversation**. Final reliability remains unconfirmed |
| `python test/hermes-python/validate_native.py` | Earlier 23-test runs passed. After adding the correction-schema regression, the 24-test combined attempt had one real-server remember timeout | Real HTTP/PGLite lifecycle plus loopback transport tests; latest attempt is not green |
| Standalone default import regression | Red before repair; 1 test passed after repair | Real CLI subprocess imports two synthetic sessions and reports two successful readbacks |
| Installer/removal regression | Red before repair; 15 tests passed after repair | Disabled-plugin removal preserves user configuration and existing ownership safeguards |
| Cutover provenance regression | Red before repair; 7 tests passed, 43 assertions after repair | Persisted raw-data readback, not only an intermediate helper result |
| Claimed-and-activated writer plus shutdown/owner suites | 50 passed, 0 failed, 131 assertions | Includes canonical files, raw provenance, coordinated stale-part tombstones, and no resurrection on reimport |
| Generated artifacts | `bun run regen:all` completed; subsequent run reported no changes | Does not regenerate PostgreSQL contract goldens |
| Secret scanning | Gitleaks 8.30.1 found no leaks in the scanned changed-file snapshot | A public Hermes commit constant initially triggered an API-key-name false positive; its variable was renamed to `HERMES_COMMIT_SHA`, retaining the same public SHA |
| Full unit and E2E | Attempted, then stopped before completion; E2E output also contained actual failures | **Not green.** Failures have not been established as baseline-only |
| Repository `verify` | Latest completed attempt: 69 passed, 8 failed | Remaining failures were per-check timeouts and the guard self-test runtime budget; do not waive or count them as passes |
| Packaged Node typecheck | Final standalone attempt exceeded 500 seconds without compiler diagnostics | **Unverified, not passed.** Earlier implementation-stage typechecks passed, but do not certify the final tree |
| Real AIAgent/model acceptance attempt | Blocked before agent construction/model calls by a missing `ruamel.yaml` dependency in the selected installed-host interpreter | No model-driven recall, write, skill selection, or fresh-process continuity is claimed |

The partial E2E run included reported failures in `agent-journey-postgres.test.ts`, `attendance-retrieval-postgres.test.ts`, `autopilot-multi-brain.serial.test.ts`, and assertions in `bootstrap-persistence.serial.test.ts`. These are retained as unresolved evidence, not classified as unrelated solely because their files were unchanged.

## Findings repaired

1. Installer return-type and maintenance fixture TypeScript contract defects from the original bundle.
2. JSON receipts routed through `writeStdoutFinal`, rather than ordinary logging redirected by the CLI JSON guard.
3. Case-insensitive SSE Content-Type handling.
4. Managed stale transcript parts deleted through revision-bound coordinated publication; deletion is counted only after a committed receipt, with canonical-file and tombstone checks.
5. Standalone maintenance omits the CLI's empty default session-source list; explicit adapter validation remains strict.
6. Removal accepts a user-disabled plugin while installation still refuses it; receipt ownership and edited-file protections remain intact.
7. Flat cutoff metadata survives the existing strict redaction pipeline and persists with the original session identity.
8. Provider correction fields are advertised in the model-facing schema, and native-manager correction arguments are schema-validated.
9. Repository integration checks: duplicate per-file documentation entry, oversized startup function, deprecated receipt advice key, and the missing PostgreSQL test-lane registration.

## Required before claiming full parity or merging

- Complete final-head typecheck, repository verification, full unit/E2E, and required GitHub CI; investigate failures rather than increasing limits until they disappear.
- Repeat native provider/manager acceptance in a stable isolated environment and resolve the timeout failures.
- Observe actual Hermes model-driven provider activation, recall, explicit save/correction/withdrawal, skill selection, and fresh-process continuity with synthetic data.
- Complete native MCP multiplex isolation and the remaining compression/rewind/resume, owner restart, credential lifecycle, and backend-parity scenarios.
- Establish maintenance-wide cumulative spend accounting for any automatic backlog resumption. Repeating identical per-run options is not aggregate-budget proof. The current command performs one bounded attempt and reports partial progress instead of internally resetting budgets.
- Do not claim a hard elapsed-time limit: cancellation is cooperative, and the inherited synthesis phase-end embedding path uses its own timeout.
- Publish a reviewed plugin commit and obtain Hermes catalog acceptance. The catalog YAML remains a submission template, not a listing.

See [the parity contract](HERMES_INTEGRATION.md) and [operator setup](../mcp/HERMES.md). Release-version allocation/restamping remains a pre-landing step; this candidate is not a release.
