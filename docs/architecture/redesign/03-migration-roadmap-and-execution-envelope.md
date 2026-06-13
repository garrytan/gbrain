# MBrain Redesign Migration Roadmap and Execution Envelope

This document defines how the current `mbrain` repository should move toward the redesign target described in `01-target-architecture.md` while staying inside the protocol and compatibility boundaries established by `00-principles-and-invariants.md` and `02-memory-loop-and-protocols.md`. It owns rollout sequencing, execution constraints, rollback boundaries, and mapping to the current inefficiency workstreams. It does not redefine target-state objects or deep subsystem behavior.

## Current State Summary

`mbrain` is already a real TypeScript/Bun product with a meaningful engine boundary, partially centralized operations, multiple backend implementations, and actual local/offline usage paths.

The redesign therefore starts from these facts rather than abstracting them away:

- `src/core/engine.ts` is a useful contract boundary that should be exploited more consistently rather than replaced.
- SQLite, Postgres, PGLite, and local execution paths already exist and already shape user expectations.
- CLI and MCP surfaces already expose a meaningful product contract, even though command ownership is not yet cleanly split.
- Markdown import, sync, and human-edited knowledge artifacts are already part of how the system works in practice.

The migration problem is not "how to build a new memory system from scratch." The migration problem is how to improve the current repository so repeated-work prevention, derived orientation, governance, and scoped memory can arrive without regressing the existing product.

## Migration Strategy

The migration strategy is incremental and contract-preserving.

1. Preserve the current product boundary wherever possible and change internals before changing user-facing contracts.
2. Introduce new canonical or derived capabilities in additive phases rather than through a single architectural cutover.
3. Keep Markdown import, sync, and human inspection valid throughout the rollout.
4. Use phase-specific feature exposure, capability checks, and explicit acceptance gates to prevent backend skew from leaking into the public surface.
5. Treat rollback, parity, and local/offline fitness as design inputs for each phase rather than as release cleanup after implementation.

The practical consequence is that each phase must deliver value on top of the current codebase while leaving the system in a state that the next phase can build on safely. No phase should require the repository to stop being a local-first Bun/TypeScript product in order to make progress.

## Execution Envelope

The roadmap is only valid inside the following execution envelope.

| Constraint | Required Behavior |
|---|---|
| Local/offline execution | Existing local/offline paths remain available for legacy use, import/export, and escape-hatch recovery, but new personal-memory runtime features target managed or local Postgres first. |
| Backend and local-path isolation | New Postgres runtime capabilities must not be constrained by SQLite/PGLite parity. Legacy local engines stay explicitly isolated from target runtime behavior unless a phase deliberately ports a feature back. |
| Existing CLI/MCP contract | Existing CLI and MCP behavior should remain stable unless a phase explicitly versions or documents the change. Internal refactors do not justify silent contract drift. |
| Markdown continuity | Markdown notes and procedures remain valid canonical artifacts throughout migration. No phase may require converting human-curated knowledge into a DB-only representation. |
| Derived artifact status | Note manifests, context maps, atlases, reports, indexes, and similar artifacts remain regenerable derived state. Migration phases may add or refresh them, but may not let them silently replace canonical truth. |
| Additive rollout | Schema additions, service modules, and operation layering should be introduced additively where possible so that rollback can disable new paths without corrupting existing data. |
| Measurement discipline | Phases that touch local search, import throughput, resume workflows, structural extraction, or background analysis must define baseline and follow-up measurement early enough to shape the phase, not only to evaluate it after the fact. |
| Workstream grounding | Each phase must map to a concrete inefficiency already identified in the current repository, not to an abstract vNext aspiration detached from current bottlenecks. |

Within this envelope, Postgres is the target runtime for new personal memory features. SQLite and PGLite remain explicit legacy/local paths for existing workflows, but they must not silently define or dilute the Postgres runtime contract.

## Phase Breakdown

