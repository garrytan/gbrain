# Latest GBrain Ideas Adoption Spec For MBrain

Date: 2026-06-21
Status: Concrete spec, implementation pending
Author: scott.lee + agent
Worktree: `/Users/meghendra/Work/mbrain/.worktrees/spec-gbrain-ideas-adoption`
MBrain baseline: `399143092b08966fbdb54190b1da066291b87abb`
GBrain baseline: `garrytan/gbrain@9bf96db807c2f050449142f2f0b05726f58e5054`

## Goal

Identify latest GBrain ideas that should be adopted by MBrain, but only when
they improve MBrain's current runtime, governance, or evaluation behavior.

This is intentionally not a 1:1 sync plan. MBrain and GBrain now have different
architecture, authority boundaries, and runtime goals. A GBrain feature is
accepted only if it survives a code-grounded fit check against current MBrain.

The primary decision question is:

> Is any GBrain idea better than the current MBrain approach, and if so, should
> MBrain adopt that better method directly instead of forcing it into an
> inefficient MBrain-shaped compromise?

Answer: yes, in a few places. The best immediate adoption is bounded stale
embedding backfill. The best medium-term adoptions are typed doctor remediation
plans and fail-closed conformance gates. Several GBrain ideas are explicitly
rejected because MBrain already has stronger evidence and writeback governance.

## Review Method

This spec is code-first:

- MBrain conclusions were grounded in `src/**`, `test/**`, and current operation
  behavior, not only documentation.
- Latest upstream GBrain was checked at `garrytan/gbrain@9bf96db8`.
- `meghendra6/gbrain` was checked and points at the MBrain repository state, so
  it was not used as the upstream GBrain source.
- Five parallel exploration subagents reviewed independent slices:
  - Embedding/backfill behavior.
  - Doctor remediation output and safety.
  - Operation conformance and memory-verb compatibility.
  - Retrieval evidence, writeback governance, and no-go constraints.
  - Latest upstream GBrain feature scan.
- Two objective review subagents then reviewed this spec:
  - One against current MBrain code and tests.
  - One against latest upstream GBrain and MBrain architecture fit.

## Executive Decisions

| Decision | Priority | Result | Reason |
| --- | --- | --- | --- |
| Bounded stale embedding backfill | P0 | Adopt | Current MBrain queues all stale chunks before one flush/write pass. GBrain's backfill discipline points to a better, bounded approach. |
| Doctor `remediation_plan` JSON | P0/P1 | Adopt, report-only first | GBrain's typed remediation planning is better than free-text advice, but MBrain must not auto-repair governance-sensitive surfaces yet. |
| Operation golden manifest and scorecard | P0/P1 | Adopt | MBrain already has a strong operation registry; it lacks a checked manifest and CI-facing compatibility scorecard. |
| Retrieval qrels and correctness gates | P1 | Adopt earlier | GBrain's source-aware retrieval gates are better than leaving ranking quality as an optional late experiment. |
| Retrieval/read/writeback metadata | P1 | Adapt | GBrain has useful source/evidence metadata ideas. MBrain should add metadata without changing the `retrieve_context -> read_context` evidence boundary. |
| Selector-first push context | P2 | Adapt only | Useful only as bounded selector pointers. Raw context injection or candidate-as-answer-ground is rejected. |
| Full Minions/supervisor port | P2/P3 | Defer/adapt tests only | GBrain's job runtime is richer, but MBrain already has maintenance-runtime primitives. Do not port wholesale before a concrete need. |
| Hot facts/takes as direct authority | No-go | Reject | MBrain's assertion pipeline, Memory Inbox, and canonical read boundary are stricter and should stay stricter. |
| Auto-heal canonical writes | No-go | Reject for now | Doctor may plan and preview. It must not mutate canonical memory or external config automatically. |

## Current MBrain Evidence

### Embedding Backfill

Current `embed --stale` is safe for correctness but not bounded enough for large
backfills:

- `src/commands/embed.ts:89` loads up to `100000` pages in one call.
- `src/commands/embed.ts:98-109` creates one `EmbeddingQueue` with
  `autoFlush: false`.
- `src/commands/embed.ts:110-146` accumulates all page plans and result promises
  before flushing.
