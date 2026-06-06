# MBrain Authority-First Memory Improvement Design

Date: 2026-06-06
Status: Design spec (approved in brainstorming, pending implementation plan)
Author: scott.lee + agent

## Goal

Improve MBrain's usefulness for Codex, Claude, and other agentic development
work by absorbing ideas from Hyper's Launch HN discussion and adjacent memory
systems into MBrain's existing architecture.

The goal is not to clone Hyper, build a larger RAG stack, or make Dream the
center of the product. The goal is to make MBrain better at:

- finding the right memory,
- knowing which memory can be trusted,
- distinguishing answer evidence from hints,
- revalidating stale claims,
- preserving decisions and rejected alternatives,
- avoiding repeated failed work, and
- explaining why an agent used or ignored a memory.

The center of this spec is **authority-first trust maintenance**. Dream Cycle is
an important operational loop that maintains this system, but it is not the
primary concept.

## Background

Hyper's HN launch thread exposed useful external signals:

- raw episodes are useful source evidence, but can lose intent when converted
  into facts too aggressively,
- fact lifecycle and provenance matter more than graph density,
- graph traversal can help retrieve the right material, but graph-derived facts
  should not become answer authority,
- hooks and automatic capture need transparent UX,
- memory products must show value quickly, and
- conflict, scope, recency, and authority are the hard parts.

MBrain already has stronger foundations than a plain RAG system:

- Markdown remains the human-editable source of truth.
- Postgres stores pages, chunks, links, embeddings, jobs, assertions,
  projections, and governed memory state.
- `retrieve_context` is a probe that returns candidates and required reads.
- `read_context` is the evidence boundary before factual answers.
- Memory Inbox keeps unreviewed or uncertain signals separate from canonical
  memory.
- Governed canonical writeback routes durable mutations through policy instead
  of direct writes.

The next improvement is to make the existing assertion, governance, episode,
task, retrieval, and Dream Cycle surfaces work as one authority-aware memory
runtime.

## Non-Goals

- Do not make raw episodes the source of truth.
- Do not make graph edges answer evidence.
- Do not create a separate writable subject-predicate-object truth store.
- Do not make Dream-generated content eligible for same-cycle canonical writes.
- Do not use recency as the final conflict-resolution rule.
- Do not enable broad real-time extraction before candidate debt and privacy
  controls exist.
- Do not require hidden or mandatory hooks.
- Do not treat retrieval hit rate as the primary success metric.

## Design Decisions

### D1. Canonical evidence remains the answer boundary

MBrain should continue to answer factual questions from canonical evidence:
compiled truth, current artifacts, source/timeline evidence with the right
activation decision, or scoped personal memories when policy allows them.

Search results, context maps, graph paths, Memory Inbox candidates, and Inbox
leads help route retrieval. They are not factual answer evidence by default.

### D2. Replace "non-canonical lane" with artifact activation labels

"Non-canonical memory lane" is too broad and unsafe. Each artifact must expose
an activation decision:

| Activation | Meaning |
|---|---|
| `answer_ground` | May support the answer directly under current scope and freshness policy. |
| `citation_only` | May provide source/timeline context but should not be summarized as compiled truth. |
| `orientation_only` | May help select what to read next, but is not answer evidence. |
| `hint_only` | May guide search or follow-up, but not answer grounding. |
| `promote_first` | Potentially valuable, but must be promoted or canonicalized before grounding project facts. |
| `audit_only` | Visible only for cleanup/review/audit workflows. |
| `verify_first` | Must be revalidated before use. |
| `suppress_if_valid` | May suppress repeated failed work only if applicability anchors still hold. |

This keeps personal episodes, Memory Inbox candidates, graph paths, task
decisions, failed attempts, and canonical pages from being mixed under one vague
"memory" label.

### D3. Trust policy is a contract view, not a new authority store

The trust policy engine should derive decisions from existing governance
surfaces:

- source policy,
- scope gate,
- assertion authority and lifecycle,
- source refs and evidence kind,
- sensitivity and secret/prompt-injection flags,
- target snapshot hash,
- freshness contract,
- revalidation path, and
- activation policy.

Freshness is an enforcement signal. A freshness breach should normally downgrade
to `verify_first`, stale marking, or report-only review. It should not promote a
claim merely because it is recent.