| Phase | Focus | Why It Comes Here |
|---|---|---|
| Phase 0 | Policy and compatibility | Establishes the envelope, parity rules, and rollback boundaries before new memory objects or read paths are introduced. |
| Phase 1 | Operational memory | Addresses repeated-work prevention first by adding durable task continuity to the current system. |
| Phase 2 | Structural extraction and derived orientation foundations | Captures the earliest Graphify-derived win through deterministic extraction without changing canonical truth rules. |
| Phase 3 | Orientation and navigation expansion | Makes the structural layer operational for navigation after the underlying derived foundation exists. |
| Phase 4 | Reusable operating knowledge | Converts repeated work patterns into reusable operating knowledge once active work continuity exists. |
| Phase 5 | Governance and review boundaries | Inserts the promotion boundary before more ambitious derived analysis can influence durable memory. |
| Phase 6 | Higher-noise derived analysis | Introduces richer derived signals only after governance controls exist. |
| Phase 7 | Later canonical knowledge consolidation | Adds slower-moving canonical knowledge structures only after operational memory, structural orientation, and governance are already in place. |
| Phase 8 | Evaluation harness and dream cycle | Turns the redesign into a measurable system after the major write and retrieval paths exist. |
| Phase 9 | Memory operations control plane | Adds governed write authority, mutation auditing, redaction lifecycle, and operator health checks after the evaluation harness can verify the full loop. |
| Phase 10 | System-of-record reconciler | Reconciles canonical Markdown and derived DB projections after governed write authority exists. |
| Phase 11 | Personal data connectors | Adds source-choice and connector framework foundations after source policy, raw ingest, and autopilot/runtime primitives exist. |
| Phase 12 | Review, audit, and health | Gives users a report-first audit surface after automation, lifecycle, and projection health have something concrete to summarize. |
| Phase 13 | Evaluation and replay | Adds lifecycle replay fixtures after report/audit surfaces can expose full-loop evidence. |
| Phase 14 | Migration and cleanup | Quarantines legacy runtime paths and updates user-facing guidance after replacement systems have executable checks. |

## Deliverables by Phase

| Phase | Deliverables |
|---|---|
| Phase 0 | Scope and policy schema additions, compatibility rules, semantic-parity checks across the supported backend and local surface, and baseline measurement for the workloads later phases will claim to improve. |
| Phase 1 | Durable active-work continuity, resume-oriented retrieval support, and verification that repeated-work prevention improves the current workflow without breaking existing contracts or regressing the supported execution paths against the recorded baselines. |
| Phase 2 | Deterministic structural extraction from canonical sources, derived orientation artifacts, and validation that Markdown-first knowledge remains the canonical substrate while extraction and sync costs are measured against the phase baselines. |
| Phase 3 | Broader orientation coverage, agent-usable navigation surfaces, and operational checks for staleness, discoverability, and local performance fitness using baseline and follow-up measurements rather than anecdotal improvement claims. |
| Phase 4 | Canonical reusable operating knowledge, durable rationale capture, and migration-safe integration with the active-work model established earlier. |
| Phase 5 | Reviewable governance state, explicit promotion boundaries, and acceptance controls that keep derived signals from bypassing provenance, scope, contradiction checks, or rollback safety for governance records. |
| Phase 6 | Richer derived analysis under governance, constrained exposure of higher-noise signals, and measured validation that the supported backend and local execution paths remain viable under the new workload. |
| Phase 7 | Later canonical knowledge consolidation, historical-validity safeguards, and controls that prevent inferred or outdated knowledge from outrunning current evidence. |
| Phase 8 | System-level evaluation, longitudinal comparison against the earlier baselines, regression detection for retrieval and scope isolation, and review loops for long-running maintenance. |
| Phase 9 | Memory mutation ledger, memory realms and sessions, governed patch application, dry-run mutation checks, redaction plan lifecycle, memory operations health reporting, and MCP acceptance coverage for the completed control plane. |
| Phase 10 | Projection target records, Markdown projection contracts, drift detection, reconciliation modes, and rollback-safe system-of-record repair boundaries. |
| Phase 11 | Connector registry, credential references, source sync protocol, minimal-consent source selection, connector health, and idempotent raw-ingest mapping without direct canonical writes. |
| Phase 12 | Daily/periodic memory report, audit query surfaces, doctor health expansion, failed-job/source/connector summaries, and report actions routed through governed operations. |
| Phase 13 | Deterministic replay fixture format, lifecycle trace coverage, policy/retrieval/projection/runner/source-safety checks, and budget-gated live eval hooks. |
| Phase 14 | Final docs and CLI help cleanup, setup-agent/rule updates, legacy engine quarantine, migration guide/helper behavior, config cleanup, and PR/release summary material. |

