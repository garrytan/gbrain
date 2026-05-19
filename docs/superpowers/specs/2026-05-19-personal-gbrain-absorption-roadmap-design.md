# Personal GBrain Absorption Roadmap for MBrain

## Purpose

This design defines how `mbrain` should absorb the strongest ideas from
`reference/gbrain` without turning into a fast fork sync or importing structural
debt.

`mbrain` remains a personal, local-first durable memory substrate. The goal is
not to clone `gbrain` feature names or table names. The goal is to internalize
the operating principles that made `gbrain` stronger: maintenance cycles,
hot/cold memory boundaries, replayable evaluation, source isolation, code-aware
orientation, and self-maintenance.

The adoption path must preserve `mbrain`'s existing invariants:

- Markdown and canonical memory remain the answer-grounding substrate.
- Memory Inbox candidates remain governed state, not truth.
- Scope gates prevent personal/work leakage.
- Derived artifacts can orient retrieval but cannot authorize factual claims.
- Code-sensitive claims require live workspace verification.
- Local SQLite/offline operation remains the default path.

## Context

The two systems have diverged into different products.

`gbrain` has grown into a broad operational knowledge graph and company-capable
runtime. Its reference implementation includes a large dream cycle, multi-source
brains, HTTP MCP with OAuth, source-scoped clients, facts/takes storage, eval
capture/replay, background job runtime, and tree-sitter code intelligence.

`mbrain` has moved toward governed personal memory: canonical Markdown,
operational task memory, scoped personal memory, Memory Inbox promotion, source
attribution, retrieval traces, context maps, atlases, and local-first engines.

This roadmap treats `reference/gbrain` as a proven reference implementation, not
as a merge target. Direct ports are allowed only when the code already fits
`mbrain`'s engine, scope, and authority boundaries.

The reference baseline for this roadmap is `reference/gbrain` at
`03947665e4dbfeaf8a5542d160a0f4b89e4ae747` (`v0.36.0.0`). Later upstream reads
must pin their own baseline before changing adoption decisions.

## Contract Precedence

This roadmap is subordinate to the redesign constitution in
`docs/architecture/redesign/00-principles-and-invariants.md` through
`08-evaluation-and-acceptance.md`.

It does not create a parallel architecture surface. Any new contract introduced
here must either:

- extend the owning redesign workstream explicitly
- remain a roadmap-local planning artifact until that owning workstream is
  updated
- be rejected if it conflicts with an existing invariant

Ownership stays with the existing redesign documents:

| Concern | Owning contract |
|---|---|
| Canonical, derived, governance, and retrieval authority | `00-principles-and-invariants.md`, `01-target-architecture.md`, `02-memory-loop-and-protocols.md` |
| Operational task continuity | `04-workstream-operational-memory.md` |
| Context maps, atlases, and derived structural artifacts | `05-workstream-context-map.md` |
| Memory Inbox, promotion, handoff, mutation ledger, realms, sessions, and redaction control plane | `06-workstream-governance-and-inbox.md` |
| Profile Memory, Personal Episodes, and work/personal scope gates | `07-workstream-profile-memory-and-scope.md` |
| Baselines, acceptance thresholds, control-plane evaluation, and rollout gates | `08-evaluation-and-acceptance.md` |

### Stage Namespace

The absorption roadmap uses `GA-P0` through `GA-P7`. These are GBrain
Absorption phases, not the existing redesign `Phase 0` through `Phase 9`
defined in `08-evaluation-and-acceptance.md` and wired through `test:phase*` /
`bench:phase*` commands.

Every GA-P implementation plan must map its work to the existing redesign owner,
scenario suite, and verification command before code changes begin.

