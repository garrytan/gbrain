# MBrain Redesign Governance and Inbox Workstream

This document defines the governance layer between derived signals and durable memory in `mbrain`. It owns the Memory Inbox, candidate confidence taxonomy, scoring, review flow, and the explicit promote, reject, and supersede boundaries that keep uncertain signals from polluting canonical memory. It does not define map-building internals from `05-workstream-context-map.md`, operational task-memory lifecycles from `04-workstream-operational-memory.md`, or the internal lifecycle of profile memory from `07-workstream-profile-memory-and-scope.md`.

## Scope

This workstream exists because useful memory systems generate more possible long-term claims than they should immediately trust.

It owns:

- `Memory Inbox` as the canonical holding area for reviewable candidates
- `Memory Candidate` objects and their governance metadata
- confidence taxonomy for extracted, inferred, ambiguous, or otherwise reviewable claims
- candidate scoring and review flow
- explicit promote, reject, and supersede rules
- scope and sensitivity checks applied at review and promotion time
- contradiction handling between candidates and existing canonical state
- governed mutation control-plane records that prove who was allowed to write, what target snapshot was expected, and what result was recorded

It does not own:

- how Context Maps are built, refreshed, or queried
- how Task Threads, Working Sets, Attempts, or Decisions are created and maintained
- how Profile Memory and Personal Episodes are stored or retrieved after a candidate has been accepted for that domain

The governance layer is therefore not a graph subsystem and not a storage replacement for target domains. It is the safety boundary between "this may be worth remembering" and "this is now canonical memory."

## Memory Operations Control Plane

The Memory Inbox governs uncertain claims. The memory operations control plane
governs durable write authority after a write has become concrete enough to
touch canonical or governance state.

It adds four operator-facing guarantees:

| Control | Purpose |
|---|---|
| Memory mutation ledger | Records applied, denied, conflict, failed, dry-run, staged-for-review, and redacted outcomes with target snapshot evidence. |
| Memory realms and sessions | Scope write authority to work, personal, or mixed domains and require read-write attachment before privileged memory writes. |
| Patch candidate apply flow | Keeps proposed patches reviewable, validates target snapshots, and records conflicts instead of overwriting stale targets. |
| Redaction plans and health reports | Let operators review, apply, audit, and monitor high-risk memory operations without silently mutating state. |

Control-plane rules:

1. Mutating memory operations must record ledger evidence unless they are an
   explicit dry-run path.
2. Write authority is session- and realm-scoped; a read-only attachment must not
   authorize canonical mutation.
3. Patch application must compare expected and current target snapshots before
   writing.
4. Redaction applies only after approval and must fail closed when a matching
   target is unsupported, stale, or adjacent to persisted data that cannot be
   safely rewritten.
5. Applied redaction plans must not keep the raw redacted query or replacement
   text in MCP-readable plan or ledger surfaces.
6. Health reporting should expose bounded operator status without pretending
   sampled counts are full-table totals.

## Personal Maintenance Apply Boundary

Personal maintenance may discover useful work, but it does not gain special
write authority. Any maintenance output that wants to mutate canonical or
governance state must pass the same control plane as an interactive write.

Apply-capable maintenance requires:

| Requirement | Why it exists |
|---|---|
| active realm and session | Proves the maintenance actor has write authority for the target scope. |
| mutation ledger | Records applied, denied, dry-run, conflict, failed, staged, or redacted outcomes. |
| target snapshot | Prevents stale maintenance from overwriting a newer canonical target. |
| dry-run/apply parity | Ensures dry-run validates the same target and policy checks as apply. |
| redaction fail-closed behavior | Prevents maintenance from exposing or partially rewriting sensitive data. |

Rules:

1. Report-only phases need no mutation authority.
2. Candidate-creating phases write governance state, not truth, and must preserve
   source refs and extraction kind.
3. Apply requests must name the target object, expected target snapshot, source
   refs, scope, sensitivity, and interaction or maintenance run id.
4. dry-run and apply paths must perform the same validation, except apply may
   mutate after authorization and conflict checks pass.
5. Failed apply requests remain auditable in the mutation ledger.
6. Maintenance must never suppress contradiction, supersession, or redaction
   history to make a report look cleaner.

## GA-P6 Personal Maintenance Cycle Runtime Contract

