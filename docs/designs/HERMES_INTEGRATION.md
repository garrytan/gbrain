# Hermes integration parity contract and acceptance gates

This is a behavior contract for #6065 and #6216, not a declaration that either
issue is complete. The integration targets Hermes
`NousResearch/hermes-agent@46d7718a52ff33accb15dc0501736fbdb6833cab`. The
candidate is rebased onto GBrain `master` `3103715596e3dd4bd74d7d9987d24a0aa8b2ffbf`;
the original review bundle's archive base (`dfa96fdb…`) and the published branch's
implementation base (`d4dc2d4d…`) are different historical bases and are not
interchangeable. Current gate status is in the [validation record](HERMES_VALIDATION.md).
The goal is equivalent useful memory behavior through each harness's native
lifecycle, not copying OpenClaw hooks or claiming identical mechanics.

## Baseline and parity map

| Behavior | OpenClaw / Codex / Claude Code baseline | Hermes implementation target | Evidence required; current boundary |
| --- | --- | --- | --- |
| Recall at natural boundaries | OpenClaw context engine owns compaction/checkpoint boundaries; Codex and other hook-light clients use explicit `context_pack`/`delta` pull calls; Claude Code has hook-backed session/compaction placement. | Native `MemoryProvider` prefetch uses `recall`, `context_pack` at first turn/session switch/compression and interval-gated `delta`; stable prompt prefix and visible degradation. | Unit and native `MemoryManager` acceptance (6 tests) exercise provider calls, fresh manager sessions, a filesystem-backed PGLite reopened by a new backend process, same-ID rewind/pre-compression rehydration, compression/session-switch callbacks and stable schemas/prompt. Separately, a bounded real-model smoke on the published head observed context retrieval and fresh-process recall. Model-driven compression/resume is unproven; no durable pre-compression checkpoint API is claimed. |
| Explicit durable memory | Shared memory verbs/MCP, with provenance; corrections and withdrawal use the server's existing write contracts. | Provider boundary tools plus full authenticated HTTP MCP operations. Provider `remember` defaults private; private facts are not remotely readable. | Native acceptance calls the real installed provider through pinned Hermes `MemoryManager`: save a harmless synthetic world-visible fact, recall from a fresh manager session, correct it and withdraw it with active-memory readback (not a model conversation). A separate bounded real-model run on the published head observed an explicit save, fresh-process recall without a tool call, correction via `replaces`, and withdrawal with zero active facts afterward. Canonical-file write-through and embedding deduplication were not exercised (`write_through.skipped`, `degraded_dedup`), and withdrawal is not physical erasure. |
| Skills | Canonical harness skillpacks and shared-skill catalog/router are separate from memory access; enrollment/policy and native use are distinct. | Setup places the canonical local skillpack in the selected Hermes profile. Shared-brain following remains a separate, explicitly approved enrollment/router flow. | The native acceptance confirms the installed `brain-ops` skill is returned by Hermes' native `skill_view`. A bounded real-model run observed the model selecting the installed canonical `query` skill through `skill_view` and then recalling correctly; it is one skill in one conversation, not a general selection guarantee, and not shared catalog enrollment. |
| Full brain operations | Native MCP connection supplies the grant-authorized operation surface. | Separate authenticated HTTP MCP connection complements the provider's fixed boundary tools. | Native acceptance discovers `mcp__gbrain__get_links` through Hermes' MCP tool discovery and invokes its registered handler against the real loopback GBrain server; it also exercises authorized page/link operations. This proves the tested operations, not the entire catalog or every permission boundary. |
| Isolation and identity | Each independent installation needs its own principal/grant; profile identity and unrelated configuration remain intact. | Explicit Hermes profile, per-turn secret scope, server-side source grants, ownership-tracked reversible setup. | Native acceptance installs two isolated profiles, concurrently exercises their real `MemoryManager` contexts, verifies source-scoped non-cross-read and token scope, and confirms a revoked grant stops a warm provider. The 26 provider tests add scoped credential rotation, removal, renewal and revocation with sibling-profile controls. Model-driven credential renewal and all edit-conflict cases remain unproven. |
| Ambient capture | Off unless the brain owner and harness user opt in; admission rechecks authoritative consent. | Off at install and provider setup; opt-in primary-human-turn capture requires local enablement and server `capture(ambient: true)` admission consent. | Native acceptance toggles capture through an installed provider with a real background `MemoryManager` worker: server consent off admits no page, consent on admits the synthetic turn, withdrawal blocks the next turn, and the other profile's source remains unchanged. This is not a general persistence-journal race or physical-erasure test. |
| Transcript history | Explicit archive/import, distinct from live capture; Hermes store schema and source/cutoff semantics are host-specific. | Explicit SQLite `state.db` import; exact `sessions.source` filter; optional strict message cutoff; full-history adapter currently ignores active/compacted flags. | Synthetic fixtures are not production-store validation. Verify the pinned schema against a populated synthetic Hermes store and live WAL/snapshot behavior; document profile, rewind and compaction boundaries before broad import. `source` is not a human-origin filter. |
| Maintenance / scheduling | Existing GBrain persistence owner, locks, drains, spend limits and kill switches remain authoritative; a scheduler is an operator choice. | One explicit bounded `gbrain hermes maintain` attempt; PGLite delegates to the live local owner when detected. No scheduler is installed. | Owner IPC, cancellation, import readback and bounded facts drain are covered by local and PostgreSQL authority tests (see the validation record). Synthesis-derived work respects canonical skips: dream-generated, private, opt-out and quarantined content is not converted to facts, and a confined child never receives source-wide extraction. One aggregate budget applies; the command never auto-resumes or resets limits. A partial report is not queue completion; deadlines are cooperative, not hard realtime. |
| Persistence mode | Existing classic/unmanaged and managed-writer modes are distinct operational contracts. | Hermes memory does not require claiming a canonical content root or activating managed persistence. | `test/hermes-managed-writer.test.ts` proves one claimed and activated synthetic source through a resident owner: Hermes transcript import creates files with raw metadata readback, stale multipart content is reconciled with coordinated `delete_page(expected_revision)`, only committed receipts count, and reimport retains the deletion. This does not prove every managed-writer lifecycle, crash, restart, or maintenance path. |
| Distribution | Native integrations may be directly installed or catalog-distributed; catalog acceptance is independent of source publication. | Standalone plugin directory and a catalog submission template. | The final-content plugin snapshot passed all 14 official checks with `--install-deps` in a disposable runtime, with the `context_exfil` caution retained. Published-pin readback and an eligible owner/major-contributor submission or maintainer-curated sweep remain separate from Hermes human review. The template placeholder is not submittable, and acceptance/listing has not been obtained. A GBrain source PR (including best-draft status) is not a catalog submission, merge or deployment. |
| Model credentials | Model access belongs to the host/provider integration; it is separate from memory-provider transport. | The GBrain plugin uses the configured GBrain server and does not read Hermes `auth.json` / `credential_pool` credentials. | #6065 marks Codex OAuth passthrough optional; it is excluded from this work and from the parity claim. |

