# MBrain Post-Review Improvements Design

Date: 2026-06-22
Status: Design spec (pending review → implementation plan)
Author: scott.lee + agent
Base commit: `b0be45b`
Worktree/branch: `worktree-post-review-improvements`
Implementation plan: `docs/post-review-improvements-2026-06-22-plan.md`

## Source

This spec operationalizes a read-only gap analysis run on 2026-06-22:
9 subsystems mapped → 7 lenses (architecture, reliability, retrieval
effectiveness, governance overhead, security/privacy, agent DX, goal
alignment) → every finding adversarially verified against current code
(already-fixed or by-design findings rejected) → 52 findings, 38 confirmed.

It builds on, and does not re-litigate, the prior reviews:
`docs/codebase-review-2026-06-11.md`, `docs/codebase-review-2026-06-16.md`,
`docs/performance-review-2026-06-10.md`. Items those reviews already closed
(e.g. postgres↔pglite unification via `PgEngineBase`) are out of scope.

## Goal

Close the highest-leverage gaps the analysis surfaced **without violating any
non-negotiable invariant**. One theme connects every lens — **proportionality**:
multi-party-grade review machinery has been imposed on a single self-reviewing
owner, so governance ceremony outran both enforcement and felt usefulness.

Concretely, this work must:

1. Restore the core promise (compounding context) at the exact path meant to
   enforce it — `retrieve_context` must not retrieve worse than the rule-breaking
   `query` op (Workstream A).
2. Make governance enforced where the product claims it is, and remove dead
   governance that misleads maintainers (Workstreams D, F).
3. Make the autonomous loop self-heal instead of merely counting problems
   (Workstream C).
4. Close two real privacy/scope leaks on the data substrate (Workstream B).
5. Make the brain show up proactively and report knowledge, not plumbing
   (Workstream E).

## Non-goals

- **No rewrite.** Incremental evolution only (Invariant 9).
- **Do not change keyword-only fallback semantics** for offline / no-embeddings
  installs. That fallback is what keeps SQLite/offline at semantic parity with
  Postgres (Invariant 8); Workstream A adds the vector leg *only when a provider
  exists*.
- **Do not auto-promote inferred facts**, and **do not auto-emit a canonical page
  on every promotion** (Invariants 3, 5). Workstream D closes the promotion loop
  with an *optional* convenience op and anomaly surfacing only.
- **Do not flatten scope isolation** for convenience (Invariant 6).
- The large structural refactors — a declarative schema DSL, a unified
  `SqlCapableEngine` seam, and decomposing the 9,458-line `sqlite-engine.ts` —
  are real strategic bets (see §8) but are **scoped out** of this spec, except
  for one contained slice (the cross-engine parity test, R10) that protects the
  parity invariant *now*.

## Invariants this work must preserve

From `docs/architecture/redesign/00-principles-and-invariants.md`. The ones that
directly constrain a change below are tagged on that change as a **Guardrail**.

1. Human-editable Markdown remains canonical.
2. Retrieval order is intent/scope-driven, not storage-tier-driven.
3. Derived artifacts are not canonical without an explicit promotion step.
4. Ongoing work state has a durable canonical home.
5. Provenance is mandatory for promoted claims.
6. Work and personal memory are isolated by default.
7. Local-first / offline operation is an architectural constraint.
8. Backend semantic parity (SQLite ≡ Postgres at the contract boundary).
9. Incremental evolution; no rewrite-first.

---

## Workstream A — Retrieval correctness (highest leverage)

### A1 (was R01) — Give `retrieve_context` the vector leg

**Problem.** `retrieve_context` is the rules' mandated first call and
`read_context`'s evidence boundary, yet it runs keyword-only search with no
vector leg and no query expansion. The lower-authority `query` op runs full
hybrid (vector + keyword + RRF + expansion). A rule-following agent therefore
gets strictly worse recall on synonym / paraphrase / cross-vocabulary queries
than one that ignores the rules — inverting the documented authority gradient and
defeating "learn once, never rediscover" at the path that is supposed to enforce
it. The escalation route (`broad-synthesis`) is also keyword-only.