GA-P6 makes personal maintenance report-first. The default cycle produces
bounded reports and suggestions: stale candidate review, duplicate merge
suggestions, derived-artifact freshness warnings, and health signals. These
outputs may point at work, but they do not mutate canonical truth.

Dry-run output must name the target object, source refs, scope, sensitivity,
expected target snapshot, policy checks, and redaction checks that apply would
use. Apply is optional and may only run through the existing memory operations
control plane. It requires an active write-capable realm/session, a mutation
ledger event, target snapshot validation, and the same validation as dry-run
before any mutation.

GA-P6 rules:

1. Report and suggestion modes are the default and require no mutation
   authority.
2. Candidate writes create or update governed candidate state, not compiled
   truth.
3. Apply without an active realm/session is denied and recorded.
4. Apply without a target snapshot is a conflict or defer outcome, never a blind
   overwrite.
5. Dry-run and apply validation must stay parity-checked so dry-run cannot hide
   a policy, scope, snapshot, or redaction failure.
6. Redaction and sensitive maintenance operations fail closed when the target is
   unsupported, stale, ambiguous, or unsafe to rewrite.

## Candidate Sources

Candidates may come from several parts of the system, but they all arrive in the same review boundary before becoming durable truth.

Representative candidate sources are:

| Source | Example Candidate Output |
|---|---|
| Map analysis | inferred relationship, bridge node insight, surprising connection, note update suggestion |
| Deterministic extraction plus synthesis | extracted fact, structured relationship, rationale anchor, open question |
| Operational pattern mining | reusable procedure candidate, repeated failure pattern, recurring decision pattern |
| Imported or observed source artifacts | note update suggestion, fact candidate, contradiction trigger |
| User or maintainer corrections | candidate that updates, narrows, or replaces an earlier claim |
| Dream-cycle or background review | duplicate merge suggestion, stale claim challenge, recap-derived candidate |

Candidate-source rules:

1. Derived signals are allowed to be useful before they are allowed to be true.
2. A strong candidate may originate from the map layer, but map generation does not imply promotion authority.
3. A candidate may target durable canonical domains such as curated notes, procedures, profile memory, or other reviewed long-lived records, without this document taking ownership of those domains' storage models.
4. The inbox is not the route for active operational continuity. Task Thread and Working Set updates stay on the direct write path defined in `02-memory-loop-and-protocols.md` and `04-workstream-operational-memory.md`.
5. Direct authoritative updates may bypass the inbox only when `02-memory-loop-and-protocols.md` already classifies them as a canonical write for that domain.

## GA-P4 Candidate Authority and Handoff Invariants

GA-P4 keeps Memory Inbox useful without letting it become a second truth store.
Candidate activation is `candidate_only`, never `answer_ground`. A candidate may
be displayed as a discovery signal, ranked for review, or linked to a target
domain, but it cannot answer for compiled truth, Profile Memory, Personal
Episodes, Source Records, operational memory, or derived orientation.

Promotion and handoff are separate invariants:

1. Promotion changes governance state only after provenance, scope, sensitivity,
   contradiction, and target-domain checks pass.
2. Canonical handoff preserves source refs, target object identity, scope, sensitivity, and expected target snapshot evidence.
3. A handoff record does not by itself rewrite the target store; the owning
   domain still performs the canonical mutation through its direct operation.
4. Personal profile targets remain personal-profile writes, personal episode
   targets remain personal-episode writes, and page-backed curated notes remain
   target-snapshot-guarded page writes.
5. Contradictory signals stay captured or staged until review resolves whether
   to reject, supersede, or hand off a newer canonical write.

## Memory Inbox Model

The `Memory Inbox` is the canonical governance container for not-yet-promoted memory. It stores candidates, review state, and explicit outcomes so the system can learn from uncertain signals without silently mutating truth.

Each `Memory Candidate` should capture at least:

| Field | Purpose |
|---|---|
| `id` and `scopeId` | Identify the candidate and the memory scope it proposes to affect. |
| `candidateType` | Distinguish fact, relationship, note update, procedure, profile update, open question, or rationale candidates for durable-memory review. |
| `proposedContent` | Hold the actual claim or change being proposed. |
| `sourceRefs` | Point back to canonical provenance handles and source artifacts. |
| `generatedBy` | Explain whether the candidate came from an agent, map analysis, dream cycle, manual input, or import. |
| `extractionKind` | Mark whether the proposal is extracted, inferred, or ambiguous. |
| `confidenceScore` | Express estimated correctness. |
| `importanceScore` | Express how much the candidate matters if true. |
| `recurrenceScore` | Express how often the same pattern or claim reappears. |
| `sensitivity` | Carry public, work, personal, secret, or unknown visibility risk. |
| `status` | Track captured, candidate, staged for review, promoted, rejected, or superseded state. |
| `targetObjectType` and `targetObjectId` | Link the proposal to its intended canonical destination when known. |
| `createdAt` and `reviewedAt` | Preserve auditability. |

The inbox should preserve review history explicitly. Promotion or rejection must be visible as a governance outcome, not inferred from disappearance.

Model rules:

1. Governance state is canonical for review history, not canonical for truth claims.
2. A candidate may exist for a long time without promotion if evidence is promising but not yet sufficient.
3. Rejection and supersession remain durable states because they improve future review quality.
4. Candidate provenance must remain attached even when the candidate is eventually rejected.

## Confidence Taxonomy

Candidate confidence should be described with both a qualitative taxonomy and a numeric score. The taxonomy tells reviewers what kind of reasoning produced the candidate; the score helps triage.

The base taxonomy is:

| Extraction Kind | Meaning | Default Governance Posture |
|---|---|---|
| `EXTRACTED` | The claim is pulled directly from a canonical artifact or source with little interpretive leap. | Usually reviewable in batches if scope and provenance are clean. |
| `INFERRED` | The claim depends on synthesis, structural interpretation, or derived connections between sources. | Requires stronger review because the system is adding meaning rather than only preserving structure. |
| `AMBIGUOUS` | The claim has unresolved referents, competing interpretations, or weak grounding. | Must not be promoted until ambiguity is resolved. |
| `MANUAL` or user-corrected | The claim was authored deliberately by a reviewer or user but still arrives as a candidate because it affects durable memory. | Review is usually faster, but scope, sensitivity, and contradiction checks still apply. |

Confidence scoring rules:

1. Numeric confidence should never be the only signal. A high-confidence inferred claim is still inferred.
2. Source quality matters separately from extraction kind. A low-quality source should cap effective confidence.
3. Code-sensitive candidates require current verification before they can be treated as strong, even if their historical confidence was high.
4. User corrections raise importance, but they do not remove scope or sensitivity obligations.

The taxonomy exists to make review legible. It should tell a reviewer not just how likely a candidate is to be true, but what kind of mistake the system may have made when producing it.

## Scoring and Review Flow

Review flow is the mechanism that turns raw candidate volume into a bounded, auditable stream of decisions.

The default flow is:

```text
captured
  -> candidate
  -> staged_for_review
  -> promoted | rejected | superseded
```

Scoring inputs should include:

- confidence score
- importance score
- recurrence score
- source quality
- extraction kind
- scope fit
- sensitivity
- user correction or reviewer intervention
- current verification result for code-sensitive or time-sensitive claims

Review-flow rules:

1. Low-value and low-confidence candidates may remain in backlog or be rejected quickly.
2. High-confidence, low-risk extracted candidates can be grouped for efficient review, especially for note-update or provenance-preserving changes.
3. High-importance inferred candidates should be staged explicitly even when they are not numerous.
4. Ambiguous or high-sensitivity candidates should be escalated instead of auto-promoted.
5. Review should always happen against the candidate's target domain and source evidence, not only against the candidate text in isolation.

This document does not define the human interface for review. It defines the state machine and evaluation contract that any review surface must preserve.

## Promote / Reject / Supersede Rules

Governance outcomes must be explicit and explainable.

Promotion rules:

1. Promote only when provenance is attached, target domain is clear, scope fit is valid, sensitivity is acceptable, and contradiction checks have either cleared or been resolved deliberately.
2. Promotion writes an explicit governance outcome linked to the target object rather than silently editing canonical memory.
3. Promotion should preserve enough history to explain why the claim crossed the boundary.

Rejection rules:

1. Reject when provenance is insufficient, the claim is clearly false, the candidate is policy-violating, the scope is wrong, the sensitivity cannot be justified, or current verification disproves the proposal.
2. Rejection should preserve the candidate, the reason, and the evidence used to dismiss it.
3. Rejection history should inform future duplicate or recurrence handling so the same bad candidate is cheaper to dismiss next time.

