# MBrain Redesign Evaluation and Acceptance Contract

This document is the shared measurement contract for the redesign doc set. It aligns with the boundaries established in `00-principles-and-invariants.md` through `07-workstream-profile-memory-and-scope.md` and does not redefine subsystem internals, storage schemas, routing logic, or rollout mechanics.

Its job is to define how the redesign proves that it works: which baselines must exist, which outcomes must be measured, which phase gates must be satisfied, and which regressions must stop the rollout.

## Scope

This contract owns:

- baseline metrics for the redesign program
- repeated-work prevention evaluation
- markdown knowledge retrieval evaluation
- context map utility evaluation
- governance precision evaluation
- memory operations control-plane evaluation
- local and offline performance evaluation
- phase acceptance criteria
- regression triggers and rollback thresholds

It does not own:

- the operational-memory object model from `04-workstream-operational-memory.md`
- the map-layer object model or refresh mechanics from `05-workstream-context-map.md`
- the governance state machine from `06-workstream-governance-and-inbox.md`
- the profile-memory and scope-gate rules from `07-workstream-profile-memory-and-scope.md`
- implementation-specific benchmarking code or test harness wiring

The contract is intentionally shared. Each earlier document owns a subsystem boundary; this document owns the evidence required to accept those boundaries as successful.

## Shared Measurement Principles

1. Baselines must be captured before a phase claims improvement over current behavior.
2. Every metric must be comparable across the same scope, same backend, and same runtime assumptions used by the phase being evaluated.
3. Local and offline operation are first-class evaluation modes, not fallback-only special cases.
4. Derived artifacts may improve evaluation, but they do not replace canonical evidence.
5. A phase is not accepted because it "feels better"; it is accepted because the measured contract improves without violating boundary rules from `00` through `07`.
6. If a metric changes meaning across phases, the contract must restate the metric rather than silently reusing the old name.

## Baseline Metrics

The redesign uses a small set of baseline families so later measurements stay comparable instead of drifting into ad hoc success claims.

| Baseline Family | What It Measures | Source of Truth | Why It Matters |
|---|---|---|---|
| Repeated-work baseline | How often the system repeats dead ends, re-reads the same material, or restarts analysis that should have been resumed. | Operational memory and task-resume traces. | Phase 1 and later phases must prove that continuity is improving, not merely being recorded. |
| Markdown retrieval baseline | How quickly and accurately the system finds canonical notes, procedures, headings, and source-linked Markdown artifacts. | Markdown corpus and retrieval traces. | The redesign keeps Markdown as a first-class canonical interface. |
| Context-map baseline | How much raw search the system needs before a derived map becomes useful. | Map queries, map reports, and follow-up source reads. | Derived orientation is only valuable if it reduces search burden without replacing canonical sources. |
| Governance baseline | How often review, promotion, rejection, and supersession decisions are correct on the first pass. | Inbox state transitions and review outcomes. | Candidate handling must get cleaner, not noisier, as derived signals increase. |
| Memory operations baseline | Whether governed mutations carry authorization, target snapshot evidence, dry-run behavior, and redaction safety without leaking sensitive data through audit surfaces. | Memory mutation events, memory realms, sessions, patch candidates, redaction plans, and health reports. | Durable memory writes need an operator-grade control plane once candidates can affect canonical state. |
| Provenance and trace baseline | Whether Source Records stay intact and Retrieval Traces stay complete enough to explain read and write behavior later. | Source Records and Retrieval Traces. | Evaluation fails if outcomes improve while provenance or explainability fragments. |
| Local-performance baseline | How the system behaves in local or offline execution, including latency and throughput under the supported contract. | Local execution traces and benchmark runs. | Local-first remains a hard architectural constraint. |
| Scope-isolation baseline | Whether work, personal, and mixed requests stay inside the correct boundaries. | Retrieval traces and scope-gate records. | Scope leakage is a correctness failure, not a ranking issue. |

Baseline capture rules:

- capture baselines on the same class of input the phase is expected to improve
- prefer repeatable workloads over one-off success stories
- record the environment and backend alongside the metric
- keep the baseline payload small enough that later comparisons are readable
- refresh the baseline only when the contract itself changes, not when the result is inconvenient

## GBrain Absorption Replay Fixture Contract

