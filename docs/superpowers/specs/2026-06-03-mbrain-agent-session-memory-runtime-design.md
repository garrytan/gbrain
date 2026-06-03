# MBrain Agent Session Memory Runtime Design

Date: 2026-06-03
Status: Design spec
Source commit: 0ca974f076e2135ee1076dc18fe8155f45c80849
Scope: Agent/session memory loop for Codex, Claude, CLI, MCP, and future agent
session sources

## Goal

Make mbrain better as a personal memory runtime by closing the missing loop
between agent sessions and governed durable memory.

Agent and assistant sessions should become source-backed memory inputs. MBrain
should capture session events, redact sensitive material, compress observations,
summarize completed sessions, classify memory signals, route them through
existing writeback governance, and later activate relevant profile, episode,
task, and procedure memory in future sessions.

This design uses `reference/agentmemory` as a reference for observation capture,
zero-LLM compression, session summaries, lessons, and activation. It does not
clone agentmemory's storage model, index, or slot store.

## Product Thesis

MBrain already has strong memory authority surfaces:

- canonical Markdown pages
- profile memory
- personal episodes
- Memory Inbox candidates
- task memory
- retrieval traces
- scope gates
- mutation and lifecycle audit records

The weak point is not the shelf. The weak point is the agent-session memory loop:
mbrain needs a better way to notice what happened, summarize it, decide what kind
of memory it is, and make it available next time.

This feature improves mbrain most when it turns ordinary Codex/Claude sessions
into usable source-backed memory without making unreviewed inference look like
truth.

## Non-Goals

- Do not create a separate agentmemory-compatible database or KV store.
- Do not duplicate mbrain search, vector, or graph indexes.
- Do not add a separate pinned slot store.
- Do not turn compressed observations directly into canonical truth.
- Do not auto-delete or evict memories based on decay scores.
- Do not implement email, calendar, browser, Slack, Discord, or document
  connectors in this spec.
- Do not build a UI dashboard.
- Do not require paid live LLM calls for normal tests.

## Relationship To Existing Specs

This design composes existing mbrain architecture rather than replacing it.

- Phase 02 Raw Ingest And Provenance provides source items, chunks, hashes,
  prompt-injection flags, secret redaction, and raw access ledgers.
- The Memory Writeback Router provides the safe default route for durable
  memory signals.
- Phase 11 Personal Data Connectors names `agent/session import` as one of the
  connector classes. This spec narrows that broad connector class into a concrete
  agent-session memory loop.
- The Auto-Promotion design can later promote eligible candidates, but only
  through judge-only runners and deterministic canonical gates.
- Phase 08 Lifecycle Forgetting governs stale, expired, archived, purged, and
  tombstoned memory. This spec does not introduce decay-based deletion.
- Phase 13 Evaluation And Replay supplies the fixture strategy for source
  safety, extraction, policy, retrieval activation, and runner behavior.

## Core Decisions

### D1. Agent Sessions Are Sources

Codex, Claude, CLI, MCP, and future agent sessions are modeled as source-backed
inputs, not as a separate long-term memory store.

The source registry should identify:

- source kind: `codex_session`, `claude_session`, `agent_session`, or a future
  equivalent source class
- origin event: `session_capture`
- session id
- actor/client name
- repo path when present
- workspace/project identifier when present
- source timestamp
- content hash
- sensitivity flags
- prompt-injection flags
- redaction status

For `route_memory_writeback`, event-derived signals map to the existing
`source_kind` values:

| Agent/session event | Writeback `source_kind` |
|---|---|
| user prompt or assistant chat summary | `chat` |
| tool call, tool result, command, file/code event | `code_event` |
| session stop or session summary | `session_end` |
| later review of a recorded session | `trace_review` |
| explicit manual memory note | `manual` |

### D2. Capture Is Automatic; Authority Is Not

Capture may run automatically. Canonical authority does not.

The default route for captured, inferred, ambiguous, compressed, or session-end
memory is a Memory Inbox candidate or a non-authoritative derived artifact.

Direct canonical writes are allowed only when existing mbrain governance says
they are allowed. That means the signal has usable source refs, target binding,
scope fit, sensitivity fit, duplicate/conflict clearance, and the required
snapshot or personal write-target preflight.

### D3. Redaction And Scope Come Before Compression

MBrain must not compress raw secret-bearing session payloads first and redact
later. The safe order is:

```text
session event
  -> source metadata
  -> redaction and safety classification
  -> redacted source chunk
  -> compression and extraction
```

The runner/LLM path receives redacted text. Raw access is logged through the raw
access ledger when raw access is explicitly allowed.

### D4. Compression Produces Memory Input, Not Truth

