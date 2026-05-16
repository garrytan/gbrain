# Candidate Signals in Agentic Retrieval

## Purpose

This design makes Memory Inbox candidates visible to Codex, Claude, and other
agent clients during normal `retrieve_context` use without weakening the
canonical evidence boundary.

The current agent-facing failure mode is that an agent can say "MBrain has no
canonical record for this direction" even when Memory Inbox contains relevant
unreviewed or pending candidates. That answer is technically careful but
operationally weak. Agents need to see candidate signals so they can notice
recent direction changes, pending ideas, contradictions, and promotion
opportunities.

The fix is not to mix Memory Inbox candidates into canonical search results.
The fix is to add an auxiliary candidate lane to `retrieve_context`: always
visible by default, clearly marked as non-canonical, capped by policy, and
connected to review, rejection, supersession, and redaction workflows.

## Problem

MBrain already has the important primitives:

- `search` and `query` discover canonical pages and chunks.
- `retrieve_context` groups canonical candidates and returns required reads.
- `read_context` loads bounded canonical evidence for answer grounding.
- Memory Inbox stores candidate claims with provenance, confidence, importance,
  recurrence, sensitivity, target binding, and lifecycle status.
- Promotion, rejection, supersession, canonical handoff, historical validity,
  and redaction plan operations already exist.

The gap is in agent retrieval. Memory Inbox candidates are reviewable through
dedicated operations, but they are not naturally visible in the default
retrieval path. If an agent only sees canonical reads, it can miss the fact that
the user or a prior agent already captured a later idea that has not crossed the
canonical boundary.

That creates three product problems:

1. Agents overstate absence when only canonical evidence is absent.
2. Direction changes can remain buried until a manual backlog review happens.
3. Memory Inbox promotion depends too heavily on scheduled maintenance rather
   than appearing at the moment a related question makes the candidate useful.

## Goals

1. Add an auxiliary `candidate_signals` lane to `retrieve_context`.
2. Return candidate signals by default for agent-facing retrieval.
3. Keep canonical reads and Memory Inbox signals separate in the response shape.
4. Preserve the rule that candidates are not answer-grounding evidence.
5. Rank candidate signals by query relevance, target affinity, status,
   freshness, and existing review priority.
6. Add deterministic `promotion_hint` and `disposition_hint` fields so agents
   know the next safe action.
7. Hide rejected and superseded candidates from normal retrieval while keeping
   them available for audit and maintenance flows.
8. Keep `search` and `query` as canonical discovery tools.
9. Avoid user-facing knobs that normal users will not configure.

## Non-Goals

- Do not make Memory Inbox candidates canonical truth before promotion.
- Do not put candidates into `required_reads`.
- Do not make `read_context` return candidate text as canonical evidence.
- Do not auto-promote candidates merely because they matched a query.
- Do not auto-delete or auto-forget candidates from retrieval scoring alone.
- Do not change low-level `search` or `query` semantics in v1.
- Do not build a new end-user review UI as part of this change.

## Core Concept

`retrieve_context` should return two lanes:

```text
canonical lane:
  candidates
  required_reads
  answerability

auxiliary candidate lane:
  candidate_signal_policy
  candidate_signals
```

The canonical lane answers: "What can the agent read as evidence?"

The auxiliary lane answers: "What reviewable, non-canonical signals might change
how the agent should frame the answer or what it should inspect next?"

The agent may say that a candidate exists. It may summarize the candidate only
as an unreviewed signal. It must not treat the candidate as factual answer
ground unless the candidate has been promoted and reflected in an appropriate
canonical source.

## Response Contract

Add these fields to `RetrieveContextResult`:

```ts
interface RetrieveContextResult {
  candidate_signal_policy: CandidateSignalPolicy;
  candidate_signals: CandidateSignal[];
}

interface CandidateSignalPolicy {
  mode: 'normal' | 'expanded' | 'strict' | 'audit';
  reason_codes: string[];
  included_count: number;
  suppressed_count: number;
}

interface CandidateSignal {
  candidate_id: string;
  status:
    | 'captured'
    | 'candidate'
    | 'staged_for_review'
    | 'rejected'
    | 'promoted'
    | 'superseded';
  authority:
    | 'unreviewed_candidate'
    | 'approved_pending_canonicalization';
  activation: 'candidate_only';
  target_object_type:
    | 'curated_note'
    | 'procedure'
    | 'profile_memory'
    | 'personal_episode'
    | 'other'
    | null;
  target_object_id: string | null;
  relation_to_canonical:
    | 'same_target'
    | 'updates'
    | 'conflicts'
    | 'supports'
    | 'adjacent'
    | 'unknown';
  score: number;
  score_reasons: string[];
  promotion_hint:
    | 'no_action'
    | 'inspect_candidate'
    | 'advance_to_review'
    | 'consider_preflight'
    | 'needs_provenance'
    | 'needs_target'
    | 'needs_scope_decision'
    | 'already_promoted_needs_handoff'
    | 'handoff_ready_for_curated_update';
  disposition_hint:
    | 'keep_candidate'
    | 'reject_low_value'
    | 'reject_missing_provenance'
    | 'reject_scope_conflict'
    | 'supersede_with_newer_candidate'
    | 'revalidate_stale_claim'
    | 'hide_from_default_retrieval'
    | 'requires_redaction_review';
  summary: string;
}
```

The `summary` must be short and framed as a signal, not as truth. It should use
language such as "Unreviewed candidate suggests..." or "Promoted candidate still
needs canonical handoff..." rather than asserting the claim directly.

## Policy Selection

Do not expose normal user-facing options for candidate signal retrieval. Users
will not reliably set them, and the primary consumers are agents. Instead,
`retrieve_context` selects a policy automatically from scenario, query text, and
scope.

| Mode | Use When | Default Cap | Default Statuses |
|---|---|---:|---|
| `normal` | Ordinary agent retrieval | 3 | `captured`, `candidate`, `staged_for_review`, eligible `promoted` |
| `expanded` | Query asks about direction, recent thinking, candidates, promotion, Memory Inbox, or non-canonical signals | 10 | active statuses plus promoted candidates pending canonical consolidation |
| `strict` | User explicitly asks for canonical, verified, or source-grounded facts only | 0 content, count-only allowed | none by default |
| `audit` | Query asks to review, clean up, reject, supersede, or inspect Memory Inbox | 20 | active statuses plus `rejected` and `superseded` summaries |

Strict mode should not pretend candidates do not exist. It may return
`suppressed_count` and a reason code such as `strict_canonical_requested` so
agents can say candidates were intentionally excluded.

## Candidate Discovery

Candidate signals should come from Memory Inbox, not from canonical page search.
`retrieve_context` should collect candidates through a bounded service that
depends on the governance store interface.

Discovery sources:

1. Candidates whose `target_object_id` matches any canonical `required_reads`
   slug or known subject.
2. Candidates whose `proposed_content` overlaps with the query.
3. Candidates whose `source_refs` or target binding overlap with known subjects.
4. Promoted candidates that target the same object but have no canonical
   handoff or still need curated consolidation.

Default normal retrieval excludes `rejected` and `superseded` candidates. Audit
mode may include them as outcomes, not as active signals.

## Ranking

Candidate signal ranking is an exposure priority, not a truth score.

Use the existing `rankMemoryCandidateEntries` review-priority score as one
input, but do not let it dominate retrieval relevance. A highly reviewable
candidate that is unrelated to the current query should not appear above a
moderately scored candidate that targets the exact canonical page being read.

Suggested scoring:

```text
candidate_signal_score =
  target_affinity
  + query_overlap
  + status_priority
  + freshness_boost
  + review_priority
  + source_quality_boost
  - sensitivity_penalty
```

Score inputs:

| Input | Purpose |
|---|---|
| `target_affinity` | Prefer candidates that target the same canonical page, procedure, profile, or episode as the current retrieval. |
| `query_overlap` | Prefer candidates whose proposed content overlaps the user query. |
| `status_priority` | Prefer `staged_for_review` and eligible `promoted` over `candidate`, and `candidate` over weak `captured`. |
| `freshness_boost` | Surface recent direction changes that may postdate canonical synthesis. |
| `review_priority` | Reuse confidence, importance, recurrence, extraction kind, and source quality scoring. |
| `source_quality_boost` | Reward candidates with usable provenance. |
| `sensitivity_penalty` | Suppress or redact unsafe personal, secret, or unknown-sensitivity content under the active scope. |

Score reasons must be stable strings so agent behavior and tests can assert why
a candidate appeared.

## Status Visibility

Default visibility should be conservative:

```text
promoted:
  include if canonical handoff or curated consolidation is pending

staged_for_review:
  include strongly

candidate:
  include normally

captured:
  include only with target binding, usable provenance, strong query overlap, or
  recent creation

rejected:
  hide outside audit mode

superseded:
  hide outside audit mode
```

This keeps the auxiliary lane useful without turning every capture into ambient
retrieval noise.

## Promotion Hints

Each signal should explain the next safe promotion action:

| Status or Condition | Promotion Hint |
|---|---|
| No usable provenance | `needs_provenance` |
| Missing target binding | `needs_target` |
| Scope or sensitivity needs decision | `needs_scope_decision` |
| `captured` with enough metadata | `inspect_candidate` |
| `candidate` with provenance and target | `advance_to_review` |
| `staged_for_review` | `consider_preflight` |
| `promoted` without handoff | `already_promoted_needs_handoff` |
| Handoff exists but curated target should change | `handoff_ready_for_curated_update` |
| No immediate action | `no_action` |

The hint should never mutate state by itself. It guides the agent toward
existing operations: `get_memory_candidate_entry`,
`advance_memory_candidate_status`, `preflight_promote_memory_candidate`,
`promote_memory_candidate_entry`, `record_canonical_handoff`, and eventually
`put_page` when a curated target should change.

## Disposition Hints

Making candidates visible by default also requires a clear cleanup story. Each
signal should include a disposition hint:

| Condition | Disposition Hint |
|---|---|
| Candidate remains useful and active | `keep_candidate` |
| Candidate is low-value, old, and weakly grounded | `reject_low_value` |
| Candidate cannot be reviewed because provenance is missing | `reject_missing_provenance` |
| Candidate conflicts with the active scope | `reject_scope_conflict` |
| Newer promoted candidate replaces it | `supersede_with_newer_candidate` |
| Promoted or handed-off claim may be stale | `revalidate_stale_claim` |
| Candidate should not appear in normal retrieval anymore | `hide_from_default_retrieval` |
| Sensitive material needs governed removal | `requires_redaction_review` |

Disposition hints are recommendations, not automatic deletion. Rejection,
supersession, and redaction remain explicit governance actions.

## Forgetting And Removal

This design distinguishes three outcomes:

1. `reject`: the candidate was reviewed and should not become durable truth.
2. `supersede`: the candidate is replaced by a newer promoted candidate.
3. `redact` or `delete`: the stored material itself must be removed, hidden, or
   tombstoned for privacy, safety, or explicit user deletion.

Do not use rejection as a privacy tool. Sensitive or explicitly deleted
material should go through the governed redaction or delete path so the system
can preserve an auditable tombstone without leaking the content.

Do not auto-delete candidates because they are old. Old candidates may matter as
evidence of a direction change or a rejected path. Maintenance should recommend
rejection, supersession, or redaction through existing operations.

## Agent Behavior

Installed agent rules should change from:

```text
If canonical reads do not support an answer, say MBrain has no canonical record.
```

to:

```text
If canonical reads do not support an answer, inspect candidate_signals before
claiming absence. If candidate_signals exist, say canonical evidence is absent
or different, but Memory Inbox has non-canonical signals. Do not treat those
signals as answer-grounding truth.
```

For normal answers, agents should use language like:

```text
Canonical memory says A. Memory Inbox also has an unreviewed candidate pointing
toward B, so I would not treat A as the whole story.
```