**Evidence (verified).**
- `src/core/services/retrieve-context-service.ts:276-277` — `candidateSearch`
  defaults to `(q, opts) => engine.searchKeyword(q, { limit: opts.limit })`.
- `src/core/operations.ts:3372` — `query` op uses `hybridSearchWithMeta` with
  `expandQuery`.
- `src/core/operations.ts` — the `retrieve_context` handler calls
  `retrieveContext(ctx.engine, {...})` and passes **no** `candidateSearch`
  override (`grep candidateSearch src/core/operations.ts` returns nothing).
- `src/core/services/broad-synthesis-route-service.ts:113-114` — escalation route
  also keyword-only.
- `src/core/search/hybrid.ts:68-71` — `hybridSearch` already degrades to
  keyword-only when `getEmbeddingProvider().capability.available` is false.

**Design.** Inject the hybrid candidate search into the governed probe, exactly
as the `query` op already does:

```ts
// operations.ts, retrieve_context handler
retrieveContext(ctx.engine, {
  ...input,
  dependencies: {
    candidateSearch: (q, opts) =>
      hybridSearch(ctx.engine, q, {
        limit: opts.limit,
        expansion: true,
        expandFn: (s) => expandQuery(s, { config: ctx.config }),
      }),
  },
});
```

Do the same at the two other call sites that default to keyword:
`read-context-service.ts:1368` (auto-reads caller) and
`broad-synthesis-route-service.ts:113`.

**Guardrail (Invariants 7, 8).** Keep keyword-only as the offline / no-provider
fallback. `hybridSearch` already does this; do not add a hard dependency on an
embedding provider. The behavior on a no-provider SQLite install must be byte-for-
byte unchanged.

**Acceptance.**
- A1 is locked by A2 (recall harness): paraphrase queries whose gold page shares
  no surface keyword are retrieved into top-k by `retrieve_context`.
- No regression on the existing qrels / graph-frontier selection fixtures.
- With the embedding provider disabled, `retrieve_context` produces the same
  results as before this change (parity guard test).
- Land behind a config flag (`retrieval.governed_probe_hybrid`, default off in
  the first PR), flip to default-on after the eval gate is green.

**Risk.** Precision regression on lexical-exact queries if expansion is too
aggressive — gate behind the eval fixtures and the flag before flipping default.
Latency is bounded (vector + keyword already run concurrently inside
`hybridSearch`).

### A2 (was R02) — Real recall harness on the production path

**Problem.** Retrieval quality is unguarded. The qrels gate injects pre-ranked
candidate lists (`score = length − index`), every `retrieve_context` test mocks
`candidateSearch`, and hybrid tests mock `searchVector` to `[]`. No recall@k is
measured over a real index running the production path, so the A1 asymmetry — and
any future ranking regression — passes CI green.

**Evidence (verified).**
- `test/retrieval-quality-qrels-gate.test.ts:58-74` — fixture candidate slugs are
  already rank-ordered.
- `test/retrieve-context-service.test.ts:65+` — `candidateSearch` mocked in every
  test.
- `test/hybrid-search.test.ts:51,82` — `searchVector` mocked to `[]`.

**Design.** Add one **DB-free SQLite** test (default `bun test` tier, no API
keys): import ~20-30 short pages on distinct topics plus near-duplicate
distractors, then run 8-12 labeled queries through the **real** `retrieve_context`
path (no `candidateSearch` override), asserting `top1_match` and `recall_at_10`
against gold slugs. Include ≥2 paraphrase queries whose gold page shares no
surface keyword. Assert **set membership** (recall@k) + top-1, not exact rank
order, to stay deterministic. Keep the qrels gate for selection-math but rename
its describe block so it is not mistaken for a recall guarantee.

**Guardrail (Invariant 8).** Run it on SQLite so it executes in the default tier
without Postgres; the production keyword/hybrid path must be exercised, not a
mock.

**Acceptance.** Test fails on current `main` (keyword-only) for the paraphrase
queries, passes after A1.

---

## Workstream B — Privacy & honesty (low-risk, tight PR)

### B1 (was R04) — Close the raw-source text leak

