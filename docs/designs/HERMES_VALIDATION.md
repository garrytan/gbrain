# Hermes draft validation record

**Status as of 2026-10-10.** Current status comes first; historical failures follow and are labelled as superseded only where a later result actually replaced them.

**Delivery target:** continue updating [draft PR #6406](https://github.com/garrytan/gbrain/pull/6406), on `thebergerking91:feat/hermes-native-integration`. This is the existing draft for the requested work, not a replacement PR. Until the rebased commits are pushed, the PR's published head remains `1db67090d821d5a5ad7e1b25498b39004c872444`; evidence for that published head and for the rebased, not-yet-published tree is kept separate below.

This is a **draft integration candidate, not a full-parity, merge-readiness or catalog-acceptance attestation**. It addresses the implementation requested in [#6065](https://github.com/garrytan/gbrain/issues/6065) and [#6216](https://github.com/garrytan/gbrain/issues/6216); neither issue should be closed solely on this record. "Best draft" status for the source PR is different from catalog submission, catalog merge or deployment, none of which has happened.

## Bases and pins (not interchangeable)

| Name | Value | Meaning |
| --- | --- | --- |
| Rebase target (`master`) | `3103715596e3dd4bd74d7d9987d24a0aa8b2ffbf` | Current upstream base of the rebased candidate |
| Rebased source tip | `1cd1ad309048eba34faaa2a9b2a4b0c3bee70938` | Four source commits atop the target; later documentation-only commits may follow |
| Published PR head | `1db67090d821d5a5ad7e1b25498b39004c872444` | What GitHub CI and the native-model smoke below actually ran |
| Pre-rebase merge base | `d4dc2d4d831503739e3c1551fdb01b4108457731` | Implementation base of the published branch |
| Original review bundle base | `dfa96fdbb13fb5633f3167eaba1e386ee9282985` | Archive base the initial design was reviewed against; differs from the implementation base |
| Hermes native API contract pin | `NousResearch/hermes-agent@46d7718a52ff33accb15dc0501736fbdb6833cab` | Provider/`MemoryManager`/`SessionDB` schema target |
| Hermes host used for the model smoke | `3eb7ed08d19da393196722d0b219b2ba1ec22810` | Real agent host; deliberately different from the API pin |

Local validation: macOS arm64, Bun 1.4.2, Python 3.12; isolated homes, synthetic SQLite/PGLite data, and a disposable loopback PostgreSQL instance. No live brain or profile was changed.

## Current status

| Gate | State |
| --- | --- |
| Rebase onto the target | **Done, clean.** 4 commits replayed; the latest implementation follow-up touched 38 files. A pre-rebase backup ref was kept. Generated assets were regenerated fresh; the locked dependency install was unchanged |
| Official `bun run typecheck` | **Passed (exit 0, 211.03 s)** on the *pre-rebase* candidate; no repository guard relaxed. **Rebased-tree typecheck: pending** |
| Repository and native-provider/manager checks on the rebased tree | **Pending (not passed).** Results below were obtained on the pre-rebase tree |
| Changed-head GitHub CI (native provider incl. fixture regeneration, `marketplace-validation`, verify, Test, E2E) | **Pending** until pushed. Green CI on `1db67090d` does not carry over |
| Independent review | Final Sol review of the pre-rebase candidate **closed all 5 findings and found no blocker** in its bounded, read-only scope. It is not merge, security or marketplace approval. A strong review of the *rebase composition* is **pending** |
| Secret scan | Gitleaks over a 101-file index snapshot: clean, after replacing a fake AWS redaction fixture with a constructed public example |
| Native-model smoke (real Hermes host, synthetic backend) | **Observed, bounded** on `1db67090d`; see below |
| Catalog submission/acceptance | **Not submitted, not accepted.** See "Catalog admission" |
| `runtimeTestedAt` | Remains `null`; see "Registry evidence field" |

## Rebased PostgreSQL evidence

At source tip `1cd1ad309`, a fresh disposable PostgreSQL instance passed **14 tests, 0 failures, 126 assertions** across the ambient-capture consent, existing queued-authority parity, and local-subagent PostgreSQL suites. This includes actual commits, batch admission, forged-capability rejection, receipt replay after job deletion, live-grant revocation locking and admission-time capture-consent locking. The labelled loopback-only container was removed and its absence verified; the live database was untouched. This is focused evidence, not the complete E2E suite.

## Pre-rebase local evidence

All counts below overlap and must not be added as unique totals.

- **Focused TypeScript and native lanes:** 51 focused tests (8 files) with required regeneration of the pinned Hermes SQLite fixture; 26 native-provider tests (including scoped credential rotation, removal, renewal, revocation and sibling-profile controls); 6 native `MemoryManager` acceptance tests (adds a filesystem-backed PGLite database reopened by a new backend process, and same-ID rewind/pre-compression rehydration to the earlier four). Optional unrelated Hermes plugins reported missing dependencies in the minimal environment; that establishes nothing about those plugins.
- **Authority and replay:** 16 local authority/replay tests, 165 assertions. A real disposable PostgreSQL run passed 3 tests / 24 assertions (cached-path commits, receipt access/replay after job deletion, batch writes, forged-capability refusal, and a held `authorizeStoredRequest(..., true)` transaction blocking a concurrent revocation with SQLSTATE `55P03`, after which revocation succeeded and authorization refused), plus the 5 older PostgreSQL authority-parity tests. These demonstrate the exercised paths, not security approval, and do not prove every concurrent revocation/publication race.
- **Canonical extraction policy preserved:** the owner-driven path is real import → committed synthesis pages → completed synthesis jobs → bounded facts drain → unchanged rerun with durable receipt replay after physical job deletion, **while preserving canonical skips**: dream-generated, private, opt-out and quarantined content is not turned into facts, and a broad parent cannot give a confined child source-wide extraction. 15 tests, 0 failures, 171 assertions across 3 files. A separate existing-backlog test proves eligible queued facts work is extracted and persisted.
- **Maintenance suites:** 60 tests across 5 files (lock authority, pending synthesis, nonterminal facts jobs); 6 maintenance integration tests / 70 assertions passed on rerun before the rebase.
- **Four ancestor-marker authority fixtures** fail the same four named tests on published `1db67090d` and on the candidate when their fixtures sit beneath the managed ancestor (baseline-classified). Baseline and candidate controls each passed 33/33 outside that ancestor. A worker used system temporary directories for those controls (a deviation, retained here); the parent verified the generated directories were removed. This is an environmental classification, not a full-suite verdict.

Maintenance behavior retained by design: one bounded attempt per invocation with no automatic resume and no budget reset; one aggregate authorization/budget is the operator's responsibility across any external repeats, and no cumulative cross-run spend accounting is claimed; cancellation and deadlines are cooperative, not hard realtime, and the inherited synthesis phase-end embedding path uses its own timeout. Earlier maintenance reviews identified brain-wide lock-reaper authority for source-limited callers, import freshness mistaken for synthesis completion, nonterminal facts-job reporting, stale counts after a failed final read, and a malformed waiting-children fixture. These were repaired with tests that failed first; see the historical section for the rejected synthesized-page exception.

## Native-model evidence on published head `1db67090d` (bounded)

Real Hermes host commit `3eb7ed08…` (not the API pin), a high-reasoning model via the host's configured provider, the committed provider export (SHA-256 recorded in the private artifact), disposable loopback PGLite, ambient capture off, synthetic data only. Two smoke conversations and a separate two-conversation lifecycle allowance were used. **The lifecycle counter is exhausted at 2/2 and was not reset**; these are not one invented four-conversation authorization.

- **Smoke (2 conversations):** context retrieval from the backend, a model-directed explicit save (committed, fact ID 2) and, in a distinct fresh process and profile, recall without any explicit tool call and without the answer in the query. Independent backend readback agreed. This proves fresh-*agent-process* continuity; the backend stayed alive across both, so it is **not** backend-restart durability.
- **Lifecycle (2 conversations):** correction using `replaces`, recall of only the active successor, withdrawal, and zero active facts afterward; and model selection of the installed canonical `query` skill via `skill_view` followed by a correct backend-seeded recall. The tool surface was constrained to the seven memory tools plus skill read tools.
- **Retained failure:** the first lifecycle collector failed after successful model tool calls (`KeyError: facts`, a wrong assumption about the engine's raw-query return shape). The failed receipt is retained unchanged. Committed correction and active-memory withdrawal were verified from the retained events; the raw historical-row readback was not captured. Historical-row retention was then checked by a separately labelled **zero-model replay** against a fresh synthetic backend (both expired rows remain, linked to the successor); it is not recovery of the first database.
- **Not shown by this evidence:** canonical-file write-through (the write reported `write_through.skipped: no_repo_configured`) and embedding-backed deduplication (`degraded_dedup: true`), so no universal full-parity claim; model-driven backend restart; model-driven compression/rewind/resume; model-driven credential renewal; or multiplexed native MCP under a model. Those scenarios are covered, where at all, only by non-model native tests; the model-driven versions remain unproven, and this record does not invent new features to close them.
- Private artifacts hold the sanitized events, receipts and counters. They contain machine-specific paths, are not an installable package, and must not be rerun against a live profile or have their counter reset without a new explicit authorization.

## Registry evidence field (`runtimeTestedAt`)

The adapter registry's `runtimeTestedAt` remains `null`, and its existing tests are unchanged. This draft conservatively leaves that broad metadata unset while recording the real, bounded model evidence separately. The smoke exercised the published provider and one canonical skill, not every adapter path or the rebased installation under a model; its detailed artifacts live outside the repository. This is an evidence-labeling choice, not a new registry enforcement rule or a claim that no model-backed session occurred.

## Catalog admission (snapshot of the provider directory)

- A byte-identical, read-only snapshot of `integrations/hermes` was checked by the official Hermes plugin validator (pinned validator checkout, no `--install-deps`, isolated home): **14 checks passed**, one **`context_exfil` caution retained** for human review (README prose on the soft context budget; no `dangerous` findings; not suppressed or allowlisted). The entry-schema validator also passed the updated disclosure-bearing template with a local 40-character candidate SHA. This checks structure only, not publication or eligibility.
- **Install pass:** the official validator with `--install-deps` passed all 14 checks on the final-content provider snapshot, including the updated README, in a fresh disposable PM environment at validator `dce1e9b37581dd62e480a9064dc04a709c2940d3`. The parent verified all 8 current plugin files against the snapshot manifest, no dependency-preparation failure, and the retained scanner caution. The live runtime was untouched. Exact published-pin readback remains pending; content validation is not publication.
- **Final pin:** not set. The catalog template's `<published-40-character-commit-sha>` placeholder is not submittable and must not be filled until the final tree is published and its exact commit can be reviewed.
- **Submitter:** the catalog permits an owner/major-contributor submission or a Hermes-maintainer-curated sweep. A canonical `garrytan` entry needs one of those eligible paths; this record asserts no determination about any particular account's eligibility.
- **Disclosure and lineage:** the submission must carry the data-flow disclosure and argue why the provider is materially different from existing community GBrain-related entries, naming the origin (the README and template carry the disclosure and lineage text). Prior-art credit and the bounded provenance review are in the provider package; the review is a verbatim-line comparison, not proof of independent authorship or absence of paraphrase.
- **Reachability:** the old pin was fetchable by a fresh clone of the upstream repository when checked (via the PR head ref). Long-term persistence of that reference is unproven; a merged commit is the durable pin. A rerun against current Hermes main is advisable because main has moved since the validator pin.
- **Acceptance/listing: not obtained and not requested.** A source PR, a valid plugin, or a submitted catalog PR is not a listing; only maintainer merge establishes that.

## Not implemented here / excluded

- Optional Codex OAuth passthrough (#6065) is excluded by the requester.
- A release verb for claimed-but-inactive sources (a #6065 comment) is not implemented; existing runbook guidance is provided instead (see the HERMES.md persistence-mode section).
- The metadata-only recall suggestion in #6216 (`snippet_chars: 0`) is not implemented.
- No scheduler is installed; no production-populated Hermes store has been validated.

## Remaining gates

1. Rebased-tree typecheck, repository verification, focused native-provider/manager and PGLite/PostgreSQL suites; changed-head GitHub CI. Investigate failures rather than raising limits.
2. Strong independent review of the rebase composition.
3. Read back a published pin and match its plugin bytes to the successful install-validation manifest. Any subsequent catalog submission needs an eligible submitter and Hermes maintainer review; this source draft does not claim a listing.
4. Model-driven versions of compression/resume, credential renewal, native MCP multiplex and backend restart remain unproven, along with canonical write-through and embedding deduplication.
5. Contributor-policy checks are red by policy for an external PR; no maintainer override is requested or applied. Release-version allocation is a pre-landing step; this candidate is not a release.

See [the parity contract](HERMES_INTEGRATION.md) and [operator setup](../mcp/HERMES.md).

## Historical evidence (kept; later results noted where they supersede)

### CI on earlier draft heads

- Draft head `507fa9367ad956d7888922bd491e731520350e23` ([run 38025588088](https://github.com/garrytan/gbrain/actions/runs/38025588088/job/114135633904), tested in its merge commit): typecheck and 76 of 77 `verify` checks passed. The one failing check required two fixtures to use canonical `beforeAll`/`afterAll` engine ownership; they were repaired without allowlist exceptions (isolation guard passes both files; 11 tests). The full local isolation scan timed out, so the targeted pass is not a claim that the whole scan succeeded.
- The first native-provider CI run exposed a real defect: a zero-initialized last-wake timestamp skipped the first delta on a freshly booted runner. The provider now uses `None` for an unobserved wake; a zero-clock regression was red before the fix.
- Head `71a1a86081066cf7a3f5769a17dee1daacadcafc`: the [native-provider workflow](https://github.com/garrytan/gbrain/actions/runs/38026605918) and [verify job](https://github.com/garrytan/gbrain/actions/runs/38026605833/job/114138880548) passed; the [E2E workflow](https://github.com/garrytan/gbrain/actions/runs/38026605859) succeeded but skipped key-gated LLM tests because fork secrets were unavailable. Four unit shards exposed installer prose parsed as a nonexistent `gbrain connection` command, two CLI dispatch goldens lacking the Hermes route, and capture-schema size/golden drift; these were fixed without raising budgets (114 tests across five contract suites, 543 assertions).
- Published head `1db67090d`: the Test workflow ([run 38028741214](https://github.com/garrytan/gbrain/actions/runs/38028741214)), [native provider](https://github.com/garrytan/gbrain/actions/runs/38028741173/job/114145040630), [repository verify](https://github.com/garrytan/gbrain/actions/runs/38028741214/job/114145041327) and [E2E status](https://github.com/garrytan/gbrain/actions/runs/38028741175/job/114147616419) succeeded; key-gated LLM scenarios stayed skipped. This is the last completed CI on a published head.

### Authority design history

- A first pipeline attempt reached synthesis page writes and failed with `The local trust lane does not match this transport.`; the retained CLI context conflicted with the synthesis child's remote tool context. The resolution was an authority-preserving local-delegation design, not weakening the write guard.
- An independent review **rejected** a synthesized-page eligibility exception and revision bridge (they changed the existing anti-self-consumption policy, introduced an invalid transaction/lock order, and violated managed extraction's original-revision fence), and the parent rejected a related source-wide facts-authority escalation for confined children. All of that code was removed and the existing backstop, facts-effect and managed-extraction behavior restored. No facts-effect exception remains.
- Compatibility fixes: opaque capability contexts bypass pre-admission/batch/receipt read proxies without relaxing engine identity; terminal local-subagent job replay refuses with owner-resubmission guidance. An emulated-publication test that produced `pool.options` errors was replaced by the native PostgreSQL test; the loopback test container was removed after its owner label was verified.
- The 15-test/171-assertion, 16-test/165-assertion, 60-test and 9-test authority/replay (107 assertions) and 40-test maintenance results above overlap earlier batches (e.g. 9 owner/IPC tests for bounded wire-receipt lock IDs). Earlier failed batches (including 4 authority-fixture setup failures from a Git ceiling and a visibility-field mistake, later corrected) remain historical.

### Superseded or still-historical timeouts and failures

- Parent full-typecheck attempts `remaining-work-parent-typecheck-v2` and `local-delegation-parent-typecheck` timed out at their 240 s limits with no diagnostics (the later run exited 124 after 240.57 s). They remain timeouts. The later completed official typecheck above supersedes them for the pre-rebase tree only.
- A standalone packaged-Node typecheck exceeded 500 s with no diagnostics; it was never a pass. It is superseded for the pre-rebase tree by the official run above, and says nothing about the rebased tree.
- A real AIAgent/model attempt was blocked before agent construction by a missing `ruamel.yaml` dependency in the selected interpreter. A later, separately configured run produced the bounded model evidence above; the blocked attempt is retained as history.
- Earlier native-manager attempts: all 4 tests passed in isolated runs, then a combined attempt timed out starting the fixture (0 tests run); the 24-test `validate_native.py` attempt had one real-server `remember` timeout. Later parent runs passed (26 provider tests, 6 manager tests), but those two earlier timeouts have not been shown to be stable-repeat green on the rebased tree.
- A first model-smoke setup did not activate the provider (a flag that ignored rules, and a configuration override that the conversation home ignored); the model reported missing context/tools. Its receipts are retained separately and were not relabelled successful.
- Earlier full unit and E2E attempts were stopped before completion and E2E output contained failures in `agent-journey-postgres.test.ts`, `attendance-retrieval-postgres.test.ts`, `autopilot-multi-brain.serial.test.ts` and assertions in `bootstrap-persistence.serial.test.ts`. They were not classified as unrelated merely because the files were unchanged; later published-head CI for E2E succeeded with key-gated tests skipped, which does not by itself explain those local failures. A repository `verify` attempt had 69 passed, 8 failed (per-check timeouts and the guard self-test runtime budget); these were not waived.
- The contributor gate is intentionally red for external PRs: upstream maintainers incorporate contributions into their fix-wave PRs.

### Earlier local execution evidence

| Check | Observed result | Boundary |
| --- | --- | --- |
| Combined Hermes, harness-onboarding, CLI JSON, transcript-retitle, stdio suites | 139 passed, 1 PostgreSQL-only skip; 423 assertions, 15 files | Focused only |
| `test/hermes-ambient-capture.test.ts` with PostgreSQL opt-in | 6 passed; 66 assertions | Includes the consent-lock transaction race; registered in `test/postgres-unit-arms.txt` |
| Standalone default import regression | Red before repair; 1 test passed after | Real CLI subprocess imports two synthetic sessions and reads both back |
| Installer/removal regression | Red before repair; 15 tests passed after | Disabled-plugin removal preserves user configuration |
| Cutover provenance regression | Red before repair; 7 tests, 43 assertions after | Persisted raw-data readback |
| Claimed-and-activated writer plus shutdown/owner suites | 50 passed; 131 assertions | Canonical files, raw provenance, stale-part tombstones, no resurrection on reimport |
| Generated artifacts | `bun run regen:all` completed; second run reported no changes | Does not regenerate PostgreSQL contract goldens; regenerated again for the rebase |

A public Hermes commit constant once triggered an API-key-name false positive in an earlier Gitleaks snapshot; its variable became `HERMES_COMMIT_SHA` with the same public SHA.

## Findings repaired

1. Installer return-type and maintenance fixture TypeScript contract defects from the original bundle.
2. JSON receipts routed through `writeStdoutFinal`, not logging redirected by the CLI JSON guard.
3. Case-insensitive SSE Content-Type handling.
4. Managed stale transcript parts deleted through revision-bound coordinated publication, counted only after a committed receipt.
5. Standalone maintenance omits the CLI's empty default session-source list; explicit adapter validation stays strict.
6. Removal accepts a user-disabled plugin while installation still refuses it; ownership and edited-file protections remain.
7. Flat cutoff metadata survives the strict redaction pipeline and persists with the original session identity.
8. Provider correction fields are advertised in the model-facing schema; native-manager correction arguments are schema-validated.
9. Repository integration checks: duplicate per-file documentation entry, oversized startup function, deprecated receipt advice key, and the missing PostgreSQL test-lane registration.
10. First-wake delta, CLI dispatch/schema-budget and fixture-ownership defects from CI; lock-reaper authority, pending-synthesis retry, nonterminal-job reporting and local-delegation authority from review.
