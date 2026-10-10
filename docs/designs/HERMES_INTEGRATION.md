# Hermes integration parity contract and acceptance gates

This is a behavior contract for #6065 and #6216, not a declaration that either
issue is complete. The integration targets Hermes
`NousResearch/hermes-agent@46d7718a52ff33accb15dc0501736fbdb6833cab`; the
reviewed GBrain base was `dfa96fdbb13fb5633f3167eaba1e386ee9282985`.
The goal is equivalent useful memory behavior through each harness's native
lifecycle, not copying OpenClaw hooks or claiming identical mechanics.

## Baseline and parity map

| Behavior | OpenClaw / Codex / Claude Code baseline | Hermes implementation target | Evidence required; current boundary |
| --- | --- | --- | --- |
| Recall at natural boundaries | OpenClaw context engine owns compaction/checkpoint boundaries; Codex and other hook-light clients use explicit `context_pack`/`delta` pull calls; Claude Code has hook-backed session/compaction placement. | Native `MemoryProvider` prefetch uses `recall`, `context_pack` at first turn/session switch/compression and interval-gated `delta`; stable prompt prefix and visible degradation. | Unit and native `MemoryManager` acceptance exercise provider calls, fresh manager sessions, compression/session-switch callbacks and stable schemas/prompt. No Hermes model conversation or durable pre-compression checkpoint API is claimed. |
| Explicit durable memory | Shared memory verbs/MCP, with provenance; corrections and withdrawal use the server's existing write contracts. | Provider boundary tools plus full authenticated HTTP MCP operations. Provider `remember` defaults private; private facts are not remotely readable. | Native acceptance calls the real installed provider through pinned Hermes `MemoryManager`: save a harmless synthetic world-visible fact, recall from a fresh manager session, correct it and withdraw it with active-memory readback. This is not a new model conversation. |
| Skills | Canonical harness skillpacks and shared-skill catalog/router are separate from memory access; enrollment/policy and native use are distinct. | Setup places the canonical local skillpack in the selected Hermes profile. Shared-brain following remains a separate, explicitly approved enrollment/router flow. | The native acceptance confirms the installed `brain-ops` skill is returned by Hermes' native `skill_view`. It does not establish model selection/use in a fresh conversation or shared catalog enrollment. |
| Full brain operations | Native MCP connection supplies the grant-authorized operation surface. | Separate authenticated HTTP MCP connection complements the provider's fixed boundary tools. | Native acceptance discovers `mcp__gbrain__get_links` through Hermes' MCP tool discovery and invokes its registered handler against the real loopback GBrain server; it also exercises authorized page/link operations. This proves the tested operations, not the entire catalog or every permission boundary. |
| Isolation and identity | Each independent installation needs its own principal/grant; profile identity and unrelated configuration remain intact. | Explicit Hermes profile, per-turn secret scope, server-side source grants, ownership-tracked reversible setup. | Native acceptance installs two isolated profiles, concurrently exercises their real `MemoryManager` contexts, verifies source-scoped non-cross-read and token scope, and confirms a revoked grant stops a warm provider. Broader renewal/removal and all edit-conflict cases remain separate. |
| Ambient capture | Off unless the brain owner and harness user opt in; admission rechecks authoritative consent. | Off at install and provider setup; opt-in primary-human-turn capture requires local enablement and server `capture(ambient: true)` admission consent. | Native acceptance toggles capture through an installed provider with a real background `MemoryManager` worker: server consent off admits no page, consent on admits the synthetic turn, withdrawal blocks the next turn, and the other profile's source remains unchanged. This is not a general persistence-journal race or physical-erasure test. |
| Transcript history | Explicit archive/import, distinct from live capture; Hermes store schema and source/cutoff semantics are host-specific. | Explicit SQLite `state.db` import; exact `sessions.source` filter; optional strict message cutoff; full-history adapter currently ignores active/compacted flags. | Synthetic fixtures are not production-store validation. Verify the pinned schema against a populated synthetic Hermes store and live WAL/snapshot behavior; document profile, rewind and compaction boundaries before broad import. `source` is not a human-origin filter. |
| Maintenance / scheduling | Existing GBrain persistence owner, locks, drains, spend limits and kill switches remain authoritative; a scheduler is an operator choice. | One explicit bounded `gbrain hermes maintain` attempt; PGLite delegates to the live local owner when detected. No scheduler is installed. | Verify owner IPC, restart/cancellation, import readback and backlog/resumption without resetting aggregate limits. A partial report is not queue completion; deadlines are cooperative, not hard realtime. |
| Persistence mode | Existing classic/unmanaged and managed-writer modes are distinct operational contracts. | Hermes memory does not require claiming a canonical content root or activating managed persistence. | `test/hermes-managed-writer.test.ts` proves one claimed and activated synthetic source through a resident owner: Hermes transcript import creates files with raw metadata readback, stale multipart content is reconciled with coordinated `delete_page(expected_revision)`, only committed receipts count, and reimport retains the deletion. This does not prove every managed-writer lifecycle, crash, restart, or maintenance path. |
| Distribution | Native integrations may be directly installed or catalog-distributed; catalog acceptance is independent of source publication. | Standalone plugin directory and a catalog submission template. | A published full commit pin and Hermes maintainer review/merge are still required. A template or GBrain PR is not a catalog listing. |
| Model credentials | Model access belongs to the host/provider integration; it is separate from memory-provider transport. | The GBrain plugin uses the configured GBrain server and does not read Hermes `auth.json` / `credential_pool` credentials. | #6065 marks Codex OAuth passthrough optional. Decide separately whether to support it; it is not part of this memory-provider parity claim. |

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
- One bounded maintenance pass may leave backlog. Do not loop by resetting
  per-run time/spend limits. Inspect the structured report and resume only under
  the same operator-approved aggregate authorization and budget.