### D4. Decision packets are projections over existing records

Decision packets are useful because agentic development needs to remember not
only what was chosen, but why it was chosen and what was rejected.

A decision packet is a read model over assertions, assertion evidence,
task decisions, canonical handoffs, retrieval traces, and source refs. It must
not become a separate truth store.

Required fields:

- `decision`
- `claim`
- `rationale`
- `rejected_alternatives`
- `owner_or_source`
- `source_refs`
- `canonical_target`
- `target_snapshot_hash`
- `valid_until`
- `revalidation_path`
- `reversibility`
- `affected_selectors`

### D5. Negative memory is conditional, not a permanent veto

Negative memory should reduce repeated failed work, but it must not prevent valid
retry after context changes.

A negative memory record must include:

- `failed_under`: branch, repo, file, version, command, error class, or other
  applicability anchors,
- `why_failed`,
- `do_not_repeat_if`,
- `reopen_if`,
- `valid_until`,
- `source_refs`, and
- `owner_or_task`.

The default activation is `suppress_if_valid` or `verify_first`, not a global
blacklist. If a negative memory blocks an agent action, that should be visible
in `memory-why` and the Dream report.

### D6. Graph is a selector planner, not a judge

Assertion graph and context graph signals should improve canonical read
selection. They must not become answer authority.

Before graph frontier retrieval becomes a default path, MBrain needs:

- scope-aware assertion/evidence/link records,
- policy/version labels on graph-derived views,
- a strict edge-type allowlist,
- edge direction and authority implications,
- fanout and depth caps,
- stale graph warnings, and
- tests proving graph-derived claims cannot ground answers directly.

Full edge vocabulary for this design:

- `supports`
- `contradicts`
- `supersedes`
- `superseded_by`
- `derived_from`
- `requires_reverification`
- `rationale_for`
- `rejected_alternative_to`

The first implementation should only enable:

- `supports`
- `contradicts`
- `supersedes`
- `requires_reverification`

Additional edge types can be added after graph-off/graph-on evaluation proves
that they improve canonical read selection without increasing false bridges.

### D7. Episode capture starts narrow

Episodes are valuable source evidence, especially for agent sessions. But broad
session capture can create privacy risk, candidate spam, and review debt.

Initial capture should be allowlisted to:

- decisions,
- negative-memory-worthy failed attempts,
- task resume state,
- code claims requiring revalidation,
- explicit user preferences, and
- source-backed project facts.

Raw text should be redacted before storage. Full raw capture should require
explicit configuration, short retention or encrypted storage, and clear
preview/uninstall UX.

### D8. Memory-why is an audit surface and a user trust surface

Agents need a small explanation of why memory was used. The default output
should be concise:

```text
Used canonical reads: 2
Ignored Inbox leads: 1 candidate_only
Revalidated: 1 stale code claim
```

Verbose mode can include full retrieval traces, graph paths, omitted candidates,
suppression reason codes, latency, and token cost.

Retrieval traces should eventually include:

- `considered_selectors`
- `selected_selectors`
- `omitted_candidate_refs`
- `suppression_reason_codes`
- `activation_decisions`
- `freshness_snapshot`
- `graph_paths_considered`
- `scope_policy_snapshot`

### D9. Dream Cycle is an operational loop, not the core concept

Dream Cycle remains important because it can maintain memory quality over time.
But this spec is not a Dream Cycle redesign. Dream is the maintenance loop that
keeps authority-first memory healthy.

Dream may automate:

- source health counts,
- ingest status,
- dedupe and clustering,
- candidate pressure scoring,
- projection and index freshness,
- lifecycle stale/expired transitions,
- replay canary checks, and
- bounded handling of low-risk, source-backed candidates.

Dream must report, not silently mutate, for:

- trust policy changes,
- new source class approval,
- unresolved contradictions,
- negative memory that blocked an action,
- freshness contract violations,
- dream-generated or inferred promotion attempts,
- candidate debt growth, and
- runner or redaction policy failures.

Dream permissions must be split:

- `write_candidates`: may create Memory Inbox candidates,
- `apply_auto_promote`: may run auto-promotion judgment and handoff flow,
- `allow_canonical_page_writes`: may mutate canonical Markdown after policy,
  snapshot, and replay gates pass.

The current single "apply" meaning is too broad for future expansion.