## Invariants

- Provider and full MCP use the intended dedicated grant. `source_id` narrows
  only operations that support it; unsupported selectors refuse rather than
  widening. Sources organize local memory but do not isolate agents sharing
  files or credentials.
- Installation preserves profile identity and unrelated configuration. It is
  not runtime activation evidence; restart the selected profile and test a new
  conversation. Consent to optional capture or paid processing is separate.
- Retrieved memory is evidence, not instructions. Stable provider prefix and
  tool schemas are maintained. Recall does not invoke synthesis. The combined
  `budget_tokens` target is soft: pack/recall may trim with a notice, while full
  delta delivery is preserved because the server may already have advanced its
  cursor.
- Importing history is not ambient capture. `--since` selects sessions;
  `--messages-since` retains only messages strictly after the boundary before
  redaction/rendering and creates a distinct archive view. Session-source
  filtering is exact-match provenance, not proof of per-message authorship.
- One bounded maintenance pass may leave backlog. The command never resumes or
  resets its own budget; an operator who repeats it externally is responsible for
  the same aggregate authorization and budget. Cancellation is cooperative, not a
  hard deadline.

## Acceptance status and evidence ledger

The [validation record](HERMES_VALIDATION.md) is the current gate status and
carries the dated results, retained failures and what each result does and does
not establish. Counts there overlap and are not unique totals. This ledger lists
only behavior boundaries.