**Problem.** `list_source_items --include_chunks` returns
`SourceChunkInspectionRecord` with `redacted_text` intact. `redactSecrets` returns
its input verbatim when no `SECRET_PATTERN` fires, so `redacted_text === chunk_text`
in the common case — full raw private source bodies — with no `evaluate_raw_access`
call, no `raw_access_ledger` entry, no consent/scope check. The op is reachable
over the remote Supabase edge function. This violates "raw source access is
scoped/audited".

**Evidence (verified).**
- `src/core/source-registry/raw-ingest-store.ts:163-168` — inspection record omits
  only `chunk_text`; `redacted_text` retained.
- `src/core/source-registry/raw-ingest.ts:349-365` — `redactSecrets` returns input
  verbatim when no pattern matches.
- `src/core/operations-source-registry.ts:2172-2178` — `listSourceItems` maps
  chunks with no `evaluate_raw_access` / ledger call.
- `supabase/functions/mbrain-mcp/index.ts:21-22` — `REMOTE_EXCLUDED` drops only 3
  ops; `list_source_items` is reachable remotely.

**Design.**
1. In `redactSourceChunkForInspection` (`raw-ingest-store.ts:165`) drop
   `redacted_text` too; return only `chunk_hash`, `token_count`,
   `sensitivity_flags`, `secret_risk`, `prompt_injection_risk`.
2. Add one authorized op `request_raw_source_chunks` that runs the same policy
   resolution + ledger write as `evaluateRawAccessOperation`, and only on a
   non-deny decision returns `redacted_text` (**never** raw `chunk_text`).
3. Update the two tests that assert verbatim text on the unauthorized path.
4. Add a secret-risk + non-secret fixture test proving no raw body escapes the
   unaudited path.

**Guardrail.** Connector inspection UIs that relied on `redacted_text` must move
to the authorized op — document the new flow; update connector/smoke tests.

**Acceptance.** `list_source_items(include_chunks=true)` returns no `chunk_text`
and no `redacted_text`; the authorized op writes a ledger row and returns only
redacted text on allow; a `secret_risk` fixture never leaks raw text through any
inspection endpoint.

### B2 (was R03) — Fix the `doctor` offline-profile severity inversion

**Problem.** `doctor`'s `offline_profile` check returns `ok` only for
`local_offline` and `warn` for everything else, so **every standard Postgres
install — the documented primary runtime — permanently shows `[WARN]`** and emits
a spurious p2 remediation action. `doctor` is the first command a new operator
runs; a false warning on the healthy default erodes trust in every other check.

**Evidence (verified).**
- `src/core/services/doctor-service.ts:557-564` —
  `status: envelope.mode === 'local_offline' ? 'ok' : 'warn'`.
- `src/core/services/doctor-remediation-service.ts:77` — remediation builder
  includes every check with `status !== 'ok'`, so the warn emits a standing
  action.

**Design.** At `doctor-service.ts:562` return `ok` for both intentional modes
(keep the mode-specific message). Reserve `warn` for an actual config-vs-engine
mismatch (offline flag set but engine = postgres, or vice versa). The spurious p2
action disappears automatically because the remediation builder keys off
`status !== 'ok'`. Add a one-line test asserting the cloud-connected check is `ok`.

**Acceptance.** A standard Postgres `doctor --json` reports `offline_profile: ok`
and emits no offline remediation action; a real mode/engine mismatch still warns.

### B3 (was R05) — Route ungoverned personal-memory write/delete through the scope gate

**Problem.** `upsert_profile_memory_entry` and `record_personal_episode` write
directly to the engine with no scope gate and accept arbitrary `scope_id`;
`delete_profile_memory_entry` / `delete_personal_episode_entry` delete by id with
no scope/ownership check. Their governed peers (`write_profile_memory_entry` /
`write_personal_episode_entry`) correctly call `selectPersonalWriteTarget`. This
contradicts the governed-write-path-only invariant and presents a simpler-looking
shortcut that silently skips governance.

**Evidence (verified).**
- `src/core/operations.ts:3802-3828` — `upsert_profile_memory_entry` writes the
  engine directly, `scope_id` verbatim.
