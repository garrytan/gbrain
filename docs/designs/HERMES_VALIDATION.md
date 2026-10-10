# Hermes draft validation record

**Delivery target:** continue updating [draft PR #6406](https://github.com/garrytan/gbrain/pull/6406), on `thebergerking91:feat/hermes-native-integration`. This is the existing draft for the requested work, not a request to open a replacement PR. Published-head evidence and unpushed follow-up evidence are kept separate.

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

## Local parity follow-up (not yet published)

The expanded working tree passed a parent-run batch of **51 focused TypeScript tests, 26 native provider tests, and 6 native MemoryManager tests**. This includes required regeneration of the exact pinned Hermes SQLite fixture, filesystem-backed PGLite reopened by a new backend process, same-ID rewind/pre-compression rehydration, and scoped credential lifecycle checks. Optional unrelated Hermes plugins reported missing dependencies in the deliberately minimal test environment; their load warnings do not establish those plugins' availability.

Separately, actual native-model conversations against the committed provider demonstrated backend context retrieval, explicit save, fresh-process recall, correction/supersession, withdrawal, and selection/application of the installed canonical `query` skill. A two-conversation correction/skill cap was retained across attempts and exhausted exactly. The first correction collector failed after successful model tool calls; committed correction and active-memory withdrawal were verified from retained events. Historical-row retention was checked by a separately labelled **zero-model replay**, not falsely attributed to recovery of the first database.

A new independent Sol review returned **request changes**, despite the passing batch:

- **Global lock authority:** source-limited import-only callers could invoke the brain-wide dead-holder reaper. The repaired runner requires trusted-local or verified unrestricted CLI authority for that housekeeping; narrow callers may still import but receive an explicit skipped/partial receipt with no lock IDs. A real-PGLite negative test first failed, then verified that sibling and global locks remain untouched and undisclosed.
- **Pending synthesis:** import freshness was incorrectly treated as completion. The runner now lets the canonical synthesis phase discover persisted pending inputs and partition completed work on an explicit unchanged retry, with one cycle/deadline. Unit regressions for import-only, lock-deferred, and budget-deferred first attempts were red before repair. Fresh-import and unchanged-retry pipeline integration evidence is still being completed.
- **Nonterminal facts jobs:** the drain now reports waiting, delayed, active, waiting-children, and paused work separately, while preserving the waiting-only legacy backlog count. Early pre-claim deferrals retain observed counts; unavailable backends and failed final count queries do not claim an empty or freshly measured queue. The original real-PGLite regressions were red before repair.

Sol's follow-up closed the authority, retry-gate, and wire-bound findings. It identified a malformed waiting-children fixture (no actual child) and stale count reporting after a failed final read. The fixture now establishes an actual delayed child through the queue API and asserts zero model calls. A fault-injected final-read test failed before the count-reset repair. The resulting parent batch passes **60 tests across 5 files**; the independent existing-backlog integration case also passes after establishing its own prior import rather than depending on test order. Earlier failed batches remain historical evidence.

**Earlier pipeline blocker:** after correcting the scripted transport's synthesis/fact-extraction routing, the real owner-driven synthesis reached its page writes but failed with `The local trust lane does not match this transport.` The retained verified CLI context conflicted with the synthesis child's remote tool context. Automatic creation and draining of synthesis-derived facts jobs were unproven at that stage. This required an authority-preserving repair, not weakening the write guard or discarding the caller's grant.

The subsequent local-delegation implementation now passes the owner-driven fresh synthesis/automatic-enqueue/drain and unchanged-rerun assertions (`parent-sol-authority-acceptance`: all 6 integration tests passed). That combined run also had 4 authority-fixture setup failures; after correcting the Git ceiling and using the canonical private-visibility field, all 4 authority tests passed separately (`parent-local-authority-green`). A public-read positive control plus private-read negative control also passed. These results demonstrate the exercised path, **not security approval**. A subsequent parent run (`parent-replay-job-gc`) passed 9 authority/replay tests with 107 assertions, including receipt replay after physical deletion of the private job, revocation/narrowing and source-incarnation rejection, and metadata/body/privacy/opt-out/quarantine boundaries. This does not prove a concurrent revocation/publication race. Independent review of the new facts-effect/anti-loop exception and final-head verification remain outstanding. The prototype is unstaged and unpublished.

### Security-review correction: retain canonical extraction policy

The independent review rejected the synthesized-page eligibility exception and revision bridge. They changed the existing anti-self-consumption policy, introduced an invalid transaction/lock order, and did not satisfy managed extraction's original-revision fence. The parent also rejected the related source-wide facts-authority escalation for confined children. All three new exception helpers and their wiring were removed; the existing backstop, facts-effect and managed-extraction implementations were restored without those exceptions.

The corrected acceptance criterion is real import → committed synthesis pages → completed synthesis jobs → bounded facts drain, **while preserving canonical skips**. It does not require turning generated summaries into facts. The separate existing-backlog test still proves that eligible queued facts work is actually extracted and persisted. New negatives prove that a broad parent cannot give a confined child source-wide extraction and that dream-generated/private/opt-out/quarantine exclusions remain effective. The parent-run `canonical-extraction-policy-restored` batch passed **15 tests, 0 failures, 171 assertions across 3 files**, including unchanged rerun and durable receipt replay after physical job deletion.

The two compatibility fixes are now implemented: opaque capability contexts bypass pre-admission/batch/receipt read proxies rather than relaxing engine identity, and terminal local-subagent job replay refuses with owner-resubmission guidance before creating work. A native PostgreSQL test found an additional batch-path attempt to read a different transport registration; the parent repaired that path and verified that forged capabilities still fail.

Real disposable PostgreSQL execution (not a PGLite engine-kind emulation) passed **3 tests / 24 assertions** for cached-path commits, receipt access/replay after job deletion, batch writes, forged-capability refusal, and concurrent revocation locking. A held `authorizeStoredRequest(..., true)` transaction blocked a concurrent revocation with SQLSTATE `55P03`; after release, revocation succeeded and subsequent authorization refused. An earlier native run also passed the 5 existing PostgreSQL authority-parity tests. The parent then passed **16 local authority/replay tests / 165 assertions**. The emulated-publication test that produced `pool.options` errors was removed in favor of the native test. The loopback-only test container was removed after verifying its task-owner label; the live database container was untouched.

The independent Sol follow-up closed all five previous findings and found no new code-level blocker within its bounded review. It did not approve merge, marketplace acceptance, or final CI. The official `bun run typecheck` subsequently **passed (exit 0, 211.03 seconds)** in `full-typecheck-measured-window`; the execution allowance was 900 seconds and no repository guard was relaxed. Final rebased-head validation and CI remain required.

The four ancestor-marker failures are now baseline-classified: the same four named tests fail on published `1db67090d` and the candidate when their fixtures are beneath the managed ancestor. Parent verification matched the relevant baseline test/authority/queue/root-registry files to that commit and compared the distinct failure names. Baseline and candidate controls each passed 33/33 outside that ancestor. Those control runs improperly used system temporary directories; the parent verified both generated directories were removed, records the deviation, and will not repeat it. This environmental classification is not a completed candidate typecheck or full-suite verdict.

The parent full-typecheck attempts `remaining-work-parent-typecheck-v2` and, after the delegation changes, `local-delegation-parent-typecheck` each timed out after their 240-second limits with no compiler diagnostics. The later run exited 124 after 240.57 seconds. These historical attempts remain timeouts, not passes. The later completed official check above establishes typecheck success on the pre-rebase candidate; the earlier worker pass did not certify the later tree.

After the first two repairs, **40 tests across maintenance, lock-reaping, owner/IPC, and standalone CLI suites passed**. A separate red/green wire-receipt hardening bounds returned lock IDs without truncating identifiers, preserves total/omission counts, and passes **9 owner/IPC tests**. These overlap the earlier suites and must not be added as unique test totals. None of these local runs substitutes for updated-head CI or a follow-up independent review.

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