- `src/commands/embed.ts:148` flushes once after all target chunks have been
  submitted.
- `src/commands/embed.ts:151-167` writes page chunk updates only after the full
  flush.
- `src/commands/embed.ts:181-184` defines stale selection as missing
  `embedded_at` or model mismatch.
- `src/core/embedding-queue.ts:10-12` already caps provider batch size and
  concurrency at `100` and `2`.
- `src/core/embedding-queue.ts:156-194` fails only affected submissions on
  provider errors.

Conclusion: the weakness is not provider concurrency. The weakness is retaining
too many pages, chunks, promises, and embedding outputs until the single final
flush/write pass.

### Doctor

Current doctor output is too free-form for machine-actionable remediation:

- `src/core/services/doctor-service.ts:34-44` defines `DoctorReport` as
  `status`, `checks`, and optional `agent_explain`.
- `src/commands/doctor.ts:17-54` prints that report as JSON for `--json`.
- `src/core/services/doctor-service.ts:512-780` assembles checks centrally.
- `src/core/services/doctor-service.ts:656-679` already knows embedding repair
  guidance such as `mbrain embed --stale`, but only as text.
- `src/core/services/doctor-service.ts:776-780` keeps top-level status healthy
  unless a check is `fail`; `warn` does not make doctor unhealthy.

Conclusion: doctor already computes useful signals, but remediation advice is
not structured enough for agents, CI, or safe follow-up tooling.

### Operation Contract And Evaluation

MBrain has a strong contract substrate:

- `src/core/operations.ts` is the single operation registry.
- Runtime introspection found 182 operations, no duplicate names, 74 mutating
  operations, and 108 read-only operations.
- `src/mcp/tool-schema.ts` derives MCP schema from operations.
- `src/mcp/server.ts` dispatches MCP calls through the operation layer.
- `src/cli.ts` shares most operation dispatch, with narrow CLI-only exceptions.
- Existing S27-S32 scenario tests already encode GBrain absorption slices:
  retrieval/candidate lifecycle, authority/writeback, corpus lanes, code lane,
  personal maintenance, and upstream discipline.

Conclusion: MBrain should not add a new broad memory API. It should freeze and
score the existing operation contract. It should also add a first-class
retrieval-quality gate, because current replay scenarios do not replace a
source-aware qrels/ranking regression gate.

### Retrieval And Governance

MBrain's evidence boundary is stronger than GBrain's general memory surfaces:

- `retrieve_context` is a probe that produces required reads, read plans,
  candidate pointers, and warnings.
- `read_context` is the canonical evidence boundary and checks selector scope,
  content hashes, staleness, windows, continuations, conflicts, and answer
  readiness.
- Candidate signals are noncanonical and carry `activation: candidate_only`.
- `route_memory_writeback` blocks task mechanics, missing provenance, missing
  import lane, ambiguous targets, and missing snapshots for agent-mediated
  writeback flows.
- `put_page` itself allows direct page-backed canonical writes when source
  attribution and expected content hash protection are present.
- Profile-memory and personal-episode operations are canonical non-page stores
  with their own provenance requirements.

Conclusion: GBrain metadata ideas are useful, but MBrain must not weaken the
probe/read/writeback split.

## Current GBrain Signals

Latest upstream GBrain provides useful ideas in these areas:

- Embedding backfill:
  - `src/core/embed-backfill-submit.ts`
  - `src/core/minions/handlers/embed-backfill.ts`
  - `src/core/embed-stale.ts`
  - Key ideas: per-source locking, cursor/keyset progress, idempotent stale
    reruns, bounded jobs, and backfill handler separation.
- Doctor remediation:
  - `src/core/remediation/plan.ts`
  - `src/core/remediation/run.ts`
  - `src/core/doctor-cause-rank.ts`
  - Key ideas: pure plan, executor split, sparse cause ranking, dry-run,
    checkpoint resume, dependency cascade, and per-step recheck.
- Evaluation and conformance:
  - `src/commands/eval-gate.ts`
  - `src/core/bench/correctness-gate.ts`
  - `src/eval/retrieval-quality/harness.ts`
  - Key ideas: source-aware qrels, hard/soft gate families, and fail-closed
    regression/correctness gates.