| Absorption stage | Existing redesign owners and verification surfaces |
|---|---|
| `GA-P0` Reference Classification | `docs/UPSTREAM_SYNC.md`, reference baseline SHA, direct-port denylist, useful upstream doc/test ledger |
| `GA-P1` Core Contracts | `02`, `05`, `06`, `07`, `08`, plus docs contract tests and scenario fixture tests |
| `GA-P2` Evaluation Foundation | `08`, `test:scenarios`, replay fixture tests, `docs/MBRAIN_VERIFY.md` |
| `GA-P3` Personal Corpus Lanes | `05`, `07`, Source Record/import tests, retrieval trace tests |
| `GA-P4` Memory Authority Model | `02`, `06`, `07`, `docs/superpowers/specs/2026-05-17-memory-consolidation-evaluation-design.md`, `test:phase5`, `test:phase7`, `test:phase8` |
| `GA-P5` Context And Code Intelligence | `02`, `05`, `08`, `reverify_code_claims`, `test:phase2`, `test:phase3`, `test/scenarios/s11-code-claim-verification.test.ts` |
| `GA-P6` Personal Maintenance Cycle | `06`, `08`, `test:phase8`, `test:phase9` |
| `GA-P7` Consolidation And Upstream Discipline | `docs/UPSTREAM_SYNC.md`, `docs/MBRAIN_VERIFY.md`, the adopted phase's scenario and bench surfaces |

### Relationship To Memory Consolidation Evaluation

This roadmap extends, and does not supersede,
`docs/superpowers/specs/2026-05-17-memory-consolidation-evaluation-design.md`.
That earlier spec remains the owner for candidate authority, update cadence,
consolidation audit, sequential retention, and exposure-to-disposition metrics.

Any GA-P work that touches candidate authority, hot/cold consolidation,
maintenance suggestions, or canonical handoff must state whether it reuses an
existing consolidation concept or adds a narrower GBrain-derived requirement.
It must not introduce parallel terminology when the consolidation spec already
owns the boundary.

## Non-Goals

- Do not make `mbrain` a company/team product in this roadmap.
- Do not import HTTP OAuth, admin dashboards, teammate-scoped writes, or hosted
  multi-user access.
- Do not copy `gbrain`'s Minions/job runtime as a prerequisite for maintenance.
- Do not reproduce `facts` and `takes` as direct table clones.
- Do not introduce a second scope system under the name `corpus lane`.
- Do not require Postgres-only behavior for core personal memory features.
- Do not let maintenance cycles mutate canonical truth without the existing
  promotion, handoff, provenance, and snapshot checks.

## Adoption Axes

| Axis | GBrain idea | MBrain absorption |
|---|---|---|
| Maintenance cycle | `dream` phase runner and overnight upkeep | Personal maintenance regimen for review, audit, stale checks, duplicate review, and derived refresh. |
| Facts/takes distinction | Hot facts flow into cold takes | Domain-specific write routing with explicit authority stages: session signal, Source Record, task memory, Memory Candidate, Profile Memory, Personal Episode, Compiled Truth, or canonical handoff. |
| System-of-record discipline | Markdown fences, extract/reconcile phases, rebuildable DB projections | Preserve Markdown/canonical evidence as the durable source while allowing derived DB/index projections to be rebuilt, reconciled, and checked for round-trip drift. |
| Eval/replay | LongMemEval, BrainBench, capture/replay | Personal regression harness for retrieval, governance, task resume, scope isolation, and candidate lifecycle. |
| Source isolation | Sources, federated reads, source-scoped writes | Source/artifact metadata inside an existing scope, used to distinguish notes, worktrees, transcripts, imports, and derived corpora without creating new write authority. |
| Code intelligence | Tree-sitter chunks, symbol graph, callers/callees | Context Map code lane with symbol metadata, invalidation/backfill controls, default-off graph walking, fanout caps, and mandatory live verification for current code claims. |
| Self-improvement loop | Nightly consolidation and enrichment | Reviewable suggestions and audit reports, not automatic canonical truth writes. |

## GA-P Roadmap

The roadmap is dependency-based, not calendar-based. Each GA-P phase must establish
contracts, verification, and authority boundaries before later automation builds
on it.

### GA-P0: Reference Classification

Classify `reference/gbrain` by feature area and implementation surface.

Required output:

- Adoption matrix with `adopt`, `adapt`, `reject`, and `later` decisions.
- Pinned upstream baseline SHA, tag, and local reference path used for the
  classification.
