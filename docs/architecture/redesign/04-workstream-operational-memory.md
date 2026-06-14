# MBrain Redesign Operational Memory Workstream

This document defines the operational-memory subsystem for `mbrain`. Its explicit purpose is repeated-work prevention: preserve enough durable task state that agents and users can resume ongoing work without re-reading the world from scratch, re-running the same dead ends, or losing the rationale behind prior choices.

## Scope

This workstream owns the canonical state required to continue active work across sessions:

- `Task Thread` as the durable container for a unit of work
- `Working Set` as the pinned continuation state for that thread
- `Event / Episode` as append-only operational history
- `Attempt / Decision` as the anti-repetition record of what was tried and what was chosen
- `Procedure` linkage and usage capture for reusable task execution patterns

This document does not redefine the derived orientation subsystem or the review and governance subsystem. It may reference those later workstreams only where operational memory depends on them at the boundary.

## Object Model

| Object | Role | Canonical Status |
|---|---|---|
| Task Thread | Durable container for multi-session work, including task identity, scope, status, goal, repo or branch context, linked episodes, and the stable historical envelope that continuity depends on. | Canonical, DB-backed. |
| Working Set | Focused continuation record for the active Task Thread: the current view of active files, active symbols, blockers, next steps, open questions, recent decisions, and known failed approaches that should shape the next move now. | Canonical, DB-backed. |
| Resume Card | Presentation view over the Working Set for CLI, MCP, or generated Markdown display. | Projection only, not canonical. |
| Event | Atomic operational record such as a message, tool call, file change, observation, or test run. | Canonical, DB-backed append-only record. |
| Episode | Session-level rollup of related Events, extracted Attempts, extracted Decisions, and continuity summary. | Canonical, DB-backed. |
| Attempt | Explicit record of an approach that was tried, including target files or symbols, commands, evidence, and outcome. | Canonical, DB-backed. |
| Decision | Explicit record of a choice, rationale, alternatives considered, consequences, and validity window. | Canonical, DB-backed. |
| Procedure Registry Entry | Searchable handle for a reusable operating procedure, linked to canonical Markdown procedure content and usage history. | Mixed canonical split: Markdown procedure content plus DB-backed registry and usage state. |

Operational memory is task-aware rather than fact-oriented. These objects exist to answer questions such as "where did we leave off?", "what already failed?", and "what decision is still in force?" before the system starts new analysis.

The authority boundary between the two top-level task objects is strict:

- `Task Thread` owns durable task identity and history: which unit of work this is, which scope and repo or branch it belongs to, what status it is in, and which Episodes, Attempts, Decisions, and procedures are attached to it.
- `Working Set` owns focused continuation state: what should be looked at next, which files or symbols are active now, which blockers matter now, and which next steps are currently justified.
- `Working Set` is therefore a canonical projection of the current best resume state for one `Task Thread`, not a competing owner of task identity or historical membership.

## Lifecycle

The lifecycle centers on maintaining continuity for an active Task Thread.

1. A task starts when a new Task Thread is created with scope, goal, and status.
2. As work proceeds, Events are appended for meaningful interactions, tool actions, file changes, observations, and verification results.
3. Related Events are rolled into Episodes so the thread has legible session boundaries rather than a flat event log.
4. Attempts and Decisions are extracted or recorded as first-class objects whenever the work reaches a meaningful trial, failure, partial success, or architectural choice.
5. The Working Set is refreshed whenever new information changes the best resume state for the thread.
6. The thread transitions through `active`, `paused`, `blocked`, `completed`, or `abandoned` while preserving prior operational history.
7. Repeated successful patterns or repeated failure-avoidance patterns are packaged as procedure candidates with supporting Attempts, Decisions, applicability conditions, and source task linkage.
8. Those procedure candidates cross the governance boundary for review, but the target lifecycle for what becomes a reusable procedure remains owned here.
9. Approved procedure candidates materialize as canonical Markdown procedures plus Procedure Registry Entries, with backlinks to the originating Task Thread, Attempts, Decisions, and later usage history.
10. Existing procedures can be recalled during active work, and their usage outcomes feed back into the Task Thread and Procedure Registry Entry.

Procedure lifecycle inside this subsystem spans the full operating path while still respecting the review boundary in `06-workstream-governance-and-inbox.md`:

- Operational memory discovers that a reusable pattern exists from repeated task history.
- Operational memory packages the pattern, evidence, applicability rules, and originating task context into a procedure candidate.
- Governance reviews whether the candidate is safe and durable enough to become a reusable procedure, but governance does not take ownership of the procedure model itself.
- On approval, this subsystem materializes or updates the Markdown procedure and its DB-backed Procedure Registry Entry.
- Operational memory links active Task Threads to procedures and records whether a procedure helped, failed, drifted, or became inapplicable.
- Later usage and decisions may supersede or retire a procedure, but those changes still flow back into the canonical procedure content and registry state owned here.

## Storage and Canonical Artifacts

Task-state objects are DB-backed. `Task Thread`, `Working Set`, `Event / Episode`, `Attempt`, and `Decision` all have canonical state in the operational database because they are update-heavy, query-heavy, and need durable joins across sessions.

The canonical storage rules for this subsystem are:

- Task-state objects are DB-backed and authoritative.
- `Task Thread` is authoritative for durable task identity, status, scope, and history linkage.
- `Working Set` is authoritative for focused continuation state and should be treated as the canonical "resume now" surface for the thread.
- Resume snapshots may have generated Markdown views, but DB state remains authoritative.
- Resume cards, generated thread summaries, and task-oriented reports are projections over canonical DB records.
- Procedures remain human-readable canonical artifacts in Markdown, with DB-backed registry metadata used for search, applicability checks, usage counters, and task linkage.
- Derived task maps or orientation reports may help navigation, but they do not replace Task Thread or Working Set as the canonical source for active-work continuity.

If the two records diverge, the resolution rule is object-specific rather than last-write-wins:

- task identity, scope, status, and historical linkage come from `Task Thread`
- active files, active symbols, blockers, open questions, and next-step continuity come from `Working Set`
- divergence between them is treated as an operational inconsistency that should trigger Working Set refresh or task verification rather than silent merge logic

This split keeps operational memory fast to update while preserving Markdown where humans need to inspect and refine reusable procedures directly.

## Retrieval Behavior

Resume flows read task-state objects before raw sources. This ordering is mandatory because repeated-work prevention depends on recovering prior work state before re-opening the repository or source corpus.

The operational retrieval route for active work is:

1. Resolve the active or requested Task Thread.
2. Read the current Working Set.
3. Read recent Episodes for the latest session context.
4. Read recent Decisions and failed Attempts.
5. Read linked procedures if they are relevant to the current blocker or next action.
6. Verify active files, symbols, branch assumptions, or tests where the Working Set depends on code-sensitive claims.
7. Only then inspect raw source files, notes, or other artifacts.

This route has two hard requirements:

- Failed approaches and prior decisions must be surfaced before proposing new actions.
- Raw-source expansion is justified only after the thread state explains what the system is trying to continue.

If derived orientation artifacts exist, they may help narrow which files or notes to inspect after step 5, but task resume remains centered on Task Thread and Working Set rather than on any map-first route.

## Resume UX

The resume experience is a projection over canonical operational memory, not a separate store. Whether surfaced through CLI, MCP, or a generated Markdown view, a resume response should make continuation obvious.

A resume projection should include:

- current goal and current subtask
- status and latest thread summary
- active files and symbols
- blockers and open questions
- next steps that remain justified
- recent Decisions still in force
- known failed approaches that should not be repeated blindly
- linked procedures worth recalling now
- latest verification timestamp and any stale-state warning

The UX objective is not just "summarize the task." It is "make the next correct action cheaper than restarting the investigation." A good resume view suppresses duplicated reasoning by showing what matters, what failed, and what still needs verification.

## Staleness and Verification

Operational memory is durable history, but some of its claims can become stale. The subsystem therefore preserves past work while re-checking any claim whose correctness depends on the current workspace or current external state.

Staleness should be tracked at the Working Set, Decision, and procedure-applicability boundaries when any of the following occur:

- the active branch changes
- a referenced file path no longer resolves
- a referenced symbol moves, is renamed, or disappears
- previously observed test behavior changes
- environment assumptions or dependency versions change materially
- the last verification timestamp is too old for the task's risk level

Verification rules:

- Historical Events, Episodes, Attempts, and Decisions remain valid as history even when their conclusions require re-checking.
- Code-sensitive next steps must be revalidated before they are presented as current truth.
- A failed `Attempt` is suppressive only while its applicability assumptions still hold for the current branch, symbol layout, test behavior, environment, and dependency context.
- If any of those applicability anchors drift materially, the failed `Attempt` remains visible as historical evidence but drops from "do not retry" to "retry only after revalidation" status.
- Attempts should therefore carry enough applicability context to explain why the failure happened and what would have to stay true for that failure to continue suppressing the same approach.
- A stale failed `Attempt` may still warn the system to inspect the old failure first, but it should not veto a retried approach without a fresh check that the prior failure conditions still exist.
- Decisions may carry explicit validity windows or supersession links so old rationale is preserved without being mistaken for current policy.
- Working Set entries should distinguish "historical memory" from "currently verified state" when the thread crosses branch or time boundaries.
- Procedure applicability should be rechecked against current preconditions instead of assumed from past success alone.

The system should degrade by warning and revalidation, not by deleting operational memory. Repeated-work prevention still benefits from seeing the prior failed path even when the underlying workspace has changed.

## CLI/MCP Surface

This subsystem should be exposed through contract-first operations that both CLI and MCP can project, rather than by burying active-work logic inside a CLI-only path.

Minimum operation families:

- task creation and status transitions: start, pause, block, complete, abandon
- task discovery: list active threads, search threads, fetch a specific thread
- resume reads: get working set, get recent episodes, get recent attempts, get recent decisions
- task-state updates: refresh working set, append event, roll up episode
- anti-repetition capture: record attempt, record decision
- procedure recall and usage capture: search procedures, link procedure to task, record procedure use
- verification: verify task continuity, verify code references used by the working set

Representative interface projections:

```bash
mbrain task start "mbrain redesign operational memory doc"
mbrain task resume
mbrain task working-set
mbrain task remember-attempt --failed --reason "heading drifted into full-system retelling"
mbrain task decide "Keep task-state canonical in DB" --rationale "high-churn operational state"
mbrain procedure search "resume workflow"
mbrain verify task <task-id>
```

```text
resume_task
get_working_set
search_tasks
search_attempts
search_decisions
search_procedures
verify_task
verify_code_reference
```

The exact command and tool names can evolve, but the public contract should preserve the same semantics across CLI and MCP surfaces.

## Current Operational Memory Scenario Evidence

The current scenario suite adds operational-memory evidence that is newer than
the GA-P0 through GA-P7 roadmap checkpoints.

- S33 agent-session memory loop is operational-memory evidence: session-derived
  signals still need the task, scope, and continuation boundaries defined here.
- S34 agent-session auto-capture proves agent-session raw-ingest and capture
  behavior. It is raw-ingest evidence, not connector acceptance, and it does not
  move source-choice ownership out of Phase 11.
- S35 prompt-injection suppression health proves suppression/report visibility
  around quarantined session-derived signals. It supports Phase 12 health
  evidence without moving report ownership into this workstream.
- S36 config-repointing guard proves init/config target changes remain explicit:
  a different local database path is refused without `--force`, and forced
  repointing preserves the prior config as a backup.
- These scenarios support the operational-memory contract, but they do not
  replace the Phase 10 projection, Phase 11 connector, or Phase 12 report
  acceptance boundaries owned by their respective workstreams.

## Tests and Evaluation

This subsystem succeeds only if it measurably reduces repeated work.

Required test areas:

- task resume ordering tests: confirm resume reads Task Thread and Working Set before raw-source inspection
- repeated-work prevention tests: confirm prior failed Attempts and Decisions are surfaced before proposing new actions
- working-set projection tests: confirm generated resume views stay consistent with canonical DB-backed task state
- episode rollup tests: confirm Events aggregate into Episodes without losing extracted Attempts or Decisions
- procedure recall tests: confirm applicable procedures are surfaced and usage outcomes are recorded
- stale code-memory detection tests: confirm branch, file, symbol, and test drift trigger revalidation rather than silent reuse
- CLI/MCP parity tests: confirm the same operational semantics through both interface surfaces

Required evaluation metrics:

- task resume accuracy
- repeated failed-attempt suppression rate
- decision reuse rate
- time-to-first-correct-next-action after resume
- stale code-memory detection rate
- procedure usefulness rate during repeated task patterns

The primary evaluation question is simple: after a pause, does the system continue the task from its own recorded state, or does it make the user pay to reconstruct that state again? Operational memory is only successful if the first path becomes the default.
