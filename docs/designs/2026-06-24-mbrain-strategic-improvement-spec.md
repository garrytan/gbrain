# MBrain Strategic Improvement Spec

Date: 2026-06-24
Status: Draft under post-analysis review
Author: scott.lee + Codex
Base commit: `146bc60d`
Worktree/branch: `.worktrees/strategic-improvement-spec-20260624` / `codex/mbrain-strategic-improvement-spec-20260624`
Document path: `docs/designs/2026-06-24-mbrain-strategic-improvement-spec.md`

## Source

This spec synthesizes a multi-agent read-only review of current `origin/master`
after the 2026-06-22 post-review implementation was merged. The review split the
system across eight independent lenses:

- product purpose, docs, onboarding, and operator mental model
- retrieval and evidence-boundary quality
- writeback governance and canonical page lifecycle
- security, raw-source access, OAuth, and remote MCP surface
- Postgres runtime, engine parity, migrations, and concurrency
- agent-session memory, dream cycle, autopilot, and context compounding
- verification, CI, benchmark, release, and spec hygiene
- architecture, maintainability, operation registry, and surface consistency

The earlier 2026-06-22 review closed a real set of issues. This document does
not re-open closed items such as unaudited `list_source_items` raw text leakage,
doctor offline-profile severity, assertion apply-path limbo, compact tool
annotation loss, or the initial governed-probe hybrid harness. Those are treated
as the new baseline. The remaining work is the next layer: make MBrain safe
enough to expose remotely, measurable enough to evolve, and quiet enough that a
single owner can use it every day without carrying the whole protocol in their
head.

This document is a strategic backlog and sequencing map, not a single
implementation PR. Each numbered item must be split into a PR-sized
implementation spec with explicit touched surfaces, tests, rollback or migration
notes, and CI gate before work starts.

## Purpose

MBrain is not just a search index or a note repository. It is the user's durable
memory runtime:

- Human-editable Markdown remains canonical.
- Postgres + pgvector is the target runtime for concurrency, auditing, derived
  storage, and MCP/CLI access.
- `retrieve_context -> read_context` is the evidence boundary for answering.
- Writes route through governed memory surfaces unless an explicit local repair
  escape is being used.
- Raw sources, secrets, and personal scope must never become casual canonical
  memory.
- The daily report and Memory Inbox are the owner's review surface.

The strategic goal is therefore:

> A rule-following agent should get the best answer path, the safest write path,
> and a clear next action without needing private knowledge of MBrain internals.

## Current Baseline

Recent `master` already includes important hardening:

- Governed retrieval can use hybrid candidate search behind
  `retrieval_governed_probe_hybrid`, with a recall harness and no-provider parity
  guard (`src/core/search/governed-probe.ts`, `test/retrieval-recall-harness.test.ts`).
- Raw source inspection drops both raw and redacted body text; redacted bodies
  are available only through the audited `request_raw_source_chunks` path
  (`src/core/source-registry/raw-ingest-store.ts:163`).
- `admin_put_page` is excluded from the Supabase remote surface
  (`supabase/functions/mbrain-mcp/index.ts:31`).
- MCP compact schemas keep safety annotations.
- Promotion of a Memory Inbox candidate now explicitly returns
  `canonical_write_pending`.
- The dormant assertion apply path was retired by ADR.
- CI now includes typecheck, sharded Linux unit tests, macOS unit tests, a
  Postgres target-runtime job, E2E tiers, release smoke, and workflow config
  tests.

The remaining gaps are mostly contract gaps: safety checks exist on one surface
but not another, quality metrics exist but do not yet gate defaults, and docs
still describe older protocols.

## Non-Goals

- No rewrite-first architecture project.
- No auto-promotion of inferred facts into canonical pages.
- No weakening of personal/work scope isolation.
- No hard dependency on an embedding provider for offline or SQLite/PGLite use.
- No new agent-facing protocol that bypasses `retrieve_context -> read_context`
  or `route_memory_writeback`.
- No large engine split before a conformance harness protects the behavior.

## Priority Map

P0 work protects authority boundaries and prevents silent unsafe writes.

- A. Transport-independent authority and surface hardening.
- B. Canonical write lifecycle closure.

P1 work makes the product meaningfully better at remembering and operating.

- C. Retrieval and evidence quality promotion.
- D. Runtime parity and managed Postgres confidence.
- E. Agent compounding loop and maintenance loop.
- F. Strategic verification contract.

P2 work reduces long-term confusion and maintenance drag.

- G. Agent-facing documentation and CLI contract alignment.
- H. Architecture modularity and ownership seams.

---

## A. Authority And Surface Hardening (P0)

### A1. Move `put_page` route-first enforcement into the operation contract

Problem: the MCP server rejects only `put_page` calls that have neither
`expected_content_hash` nor `memory_session_id`. That guard lives in the MCP
transport (`src/mcp/server.ts:268`), and it lets a generic memory control-plane
session stand in for a routed page-write grant. Raw operation dispatch can still
reach the handler, and the handler treats missing `expected_content_hash` as
`null` (`src/core/operations.ts:3078`). That means the strongest canonical-write
contract is not actually owned by the canonical-write operation.

Design:

- Add a shared `assertPutPageAuthority` in the core operation layer.
- Require one of:
  - explicit `expected_content_hash` field, including `null` to assert absence
  - valid `write_session_id` or write grant introduced by B1
  - explicit `admin_put_page` repair path
