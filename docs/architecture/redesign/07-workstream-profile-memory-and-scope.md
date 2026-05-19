# MBrain Redesign Profile Memory and Scope Workstream

This document defines personal and profile memory for `mbrain`, along with the scope gates that keep work retrieval and personal retrieval from bleeding into each other. It owns `Profile Memory`, `Personal Episode`, scope-gate behavior, retrieval isolation, write isolation, and export or visibility boundaries for personal memory. It does not redefine operational task-memory internals from `04-workstream-operational-memory.md`, map-building mechanics from `05-workstream-context-map.md`, or general candidate-governance mechanics from `06-workstream-governance-and-inbox.md`.

## Scope

This workstream exists because `mbrain` needs durable personal memory without turning work retrieval into a noisy personalization layer or turning personal conversations into a leak of work-only context.

It owns:

- `Profile Memory` as canonical personal-scope durable memory
- `Personal Episode` as canonical personal-scope event history
- scope-gate rules that decide whether retrieval or write behavior is operating in work, personal, or explicitly mixed scope
- retrieval isolation rules between work and personal domains
- write isolation rules between work and personal domains
- export and visibility boundaries for personal memory

It does not own:

- Task Thread, Working Set, Attempt, Decision, or procedure lifecycles
- Context Map extraction and map-refresh internals, even though personal maps may later exist
- general promote, reject, supersede, contradiction, or candidate-scoring policy

The guiding rule is strict separation by default: personal memory is valuable, but it is not ambient context for work unless the user or policy makes that crossing explicit.

## Profile Memory Model

`Profile Memory` is the canonical store for durable personal-scope facts, preferences, routines, and user-specific background that should survive beyond a single conversation.

A profile record should capture at least:

| Field | Purpose |
|---|---|
| `id` and `scopeId` | Identify the record and bind it to personal scope. |
| `profileType` | Distinguish preference, routine, personal project, stable fact, relationship boundary, or other durable personal categories. |
| `subject` | Name what the record is about, such as sleep routine, writing preference, or personal side project. |
| `content` | Hold the actual durable memory content. |
| `sourceRefs` | Preserve provenance for why the record exists. |
| `sensitivity` | Mark public, personal, secret, or other visibility level. |
| `lastConfirmedAt` | Track when the memory was last reaffirmed. |
| `supersededBy` or validity metadata | Preserve evolution without silent overwrite. |
| `exportStatus` | Record whether any subset is eligible for selected Markdown export. |

Model rules:

1. Profile Memory is canonical for personal durable memory, but only within personal scope.
2. Profile records should hold durable or recurrent facts, not every transient utterance.
3. Selected Markdown export is allowed only for curated, explicitly permitted subsets; the DB-backed record remains authoritative.
4. Profile Memory is not a general user-style-preference bucket for work execution. Short-lived formatting or collaboration preferences still belong in operational work records such as the Task Thread and Working Set when they matter only to active work continuity.

## Personal Episode Model

`Personal Episode` is the append-only canonical history for meaningful personal-scope interactions, analogous to how operational memory uses episodes for work. It exists so personal memory can preserve history without flattening everything into stable profile facts.

A personal episode should capture at least:

| Field | Purpose |
|---|---|
| `id` and `scopeId` | Identify the episode and keep it inside personal scope. |
| `title` | Give the episode a compact human-readable summary. |
| `startTime` and `endTime` | Preserve temporal context. |
| `sourceKind` | Explain whether the episode came from a chat, note, import, meeting, reminder flow, or other personal channel. |
| `summary` | Capture what happened in the episode. |
| `eventRefs` or `sourceRefs` | Point back to the underlying evidence. |
| `candidateIds` | Link any later profile or note candidates without turning the episode into governance state itself. |

Episode rules:

1. Personal Episodes preserve history; they should not be collapsed automatically into Profile Memory.
2. Repeated patterns across episodes may justify durable profile records, but the promotion mechanics still belong to `06`.
3. Personal Episodes are visible for personal recall and personal timeline reconstruction, not for ambient work recall.

Together, Profile Memory and Personal Episodes preserve both stable personal facts and the history that explains how those facts emerged.

## GA-P4 Profile-vs-Compiled-Truth Routing

Profile Memory and Personal Episodes are canonical personal records, but they
are not curated Markdown compiled truth. GA-P4 requires the planner and
activation policy to expose that distinction directly:

- Profile Memory reports `profile_memory` authority, not `canonical_compiled_truth`.
- Personal Episodes report `personal_episode` authority, not `canonical_compiled_truth`.
- Both authorities require Scope Gate `allow` before they can become
  `answer_ground`; missing, denied, or deferred scope remains `scope_denied`.
- Supporting notes and Source Records may cite or explain the history behind a
  personal record, but they do not collapse profile records or episodes into
  compiled truth.
- If a personal signal is ambiguous, inferred, contradictory, or missing
  personal scope/sensitivity, route it to governance or defer it rather than
  writing a personal canonical record.

This lets an answer explain whether a personal claim came from stable profile
memory, a historical personal episode, supporting evidence, or reviewed compiled
truth.

## Scope Gate Rules

The `Scope Gate` determines which memory domain may participate in retrieval or writes for a given interaction. It is a first-order routing decision, not a cosmetic filter added after retrieval.

The default scope classes are:

| Scope | Typical Signals |
|---|---|
| `work` | repo paths, code, docs, issues, PRs, architecture, team or project execution |
| `personal` | routines, habits, life admin, personal projects, preferences, daily memory |
| `mixed` | explicit user request to connect work and personal context |
| `unknown` | request lacks enough information to permit safe retrieval across domains |

Scope-gate rules:

1. Work is the default for repository, coding, documentation, or team-execution requests.
2. Personal is the default for explicit personal-memory or daily-life requests.
3. Mixed scope requires explicit user intent or explicit policy support; it is never assumed.
4. Unknown scope should narrow or ask for clarification before durable cross-domain reads or writes occur.
5. The scope decision should be recorded in retrieval traces when it materially affects what the system was allowed to read or write.

The Scope Gate is what makes later retrieval and write isolation enforceable. Without it, personal memory becomes accidental prompt stuffing and work memory becomes a privacy risk.

## Retrieval Isolation Rules

Retrieval isolation is the concrete consequence of the Scope Gate.

Rules for work retrieval:

1. Do not read Profile Memory or Personal Episodes by default.
2. Do not load personal map reports or personal atlas entries unless scope has already been allowed to cross into personal memory.
3. Do not treat personal routines or preferences as ambient work hints unless the request explicitly asks for that crossover.

Rules for personal retrieval:

1. Do not read Task Threads, Working Sets, work Attempts, work Decisions, or work-only source artifacts by default.
2. Do not inject private repo or team context into personal answers.
3. Personal recall may use personal maps or derived personal orientation artifacts only after the scope gate has already allowed personal retrieval.

Rules for mixed retrieval:

1. Mixed retrieval must name or justify the cross-scope bridge it is using.
2. Mixed retrieval should load the minimum necessary cross-domain context instead of flattening both domains into one giant recall set.
3. Retrieval traces should make the cross-scope decision visible when it mattered to the answer.

The default posture is isolation, not convenience.

## Write Isolation Rules

Write isolation prevents the system from normalizing unsafe storage behavior just because a retrieval step happened to be useful.

Rules:

1. Work interactions write to work domains by default, not to Profile Memory.
2. Personal interactions write to Profile Memory or Personal Episodes by default, not to work memory.
3. Mixed interactions must resolve their target domain explicitly before durable writes occur.
4. Ambiguous personal facts should stay out of durable memory until the scope and sensitivity are clear; if they need review, they may enter governance state without this document redefining governance.
5. Imported or observed personal artifacts retain their personal sensitivity unless explicitly reclassified.
6. Work-only internal information must not be copied into personal memory as a convenience summary.
7. Personal summaries that are safe for export still remain personal-scope records unless an explicit publication step changes their visibility class.

The key boundary is that scope determines destination. Retrieval convenience is never a sufficient reason to change memory domain.

## Corpus Lane Scope Boundary

Personal corpus lanes may help retrieval explain which corpus contributed a
result, but they do not decide whether a request is work, personal, or mixed.

The lane resolver runs after the Scope Gate.

Rules:

1. A lane cannot turn work retrieval into personal retrieval.
2. A lane cannot turn personal retrieval into work retrieval.
3. A lane cannot authorize a write into Profile Memory, Personal Episodes,
   Task Threads, Working Sets, curated Markdown, or governance state.
4. Profile Memory routing still follows the Scope Gate and write isolation rules.
5. Mixed-scope retrieval must still name the cross-scope bridge even when both
   sides have lane metadata.
6. Lane-aware citations should include the lane only as provenance metadata, not
   as a replacement for source refs or scope decisions.

Useful lane examples inside personal `mbrain`:

| Lane | Scope relationship | Allowed use |
|---|---|---|
| `notes` | Work or personal, depending on resolved scope | Citation and import provenance. |
| `worktree` | Usually work | Code/source orientation after work scope is allowed. |
| `transcripts` | Work, personal, or mixed by source | Source evidence after scope classification. |
| `imports` | Determined by source artifact | Provenance and derived refresh selection. |

## Export and Visibility Boundaries

Personal memory is not automatically as shareable as work notes.

Visibility rules:

1. Profile Memory is private to personal scope unless a record is explicitly marked otherwise.
2. Personal Episodes are private by default and should rarely be exported in raw form.
3. Selected Markdown export is allowed only for curated subsets that the user would reasonably expect to inspect, diff, or back up outside the DB-backed store.
4. Work-scoped exports, sync operations, and shared reports must exclude personal memory by default.
5. Public or team-visible artifacts must not include personal records unless the user explicitly authorizes that exposure.
6. Personal scope may include its own derived orientation artifacts, but those artifacts inherit the same visibility limits as the underlying domain.

Export rules exist to preserve two different expectations at once:

- work memory should remain operationally useful and shareable where appropriate
- personal memory should remain private, bounded, and deliberately visible only when the user intends it

## Tests and Evaluation

This workstream is successful only if the system can remember personal context without turning scope boundaries into guesswork.

Required test areas:

- scope classification tests for work, personal, mixed, and unknown requests
- retrieval isolation tests that confirm work queries do not read personal records by default
- retrieval isolation tests that confirm personal queries do not read work-only operational memory by default
- write routing tests ensuring work interactions do not create Profile Memory records accidentally
- personal-write tests ensuring personal interactions create Profile Memory or Personal Episodes in the right domain
- mixed-scope tests confirming explicit cross-scope intent is required before retrieval or writes cross domains
- retrieval-trace auditability tests confirming scope decisions and cross-scope retrieval paths are recorded when they materially affect an answer
- export filter tests preventing personal data from appearing in work-visible or public artifacts
- visibility inheritance tests confirming personal maps or summaries remain bounded by personal scope

Required evaluation questions:

- Is personal recall useful without requiring the user to restate routines, preferences, or ongoing personal projects?
- Are work answers staying free of irrelevant personal memory?
- Are personal answers staying free of work-only internal context?
- Are export and sync paths preserving the user's privacy expectations?

The subsystem is successful only if it achieves both goals at the same time: durable personal memory and reliable work-personal isolation.