- Operation contract:
  - `src/core/operations.ts`
  - `src/mcp/tool-defs.ts`
  - `src/mcp/dispatch.ts`
  - Key ideas: contract-first operation definition and shared transport
    dispatch.
- Retrieval metadata and pointer context:
  - `src/core/search/evidence.ts`
  - `src/core/context/retrieval-reflex.ts`
  - `src/core/context/volunteer.ts`
  - Key ideas: richer source/evidence metadata and pointer-first context
    volunteering.

GBrain surfaces not suitable for direct MBrain adoption:

- DB-only fact write or forget fallbacks when no canonical fence exists.
- Raw push-context injection into prompts.
- Candidate or hot-memory facts as answer-ground without canonical read.
- Full hosted/team/admin runtime surfaces.
- Full Minions/supervisor runtime before MBrain has a concrete job-runtime need.

## Workstream A: Bounded Stale Embedding Backfill

Priority: P0

### Decision

Adopt the GBrain backfill discipline as a bounded MBrain CLI implementation
first. Do not keep MBrain's current all-pages/all-plans/all-results flow.

Do not add arbitrary sleep pacing in the first implementation. Provider pressure
is already capped by `EmbeddingQueue` batch size and concurrency. Pacing should
be added later only when tied to a real signal such as DB contention, provider
rate-limit response, or foreground-pressure policy.

### Requirements

1. Replace `embedAll()` with a bounded window loop.
   - Fetch a page window.
   - Refresh derived storage for each page.
   - Ensure chunks for each page.
   - Select target chunks using the current stale rules.
   - Submit only the current bounded window to `EmbeddingQueue`.
   - Flush.
   - Upsert successful page updates immediately.
   - Release references before the next window.

2. Preserve existing stale semantics.
   - Always call derived refresh and `ensurePageChunks` before stale selection.
   - Do not replace stale selection with a SQL-only `embedded_at IS NULL`
     shortcut.
   - Keep model drift handling.
   - Keep invalid-dimension refresh behavior.
   - Keep frontmatter-derived chunk add/remove behavior.
   - Keep old-snapshot skip behavior for concurrent page mutation.

3. Bound memory explicitly.
   - Introduce internal options for `pageWindowSize` and/or
     `maxQueuedChunks`.
   - The default should be conservative and local-friendly.
   - No run should retain all pages, all target chunks, all original chunks,
     and all embedding outputs at once.

4. Preserve failure-soft progress.
   - Provider failure for one page or batch leaves affected pages stale.
   - Write failure for one page does not block later pages.
   - Completed windows remain persisted if the process is interrupted later.
   - End summary includes provider failures and write failures.

5. Progress output must be actionable.
   - Pages scanned.
   - Pages touched.
   - Chunks queued.
   - Chunks embedded.
   - Skipped derived-refresh pages.
   - Provider failures.
   - Write failures.
   - Window count.

6. More than 100,000 pages must not be silently skipped.
   - Prefer cursor/keyset pagination if the engine supports it cleanly.
   - If only `limit`/`offset` exists initially, the implementation must loop
     until an empty page window and must document the offset stability
     assumption.

7. Optional CLI flags may be added only if they match existing CLI style.
   - `--dry-run`: report scan/target counts without embedding or writing.
   - `--limit`: cap pages scanned for safe manual testing.
   - Do not add `--source` unless there is already a stable source/page
     selector path in the engine layer.

### Non-Goals

- No embedding provider change.
- No embedding model change.
- No DB schema change in the first PR.
- No durable embedding job table in the first PR.
- No Dream Cycle automation in the first PR.
- No arbitrary sleep pacing in the first PR.
- No import-time auto-backfill until the bounded CLI path is proven.

### Acceptance Tests

Add focused tests:

- Large fake corpus processes more than one page window.
- More than 100,000 fake pages are not skipped.
- Max queued chunks never exceeds the configured bound.
- Writes happen after each window, not only at the end.
- Provider failure leaves failed pages stale and later pages can persist.
- Write failure for one page does not block later pages.
- `--stale` still repairs model drift, invalid dimensions, frontmatter changes,
  obsolete chunks, and old-snapshot skips.

Required verification for the implementation PR:

```bash
bun test test/embedding-queue.test.ts test/chunk-embedding-freshness.test.ts test/derived-worker.test.ts
bun test test/local-offline.test.ts --test-name-pattern "stale-only embedding"
```