**Exercised, pre-rebase, in the pinned synthetic native lane:** the CLI installs
two explicit Hermes profiles; Hermes' pinned `MemoryManager` loads the installed
provider with scoped secrets; memory save/recall across fresh manager sessions,
correction and withdrawal; native MCP discovery plus a registered `get_links`
handler; native `skill_view` for installed `brain-ops`; concurrent profile source
isolation; consent-gated capture off/on/withdrawal through a background worker;
loss of access after revoking a warm provider's grant; a file-backed PGLite reopened
by a new backend process; and same-ID rewind/compression rehydration. The suite is
6 native-manager tests plus 26 provider/transport tests (credential rotation,
removal, renewal, revocation with sibling controls) against isolated loopback
GBrain/PGLite. Hermes is pinned to `46d7718a52ff33accb15dc0501736fbdb6833cab`.
**The native-provider and MemoryManager runs above were taken on the pre-rebase
and rebased source; changed-head GitHub CI passed on `809fb5609` (see the
validation record) except for the external-contributor policy gate. Re-verify on
any later head.**

**Exercised with a real model (published head, bounded, synthetic):** an explicit
model-directed save, fresh-process recall, `replaces`-based correction, withdrawal,
and selection of the installed canonical `query` skill. Two smoke conversations were followed by a separately bounded two-conversation
lifecycle run; its 2/2 counter is exhausted and was not reset. A collector failure is retained, with a
separately labelled zero-model replay for historical-row retention. This is
not full parity: canonical-file write-through and embedding deduplication were not
exercised, and `MemoryManager` tests are still not model conversations.

**Not yet proven:** model-driven compression/resume, backend restart, credential
renewal and multiplexed native MCP; full native MCP catalog coverage; every
expiry/revocation and profile edit/removal case; persistence-journal races beyond the explicitly tested grant/consent locking cases; managed-writer paths beyond the resident-owner source-claim/import/shrink/
reimport test; production-populated Hermes store/WAL behavior; and
catalog acceptance (the entry remains an unaccepted submission candidate).
Not implemented: release verb for claimed-but-inactive sources, metadata-only recall
(#6216 suggestion).

Evidence commands include `bun test test/hermes-managed-writer.test.ts`,
`python test/hermes-python/validate_native.py`, and
`python test/hermes-python/native_manager_acceptance.py`, with locked GBrain Bun
dependencies and the minimal pinned Python dependencies. Missing-plugin
`requests`/optional-provider warnings are not test failures and are not acceptance
evidence. Record exact commands, runtime versions, observed results and skipped
gates before changing this ledger.

Before release, run repository `/ship` and the declared full typecheck, unit, PGLite
and PostgreSQL E2E gates from a complete checkout of the rebased head. Keep live
profile/user data, credentials, paid providers and visibility widening out of
acceptance tests. Do not claim universal parity or close #6065/#6216 on
configuration writes, discovery, focused probes, or an unaccepted catalog entry.
`runtimeTestedAt` remains `null` as a conservative metadata choice: the bounded
model smoke is recorded separately in the validation record, and this draft
assigns no broad runtime-certification date.

## Sources for this contract

- [#6065](https://github.com/garrytan/gbrain/issues/6065) and
  [#6216](https://github.com/garrytan/gbrain/issues/6216): requested scope and
  Hermes catalog distribution.
- [#5118](https://github.com/garrytan/gbrain/issues/5118) and
  [#5119](https://github.com/garrytan/gbrain/issues/5119): preserve session-level
  `--since` while adding strict message cutoffs and exact session-source filters;
  neither promises human-authorship inference.
- GBrain's [ambient recall](../guides/ambient-recall.md),
  [ambient writeback](../guides/ambient-writeback.md),
  [shared brain skills](../guides/shared-brain-skills.md), and
  [harness validation](../guides/harness-validation.md) define the comparator's
  memory placement, consent, enrollment, and evidence boundaries.
- The Hermes schema target is pinned to
  [the Hermes source commit](https://github.com/NousResearch/hermes-agent/tree/46d7718a52ff33accb15dc0501736fbdb6833cab).