- Until B1 lands, public `put_page` may be authorized only by explicit
  `expected_content_hash`; `memory_session_id` is not described as a
  `route_memory_writeback` session. It belongs to the separate memory
  control-plane session model.
- A generic `memory_session_id` is not sufficient authority to bypass
  `expected_content_hash`. Public `put_page` may omit `expected_content_hash`
  only with a `write_session_id` or write grant minted by
  `route_memory_writeback` and bound to target slug, expected hash/null,
  `source_refs`, scope, actor, and expiry.
- Keep MCP/remote guards as early UX, but make them redundant, not authoritative.
- Ensure `mbrain call put_page ...` follows the same rule as MCP.
- Keep local import/sync flows on their existing internal primitives or
  `admin_put_page`, not public `put_page`.

Acceptance:

- `handleToolCall(engine, "put_page", { slug, content })` fails with
  `route_first`.
- Direct public `put_page.handler` without `expected_content_hash` or valid
  `write_session_id` fails with `route_first`.
- `mbrain call put_page` without `expected_content_hash` and without a routed
  `write_session_id` fails with `route_first`.
- MCP `put_page` and Supabase remote `put_page` fail with the same semantic
  error.
- `admin_put_page` remains the only blind local repair escape and is not exposed
  remotely.
- A bare `memory_session_id` without a routed `write_session_id` cannot create a
  missing page through public `put_page`.
- `put_page` with an ordinary read-write `memory_session_id`, `realm_id`, and no
  `expected_content_hash` fails with `route_first`.
- A `write_session_id` succeeds only for the exact target/source/scope it was
  minted for; mismatch, expiry, or reuse fails closed.
- Existing CAS tests still pass; new operation-level tests prove transport
  bypass is impossible.

### A2. Unify MCP surface profiles and enforce them at dispatch

Problem: current MCP tiering narrows the listed catalog, but dispatch by name
uses the full operation map (`src/mcp/server.ts:129`, `src/mcp/server.ts:879`).
Built-in HTTP also opts into `toolTier: 'all'` (`src/mcp/http-server.ts:135`),
while the Supabase edge bundle filters separately. This is a visibility model,
not a capability model.

Design:

- Define one `SurfaceProfile` contract for `stdio`, `http_local`, `http_remote`,
  and `edge_remote`.
- Each profile declares:
  - visible tiers
  - callable tiers
  - forbidden operation names
  - allowed raw-source capability
  - allowed canonical-write capability
  - timeout class
  - CORS, body-size, and request-log policy
- Enforce callable tiers and forbidden operations inside `CallTool`, not only in
  `ListTools`.
- `CallTool` authorization is the intersection of surface profile and
  authenticated token capabilities; list visibility is never the authority
  boundary.
- Add a test matrix that snapshots visible and callable operations for each
  surface.
- Extend the operation golden manifest to v2 with effective tier, visible
  profiles, callable profiles, forbidden profiles, and remote exposure.
- Make new mutating operations fail tests unless their tier/profile exposure is
  explicitly classified.

Acceptance:

- An admin-tier tool hidden from a profile cannot be called by name on that
  profile.
- An OAuth token without `raw_source` or `canonical_write` capability cannot call
  `request_raw_source_chunks` or `put_page` even if the surface profile exposes
  them.
- Denials are logged with token/client identity and return `permission_denied`
  before handler execution.
- Built-in HTTP default no longer exposes `all` capabilities by default.
- Edge and built-in HTTP share the same profile vocabulary.
- Discovery may reveal metadata for hidden tools, but `CallTool` still fails
  unless the active profile and token capabilities allow the operation.
- The operation golden manifest records tier and profile exposure.
- Any new mutating operation without profile classification fails tests.

### A3. Propagate authenticated principal into operation context

Problem: HTTP authentication produces a `tokenName`, and OAuth access tokens
carry client and scope, but operation handlers mostly see caller-supplied fields.
For example `evaluate_raw_access` and `request_raw_source_chunks` require
`actor_type` and `actor_id` from request parameters
(`src/core/operations-source-registry.ts:537`, `src/core/operations-source-registry.ts:559`).
That allows a valid remote client to write an audit ledger entry under a
different claimed actor unless every caller behaves.

Design:

- Add `auth_principal` to `OperationContext`.
- Include principal type, token/client id, token name, OAuth client name, scopes,
  surface profile, and remote/local marker.
- For raw-source operations, ledger actor defaults to the authenticated
  principal.
- If a caller supplies `actor_type`/`actor_id`, require it to match the principal
  or reject the request. Delegated-actor grants are deferred behind a separate
  ADR and test matrix.
- Include `auth_principal` in request logs and raw access ledgers.

Acceptance:

- Remote raw-source access records the authenticated principal even if the caller
  omits actor fields.
- Remote `request_raw_source_chunks` accepts omitted actor fields and records
  `auth_principal` as actor.
- A caller cannot claim `actor_id: owner` from a different OAuth client.
- If caller-supplied actor fields do not match the authenticated principal or an
  explicit delegation grant, the call returns `permission_denied`, returns no
  chunks, and audits the claimed actor only as metadata.
- Local CLI can still pass explicit actor fields, but the audit record marks the
  surface as local.

