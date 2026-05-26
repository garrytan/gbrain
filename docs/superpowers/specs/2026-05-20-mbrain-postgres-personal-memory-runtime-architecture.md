# MBrain Postgres Personal Memory Runtime Architecture

Date: 2026-05-20
Status: Approved for specification
Scope: Target architecture for the next major MBrain redesign

## Purpose

MBrain should become a local-first personal memory runtime, not only a local
Markdown search tool. The target design is a Postgres-only architecture that can
ingest personal raw sources, extract structured memory, automatically update
canonical knowledge, forget low-value or superseded memory, and run maintenance
cycles safely while multiple Claude Code, Codex, CLI, MCP, and daemon sessions
are active.

The design intentionally absorbs strong ideas from `reference/gbrain`, especially
Postgres-backed runtime coordination, dream/autopilot maintenance, hot/cold
memory flow, source-aware ranking, facts/takes-style temporal memory, and
system-of-record reconciliation. It does not clone gbrain's company/team product
surface. MBrain remains personal, local, governed, and user-owned.

## Non-Negotiable Decisions

1. Target architecture is Postgres-only.
2. Local-first means local ownership and local execution, not SQLite-only.
3. Local Postgres is the default backend; SQLite and PGLite are legacy or
   migration surfaces, not targets for new runtime features.
4. MBrain is a personal memory runtime, not a general agent platform.
5. Restricted maintenance runners are allowed for memory tasks, including local
   Claude Code and Codex when available.
6. Automatic canonical write is required.
7. Governance is not a manual approval wall. Governance is the policy system
   that makes automatic writes safe, explainable, reversible, and auditable.
8. Long-term user knowledge must remain human-readable and reconcilable through
   Markdown/frontmatter/fences/projections.
9. Runtime state can be Postgres-only.
10. Forgetting is a first-class lifecycle, not only search filtering.
11. Source policies should be mostly automatic. Users grant minimal consent and
   manage exceptions.
12. Multiple agents and sessions are normal and must be safe by design.

## Core Mental Model

MBrain has four knowledge layers:

```text
Raw Source Layer
  - source registry, source items, source chunks, provenance, raw access ledger

Work / Session Layer
  - Codex and Claude sessions, task threads, attempts, decisions, working sets,
    retrieval traces, handoffs, reverify states

Semantic Assertion Layer
  - extracted claims, resolved assertions, assertion events, conflict sets,
    lifecycle state, authority state

Canonical Projection Layer
  - Markdown pages, profile memory, personal episodes, project/system docs,
    task resume cards, timelines, reports
```

The raw and work/session layers preserve evidence and operational continuity.
The assertion layer is where facts from different sources fuse. The projection
layer is what the user and agents actually read.

## Source And Evidence Model

All durable memory starts as source-backed evidence.

Important source kinds:

- `user_direct`
- `codex_session`
- `claude_session`
- `agent_session`
- `meeting_transcript`
- `document`
- `pdf`
- `markdown_file`
- `code_repo`
- `email`
- `calendar`
- `browser`
- `bookmark`
- `chat_export`
- `slack`
- `discord`
- `manual_note`
- `imported_archive`

Every source item must carry:

- source id
- source kind
- origin event, when applicable
- connector id, when applicable
- source locator
- content hash
- source timestamp
- ingestion timestamp
- source policy id
- sensitivity flags
- prompt-injection flags
- secret flags
- retention policy
- extraction status

MBrain does not store every source as a full raw copy by default. It stores
metadata, selected chunks/excerpts, hashes, and provenance. Full raw copy is a
source-policy decision.

## Personal Data Hub Policy

The system must be designed from the beginning for all personal source classes,
including email, calendar, browser, documents, meeting transcripts, chat exports,
code repositories, and agent sessions.

This does not mean every connector is enabled by default. The user grants
minimal consent when connecting a source. MBrain chooses source-kind defaults
for ingest, indexing, extraction, canonical write, LLM use, retention, export,
and forgetting. Advanced overrides exist but are not part of the normal
onboarding path.

Default UX principle:

```text
The user decides whether a source can be used for memory.
MBrain decides how to handle that source safely by default.
The user manages exceptions.
```

