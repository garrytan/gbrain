# GBrain Knowledge Runtime — Design Doc

**Status:** DRAFT for CEO review.
**Date:** 2026-04-18.
**Supersedes:** The earlier "Feynman Ideas Assessment + Phase A/B" plan.

---

## 0. Context

During a CEO review of a narrow two-feature plan (bare-tweet citation repair + completeness score, borrowed from Feynman), the scope was reframed. The narrow plan duplicated work Garry's OpenClaw already does and missed the real leverage point: **the bespoke abstractions hiding inside OpenClaw — resolvers, enrichment orchestration, scheduling, deterministic output — should live in GBrain as first-class primitives.**

North star: *"When Garry's OpenClaw's Claw upgrades to this version of GBrain, it should immediately recognize brilliance and completeness and say 'It's time to switch to these abstractions.'"*

That is the test this document is designed against. Everything else is downstream.

---

## 1. The Four Layers

The design is four layered abstractions. Each is independently useful; together they are the Knowledge Runtime.

```
  ┌───────────────────────────────────────────────────────────────────┐
  │                   KNOWLEDGE RUNTIME (new)                         │
  ├───────────────────────────────────────────────────────────────────┤
  │  Layer 4: Deterministic Output Builder                            │
  │     BrainWriter · Scaffolds · Back-link enforcer · Slug registry  │
  │     Rule: LLM picks WHAT to write. Code guarantees WHERE and HOW. │
  ├───────────────────────────────────────────────────────────────────┤
  │  Layer 3: Scheduler                                               │
  │     ScheduledResolver · TZ-aware quiet hours (enforced) ·         │
  │     Auto-stagger · Durable state · Retry/circuit-break            │
  ├───────────────────────────────────────────────────────────────────┤
  │  Layer 2: Enrichment Orchestrator                                 │
  │     Trigger convergence · Tier routing · Budget · Cascade ·       │
  │     Evidence-weighted completeness · Fail-safe transactions       │
  ├───────────────────────────────────────────────────────────────────┤
  │  Layer 1: Resolver SDK                                            │
  │     Resolver<I,O> interface · Registry · Factory · Plugin recipes │
  │     Ported reference impls: X-API, Perplexity, Mistral, brain     │
  └───────────────────────────────────────────────────────────────────┘
          │                                                │
          ▼                                                ▼
     REUSES (polished primitives already in GBrain)  REPLACES (ad-hoc code)
     FailImproveLoop · backoff · storage factory ·   enrichment-service ·
     check-resolvable · operations validators ·      embedding · transcription ·
     engine interface · publish · backlinks          2 recipe formats
```

---

## 2. Why This Order (L1 → L4)

Every higher layer depends on the lower one. **L1 must land first or the rest leaks abstractions.**

- **L1 (Resolvers)** is the substrate. Without a uniform lookup interface, every orchestrator + writer has bespoke callers.
- **L2 (Orchestrator)** uses L1 to fetch; without L1 it's still ad-hoc.
- **L3 (Scheduler)** runs L2 periodically; without L2 it's scheduling nothing structured.
- **L4 (Output Builder)** is what every layer ultimately writes through; without it we have 14 call sites doing `fs.writeFile` with hand-rolled citation discipline.

An earlier implementation could ship L1 + L4 first (the two "purest" layers) and have the most immediate integrity impact, then add L2 + L3. But the end-state must include all four.

---

## 3. Layer 1 — Resolver SDK

### 3.1 What's broken today

Garry's OpenClaw has **69 distinct external-lookup patterns** across X API (14 shapes), Perplexity, Mistral OCR, Gmail, Calendar, Slack, GitHub, YouTube, Diarize.io, YC tools, OSINT collectors, and brain-local lookups. Each one is a bespoke script under `scripts/` with its own error handling, retry logic, and output shape. GBrain has 3 ad-hoc wrappers (`embedding.ts`, `transcription.ts`, `enrichment-service.ts`) that don't share an interface.