Supersession rules:

1. Supersede when a newer candidate or newer evidence replaces an older promoted or staged claim without making the historical record disappear.
2. Supersession should link old and new records explicitly.
3. Supersession is preferred over silent overwrite when the earlier claim was once defensible or already canonical.

These outcomes are the core guarantee that the system can improve without becoming opaque.

## Scope and Sensitivity Gates

Governance must re-check scope and visibility even if the retrieval route that produced the candidate already had a scope decision. Durable writes deserve their own boundary check.

Sensitivity classes should include:

- `public`
- `work`
- `personal`
- `secret`
- `unknown`

Promotion-time rules:

1. A `personal` or `secret` candidate must not be promoted into work-visible canonical memory.
2. A `work` candidate must not be promoted into personal memory as a convenience copy.
3. `unknown` sensitivity blocks promotion until the candidate is classified.
4. Cross-scope promotion requires an explicit policy reason, not an accidental match.
5. Scope mismatch should prefer rejection or backlog over forced promotion.

This is the point where governance intersects with `07-workstream-profile-memory-and-scope.md`: `07` defines which domains may be read or written by default, while this document defines how those decisions are enforced when a candidate attempts to become durable memory.

## Contradiction Handling

Contradictions are not edge cases. They are normal in a system that synthesizes from changing sources, historical code states, and overlapping notes.

Contradiction handling rules:

1. A contradictory candidate must never silently overwrite canonical state.
2. The system should link the new candidate to the canonical claim, source record, or earlier candidate it challenges.
3. Contradictions should distinguish at least three cases: clearly false candidate, unresolved conflict, and newer evidence that supersedes older truth.
4. Time-sensitive or code-sensitive contradictions require current verification before promotion or supersession.
5. When contradiction remains unresolved, the safe outcome is to keep the conflict explicit rather than smoothing it away.

Useful contradiction outcomes are:

- reject the new candidate
- supersede the old canonical claim with the new reviewed claim
- keep both records visible with an unresolved contradiction marker
- convert the conflict into an explicit open question for later review

The important rule is auditability. A reviewer should be able to see that the contradiction occurred, what evidence each side had, and why the final governance outcome was chosen.

## Tests and Evaluation

This workstream needs both policy tests and outcome-quality metrics.

Required test areas:

- inbox state-machine tests for captured, candidate, staged, promoted, rejected, and superseded transitions
- provenance completeness tests so promotion cannot happen without source references
- scoring determinism tests so the same candidate data yields the same ranking inputs
- sensitivity-gate tests preventing personal, secret, or unknown-scope leakage
- contradiction tests covering reject, unresolved, and supersede outcomes
- duplicate handling tests so recurrence improves triage instead of multiplying identical review work
- code-sensitive verification gate tests preventing stale code claims from being promoted without re-checking
- target-domain handoff tests confirming governance outcomes can link into curated notes, procedures, profile memory, or other durable canonical records without redefining those domains
- memory mutation ledger tests for applied, denied, conflict, dry-run, and redacted outcomes
- memory realm and session tests for read-only denial, read-write authorization, expiry, closure, archived realms, and scope mismatch
- patch apply tests for target snapshot conflicts, expected resulting hashes, and ledger rollback on failure
- redaction plan tests for unsupported target fail-closed behavior, paginated dry-run previews, derived storage refresh, and post-apply secret tombstoning
- memory operations health tests for mutation counts, draft redaction plans, and bounded pending patch counts

Required evaluation questions:

- What percentage of promoted candidates are later corrected or superseded?
- How often does the inbox surface high-value candidates early enough to matter?
- Is review backlog staying bounded, or is candidate volume overwhelming governance?
- Are scope and sensitivity violations being blocked before promotion?
- Are contradictions becoming more legible and auditable over time?
- Are durable memory writes explainable through ledger events with target snapshot evidence?
- Are high-risk operations such as patch apply and redaction reviewable, bounded, and reversible enough for operators to trust?

The subsystem is successful only if it lets the system learn from derived signals
while keeping durable memory cleaner, safer, and more explainable than a
direct-write pipeline would. The Phase 9 control plane extends that success
condition from candidate governance into governed mutation itself.