Dream also needs:

- `max_candidates_per_cycle`,
- `max_runner_calls`,
- `time_budget_ms`,
- lock heartbeat or renewal,
- TTL-before-abort gate,
- replay canary before apply,
- policy-aware verdict cache, and
- self-consumption guard for dream outputs.

### D10. Proof mode comes before broad expansion

The user should see the value of MBrain quickly. A future `mbrain proof --agent`
or `setup-agent --proof` should demonstrate:

- decision reuse,
- failed attempt avoidance,
- stale code claim verify-first,
- candidate excluded from answer grounding, and
- memory-why explanation.

This is not marketing. It is a product-quality check that the system's trust
model is understandable.

## Architecture

### Current shape

```text
Markdown canonical memory
  + Postgres runtime/index
  + Memory Inbox/governed writeback
  + retrieve_context probe
  + read_context evidence boundary
```

### Target shape

```text
agent/session/tool/file event
  -> allowlisted episode capture
  -> redaction/scope/sensitivity classification
  -> extraction outbox
  -> claim / decision / negative-memory candidate
  -> assertion resolution
  -> Memory Inbox or governed canonical write
  -> decision/negative/fact projections
  -> scoped selector planning
  -> read_context evidence
  -> answer + memory-why trace
```

Dream Cycle periodically maintains the middle of this pipeline, but the user's
interactive agent experience is the end-to-end product.

## Components

### 1. Trust Contract Service

Computes activation decisions from existing policy inputs.

Inputs:

- artifact kind,
- source kind,
- evidence kind,
- scope policy,
- sensitivity,
- assertion authority state,
- assertion lifecycle state,
- freshness contract,
- revalidation path,
- target snapshot hash,
- prompt-injection and secret flags.

Outputs:

- activation decision,
- authority label,
- freshness label,
- revalidation instruction,
- source refs,
- reason codes,
- policy version hash.

### 2. Inbox Lead Service

Surfaces review-only signals when canonical memory is absent or incomplete.

Rules:

- default candidate signal output remains content-light,
- candidate content reads require explicit purpose and scope,
- rejected/superseded candidates appear only in audit mode,
- unreviewed candidates never become project-fact answer evidence,
- personal episode grounding requires explicit or obvious personal scope.

### 3. Decision Packet Projection

Builds decision packet read models without creating a new truth store.

Sources:

- assertions,
- assertion evidence,
- task decisions,
- canonical handoffs,
- retrieval traces,
- source refs.

The projection may be indexed and cached, but canonical mutation still goes
through governed writeback.

### 4. Negative Memory Projection

Builds conditional warning/suppression records over task attempts, failed
approaches, rejected candidates, and stale procedures.

It supports:

- task continuation,
- repeated-work warnings,
- stale procedure detection,
- benchmark invalidation,
- "retry only if conditions changed" guidance.

### 5. Scoped Assertion Graph

Adds enough structure for safe graph-assisted retrieval.

Required before default frontier retrieval:

- scope-aware assertion lookup,
- edge type allowlist,
- edge authority implications,
- fanout and depth caps,
- trace of graph paths,
- graph-off/graph-on evaluation.

### 6. Memory-Why Trace

Adds answer-level explainability.

Default:

- 3 to 5 line summary.

Verbose:

- selected and omitted selectors,
- graph paths,
- Inbox leads,
- activation decisions,
- suppression reasons,
- stale checks,
- token and latency cost.

### 7. Dream Maintenance Guardrails

Extends Dream behavior only after the authority substrate exists.

Required before expanded Dream apply:

- permission split,
- runner budget,
- lock renewal/abort,
- replay canary,
- policy-aware verdict cache,
- inferred/dream-generated promotion block,
- all flagged/quarantined/redacted safety states in reports.

### 8. Agent Trust UX

Makes agent integration inspectable.

Surfaces:

- `setup-agent --preview`
- `setup-agent --diff`
- `setup-agent --apply`
- `setup-agent --uninstall`
- `doctor --agent --explain`
- future `proof --agent`

The user should be able to tell what was installed, what will be captured, what
will be written, and what can be removed.

## Evaluation

Primary metrics:

- `supported_answer_rate`
- `canonical_read_precision@k`
- `canonical_read_recall@k`
- `abstention_accuracy`
- `time_to_evidence`
- `tokens_per_supported_answer`
- `repeated_work_reduction`
- `negative_false_suppression_rate`
- `candidate_disposition_latency`
- `review_debt_per_session`