For strict answers, agents should use language like:

```text
From canonical evidence only, I found A. Non-canonical candidate signals were
suppressed because this was a strict canonical request.
```

For review flows, agents should use language like:

```text
This candidate has target binding and provenance, so the next safe step is
preflight_promote_memory_candidate.
```

## Scope And Safety

Candidate signals must respect the same scope boundaries as canonical retrieval.

Rules:

1. Personal or secret candidate content must not appear in work-scope retrieval.
2. Unknown sensitivity should be suppressed or summarized without content unless
   the query is an audit flow in an allowed scope.
3. `suppressed_count` should count hidden candidates so agents know there is
   something withheld.
4. Candidate summaries must not include source text that would violate the
   active scope.
5. Rejected or superseded sensitive candidates remain hidden outside audit and
   redaction workflows.

## Implementation Shape

Add a focused service:

```text
src/core/services/candidate-signal-service.ts
```

Responsibilities:

- select candidate signal policy
- list bounded Memory Inbox candidates
- compute target affinity and query overlap
- combine retrieval relevance with existing review priority
- produce promotion and disposition hints
- apply scope and sensitivity suppression
- return deterministic scores and reason codes

`retrieve-context-service.ts` should call this service after canonical
`required_reads` are computed. The service receives:

```ts
{
  query,
  requested_scope,
  scenario,
  known_subjects,
  required_reads,
  canonical_candidates,
  limit
}
```

The service returns:

```ts
{
  candidate_signal_policy,
  candidate_signals
}
```

Keep low-level `search` and `query` unchanged.

Keep `read_context` canonical-only. If a candidate needs inspection, the agent
should call `get_memory_candidate_entry` or the review backlog operations.

## Testing

Add focused unit and operation tests:

1. `retrieve_context` includes `candidate_signals` by default.
2. Candidate signals never appear in `required_reads`.
3. Normal policy returns active candidates with a small cap.
4. Expanded policy is selected for Memory Inbox, direction, recent-thinking,
   and promotion-related queries.
5. Strict policy suppresses content and returns count-only metadata.
6. Audit policy can include rejected and superseded candidates as outcomes.
7. Candidate ranking prefers same-target and query-overlap candidates over
   unrelated high-priority backlog items.
8. `promotion_hint` is deterministic for missing provenance, missing target,
   staged candidates, promoted-without-handoff, and handoff-ready candidates.
9. `disposition_hint` is deterministic for low-value, missing-provenance,
   scope-conflict, supersession, stale-claim, and redaction cases.
10. Scope and sensitivity gates suppress unsafe candidate content.
11. Existing `search`, `query`, `read_context`, promotion, handoff, rejection,
   supersession, and redaction tests continue to pass.

## Acceptance Criteria

The change is complete when:

1. Agents using `retrieve_context` can see relevant Memory Inbox candidates even
   when canonical evidence exists.
2. Agents can no longer truthfully say "no MBrain memory exists" when only
   canonical evidence is absent but relevant candidates exist.
3. Candidate signals are clearly marked as non-canonical and never become
   required reads.
4. Promotion and disposition hints guide agents to existing governance tools.
5. Rejected and superseded candidates do not pollute normal retrieval.
6. Strict canonical answers remain possible.
7. Work and personal scopes remain isolated.
8. The implementation remains local/offline compatible and backend-parity safe.

## Rollout Plan

1. Add candidate signal types.
2. Implement the candidate signal service.
3. Integrate it into `retrieve_context`.
4. Update MCP instructions and installed agent rules.
5. Add unit and operation tests.
6. Run focused retrieval, Memory Inbox, and setup-agent tests.
7. Run the standard pre-ship test suite before shipping.

## Design Decision

The approved direction is:

> Always surface Memory Inbox candidates to agents as an auxiliary lane in
> `retrieve_context`, never as canonical search results, and never as
> answer-grounding evidence before promotion and canonical consolidation.

This gives agents the context they need to notice emerging direction changes
while preserving MBrain's canonical-memory quality boundary.
