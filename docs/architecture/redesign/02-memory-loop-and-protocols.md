# MBrain Redesign Memory Loop and Protocols

This document is the authoritative protocol contract for how `mbrain` reads, verifies, writes, and promotes memory. It defines the end-to-end operating loop across retrieval, verification, candidate creation, Retrieval Trace capture, and promotion boundaries. It does not define storage schemas, rollout sequencing, or backend-specific implementation mechanics.

## End-to-End Memory Loop

1. Detect request intent and active scope.
2. Route retrieval based on intent: task resume, broad synthesis, precision lookup, or personal/profile lookup.
3. Read the strongest canonical sources for that route before consulting derived orientation artifacts.
4. Verify time-sensitive, code-sensitive, or branch-sensitive claims before reuse.
5. Answer using operational memory, curated Markdown, Source Records, and derived orientation artifacts in the correct order.
6. Write back operational state changes immediately when the interaction changes active work continuity.
7. Convert inferred, ambiguous, or derived long-term claims into Memory Candidates rather than durable truth.
8. Promote only reviewed claims that pass scope, contradiction, and provenance checks.
9. Persist a Retrieval Trace as a canonical operational record when the interaction needs durable explainability for retrieval, verification, or write justification.

The loop is complete only when both sides are handled: the read path must explain how the answer was produced, and the write path must explain what durable state, if any, changed as a result of the interaction.

## Query Route by Intent

Retrieval order is determined by request intent and scope, not by a universal storage hierarchy.
Scenario classification sits above these routes: it decides whether the prompt
is coding continuation, project Q&A, knowledge Q&A, auto accumulation, personal
recall, or mixed, then decomposes the request into one or more intent routes.

| Intent | Primary Route | Secondary Route | What Must Not Happen |
|---|---|---|---|
| Task resume | Task Thread -> Working Set -> recent Event / Episode -> recent Attempt / Decision -> relevant Procedure | focused Source Record reads and map-assisted orientation only after resume state is loaded | jumping straight to raw files and repeating prior failed work |
| Broad synthesis | Curated Notes -> linked canonical notes -> Context Map / Map Report for orientation | focused Source Record reads for citation support or gap resolution | treating map edges or summaries as truth without canonical support |
| Precision lookup | exact canonical source, entity/topic note, or direct Source Record path | current artifact verification and minimal supporting reads | answering from remembered summaries when the exact artifact is available |
| Personal/profile lookup | Scope Gate -> Profile Memory / Personal Episode -> scoped supporting notes | explicit cross-scope expansion only after an explicit scope decision | leaking personal memory into work retrieval by default |

If a request mixes intents, the route should be decomposed instead of flattened. For example, a request that resumes a task and asks for a new synthesis should first resume active work state, then run synthesis inside that recovered context.
Cross-scope retrieval or write behavior is blocked until the scope decision is explicit.

## Task Resume Protocol

Task resume exists to prevent repeated investigation and repeated mistakes.

1. Read the active Working Set before scanning raw files.
2. Read recent Event / Episode records to recover the latest interaction context and state transitions.
3. Read recent Attempts and Decisions before proposing new next steps.
4. Surface the last known blockers, failed paths, branch assumptions, and pending actions before generating fresh analysis.
5. Read the relevant Procedure only if it informs the next action for the active Task Thread.
6. Expand to raw files, symbols, tests, or Source Records only after the canonical resume state is loaded.

The resume answer should make prior work legible. A correct resume response tells the agent what was already tried, what remains uncertain, and what the next justified action is.

## Broad Synthesis Protocol

Broad synthesis is used when the request asks what the system knows across multiple notes, topics, code areas, or evidence sets.

1. Start with curated Markdown notes and other canonical synthesized material.
2. Use Context Maps, Context Atlases, or Map Reports to orient the search space, identify bridges, and select promising source clusters.
3. Prefer curated Markdown over inferred map edges when the two disagree in emphasis or confidence.
4. Pull focused Source Records only where canonical notes are thin, contradictory, or missing the citation support needed for the answer.
5. Write gaps, open contradictions, or promising but unproven links back as Memory Candidates rather than silently smoothing them into the synthesis.

Context Maps are navigation aids. They help the system find the right canonical material faster, but they do not authorize new truth on their own.

## Precision Lookup Protocol

Precision lookup is used when the request depends on an exact fact, exact note, exact source, or exact current artifact.

1. Use the direct Source Record path whenever it is available.
2. Prefer the exact canonical note, exact Source Record, exact code artifact, or exact procedure over any summary.
3. Verify stale-sensitive claims before repeating them, especially if the claim depends on current files, branch state, test behavior, or imported source contents.
4. Keep supporting reads narrow. Precision lookup should minimize collateral retrieval once the correct artifact is found.
5. If the exact artifact cannot be found, the answer should degrade explicitly rather than pretending a remembered summary is equivalent.