### Later Extension

After the bounded CLI path is proven, consider durable job integration:

- Add a maintenance-runtime job type such as `embed_backfill`.
- Use idempotency keys to coalesce duplicate backfill requests.
- Store a progress cursor.
- Add per-source locking if source-scoped backfill becomes real.
- Adopt GBrain-style lock-renewal and stall-rescue tests if the job becomes
  long-running.

Do not port GBrain Minions wholesale unless MBrain's current maintenance runtime
is proven insufficient.

## Workstream B: Doctor Remediation Plan JSON

Priority: P0/P1

### Decision

Adopt GBrain's pure remediation-plan idea, but not automatic repair.

MBrain doctor should emit a typed `remediation_plan` in JSON output. The plan
should be report-only, deterministic, redacted, and safe for agents to inspect.
The first implementation must not auto-apply changes.

### Report Shape

Add an optional field to `DoctorReport`:

```ts
remediation_plan?: {
  schema_version: 1;
  mode: 'report_only';
  summary: {
    action_count: number;
    highest_priority: 'p0' | 'p1' | 'p2' | 'none';
    auto_apply_supported: false;
  };
  actions: Array<{
    id: string;
    check_name: string;
    check_status: 'warn' | 'fail';
    category:
      | 'agent_setup'
      | 'runtime_config'
      | 'database_schema'
      | 'embedding'
      | 'sync'
      | 'memory_governance'
      | 'process_lifecycle'
      | 'manual_investigation';
    priority: 'p0' | 'p1' | 'p2';
    cause_rank: number;
    downstream_of?: string[];
    title: string;
    rationale: string;
    commands: Array<{
      kind: 'inspect' | 'preview' | 'manual' | 'apply';
      command: string;
      mutating: boolean;
      requires_user_confirmation: boolean;
      effects: string[];
    }>;
    safety: {
      auto_apply_allowed: false;
      reason_codes: string[];
      canonical_write: false;
      external_mutation: boolean;
      filesystem_write: boolean;
    };
    verification: Array<{
      command: string;
      expected: string;
    }>;
  }>;
};
```

### Requirements

1. Keep existing doctor compatibility.
   - Existing `status` and `checks` stay unchanged.
   - Existing `agent_explain` stays unchanged.
   - `warn` checks must not make top-level `status` unhealthy.

2. Add actions only for `warn` and `fail` checks.
   - `ok` checks produce no actions.
   - Mapping is by stable `check.name` and structured inputs, not by parsing
     free-form messages.
   - Known check-name mappings must have drift tests so new/renamed checks do
     not silently lose remediation.

3. Rank root causes before downstream symptoms.
   - Adopt GBrain's sparse cause-ranking idea directly.
   - Use explicit cause edges only when MBrain code has a known dependency.
   - Include `cause_rank` and optional `downstream_of` in actions.
   - Do not infer causal chains from free-form messages.

4. Agent setup actions reuse setup-agent vocabulary.
   - Prefer `mbrain setup-agent --preview`.
   - Optionally include `mbrain setup-agent --diff`.
   - Do not auto-run `mbrain setup-agent --apply`.

5. These surfaces are always manual/preview-only in the first implementation:
   - Schema migrations.
   - `pgvector` SQL.
   - RLS changes.
   - System-of-record repair.
   - Memory runtime dead/stuck jobs.
   - Prompt-injection flags.
   - Purge candidates.
   - MCP registration mutation.

6. Never include canonical writes in doctor remediation.
   - Doctor can recommend investigation or governed control-plane flows.
   - Doctor must not call `put_page`.
   - Doctor must not bypass `route_memory_writeback`.

7. Redact or avoid user config contents.
   - Preserve existing no-leak behavior from setup-agent preview/diff tests.

### Acceptance Tests

Add or extend:

- `test/doctor.test.ts`
  - `embeddings` warn maps to `mbrain embed --stale`.
  - `schema_version` warn maps to manual migration guidance.
  - sync recency/watch warn maps to sync/watch actions.
  - memory runtime fail maps to manual investigation.
  - serve process warn maps to restart/manual action.
  - root causes sort before downstream symptoms.
  - known check-name remediation mappings fail on drift.