GBrain-style replay is useful only if it measures `mbrain` boundaries, not just
retrieval overlap. Replay fixtures for this roadmap must preserve enough fields
to evaluate retrieval, governance, scope, code verification, and maintenance
apply behavior.

GA-P fixture namespace: absorption fixtures use `GA-P*` stage identifiers so
they do not collide with the existing redesign phase acceptance packs.

Minimum fixture shape:

```json
{
  "fixture_id": "ga-p1-example",
  "stage_id": "GA-P1",
  "query": "resume the retrieval routing task",
  "requested_scope": "work",
  "expected_intent": "task_resume",
  "expected_canonical_refs": ["task_thread:example"],
  "candidate_authority": "candidate_only",
  "lane_scope_decision": {
    "scope_id": "work",
    "lane_id": "worktree",
    "lane_grants_authority": false
  },
  "code_verification": {
    "required": true,
    "repo_path": "/path/to/repo",
    "expected_mode": "live_workspace_check"
  },
  "maintenance_apply_result": {
    "allowed_without_control_plane": false,
    "requires_realm_session": true,
    "requires_mutation_ledger": true,
    "requires_target_snapshot": true
  }
}
```

Replay rules:

1. Fixtures must identify expected canonical refs separately from candidate
   signals and derived refs.
2. Candidate authority must be explicit: `answer_ground`, `candidate_only`,
   `historical`, or `not_expected`.
3. Lane decisions must record that lanes do not grant authority.
4. Code verification must state whether live workspace checks are required.
5. Maintenance apply expectations must state whether realm/session, mutation
   ledger, and target snapshot checks are required.
6. A replay pass fails if retrieval gets the right text by violating scope,
   candidate authority, or control-plane boundaries.

## GBrain Absorption GA-P2 Evaluation Foundation

GA-P2 turns the replay contract into a focused regression foundation before
later absorption phases add stronger behavior. It does not introduce a new
runtime service. It binds hand-authored or captured replay cases to existing
SQLite-capable verification surfaces so search, code-lane, maintenance, and
corpus-lane changes can be evaluated before and after a patch.

| Fixture family | Existing verification surface | Regression guarded |
|---|---|---|
| retrieval_regression | `retrieve_context` + `read_context` | Probe candidates stay non-authoritative until canonical evidence is read. |
| candidate_lifecycle_regression | Memory Inbox status events | Rejected candidate status history remains auditable without becoming answer-grounding truth. |
| task_resume_fidelity | `resume_task` / task working set | Resume output preserves current goal, blockers, failed attempts, decisions in force, and verification warnings. |
| scope_leak_regression | Scope Gate exact-selector denial | Work-scoped requests cannot disclose personal selectors, required reads, or candidate snippets. |
| derived_refresh_regression | context-map stale freshness checks | Derived maps and atlases disclose stale status and require canonical follow-through or rebuild before trust. |

GA-P2 fixture rules:

1. Fixture ids use the `ga-p2-` prefix and name the regression family.
2. Each family must map to one existing operation, service, or scenario surface
   rather than a placeholder metric.
3. The default SQLite scenario must exercise at least one real flow per family.
4. Candidate and derived outputs may be present in replay data, but the fixture
   must state their authority as `candidate_only`, `historical`, or
   `not_expected` unless a canonical read proves otherwise.
5. A GA-P2 pass is a measurement foundation only; it does not accept GA-P3+
   corpus-lane behavior, GA-P4 authority-model changes, or GA-P6 maintenance
   automation.

## GBrain Absorption GA-P3 Corpus Lanes

GA-P3 accepts corpus lanes only when executable tests prove they are provenance
metadata layered onto existing imports, retrieval selectors, reads, and traces.
The executable fixture is
`test/fixtures/gbrain-absorption/ga-p3-corpus-lanes.fixture.json`, and S29
exercises it through SQLite-capable import, retrieval, read, trace, and
writeback-router flows.

GA-P3 fixture rules:

1. The fixture uses `stage_id: "GA-P3"` and includes `notes`, `worktree`,
   `transcripts`, `imports`, and `derived` lane cases.
2. Every lane case records `lane_grants_authority: false`.
3. Every lane case preserves `scope_gate`, `source_record`, `import_origin`,
   `retrieval_trace`, and `canonical_selector` fields.