- Direct-port denylist for code, directories, migrations, and runtime surfaces
  that would violate `mbrain` invariants.
- Useful-reference ledger naming which `gbrain` docs, tests, migrations, and
  source files are evidence for each adopted idea.
- Explicit classification for `gbrain`'s system-of-record and reconciler
  discipline, separate from the `facts`/`takes` hot/cold distinction.

Completion criteria:

- Every major `gbrain` area relevant to personal `mbrain` is classified.
- Skipped company/runtime surfaces have explicit rationale.
- The classification is written before implementation begins.
- A future agent can tell which exact upstream snapshot was reviewed.
- Direct ports are impossible to justify without crossing a recorded allow or
  deny decision.

### GA-P1: Core Contracts

Define stable contracts for the concepts that future work needs.

Required output:

- Maintenance phase contract.
- Personal corpus lane contract, defined as source/artifact metadata inside an
  existing `scopeId`, not as a new scope or authority system.
- Eval replay fixture schema.
- Code-lane derived artifact contract.
- Authority-stage terminology that maps session signals to the correct
  domain-specific canonical or governance home before any promotion path is
  chosen.

Completion criteria:

- New concepts have a documented responsibility and authority level.
- Engine and service boundaries are clear enough to test independently.
- New contracts name the redesign workstream they extend instead of standing
  alone.
- New contracts map to an executable scenario, fixture, phase test, or bench
  command before they can be considered implementable.
- No new concept can be mistaken for canonical answer-grounding truth unless it
  explicitly is canonical truth.

### GA-P2: Evaluation Foundation

Build measurement before adding powerful behavior.

Required output:

- Replay fixture format for captured or hand-authored retrieval cases.
- Retrieval regression tests.
- Candidate lifecycle regression tests.
- Task resume fidelity tests.
- Scope leak tests.
- Derived refresh regression checks.

Completion criteria:

- A future search, code-lane, or maintenance change can be evaluated before and
  after the patch.
- Candidate-only signals cannot become answer-grounding evidence unnoticed.
- Task resume output preserves current goal, blocker, failed attempts,
  decisions in force, and verification warnings.

### GA-P3: Personal Corpus Lanes

Reinterpret `gbrain` sources as personal corpus lanes, not team ACL scopes and
not a second scope system.

A corpus lane is source or artifact metadata within an already resolved
`scopeId`. It may describe where evidence came from, which import/worktree
produced it, or which derived corpus should refresh. It must not decide whether
work, personal, or mixed memory may be read or written.

Lane metadata only partitions retrieval subsets inside an already chosen
canonical domain. It never replaces Source Records, imported-artifact boundaries,
retrieval traces, or scope-gate decisions.

Required output:

- Corpus lane model.
- Lane resolver that runs after the Scope Gate and cannot override it.
- Lane-aware retrieval metadata.
- Lane-aware citation format.
- Import and sync boundaries for notes, worktrees, transcripts, and imported
  source material.
- Mapping from lanes to existing Source Records, page metadata, retrieval traces,
  context-map source-set hashes, and import origins.
- Lane-to-Source Record and lane-to-import-origin tests.

Completion criteria:

- Ambiguous writes fail instead of silently picking a lane.
- Retrieval can explain which lanes were searched.
- Lane metadata improves routing and citation without weakening scope gates.
- Lane metadata never grants write authority and never substitutes for work,
  personal, or mixed scope.
- Lane-aware retrieval must still preserve Source Record routing and imported
  artifact identity.

### GA-P4: Memory Authority Model

Absorb the useful part of `facts` versus `takes` as an authority model.

The transferable idea is not a generic hot-signal funnel. The deeper upstream
lesson is that canonical artifacts and derived DB/index rows must have a
disciplined system-of-record relationship. `mbrain` has multiple canonical homes,
each with different write rules: Source Records, Task Threads, Working Sets,
Attempts, Decisions, Profile Memory, Personal Episodes, curated Markdown,
procedures, and Memory Inbox governance state. GA-P4 must route a signal to the
correct domain before deciding whether it is direct canonical state,
candidate-only state, or a handoff proposal.

Required output:

- Session signal classification rules.
- Domain-specific write-home routing matrix.
- Candidate authority and activation rules.
- Promotion and canonical handoff invariants.
- Profile-memory versus compiled-truth routing rules.
- System-of-record and reconciler rules for any derived projection introduced by
  GBrain absorption.
- Tests for contradictions, supersession, stale claims, and provenance loss.

Completion criteria:

- Hot session signals have a safe route into Memory Inbox or scoped canonical
  domains.
- Promotion cannot bypass scope, contradiction, provenance, or target snapshot
  checks.
- The system can explain whether a claim is ephemeral, candidate-only,
  historical, profile memory, compiled truth, or derived orientation.
- Operational continuity writes are not forced through the Memory Inbox when
  `02-memory-loop-and-protocols.md` and `04-workstream-operational-memory.md`
  already define a direct canonical write path.
- Derived projections can be rebuilt or reconciled without changing canonical
  memory authority.

### GA-P5: Context And Code Intelligence

Absorb code intelligence as a derived Context Map lane.

Required output:

- Code chunk metadata model.
- Symbol node and edge model for context maps.
- Code claim verification protocol.
- Indexing and retrieval prerequisites, including chunk-grain lookup semantics
  appropriate for each supported engine.
- Backfill, reindex, and invalidation strategy for chunker or extractor version
  changes.
- Default-off graph-walk controls, explicit depth limits, high-fan-out caps, and
  bounded output behavior.
- Local/offline performance and regression acceptance gates before new code
  retrieval behavior becomes default.
- Initial code retrieval tests for definition, reference, caller, callee, and
  nearby-context questions.

Completion criteria:

- Symbol graph data is derived orientation.
- Current code claims are verified against the live workspace before being
  presented as current truth.
- Code metadata improves navigation without replacing `rg`, exact file reads,
  or current branch verification.
- Reindex and invalidation behavior cannot silently leave stale symbol graphs in
  the retrieval path.
- Graph expansion is opt-in until evaluation proves it improves code retrieval
  without regressing prose, local/offline performance, or scope isolation.

### GA-P6: Personal Maintenance Cycle

Expand `mbrain`'s dream-cycle maintenance into a personal review and audit loop.

Required output:

- Maintenance phase runner or phase service contract.
- Dry-run report format.
- Stale candidate review suggestions.
- Duplicate merge suggestions.
- Derived artifact freshness report.
- Optional explicit apply path that routes through existing promotion/handoff
  operations.
- Apply-path control-plane requirements: active realm/session authorization,
  mutation-ledger coverage, target snapshot conflict detection, dry-run/apply
  validation parity, and redaction/privacy fail-closed behavior.

Completion criteria:

- Default maintenance mode is report-only or suggestion-only.
- Canonical writes require existing governed write paths.
- Maintenance can identify stale, duplicated, unresolved, or drifted memory
  without silently mutating truth.
- Dry-run and apply paths perform the same validation, except apply may mutate
  only after authorization and conflict checks pass.
- Maintenance writes cannot bypass memory mutation ledger, realm/session,
  redaction, or target snapshot requirements from
  `06-workstream-governance-and-inbox.md` and
  `08-evaluation-and-acceptance.md`.

### GA-P7: Consolidation And Upstream Discipline

Keep the reference relationship auditable.

Required output:

- Updated design docs.
- Updated `docs/UPSTREAM_SYNC.md` when code or behavior is adopted.
- Verification checklist for each adopted area.
- Skipped and deferred rationale.

Completion criteria:

- A future agent can see what came from `gbrain`, what was reinterpreted, what
  was rejected, and why.
- Tests and docs match the implementation state.
- No adopted reference area is left as an unexplained fork artifact.

## Implementation Priority

Priority is based on debt risk, not feature appeal.