- `test/doctor-agent-explain.test.ts`
  - `doctor --agent --explain --json` includes both `agent_explain` and
    `remediation_plan`.
- `test/setup-agent-trust-ux.test.ts`
  - preview remains no-side-effect and redacted.

Required verification for the implementation PR:

```bash
bun test test/doctor.test.ts test/doctor-agent-explain.test.ts test/installed-agent-readiness-service.test.ts test/setup-agent-trust-ux.test.ts test/setup-agent.test.ts test/proof-agent-command.test.ts test/cli.test.ts
```

## Workstream C: Operation Golden Manifest, Retrieval Gates, And Scorecard

Priority: P0/P1

### Decision

Adopt GBrain's contract/gate discipline, but implement it over MBrain's existing
operation registry and retrieval replay substrate. Do not add a new broad
`memory_action`, `brainbench`, or generic memory API.

### Requirements

1. Add a checked-in operation golden manifest generated from `operations`.
   - Sort by operation name.
   - Store enough metadata to catch contract drift.
   - The manifest belongs under `test/fixtures` or a similarly test-owned path.

2. Manifest entries must include:
   - `name`
   - `description`
   - `mutating`
   - `capabilityRequired`
   - normalized params: required, type, enum, default, nullable
   - CLI exposure mode
   - MCP read-only/destructive annotations
   - compact schema hash
   - full schema hash
   - capability visibility
   - memory-verb metadata
   - mutation alias metadata where typed mutation names differ from public
     operation names

3. Add an explicit CLI exposure input model.
   - `operations` remains the source for shared MCP/CLI operation behavior.
   - `CLI_ONLY_SPECS`, `DIRECT_ENGINE_COMMANDS`, `DIRECT_NO_ENGINE_COMMANDS`,
     `CLI_NO_ENGINE_COMMANDS`, and `CLI_ONLY` in `src/cli.ts` are separate
     inputs to the manifest generator.
   - The manifest must classify each command as:
     - `mcp`
     - `cli_shared`
     - `cli_direct_engine`
     - `cli_direct_no_engine`
     - `cli_only`
     - `not_cli`
   - CLI-only drift is a failure only when a command enters or leaves an
     explicit exception set without updating the manifest and rationale.

4. Add a CI-facing conformance scorecard.
   - Output deterministic JSON plus a human summary.
   - Use numerator/denominator per dimension.
   - Include hard failures separately from scores.
   - Avoid a single opaque score as the only signal.

5. Add a source-aware retrieval-quality gate.
   - Use small, deterministic qrels fixtures.
   - Measure at least `top1_match_rate` and `recall@10`.
   - Report per-query failures, not just aggregate score.
   - Keep it no-network and CI-friendly.
   - Gate retrieval metadata, rerank, and autocut changes on this suite.
   - Treat skipped env-gated coverage as skipped, not passed.

6. Scorecard dimensions:
   - `operation_catalog_integrity`
   - `mcp_cli_compatibility`
   - `capability_filtering`
   - `retrieval_quality`
   - `memory_authority`
   - `writeback_governance`
   - `mutation_control_plane`
   - `replay_evaluation`

7. Hard gates must fail CI for:
   - Duplicate operation names.
   - Missing required params in MCP schemas.
   - Mutating/destructive classification drift.
   - CLI/MCP drift outside explicit exceptions.
   - Memory-verb mappings to nonexistent operations.
   - Agent-mediated writeback paths that bypass
     `route_memory_writeback`/snapshot/provenance guards.
   - Page-backed `put_page` paths that bypass source attribution or expected
     content hash checks.
   - Profile-memory or personal-episode canonical writes that bypass their
     required provenance fields.
   - Public operation names drifting away from mutation ledger names without an
     explicit alias entry.
   - Retrieval quality falling below qrels thresholds.

### Memory-Verb Matrix

The matrix maps common memory verbs to existing operations. It is not a new API.