## Assertion Model

The smallest semantic knowledge object is an `assertion`.

Examples:

- "MBrain's target architecture is Postgres-only."
- "The user prefers minimal consent over many onboarding options."
- "This project uses foundation-first linear implementation phases."
- "A code claim requires live verification before answer-grounding."
- "A commitment was made in a meeting."
- "A preference was superseded by a newer direct statement."

Decision, preference, event, relationship, code claim, commitment, project rule,
architecture claim, and profile fact are assertion types, not separate top-level
canonical object families.

Assertions have two independent state axes:

```text
authority_state:
  unresolved
  candidate
  canonical
  conflicted
  rejected

lifecycle_state:
  active
  stale
  expired
  archived
  purged
```

State changes are append-only in `assertion_events`.

## Extracted Claim Layer

Raw source processing does not create assertions directly. It creates
`extracted_claim` records first.

Pipeline:

```text
source_item/source_chunk
  -> extracted_claim
  -> resolved assertion
  -> canonical projection, candidate, conflict, or rejection
```

`extracted_claim` is parser/LLM/runner output. It may be malformed,
low-confidence, unresolved, duplicate, unsafe, or contradicted. Resolver and
policy stages decide whether it becomes an assertion.

Memory Candidate is not the universal extraction buffer. It is the review UX for
assertions or projection proposals that cannot be safely applied automatically.

## Automatic Canonical Write

Automatic canonical write is a required capability.

Source-backed factual updates should write canonical memory automatically when:

- source provenance is usable
- target is resolved
- claim type is eligible
- confidence is high enough
- sensitivity policy permits
- no unresolved contradiction exists
- source-kind x claim-type authority matrix permits automatic write

Ambiguous, low-confidence, sensitive, target-uncertain, prompt-injection-flagged,
or conflicting claims become candidates, conflicts, quarantine records, or
rejections.

Policy must record:

- source refs
- extracted claim ids
- assertion evidence ids
- assertion id
- authority decision
- confidence
- target resolution
- sensitivity decision
- contradiction decision
- writer id
- runner id, when applicable
- previous state hash
- after state hash

## Authority Matrix

Automatic write authority is determined by source kind x claim type, with
additional gates for confidence, sensitivity, target certainty, contradiction,
recency, and user override policy.

Examples:

- `user_direct x decision`: automatic canonical
- `user_direct x preference`: automatic canonical with supersession support
- `agent_session x task_outcome`: automatic canonical
- `agent_session x inferred_preference`: candidate unless recurring
- `codex_session x architecture_decision`: automatic canonical when user-confirmed
- `email x relationship`: candidate or verify-first
- `calendar x event`: automatic canonical
- `browser x preference`: candidate
- `code_repo x code_claim`: verify-first before canonical
- `meeting_transcript x commitment`: automatic only when speaker/target is clear
- `document x world_fact`: canonical if source-backed and non-conflicting

Assertions can be supported by multiple evidence records. Assertion-level
authority and confidence are derived summaries, not replacements for the
underlying evidence set. The evidence set must support per-source revocation,
forgetting, contradiction review, and audit explanations.

## Conflict And Supersession

Temporal supersession is considered before contradiction.

If a new assertion updates an older assertion over time, the old assertion is
expired/superseded and the new assertion becomes active. This is not a conflict.

A conflict set is created only when multiple assertions about the same
target/property/time window cannot all be true.

Conflict sets track:

- target
- property
- participating assertions
- validity window
- evidence summary
- provisional winner, if any
- resolution status
- resolver event history

Retrieval must not use unresolved conflicts as simple answer-grounding truth.

## Forgetting Model

Forgetting is lifecycle-level:

```text
active -> stale -> expired -> archived -> purged
```

Default retrieval uses canonical active assertions first. Stale assertions are
verify-first. Expired and archived assertions are hidden from normal answer
grounding but visible in audit/review mode.

Purge is restricted. It requires explicit user action, retention policy,
redaction/sensitive-data cleanup, or source-specific TTL. Purge leaves a
tombstone/audit record.

Restore policy is source-kind and sensitivity dependent:

- durable profile/preference/decision: long archive, easy restore
- sensitive/private data: short restore window, purge/redaction priority
- transient task mechanics: fast expiry/purge possible
- code claims: reverify before purge
- imported documents: follow source retention policy

## System Of Record

MBrain is Postgres-only for runtime and structured memory, but user knowledge
must not become opaque DB-only state.

Canonical mutation uses dual-write with required reconciliation:

```text
policy-approved canonical mutation
  -> Postgres transaction
  -> Markdown/frontmatter/fence projection write
  -> mutation ledger event
  -> reconciliation status
```

Mutation states:

- `applied`
- `pending_reconcile`
- `failed_db`
- `failed_markdown`
- `conflict`

Runtime state can be Postgres-only:

- jobs
- locks
- leases
- runner transcripts
- tool calls
- source processing attempts
- raw access ledger
- queue state
- cycle heartbeat
- retry state

Long-term knowledge should be Markdown-representable:

- compiled truth
- timelines
- profile/preference summaries
- personal episodes
- project/system decisions
- durable facts
- important task handoffs

## Projection Model

Assertions are the semantic source. Projections are human-readable and
agent-readable views.

Projection targets include:

- Markdown page compiled truth
- Markdown page timeline
- profile memory
- personal episode
- project/system document
- task resume card
- daily/periodic memory report
- source summary
- context map or atlas

Critical projections are updated immediately. Bulk and derived projections are
queued.

Immediate examples:

- explicit decision
- important preference/profile update
- active task handoff
- project/system compiled truth
- high-importance contradiction resolution

Queued examples:

- large document summary
- timeline rebuild
- source-wide digest
- daily report
- embedding/index refresh
- context map/atlas rebuild

Projection failures do not erase canonical assertions. They create
`pending_reconcile` or `projection_failed` status for the reconciler.

Markdown is not an alternate semantic source of truth. Human Markdown edits are
accepted as source input by creating a `markdown_file` source item with
`origin_event = markdown_edit`, extracting claims from the changed content,
resolving assertions, and applying canonical write policy. A reconciler may
repair projection metadata or hashes from Markdown where a structured projection
contract supports it, but it must not promote Markdown text directly into
canonical assertions.

## Codex And Claude Session Memory

Codex and Claude Code sessions are first-class sources, but their durable memory
is not stored only as assertions.

They produce:

- source records
- task events
- attempts
- decisions
- working sets
- retrieval traces
- handoffs
- extracted claims
- assertions
- projection mutations

Operational continuity remains in the task/session graph. Durable semantic
content is normalized into the shared assertion layer.

The task/session graph owns:

- sessions
- task threads
- task events
- task attempts
- working sets
- retrieval traces
- handoffs
- reverify states
- session grants
- session source grants
- session write grants

Session-scoped trust is evaluated from this graph. MCP clients, local runners,
and interactive CLI sessions do not inherit global trust only because they can
connect to MBrain.

Retrieval activates different layers by scenario:

- "continue this task": task/session graph first
- "what was decided": canonical assertions and projections first
- "why was this decided": canonical projection plus originating source/session
- "what did Codex do recently": session/task events first
- "is this code claim current": assertion plus live reverify

## Runtime Model

MBrain needs a durable Postgres-backed maintenance runtime, inspired by gbrain
Minions but scoped to memory maintenance.

Required runtime features:

- job table
- cycle lock table
- lease/heartbeat
- idempotency keys
- retry/backoff
- timeout
- progress
- structured result
- failure classification
- backpressure
- stale lock recovery
- foreground pressure yielding
- audit events

The runtime is not a general shell job platform. It does not expose arbitrary
agent runs as a primary product feature.

## Autopilot And Dream

Autopilot is a local daemon or scheduled process that runs maintenance cycles.
It can be installed through guided onboarding.

Supported host schedulers:

- launchd
- systemd
- cron fallback
- manual start for development

Dream is a phase runner, not a single report tool.

Dream phase families:

- source sync
- raw ingest
- extraction
- assertion resolution
- canonical write
- contradiction review
- consolidation
- forgetting review
- projection reconcile
- embedding/index refresh
- context refresh
- daily/periodic report
- eval/replay capture