| Priority | Work | Reason |
|---|---|---|
| P0 | `GA-P0` and `GA-P1` | Wrong classification or weak contracts would corrupt every later adoption. |
| P1 | `GA-P2` | Regression measurement must exist before stronger retrieval, code, or maintenance behavior. |
| P2 | `GA-P4` | Memory authority has to be fixed before hot/cold consolidation ideas are implemented. |
| P3 | `GA-P3` | Corpus lanes affect retrieval, import, citation, and future maintenance. |
| P4 | `GA-P5` | Code intelligence is useful only if derived/current truth boundaries are already enforced. |
| P5 | `GA-P6` | Automation should arrive after verification and authority boundaries. |
| P6 | `GA-P7` | Documentation and upstream discipline keep the reference relationship healthy over time. |

## Risk Controls

| Risk | Control |
|---|---|
| Fast porting creates structural debt | Classify first, define contracts second, port only when boundaries already match. |
| Roadmap contracts drift from redesign contracts | Treat `00` through `08` as the owning constitution; roadmap contracts must extend those documents or remain planning-only. |
| GA-P phases conflict with redesign phases | Use `GA-P*` names for absorption work and map every implementation slice to existing `test:phase*` / `bench:phase*` surfaces. |
| Candidate-only evidence becomes truth | Tests must preserve `candidate_signal` versus `answer_ground` separation. |
| Corpus lanes cause scope leakage | Lanes are source/artifact metadata inside resolved scope, not independent scope or write authority. |
| Hot signals flatten into one generic memory funnel | Domain-specific write-home routing must run before candidate or canonical write selection. |
| Source/artifact metadata replaces provenance | Corpus lanes must map back to Source Records, import origins, and retrieval traces instead of becoming a second provenance model. |
| Code graph is treated as current code fact | Code graph stays derived; current claims require live verification, graph walking stays default-off until evaluated, and stale indexes fail safe. |
| Maintenance hardens wrong memory | Default maintenance output is reviewable report or suggestion; apply paths must pass realm/session, ledger, snapshot, and redaction controls. |
| Postgres assumptions break local-first use | Engine-neutral contracts and backend parity tests come before engine-specific code. |
| Company features bloat personal mbrain | HTTP OAuth, admin UI, teammate writes, and Minions remain out of scope. |

## Reference Surfaces

Primary `gbrain` references:

- `reference/gbrain/README.md`
- `reference/gbrain/src/core/cycle.ts`
- `reference/gbrain/docs/architecture/system-of-record.md`
- `reference/gbrain/docs/takes-vs-facts.md`
- `reference/gbrain/docs/architecture/brains-and-sources.md`
- `reference/gbrain/docs/guides/multi-source-brains.md`
- `reference/gbrain/docs/eval-bench.md`
- `reference/gbrain/docs/eval-capture.md`
- `reference/gbrain/docs/eval-takes-quality.md`
- `reference/gbrain/docs/designs/CODE_CATHEDRAL_II.md`

Primary `mbrain` anchors:

- `docs/architecture/redesign/00-principles-and-invariants.md`
- `docs/architecture/redesign/01-target-architecture.md`
- `docs/architecture/redesign/02-memory-loop-and-protocols.md`
- `docs/architecture/redesign/04-workstream-operational-memory.md`
- `docs/architecture/redesign/05-workstream-context-map.md`
- `docs/architecture/redesign/06-workstream-governance-and-inbox.md`
- `docs/architecture/redesign/07-workstream-profile-memory-and-scope.md`
- `docs/architecture/redesign/08-evaluation-and-acceptance.md`
- `docs/superpowers/specs/2026-05-17-memory-consolidation-evaluation-design.md`
- `docs/UPSTREAM_SYNC.md`

## Acceptance Criteria

This roadmap is accepted when:

1. Future work starts from `GA-P*` contracts and tests rather than direct ports.
2. `gbrain` ideas are traceable to `mbrain` concepts without losing authority
   boundaries.
3. Personal-only scope is preserved.
4. Evaluation precedes automation.
5. Maintenance suggestions remain reviewable unless explicitly routed through
   governed canonical write paths.
6. Upstream adoption is documented as deliberate `mbrain` design, not accidental
   fork drift.
7. Each GA-P implementation slice updates the existing redesign owner,
   `docs/MBRAIN_VERIFY.md`, and at least one executable fixture, scenario, phase
   test, or bench surface for every contract family it introduces.