| Verb family | Existing operations |
| --- | --- |
| Discover/search | `search`, `query`, `retrieve_context`, `plan_retrieval_request`, `select_retrieval_route` |
| Read/evidence | `read_context`, `get_page`, `list_pages`, `get_memory_candidate_entry`, `list_memory_candidate_entries`, `read_candidate_context` |
| Plan/activate | `classify_memory_scenario`, `select_activation_policy`, `plan_scenario_memory_request`, `plan_agent_session_activation`, `preview_agent_session_memory` |
| Route writeback | `route_memory_writeback` |
| Canonical page write | `put_page`; direct calls must include source attribution and expected hash, while agent-mediated writeback must first pass `route_memory_writeback` |
| Canonical non-page personal store | `upsert_profile_memory_entry`, `record_personal_episode`; each uses its own provenance requirement instead of page snapshots |
| Candidate lifecycle | `create_memory_candidate_entry`, `advance_memory_candidate_status`, `verify_memory_candidate_entry`, `reject_memory_candidate_entry`, `preflight_promote_memory_candidate`, `promote_memory_candidate_entry`, `supersede_memory_candidate_entry`, `resolve_memory_candidate_contradiction` |
| Patch/governed mutation | `create_memory_patch_candidate`, `review_memory_patch_candidate`, `dry_run_memory_mutation`, `apply_memory_patch_candidate` |
| Profile/episode | `write_profile_memory_entry`, `upsert_profile_memory_entry`, `delete_profile_memory_entry`, `record_personal_episode`, `write_personal_episode_entry`, `delete_personal_episode_entry` |
| Realm/session/ledger | `upsert_memory_realm`, `create_memory_session`, `attach_memory_realm_to_session`, `close_memory_session`, `list_memory_mutation_events`, `record_memory_mutation_event` |
| Redaction/forget | `create_memory_redaction_plan`, `approve_memory_redaction_plan`, `reject_memory_redaction_plan`, `apply_memory_redaction_plan`, lifecycle purge/restore operations |
| Maintenance/health | `run_dream_cycle_maintenance`, `get_memory_operations_health`, `rerun_memory_job` |

### Acceptance Tests

Add:

- `operation-golden-manifest.test`
- `conformance-scorecard.test`
- `retrieval-quality-qrels-gate.test`
- `memory-verb-matrix.test`
- `mcp-cli-operation-compatibility.test`
- `writeback-router-golden.test`
- `memory-mutation-name-alignment.test`

Optional Postgres compatibility tests may be env-gated. A skipped env-gated test
must be reported as skipped coverage, not as passing coverage.

## Workstream D: Retrieval Evidence And Governance Metadata

Priority: P1

### Decision

Adapt GBrain's richer retrieval metadata and `create_safety` idea, but do not
change MBrain's authority rules.

Metadata improves explainability, ranking experiments, and regression tests. It
must not make `retrieve_context`, candidate signals, graph frontier output, code
lane output, or push-context pointers answer evidence.

This workstream should avoid schema churn for fields MBrain already carries.
The implementation should first inventory existing selector/read/candidate
fields, then add only missing metadata needed for evaluation, duplicate
prevention, and governance explainability.

### Requirements

1. Add retrieval evidence metadata without changing selector IDs:
   - `evidence_role`
   - `authority`
   - `activation`
   - `freshness`
   - `content_hash`
   - `source_ref_count`
   - `source_ref_kinds`
   - `corpus_lane`
   - `scope_gate`
   - `rank_reason`
   - `backend_gap`
   - `graph_frontier_authority`
   - `create_safety`

2. Define `create_safety` as advisory duplicate-prevention metadata.
   - Values should be small and explicit, for example:
     - `exists`
     - `probable_duplicate`
     - `unknown`
     - `safe_to_propose`
   - It is advisory only; it must not create pages.
   - It should help agents decide whether to search/read/review duplicates
     before proposing new memory.
   - It must connect to existing duplicate review behavior instead of replacing
     governed writeback.

3. Add read evidence metadata to canonical reads:
   - selector ID
   - authority
   - content hash
   - source refs/count
   - token/window bounds
   - continuation status
   - stale-selector result
   - derived-index status
   - corpus lane
   - conflict/readiness contribution

4. Add candidate signal metadata:
   - status
   - verification status
   - target-binding state
   - proposal state
   - promotion/handoff state
   - suppression reason
   - pressure reasons
   - explicit `why_not_answer_ground`

5. Add writeback governance metadata:
   - route decision
   - missing requirements
   - canonical blockers
   - provenance/source-ref counts
   - target snapshot presence/hash
   - sensitivity decision
   - candidate-only reason
   - whether a control-plane apply is required