Deliverables should remain scoped to what the current repository can absorb phase by phase. If a deliverable requires a deeper subsystem contract, that contract belongs in the later workstream document for that subsystem rather than here.

## Phase Implementation Status

This table is the status crosswalk between the Phase 0-14 roadmap and the
current package scripts. A script can provide useful evidence without declaring
the corresponding roadmap phase fully accepted.

| Phase | Roadmap meaning | Current status | Evidence surface | Notes |
|---|---|---|---|---|
| Phase 0 | Policy, compatibility, parity, and baseline measurement | Evidence surface present | `bench:phase0`; parity coverage included in `test:phase1` | Baseline evidence exists, but later phases still need their own follow-up measurements. |
| Phase 1 | Operational memory and repeated-work prevention | Evidence surface present | `bench:phase1`; `test:phase1` | Acceptance still depends on comparable baseline output, not only a passing test command. |
| Phase 2 | Structural extraction and derived orientation foundations | Evidence surface present | `bench:phase2-*`; `test:phase2` | Derived artifacts remain rebuildable and may not replace canonical truth. |
| Phase 3 | Orientation and navigation expansion | Evidence surface present | `bench:phase3-*`; `test:phase3` | Route and trace evidence should remain tied to bounded-output and freshness checks. |
| Phase 4 | Reusable operating knowledge and personal scope boundaries | Evidence surface present | `bench:phase4-*`; `test:phase4` | Personal/profile acceptance requires explicit scope and visibility checks. |
| Phase 5 | Governance and review boundaries | Evidence surface present | `bench:phase5-*`; `test:phase5` | Passing evidence does not authorize bypassing provenance, scope, or contradiction gates. |
| Phase 6 | Higher-noise derived analysis under governance | Evidence surface present | `bench:phase6-*`; `test:phase6` | Candidate scoring and derived candidates remain reviewable, not direct canonical truth. |
| Phase 7 | Later canonical knowledge consolidation | Evidence surface present | `bench:phase7-*`; `test:phase7` | Historical-validity and canonical handoff evidence must preserve current-evidence discipline. |
| Phase 8 | Evaluation harness and dream cycle | Evidence surface present | `bench:phase8-*`; `test:phase8` | Dream-cycle evidence is maintenance/evaluation coverage, not a blanket acceptance of later phases. |
| Phase 9 | Memory operations control plane | Evidence surface present | `bench:phase9-acceptance`; `test:phase9` | Control-plane acceptance is scoped to governed write, mutation, redaction, and health contracts. |
| Phase 10 | System-of-record reconciler | Implementation evidence present / no dedicated phase alias | `test/system-of-record-reconciler-service.test.ts`; `test/markdown-projection-contracts.test.ts`; `test/page-projection-engine.test.ts` | Projection and reconciliation have targeted evidence, but there is no `bench:phase10` or `test:phase10` acceptance alias. |
| Phase 11 | Personal data connectors | Partial / no acceptance declared | Connector framework tests and source-registry tests | Framework and raw-ingest foundations exist, but connector acceptance should remain per-connector and inspectable. |
| Phase 12 | Review, audit, and health | Implementation evidence present / no dedicated phase alias | `test/memory-review-report-service.test.ts`; `test/memory-operations-health-service.test.ts`; `test/memory-operations-health-operations.test.ts`; `test:phase13` | Report actions and health summaries have targeted evidence, but there is no dedicated `bench:phase12` or `test:phase12` acceptance alias. |
| Phase 13 | Evaluation and replay | Deterministic replay evidence | `bench:phase13-replay`; `test:phase13` | This is deterministic replay plus live-eval budget gating; it is not proof that production live evals ran. |
| Phase 14 | Migration and cleanup | Runtime confidence gate present | `smoke:postgres-runtime` | This smoke is a Postgres target confidence gate; it does not accept skipped or partial Phase 10-12 work. |