4. A replay pass fails if lane metadata changes selector identity or bypasses
   the Scope Gate.
5. Ambiguous imported source-extracted writeback must defer with
   `import_lane_required` rather than inventing a lane.

## GBrain Absorption GA-P4 Memory Authority

GA-P4 accepts the memory-authority slice only if the system can replay and
explain the authority of each artifact without adding a new facts/takes store.
The executable fixture is
`test/fixtures/gbrain-absorption/ga-p4-memory-authority.fixture.json`, and S28
exercises it through existing SQLite-capable services and operations.

The fixture has two families:

| Fixture field | Existing verification surface | Regression guarded |
|---|---|---|
| `authority_cases` | `select_activation_policy`, `plan_scenario_memory_request`, Profile Memory, and Personal Episode operations | Compiled truth, Profile Memory, Personal Episodes, historical evidence, candidates, and derived orientation report distinct authority labels. |
| `writeback_cases` | `route_memory_writeback` | Canonical page writes require target snapshots, personal targets require explicit personal scope and sensitivity, contradictions become candidates, and task mechanics remain no-write. |

GA-P4 fixture rules:

1. Profile Memory must report `profile_memory` authority only after scope
   `allow`; denied, deferred, or missing scope stays `scope_denied`.
2. Personal Episodes must report `personal_episode` authority only after scope
   `allow`; they are historical personal memory, not compiled truth.
3. Source Records and timelines remain citation-only historical evidence unless
   reviewed synthesis updates compiled truth.
4. Memory Candidates remain candidate-only until promotion and canonical handoff
   preserve provenance, target object, scope, sensitivity, and target snapshot
   evidence.
5. Context maps, codemap pointers, and replay projections must keep derived projection system-of-record and rebuild rules explicit: the projection is rebuilt from canonical sources and never becomes the source of record itself.
6. GA-P4 does not add new database tables, Postgres-only behavior, or facts/takes
   storage.

## GBrain Absorption GA-P5 Code Lane

GA-P5 accepts the code-lane foundation only when executable replay proves that
code graph data stays derived orientation and current code claims pass through a
live workspace gate. The executable fixture is
`test/fixtures/gbrain-absorption/ga-p5-code-lane.fixture.json`, and S30
exercises it through codemap import, code-lane Context Map build, bounded graph
expansion, and `reverify_code_claims`.

The fixture has one family:

| Fixture field | Existing verification surface | Regression guarded |
|---|---|---|
| `code_lane_cases` | codemap import, `buildCodeLaneContextMapEntry`, `expandCodeLaneGraph`, and `reverify_code_claims` | Definition, reference, caller, callee, and nearby-context lookups remain orienting only; stale `expected_content_hash` claims fail as `content_hash_mismatch`. |

GA-P5 fixture rules:

1. Code-lane runtime entries are derived orientation, not current code truth.
2. Chunk-grain metadata is required before graph-walk retrieval can become
   default.
3. Symbol graph expansion is opt-in, depth-limited, fanout-capped, and bounded.
4. Extractor/chunker version changes must invalidate or rebuild derived
   code-lane artifacts.
5. Current code claims require live file, symbol, branch, and content-hash
   verification.
6. `definition_lookup`, `references_lookup`, `callers_lookup`, `callees_lookup`,
   `nearby_context`, and `stale_code_claim` cases must all record
   `lane_grants_authority: false`.

## GBrain Absorption GA-P6 Personal Maintenance Cycle

GA-P6 accepts the personal maintenance contract only when replay proves that
maintenance is report-first and apply remains inside the Phase 9 control plane.
The executable fixture is
`test/fixtures/gbrain-absorption/ga-p6-personal-maintenance-cycle.fixture.json`,
and S31 replays the runtime report, suggestion, derived freshness, and
control-plane guard behavior.

The fixture has two families:

| Fixture field | Existing verification surface | Regression guarded |
|---|---|---|
| `maintenance_report_cases` | report-only and suggestion-shaped fixture replay | Maintenance defaults to bounded reports, stale candidate review, duplicate merge suggestions, and derived freshness warnings without mutation. |
| `maintenance_apply_control_cases` | Phase 9 memory operations control-plane invariants | Apply requires active realm/session, mutation ledger, target snapshot, dry-run/apply parity, and redaction fail-closed behavior. |

