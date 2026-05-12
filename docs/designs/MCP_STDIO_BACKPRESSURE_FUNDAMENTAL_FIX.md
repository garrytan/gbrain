# MCP Stdio Backpressure Fundamental Fix

## Purpose

This document defines the root problem behind the Hermes/OpenClaw + Telegram +
MBrain MCP stalls, records the improvement ideas considered, and proposes the
target design for a fundamental fix.

The goal is not another narrow truncation patch. The target is to make MBrain's
MCP server predictable under stdio backpressure, large canonical pages, repeated
`put_page` writes, and client/harness concurrency.

## Baseline For The Next Session

The implementation should start from the committed branch baseline, not from
incidental dirty workspace state.

- Baseline commit: `1a062dafcee849c2ef51862d7452218339848c40` (`Improve MCP
  stdio backpressure handling`) on `mcp-stdio-backpressure`.
- The committed baseline still has `docs/MBRAIN_AGENT_RULES.md` at
  `mbrain-agent-rules-version: 0.5.7`.
- Local uncommitted changes that bump agent rules/tests to `0.5.8` and add
  `all_subbrains: true` are not required for this MCP backpressure design.
  They can be discarded unless the next task explicitly includes agent-rule
  publishing/readiness updates.
- The local `src/core/operations.ts` dynamic-import cleanup is also outside this
  design unless a future build or bundling task explicitly needs it.
- This design document itself is currently a planning artifact. If the workspace
  is reset before it is committed or otherwise preserved, the next session must
  recreate it from the latest saved copy.

## Problem Statement

Hermes/OpenClaw-style agents run MBrain and Telegram as MCP or channel-connected
subsystems under one harness. MBrain communicates over MCP stdio. Telegram
notifications also need timely dispatch through the same agent harness event
loop.

The suspected failure mode is:

1. MBrain emits or processes a large MCP message, such as `tools/list`,
   `get_page`, `read_context`, or `put_page`.
2. The harness is busy reading, parsing, or handling the MBrain response.
3. Telegram tries to deliver a channel notification while the harness is busy.
4. Telegram dispatch can be delayed if the harness processes MCP transports on
   the same event loop or a multiplexed stdout path. Independent stdio pipes do
   not directly backpressure each other unless the harness multiplexes them.
5. The Telegram bot remains TCP-alive but app-level dispatch stops making
   progress.

The current mitigation branch reduces several immediate pressure points:

- MCP `tools/list` uses compact schemas by default.
- MCP `get_page` defaults to bounded content windows.
- MCP tool results are guarded by a maximum text byte budget.
- MCP `put_page` can commit canonical content first and defer derived storage.
- MCP stdio starts while engine initialization is still pending.

That is useful, but it is not yet the fundamental design. The remaining risks
are actual JSON-RPC frame size, in-memory background work, snapshot consistency,
full-page reads before slicing, and lack of performance regression coverage.

## Non-Negotiable Requirements

1. Stdio output must be bounded by the bytes actually written to stdout, not only
   by the inner result string.
2. Canonical page writes must remain durable even if derived indexes are delayed.
3. Derived indexes must never serve stale results as if they were current.
4. Large reads must be windowed before full page bodies are materialized when the
   caller only asks for a window.
5. Continuation reads must be tied to a page snapshot, or they must warn/reject
   when the page changed between windows.
6. Background work must not compete with foreground MCP responses in an
   unbounded way.
7. The fix must preserve SQLite/Postgres semantic parity.
8. The solution must be measurable with stdio, page-size, burst-write, and
   derived-index benchmarks.
9. The solution must be tested against harness event-loop delay, not only
   MBrain-local byte counts.

## Acceptance Boundary

The MBrain-side fix is complete only when both local and harness-level evidence
pass:

- Raw stdio MCP tests capture every stdout line emitted by MBrain and assert the
  final line byte length, including JSON-RPC wrapper and trailing newline, stays
  within the configured budget.
- The budget applies to all server-originated JSON-RPC lines: `initialize`,
  `tools/list`, `tools/call` success, `tools/call` OperationError responses,
  protocol errors, and any future server notifications.
- A dual-channel harness stress test runs MBrain stdio under repeated
  `tools/list`, large `get_page/read_context`, and burst `put_page` calls while
  a synthetic Telegram channel emits heartbeat notifications.