- `src/core/operations.ts:3840-3848, 3947-3953` — deletes by id with no
  scope/ownership check.
- `src/core/operations.ts:4345-4356` — `write_profile_memory_entry` calls
  `selectPersonalWriteTarget` (the gated pattern).
- `docs/architecture/redesign/02-memory-loop-and-protocols.md:174-175` —
  governed-write-path-only invariant.

**Design.** Route the two ungoverned writers through `selectPersonalWriteTarget`
(throw when `preflight.route` is null), **or** remove them now that the `write_*`
peers exist. For both deletes, fetch the entry first and require
`scope_id.startsWith('personal:')` before deleting, and record the delete in the
mutation ledger. If any variant must remain for admin/migration, mark it with the
`admin` tier (Workstream C, C1).

**Guardrail (Invariant 6).** A `work:*` `scope_id` must be rejected on the
personal write path.

**Acceptance.** A `work:*` `scope_id` is rejected on the personal write path; a
cross-scope delete is rejected; the gated `write_*` peers are unchanged; mutation
ledger records the delete.

---

## Workstream C — Agent surface & self-healing

### C1 (was R06) — `tier` field on `Operation`; gate the MCP catalog; always emit safety annotations in compact mode

**Problem.** ~182 ops are returned flat in every `list_tools` with no
tier/audience field (~86 are governance / control-plane / source-registry), so the
~10 daily ops are buried and admin ops like `apply_memory_redaction_plan` are
freely callable. Worse, **compact mode (the default on the local stdio surface
that Claude Code / Codex use) strips `description`, `title`, AND
destructive/read-only hints from 180 of 182 tools**, while remote HTTP clients get
full descriptors — exactly backwards. `get_skillpack` (the runtime self-orientation
entrypoint) is undiscoverable in compact mode, and required-param value lists live
in prose with no `enum` array. (Prior-review G3, still open.)

**Evidence (verified).**
- `src/core/operations.ts:307-325` — `Operation` interface has no
  tier/audience/visibility field.
- `src/mcp/server.ts:300-304, 825-829` — compact mode is the stdio default.
- `src/mcp/tool-schema.ts:79-82` — returns `{}` (no title/annotations) unless
  `compactDescription` set; only 2 ops carry it.
- `src/mcp/http-server.ts:138` — HTTP forces `compact:false` (the inversion).
- `docs/codebase-review-2026-06-11.md:107-125` — G3, unfixed.

**Design (two independently shippable parts).**

*Part 1 — immediate, low-risk (ship first):*
- In `tool-schema.ts`, **always** emit `title` and `readOnlyHint`/`destructiveHint`
  annotations regardless of compact (a few tokens per tool, safety-critical —
  mirrors the already-accepted F12-c "required" precedent).
- Give `get_skillpack` a `compactDescription` and add one `MCP_INSTRUCTIONS`
  sentence pointing cold agents to it.
- Add `enum: [...RETRIEVAL_ROUTE_INTENTS]` to the required `intent` params on
  `evaluate_scope_gate` / `select_retrieval_route` so valid values survive compact
  mode instead of surfacing as a runtime error.

*Part 2 — the tier system:*
- Add `tier?: 'core' | 'extended' | 'admin'` to the `Operation` interface; tag the
  ~10-15 daily ops `core` and control-plane / redaction / realm / session /
  maintenance ops `admin`.
- Filter the MCP catalog by `MBRAIN_MCP_TOOL_TIER` (default `core+extended`;
  `=all` to expose everything), keeping the existing capability filter and the
  `tool_search` lazy-load escape hatch. Keep dispatch-by-name **unfiltered** so a
  named call to a hidden op still works.
- Pin the tier contract in `test/parity.test.ts`.

**Guardrail (DG3).** Existing clients that expected the full flat surface lose
admin ops by default; mitigate with `=all` opt-in. The edge surface may want
`default=all` to avoid breaking remote flows — decide per surface.

**Acceptance.** Compact-mode tool list still carries `title` + safety hints;
`get_skillpack` is discoverable; default stdio catalog returns only `core+extended`;
`=all` restores the full surface; named dispatch of a hidden op still works.

### C2 (was R07) — Make the autonomous loop self-heal

