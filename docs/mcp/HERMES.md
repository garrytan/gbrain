# Connect GBrain to Hermes

Add GBrain memory to an existing Hermes agent without replacing its identity.
The native memory provider recalls context at turn and session boundaries. A
native HTTP MCP connection exposes the same authorized memory, page, graph and
skill operations available to other GBrain harnesses. Setup installs the canonical
Codex/Claude skillpack in the selected Hermes profile.

**Say to your agent:** *"Connect this Hermes profile to my GBrain, with automatic
capture off."* Or *"Import only my interactive Hermes conversations after this
date, then check that they were saved."*

## Install in one explicit profile

Start with a working GBrain host from [INSTALL_FOR_AGENTS.md](../../INSTALL_FOR_AGENTS.md).
Use one `gbrain serve --http` owner for a PGLite brain, including when several
Hermes profiles run concurrently. Do not launch an embedded engine per conversation.
The Hermes provider and MCP connection do **not** require managed persistence or a
shared-content writer claim: for a single-user PGLite setup, the supported default
is one local owner with the brain left in classic/unmanaged mode. Do not run the
shared-content migration or claim a canonical root just to connect Hermes. If you
intentionally need managed writers/shared-content publication, use the reviewed
[claim and activate runbook](../architecture/topologies.md#claim-and-activate-runbook)
after its quiescence and backup checks. A source claimed before activation can
block classic sync; resolve it with the [pre-activation claim runbook](../architecture/topologies.md#pre-activation-claims),
not by deleting owner files. There is no GBrain verb to release a source that was
claimed but never activated; follow that runbook. For PGLite lock, backup and restoration details, see
[serve and sync concurrency](../architecture/serve-sync-concurrency.md) and the
[engine guide](../ENGINES.md).
Follow [hosted access](../guides/hosted-harness-access.md) to obtain a scoped private
handoff or bearer token from the brain owner. On the Hermes machine:

```sh
gbrain connect https://brain.example/mcp --harness hermes \
  --credentials-file /private/gbrain-handoff.json \
  --root /absolute/hermes-profile --install
```

With an already-issued bearer token in a private file:

```sh
gbrain hermes setup --hermes-home /absolute/hermes-profile \
  --url https://brain.example/mcp --token-file /private/gbrain-token --json
```

The root is the selected profile's home, not the brain's home or Hermes source
checkout. Setup never guesses a profile. It installs `plugins/gbrain`, native
skills, `memory.provider`, `memory.gbrain`, and `mcp_servers.gbrain`. It preserves
unrelated settings and identity files, refuses ownership conflicts and disabled
plugins, and records a private receipt. YAML formatting/comments may be rewritten;
a private original-config backup is retained. Tokens go in the profile's `.env`,
not command arguments or public receipts. Omit `--token-file` to use an existing
profile token. Remote connections require HTTPS; loopback HTTP is supported.

Setup recovers locks older than two minutes only when their recorded local
process is provably dead; an unidentified lock or a rare interrupted `.reap`
recovery artifact requires verifying that no setup process remains before
manual recovery, while preserving the installation receipt.

Restart Hermes in that profile. Setup reports `native_harness_verified: false`:
writing config is not evidence that a new conversation used it. After the restart,
verify the selected profile's MCP connection, then test the real memory lifecycle
in separate conversations: explicitly remember a harmless synthetic fact with
provenance, ask for it in a fresh conversation without repeating it, correct it,
read back the correction, withdraw it, and confirm it is no longer active. Use the
actual authorized read/write path and inspect receipts. Because provider `remember`
defaults to private visibility and remote MCP cannot read private facts, perform
readback through a trusted-local path unless the brain owner explicitly approves a
harmless synthetic world-visible test fact for connected agents; never widen real
private data just to make remote recall succeed. Also ask a new conversation to
perform one relevant task using a canonical installed skill; a listed skill or a
successful MCP smoke test is not proof the model selected it. Record profile and
Hermes version with the result. These are manual model-facing acceptance checks
for your own installation; the automated native `MemoryManager` coverage and the
bounded model smoke recorded in the [validation record](../designs/HERMES_VALIDATION.md)
do not replace them.

```sh
HERMES_HOME=/absolute/hermes-profile hermes mcp test gbrain
HERMES_HOME=/absolute/hermes-profile hermes -z \
  'Use GBrain to recall saved context about the example project. Cite its source.'
```

## Runtime behavior

| Capability | Hermes path |
| --- | --- |
| Relevant context before a turn | Provider `prefetch` calls keyless `recall` |
| Core memory and standing entities | `context_pack` at first turn, session switch and after compression |
| Changes since last wake | `delta` on the next prefetch after the heartbeat interval; no independent timer |
| Explicit save, correction, withdrawal | Provider tools or native `mcp__gbrain__*` operations with provenance |
| Full page, graph and skill operations | Native HTTP MCP under the existing server grant |
| Native skills | Canonical `plugin/skills` payload used by Codex/Claude |
| Shared skill following | Existing enrollment/router, separately opt-in through a handoff |
| Optional transcript capture | Local opt-in plus server admission-time consent; off at installation |
| History and nightly work | SQLite adapter and one-engine `hermes maintain` coordinator |

The provider keeps its system-prompt prefix and tool schemas stable. Retrieved
text is evidence, not instructions. Failures/degradation remain visible. It
contains no inference credentials and never runs synthesis on the recall path.
Each profile resolves `GBRAIN_MCP_TOKEN` through Hermes' per-turn secret scope.
It never reads another profile's process environment. For multi-profile gateways,
issue a separate principal/grant per independent profile; sharing a token makes
them one security principal. Verify isolation with harmless, disjoint synthetic
facts and confirm each profile is denied the other's fact. Do not treat separate
`HERMES_HOME` directories alone as server authorization boundaries.

Use a dedicated source-scoped grant as the access boundary. Optional
`memory.gbrain.source_id` only narrows operations that advertise that selector;
unsupported operations refuse it rather than widening the read. This selector
is not authorization, including for the separate full MCP connection.

```yaml
memory:
  provider: gbrain
  gbrain:
    url: https://brain.example/mcp
    entities: [people/alice-example, companies/acme-example]
    budget_tokens: 1200
    timeout_seconds: 3
    heartbeat_seconds: 300
    capture: false
```

Automatic capture is a separate choice. With local `capture: true`, completed
primary human turns are sent only to servers advertising consent-gated
`capture(ambient: true)`. The authoritative `memory.auto_writeback` setting must
also allow admission. Old servers, off/unset consent, bot turns, cron and subagents
do not become a silent capture path. Turning capture off retains earlier archives.
Keep `capture: false` unless both the profile user explicitly opts in and the brain
owner's `memory.auto_writeback` admission setting permits it. Verify the default
and explicit-off cases admit no ambient capture; if both parties opt in, test one
harmless primary-human turn, then withdraw consent and verify a later turn is
refused. This tests admission, not erasure of previously retained data.
Explicit remembering still works with automatic capture off, subject to the grant.
Configuration changes take effect in a new session. For expired or revoked tokens,
renew the scoped handoff and reinstall the same owned connection; do not broaden
permissions to make an operation pass.

## Import history and maintain it

History import is explicit and separate from installing memory. Session sources
are exact stored Hermes values; inspect the store before choosing one. This
example uses a synthetic `interactive` source:

```sh
gbrain transcripts ingest /absolute/hermes-profile/state.db --format hermes \
  --session-source interactive --messages-since 2026-10-01T00:00:00Z --dry-run
gbrain hermes maintain --state-db /absolute/hermes-profile/state.db \
  --source notes-example --session-source interactive \
  --messages-since 2026-10-01T00:00:00Z --window 300 --json
```

`--source` chooses the destination GBrain source; repeat `--session-source` for
several Hermes origins. `--since` keeps its session-selection semantics.
`--messages-since` retains only turns strictly after the boundary, before
redaction/rendering. Cutoff views have separate deterministic archive identities:
importing one cannot replace an earlier full archive. Normalized filters have
independent checkpoints.

The adapter imports all eligible user/assistant text from the selected store;
it currently ignores Hermes `active` and `compacted` flags to preserve archived
history. `--session-source` filters only exact `sessions.source` values. It is not
a profile selector, hidden-session/rewind policy, or per-message human-origin
filter: a mixed `state.db` can include other profiles or automated sessions.
Inspect the chosen store and verify its source values in a dry run. Use a
profile-specific store where possible, or choose exact sources deliberately. Do
not infer authorship from message text or call this a human-only transcript import.

With a live local PGLite serve, maintenance delegates over authenticated local IPC
to that same engine and requires its bound source and an existing local CLI writer
grant. An older or unbound owner refuses safely; upgrade and restart it first.

Maintenance reuses the importer, managed writer, cycle locks, facts drain and
source-scoped readback. It reports empty input, partial scans, deferred enrichment,
backlog, missing readback and cancellation. Its deadline is cooperative: synchronous
SQLite snapshot copying/querying is not a hard realtime deadline. It never kills a
live database owner or deletes lock files by guesswork.

Without `--enrich`, no paid enrichment runs. With `--enrich`, existing spend caps
and kill switches still apply. Synthesis also requires configured
`dream.synthesize.enabled`, `dream.synthesize.conversation_pages`, and `--dir`.
The existing facts drain can process queued work elsewhere in the same brain.
Enrichment therefore requires an existing unrestricted source grant; a
source-limited CLI grant may import and validate its selected source, but
`--enrich` refuses before importing anything. Brain-wide dead-holder lock cleanup
is independently attempted on import-only runs by trusted-local or verified
unrestricted CLI writers. Narrow authenticated grants do not invoke that reaper;
the receipt explicitly reports `lock_reap_requires_unrestricted_writer`, with
no sibling lock IDs and partial rather than complete housekeeping status.
An explicit enrichment retry may process previously imported pending conversations
even when the current import changes no pages. The shared synthesis phase uses
its durable completion records to avoid repeating completed work; the runner
never loops to reset the invocation's deadline or spending limits. This path retains
the existing dream-generated, privacy, opt-out and quarantine gates; it does not
bypass them or extract generated summaries as facts just to empty a queue.
No scheduler is installed. Schedule this command only after explicit opt-in to
recurring transcript imports and any paid processing. Each invocation is one
bounded attempt, not a promise that the backlog is drained; inspect JSON
`status`, `reasons`, ingest counts and any reported backlog before treating it as
complete. A partial result may require a later retry. The command never resumes
automatically or resets its budget, and it keeps no cumulative spend ledger across
external repeats; if you repeat it, you own one aggregate authorization and budget,
and must never run an unbounded loop that resets the time/spend limits. The
deadline is cooperative (cancellation is checked between steps), and a synchronous
SQLite snapshot operation or the synthesis phase-end embedding step may exceed it. Omit `--enrich` for import
and validation only; `--enrich` invokes existing brain-wide drain controls and
requires the unrestricted local writer grant described above.

The following is an **example only** for an operator who has explicitly chosen
recurring imports. It installs no scheduler; use the platform scheduler you
already operate, and replace the absolute paths and source with reviewed values.
It imports only the exact `interactive` session source, uses a fixed window and
session cap, and does not enable paid enrichment:

```cron
15 2 * * * HERMES_HOME=/absolute/hermes-profile /absolute/path/to/gbrain hermes maintain --state-db /absolute/hermes-profile/state.db --source notes-example --session-source interactive --window 300 --limit 100 --json
```

`--json` emits a machine-readable report but does not grant consent or make a
partial run successful. Before considering a schedule, test the selected
transcript inputs with the `gbrain transcripts ingest ... --dry-run` command above;
`gbrain hermes maintain` has no dry-run flag. For local PGLite, maintenance uses
the live owner when available; it must not start a second database writer.

## Remove or use legacy stdio

```sh
gbrain hermes setup --hermes-home /absolute/hermes-profile --remove --json
```

Removal restores unchanged owned settings and removes unchanged owned assets.
Edited files cause a conflict instead of being overwritten. Restart Hermes;
revoke the server grant separately if access should end. Private backups and
already-saved brain content remain.

Legacy stdio remains supported for a single local session:

```sh
hermes mcp add gbrain --env GBRAIN_HOME=/absolute/brain-home --connect-timeout 60 \
  --command /absolute/path/to/gbrain --args serve
```

Confirm the enable-tools prompt and verify with `hermes mcp test gbrain`; the add
command's exit status alone is not proof. Stdio alone does not install the provider
lifecycle. Existing `gbrain compile-context --target hermes --include-core` remains
available for static project context.

## Compatibility and verification

Automated coverage uses Hermes' native `MemoryManager` and provider loader with
the selected profile (6 native-manager tests plus 26 provider tests: file-backed
PGLite reopened by a new backend process, same-ID rewind/compression rehydration,
and scoped credential rotation, removal, renewal and revocation with sibling
controls). Those suites do not themselves start the full Hermes agent or call a
model. A separate, bounded smoke on the published draft head used a real Hermes
host and model against a synthetic backend: explicit save, fresh-process recall,
correction, withdrawal and selection of the installed canonical `query` skill.
Its limits: canonical-file write-through and embedding deduplication were not
exercised, model-driven restart, compression/resume and credential renewal are
unproven, and it does not prove the full MCP catalog or catalog acceptance. See the
[validation record](../designs/HERMES_VALIDATION.md) for current rebased-tree
status, including passed native checks and the changed-head CI result, and the
[native evidence ledger](../designs/HERMES_INTEGRATION.md#acceptance-status-and-evidence-ledger).
The adapter registry's `runtimeTestedAt` stays `null` in this draft; that unchanged
metadata is not a claim that no model-backed session was observed. Qualified
runtime evidence is recorded separately rather than assigning a broad certification date. A separate
[`test/hermes-managed-writer.test.ts`](../../test/hermes-managed-writer.test.ts)
acceptance proves a single claimed/activated synthetic source's resident-owner
import, provenance readback, stale multipart removal and reimport tombstone.
That test does not make managed persistence a requirement for ordinary Hermes
provider use or establish every managed-writer lifecycle. The standalone provider
remains a candidate, not an accepted catalog entry; see the
[provider package](../../integrations/hermes/README.md#catalog-submission).

The provider and transcript schema target Hermes commit
`46d7718a52ff33accb15dc0501736fbdb6833cab`. The schema contract is verified for
that exact revision using synthetic stores generated by its real `SessionDB`
API and live-WAL fixtures. The native CI lane requires regeneration and fails
if either pin or interpreter configuration is missing. This is not a claim of
compatibility with other Hermes revisions or unexamined production stores.
See the [provider package](../../integrations/hermes/README.md) for contract tests and the
[parity checklist](../designs/HERMES_INTEGRATION.md) for native gates. Catalog
publication needs a reviewed published commit, an eligible owner/major-contributor
submission or maintainer-curated sweep, and Hermes maintainer approval; a package in a
draft PR is not an accepted catalog listing. Optional Codex OAuth passthrough and a
metadata-only recall mode are not part of this integration.