- The harness test records Telegram dispatch p95 and max delay, and asserts
  both stay below an explicit threshold chosen in the implementation plan. If
  this cannot be automated in this repository, the document and release notes
  must state that the work fixes MBrain's contribution but does not by itself
  prove the full Hermes/OpenClaw stall is resolved.

## Ideas Considered

### Actual JSON-RPC Frame Budget

Current result guarding limits the JSON string placed inside `content[0].text`.
The MCP SDK then serializes that string inside a JSON-RPC response, adding
wrapper fields and escaping quotes/newlines. A 24 KB inner string can become a
larger stdout line.

The fix is to budget against the measured final JSON-RPC frame by wrapping or
subclassing the stdio transport send path, or by constructing the exact
`JSONRPCMessage` shape used by the SDK in tests and production before
`stdout.write`. Handler-level text guards are inputs to the transport-level
budget; they are not sufficient by themselves.

The formatter should reserve wrapper overhead and account for escaping. Known
large tools should use smaller inner budgets so the final stdout write stays
under the configured limit.

This is high priority because it addresses the pipe pressure boundary directly.

### Structured MCP Results

Returning JSON as text double-escapes data. `structuredContent` could carry the
object while `content` contains only a short summary.

This can reduce bytes and parsing cost for compatible clients, but client
compatibility is uncertain. It should be opt-in first, for example
`MBRAIN_MCP_STRUCTURED_RESULTS=1`, not the default fundamental boundary.

### Tool Catalog Pagination And Caching

Compact `tools/list` is smaller than the full schema, but it is still a large
single response and is regenerated on every request.

Caching compact/full catalogs in the server process is low risk. Pagination can
cap each page, but only if target clients reliably follow `nextCursor`; otherwise
pagination can make tools disappear. The fundamental fix should cache schemas
now and treat pagination as client-profile dependent.

### Inbound Request And Execution Bounds

Outbound response limits do not protect the server from a very large inbound
JSON-RPC request. A huge `put_page.content`, selector array, or malformed request
line can still force the SDK transport to buffer and parse a large line before
MBrain handlers can reject it.

The target design should define request argument limits and, if necessary, a
bounded stdio transport wrapper that rejects oversized JSON-RPC lines early.
MCP tool execution should also be concurrency-limited by class: mutating tools
serialize, heavy read/search tools have a small limit, and `tools/list` remains
lightweight and cached. This prevents several heavy operations from finishing
and writing large frames at the same time.

### Bounded Derived Work Queue

The current deferred `put_page` path uses in-memory `setTimeout(0)` scheduling.
That prevents the response from waiting on chunk/manifest/section rebuilds, but
bursts can schedule unbounded work and contend with foreground MCP operations.

The better design is a queue keyed by slug:

- foreground transaction commits canonical page and invalidates or marks stale
  every derived artifact whose effective inputs changed, including content hash,
  manifest path, scope id, tags, extractor version, and derived schema version;
- derived job is coalesced by slug, scope, artifact kind, target content hash,
  and derived parameters;
- SQLite runs derived jobs through a foreground-aware scheduler;
- Postgres may allow small configurable concurrency with foreground backoff;
- foreground MCP calls keep priority over background derived refresh.

This is necessary even if a durable outbox is added later.

### Durable Derived Outbox

An in-process queue still loses pending derived refresh after process exit. A
durable outbox records pending derived jobs in the same transaction whenever
canonical content or derived metadata requires refresh. This includes unchanged
content hash with changed manifest path, scope, extractor version, or derived
schema version. The worker drains jobs with leases, retries, and content-hash
guards.

This is the most correct design for production reliability. It adds schema and
worker complexity, but it eliminates the core failure where a response succeeds
and derived indexes never rebuild because the MCP server exited.

### Snapshot-Bound Continuations

Windowed `get_page` and guarded fallback continuations currently identify the
next read by slug and character offset. If the page changes between windows, the
agent can splice old and new content.

`RetrievalSelector` already has a `content_hash` field. The design must make
that field meaningful for every selector that reads page-derived text: `page`,
`compiled_truth`, `timeline_range`, `line_span`, `section`, and `source_ref`.
Follow-up `read_context`, `get_page`, and timeline/compiled-truth window reads
should either:

- return the requested window when the hash matches; or
- return a structured `stale_continuation` or `stale_selector` warning when the
  page changed.

This is correctness-critical once bounded reads become normal.

Continuation offsets must also define a cross-engine unit. The target unit is
0-based Unicode scalar offsets, not JavaScript UTF-16 code units. SQLite,
Postgres, and TypeScript implementations must use the same unit and must not
split a Unicode scalar. Tests must include non-ASCII and emoji content.

### Engine-Level Bounded Page Reads

The current `get_page` MCP default is bounded at the operation layer, but the
engine still fetches the full page and slices in TypeScript. Large pages still
cost memory, DB transfer, and serialization work before the final result is
small.

The engine should expose a bounded projection API, such as:

- `getPageProjection(slug, options)` for metadata-only or selected text fields;
- `getPageWindow(slug, ranges)` for `compiled_truth` and `timeline` substrings
  with total character counts and content hash.

SQLite can use `substr`/`length`; Postgres can use `substring`/`char_length`.
CLI full reads can keep using the existing full-page path.

All MCP canonical read paths must use the projection/window API when a selector
or token budget permits bounded access. This includes `read_context` selectors
for `page`, `compiled_truth`, `timeline_range`, and `line_span`; fixing only
`get_page` leaves a full-page materialization path in the evidence boundary.

### Source Ref And Search Hot Paths

Some reads still scale poorly:

- `readSourceRef` scans all note section entries in memory.
- SQLite keyword search selects full page bodies to build small snippets.

These are important performance cliffs, but they are adjacent to the MCP stdio
failure. They should be included in benchmark coverage and considered after the
core stdio/write/read-window work unless profiling shows they dominate.

## Recommended Target Architecture

The fundamental implementation should be one release-level invariant set, not a
collection of unrelated mitigations. It can land as multiple reviewable PRs
behind compatible defaults, but the work is not complete until every invariant
below is implemented and verified.

### 1. Stdio Budget Layer

Add a response budgeting layer inside the MCP server that reasons about the final
JSON-RPC response frame, not only the tool result text.

Responsibilities:

- cache compact/full tool schemas at server startup;
- enforce the budget immediately before `StdioServerTransport.send`, including
  the trailing newline;
- cover `initialize`, `tools/list`, `tools/call` success/error, OperationError
  envelopes, protocol errors, and future server notifications;
- measure exact final frame bytes for server-originated messages, using
  estimates only to choose inner result budgets before final validation;
- reserve wrapper overhead and escape overhead;
- enforce hard maximum stdout line bytes;
- keep opt-outs explicit and intentional.

Expected outcome: no normal MBrain MCP response can exceed the configured stdio
frame budget unless the operator deliberately raises the budget.

### 2. Snapshot-Safe Windowed Read Layer

Add engine-level bounded page reads and propagate `content_hash` through
continuation selectors.

Responsibilities:

- return page metadata plus bounded `compiled_truth`/`timeline` windows;
- include total chars, returned chars, next offsets, and content hash;
- reject or warn on stale continuation hashes for every page-derived selector;
- use projection/window APIs in `read_context`, not only `get_page`;
- define continuation offsets as 0-based Unicode scalar offsets across SQLite,
  Postgres, and TypeScript;
- keep direct CLI full-content behavior compatible.

Expected outcome: agents can inspect full documents through bounded continuation
reads without mixed-version content or full-body materialization.

### 3. Durable Derived Job Layer

Replace one-shot `setTimeout` scheduling with a derived job system.

Minimum target design splits work lifecycle from freshness state:

- `derived_jobs`: `id`, `scope_id`, `slug`, `artifact_kind`,
  `target_content_hash`, `manifest_path`, `derived_parameters`, `status`
  (`pending`, `running`, `failed`, `superseded`), `attempts`, `last_error`,
  `lease_owner`, `lease_expires_at`, `created_at`, and `updated_at`.
- `derived_index_state`: `scope_id`, `slug`, `artifact_kind`,
  `target_content_hash`, `indexed_content_hash`, `status`
  (`pending`, `ready`, `failed`), `extractor_version`, `derived_schema_version`,
  `last_error`, and `updated_at`.
- a unique active pending job exists per `scope_id`, `slug`, `artifact_kind`,
  and derived target; newer writes coalesce older pending work and mark older
  incompatible jobs `superseded`;