Precision lookup optimizes for correctness over breadth. It is acceptable to answer with less synthesis if that preserves fidelity to the actual artifact.

## Code Claim Verification Protocol

Code claims are uniquely vulnerable to staleness and branch drift. Memory may suggest where to look, but live code claims require current verification.

1. Reconfirm file paths before citing them as current.
2. Reconfirm symbol existence and location before relying on remembered structure.
3. Reconfirm branch-sensitive assumptions when a claim depends on the active worktree or branch state.
4. Reconfirm tests, commands, or failure modes before treating a previous observation as still true.
5. Distinguish clearly between historical memory and current workspace truth.
6. If verification fails, remove authority for the current answer while preserving the original Task Thread, Working Set, Event / Episode, and Attempt / Decision records as historical memory.

Operational memory is still valuable here: it preserves which files mattered, which commands failed, and which branches were relevant as history. A failed revalidation does not turn that history into governance state; it only means the remembered code claim cannot be treated as current evidence. Only new proposed durable claims belong in Memory Candidate or Memory Inbox handling.

## Write Route and Candidate Lifecycle

Write behavior follows the same scope and intent discipline as retrieval. Not every useful signal becomes canonical truth.

1. Classify the new signal by scope and memory domain before writing anything durable.
2. Write direct operational state changes to Task Thread, Working Set, Event / Episode, and Attempt / Decision records when the interaction changes active work continuity.
3. Write direct personal updates only inside the personal/profile scope after the Scope Gate confirms that domain.
4. Write inferred, derived, contradictory, or ambiguous long-term claims into the Memory Inbox as candidates.
5. Write or link provenance into Source Records so candidate and promotion logic point to the canonical provenance destination.
6. Attach Source Record and contradiction context to every Memory Candidate strong enough to matter later.
7. Promote only after review, scope checks, contradiction checks, and provenance checks succeed.
8. Reject or supersede candidates explicitly rather than deleting their governance history silently.

The candidate lifecycle exists to keep derivation useful without letting it pollute canonical memory. A strong hint is still a candidate until it has passed the promotion boundary.

## GBrain Absorption Authority Routing Contract

`gbrain`'s facts/takes distinction is useful because it separates fast capture
from slower consolidation. `mbrain` absorbs that idea through domain-specific
write routing, not through cloned facts and takes tables.

Domain-specific write homes are selected before candidate or canonical write selection.

| Session signal | First routing question | Allowed destination | Forbidden shortcut |
|---|---|---|---|
| Active task state changed | Does this affect ongoing work continuity? | Task Thread, Working Set, Event, Attempt, or Decision. | Forcing operational continuity through Memory Inbox. |
| User states a durable personal preference or fact | Has the Scope Gate resolved personal scope and sensitivity? | Profile Memory, Personal Episode, or Memory Candidate for profile review. | Writing personal memory into work-visible canonical notes. |
| User states curated topic knowledge | Is there authoritative provenance and a target Markdown note or procedure? | Curated Markdown, Procedure, Source Record, or Memory Candidate. | Treating a conversational summary as compiled truth without source refs. |
| Imported or observed artifact | What source evidence must be preserved before synthesis? | Source Record plus derived indexes or candidates. | Promoting extracted claims without preserving the source boundary. |
| Inferred relationship or surprising link | Is the claim derived, ambiguous, or contradictory? | Memory Candidate with extraction kind and target object when known. | Treating a map edge or recurrence score as answer-grounding truth. |
| Code-sensitive claim | Can the current workspace verify path, symbol, branch, and test assumptions? | Verified response, operational stale marker, or Memory Candidate after verification. | Reusing historical code memory as current truth. |

Authority-routing rules:

1. The route starts with scope and domain, not with hot versus cold storage.
2. Direct canonical writes are allowed only when `02` and the owning workstream
   already classify the signal as authoritative for that domain.
3. Candidate-only state remains governance history until promotion, rejection,
   supersession, or canonical handoff finishes.
4. Promotion and handoff preserve Source Records, target identity, scope,
   sensitivity, and expected target snapshot evidence.
5. If no safe write home is clear, the signal stays ephemeral or becomes an
   explicitly ambiguous Memory Candidate.

## GA-P4 Memory Artifact Authority Matrix

GA-P4 makes authority labels explicit at activation time. The label says why an
artifact may influence an answer; it is not a new storage subsystem.