Safety metrics:

- `scope_leak_rate = 0`
- `candidate_pollution_rate = 0`
- `promotion_bypass_count = 0`
- `candidate_as_answer_ground_count = 0`
- `graph_as_answer_evidence_count = 0`
- `prompt_injection_auto_write_count = 0`
- `secret_canonicalization_count = 0`

Frontier retrieval metrics:

- graph-off vs graph-on canonical read precision,
- false bridge rate,
- p95 latency delta,
- token delta,
- edge type contribution,
- stale graph leakage.

Dream metrics:

- replay canary pass/fail,
- candidates created by phase,
- candidates suppressed by phase,
- auto-promote dry-run vs apply counts,
- lock renewals,
- runner calls and time budget,
- flagged/quarantined/redacted safety counts,
- candidate debt delta.

## Implementation Sequence

### Milestone 0: Spec and test contract

- Write this spec.
- Define acceptance tests and metrics before implementation.
- Keep all feature expansion behind explicit flags or report-only mode.

### Milestone 1: Authority substrate

- Add or expose scope/policy/freshness labels where assertion, evidence, link,
  derived fact, and trace paths need them.
- Add activation decision contract tests.
- Add graph/candidate cannot-answer tests.

### Milestone 2: Decision and negative memory projections

- Build read models for decision packets and negative memory.
- Use existing assertions/task decisions where possible.
- Add applicability-anchor tests.
- Add false suppression eval fixtures.

### Milestone 3: Memory-why and proof mode

- Extend trace payloads.
- Add concise memory-why output.
- Add proof-mode fixture demonstrating agent value.

### Milestone 4: Dream permission and safety guardrails

- Split Dream permissions.
- Add runner budget and lock renewal/abort behavior.
- Add replay canary gate.
- Add policy-aware auto-promote cache invalidation.
- Report all safety states.

### Milestone 5: Episode capture and Inbox lead refinement

- Start with narrow allowlisted capture.
- Keep candidate content gated.
- Add candidate debt metrics.

### Milestone 6: Bounded frontier retrieval experiment

- Add strict edge ontology.
- Run graph-off/graph-on ablation.
- Enable only if canonical-read precision improves without safety regression.

## Acceptance Criteria

- Factual answers are still grounded only in allowed evidence.
- Inbox leads help discovery without becoming answer evidence.
- Scope and policy labels are part of graph/frontier planning.
- Decision packets and negative memory are projections, not duplicate truth
  stores.
- Negative memory suppresses only when applicability anchors still hold.
- Dream cannot turn candidate writes into canonical page writes without explicit
  permission and replay gates.
- Memory-why can explain selected reads, ignored candidates, stale checks, and
  suppression decisions.
- Proof mode can show practical Codex/Claude value in a small repeatable flow.
- Eval shows better supported answers or reduced repeated work without scope
  leaks, candidate pollution, or promotion bypasses.

## Implementation Decisions

- Scoped assertion retrieval must be scope-safe before frontier retrieval can be
  enabled by default. The preferred path is to add `scope_id`,
  `policy_version`, and `authority_scope` to assertion-derived retrieval
  surfaces. If direct assertion schema migration is deferred, the implementation
  must provide an equivalent scope-safe query predicate over evidence and
  projections before graph traversal is allowed.
- Candidate content should be exposed through a new gated read surface,
  tentatively `read_candidate_context`. `retrieve_context` candidate signals
  remain content-light and `candidate_only`.
- Proof mode should start as CLI output. `doctor --agent --explain` can later
  summarize the latest proof result and installed-agent trust surface.
- The first graph implementation enables only `supports`, `contradicts`,
  `supersedes`, and `requires_reverification`.

## Design Summary

MBrain should improve by becoming more authority-aware, not merely more
retrieval-heavy. Episodes, graph, decision packets, negative memory, and Dream
Cycle are all useful, but only if they preserve the canonical evidence boundary
and make agent behavior easier to verify.

The core design is:

```text
more memory
  -> only through scoped source evidence
  -> with activation labels
  -> periodically maintained by Dream where applicable
  -> tested by replay
  -> explained by memory-why
  -> grounded by read_context
```