- jobs are stored transactionally whenever canonical content or derived metadata
  requires refresh, including unchanged content with changed manifest path,
  scope, tags, extractor version, or derived schema version;
- the worker drains jobs with content-hash and derived-parameter guards.

Foreground priority is operational, not aspirational: the worker has bounded
concurrency, bounded per-tick drain, no recursive immediate drains, and yields
between jobs. SQLite worker concurrency is 1 and must not start a new rebuild
while foreground writes are queued. Postgres may use configurable concurrency
with `SKIP LOCKED` leases and the same foreground backoff.

Expected outcome: canonical writes return quickly, stale derived data is removed,
and derived rebuilds are not lost if the MCP process exits.

### 4. Derived Freshness And Read Semantics

Make derived freshness explicit instead of inferring it from missing chunks or
missing section rows.

Responsibilities:

- expose derived status in `put_page` result and possibly a lightweight status
  operation;
- make section/source-ref reads warn when the derived index is pending or failed;
- never serve old chunks/sections for a newer page hash;
- define keyword/vector retrieval behavior for `pending` and `failed` derived
  state with SQLite/Postgres parity. It may return canonical page-level matches
  with `derived_status` warnings or suppress derived-backed results consistently,
  but it must not silently return empty as if no canonical page matched;
- store enough identity on chunks to prove embedding freshness:
  `chunk_content_hash`, `chunk_source`, `embedding_model`, and `embedded_at`;
- clear embeddings whenever chunk text, source, hash, or model changes,
  regardless of import path.

Expected outcome: retrieval can distinguish "not found" from "derived index is
pending" and does not treat stale derived rows as current evidence.

### 5. Regression And Performance Harness

Add dedicated benchmarks and stress tests before relying on the design.

Required coverage:

- MCP startup to `tools/list`;
- raw stdio final-frame bytes for `initialize`, `tools/list`, `tools/call`
  success, `tools/call` OperationError, and protocol errors;
- quote-heavy and newline-heavy tool result final frame bytes captured from
  stdout, not only estimated in helper tests;
- inbound oversized request rejection with continued server responsiveness;
- huge `get_page` window reads for 1 MB and 5 MB pages;
- `read_context` bounded selector reads that do not materialize full pages;
- continuation read after page mutation, including section/source-ref stale
  selector behavior;
- non-ASCII and emoji continuation offsets across SQLite, Postgres, and
  TypeScript paths;
- same content hash with changed manifest path under deferred `put_page` does
  not serve old path/sections as current;
- burst `put_page`, `get_health`, and bounded `get_page/read_context` p95 while
  derived jobs drain;
- process restart after queued derived job;
- dual-channel harness stress with synthetic Telegram heartbeat delay metrics;
- source-ref and search benchmarks as secondary visibility.

Expected outcome: future changes cannot accidentally reintroduce large stdout
frames or unbounded background work without visible regression.

## Why This Should Be One Cohesive Release

Small follow-up patches can each look correct while leaving the real failure
mode alive:

- truncating inner text does not guarantee final stdout frame size;
- deferring derived work without durability can lose index rebuilds;
- windowing reads without snapshot hashes can mix page versions;
- queueing work without frame budgeting can still block the harness;
- DB-level projections without benchmarks can silently regress later.

The coherent fix is to treat stdio, canonical writes, derived jobs, bounded
reads, and measurement as one system boundary. The implementation should still
land as reviewable PRs behind compatible defaults, but the release is not
complete until the whole invariant set passes.

## Recommended Sequencing

1. Add final-frame measurement, raw stdio tests, and tool schema/config caching.
2. Add inbound request limits and MCP tool execution concurrency limits.
3. Add engine projection/window APIs for SQLite and Postgres.
4. Enforce snapshot-bound selectors and stale continuation behavior across
   `get_page` and `read_context`.
5. Add `derived_index_state`, `derived_jobs`, migrations, engine methods, and
   coalescing semantics.
6. Implement the foreground-aware derived worker and restart/burst tests.
7. Add the dual-channel harness stress test or explicitly document that the
   repository can only prove the MBrain side of the issue.
8. Use source-ref indexing and search snippet optimization only if benchmarks
   show they are part of the observed stall path.

Implementation status:

- Step 1 is implemented in this PR slice: exact final-frame measurement,
  budgeted stdio transport, cached compact/full tool catalogs, inner tool-result
  budgeting, raw stdout regression tests, and full-schema compatibility coverage.
- Step 2 is implemented in this PR slice: inbound stdio request line budgeting
  before JSON parsing, bounded oversized-request error frames, continued
  responsiveness after rejection, serialized mutating MCP tool execution, and
  bounded heavy-read execution with lightweight tools left responsive.
- Step 3 is implemented in this PR slice: `BrainEngine.getPageProjection`
  returns page metadata plus requested `compiled_truth`/`timeline` windows from
  one engine query, with SQLite/Postgres/PGLite implementations and
  Unicode-scalar window contract tests. Existing full `getPage` reads remain
  compatible.
- Step 4 is implemented in this PR slice: bounded `get_page` and
  `read_context` page-derived reads propagate page `content_hash` through
  continuation selectors, reject stale or deleted snapshots with structured
  stale warnings/results, use Unicode-scalar offsets, and route
  `compiled_truth`, `timeline_range`, default `page`, and `line_span` reads
  through projection/window APIs. MCP fallback continuations also preserve
  snapshot hashes and window offsets.
- Step 5 is implemented in this PR slice: `derived_jobs` and
  `derived_index_state` are present in fresh schemas and migrations, engine APIs
  enqueue/coalesce/supersede derived work, ready completion is serialized with
  enqueue, stale completions are target-guarded, and page imports invalidate
  chunks/manifest/sections into durable pending work with derived freshness
  tracked by content hash plus extractor/schema metadata.
- Step 6 is implemented in this PR slice: the MCP server starts a durable
  derived worker by default, the worker leases and retries jobs with
  content-hash and active-target guards, yields before claiming work when
  mutating foreground MCP calls are active or queued, releases a claimed job
  before refresh if foreground pressure appears after claim, and
  restart/burst-yield/foreground-pressure tests prove durable drain behavior.
- Steps 7-8 remain future work. The repository still does not prove the
  dual-channel Telegram heartbeat behavior or source-ref/search optimization
  impact with benchmark evidence.
  The foreground-pressure signal is currently process-local to one MCP server;
  multi-process deployments should run a single derived worker per backing
  store, or set `MBRAIN_DERIVED_WORKER=0` on additional servers, until DB-wide
  foreground pressure or worker election is added.

## Resolved Decisions And Remaining Open Questions

1. Should `structuredContent` be opt-in in the same PR, or documented as a later
   compatibility experiment?

   Recommendation: opt-in only if the test client confirms compatibility;
   otherwise defer.

2. Should durable outbox be required immediately, or should the first
   implementation use only an in-process coalescing queue?

   Recommendation: include durable outbox now. The user goal is the fundamental
   fix, and process exit after a successful `put_page` is a real correctness
   gap. This is now a resolved target-design decision; the implementation may
   still land as multiple PRs.

3. What is the default MCP final frame budget?

   Recommendation: keep the current spirit of `24_000` bytes but define it as a
   final-frame budget. If compatibility requires larger catalog frames, separate
   `tools/list` budget from tool-result budget.

4. How strict should stale continuations be?

   Recommendation: return a structured warning/error rather than silently
   reading the new version from the old offset. `tools/call` should avoid
   throwing transport-level failures for ordinary stale selectors; return a
   structured operation error or warning envelope that clients can recover from.

5. Should source-ref indexing and search snippet optimization be in the same PR?

   Recommendation: benchmark and document them, but do not include unless
   profiling shows they are part of the Hermes/Telegram stall path.

## Proposed Next Step

Turn this design into an implementation plan that starts with tests and
benchmarks:

1. Add raw stdio final-frame budget tests, schema-cache tests, and inbound
   request limit tests.
2. Add snapshot selector and continuation tests, including `read_context`,
   section/source-ref, and non-ASCII offsets.
3. Add engine-level page window/projection APIs for SQLite and Postgres.
4. Add `derived_index_state` and `derived_jobs` schema, engine methods,
   coalescing rules, and restart tests.
5. Add foreground-aware worker tests and burst latency benchmarks.
6. Add harness-level synthetic Telegram heartbeat stress, or explicitly mark it
   as external validation if the harness cannot live in this repository.
7. Implement the server integration and update MCP docs.