## Acceptance status and evidence ledger

The [draft validation record](HERMES_VALIDATION.md) is the current gate status.
It preserves later provider/fixture timeouts and incomplete full-suite/typecheck
attempts alongside the earlier passing evidence below. Earlier green runs do
not certify final-head reliability or release readiness.

**Proven in the pinned synthetic native acceptance lane:** the CLI installs two
explicit Hermes profiles; Hermes' pinned `MemoryManager` loads the installed
provider with scoped secrets; memory save/recall across fresh manager sessions,
correction and withdrawal; native MCP discovery plus a registered `get_links`
handler; native `skill_view` for installed `brain-ops`; concurrent profile
source isolation; consent-gated capture off/on/withdrawal through a background
worker; and loss of access after revoking a warm provider's grant. The acceptance
has four passing tests against the real isolated loopback GBrain/PGLite fixture.
The lane also runs the existing native directory-discovery and loopback JSON/SSE
provider contracts. Hermes is pinned to
`46d7718a52ff33accb15dc0501736fbdb6833cab`.

This proves native host API integration and the named behaviors—not an
end-to-end Hermes process/model conversation. `MemoryManager` test sessions are
not fresh model conversations. `skill_view` is discovery/view evidence, not
proof that a model selected a skill; a handful of MCP operations is not full
catalog acceptance.

**Not yet proven:** a real Hermes CLI/model conversation invoking the provider;
model use of an installed skill; full native catalog coverage or Hermes catalog
acceptance; compression/delta cursor continuity; every expiry/revocation and
profile edit/removal case; real persistence-journal admission races; managed-writer
paths beyond the specific resident-owner source-claim/import/shrink/reimport test;
maintenance worker lifecycle; live-owner shutdown, cancellation/restart; PGLite and
PostgreSQL lifecycle parity; production-populated Hermes store/WAL behavior; and
bounded backlog resumption under one aggregate budget. The catalog entry remains
a template, not an accepted listing.

Evidence commands in CI include `bun test test/hermes-managed-writer.test.ts`,
`python test/hermes-python/validate_native.py`, and
`python test/hermes-python/native_manager_acceptance.py`, with locked GBrain Bun
dependencies and the minimal pinned Python runtime dependencies. The managed-writer
run recorded one passing test and 34 assertions; the native-manager acceptance
recorded four passing tests (`Ran 4 tests ... OK`). The pinned native provider
lane is separately responsible for its contract tests. Missing-plugin
`requests`/optional-provider warnings are not test failures and are not
acceptance evidence. Record exact commands, runtime versions, observed results,
and skipped gates before changing this ledger.

Before release, run repository `/ship` and the declared full typecheck, unit,
PGLite and PostgreSQL E2E gates from a complete checkout. Then use the pinned
Hermes revision and a disposable profile plus synthetic GBrain data for the
remaining real CLI/model conversation and lifecycle gates. Keep live profile/user
data, credentials, paid providers and visibility widening out of acceptance
tests. Do not claim parity or close #6065/#6216 based on configuration writes,
discovery, focused probes, or an unaccepted catalog entry. Keep
`runtimeTestedAt: null` until the native fresh-conversation gate is observed.

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