6. Add auto-promote audit metadata:
   - runner kind
   - prompt version
   - prompt input hash
   - threshold
   - policy version
   - verification method/status
   - target snapshot hash
   - low-risk/risky/excluded reason
   - gate skip reason
   - preflight result
   - patch candidate ID
   - whether canonical page writes were enabled

### Hard Constraints

- `read_context` remains mandatory for factual answers.
- Candidate signals are never answer ground.
- Corpus lane is metadata, not authority, scope, storage root, or selector
  identity.
- Code lane is orientation only, not current code truth.
- Graph frontier output is orientation only.
- Page-backed canonical writes through `put_page` require source attribution and
  expected content hash protection.
- Agent-mediated page writeback requires `route_memory_writeback` and the
  router's expected hash requirements.
- Canonical non-page personal stores such as profile memory and personal
  episodes require their own provenance fields and must stay covered by the
  conformance gates.
- No hidden channel may inject raw unscoped personal memory into prompts.

### Acceptance Tests

Add:

- Serialization tests for retrieve/read/writeback/candidate/auto-promote
  metadata.
- Regression tests that selector IDs do not change when metadata is added.
- Regression tests for `create_safety` on exact match, probable duplicate, and
  unknown search results.
- Regression tests that candidate signals still require verification/preflight.
- Regression tests that `auto-promote --apply` requires explicit canonical-write
  policy and records whether canonical page writes were enabled.
- Scenario extensions for S27-S31 covering metadata fields.

## Workstream E: Selector-First Push Context

Priority: P2

### Decision

Adapt only the pointer-first idea. Do not adopt raw push context.

MBrain can later add a small push-context envelope if it helps agents avoid
repeated discovery work. The envelope must be a bounded selector/trace object,
not injected memory content.

### Envelope Requirements

Allowed fields:

- trace IDs
- selector IDs
- content hashes
- scope gate result
- answer readiness
- source ref count
- TTL/expiry
- confidence
- `not_answer_ground_until_read_context: true`

Disallowed fields:

- raw retrieved page text
- raw personal memory text
- candidate content as answer ground
- unscoped source excerpts
- any field that bypasses `read_context`

### Acceptance Tests

Before enabling this surface:

- Expired envelope is rejected.
- Cross-scope personal text is not carried.
- Candidate-only pointer cannot be used as evidence.
- Selector pointer requires `read_context`.
- Raw text fields are rejected by schema.

## Workstream F: Deferred Or Rejected Ideas

### Full GBrain Minions/Supervisor

Result: defer direct port.

GBrain has strong job-runtime ideas: protected job names, idempotency,
backpressure, parent/child fanout, `FOR UPDATE SKIP LOCKED`, timeout rescue,
lock renewal, RSS watchdogs, and crash recovery tests.

MBrain already has maintenance-runtime primitives:

- enqueue
- idempotency coalescing
- claim/lease
- stale lock reclaim
- retries/dead state
- cycle locks
- heartbeat
- Postgres `FOR UPDATE SKIP LOCKED`

Adopt GBrain-style resilience tests and specific missing primitives only after a
concrete MBrain job needs them. The bounded embedding CLI should come first.

### Hot Memory / Takes Vs Facts

Result: reject as authority model, adapt vocabulary only if useful.

The vocabulary distinction between private facts and attributed takes is useful,
but GBrain's DB-only fallback writes/forgets are weaker than MBrain's governed
candidate/assertion pipeline.

MBrain must keep:

- Memory Inbox for noncanonical signals.
- `route_memory_writeback` for agent-mediated durable writeback.
- `read_context` as factual evidence boundary.
- page-backed canonical writes protected by source attribution and expected hash.
- non-page personal stores protected by their own provenance requirements.

### Doctor Auto-Heal

Result: reject for now.

Doctor can emit structured plans. It cannot auto-apply:

- external config edits,
- MCP registration changes,
- schema migrations,
- canonical memory writes,
- RLS changes,
- purge or redaction actions.

### Cross-Encoder Rerank / Autocut

Result: defer behind eval gates.

These may improve retrieval quality, but they should follow Workstream C/D so
MBrain has a source-aware quality gate and metadata to measure regressions.