Zero-LLM compression turns large or noisy session events into compact observation
records. It is an input to routing and retrieval orientation. It is not
answer-grounding truth.

The compressed observation shape should include:

```ts
interface AgentSessionCompressedObservation {
  id: string;
  source_item_id: string;
  source_chunk_ids: string[];
  session_id: string;
  event_ids: string[];
  observed_at: string;
  observation_type:
    | 'conversation'
    | 'tool_use'
    | 'tool_failure'
    | 'file_read'
    | 'file_write'
    | 'file_edit'
    | 'command_run'
    | 'search'
    | 'subagent'
    | 'session_summary'
    | 'other';
  title: string;
  narrative: string;
  facts: string[];
  concepts: string[];
  files: string[];
  importance_score: number;
  confidence_score: number;
  sensitivity: 'public' | 'work' | 'personal' | 'secret' | 'unknown';
  scope_id: string;
  source_refs: string[];
  generated_by: 'agent_session_capture';
}
```

### D5. Session-End Summaries Are First-Class Inputs

Session-end summaries are the highest-value agentmemory idea for mbrain.

At session end, mbrain should create a bounded summary of:

- user goals
- final outcome
- decisions made
- preferences or instructions stated by the user
- files or systems touched
- errors and fixes
- unresolved questions
- promised follow-ups
- candidate durable memory signals

Large sessions should be summarized by chunking and reducing the session event
stream. The final session summary is source-backed and redacted. It may create a
personal episode candidate, task continuation memory, profile update candidate,
procedure candidate, or canonical write candidate depending on classifier output.

### D6. Classification Is MBrain-Native

Agentmemory does not provide the exact classifier mbrain needs. MBrain should
define its own memory signal classifier.

Classifier output:

```ts
interface AgentSessionMemorySignal {
  id: string;
  source_observation_id: string;
  content: string;
  evidence_kind:
    | 'direct_user_statement'
    | 'source_extracted'
    | 'agent_inferred'
    | 'ambiguous'
    | 'contradicts_existing'
    | 'code_sensitive'
    | 'task_mechanics';
  signal_kind:
    | 'profile_memory'
    | 'personal_episode'
    | 'procedure'
    | 'task_memory'
    | 'project_note'
    | 'open_question'
    | 'no_write';
  target_object_type:
    | 'profile_memory'
    | 'personal_episode'
    | 'procedure'
    | 'curated_note'
    | 'other'
    | null;
  target_object_id: string | null;
  scope_id: string;
  sensitivity: 'public' | 'work' | 'personal' | 'secret' | 'unknown';
  confidence_score: number;
  importance_score: number;
  recurrence_score: number;
  source_refs: string[];
}
```

Routing defaults:

| Signal | Default route |
|---|---|
| Explicit stable user preference | `profile_memory` target via candidate or personal write preflight |
| One-time personal event | `personal_episode` target via candidate or gated episode write |
| Reusable workflow or lesson | `procedure` candidate |
| Project/system durable note | `curated_note` candidate or governed canonical write |
| Task continuation detail | task memory operation |
| Ambiguous inferred preference | Memory Inbox candidate |
| Contradiction | Memory Inbox candidate or conflict workflow |
| Secret or unknown sensitivity | defer, quarantine, or redaction review |
| Pure command mechanics | no durable write |

### D7. Activation Must Preserve Authority Labels

The feature only improves mbrain if remembered context is available in future
sessions. Activation must be selective and authority-aware.

Activation should be built on existing retrieval surfaces:

- `retrieve_context`
- `read_context`
- profile memory lookup
- personal episode lookup
- task memory lookup
- candidate signal lookup
- context maps and atlases

Activation output must preserve whether a memory is:

- canonical compiled truth
- profile memory
- personal episode
- task decision
- timeline/source evidence
- Memory Inbox candidate
- derived orientation

Candidates and derived summaries may orient the agent, but they are not
answer-grounding truth.

### D8. Recurrence Improves Ranking, Not Truth

Repeated signals should increase review priority and activation relevance. They
do not by themselves make a memory true.

Recurrence should feed:

- Memory Candidate `recurrence_score`
- duplicate/backlog grouping
- review priority
- activation ranking
- auto-promote eligibility when paired with safe evidence and policy

Recurrence must not bypass provenance, target binding, scope gate, or
contradiction checks.

## Architecture

```text
Agent/assistant session
  -> Agent Session Source Adapter
  -> Source item + redacted source chunks
  -> Safety metadata and raw access ledger
  -> Zero-LLM compressed observations
  -> Optional LLM session summary through restricted runner
  -> Memory signal classifier
  -> Route selection:
       - route_memory_writeback
       - write_profile_memory_entry / write_personal_episode_entry preflight
       - task memory operations
       - procedure or curated-note candidates
       - no-write / defer / redaction review
  -> Memory Inbox / profile memory / personal episode / task memory
  -> Retrieval activation
  -> Maintenance:
       - recurrence
       - duplicate grouping
       - auto-promote
       - lifecycle state
       - daily report
```