Common consequences:
- No uniform retry/backoff strategy (some scripts retry, most don't)
- No cost tracking (Perplexity bills eaten silently when calls return no-substance results)
- No confidence/provenance propagation (callers can't tell if an answer is verified or inferred)
- Users can't add a resolver without forking GBrain

### 3.2 Interface

```typescript
// src/core/resolvers/interface.ts

export type ResolverCost = 'free' | 'rate-limited' | 'paid';

export interface ResolverRequest<I> {
  input: I;
  context: ResolverContext;
  timeoutMs?: number;
}

export interface ResolverResult<O> {
  value: O;
  confidence: number;      // 0.0–1.0; 1.0 = deterministic from ground-truth API
  source: string;          // e.g. "x-api-v2", "perplexity-sonar", "brain-local"
  fetchedAt: Date;
  costEstimate?: number;   // dollars; 0 if free
  raw?: unknown;           // for sidecar preservation via put_raw_data
}

export interface Resolver<I, O> {
  readonly id: string;           // stable, slug-like: "x_handle_to_tweet"
  readonly cost: ResolverCost;
  readonly backend: string;      // "x-api-v2", "perplexity", "brain-local"
  readonly inputSchema: JSONSchema;
  readonly outputSchema: JSONSchema;

  available(ctx: ResolverContext): Promise<boolean>;
  resolve(req: ResolverRequest<I>): Promise<ResolverResult<O>>;
}
```

### 3.3 Context

```typescript
export interface ResolverContext {
  engine: BrainEngine;
  storage: StorageBackend;
  config: GBrainConfig;
  logger: Logger;
  metrics: MetricsRecorder;
  budget: BudgetLedger;       // hard spend caps, queried pre-resolve
  requestId: string;
  remote: boolean;            // trust boundary — untrusted callers get stricter validation
  deadline?: Date;
}
```

### 3.4 Registry + Factory (mirrors `src/core/storage.ts`)

```typescript
// src/core/resolvers/registry.ts
export class ResolverRegistry {
  register<I, O>(r: Resolver<I, O>): void;
  get(id: string): Resolver<unknown, unknown>;
  list(filter?: { cost?: ResolverCost; backend?: string }): Resolver[];
  async resolve<I, O>(id: string, input: I, ctx: ResolverContext): Promise<ResolverResult<O>>;
}

// src/core/resolvers/factory.ts (dynamic import like engine-factory)
export async function createResolver(
  type: 'x-api' | 'perplexity' | 'mistral-ocr' | 'brain-local' | 'plugin',
  config: ResolverConfig,
): Promise<Resolver>;
```

### 3.5 Plugin format (unifies `recipes/` + `data-research` formats)

A plugin is YAML + JS module, discovered via filesystem scan of `~/.gbrain/resolvers/` and `recipes/`.

```yaml
# Example: resolvers/x-api/handle-to-tweet.yaml
id: x_handle_to_tweet
version: 1
category: lookup
cost: rate-limited
backend: x-api-v2
module: ./handle-to-tweet.ts
input_schema:
  type: object
  properties:
    handle:   { type: string, pattern: "^[A-Za-z0-9_]{1,15}$" }
    keywords: { type: string }
  required: [handle]
output_schema:
  type: object
  properties:
    url:        { type: string, format: uri }
    tweet_id:   { type: string }
    text:       { type: string }
    created_at: { type: string, format: date-time }
requires:
  env: [X_API_BEARER_TOKEN]
health_check:
  kind: http
  url: https://api.twitter.com/2/tweets/1
  expect: { status: [200, 401] }   # 401 = auth failure but endpoint reachable
tests:
  - input:  { handle: "garrytan" }
    expect: { url: { pattern: "^https://x\\.com/garrytan/status/\\d+$" } }
```

Trust flagging follows the existing `src/commands/integrations.ts` pattern: only package-bundled resolvers are `embedded=true` and may run arbitrary commands; user-provided resolvers are restricted to `http` and validated schemas.

### 3.6 Wraps every resolver with `FailImproveLoop`

Existing `src/core/fail-improve.ts` is the deterministic-first/LLM-fallback pattern. Every resolver automatically gets wrapped: if the deterministic path (e.g. X API) returns a valid result, use it; if it fails, optionally fall back to an LLM-based resolver; log both paths for future pattern analysis and auto-test generation.

### 3.7 Reference implementations to ship

The OpenClaw survey inventoried 69 resolver shapes. Shipping all of them is wrong (over-scoped); shipping zero is under-scoped. The dogfood set:

| # | Resolver | Purpose | Used by |
|---|---|---|---|
| 1 | `x_handle_to_tweet` | Bare-tweet citation repair (original Phase A) | `gbrain integrity` |
| 2 | `url_reachable` | Dead-link detection | `gbrain integrity` |
| 3 | `brain_slug_lookup` | Name/email → slug (wraps existing `resolveSlugs`) | Output Builder |
| 4 | `openai_embedding` | Refactor of `src/core/embedding.ts` into Resolver | Import pipeline |
| 5 | `perplexity_query` | Query → synthesis + citations | Enrichment Orchestrator |
| 6 | `text_to_entities` | LLM entity extraction (structured JSON) | Enrichment Orchestrator |

The remaining 63 OpenClaw patterns port incrementally, driven by user need. Each port is a new YAML + module under `recipes/` or `~/.gbrain/resolvers/` with no framework changes.

---

## 4. Layer 2 — Enrichment Orchestrator

### 4.1 What's broken today

Garry's OpenClaw's enrichment is **polished at the data layer, hacky at the control layer**:

- **Completeness = "length > 500 chars + no `needs-enrichment` tag"** (`lib/enrich.mjs:351-355`). Naïve. A rich page of repetitive Perplexity summaries (see `brain/people/0interestrates.md` — 38 repeating blocks) passes this check.
- **30-day auto-re-enrichment** runs forever. No "done" state. A person met once in 2023 still gets re-researched monthly.
- **Cascade is convention-only.** Person→company stubs are created automatically; company→investors, company→employees traversals are documented but never implemented.
- **No hard budget cap.** Cost is estimated per batch, never enforced across batches or per day.
- **Failure is silent.** A bad Perplexity response logs and continues; partial writes can leave a page with a timeline entry but no raw-data sidecar.

### 4.2 The orchestrator

```typescript
// src/core/enrichment/orchestrator.ts

export interface EnrichmentRequest {
  entitySlug: string;
  trigger: 'mention' | 'stub-creation' | 'cron-sweep' | 'manual' | 'cascade';
  tier?: 1 | 2 | 3;                // optional override; auto-computed if absent
  cascadeDepth?: number;           // 0 = no cascade; default 1
}

export interface EnrichmentResult {
  entitySlug: string;
  completenessBefore: number;
  completenessAfter: number;
  resolversUsed: string[];         // e.g. ["perplexity_query", "x_handle_to_tweet"]
  costSpent: number;
  writtenTo: string[];             // page paths touched, for transaction audit
  cascadedTo: string[];            // related entities enriched
  status: 'enriched' | 'skipped' | 'failed' | 'budget-exhausted';
  reason?: string;
}

export class EnrichmentOrchestrator {
  constructor(
    private registry: ResolverRegistry,
    private writer: BrainWriter,
    private budget: BudgetLedger,
    private scorer: CompletenessScorer,
    private graph: EntityGraph,
  ) {}

  async enrich(req: EnrichmentRequest): Promise<EnrichmentResult>;
  async enrichBatch(reqs: EnrichmentRequest[]): Promise<EnrichmentResult[]>;
}
```

### 4.3 Evidence-weighted completeness (replaces length heuristic)

Completeness is a per-entity-type rubric, stored in frontmatter on write and recomputed on demand.

```typescript
// src/core/enrichment/completeness.ts
export interface CompletenessRubric<Page> {
  entityType: PageType;
  dimensions: {
    name: string;
    weight: number;                // sum must = 1.0
    check: (page: Page) => number; // 0.0–1.0
  }[];
}

// Example rubric for persons:
//   - has_role_and_company   0.20
//   - has_source_urls        0.20  (≥1 URL with resolver-verified reachability)
//   - has_timeline_entries   0.15  (≥1)
//   - has_citations          0.15  (every claim has [Source: ...])
//   - has_backlinks          0.10  (every linked page links back)
//   - recency_score          0.10  (last_verified within 90 days)
//   - non_redundancy         0.10  (no repeated blocks; distinct-lines/total-lines > 0.8)
```

**Key property:** `non_redundancy` + `recency_score` explicitly kill the two brain pathologies observed in the audit (Wilco-style repeating blocks; stale pages without `last_verified`).

The `completeness` field goes in frontmatter as `0.0–1.0`. It becomes queryable via `list_pages(where: completeness < 0.5)`.

### 4.4 Tier routing with hard budget

Two-dimensional routing: **importance** (tier 1/2/3 from person-score) × **budget state**.

```typescript
// src/core/enrichment/tiers.ts
export const TIER_CONFIG = {
  1: { models: ['opus', 'sonar-deep'], maxCostUsd: 0.10, cascadeDepth: 2 },
  2: { models: ['sonar'],              maxCostUsd: 0.02, cascadeDepth: 1 },
  3: { models: ['sonar'],              maxCostUsd: 0.005, cascadeDepth: 0 },
};

// src/core/enrichment/budget.ts
export class BudgetLedger {
  // Hard caps. Queryable pre-resolve.
  dailyCapUsd: number;
  perEntityCapUsd: number;
  perResolverCapUsd: Map<string, number>;

  async reserve(resolverId: string, estimateUsd: number): Promise<Reservation | 'exhausted'>;
  async commit(reservation: Reservation, actualUsd: number): Promise<void>;
  async rollback(reservation: Reservation): Promise<void>;
  async state(): Promise<{ spent: number; remaining: number; perResolver: Record<string, number> }>;
}
```

**Property:** if the daily cap is reached, `orchestrator.enrich()` returns `status: 'budget-exhausted'` immediately. No silent overages. Circuit-breaker resets at midnight in the user's configured TZ.

### 4.5 Cascade (entity graph traversal)

```typescript
// src/core/enrichment/cascade.ts
export class EntityGraph {
  // Deterministic, no LLM. Uses engine.getLinks() + engine.getBacklinks().
  async neighbors(slug: string, depth: number): Promise<string[]>;
  async cascadeFrom(trigger: string, depth: number): Promise<EnrichmentRequest[]>;
}
```

If person X is enriched and gains a new `company: Acme` field, cascade checks: does `companies/acme` exist? If not, create stub + enqueue at tier 2. Does `companies/acme` link back to X? If not, write the back-link. **Iron Law is machine-enforced, not skill-enforced.**

### 4.6 Fail-safe transactions

Every enrichment is wrapped in a BrainWriter transaction (Layer 4). Partial writes are rolled back. No asymmetric state like timeline-entry-without-raw-sidecar.

```typescript
await writer.transaction(async (tx) => {
  const research = await registry.resolve('perplexity_query', {...}, ctx);
  await tx.appendTimeline(slug, {...});
  await tx.putRawData(slug, 'perplexity', research.raw);
  await tx.setFrontmatterField(slug, 'completeness', score);
  // All-or-nothing commit on exit.
});
```

---

## 5. Layer 3 — Scheduler

### 5.1 What's broken today

Garry's OpenClaw's cron is **externally-driven JSON** (`cron/jobs.json`) with ~30 jobs manually stagger-offset at different minutes. GBrain has **zero native scheduling** — `src/commands/autopilot.ts` is a single daemon loop, and `docs/guides/cron-schedule.md` is architectural guidance, not code.

Failures observed in Garry's OpenClaw's actual state:
- `X OAuth2 Token Refresh`: 11 consecutive timeouts (critical-path silent failure)
- `flight-tracker daily scan`: 5 consecutive timeouts
- `morning-briefing`: 4 consecutive timeouts
- Quiet hours are checked at runtime in skills, so a skill that forgets to check will DM at 3 a.m.
- Staggering is manual convention; no protection against two jobs colliding after a config edit.

### 5.2 ScheduledResolver interface

```typescript
// src/core/scheduling/scheduler.ts
export interface Schedule {
  kind: 'cron' | 'interval';
  expr?: string;                    // cron string
  intervalMs?: number;
  tz: string;                       // IANA: "America/Los_Angeles"
  quietHours?: {
    startHour: number;              // 22 = 10 PM local
    endHour: number;                // 7 = 7 AM local
    policy: 'skip' | 'defer' | 'silent-run';
  };
  staggerKey?: string;              // jobs with same key auto-offset
  maxConcurrent?: number;           // global concurrency cap
  maxDurationMs?: number;           // timeout
}

export interface ScheduledResolver extends Resolver<void, ScheduledResult> {
  schedule: Schedule;
  retryPolicy: { maxRetries: number; backoffMs: number };
  circuitBreaker: { failureThreshold: number; cooldownMs: number };
  state: DurableState;              // watermark, content-hash, idempotency key
}
```

### 5.3 Enforcement vs convention (the key delta from Garry's OpenClaw)

| Concern | Garry's OpenClaw today | Knowledge Runtime |
|---|---|---|
| Quiet hours | Checked inside each skill (trust-based) | Enforced at scheduler, skill cannot override |
| Staggering | Manual minute-offset in `jobs.json` | Scheduler assigns slots via hashed staggerKey |
| Concurrency | `MAX_BATCH_PROCESSES=2` in backoff, ignored by cron | Global semaphore in scheduler |
| Timeout | Per-job string in JSON, not always respected | Enforced via `AbortController`, timeout raises `TimeoutError` caught by orchestrator |
| Retry | None at cron level | `retryPolicy` with exponential backoff |
| Silent failure | "11 consecutive timeouts" unnoticed | Circuit breaker opens at threshold → escalation to user |
| Idempotency | State files per job, no framework | `DurableState` primitive: watermark/ID/content-hash |

### 5.4 Native engine + OS cron adapter

The scheduler runs as either:
1. **Embedded** (default for `gbrain autopilot`): native event loop inside the daemon process. One process, many ScheduledResolvers.
2. **OS-driven** (for Railway/launchd/systemd): `gbrain schedule run <id>` invoked by OS cron, scheduler state is durable so cross-invocation dedup still works.

Both modes share the same `Schedule` config + state.

### 5.5 Observability

Every scheduled run emits structured events: `started`, `skipped-quiet-hours`, `deferred-to-active-hours`, `failed-retrying`, `circuit-opened`, `completed`. Events go to:
- `~/.gbrain/scheduler/events.jsonl` (local, always)
- `engine.logIngest` (audit trail in brain DB)
- Optional webhook (Slack/Telegram for the user)

`gbrain doctor` reads the event log and reports: current circuit-breaker state, any resolver with > 3 consecutive failures, any resolver that hasn't fired within 3× its interval (freshness SLA like Garry's OpenClaw's `freshness-check.mjs` but built-in).

---

## 6. Layer 4 — Deterministic Output Builder

### 6.1 The anti-hallucination invariant

**Iron Law: LLM picks WHAT. Code guarantees WHERE and HOW.**

Garry's OpenClaw's existing `lib/enrich.mjs:buildTweetEntry` is close to this — tweet URLs are built from `tweet.id` returned by the X API, never from LLM memory. But:

- A past incident: *"Sub-agent test #2 FAILED — hallucinated 'Philip Leung' entity links across all daily files. LLM rewriting of daily files is too error-prone."* (Garry's OpenClaw memory log, 2026-04-13.)
- Back-links depend on `appendTimeline` being called everywhere; skips are silent.
- Slug collisions are unchecked (no conflict detection on `slugify`).
- Citation format is post-hoc linted weekly, not pre-write enforced.

### 6.2 BrainWriter

```typescript
// src/core/output/writer.ts
export class BrainWriter {
  constructor(
    private engine: BrainEngine,
    private slugRegistry: SlugRegistry,
    private scaffolder: Scaffolder,
  ) {}

  async transaction<T>(fn: (tx: WriteTx) => Promise<T>): Promise<T>;
}

export interface WriteTx {
  // High-level typed operations; never raw string writes.
  createEntity(input: EntityInput): Promise<string>;          // returns slug, conflict-checked
  appendTimeline(slug: string, entry: TimelineInput): Promise<void>;
  setCompiledTruth(slug: string, body: CompiledTruthInput): Promise<void>;
  setFrontmatterField(slug: string, key: string, value: unknown): Promise<void>;
  putRawData(slug: string, source: string, data: object): Promise<void>;
  addLink(from: string, to: string, context: string): Promise<void>;  // auto-creates reverse back-link

  // Validators (called implicitly on commit)
  validate(): Promise<ValidationReport>;
}
```

### 6.3 Scaffolder — deterministic link + citation construction

Every user-visible URL/link/citation is built by code from resolver outputs, not from LLM text.

```typescript
// src/core/output/scaffold.ts
export class Scaffolder {
  tweetCitation(handle: string, tweetId: string, dateISO: string): string {
    // "[Source: [X/garrytan, 2026-04-18](https://x.com/garrytan/status/123456)]"
  }
  emailCitation(account: string, messageId: string, subject: string): string {
    // deterministic Gmail URL per OpenClaw pattern
  }
  sourceCitation(resolverResult: ResolverResult<unknown>): string {
    // pulls .source, .fetchedAt, .raw from the result
  }
  entityLink(slug: string): string {
    // slugRegistry checks existence; returns resolvable wikilink
  }
}
```

### 6.4 SlugRegistry — conflict detection

```typescript
// src/core/output/slug-registry.ts
export class SlugRegistry {
  async create(desiredSlug: string, displayName: string, type: PageType): Promise<CreatedSlug>;
  // Throws SlugCollision if another entity already occupies desiredSlug and isn't
  // confirmed as the same person (via email / x_handle / disambiguator).
  // Auto-resolves near-collisions by appending disambiguator.

  async confirmSame(slugA: string, slugB: string, confidence: number): Promise<void>;
  async merge(canonical: string, duplicate: string): Promise<void>;
}
```

### 6.5 Pre-write validators (fail-closed for integrity)

On `WriteTx.validate()` before commit:

1. **Citation validator.** Every factual sentence in `compiled_truth` must have an inline `[Source: ...]` within N lines. Non-compliant paragraphs are flagged. Configurable: strict-mode rejects the transaction, lint-mode warns.
2. **Link validator.** Every `[text](path)` must point to a page that exists OR to a URL the Scaffolder built (so it's guaranteed-valid). No raw LLM-composed URLs.
3. **Back-link validator.** Every outbound link must have a reverse link written in the same transaction.
4. **Triple-HR validator.** Compiled truth / timeline split enforced at the schema level.

**Fails closed**: the default is strict-mode. Loosening requires explicit `writer.transaction({ strictMode: false }, ...)` and logs a warning to the ingest log.

### 6.6 LLM output sanitization

Any LLM output destined for a brain page passes through a JSON-Schema-validated parser first. No free-form markdown goes to disk.

- Entity extraction: JSON array of `{ name, type, context }` per existing `extractEntities` pattern — strict validation.
- Compiled-truth synthesis: LLM emits structured `{ sections: [{heading, paragraphs: [{text, sources: [...]}]}]}`, scaffolder renders to markdown.
- Timeline entries: LLM emits `{ date, summary, detail, sources }`, scaffolder renders.

LLM never sees file paths, never writes files, never emits finished markdown.

---

## 7. Integration with existing GBrain

### 7.1 Reuse (already polished)

| Existing | Used by | Change |
|---|---|---|
| `src/core/fail-improve.ts` (9/10) | Wraps every Resolver in L1 | None; becomes default wrapper |
| `src/core/backoff.ts` (9/10) | ResolverContext.backoff | None |
| `src/core/storage.ts` (9/10) | Template for Resolver factory pattern | None; serves as pattern reference |
| `src/core/check-resolvable.ts` (9/10) | Extend to validate Resolver plugins | Add `checkResolvers()` mode |
| `src/commands/publish.ts` (9/10) | Uses BrainWriter under the hood | Minor: route through L4 |
| `src/commands/backlinks.ts` (8/10) | Folded into L4 validator | Keep as CLI-facing lint entry point |
| `src/core/operations.ts` validators | Reused in ResolverContext trust enforcement | None |
| `src/core/engine.ts` BrainEngine (35 methods) | ResolverContext.engine | Extend with `getResolverRegistry()` |

### 7.2 Replace (ad-hoc today)

| Existing | Replace with |
|---|---|
| `src/core/enrichment-service.ts` (5/10) | `src/core/enrichment/orchestrator.ts` (L2) |
| `src/core/embedding.ts` (monolithic) | `src/core/resolvers/builtin/embedding/openai.ts` |
| `src/core/transcription.ts` (monolithic) | `src/core/resolvers/builtin/transcription/{groq,openai}.ts` |
| `src/commands/integrations.ts` recipe format | Unified Resolver plugin format (§3.5) |
| `src/core/data-research.ts` recipe format | Same unified format |
| `src/commands/autopilot.ts` hard-coded daemon loop | Wraps a set of ScheduledResolvers |

### 7.3 Extend

- `src/core/engine.ts`: add `getResolverRegistry()`, `getWriter()`, `getScheduler()`. Engine becomes the runtime's root container.
- `src/core/operations.ts`: `OperationContext` inherits from `ResolverContext` (or vice-versa). Trust flags unified.
- `src/core/types.ts`: add `completeness: number` to `Page`, `sourcedBy: string[]` for provenance.

---

## 8. Migration Path (phased, shippable)

Each phase ships independently, passes full E2E, is feature-flagged, and is reversible. No big-bang.

### Phase 0 — Foundation (human: ~1 wk / CC: ~4 h)
- Define `Resolver<I,O>`, `ResolverContext`, `ResolverRegistry`, `ResolverResult` (§3.2–3.4).
- Add `src/core/resolvers/index.ts` wiring + tests for registry (register/get/list).
- No behavioral change; ship as `v0.11.0-alpha` with feature flag.

### Phase 1 — Three reference resolvers (human: ~1 wk / CC: ~4 h)
- Port `src/core/embedding.ts` → `resolvers/builtin/embedding/openai.ts`.
- Implement `resolvers/builtin/brain-local/slug-lookup.ts` (wraps `engine.resolveSlugs`).
- Implement `resolvers/builtin/url-reachable.ts` (HEAD-check).
- Prove the interface: old callers swap to `registry.resolve('openai_embedding', ...)`.

### Phase 2 — BrainWriter + Slug Registry (human: ~1.5 wk / CC: ~6 h)
- L4 core: `BrainWriter.transaction`, `Scaffolder`, `SlugRegistry` with conflict detection.
- Pre-write validators: citation, link, back-link, triple-HR.
- Migrate `src/commands/publish.ts` + `src/commands/backlinks.ts` to route through BrainWriter.
- **Now** Garry's OpenClaw's "Philip Leung" hallucination is structurally impossible — LLM output passes through JSON-Schema validator before reaching Scaffolder.

### Phase 3 — `gbrain integrity` command (human: ~0.5 wk / CC: ~2 h)
- Ship the originally-scoped user-facing feature on top of the new foundation.
- Uses Resolver SDK: `x_handle_to_tweet` + `url_reachable`.
- Uses BrainWriter: all auto-repairs go through validated writes.
- `--auto --confidence 0.8` mode as user approved in cherry-pick #1.
- **User-visible value ships in Phase 3, not Phase 7.**

### Phase 4 — Enrichment Orchestrator (human: ~2 wk / CC: ~8 h)
- L2 core: `EnrichmentOrchestrator`, `BudgetLedger`, `CompletenessScorer`, `EntityGraph.cascadeFrom`.
- Migrate `src/core/enrichment-service.ts` callers (deprecate the old file after).
- Completeness score in frontmatter on every write (dogfooding cascades).

### Phase 5 — Scheduler (human: ~2 wk / CC: ~8 h)
- L3 core: `Scheduler`, `ScheduledResolver`, `DurableState`, circuit breaker, quiet-hours enforcer.
- Migrate `src/commands/autopilot.ts` to a ScheduledResolver set.
- Ship `gbrain schedule list|run|pause|tail` CLI for observability.

### Phase 6 — Port 5–8 OpenClaw resolvers (human: ~1.5 wk / CC: ~6 h)
- `perplexity_query`, `text_to_entities`, `mistral_ocr_pdf`, `x_search_all`, `x_user_to_tweets`, `gmail_query_to_threads`, `calendar_date_to_events`.
- Each ships as YAML + TS module under `resolvers/builtin/` — **proof of the plugin format.**

### Phase 7 — OpenClaw Adoption Integration (human: ~1 wk / CC: ~4 h)
- Write `docs/openclaw/ADOPTION.md` showing your OpenClaw how to replace its 69 bespoke scripts with calls to `gbrain registry.resolve(...)`.
- Ship a `gbrain claw-bridge` subcommand that proxies Garry's OpenClaw's current script invocations to the resolver registry — zero-edit adoption path.
- **This is the test of the north star.** If your OpenClaw can stand up a 1-line shim and drop `scripts/x-api-client.mjs`, the abstraction succeeded.

Total: human: ~10 weeks / CC: ~42 hours / calendar with single implementer: ~3–4 weeks.

---

## 9. Critical Files

### New directories / files

```
src/core/
  runtime/
    index.ts                       # RuntimeContext (engine, storage, config, logger, metrics, budget)
    registry.ts                    # ResolverRegistry
    factory.ts                     # createResolver()
  resolvers/
    interface.ts                   # Resolver<I, O>
    fail-improve-wrapper.ts        # auto-wraps every resolver in FailImproveLoop
    builtin/
      x-api/
        handle-to-tweet.ts
        handle-to-tweet.yaml
      perplexity/
        query.ts
        query.yaml
      brain-local/
        slug-lookup.ts
        url-reachable.ts
      embedding/
        openai.ts                  # refactored from src/core/embedding.ts
      transcription/
        groq.ts
        openai.ts
  enrichment/
    orchestrator.ts                # EnrichmentOrchestrator
    tiers.ts                       # TIER_CONFIG
    budget.ts                      # BudgetLedger
    completeness.ts                # CompletenessScorer + per-type rubrics
    cascade.ts                     # EntityGraph
  scheduling/
    scheduler.ts                   # Scheduler + ScheduledResolver
    schedule.ts                    # Schedule type, cron expr parser
    state.ts                       # DurableState primitives
    quiet-hours.ts                 # TZ-aware enforcement
    stagger.ts                     # deterministic slot assignment
  output/
    writer.ts                      # BrainWriter
    scaffold.ts                    # Scaffolder (typed URL builders)
    slug-registry.ts               # SlugRegistry (conflict detection)
    validators/
      citation.ts
      link.ts
      back-link.ts
      triple-hr.ts

src/commands/
  integrity.ts                     # ships in Phase 3, replaces Feynman Phase A/B
  schedule.ts                      # gbrain schedule list|run|pause|tail (Phase 5)

docs/openclaw/
  ADOPTION.md                      # written in Phase 7
```

### Replaced / removed
- `src/core/enrichment-service.ts` — folded into `enrichment/orchestrator.ts`
- `src/core/embedding.ts` — moved into `resolvers/builtin/embedding/openai.ts`
- `src/core/transcription.ts` — moved into `resolvers/builtin/transcription/`

### Extended
- `src/core/engine.ts` — add `getResolverRegistry()`, `getWriter()`, `getScheduler()`
- `src/core/operations.ts` — unify with ResolverContext; every operation validator reusable by resolvers
- `src/core/types.ts` — add `completeness: number`, `sourcedBy: string[]`, `lastVerified: Date`

---

## 10. Testing Strategy

### Contract tests
Every Resolver implementation tested against the interface spec. Table-driven: run the same suite against `openai_embedding`, `x_handle_to_tweet`, etc. Ensures plugin authors can't ship broken resolvers.

### Property tests
- **Idempotency:** running a ScheduledResolver twice with the same state produces the same output and doesn't double-write.
- **Atomicity:** a BrainWriter transaction that throws mid-flight leaves the brain bit-for-bit identical to pre-transaction.
- **Deterministic scaffolds:** given the same resolver outputs, the Scaffolder produces byte-identical citations/links.

### Integration tests
- `EnrichmentOrchestrator` end-to-end against PGLite (in-memory, no API keys) with mocked resolver registry.
- `Scheduler` with fake clock + quiet-hours scenarios.
- BrainWriter transaction rollback on validator failure.

### Chaos tests
- Kill the process mid-enrichment; next run must resume cleanly.
- Simulate API timeout mid-transaction; transaction must roll back completely.
- Corrupted state file; scheduler must escalate, not silently skip.

### Regression tests vs. Garry's OpenClaw behavior
For each OpenClaw pattern we port (e.g. X-handle → tweet URL), a regression test proves the new resolver produces the same answer on real-world inputs from the brain audit. This is the "your OpenClaw would adopt" proof.

---

## 11. Open Questions (flagged for CEO re-review)

1. **Scope shape.** Is this the right four-layer decomposition, or are some layers better left to OpenClaw (e.g. Scheduling lives above GBrain, not in it)?
2. **Phase 3 user-value break.** Does Phase 3 (user-visible `gbrain integrity`) ship early enough, or do we need an even smaller MVP?
3. **LLM-as-resolver.** Should `text_to_entities` be a Resolver, or does that blur the "code vs LLM" line the invariant relies on?
4. **Plugin format.** YAML + TS module (§3.5) vs. pure TS module with decorator-style metadata. Latter is more type-safe; former is more discoverable.
5. **Cross-resolver transactions.** Do we support "atomic fetch-from-Perplexity + write-to-brain" at the L2 layer? Current design says yes; implementation is tricky (Perplexity call isn't rollbackable).
6. **OpenClaw bridge scope.** Phase 7 `gbrain claw-bridge` — is that worth a phase of its own, or should adoption be documentation-only?
7. **Completeness rubric coverage.** Do we define rubrics for all 9 PageTypes upfront, or ship people/company/meeting first and extend incrementally?
8. **Budget config UX.** Hard daily cap is strict; should we also expose a soft-cap warning mode, and how is the cap set (env var? config file? prompt on first use?)
9. **Backwards compat.** `src/commands/publish.ts` and `src/commands/backlinks.ts` have been running cleanly for weeks. Refactoring through BrainWriter carries migration risk. Acceptable?
10. **Existing TODOS alignment.** `TODOS.md` has P0 "Runtime MCP access control" and P2 security hardening. The new RuntimeContext.remote flag interacts with both — do we fold MCP access control into Phase 0 or keep separate?

---

## 12. Verification (the "your OpenClaw would adopt" test)

The design succeeds iff:

- [ ] A user can add a new resolver by dropping a YAML + TS module in `~/.gbrain/resolvers/` without editing GBrain source.
- [ ] Your OpenClaw can delete `scripts/x-api-client.mjs` and replace all callers with 1-line `await registry.resolve('x_handle_to_tweet', ...)`.
- [ ] No brain page can be written with a bare tweet reference, a missing back-link, or an unverified URL (validators catch it pre-commit).
- [ ] Running `gbrain integrity --auto --confidence 0.8` over a real brain fixes ≥1,000 of the 1,424 known bare-tweet citations without human review.
- [ ] Full E2E test suite passes on both PGLite + Postgres engines.
- [ ] The Knowledge Runtime ships across 7 phases with each phase individually shippable and reversible.