GA-P6 fixture rules:

1. Phase 8 accepts report and suggestion quality only when no canonical mutation
   occurs by default.
2. Phase 9 accepts apply only through the existing memory operations control
   plane; maintenance does not define a parallel write path.
3. `report_only_default`, `stale_candidate_review`,
   `duplicate_merge_suggestion`, and `derived_artifact_freshness` must remain
   non-mutating replay cases.
4. `candidate_write_governed_not_truth`, `apply_requires_realm_session`,
   `apply_requires_target_snapshot`, `dry_run_apply_validation_parity`, and
   `redaction_fail_closed` must preserve the same replay expectations as
   interactive governed memory operations.

## Repeated-Work Prevention Evaluation

This evaluation corresponds to the operational-memory workstream and later phases that depend on resume quality.

The required measures are:

- task resume accuracy
- repeated failed-attempt suppression rate
- decision reuse rate
- time to first correct next action after resume
- stale-memory detection rate for branch, file, symbol, or test drift
- prior-analysis surface rate, meaning how often the system surfaces prior failed paths before proposing new work

Acceptance rules:

1. The system must recover the active task state before re-opening raw sources for resume-oriented work.
2. Failed approaches must stay visible as historical evidence and suppress repeated mistakes when their assumptions still hold.
3. The resume path must reduce duplicate investigation compared with the baseline, not simply report that a task exists.
4. Code-sensitive task claims must be revalidated before they are treated as current truth.
5. If repeated-work metrics improve while stale-state detection worsens, the phase is not accepted.

This evaluation is successful when the next action becomes cheaper because the system remembered what already failed.

## Memory Lane Update Cadence Matrix

This matrix is evaluation guidance, not retrieval authority. Retrieval remains
intent- and scope-driven, and `read_context` remains the answer-grounding
boundary.

| Lane | Update Cadence | Authority | Staleness Rule | Promotion Or Refresh Path |
|---|---|---|---|---|
| Session context | Immediate, ephemeral | Current conversation only | Expires with session context | Durable writeback routes to candidate, task, or canonical write. |
| Working Set | Fast, task-scoped | Canonical operational resume state | Stale when branch, path, symbol, test, or blocker changes | Refresh working set and record attempts or decisions. |
| Retrieval Trace | Per meaningful memory interaction | Canonical audit record | Historical, not current truth | May feed Memory Candidate creation. |
| Memory Candidate | Fast capture, slower review | Canonical governance state, not truth | Stale when unresolved beyond review window or contradicted | Reject, promote, supersede, redact, or hand off. |
| Candidate Signal | Per retrieval probe | Non-canonical exposure lane | Stale when underlying candidate status changes | Recompute from Memory Inbox state. |
| Context Map / Atlas | Background or source-change refresh | Derived orientation | Stale when source hash, extractor version, task, or code anchor changes | Rebuild or warn; never promote directly. |
| Compiled Truth | Slow, reviewed update | Canonical answer evidence | Stale when superseded or source evidence changes | Patch with provenance and target snapshot checks. |
| Profile Memory | Slow, scoped update | Canonical personal memory | Stale when unconfirmed, superseded, or scope changes | Write through personal scope preflight. |
| Personal Episode | Append-only personal event capture | Canonical personal history | Historical by design; stale only when superseded by correction metadata | Record through personal episode write path; derive profile updates through governance. |

## Markdown Knowledge Retrieval Evaluation

This evaluation measures whether curated Markdown remains the canonical and usable interface for knowledge retrieval.

Required measures:

- exact note retrieval success rate
- exact procedure retrieval success rate
- heading-level lookup precision
- source-linked retrieval precision
- citation completeness for retrieved claims
- markdown-first answer rate for questions that are primarily about curated knowledge

Acceptance rules:

1. If the exact Markdown artifact exists, retrieval should prefer it over a summary or a derived explanation.
2. Heading and path references must remain usable as stable entry points.
3. Retrieved answers must stay grounded in canonical Markdown rather than in derived map edges or remembered summaries alone.
4. Retrieval should not require the user to restate obvious headings, note names, or procedure names that already exist canonically.
5. If retrieval quality improves only by widening scope or relaxing precision, the phase does not meet the contract.