### A4. Make OAuth refresh tokens one-time or explicitly replay-tolerant

Problem: OAuth access-token rotation exists, but refresh tokens are stateless
signed blobs and the implementation can permit replay unless server-side
rotation state is added. That may be acceptable for a simple local connector, but
it should be an explicit threat-model decision rather than an accidental
property.

Design:

- Prefer one-time refresh-token rotation for HTTP OAuth.
- Store refresh token identifiers server-side, or store a revocation sequence
  keyed by token binding.
- If replay tolerance is intentionally retained, document why and limit it by
  short TTL, client binding, and anomaly logging.

Acceptance:

- Either the same refresh token cannot be used twice, or the replay-tolerant
  behavior is documented in an ADR with tests that show the exact blast radius.
- Stolen old access tokens remain rejected after refresh.
- Refresh-token signing continues to require the dedicated signing secret.

### A5. Assert personal scope in every personal write path

Problem: legacy personal write operations already assert personal scope. The
remaining gap is that `write_profile_memory_entry` and
`write_personal_episode_entry` perform personal preflight, then persist an
explicit caller-supplied `scope_id` without reasserting that it is `personal:*`.
Safe-looking operations should not become a scope override escape.

Design:

- Introduce a shared personal write target resolver for profile memory, personal
  episodes, and future personal-memory writes.
- Reject explicit `work:*` or unknown scope overrides before persistence.
- Record scope-gate decision in the mutation/audit output.

Acceptance:

- `scope_id: "work:*"` is rejected for every profile/episode write path.
- `write_profile_memory_entry` and `write_personal_episode_entry` reject
  explicit `scope_id: "work:default"` after an otherwise-allowed personal
  preflight.
- `scope_id: "workspace:default"`, `scope_id: "work:default"`, or any
  non-`personal:*` value is rejected for both operations in dry-run and apply
  paths.
- Rejected writes persist zero rows.
- Tests cover both legacy and safe operation names.

---

## B. Canonical Write Lifecycle Closure (P0)

### B1. Add write sessions returned by `route_memory_writeback`

Problem: the router returns intended operation and expected hash requirements,
but the public contract still relies on the caller carrying those requirements
into `put_page`. There is no durable route id that `put_page` can consume and
close.

Design:

- `route_memory_writeback` returns a `write_session_id` for canonical-write
  allowed routes.
- The write session records target slug, expected hash, source refs, route
  decision, actor, scope, and expiry.
- `put_page` can consume `write_session_id` instead of separately supplied
  expected hash, but must verify slug, source refs, scope, and expiry.
- Consuming a write session marks it applied, superseded, expired, or abandoned.

Acceptance:

- A write session for `brain/concepts/x.md` cannot write `brain/ideas/x.md`.
- A stale or already consumed session fails closed.
- The daily memory report can show open write sessions and expired write
  sessions.
- `put_page` ledger includes route decision id and write session id.

### B2. Separate public write, admin repair, import, and patch-apply primitives

Problem: canonical markdown can be written by public `put_page`, admin repair,
file import, sync, and patch candidate apply. Some paths share behavior, some do
not. The more write surfaces MBrain has, the more important it is to make the
canonical write primitive explicit.

Design:

- Create a core `CanonicalPageWriteService` with named modes:
  - `public_governed_write`
  - `admin_repair_write`
  - `import_reconcile_write`
  - `patch_candidate_apply`
  - `sync_markdown_write`
- Each mode declares required preconditions, provenance rules, ledger behavior,
  derived-refresh behavior, and allowed call sites.
- Route patch candidate apply through the same final write primitive so markdown
  serialization, conflict checks, derived scheduling, and ledger events cannot
  drift.

Execution slices:

- B2a: inventory write modes and add table-driven precondition tests.
- B2b: delegate public `put_page` through the service without behavior changes.
- B2c: move patch candidate apply through the service.
- B2d: evaluate import/sync modes after the first three slices are stable.

Acceptance:

- The first B2 PR changes no serialized page output, ledger shape, content hash
  behavior, or derived refresh behavior.
- One table-driven test proves every canonical write mode's preconditions.
- Patch candidate apply emits the same canonical-page write ledger class as
  `put_page`, with mode metadata.
- Public write modes cannot bypass provenance or CAS by using lower-level import
  helpers.

### B3. Track candidate canonicalization status explicitly

Problem: promoting a Memory Inbox candidate flips review status but does not
create retrievable markdown. Returning `canonical_write_pending` is a good UI
hint, but the lifecycle is still not first-class.

Design:

- Add candidate-level `canonicalization_status`:
  - `not_applicable`
  - `needs_target`
  - `target_proposed`
  - `patch_created`
  - `write_pending`
  - `canonicalized`
  - `rejected`
  - `superseded`
- Link candidates to target proposals, patch candidates, write sessions, and
  resulting page content hash.
- The daily report should group "reviewed but not retrievable" items by blocker.

Acceptance:

- A promoted candidate without a page appears in daily report as canonicalization
  debt.
- Applying a patch candidate or routed `put_page` moves status to
  `canonicalized`.
- Supersession closes the debt without pretending the older candidate became a
  page.

### B4. Make verification and promotion events append-only

Problem: candidate verification status can change without a matching append-only
event that explains who verified what, against which source, and whether the
result blocked or enabled canonicalization.

Design:

- Add append-only events for verification, promotion, supersession, binding, and
  patch-apply transitions.
- Keep current row status for quick querying, but treat the event log as the
  audit authority.

Acceptance:

- Every verification status mutation has a corresponding event row.
- Daily report can reconstruct the latest status from events.
- Tests reject status changes that do not append an event.

---

## C. Retrieval And Evidence Quality (P1)

### C1. Graduate governed hybrid retrieval to default-on through a gate

Problem: hybrid governed retrieval exists, but the default remains off
(`src/core/config.ts:129`). The recall harness proves the feature can recover
paraphrase matches, yet the normal user path still uses the weaker baseline.

Design:

- Define a "hybrid default-on" promotion gate:
  - recall@10 = 1.0 on labeled harness
  - top1 >= 0.75
  - no-provider parity preserved
  - p95 latency within budget
  - no regression on graph-frontier and qrels fixtures
- Thread the same resolved embedding provider/config through provider
  availability checks, query embedding, diagnostics, and tests.
- Run the gate in CI or as a release artifact before flipping the default.
- When the flag is off or no provider is available, surface a
  `retrieval_backend_capability` warning in `retrieve_context`.

Acceptance:

- Default-on PR includes before/after recall artifact.
- No-provider parity means candidate slugs, selector ids, and `read_plan`
  ordering remain identical to keyword-only; only retrieval backend diagnostics
  may differ.
- `retrieve_context` output tells the agent whether hybrid was active,
  unavailable, or explicitly disabled.

### C2. Prefer current compiled truth over timeline hits unless intent says otherwise

Problem: when compiled truth and timeline hits exist on the same page,
`resolveCandidateGroup` can choose the best timeline search result before the
top current result (`src/core/services/retrieve-context-service.ts:896`). That
can over-weight historical evidence when the user asks for current compiled
truth.

Design:

- Add an authority-aware selector portfolio:
  - compiled truth / current section as primary for current-state questions
  - timeline as supporting evidence for source, history, or contradiction intent
  - Memory Inbox candidates as non-canonical signals only
- Expose why each selector was chosen.

Acceptance:

- A mixed compiled/timeline fixture picks compiled truth as primary when asking
  "what is true/current?"
- A historical question can still pick timeline as primary.
- `retrieve_context.read_plan.selector_roles` marks primary answer-ground
  selectors separately from citation-only selectors, and `read_context` preserves
  those roles in returned selector snapshots.

### C3. Improve Korean/CJK and non-ASCII retrieval quality

Problem: section ranking tokenization is ASCII-centered
(`/[a-z0-9]+/g` in `tokenizeForSectionRank`, `src/core/services/retrieve-context-service.ts:1456`).
That weakens Korean/CJK page labels, section titles, and user queries.

Design:

- Use `Intl.Segmenter` when available.
- Add Unicode property regex fallback.
- Add CJK bigram/trigram query variants for labels, slugs, and section titles.
- Extend context-map query ranking with aliases and normalized non-ASCII tokens.

Acceptance:

- Add a Korean/CJK retrieval fixture with Korean title, slug, heading, and
  body-only variants.
- For each Korean/CJK query, `retrieve_context` places the gold selector in
  `required_reads` within top 3 on SQLite and PGLite.
- Mixed Korean/English query variants improve recall without lowering English
  harness scores.
- Tokenizer behavior is deterministic in Bun test runtime.

### C4. Promote context-map and graph-frontier from inert orientation to useful planning

Problem: context map and graph frontier are correctly labeled as orientation
only, but ranking is shallow and production graph frontier wiring can be inert
without persisted seeds.

Design:

- Keep context-map and graph paths non-evidence.
- Add context-map reranking using node score, freshness, canonical follow-through
  availability, source rank, edge type, and centrality.
- Implement a production graph-frontier input builder from persisted assertion
  and context graph data.
- Merge only canonical selectors into `required_reads`; keep graph paths as
  `selector_planning_only`.

Acceptance:

- Graph frontier `false_bridge_rate = 0`.
- `graph_as_answer_evidence_count = 0`.
- Recall with graph frontier enabled is >= recall with it disabled on graph
  evaluation fixtures.
- Scope/stale traversal leaks are zero.
- Production graph frontier emits a clear inactive reason when no seed builder or
  persisted seed data is available.

### C5. Make expansion and auto-read limits observable

Problem: query expansion errors can degrade silently, and `read_context
reads:auto max_selectors:N` can still be limited by `retrieve_context`'s selected
required-read cap.

Design:

- Add `expandQueryWithMeta` returning expanded queries plus provider status.
- Surface `expansion_failed` and reason in retrieval diagnostics.
- Split `candidate_limit` from `required_read_limit`.
- Ensure `read_context reads:auto max_selectors:5` can actually read five
  selectors when five are selected.

Acceptance:

- Provider failure increments retrieval diagnostics instead of disappearing into
  `[query]`.
- `read_context reads:auto max_selectors:5` returns up to five
  `selected_selector_snapshots` when at least five canonical candidates exist.
- `read_plan.max_selectors` equals the caller's `max_selectors` rather than the
  `retrieve_context` default cap.

---

## D. Runtime, Parity, And Managed Postgres Confidence (P1)

### D1. Turn `EngineCapabilities` into an acceptance contract