**Problem.** The maintenance loop counts problems instead of fixing them.
`sweepTimedOutJobs` is implemented/tested but has no production caller, so crashed
jobs leak as `active` and can stall a slot via dedup; the daily report counts only
failed/dead jobs, so the stuck-active state is invisible. The durable
`embed_backfill` job fails the whole run on one transient provider blip
(`max_attempts:1` + `retryable:false`).

**Evidence (verified).**
- `src/core/services/maintenance-runtime-db-adapter.ts:492-537` —
  `sweepTimedOutJobs` implemented; no production caller.
- `src/core/services/embed-backfill-job-service.ts:72,158-168` — `max_attempts:1`
  + `failJob(retryable:false)` on any partial failure.
- `src/core/services/dream-cycle-runner-service.ts:422-441` —
  `embedding_refresh` / `context_refresh` count-only; daily report counts only
  failed/dead.
- `src/core/derived-worker.ts:121-160` — default-on derived worker already
  self-heals derived artifacts.

**Design.**
- (a) Call `sweepTimedOutJobs` at the start of `submitCycle` (before the dedup
  check) so orphaned `active` rows past `timeout_at` are dead-lettered and stop
  blocking re-submission.
- (b) In `embed-backfill-job-service.ts` pass `retryable:true` for the
  partial-failure case (keep `runner_unavailable` non-retryable) and raise
  `max_attempts` to ~3 with exponential backoff — the backfill is idempotent and
  only re-embeds unembedded chunks.
- (c) Extend the `daily_report` phase to count `status='active' AND
  lock_expires_at <= now()` and flag it as actionable.
- (d) For embeddings (not `context_refresh`, which the default-on derived worker
  already drains), either auto-enqueue `embed_backfill` when
  `missing_embeddings > 0` behind a default-off config flag, or stop marking the
  count-only phase `implemented:true` and surface the `mbrain embed --stale`
  remediation in the dream `next_action`.

**Guardrail (Invariant 7).** Auto-enqueueing embeddings could surprise local-first
users with cost/CPU — gate behind a **default-off** config flag. Sweep + retry must
not double-process; rely on existing lease/idempotency keys.

**By-design note.** `context_refresh` being count-only is largely redundant with
the default-on `startDerivedWorker` polling loop — do **not** duplicate that
self-healing. Only the embedding half is a genuine gap.

**Acceptance.** A job that exceeds `timeout_at` is dead-lettered on the next
`submitCycle` and no longer blocks its slot; a single transient provider error
retries instead of failing the run; the daily report lists stuck-active jobs.

### C3 (was R10) — Generalize the cross-engine column-parity test

**Problem.** The only structural enforcement that SQLite and Postgres-dialect
schemas agree at the column level checks a hardcoded 9-table list. ~40 other shared
tables — assertion, governance, `personal_episode`/`profile`, context-map/atlas,
`memory_realms`/`sessions`/`redaction_plans` — are unguarded. Given the SQLite
`ensure*`-helper monolith (no compile-time guard elsewhere), a helper that
adds/renames a column without the matching PGLite/PG migration silently drifts,
threatening backend semantic parity.

**Evidence (verified).**
- `test/migrate.test.ts:67-77` — `sharedTables` hardcodes exactly 9 tables.
- `src/core/sqlite-engine.ts:7624+` — assertion tables defined separately, none
  parity-tested.

**Design.** In `test/migrate.test.ts` replace the hardcoded array with a
programmatic intersection computed after both `initSchema()` calls (SQLite
`sqlite_master` ∩ PGLite `information_schema.tables`, minus an explicit allowlist
of intentional divergences), then run the existing column-set equality assertion
over every shared table. The harness already migrates both engines before
introspection, so this is a single-test change with no production risk.

**Guardrail (Invariant 8).** Some tables may legitimately differ — capture those
in a small documented allowlist rather than dropping the assertion.

**Acceptance.** Adding a column to a SQLite ensure-helper without the matching
PGLite migration fails this test.

---

## Workstream D — Write-governance proportionality

### D1 (was R09) — Make `put_page` enforce the router discipline