## LLM And Local Runner Policy

Retrieval remains deterministic-first. LLM use is allowed for maintenance
quality when configured through onboarding.

MBrain uses a runner abstraction:

1. local Claude Code runner, when available and allowed
2. local Codex runner, when available and allowed
3. local model runner, such as Ollama or LM Studio
4. configured remote model provider
5. deterministic/report-only fallback

The runner is restricted to maintenance task types:

- assertion extraction
- consolidation review
- contradiction review
- forgetting review
- source summary
- daily report draft

It is not an arbitrary `mbrain agent run` platform.

Runner authority is task-type allowlisted. Canonical mutation is performed by
MBrain policy and mutation applier, not by the runner directly.

## Security And Privacy

Raw source text is untrusted data.

Prompt injection policy:

- instruction/data hard separation
- sanitizer/classifier at ingest
- flagged source write restrictions
- quarantine for high-risk injection or exfiltration attempts
- no tool access expansion based on source text

Secret policy:

- detect secrets during ingest
- redact before LLM/runner access
- ban secrets from canonical memory
- store metadata/hash/risk/remediation only
- prioritize redaction/purge for secret-bearing chunks

Raw access policy:

- scoped runner access only
- chunk/time/token/source limits
- sensitivity gates
- raw access ledger required
- runner cannot access connector credentials

MCP policy:

- local MCP clients are session-scoped, not globally trusted
- sessions carry realm, workspace, source grants, write policy, raw access
  policy, expiry, and close status
- raw personal source access requires explicit grant

Credential policy:

- external credential broker or credential gateway preferred
- OS keychain or password manager may be used when no broker/gateway is
  configured
- local encrypted vault is fallback only
- DB stores credential references, not secrets
- runner and agent sessions cannot read connector credentials

## Review And Audit UX

The default review surface is a daily or periodic memory report, not a manual
approval inbox.

Reports include:

- new canonical memories
- updated projections
- stale/expired/archived memories
- purge candidates and restore windows
- candidate/review items
- conflicts
- source ingest summary
- extraction summary
- runner/LLM token and cost estimates
- failed jobs
- reconciliation failures
- credential/source health

Users act on exceptions: undo, restore, pin, reject, pause source, purge, or
adjust policy.

## Implementation Strategy

Implementation is foundation-first and linear. The full target must be specified
now so later implementation sessions do not drift.

The phase specs are authoritative for ordering and acceptance:

- Phase 00: Postgres Foundation
- Phase 01: Source Registry And Policy
- Phase 02: Raw Ingest And Provenance
- Phase 03: Assertion Pipeline
- Phase 04: Governed Canonical Write
- Phase 05: Maintenance Runtime
- Phase 06: Autopilot Daemon
- Phase 07: Dream Cycle
- Phase 08: Lifecycle Forgetting
- Phase 09: Restricted Runner
- Phase 10: System Of Record Reconciler
- Phase 11: Personal Data Connectors
- Phase 12: Review, Audit, And Health
- Phase 13: Evaluation And Replay
- Phase 14: Migration And Cleanup

## Success Criteria

The redesign is complete when:

1. A fresh MBrain install uses local Postgres by default.
2. Raw personal sources can be registered with minimal consent.
3. Source items are ingested with provenance, chunking, sensitivity, and safety
   flags.
4. Extracted claims become assertions through a resolver/policy pipeline.
5. Source-backed eligible assertions automatically update canonical memory.
6. Canonical knowledge is represented in both Postgres and Markdown projections.
7. Autopilot runs safely under launchd/systemd/cron/manual modes.
8. Dream maintenance performs consolidation, contradiction review, forgetting,
   projection, and reporting.
9. Local Claude Code/Codex can be used as restricted maintenance runners.
10. Multiple agents and sessions can read/write safely without corrupting
    memory.
11. Forgetting changes retrieval behavior and storage lifecycle.
12. Reports show what changed, what was forgotten, what failed, and what needs
    attention.
13. Evaluation/replay can catch regressions in extraction, policy, retrieval,
    forgetting, and projection.