## Mapping to Existing Inefficiency Workstreams

The roadmap is justified by the inefficiency analysis only if each phase reduces a real current cost.

| Existing Inefficiency Workstream | Relevant Phases | Migration Implication |
|---|---|---|
| Engine implementation duplication across SQLite, Postgres, and PGLite | Phase 0 through Phase 14 | Every phase should prefer shared services and capability flags over backend-specific product logic. New memory capabilities should enter through stable contracts rather than fan out into three divergent implementations. |
| Split between contract-first operations and CLI-only flows | Phase 0 through Phase 14 | New roadmap capabilities should land behind reusable operations or service layers first, with thin CLI and MCP adapters. The redesign should reduce accidental command-surface divergence instead of adding more of it. |
| Mixed Postgres connection ownership | Phase 0, Phase 1, Phase 5, Phase 7, Phase 9 | Phases that add canonical write paths or governance state must not deepen reliance on mixed singleton and instance access. They should move the system toward clearer ownership and transaction boundaries. |
| Full-scan local vector search in SQLite | Phase 2, Phase 3, Phase 6, Phase 8 | Structural maps and atlas features should improve orientation without assuming expensive semantic retrieval. Semantic map work must remain performance-aware for local backends and be measured explicitly before broad exposure. |
| Local import throughput limits caused by engine capability gaps | Phase 0, Phase 2, Phase 3, Phase 8 | Manifest extraction, map builds, and future dream-cycle workloads must be designed so the local path does not become a second-class throughput story. Capability modeling should remain explicit. |
| Code-to-doc drift after the local-first transition | Phase 0 and every later phase | Each phase must keep docs aligned with actual contract and runtime behavior. The redesign documents are part of the migration surface, not separate from it. |
| Missing benchmark baselines | Phase 0 through Phase 14 | The roadmap should establish baselines in Phase 0 and require phase-shaping measurement whenever a phase changes local search, import throughput, resume quality, extraction cost, background analysis, governed write behavior, connector sync, or migration cleanup. Retrieval and workflow wins are not accepted without measured evidence. |

This mapping is why the roadmap stays improvement-first. The phases are not just architecture milestones; they are a sequence for attacking today’s structural duplication, contract drift, local bottlenecks, and missing evidence discipline.

## Compatibility and Rollback

Compatibility and rollback rules apply to every phase.

| Area | Compatibility Rule | Rollback Rule |
|---|---|---|
| Markdown knowledge and procedures | Existing Markdown artifacts remain readable, writable, and syncable throughout migration. | If a new phase misbehaves, disable the new derivation or write path and continue using the existing Markdown artifacts as canonical state. |
| Source Records and provenance artifacts | Source Records remain readable, linkable, and usable as the canonical provenance destination throughout migration. | Roll back by disabling the new write or derivation path while preserving the previously written Source Records and their raw evidence so provenance does not fragment. |
| Operational records | New operational objects should be additive to existing behavior and should not invalidate legacy task workflows immediately. | Roll back by disabling new resume or capture flows while preserving written historical records. |
| Governance records | Memory Inbox, Memory Candidates, and promotion or supersession outcomes remain compatible canonical governance state throughout migration. | Roll back by disabling the new review or promotion path while preserving already written governance records and their statuses for later replay or re-review. |
| Retrieval Traces and explainability records | Retrieval Traces remain valid canonical explainability records even as routing and verification behavior evolves. | Roll back by disabling the new retrieval or trace-writing path without discarding already written traces needed for audit, evaluation, or later migration repair. |
| Derived artifacts | Context maps, atlases, reports, embeddings, and indexes remain derived and regenerable. | Roll back by ignoring or rebuilding the derived artifact; do not mutate canonical memory to compensate. |
| CLI and MCP surfaces | Existing commands and tools stay stable unless explicitly versioned or documented as changed. | Roll back by routing adapters back to the prior implementation path without breaking contract names where possible. |
| Backend and local-path parity | Public behavior should remain semantically aligned across the supported backend and local execution surface. | Roll back feature exposure on the skewed path rather than accepting silent parity breakage in the public contract. |
| Data migrations | Prefer additive schema changes and backfills over destructive rewrites. | Roll back by disabling reads or writes that depend on the new schema while leaving pre-existing data usable. |