## Components

### 1. Agent Session Source Adapter

Responsibility:

- accept events from Codex, Claude, CLI, MCP, and future agent clients
- normalize events into source registry input
- preserve session ids and event ids
- attach actor, repo, workspace, and client metadata
- create source items and redacted chunks
- never call canonical write operations directly

Minimum event classes:

- session start
- user prompt
- assistant response summary
- tool call
- tool result
- tool failure
- file operation
- command run
- subagent result
- session stop
- explicit user memory note

### 2. Agent Session Safety Processor

Responsibility:

- classify work, personal, mixed, or unknown scope
- detect secret-bearing text
- produce redacted chunks before compression
- record prompt-injection risk when raw text contains instruction attacks
- set `sensitivity`
- create provenance source refs
- fail closed on secret or unknown sensitivity when the target would be
  canonical

### 3. Zero-LLM Compression

Responsibility:

- create compact observation records without calling an LLM
- keep cost low enough for automatic capture
- provide useful title, narrative, type, files, importance, confidence, and
  source refs
- index or surface compressed observations only as derived or candidate inputs

The zero-LLM path should be the default. LLM compression is optional and belongs
behind runner policy, budget controls, and redacted input.

### 4. Session-End Summarizer

Responsibility:

- create a compact session summary at stop/session-end time
- chunk and reduce long sessions
- emit explicit memory signals for decisions, preferences, events, procedures,
  open questions, and task continuation items
- tag output as `source_kind: session_end`
- avoid canonical writes directly

### 5. Memory Signal Classifier

Responsibility:

- decide whether a signal is stable profile memory, personal episode, procedure,
  task memory, curated note, open question, no-write, or defer
- choose evidence kind
- choose target object type when known
- compute initial confidence, importance, and recurrence
- route through existing mbrain operations

This classifier is the main new product logic. It should be deterministic when
possible and runner-assisted only for ambiguous or high-value cases.

### 6. Writeback Integrator

Responsibility:

- call `route_memory_writeback` for durable memory signals
- call personal write-target preflight for explicitly safe profile or episode
  writes
- call task-memory operations for task continuation details
- create Memory Inbox candidates for inferred, ambiguous, contradictory,
  compressed-only, or target-uncertain signals
- preserve duplicate review and candidate lifecycle events

### 7. Activation Planner

Responsibility:

- select relevant memory for a new session or request
- separate profile memory, personal episodes, task decisions, procedures,
  candidates, and derived orientation
- cap injected context
- record retrieval traces
- keep candidate and derived authority labels visible

Activation should improve user experience by reducing repeated explanations and
by making previous decisions, preferences, and unresolved tasks easy to recover.

### 8. Maintenance Integration

Responsibility:

- update recurrence scores
- group duplicates
- surface candidate review backlog
- hand off eligible candidates to auto-promote
- lifecycle stale or expired operational memory
- produce daily or session digest reports

Maintenance must not silently delete personal memory. Deletion and purge remain
governed lifecycle operations.

## Safety Rules

1. Secret-bearing raw session text is redacted before compression or runner use.
2. Unknown or mixed scope defers unless the route is explicit.
3. Compression output is not canonical truth.
4. Candidate and derived artifacts are not answer-grounding truth.
5. Direct personal profile writes require personal scope and source refs.
6. Inferred preferences default to candidates unless recurrence and policy make
   them eligible for governed promotion.
7. Contradictions create candidates or conflict records, not silent overwrite.
8. Recurrence improves priority, not truth.
9. Auto-promote must use judge-only runners and deterministic mbrain gates.
10. Purge leaves tombstones and must not erase required audit records.

## User Experience Outcomes

This feature should make mbrain better in these concrete ways:

- fewer important preferences and decisions are lost
- future agents need fewer reminders from the user
- session continuation is easier
- Memory Inbox receives higher-quality candidates
- personal episodes capture what happened without treating every event as a
  stable fact
- profile memory becomes useful because it receives well-routed signals
- ambiguous or inferred memories remain reviewable instead of becoming truth
- retrieval activation feels personalized while still showing authority

## Objective Value Assessment

High-value improvements:

1. agent/session capture with redaction and source refs
2. zero-LLM compression
3. session-end summary
4. signal classification into profile, episode, candidate, task, and procedure
5. activation with authority labels

Medium-value improvements:

1. recurrence scoring
2. candidate dedup and review backlog
3. auto-promote eligibility for direct/source-extracted low-risk signals
4. daily digest

Lower-value improvements for this feature:

1. new BM25/vector/graph search implementations
2. separate slot storage
3. image/vision memory
4. broad personal data connectors beyond agent sessions

## Implementation Phases

### Phase 1: Capture And Safety

Add the agent/session source adapter and safety processor.

Deliverable:

- session events can become source items and redacted chunks
- source refs are available for later writeback
- scope and sensitivity are attached
- secret or unknown sensitivity fails closed for canonical routes

### Phase 2: Compression And Session Summary

Add zero-LLM compressed observations and session-end summaries.

Deliverable:

- individual events produce compact derived observations
- session stop produces a bounded session summary
- large sessions are summarized by chunk/reduce
- output is source-backed and marked non-authoritative

### Phase 3: Classification And Writeback

Add the mbrain-native memory signal classifier and writeback integration.

Deliverable:

- stable preferences route toward profile memory candidates
- one-time events route toward personal episode candidates
- reusable workflows route toward procedure candidates
- project/system notes route toward curated-note candidates
- task mechanics route to task memory or no-write
- all durable uncertain signals pass through `route_memory_writeback`

### Phase 4: Activation

Add authority-aware activation for future sessions.

Deliverable:

- relevant profile, episode, task, procedure, and candidate signals can be
  selected for context
- candidates and derived artifacts are labeled as non-authoritative
- retrieval traces record what was activated

### Phase 5: Maintenance And Evaluation

Add recurrence, dedup, auto-promote handoff, lifecycle reports, and replay
fixtures.

Deliverable:

- repeated signals improve review priority
- eligible low-risk candidates can flow to existing auto-promote
- stale or low-value operational session memory moves through lifecycle states
- replay fixtures cover redaction, classification, writeback, activation, and
  false canonical writes

## Test Strategy

Unit tests:

- event normalization preserves session id, event id, actor, source refs, and
  repo/workspace metadata
- secret text is redacted before compression
- unknown or mixed scope defers unsafe writes
- zero-LLM compression emits stable type/title/narrative/files/scores
- session summary emits bounded memory signals
- classifier routes stable preferences, personal episodes, procedures, task
  mechanics, contradictions, and ambiguous signals correctly
- writeback integrator calls `route_memory_writeback` for candidate routes
- activation planner preserves authority labels
- recurrence affects review priority without changing truth authority

Scenario tests:

- direct user preference becomes profile-memory candidate or governed profile
  write when the personal route is explicit
- inferred preference remains candidate
- one-time personal event becomes personal episode candidate
- tool failure becomes task/session memory, not profile memory
- contradiction creates a candidate/conflict path
- secret-bearing session text never reaches compression unredacted
- candidate signal is surfaced as orientation only, not answer-grounding truth

Replay fixtures:

- captured agent session with prompt, tool event, failure, and stop summary
- long session requiring chunk/reduce summary
- mixed work/personal session requiring explicit route
- repeated preference signal increasing recurrence
- stale session mechanics moving through lifecycle without deleting derived
  semantic memory

## Acceptance Criteria

- Agent/session events can enter mbrain as source-backed evidence.
- Redaction and sensitivity classification run before compression.
- Zero-LLM compression works without live LLM credentials.
- Session-end summaries produce bounded source-backed memory signals.
- Classification routes signals to profile memory, personal episode, procedure,
  task memory, Memory Inbox, no-write, or defer.
- Inferred, ambiguous, contradictory, compressed-only, secret, or unknown
  signals do not become canonical truth directly.
- Activation can retrieve relevant memory with authority labels preserved.
- Maintenance can rank repeated candidates without treating recurrence as truth.
- Existing `route_memory_writeback`, Memory Inbox, personal memory, retrieval,
  auto-promote, and lifecycle invariants remain intact.

## Success Metrics

- Fewer user reminders needed across sessions.
- More relevant profile and episode memory appears in future session context.
- Memory Inbox candidates have usable source refs and target hints.
- Candidate promotion preflight rejects unsafe auto-generated memories.
- No unredacted secret appears in compressed observations or runner prompts.
- Replay fixtures catch inappropriate canonical write regressions.
- Search and retrieval remain useful without treating candidates as truth.

## Final Recommendation

Build this as a mbrain-native agent session memory runtime.

The best product improvement is not copying agentmemory. The best improvement is
using agentmemory's strongest ideas to complete mbrain's own loop:

```text
capture -> redact -> compress -> summarize -> classify -> route -> activate -> maintain
```

That loop makes mbrain substantially more useful while preserving the governed
memory boundaries that make mbrain trustworthy.