The core question is whether the redesign makes Markdown easier to find, easier to cite, and easier to trust.

## Context Map Utility Evaluation

This evaluation measures whether derived orientation helps the system navigate without becoming authority.

Required measures:

- raw-search reduction for broad synthesis tasks
- map-report usefulness for identifying the right entry points
- path-explanation usefulness for bridge discovery
- bounded-output adherence for map queries
- stale-map detection accuracy
- map-to-canonical follow-through rate, meaning whether map output leads to the right canonical source instead of stopping at the map

Acceptance rules:

1. Context maps must reduce search effort for broad questions.
2. Map output must stay compact enough to use during answer time.
3. A map edge or cluster is only useful if it leads back to canonical sources that can justify the result.
4. Stale maps must fail safe by warning or falling back, not by pretending to be fresh.
5. If map utility improves while canonical-source grounding weakens, the phase is not accepted.

This evaluation succeeds only when the map is an orienting layer, not a truth replacement.

## Provenance and Retrieval Trace Evaluation

This evaluation measures whether the redesign preserves the canonical evidence trail needed to trust later metrics and rollback decisions.

Required measures:

- Source Record completeness rate for durable writes and promoted candidates
- Source Record link integrity, meaning promoted or reviewed claims still resolve to their canonical provenance destination
- Retrieval Trace completeness for scope, route, verification, and write-outcome fields
- retrieval-trace coverage rate for flows that require durable explainability
- rollback audit continuity for Source Records and Retrieval Traces across phase changes

Acceptance rules:

1. Durable writes and promoted candidates must remain linked to canonical provenance rather than to ephemeral summaries alone.
2. Retrieval Traces must capture enough route and verification detail to explain how a durable answer or write decision happened.
3. Explainability records must remain readable across phase changes and rollback boundaries.
4. If task, governance, or retrieval outcomes improve while provenance fragments or trace completeness drops, the phase is not accepted.

This evaluation succeeds only if later measurements and investigations still have canonical evidence to stand on.

## Governance Precision Evaluation

This evaluation measures whether the inbox boundary keeps derived signals from polluting canonical memory.

Required measures:

- promotion precision
- rejection precision
- supersession precision
- duplicate candidate handling effectiveness
- scope and sensitivity leak rate
- contradiction resolution accuracy
- stale code-sensitive claim rejection rate

Acceptance rules:

1. A candidate must not be promoted without provenance, scope fit, and a valid target domain.
2. Work-visible and personal-visible memory must remain isolated according to the scope rules in `07`.
3. Contradictions must remain explicit until they are resolved, rejected, or superseded intentionally.
4. Duplicate or recurring candidates should improve triage instead of multiplying review burden.
5. Claims that depend on current workspace state must be rechecked before promotion or supersession.

Governance is successful when the system learns from uncertain signals without making canonical memory noisier.

## Memory Operations Control-Plane Evaluation

This evaluation measures whether durable memory mutation is authorized,
auditable, conflict-aware, and safe for high-risk operations.

Required measures:

- mutation ledger coverage for mutating memory operations
- denied, conflict, failed, dry-run, staged-for-review, and redacted result fidelity
- memory realm and session authorization correctness
- target snapshot conflict detection before canonical writes
- patch candidate review and apply correctness
- redaction plan fail-closed behavior for unsupported or stale targets
- applied-redaction privacy, meaning raw redacted query and replacement text do
  not remain in MCP-readable applied plan or ledger surfaces
- bounded memory operations health reporting

Acceptance rules:

1. A privileged memory write must be tied to an active session and compatible
   read-write realm attachment when the operation requires scoped authority.
2. Dry-run and apply paths must preserve the same validation semantics without
   mutating targets during dry-run.
3. Target snapshot mismatch must record a conflict or fail explicitly instead of
   overwriting stale memory.
4. Redaction must fail closed on unsupported persisted matches and must refresh
   derived page storage after supported page redactions.
5. Applied redaction plan and ledger surfaces must not expose the raw redacted
   query or replacement text.
6. Health reports must disclose bounded or sampled counts without presenting
   them as complete counts.

The control plane is successful when memory writes are no longer just possible,
but reviewable, attributable, scoped, conflict-aware, and safe to inspect later.

## Local and Offline Performance Evaluation