Rollback is therefore phase-scoped rather than repo-wide. A failed derived feature should be removable without invalidating canonical memory, and a failed new canonical workflow should be disableable without requiring a repository reset.

## Test and Acceptance Gates

No phase is complete without fresh verification across the execution envelope.

| Gate | Required Evidence |
|---|---|
| Local/offline gate | The phase works in a local/offline configuration without requiring network-backed fallback for its core contract. |
| Backend and local-path parity gate | The phase preserves the same semantic result across the supported backend and local execution surface for its public contract, or else the temporary gap is explicitly hidden and documented. |
| Contract gate | CLI and MCP behavior remains stable or the versioned/documented change is verified intentionally. |
| Markdown continuity gate | Markdown import, sync, and canonical inspection still behave correctly after the phase lands. |
| Canonical record compatibility gate | Source Records, governance records, and Retrieval Traces remain readable, stable, and rollback-safe across the phase change. |
| Derived-versus-canonical gate | Derived outputs remain regenerable and do not silently modify canonical truth. |
| Benchmark or workload gate | Phases that affect local search, import, resume workflows, structural extraction, map builds, or background analysis include baseline and follow-up measurement rather than anecdotal claims. |
| Rollback gate | The team can identify the feature flag, adapter boundary, or schema dependency needed to disable the phase safely if needed. |

Minimum acceptance emphasis by phase:

- Phase 0 must prove compatibility rules, backend and local-path parity baselines, and the initial workload measurements before later phases depend on them.
- Phase 1 must prove task continuity and repeated-work prevention on current workflows and compare those gains against the Phase 0 baseline on the supported execution surface.
- Phases 2 and 3 must prove that structural orientation helps retrieval without introducing contract drift or local performance regression, and they must report the extraction and navigation costs that shaped the phase.
- Phases 5 through 7 must prove that governance, higher-noise derived analysis, and later canonical knowledge changes cannot bypass provenance, scope, or contradiction checks.
- Phase 8 must prove that the redesign can be evaluated as a system rather than by anecdote and that later measurements are comparable to the early baselines.
- Phase 9 must prove that governed write authority, mutation auditing, patch application, redaction, and operations health remain explicit, reviewable, rollback-safe, and semantically aligned across the supported execution surface.
- Phase 10 must prove projection reconciliation preserves Markdown as the system of record and leaves derived records rebuildable.
- Phase 11 must prove source choice, credential references, connector health, and raw-ingest mapping are persistent and inspectable before claiming connector acceptance.
- Phase 12 must prove report actions are executable governed operations or intentionally withheld when the current record state makes them invalid.
- Phase 13 must distinguish deterministic fixture interpretation from true end-to-end replay and must not claim full lifecycle replay until production services execute the flow.
- Phase 14 must prove migration guidance, fresh init defaults, setup prompts, and legacy runtime quarantine are aligned with the Postgres target runtime.

## Risk Register