**Problem.** `put_page`'s governance runs only when `memory_session_id` is supplied
(null by default), and `expected_content_hash` is optional. Existing-page blind
overwrite is now blocked, but **brand-new canonical pages can be created with no
router decision, no session, no grant, and only a self-attestable `[Source:]`
string.** The router's `canonical_write_allowed` protocol is purely cooperative —
the server never verifies a route decision preceded the write. The governance
ceremony is thus a tax paid only by well-behaved agents.

**Evidence (verified).**
- `src/core/operations.ts:3056` — `expected_content_hash` nullable/optional, never
  required.
- `src/core/operations.ts:3097-3104` — authorization runs only inside
  `if (memorySessionId)`, default null.
- `src/core/operations.ts:2509-2519` — `assertPutPageSourceAttribution` requires
  only one `[Source:]` substring.
- `scripts/smoke-test-installed-mcp.ts:165-172` — own smoke calls `put_page` with
  just `{slug, content}` and succeeds.

**Design.** Make the simple path the governed path:
- On the agent-facing MCP surface, require the `expected_content_hash` **field to
  be present** (value may be `null`), rejecting when omitted — forcing every write
  to first observe the target (or assert absence with `null`), turning convention
  into enforced CAS with no new steps.
- Reject sessionless fresh-slug creation with a clear `route_first` error naming
  `route_memory_writeback`.
- Provide a separate CLI-local / admin-flagged `admin_put_page` for repair/import
  that may omit the hash (tag it `admin`, C1).
- Persist in the mutation ledger whether the caller actually supplied the
  precondition.

A full router-grant token is heavier than needed for a single user and is
**deferred**.

**Guardrail (Invariant 9, DG2).** This changes the public tool contract — needs a
migration note for existing callers, a smoke-test update, and an
`MBRAIN_AGENT_RULES` update. Keep the local-CLI/admin escape hatch so offline
repair stays possible.

**Acceptance.** Agent/MCP `put_page` without the `expected_content_hash` field
rejects with `route_first`; with `null` on a truly-absent slug it succeeds; with a
stale hash it conflicts and writes nothing; `admin_put_page` (CLI-local) still
repairs without a hash; the ledger records whether the precondition was supplied.

### D2 (was R11) — Close the promotion loop; surface promoted-without-page anomalies

**Problem.** `promote_memory_candidate_entry` only flips a row to
`status='promoted'` and writes no markdown page. A fully-governed candidate
lifecycle (route → create → verify → advance → promote) can end with nothing
retrievable via `retrieve_context`/`read_context`. For a single self-reviewing
owner this is the core proportionality failure: heavy governance work compounds
into nothing.

**Evidence (verified).**
- `src/core/pg-engine-base.ts:2454-2490` / `src/core/sqlite-engine.ts:3691` —
  promote is a row-only status flip, no page write.
- `src/core/auto-promote/promote-gate.ts:167-253` — only the (default-off)
  auto-promote gate emits a page via `apply_memory_patch_candidate`.
- `src/core/services/brain-loop-audit-service.ts:398-418` —
  `promotedWithoutHandoff` already tracked as an auditable anomaly.

**Design.** Keep promotion as an explicit governed step (do **not** auto-emit a
page on every flip). Add one optional convenience op (e.g. `bind_and_promote` /
`promote --write-page`) that, for a page-backed candidate with a slug, runs the
existing governed `create_memory_patch_candidate` → review →
`apply_memory_patch_candidate` sequence atomically, defaulting
`session_id`/`realm_id`/`actor` from the active session. At minimum, have `promote`
return a `canonical_write_pending` hint when no write followed, and surface
`promotedWithoutHandoff` in the daily report. Update `MBRAIN_AGENT_RULES` to state
plainly that promotion alone does not produce retrievable markdown.

**Guardrail (Invariants 3, 5, 6).** The convenience op must not bypass
provenance/scope — reuse the proven `apply_memory_patch_candidate` path, never a
new writer. Defaulting session/realm/actor must still honor scope isolation.
**This is not auto-promotion** — the page write is still an explicit, governed,
opt-in step.