Problem: `EngineCapabilities` says Postgres is target runtime and SQLite/PGLite
are legacy/local compatibility runtimes (`src/core/engine-capabilities.ts:3`),
but capabilities are not yet a complete test oracle.

Design:

- Classify each operation and storage feature as:
  - required parity
  - documented degraded behavior
  - target-runtime only
  - unsupported and fail-closed
- Store the classification in a machine-readable contract.
- Generate docs and tests from that contract.
- Harnesses only compare behavior for operations marked required parity;
  target-only operations assert fail-closed behavior on SQLite/PGLite.

Acceptance:

- Every operation has a runtime support classification.
- Unsupported target-only surfaces fail with a capability error rather than
  silently succeeding.
- Docs generated from the contract replace hand-maintained runtime claims.

### D2. Add a cross-engine conformance harness

Problem: parity tests exist but are partial. A broad engine interface plus three
runtimes requires a deterministic fixture that catches drift only where the
runtime support matrix says parity is required.

Design:

- Run the same fixture against SQLite, PGLite, and Postgres for operations marked
  required parity:
  - page create/update/delete
  - tags/links/timeline
  - JSON fields
  - raw source metadata
  - derived jobs
  - search result set membership
  - slug rename/update
  - governed write preconditions
- Permit rank differences only where explicitly documented by the runtime
  support matrix.
- Make Postgres lane a required CI job when a schema/storage/governance file
  changes.

Acceptance:

- Required-parity operation result sets match across engines.
- Ranking-tolerant tests assert membership and diagnostic shape.
- Target-only operations assert capability errors or documented degraded results
  on SQLite/PGLite.
- Postgres tests do not silently skip in PRs that touch storage or governance.

### D3. Raise migration checks from case coverage to schema semantics

Problem: migration tests catch some version coverage and column parity, but they
do not yet enforce index, foreign key, check, trigger, RLS, and semantic drift.

Design:

- Snapshot/introspect table, column, type, index, FK, check, trigger, and RLS
  policy metadata.
- Replay selected historical versions (`v1`, `v12`, `v21`, `v50`, latest - 1)
  to latest.
- Verify second migration run applies zero changes.

Acceptance:

- Fresh DB and replayed old DB both reach `LATEST_VERSION`.
- Second migration run applies 0 changes.
- JSON scalar-string regression remains 0.
- RLS coverage is classified for every durable table.

### D4. Add live Postgres concurrency stress gates

Problem: Postgres advertises parallel workers, but the strongest concurrency
proof is still thinner than the product claim. Derived job code mixes
`SKIP LOCKED` and explicit locks, so throughput and lock-wait behavior should be
measured.

Design:

- Live DB stress tests for:
  - 100+ derived jobs x 8/16 workers
  - lease expiry and reclaim
  - same-slug optimistic update conflict
  - parallel import idempotency
  - lock-wait p95
- Emit JSON artifacts for CI/nightly comparison.

Acceptance:

- Exactly-once claim for derived jobs.
- Duplicate active derived rows = 0.
- Expired lease reclaim = 100%.
- Concurrent same-slug writes produce one success, one precondition failure, and
  zero lost updates.

### D5. Define managed Postgres/RLS policy per durable table

Problem: managed Postgres and Supabase-adjacent operation need an explicit table
policy. Some schema messaging implies broad RLS while actual coverage appears
partial.

Design:

- For every durable table, classify as:
  - `rls_required`
  - `service_only`
  - `explicitly_exempt`
- Add schema tests that enforce the classification.
- Add docs explaining how local Postgres, managed Postgres, and Supabase edge use
  the policy.

Acceptance:

- Every durable table has one policy classification.
- Schema introspection enumerates every non-temporary durable table and requires
  exactly one classification.
- The test fails if schema docs or notices claim all-table RLS while any durable
  table is unclassified, not RLS-enabled, and not explicitly `service_only` or
  `explicitly_exempt`.
- Schema tests fail on unclassified new tables.
- Managed runtime docs no longer imply RLS coverage that does not exist.

---

## E. Agent Compounding And Maintenance Loop (P1)

### E1. Persist activation traces and context compounding metrics

Problem: SessionStart activation can inject a bounded card, but MBrain cannot yet
prove whether retrieved context improved follow-up behavior or whether the same
context was repeatedly rediscovered.

Design:

- Persist activation trace payload:
  - query
  - selectors considered
  - selectors injected
  - required reads deferred
  - token budget
  - scope gate
  - follow-up write/candidate outcome
- Add a report-only `context_compounding` section to memory report.

Acceptance:

- Daily report shows repeated retrieval of the same unresolved topic.
- Activation traces do not store raw private conversation bodies.
- Operators can inspect why a card was injected.

### E2. Add merge-first recurrence handling for candidates

Problem: repeated similar signals can pile up as candidate-only debt. Recurrence
scores and merge behavior are not yet strong enough to keep the inbox small.

Design:

- Before creating a new candidate, search unresolved candidates for same target,
  same source family, and similar claim.
- Merge supporting evidence into an existing candidate when safe.
- Raise confidence or recurrence only when sources are independent enough.

Acceptance:

- Repeated same-session signals merge into one candidate.
- Contradictory signals do not merge silently.
- Daily report separates repeated support from new claim.

### E3. Tie dream cycle Phase 14 to canonicalization debt

Problem: Memory Inbox promotion can leave retrievable markdown unwritten, and
autopilot/dream status is split across surfaces.