| Risk | Why It Matters | Mitigation Direction |
|---|---|---|
| Backend skew | SQLite, Postgres, and PGLite or equivalent local execution paths may drift as new features land. | Do not make SQLite/PGLite parity a target-runtime release gate; instead keep legacy/local behavior explicitly scoped and hide or document unsupported target-only surfaces. |
| Local/offline regression | New map, governance, or evaluation work could quietly assume heavier runtime infrastructure than the current local path can support. | Measure local workloads when a phase intentionally supports them, but let Postgres-target features ship behind honest capability gates when legacy engines are out of scope. |
| Contract drift between operations, CLI, MCP, and docs | The redesign could add new behavior faster than the public contract is cleaned up. | Route new work through service or operation boundaries first and update docs as part of the same phase. |
| Candidate pollution | Derived or inferred signals may flood governance state and reduce trust. | Introduce scoring, triage, and promotion checks before semantic analysis becomes a primary workflow. |
| Scope leakage | Work and personal memory boundaries may blur as retrieval grows more capable. | Keep scope checks in the acceptance gates and require explicit scope decisions before cross-domain retrieval or writes. |
| Temporal drift in code-sensitive memory | Historical decisions may be mistaken for current workspace truth. | Keep verification requirements tied to code-sensitive claims and separate historical operational memory from current evidence. |
| Migration sprawl | Later phases may start redefining target-state architecture or subsystem internals inside rollout docs. | Keep this roadmap focused on sequencing and constraints; defer subsystem mechanics to the later workstream documents. |

## Sequence Rationale

Phase 0 comes first because the redesign needs an execution envelope before it needs new objects. If compatibility, local/offline constraints, rollback boundaries, backend and local-path parity, and the initial workload baselines are not explicit at the start, every later phase risks solving the architecture problem by making the current product less reliable.

Phase 1 comes next because repeated-work prevention is the first user goal and the strongest justification for redesign work that touches the live codebase. Durable task continuity also creates a safer base for later procedure capture, retrieval traces, and governance-aware writes.

Phase 2 follows because deterministic structural extraction is the earliest Graphify-derived gain that fits the current repository. It improves navigation and synthesis without forcing deeper subsystem commitments too early.

Phase 3 is sequenced after Phase 2 because broader orientation and navigation are only valuable once the derived structural foundation exists and staleness can be observed. It turns the structural layer into an actual agent aid rather than an offline artifact.

Phase 4 waits until after operational continuity and structural orientation because reusable operating knowledge is most useful when it can be grounded in real task history instead of premature abstraction.

Phase 5 must precede Phase 6 and Phase 7 because higher-noise derived analysis and later canonical knowledge changes both need a governance boundary. Without review controls, richer derived signals would bypass the trust model.

Phase 6 comes before Phase 7 because higher-noise derived analysis is still discardable and easier to constrain. It is a lower-risk way to learn from richer structure before introducing later canonical knowledge changes.

Phase 7 is intentionally late because later canonical knowledge changes are valuable only after the system already knows how to preserve provenance, contain contradictions, and distinguish current evidence from historical memory.

Phase 8 validates the full loop because evaluation and dream-cycle maintenance should measure system behavior rather than guess at isolated wins. Benchmarking, leakage checks, retrieval evaluation, and repeated-work tests are the evidence layer that tells the team whether the migration actually improved the existing product.

Phase 9 adds the memory operations control plane after that evidence layer exists. Mutation ledgers, memory realms and sessions, dry-run mutation checks, governed patch application, redaction plans, and health reporting are intentionally late because they grant durable write authority and need the earlier governance, scope, provenance, and acceptance machinery to fail closed.

Phase 10 follows the control plane because projection repair must be able to explain what it changes and why. It keeps Markdown as the durable system of record while making database projections auditable and repairable.

Phase 11 follows the source and runtime foundations because personal data connectors need source policy, raw-ingest provenance, and maintenance scheduling before users can safely choose new sources. Connector stubs are not full source-choice acceptance unless registration and consent decisions are persistent and inspectable.

Phase 12 comes after automation and lifecycle state because the daily report should summarize real activity, not invent a dashboard ahead of the underlying evidence. Report actions must be routed through governed operations and must only be offered when they can run against the current record state.

Phase 13 comes after review and audit because replay needs the full chain of records, jobs, events, reports, and projections to be observable. Deterministic fixtures can guard regressions early, but full phase acceptance requires executing the lifecycle flow rather than only interpreting declared fixture arrays.

Phase 14 is last because cleanup is only safe after replacement paths have executable evidence. It updates docs, setup, migration, and legacy-runtime boundaries so future work does not keep treating SQLite/PGLite parity as the target constraint for new Postgres runtime features.