This evaluation measures whether the redesign preserves the local-first contract while adding more structure around it.

Required measures:

- local startup latency
- local resume latency
- local lookup latency for canonical Markdown
- local map-build or map-refresh latency
- local import or sync throughput
- offline task completion success rate
- backend semantic parity at the public contract boundary

Acceptance rules:

1. The supported local path must remain usable without network dependence for its core contract.
2. Performance must be measured on the same workload class that the phase changes.
3. If one backend or local execution path behaves differently, the public contract must remain semantically aligned or the gap must stay behind an explicit non-default boundary.
4. Local improvements are not accepted if they depend on hidden backend assumptions that break parity.

The local/offline evaluation is successful only if the redesign remains a local product, not a cloud-only one with a local shell.

## Default Acceptance Thresholds

The redesign uses shared pass/fail bars so phase acceptance is not negotiated ad hoc after results arrive.

Unless a phase declares a stricter threshold before implementation begins, these defaults apply:

| Threshold Class | Minimum Bar | Failure Condition |
|---|---|---|
| Primary improvement threshold | At least one primary metric owned by the phase improves by `>=10%` relative to the recorded baseline. | The phase claims a workflow win but no primary metric clears the minimum improvement bar. |
| Guardrail non-regression threshold | Non-targeted core metrics and subsystem guardrails may not regress by more than `5%` relative to baseline. | A phase improves one target metric while materially degrading another core contract. |
| Provenance completeness threshold | Durable writes and promoted candidates must maintain `100%` Source Record completeness on the acceptance workload. | Any promoted or durable record lands without canonical provenance linkage. |
| Retrieval-trace completeness threshold | Required scope, route, verification, and durable-write fields must be present in `>=95%` of interactions that require durable explainability. | Trace coverage or required-field completeness drops below the threshold. |
| Safety threshold | Scope-leak incidents, promotion-bypass incidents, contradiction-bypass incidents, and public-contract parity breaks are all `0` on the acceptance workload. | Any one of those boundary failures appears in acceptance evidence. |
| Local/offline threshold | Core local/offline workloads must run without network dependence, and local latency or throughput may not regress by more than `10%` unless a stricter predeclared exception is approved in Phase 0. | The phase quietly shifts the supported local contract or exceeds the allowed local regression budget. |

Threshold rules:

1. A phase must satisfy the relevant threshold classes in addition to the qualitative acceptance rules below.
2. If a phase needs a stricter bar, that stricter bar must be declared before the phase starts, not after measurement is known.
3. If a metric cannot be compared against its baseline under the same workload assumptions, the threshold is considered unmet.

## Phase Acceptance Criteria

Each phase must satisfy the baseline family it is expected to improve, plus the boundary contracts it touches.

| Phase | Minimum Acceptance Criteria |
|---|---|
| Phase 0 | Baseline metrics are captured with `100%` workload coverage for the published acceptance workloads, backend and local-path parity is measured with `0` public-contract mismatches, and the execution envelope is explicit enough to support later comparison. |
| Phase 1 | Repeated-work prevention clears the primary improvement threshold while stale-state detection, Markdown continuity, and local/offline behavior stay within the guardrail and safety thresholds. |
| Phase 2 | Deterministic structural extraction clears the primary improvement threshold for orientation without weakening Markdown retrieval, canonical-source authority, or provenance completeness beyond the allowed thresholds. |
| Phase 3 | Context maps clear the primary improvement threshold for raw-search reduction or path finding while bounded-output adherence, freshness, and canonical follow-through stay within guardrail and safety thresholds. |
| Phase 4 | Reusable operating knowledge clears the primary improvement threshold through procedure usefulness or repeated-task-pattern reuse, without collapsing task state into procedure state or violating guardrail thresholds on task continuity. |
| Phase 5 | Governance clears the primary improvement threshold for promotion, rejection, or supersession precision while keeping scope leakage, provenance bypass, and contradiction bypass at the safety threshold of `0`. |
| Phase 6 | Higher-noise derived analysis remains constrained by governance, clears the relevant primary improvement threshold, and does not exceed the local/offline or guardrail regression thresholds. |
| Phase 7 | Later canonical knowledge consolidation preserves provenance, historical-validity safeguards, and current-evidence discipline with `100%` provenance completeness and no safety-threshold violations. |
| Phase 8 | The full redesign is measurable as a system, profile and scope isolation remain at the safety threshold of `0` known leakage incidents, and the baseline families remain comparable over time with no missing acceptance workloads. |
| Phase 9 | Memory operations control-plane behavior preserves scoped write authority, target snapshot conflict checks, mutation ledger coverage, redaction fail-closed semantics, post-apply secret tombstoning, MCP exposure, and health reporting with no safety-threshold violations. |