Design:

- Dream cycle should produce a canonicalization debt summary:
  - promoted but no page
  - target proposed but not approved
  - patch created but not applied
  - write session expired
  - source verification blocked
- Phase 14 should suggest the next operator action, not just count debt.

Acceptance:

- Memory report and dream report agree on debt counts.
- Each debt item has one next action.
- Closed/superseded debt disappears from active report.

### E4. Sweep timed-out jobs at manual dream-cycle entry

Problem: retry/backoff/reporting improved, but manual `mbrain dream` can enter
without the same maintenance sweep guarantees as automated paths.

Design:

- Ensure `runDreamCycle` or its entrypoint runs `sweepTimedOutJobs` before
  acquiring/processing active work.
- Keep the sweep idempotent and bounded.

Acceptance:

- An expired active job fixture is swept before manual dream processing starts.
- Stuck active count is 0 after the sweep.
- Existing autopilot behavior is unchanged except for the healed state.

### E5. Unify autopilot status

Problem: setup, scheduler, memory report, dream cycle, candidate backlog, and
derived maintenance health can each tell a different partial story.

Design:

- Add one `mbrain autopilot status --json` model with:
  - hooks installed
  - MCP registration health
  - SessionStart activation status
  - Stop capture status
  - candidate backlog
  - canonicalization debt
  - derived job backlog
  - raw-source blocked items
  - last successful cycle
  - next recommended action

Acceptance:

- `doctor --agent`, `memory-report`, and `autopilot status` share the same status
  primitives.
- No field reports `unknown` when a deterministic local check exists.

---

## F. Strategic Verification Contract (P1)

### F1. Verify the verification surface itself

Problem: at least one package script references a missing test file, and the
runbook points to that command. This is a trust problem: the verification layer
can rot while CI remains green.

Design:

- Add a script/runbook integrity test:
  - every `package.json` test/bench script references existing files or commands
  - every executable command in `docs/MBRAIN_VERIFY.md` is classified as
    executable, manual, external, or obsolete
  - workflow test names match actual jobs
- Fail on stale executable commands that point to missing files.

Implementation slices:

- F1a: guard repo-local file references and `bun run <script>` references in
  `package.json` and `docs/MBRAIN_VERIFY.md`.
- F1b: add explicit runbook command classification for executable/manual/
  external/obsolete commands.
- F1c: connect workflow-name references to the workflow config tests.

Acceptance:

- `test:authority-foundation` either points to an existing test or is removed.
- Add `test/verification-runbook-integrity.test.ts` to parse `package.json`
  scripts and fail when referenced repo-local test or script files are missing.
- That test must currently catch
  `test:authority-foundation -> test/assertion-lineage-operations.test.ts`
  until the script is corrected.
- A package script that references a missing test file fails the integrity test
  even if the underlying runner would otherwise exit green.
- Runbook commands have an explicit classification.
- CI catches future stale script references.

### F2. Promote retrieval and benchmark results with artifacts

Problem: recall and benchmark tools exist, but some benchmark states can pass as
`pending_baseline`, and acceptance packs can summarize static pass data rather
than live probes.

Design:

- Define PR, nightly, release, and manual gates:
  - PR: deterministic recall, no-provider parity, workflow config, docs
    integrity
  - nightly: live Postgres concurrency, benchmark baselines, graph frontier
  - release: benchmark artifacts with no `pending_baseline` unless waived
  - manual: expensive LLM skill and long-corpus eval
- Save JSON artifacts for retrieval recall, latency, benchmark, and Postgres
  stress gates.
- Artifact schema includes `schema_version`, `git_sha`, `command`,
  `started_at`, `metrics`, `pending_baseline_count`, `waiver_id`, and
  `decision`.
- Gate artifacts also include `gate_name`, `fixture_id`, `engine`,
  `provider_capability`, `thresholds`, `status`, and `waiver_reason`.

Acceptance:

- Release profile fails or requires explicit waiver when
  `pending_baseline > 0`.
- Phase1/Phase8/Phase9 outputs are preserved as artifacts.
- Hybrid default-on uses the same artifact format.

### F3. Make release reproducibility automatic

Problem: release workflow builds and smokes artifacts, but checksum/provenance
and release-asset re-download verification remain partly manual.

Design:

- Generate checksum manifest during tag release.
- Publish manifest with artifacts.
- After publishing, download GitHub release asset and rerun:
  - `--version`
  - installed MCP smoke
  - package/tag/version/plugin manifest lockstep check

Acceptance:

- Release workflow fails if downloaded asset does not match checksum.
- Release workflow fails if binary version, package version, tag, or plugin
  manifest disagree.
- Manual release runbook becomes a confirmation checklist, not the source of
  truth.

### F4. Add spec lifecycle hygiene

Problem: implemented plans can remain with unchecked boxes, while superseded
ideas can look open. This creates roadmap noise and makes agents repeat old work.

Design:

- Every spec/plan gets:
  - `Status`
  - `Implemented in`
  - `Verification`
  - `Deferred`
  - `Superseded by`
- Add a docs test that flags stale open checkboxes in newly modified or newly
  created implemented plans. Do not require the entire historical docs tree to
  pass in the first PR.
- Add a spec integrity test that fails when a prioritized item is absent from,
  duplicated in, or represented only by an unexpanded range in the sequencing
  section.