**Acceptance.** A page-backed candidate can go from candidate to retrievable
markdown in one governed op without hand-supplying session/realm/actor; a bare
`promote` with no follow-up returns `canonical_write_pending`; the daily report
lists promoted-without-page anomalies.

---

## Workstream E — Proactive recall & knowledge-centric review

### E1 (was R12) — Proactive recall + a knowledge digest

**Problem.** The compounding-context promise is undercut on the felt-experience
axis. The session-activation planner (`plan_agent_session_activation`) is
substantive recall machinery but is **never auto-invoked** — the only proactive
surface is a text nudge telling the agent to fetch context itself. And the "primary
review surface", the daily memory report, is an ops-exception digest with no "what
did my brain learn / now believes / where is it blind" lens.

**Evidence (verified).**
- `src/commands/setup-agent.ts:578-605` — only `Stop` and `UserPromptSubmit` hooks
  registered; no `SessionStart`.
- `src/core/operations-agent-session-activation.ts:25-47` —
  `plan_agent_session_activation` is a substantive planner with no
  hook/command/cron caller.
- `src/commands/memory-report.ts:284-299` — `canonical_memories` summary is the
  raw operation/target string, not a learning digest; no coverage-gap section.

**Design.**
- (a) Wire a `SessionStart` hook (a third entry in `CLAUDE_MANAGED_HOOK_ENTRIES`
  plus a hook script) that calls `plan_agent_session_activation` for the active
  scope/cwd and injects a compact, **token-bounded, scope-gated** activation card
  (recent task threads, working set, top profile/episode signals) as
  `additionalContext` — actual context, not an instruction; silent on empty.
- (b) Add a thin knowledge-digest section to the daily report projected from
  existing data: render `canonical_memories` deltas as human-readable "learned this
  period" summaries (not the raw operation/target string), and promote the briefing
  skill's pageless-mention coverage-gap heuristic to a first-class list. Defer the
  "now believes" compiled-truth diffing as optional/flagged.

**Guardrail (Invariants 6, 7; honor [[claude-hooks-nonblocking-preference]]).** The
activation card must be token-bounded and scope-gated to avoid bloating every
session and to respect work/personal isolation. The hook must be **silent on
empty** and inject `additionalContext` (non-blocking), matching the user's
documented hook-UX preference. Land A1 first — activation inherits the keyword-match
ceiling until the vector leg exists.

**Acceptance.** A new session in a known scope receives a bounded activation card
(or nothing, silently, when empty); the daily report shows a human-readable
"learned this period" section and a coverage-gap list.

---

## §8 — Structural decision gate (decision required before code)

### F1 (was R08) — Decide the fate of the assertion / governed-write apply path

**Problem.** ~4,100 LOC across `src/core/assertions/` plus
`GovernedCanonicalWriteService` (655 LOC) and 6+ dedicated tables are **dead
structure**: `applyCanonicalWrite` and `resolveExtractedClaimForEngine` have no
production caller, the preview ops use throwaway in-memory services, and the read
ops query permanently-empty tables. This imposes full schema-parity and
SQLite-mirroring cost and reads as enforced governance to future maintainers while
enforcing nothing. It also amplifies the flat-tool-surface problem (C1).

**Evidence (verified).**
- `grep -rln applyCanonicalWrite src | grep -v test` → only
  `governed-canonical-write-service.ts`; constructed only in tests.
- `src/core/services/assertion-pipeline-service.ts:91-93` — preview ops use
  in-memory `Map`s; `resolveExtractedClaimForEngine` has zero non-test callers.
- `src/core/operations.ts:3097` — `put_page` governance runs only inside
  `if (memorySessionId)`, bypassing the whole pipeline.
- `src/schema.sql:488-597` + `sqlite-engine.ts` `ensureAssertionPipelineSchema:7624`
  — 6 assertion tables mirrored by hand on SQLite.

**This is a decision, not an implementation.** The incremental-evolution invariant
forbids blind deletion. The owner must choose, in an ADR, between:

- **Option A — Retire (recommended).** The live product direction is the
  Memory-Inbox candidate ladder. Retire the dead apply machinery: delete
  `resolveExtractedClaimForEngine`, `applyCanonicalWrite`,
  `GovernedCanonicalWriteService`, `canonical-write-audit-store`, and the SQLite
  mirrors that exist only to support them; add a migration dropping the unused
  tables on both engines; keep read/preview/explain ops only if surfaced in a real
  feature. Recovers ~3-4k LOC and a large chunk of the SQLite schema burden.
- **Option B — Wire it.** Make `GovernedCanonicalWriteService` the real canonical
  gate: route `put_page` (or a new `governed_put_page`) through
  `applyCanonicalWrite` so session-grant / runner-trust / quarantine actually gate
  canonical writes. Larger, and overlaps with D1.

Either way: add a test asserting the assertion tables are either written by a live
op or absent. **Do not leave the status quo.**

**Dependency.** Resolve F1 before or alongside C1's tier work (it changes which ops
exist) and D1 (both touch the canonical-write path).

---

## Sequencing

| Phase | Items | Why this order | Contract change? |
|-------|-------|----------------|------------------|
| 1 | A1, A2 | Highest leverage; A2 locks A1. Everything downstream (E1 recall) inherits the ceiling. | No (flag-gated) |
| 2 | B1, B2, B3 | Tight security/honesty PR, small blast radius, clear regression tests. | No |
| 3 | C1-part1, C3, C2 | Cheap surface-safety + self-heal wins reusing existing machinery. | No |
| 4 | C1-part2 | Tier system; needs the `=all` opt-in decision (DG3). | Catalog default |
| 5 | D1, D2 | Governance enforcement; both alter public/tool contracts. | **Yes** (DG2) |
| 6 | E1 | Proactive recall + digest; depends on A1. | No |
| Gate | F1 | Owner ADR decision; resolve before/with C1-part2 and D1. | TBD by decision |

This mirrors the prior reviews' Phase A/B/C/D discipline: security/data-integrity
first, then core contracts, then surface/observability.

## Decision gates (owner input required)

- **DG1 (F1)** — Retire vs wire the assertion/governed-write apply path. ADR
  required before any code in §8. Recommendation: **retire (Option A)**.
- **DG2 (D1)** — Public `put_page` contract change (require `expected_content_hash`
  field present). Needs migration note + smoke update + agent-rules update.
- **DG3 (C1-part2)** — Default MCP tool tier. `core+extended` default with `=all`
  opt-in; possibly `=all` on the edge surface. Confirm per surface.

## Overall acceptance (definition of done for the whole effort)

- A rule-following `retrieve_context` retrieves paraphrase-only matches that
  `query` already finds (A1+A2), with the no-provider parity guard green.
- No raw chunk text escapes an unaudited inspection path (B1).
- `doctor` reports the standard Postgres profile as healthy (B2).
- Personal write/delete cannot cross scope (B3).
- Default stdio tool list carries safety annotations and a discoverable
  orientation entrypoint; daily-driver ops are not buried (C1).
- A crashed maintenance job self-heals on the next cycle; a transient embedding
  blip retries (C2).
- Cross-engine column drift on any shared table fails CI (C3).
- New canonical pages cannot be created without observing the target / routing
  (D1); a governed candidate can become retrievable markdown in one op (D2).
- A new session gets bounded, scope-gated proactive recall; the review surface
  reports knowledge, not only plumbing (E1).
- The assertion/governed-write apply path is either wired or retired, with an ADR
  and a test that forbids the dormant middle state (F1).

## Out of scope (acknowledged strategic bets, future specs)

- **B-DSL** — a declarative schema spec that both the Postgres migration generator
  and the SQLite `ensure*` helpers derive from, after extracting the ~3,600-line
  schema region of `sqlite-engine.ts` into a `SQLiteSchemaManager`.
- **SQL-seam** — unify raw-SQL access behind one declared `SqlCapableEngine` seam,
  deleting the 7+ redefined engine-shape types and three duck-typing conventions.
- **precision-lookup full-table scans** — rewrite to use targeted filters the
  engine already supports (a contained slice may be pulled into Phase 3 if cheap).
- **live contradiction detection** on the write path (deterministic polarity layer
  atop the existing same-target duplicate scan) + a freshness guard on lifecycle
  forgetting transitions.