### Skillpack Ecosystem

Result: defer as a separate product spec.

GBrain's skillpack manifest validation, trust prompt, no-overwrite scaffolding,
state tracking, and quick doctor are useful. They do not belong in this core
memory/runtime adoption spec.

## Implementation Sequence

### Phase 0: Freeze This Spec

Exit criteria:

- Spec committed in a separate worktree.
- Baseline tests pass.
- Subagent review findings are incorporated.

### Phase 1: Bounded Embedding Backfill

Implement Workstream A first.

Exit criteria:

- `embed --stale` no longer loads and queues the entire corpus before writing.
- Large corpus tests prove bounded memory behavior.
- Existing stale embedding semantics stay green.
- Manual progress output is useful for long runs.

### Phase 2: Doctor Remediation Plan

Implement Workstream B.

Exit criteria:

- `mbrain doctor --json` includes additive `remediation_plan`.
- Remediation actions include deterministic cause ranking and explicit
  downstream symptom links where known.
- Existing doctor JSON consumers remain compatible.
- No automatic repair exists.
- Redaction/no-side-effect tests pass.

### Phase 3: Operation Manifest And Scorecard

Implement Workstream C.

Exit criteria:

- Operation golden manifest is checked in.
- CI fails on contract drift.
- Source-aware retrieval qrels gate exists and reports per-query failures.
- Memory-verb matrix maps only to existing operations.
- Writeback governance hard gates exist.

### Phase 4: Evidence Metadata

Implement Workstream D.

Exit criteria:

- Retrieval/read/writeback/candidate/auto-promote metadata is serialized.
- `create_safety` exists for search/retrieval duplicate-prevention advice.
- Selector IDs and evidence boundary do not change.
- S27-S31 scenario assertions cover metadata.

### Phase 5: Optional Context And Runtime Experiments

Only after P0/P1 work is stable:

- Selector-first push context.
- Durable embedding job integration.
- GBrain-style job resilience tests.
- Rerank/autocut experiments.

## Review Requirements For Future PRs

Every implementation PR from this spec must include:

- A code-first design note that names the MBrain files changed.
- At least one focused subagent review for the touched subsystem.
- A regression test proving the relevant no-go boundary still holds.
- Concrete verification commands in the PR description.
- No direct port of GBrain behavior unless the PR explains why MBrain's current
  approach is objectively weaker for that slice.

## Spec Verification

Baseline verification run before writing this spec:

```bash
bun install --frozen-lockfile
bun test test/operation-param-validation.test.ts test/retrieve-context-service.test.ts test/read-context-service.test.ts test/memory-writeback-router-service.test.ts test/doctor.test.ts
```

Expected result at the MBrain baseline:

- 163 tests passed.
- 0 tests failed.

Additional subagent verification:

- Embedding slice:
  - `bun test test/embedding-queue.test.ts test/chunk-embedding-freshness.test.ts test/derived-worker.test.ts`
  - `bun test test/local-offline.test.ts --test-name-pattern "stale-only embedding"`
- Doctor slice:
  - `bun test test/doctor.test.ts test/doctor-agent-explain.test.ts test/installed-agent-readiness-service.test.ts test/setup-agent-trust-ux.test.ts test/setup-agent.test.ts test/proof-agent-command.test.ts test/cli.test.ts`
- Governance slice:
  - `git diff --exit-code -- src test`

## Final Judgment

The highest-value GBrain idea is not a new memory model. It is operational
discipline around large backfills, remediation plans, and conformance gates.

MBrain should adopt the better GBrain ideas where they fix concrete MBrain
weaknesses:

1. Replace the unbounded `embed --stale` implementation with bounded windowed
   backfill.
2. Add structured doctor remediation output.
3. Add cause-ranked remediation ordering without auto-heal.
4. Add operation golden manifests, source-aware qrels, and scorecard gates.
5. Add evidence metadata and `create_safety` while preserving the read boundary.

MBrain should reject or defer GBrain ideas that weaken its stronger governance:

1. No candidate/hot-memory answer authority.
2. No raw push context.
3. No doctor auto-heal for canonical memory or external config.
4. No full Minions port without a concrete MBrain runtime need.
5. No new broad memory API over the existing operation registry.