General acceptance rule:

1. A phase is accepted only if the metrics it is supposed to improve move in the right direction and none of the boundary failures in `00` through `07` are introduced or hidden.
2. A phase that improves one metric while regressing a boundary condition is not accepted.
3. A phase that cannot be measured against the baseline family it claims to improve is not accepted.

## Regression Triggers

The following conditions must trigger investigation and, if necessary, rollback or phase rejection:

- repeated failed attempts start reappearing without new evidence
- task resume requires manual reconstruction that the working set should already have preserved
- exact Markdown notes or procedures become harder to retrieve than their derived summaries
- map output starts being trusted without canonical follow-through
- promotion occurs without provenance, scope fit, or contradiction checks
- governed memory mutation occurs without required session or realm authority
- target snapshot conflicts are overwritten instead of recorded as conflicts or failures
- applied redaction leaves raw redacted query or replacement text in MCP-readable plan or ledger surfaces
- Source Records become incomplete, unresolvable, or fragmented across promoted memory
- Retrieval Traces stop recording scope, route, verification, or durable write outcomes needed for audit
- work memory and personal memory begin to mix without explicit scope permission
- local execution depends on network access for the phase's core contract
- parity between supported backend and local execution paths breaks at the public contract boundary
- stale derived artifacts are treated as current truth
- benchmark results are missing, stale, or not comparable to the published baseline family

Regression response:

1. Stop treating the phase as accepted.
2. Identify which baseline family or boundary rule failed.
3. Re-run the smallest comparable measurement that demonstrates the failure.
4. Route the issue back to the owning workstream doc if the failure belongs to a subsystem boundary rather than to evaluation itself.

## Acceptance Summary

The redesign is complete only when the measurement contract says it is complete. That means the system must demonstrate:

- cleaner repeated-work prevention
- reliable Markdown retrieval
- useful but bounded context-map orientation
- precise governance
- governed memory mutation
- preserved local/offline performance
- preserved scope isolation
- measurable, comparable results across phases

If the redesign cannot prove those outcomes, it is not finished, regardless of how good the architecture sounds on paper.

## Redesign Completion Appendix

As of the final acceptance closure, the redesign completion boundary is
implemented and measurable:

- `audit_brain_loop` is the loop-observability verification surface. It reports
  trace counts, intent/scope/gate distributions, canonical-vs-derived read
  ratios, linked write counts, approximate unlinked candidate activity, task
  compliance, and summary lines from structured trace columns and
  `interaction_id` joins.
- `retrieval_traces.id` is the durable interaction identity for the implemented
  loop-observability path. Governance writes that participate in the audited
  loop link back through `interaction_id`.
- `test/scenarios` has zero placeholders. S5, S9, and S11 now exercise
  request-level decomposition, canonical-first broad synthesis, and stale code
  claim verification respectively.
- CI runs `bunx tsc --noEmit --pretty false` before the default `bun test`
  job, so new production behavior lands under the TypeScript gate.
- Code-sensitive resume facts are reverified before being presented as current
  task state. Historical operational records are preserved even when a claim is
  stale or unverifiable.
- Phase 9 adds the memory operations control plane: mutation ledger events,
  memory realms and sessions, dry-run mutation checks, governed patch apply,
  redaction plan lifecycle, memory operations health reporting, and MCP
  acceptance coverage.
- Applied redaction plans tombstone the raw query and replacement text on
  applied plan surfaces, and ledger metadata avoids retaining those raw values.

The following remain outside this completion boundary unless promoted into a
new spec:

- trace retention, pruning, or TTL policy
- a dashboard or scheduled cron runner for loop observability
- an active-only task-compliance metric
- richer AST-aware code-claim verification beyond the current path, symbol, and
  branch-sensitive checks
- retention, pruning, or archival policy for memory mutation ledger events and
  applied redaction plans