| Artifact | Activation | Authority | System of record or rebuild path |
|---|---|---|---|
| Compiled Truth | `answer_ground` after canonical read, `verify_first` when stale | `canonical_compiled_truth` | Curated Markdown page plus source-attributed timeline evidence. |
| Profile Memory | `answer_ground` only after Scope Gate `allow` | `profile_memory` | Profile Memory store owned by `07`; writes use personal scope preflight. |
| Personal Episode | `answer_ground` only after Scope Gate `allow` | `personal_episode` | Personal Episode store owned by `07`; append-only personal history. |
| Source Record or timeline evidence | `citation_only` | `source_or_timeline_evidence` | Historical evidence; supports citations and contradictions but is not current synthesis by itself. |
| Memory Candidate signal | `candidate_only` | `unreviewed_candidate` | Memory Inbox review state; must not ground answers before promotion or canonical handoff. |
| Context Map or codemap pointer | `orientation_only` or `verify_first` when stale | `derived_orientation` | Rebuild from canonical pages, manifests, source hashes, extractor versions, or live code verification. |
| Task Attempt or Decision | `suppress_if_valid`, `verify_first`, or `answer_ground` | `operational_memory` | Operational task records owned by `04`; historical code claims still need live verification for current answers. |

Profile Memory and Personal Episodes are canonical inside personal scope, but
they are not compiled truth. They must explain themselves as personal authority
so a response can say whether a claim came from stable profile memory, an
episode, or reviewed curated synthesis.

Derived projections are never the system of record. A map, atlas, codemap, or
candidate exposure can orient retrieval, but any answer-grounding claim must
follow back to a canonical page, personal record, Source Record, operational
record, or verified current artifact. If a projection is stale, the safe paths
are rebuild, verify, or fall back to the underlying canonical source.

## Personal Maintenance Phase Contract

Personal maintenance borrows the phase-runner discipline of `gbrain dream`, but
not its authority model. Maintenance phases produce reports, candidates, or governed apply requests.

Allowed phase outputs:

| Output | Authority | Example |
|---|---|---|
| Report | Non-mutating orientation | stale candidate report, derived freshness report, duplicate group summary |
| Candidate | Governance state, not truth | stale-claim challenge, duplicate-merge suggestion, profile update proposal |
| Governed apply request | Pending mutation request | reviewed canonical handoff or patch candidate that still needs control-plane validation |

Maintenance routing rules:

1. A phase may refresh derived artifacts when the owning derived layer permits it.
2. A phase may create Memory Candidates for inferred, ambiguous, stale, or
   contradictory signals.
3. A phase may not patch canonical Markdown, Profile Memory, or operational state
   directly unless the existing governed write path is invoked.
4. Apply-capable phases must expose dry-run behavior before mutation.
5. Phase results must be inspectable in retrieval traces, audit reports, or
   mutation ledger records when they influence later reads or writes.

## Retrieval Trace Requirements

Retrieval Traces are persisted as canonical operational records when the system needs durable explainability for how an answer was assembled or how a write was justified.

Each trace must capture:

- the active scope and intent route that governed retrieval
- which canonical artifacts were read
- which derived artifacts were consulted for orientation or ranking
- where verification occurred and what kind of verification it was
- whether the interaction produced operational writes, candidates, promotions, rejections, or no durable write at all

Retrieval Traces are canonical operational evidence, not performance caches. They exist so later evaluation can inspect how the loop behaved, where verification happened, and whether the route chosen by intent was appropriate.

## Fallback Rules

Fallbacks are controlled degradations, not excuses to ignore the protocol.

1. If Context Maps, Atlases, or Map Reports are stale or unavailable, fall back to curated notes and focused Source Record reads.
2. If canonical synthesis is thin, fall back to Source Records rather than inflating map-derived suggestions into truth.
3. If code verification cannot confirm a remembered claim, keep the historical operational record intact, drop the claim's authority for the current answer, and answer with the degraded confidence explicitly.
4. If scope is ambiguous, narrow scope before retrieval or durable write.
5. If the route selection remains ambiguous, prefer the narrower and more verifiable route over the broader and more speculative one.
6. If promotion checks cannot clear a candidate, keep it in governance state rather than forcing a canonical write.

Fallback behavior should preserve trust. The system may answer with less certainty or less breadth, but it must not answer with false certainty.

## Anti-Patterns

The following behaviors violate the redesign contract:

- treating retrieval as a fixed long-term -> short-term -> cache -> note sequence
- scanning raw files before loading Task Thread, Working Set, and Event / Episode records during task resume
- dumping raw graph or map output into prompts as if it were already verified knowledge
- treating inferred edges, summaries, or bridges as facts without canonical support
- using remembered code claims without current verification
- promoting ambiguous or contradictory claims directly into canonical memory
- allowing cross-scope retrieval or write behavior without an explicit scope decision
- mixing personal and work retrieval by default
- writing durable truth without Source Record provenance or without persisting the Retrieval Trace required for durable explainability
- hiding failure to verify behind fluent synthesis

If any of these behaviors occur, the system may still produce a plausible answer, but it is no longer operating under the intended memory contract.