- For the 2026-06-22 plan, convert unchecked completed items into a status
  ledger rather than pretending they are still pending.

Acceptance:

- Closed specs list commit or PR references and verification commands.
- Open checkboxes correspond to real remaining work.
- Superseded items point to their replacement decision.
- Every P0/P1 item appears exactly once in sequencing unless explicitly
  deferred or demoted by ADR.

### F5. Make Postgres-required tests impossible to skip accidentally

Problem: Postgres coverage is present but split across PR jobs, release jobs, and
runbooks. Storage changes should not rely on humans noticing which DB-backed
tests to run.

Design:

- Add a path-to-gate map:
  - schema/migrate/storage -> Postgres runtime matrix
  - governance/writeback -> Postgres + SQLite CAS suite
  - retrieval/search -> recall + latency gate
  - source/raw -> source registry + raw ledger suite
- Make CI aggregator fail if a required path-specific gate is absent.

Acceptance:

- A migration-only PR cannot pass without the Postgres migration job.
- A raw-source operation change cannot pass without raw ledger tests.
- Skip reasons are explicit artifacts, not silent conditional exits.

---

## G. Documentation And Agent UX (P2)

### G1. Replace stale agent guides with the current evidence contract

Problem: several guides still teach `search/get/query` and direct `put` as the
default loop (`docs/guides/brain-first-lookup.md`, `docs/guides/brain-agent-loop.md`,
`docs/guides/meeting-ingestion.md`). Current rules require
`retrieve_context -> read_context` for evidence and `route_memory_writeback` for
durable writes.

Design:

- Create a small current guide set:
  - First Brain: when to read MBrain and when not to
  - Evidence Contract: `retrieve_context`, `read_context`, selectors, hashes
  - Governed Writeback: route, expected hash, patch candidate, sync
  - Operator Review: Memory Inbox, daily report, canonicalization debt
  - Legacy/Compatibility: SQLite/PGLite and local repair paths
- Mark or remove older protocol docs.
- Keep examples runnable against current CLI/MCP names.

Acceptance:

- No agent-facing guide recommends direct `put` as the default durable write.
- No guide treats `search`/`query` chunks as answer evidence.
- Meeting ingestion docs route through source/candidate/patch flow, not blind
  timeline writes.

### G2. Update CLI help to surface the governed path

Problem: global CLI help highlights `get`, `put`, `search`, and `query`, but not
the governed read/write path (`src/cli.ts:713`).

Design:

- Add a top-level `AGENT MEMORY LOOP` section:
  - `retrieve-context`
  - `read-context`
  - `route-memory-writeback`
  - `memory-report`
- Keep page commands visible, but label `put` as governed/direct canonical write
  with expected hash requirements.

Acceptance:

- `mbrain --help` teaches the same first path as `MBRAIN_AGENT_RULES.md`.
- `put` help mentions `expected_content_hash` and route-first requirements.

### G3. Add generated doc drift checks

Problem: docs still mention obsolete operation counts such as "~30" or "31 ops",
while the current golden manifest has roughly 180 operations.

Design:

- Generate operation count and core surface summaries from the manifest.
- Add docs tests for known high-drift claims:
  - operation count
  - embedding model/dimension
  - engine/runtime status
  - default MCP tool tiers
  - raw-source body access path

Acceptance:

- `CLAUDE.md` and architecture docs no longer claim obsolete operation counts.
- The check covers the current drift where `CLAUDE.md` describes roughly 30
  shared operations while the golden manifest records about 180 operations.
- Future operation-count drift fails a docs test or updates the generated
  snippet.

### G4. Make first-run success visible

Problem: README and docs are comprehensive but dense. A new user needs a short
path from install to "the agent read evidence, wrote a candidate, and I reviewed
it."

Design:

- Add a first-run walkthrough:
  - install/setup
  - `doctor --agent`
  - `retrieve_context` dry evidence probe
  - `route_memory_writeback` dry run
  - Memory Inbox review
  - `memory-report`
- Keep it operational, not marketing.

Acceptance:

- A fresh local install can complete the walkthrough without external services.
- The walkthrough uses current governed read/write APIs only.

---

## H. Architecture And Maintainability (P2)

### H1. Split operation ownership without changing behavior

Problem: `operations.ts` centralizes roughly 180 operation definitions plus
validation, formatting, dispatch, and many handlers. Adding one tool can affect
CLI, MCP, tiers, schema, and tests in one hotspot.

Design:

- Introduce operation modules by domain:
  - pages
  - retrieval
  - writeback/governance
  - source registry
  - personal memory
  - maintenance/dream
  - admin/repair
- Keep one generated/default exported operation list for compatibility.
- Keep the golden manifest as the public surface guard.

Acceptance:

- Operation manifest is byte-for-byte unchanged after the mechanical split.
- Domain modules own their own tier/profile metadata.
- Dispatch and help output remain identical.

### H2. Build store-level conformance before engine refactors

Problem: `sqlite-engine.ts` and `pg-engine-base.ts` are large, but splitting them
without stronger tests risks changing behavior while "cleaning up."

Design:

- Use the existing focused `BrainEngine` interfaces as the initial store
  contracts instead of inventing a new abstraction first.
- Back each store contract with the cross-engine conformance harness.
- Only then split implementations.

Acceptance:

- Store contract tests pass on SQLite, PGLite, and Postgres.
- First implementation split changes file ownership only, not behavior.
- Performance and migration artifacts remain unchanged.

### H3. Defer schema DSL until semantic migration tests exist

Problem: a declarative schema/migration DSL may help, but it should not precede
tests that can prove semantic parity.

Design:

- Complete D3 first.
- Then evaluate whether schema DSL would remove real duplication or just move
  complexity.

Acceptance:

- No schema DSL work starts without semantic migration snapshots in place.
- If adopted, generated SQL must round-trip to current schema snapshots.

---

## Sequencing

### Phase 0: Small contract and UX anchors

1. F1 script/runbook integrity test.
2. G2 CLI help governed-loop alignment.
3. G3 generated doc drift check for operation count.

Exit criteria:

- The verification surface catches missing repo-local files in scripts.
- CLI help teaches the governed read/write path.
- Obvious operation-count drift is pinned by a docs test.

### Phase 1: Authority floor

1. A1 operation-level `put_page` route-first enforcement.
2. A2 surface profiles with dispatch enforcement.
3. A3 authenticated principal in operation context.
4. A4 OAuth refresh-token replay decision and implementation or ADR.
5. A5 personal write scope assertion.

Exit criteria:

- No public or remote path can bypass write preconditions by changing transport.
- Every MCP surface has visible and callable snapshots.
- Raw-source audit actor is bound to the authenticated principal.

### Phase 2: Canonical lifecycle

1. B1 write sessions.
2. B2 common canonical write service.
3. B3 candidate canonicalization status.
4. B4 append-only verification/promotion events.

Exit criteria:

- A routed durable write has a durable lifecycle from route to retrievable page.
- Promoted-but-unwritten candidates are visible debt, not hidden state.

### Phase 3: Retrieval and runtime confidence

1. F2 retrieval/benchmark artifact schema and latency budget.
2. C1 hybrid default-on gate.
3. C2 selector authority portfolio.
4. C3 Unicode/CJK retrieval.
5. C4 context-map and graph-frontier planning.
6. C5 expansion and auto-read observability.
7. D1 runtime capability contract.
8. D2 cross-engine conformance harness.
9. D3 semantic migration checks.
10. D4 live Postgres concurrency gates.
11. D5 managed Postgres/RLS table policy.

Exit criteria:

- Rule-following agents get the highest-recall retrieval path by default.
- Runtime parity and Postgres concurrency claims have live evidence.

### Phase 4: Compounding loop and verification contract

1. E1 activation trace and compounding report.
2. E2 merge-first candidate recurrence.
3. E3 canonicalization debt in dream reports.
4. E4 timed-out job sweep at manual dream-cycle entry.
5. E5 unified autopilot status.
6. F3 release reproducibility.
7. F4 spec lifecycle hygiene.
8. F5 Postgres-required path-to-gate enforcement.

Exit criteria:

- Daily report explains what memory work is compounding and what is stuck.
- Release and benchmark confidence is artifact-backed.

### Phase 5: Docs and maintainability

1. G1 current agent guide set.
2. G4 first-run path.
3. H1 operation ownership split.
4. H2 store-level contracts and engine modularity.
5. H3 schema DSL decision.

Exit criteria:

- Agent-facing docs teach the current protocol.
- Large files can shrink behind behavior-preserving conformance tests.

## Definition Of Done

The improvement program is done when all of these are true:

- `retrieve_context -> read_context` is both the documented and highest-quality
  answer path.
- Public canonical writes require route/session or observed target across CLI,
  MCP, HTTP, and edge surfaces.
- Remote clients can only call operations allowed by their surface profile and
  token capabilities.
- Raw-source audit records use authenticated principals, not caller claims.
- Promoted candidates either become retrievable markdown or remain visible
  canonicalization debt with a next action.
- Postgres target-runtime claims are protected by live conformance,
  concurrency, migration, and RLS tests.
- Release artifacts prove version, checksum, installed MCP smoke, and benchmark
  state.
- Agent-facing docs and CLI help do not teach stale protocols.

## Open Decisions

- A2 blocker: should built-in HTTP default to `core+extended` or a stricter
  `core` profile?
- A4 blocker: should OAuth refresh tokens become one-time immediately, or is
  replay-tolerant refresh acceptable for local single-owner deployments?
- B1 blocker: should write sessions be stored in the memory session tables,
  mutation ledger, or a new compact route-session table?
- C1 blocker: what latency budget is acceptable before flipping governed hybrid
  retrieval to default-on?
- G1 blocker: which docs should be deleted versus marked legacy after the new
  guide set lands?

## First PR Candidates

The first implementation PRs should be small, ordered, and CI-pinned:

1. F1 script/runbook integrity test.
2. A1 operation-level `put_page` route-first enforcement.
3. A5 explicit personal write scope assertion.
4. G2 CLI help governed-loop alignment.
5. G3 generated doc drift check for operation count.

Follow-on ordered remote-hardening PRs:

1. A2 surface profile dispatch enforcement with stdio/http/edge snapshots.
2. A3 authenticated principal propagation after the surface profile contract
   exists.
3. A4 OAuth refresh-token replay decision before remote-hardening is considered
   complete.
4. C1 hybrid default-on promotion gate artifact after artifact schema and
   latency budget exist, without flipping the default yet.
