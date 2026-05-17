# TODOS


## dreamy-thompson wave follow-ups (v0.36.x)

- [ ] **v0.36.x: runThink full rewrite — drop ThinkLLMClient indirection.** v0.36's fix(think) wave landed a gateway-backed adapter at `src/core/think/index.ts:225-251` so `gbrain config set anthropic_api_key` works over MCP stdio (closed #952). The adapter routes through `gateway.chat()` but `runThink` still carries the `ThinkLLMClient` interface as the test seam — it's the last LLM-using path that doesn't use the canonical `__setChatTransportForTests` seam v0.31.12 established for chat/embed. Cleanup: drop `ThinkLLMClient`, drop the `opts.client` injection point, migrate the 12+ existing tests (`test/think-pipeline.serial.test.ts:144,181,222`, `test/think-gateway-adapter.test.ts`, plus 9+ others that stub the interface) to `__setChatTransportForTests`. Pros: codebase consistency, one fewer test-stub pattern, easier to add provider switching for think once it routes through gateway natively. Cons: 12+ test files need migration. Blocked by: v0.36 wave landing on master (so the adapter exists to lean on while migrating tests). Plan reference: D5 + D7 in `~/.claude/plans/ok-i-spun-up-dreamy-thompson.md`.

- [ ] **v0.36.x: Supabase parity test fixture for `applyForwardReferenceBootstrap`.** v0.36 fixed the underlying bug (bootstrap now uses the DDL connection from `initSchema` so probes run inside the advisory-lock scope) per codex P1 from /ship adversarial review. What remains is the TEST FIXTURE that proves it: the new pre-v18/pre-v34/pre-v60 E2E tests run against local Docker Postgres but not against Supabase-shape pooler topology (transaction pooler + statement_timeout). Real Supabase upgrades have failed multiple times on this exact connection-topology divergence (#699, #820 lineage). Fix: a test fixture that exercises the probe path against deriveDirectUrl + transaction pooler + statement_timeout. Cons: requires Supabase fixture infra OR careful mocking of the connection-selection logic in `db.ts`'s `getDDLConnection` path.


## kinshasa-v3 follow-ups (v0.35.4.0)

- [ ] **v0.36.x: Fix `supervisor-audit.ts:77` `readSupervisorEvents` to use the dual-week-aware pattern from `stub-guard-audit.ts:readRecentStubGuardEvents`.** The supervisor reader only reads the current ISO-week file, so a 24h sliding window across Monday 00:00 UTC silently loses Sunday's events (they're in last week's file). The new stub-guard reader in v0.35.4.0 fixes this for its own audit log by reading BOTH current and previous week files before timestamp-filtering — the supervisor reader should adopt the same shape. Pin with a unit test that uses a fake-clock fixture set to "Monday 00:01 UTC" with a Sunday 23:55 event in the prior file. Filed during v0.35.4.0 kinshasa-v3 codex outside-voice review.

- [ ] **v0.36.x: Decommission the stub-guard at `fence-write.ts:190` once the sunset criterion holds.** The guard's purpose is defense-in-depth behind the resolver's prefix-expansion fix. Sunset rule: when `stub_guard_24h` reads <5 hits/week for 3 consecutive weeks across production brains, the prefix-expansion is doing its job and the guard can be removed. The JSDoc names v0.36 as the target — re-check this against actual operator-brain data when planning v0.36.

- [ ] **v0.36.x: `PREFIX_EXPANSION_DIRS` is hardcoded to `['people', 'companies']` in `src/core/entities/resolve.ts:97`.** New entity directories (funds, advisors, deals, etc.) require a code change to opt in. Consider a config-driven list (`entities.prefix_expansion_dirs: [...]` in `gbrain.yml`) so operators can extend without forking. Filed during v0.35.4.0 plan-eng-review.

- [ ] **v0.36.x: Sweep the banned private-agent-name references out of `CHANGELOG.md`.** Three pre-existing lines in `CHANGELOG.md` (around lines 2537, 2606, 3304) reference the name that `scripts/check-privacy.sh` enforces against. Pre-existing on master, not introduced by v0.35.4.0; `CHANGELOG.md` is on the script's allow-list so master CI is green, but they still violate the spirit of CLAUDE.md's privacy rule (the allow-list is a meta-documentation exception, not a license to add new references). Replace with `your OpenClaw` or `Garry's OpenClaw` per the script's own suggestion text. Trivial cleanup PR. Filed during v0.35.4.0 privacy audit.


## embed --stale follow-ups (v0.34.4.0)

- [ ] **v0.35.x: Concurrent NULL→non-NULL upsert race in `embed.ts:429-443` + `postgres-engine.ts:1231`'s `COALESCE(EXCLUDED.embedding, content_chunks.embedding)`.** Two `embed --stale` workers (or `embed --stale` racing with a sync that re-embeds the same chunk) can have the slower writer overwrite the faster one's fresher embedding. Window is small (20 workers, all from the same `listStaleChunks` snapshot) but exists. Tractable fix: a `WHERE content_chunks.embedded_at < EXCLUDED.embedded_at OR content_chunks.embedding IS NULL` predicate on the upsert. Out of scope for v0.34.4.0 because the upsert is not in the diff; pre-existing bug. Filed during v0.34.4.0 codex outside-voice review.

- [ ] **v0.35.x: New stale rows inserted behind the keyset cursor.** A sync or `gbrain put_page` mid-`embed --stale` creates chunks with `embedding IS NULL` at `(page_id, chunk_index)` already passed by the cursor. Picked up on next run via the partial index; documented limitation. Possible fix: a second pass at end-of-run that does a fresh `countStaleChunks()` and re-enters the loop while count > 0 and budget allows. Filed during v0.34.4.0 codex outside-voice review.

## MCP fix wave follow-ups (v0.34.1)

- [ ] **v0.34.x: Source-scope `takes_*` ops (pre-existing leak surfaced during v0.34.1 adversarial review).** `takes_list`, `takes_search`, `takes_scorecard`, `takes_calibration` in `src/core/operations.ts:1248-1335` thread `ctx.takesHoldersAllowList` but never `ctx.sourceId`. An auth'd OAuth client scoped to `source_id='canon-a'` can call `takes_list --page_slug=foo` (slug in `canon-b`) and read takes attached to foreign-source pages. Pre-existing, not introduced by v0.34.1, but the wave was framed as "P0 source-isolation seal on the read path" and `takes_*` surfaces were missed. Fix: extend `TakesListOpts` in `src/core/engine.ts:186` with `sourceId?: string` + `sourceIds?: string[]`; thread `sourceScopeOpts(ctx)` at each op handler; engine `listTakes`/`searchTakes` filter via the `pages` JOIN.

- [ ] **v0.34.x: Extend `sourceScopeOpts(ctx)` to the 14 read-side ops PR #861 didn't touch.** `get_page`, `get_tags`, `get_links`, `get_backlinks`, `get_timeline`, `list_files`, `get_file`, and the four `takes_*` ops (above) still use the v0.31.8-era `const sourceOpts = ctx.sourceId ? { sourceId: ctx.sourceId } : {}` pattern. NOT a leak (scalar `ctx.sourceId` IS threaded), but federated_read (#876, `ctx.auth?.allowedSources`) is silently dropped. A "WeCare L3 dept" client gets correct federated results from `search`/`query`/`list_pages`/`traverse_graph`/`find_experts` but only sees its scalar `source_id` for `get_page`/`get_tags`/etc. Fix: route all 14 sites through `sourceScopeOpts(ctx)`.

- [ ] **v0.34.x: Migration v60 idempotency guard against `--force-retry` race with v64.** `gbrain apply-migrations --force-retry 58` after v64 has already run will re-install the FK with `ON DELETE SET NULL`, silently downgrading the v64 RESTRICT posture. Probability low (operator has to explicitly force-retry 58) but failure mode is invisible. Fix: v60 should probe `pg_constraint.confdeltype` before re-adding and refuse to clobber `'r'` (RESTRICT) with `'n'` (SET NULL).

- [ ] **v0.34.x: `embedMultimodalOpenAICompat` batching + partial-failure handling.** `src/core/ai/gateway.ts:1180-1255` sends one HTTP request per input. Multi-input callers (10 images) get 10 sequential round-trips with no parallelism; a 401 on input #5 throws and discards inputs #1-#4's already-computed embeddings (wasted spend, no surfacing of the partial array). Voyage's existing path batches. Fix: batch via the provider's `input: [...]` array shape; on partial failure, return successful embeddings + failed-index array.

- [ ] **v0.34.x: Doctor check `oauth_orphan_source_id`** — surfaces OAuth clients whose source_id was nulled by the v60 D10 silent-widen path (`GBRAIN_ACCEPT_SILENT_WIDEN=1`). Closes the observability gap from v0.34.1's D4 decision. Sibling to the `rls_event_trigger` check pattern in `src/commands/doctor.ts`.

- [ ] **v0.34.x: `gbrain sources purge` FK error UX.** Post-v0.34, deleting a source is refused if any oauth_client references it (v64 ON DELETE RESTRICT). The CLI currently surfaces the raw Postgres FK violation. Fix: pre-check via `SELECT client_id, client_name FROM oauth_clients WHERE source_id = $1`, print "N OAuth clients reference this source: ... Revoke first via `gbrain auth revoke-client <id>`." Mirrors `assessDestructiveImpact` in destructive-guard.ts (v0.26.5).

- [ ] **v0.34.x: `hybrid.ts:223` explicit-pick refactor.** The SearchOpts rebuild manually picks fields from HybridSearchOpts. This is the bug shape that caused the original v0.34.1 P0 leak — a new SearchOpts field is silently dropped if not manually added here. The wave added `sourceId` + `sourceIds` to the pick; future fields will keep hitting this footgun. Fix: refactor to spread + TypeScript `Pick<>` helper that narrows HybridSearchOpts → SearchOpts type-safely.


## functional-area-resolver follow-ups (v0.32.3.0)

- [ ] **v0.33.x: Dogfood `functional-area-resolver` on gbrain's own `skills/RESOLVER.md`** when it crosses ~12KB (currently 8KB). Apply the pattern to the Operational section first (largest). Filed during v0.32.3.0 CEO review.

- [ ] **v0.33.x: Promote `evals/functional-area-resolver/harness.mjs` to a first-class CLI command** `gbrain routing-eval --ab-compare <variant-dir>`. Removes the one-off harness as maintenance debt; gives every pattern-skill a way to ship its eval. Replaces the placeholder `--llm` flag in `src/core/routing-eval.ts:17-20`. Filed during v0.32.3.0 CEO review.

- [ ] **v0.33.x: Expand held-out corpus to >=20 fixtures.** The current n=5 saturates at 100% across most cells and can't distinguish "100%" from "95% with one nondeterministic miss." Author independently (don't see variants while authoring). Filed during v0.32.3.0 boil-the-ocean push after codex outside-voice review.

- [ ] **v0.33.x: Cross-vendor model verification.** Run the harness on Gemini 2.5 Pro and GPT-4o/5 in addition to the three Anthropic models we already covered. Compression gains may not transfer across vendor families (the `(dispatcher for: ...)` clause is interpreted differently by different prompt-tuned models). Wire through the existing gbrain gateway (recipes already exist for both vendors).

- [ ] **v0.33.x: Per-row description length sweep.** Anthropic's Agent Skills median is ~80 tokens of frontmatter per skill ([Anthropic engineering blog](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)). Sweep functional-areas at {20, 40, 80, 160} tokens per dispatcher row, eval each. Novel published contribution — no public data exists. ~$5 in API spend. Filed during v0.32.3.0 web research.

- [ ] **v0.33.x: Structural compression of functional-areas (`(dispatcher for: ...)` → `dispatcher: [...]` YAML form, trim verbose triggers, separate hard gates to sibling file).** Target 13KB → 9-10KB without accuracy regression. Requires another full re-baseline run (~$3 across 3 models) to confirm no regression.

- [ ] **v0.33.x: Hierarchical compression (area-of-areas).** Two-level: top-level mega-areas (knowledge / ops / comms) pointing to functional-area files loaded lazily. Predicted 13KB → 4-6KB. Risks resolver-of-resolvers-style collapse on the top-level layer. Worth an A/B but its own piece of work. Cross-reference AnyTool ([arXiv:2402.04253](https://arxiv.org/abs/2402.04253)) which formalizes this hierarchy at runtime.

- [ ] **v0.33.x: Embedding-based area pre-router.** RAG-MCP shape ([arXiv:2505.03275](https://arxiv.org/html/2505.03275v1)) — cheap embedding model picks the area; only that area's sub-skills get sent to the LLM. Dramatic per-call payload reduction (~80%). Significant new code surface but big production cost win. Wire through the existing gateway's voyage or openai embedding recipes.

- [ ] **v0.33.x: Adversarial-intent fixtures.** Intents specifically designed to test dispatcher-vs-subskill behavior on edge cases ("I want to do something brain-related" without specifying what). Targets the prompt-design failure mode (run-1 collapse) that our current 25 fixtures don't surface. ~10-15 fixtures, authored without looking at variant content.

- [ ] **v0.33.x: Run-2 vs Run-1 prompt-design ablation.** Document the difference between the naive classifier prompt (run-1, every variant 30-60% training) and the dispatcher-aware prompt (run-2+, functional-areas 88-100% training) as a reproducible result. This is the strongest empirical finding from v0.32.3.0 and deserves its own callout in SKILL.md or a sibling METHODOLOGY.md.

## Embedding-provider follow-ups (v0.32.0)

- [ ] **v0.32.x: Vertex AI ADC embedding provider (#729 originally).** lucha0404
  prototyped this with single-source-JSON via `GOOGLE_APPLICATION_CREDENTIALS`.
  Real ADC is the full chain (metadata server, gcloud creds, service-account
  JSON). The recipe needs to either use `@ai-sdk/google-vertex` (one new
  dep, native fit) or implement the chain via Bun.crypto.subtle for RS256
  JWT signing (zero dep, ~150 lines + RS256 spike). Original Q3 chose
  zero-dep; revisit the dep budget when scoping.

- [ ] **v0.32.x: GitHub Copilot embeddings (#691 originally).** tonyxu-io
  proposed adding Copilot's Metis embedding endpoint as a sidecar recipe.
  Codex review caught that this is not a recipe-add — it's an outbound OAuth
  product surface (login flow, browser/device flow, refresh, UX). Needs its
  own design pass: where does the token live? `~/.gbrain/oauth/copilot.json`
  mode 0600 was the v0.32 plan; revisit + write `gbrain auth login copilot`.

- [ ] **v0.32.x: OpenAI Codex OAuth chat provider (#698 originally).** perlantir
  proposed a chat-only provider that reuses ChatGPT subscription auth instead
  of API keys. Same OAuth-product-surface argument as #691. Same shared
  infra: `~/.gbrain/oauth/<provider>.json` + `gbrain auth login <provider>`.
  Build alongside #691 in one OAuth-subsystem wave.

- [x] **v0.32.7: CJK PGLite keyword fallback (#765 extracted).** Landed
  in the CJK fix wave. `hasCJK` + `escapeLikePattern` live in
  `src/core/cjk.ts`; the CJK branch in `pglite-engine.ts:searchKeyword`
  uses ILIKE + bigram-frequency-count ranking. Postgres path deferred
  (see new follow-up below).

- [ ] **v0.33+: Postgres CJK FTS via pgroonga / zhparser / ngram trigrams.**
  v0.32.7 only fixed CJK keyword search on PGLite. Multi-tenant Postgres
  deployments still hit empty results for CJK queries because
  `to_tsvector('english', ...)` can't segment Chinese / Japanese / Korean.
  Installing pgroonga or zhparser is an operator decision (extension
  install permission, multi-tenant rollout), so gbrain can't default it.
  Plan: doctor advisory pointing at the relevant extension docs;
  searchKeyword / searchKeywordChunks fall through to PGLite-style ILIKE
  when the extension isn't installed. Defer until users complain.

- [ ] **v0.33+: widen CJK ranges to Unicode property escapes.** v0.32.7
  uses BMP-only ranges (Han `4e00-9fff`, Hiragana `3040-309f`, Katakana
  `30a0-30ff`, Hangul Syllables `ac00-d7af`). Misses Han Extensions A/B/C,
  halfwidth katakana, compatibility ideographs, compatibility Jamo, and
  iteration marks `々` / `〇`. Switch to `\p{Script=Han}` / `\p{Script=Hiragana}` /
  `\p{Script=Katakana}` / `\p{Script=Hangul}` (TS supports unicode property
  escapes with the `u` flag). Astral-plane support also requires
  `Array.from(str)`-style codepoint iteration in the chunker's char-slice
  fallback (current `String.prototype.slice` splits surrogate pairs).
  Defer until first user hits the gap.

- [ ] **v0.33+: `git diff --name-status -z` + NUL framing.** v0.32.7
  added `core.quotepath=false` which handles non-ASCII paths but doesn't
  cover tabs, newlines, or quotes in filenames. The `-z` flag with
  NUL-byte path framing is the robust fix for the whole encoding class.
  Affects `src/commands/sync.ts:buildDetachedWorkingTreeManifest` +
  `buildSyncManifest`. Defer until someone files a tab-in-filename issue.

- [ ] **v0.33+: CJK-aware overlap context in chunker.** v0.32.7
  `extractTrailingContext` is still whitespace-token-based, so CJK chunks
  under the maxChars cap have no useful overlap with the previous chunk.
  Search continuity across chunk boundaries degrades for pure CJK content.
  The maxChars sliding-window in v0.32.7 IS overlap-protected for the
  hard-cap path, so this only affects normal-size chunks. Plan: switch
  `extractTrailingContext` to char-count when `countCJKAwareWords` would
  have triggered the CJK branch.

- [ ] **v0.33+: other non-Latin scripts (Thai, Arabic, Cyrillic,
  Devanagari).** Same five-layer fix pattern as CJK applies: slugify
  needs the script range, chunker needs density-threshold counting,
  PGLite keyword fallback would benefit from script-aware tokenization.
  Defer until first issue.

- [ ] **v0.33+: embedding pricing refresh mechanism.** v0.32.7 added
  `src/core/embedding-pricing.ts` as a static lookup table sibling to
  `anthropic-pricing.ts`. Both drift when providers change rates. Plan:
  a `gbrain prices refresh` skill that diffs against a published canonical
  source (OpenAI pricing page, Anthropic pricing page) and proposes an
  update PR. Or a release-cadence audit checklist item. Today: when the
  estimate looks off, hand-edit the constants.

- [ ] **v0.32.x: interactive provider chooser in `gbrain init`.** The full
  wizard piece of the v0.32 discoverability lane was deferred. Today
  `gbrain init` (no flags, TTY) silently uses OpenAI default. Plan: hook
  into `init.ts:resolveAIOptions`, when no `--model` AND TTY AND not
  `--non-interactive`, call `runExplain([])` (non-JSON path) from
  `providers.ts:233-350` to print the provider matrix, then prompt with
  readline (mirror `supabaseWizard()` at `init.ts:108`). Suggest
  recommended based on env detection. Refuse `user_provided_models`
  shorthand (already done in v0.32.0). Tests:
  `test/init-provider-wizard.test.ts` (TTY → prompt fires; non-TTY →
  falls through; invalid choice → re-prompts).

- [ ] **v0.32.x: real-credentials per-recipe smoke-test CI matrix.** Codex
  finding #6 noted that unit tests via `__setEmbedTransportForTests` prove
  routing but not contract correctness with the actual provider HTTP
  shape. Provider APIs change quietly (Voyage encoding-format, MiniMax
  type field, Azure header). One real-call per recipe per month catches
  drift before users do; <$1/run estimated. Requires API-key budget
  approval + repo secrets.

- [ ] **v0.32.x: MiniMax asymmetric retrieval support.** v0.32 ships
  `embo-01` with `type: 'db'` for both indexing and queries (symmetric
  retrieval). True asymmetric needs a query/document signal threaded
  through the embed seam. Worth it for MiniMax users who care about
  retrieval quality on Chinese content; defer until users complain.

- [ ] **v0.32.x: un-hardcode the multimodal dispatch at gateway.ts:583.**
  Currently `recipe.id !== 'voyage'` is hardcoded — harmless until a
  second multimodal recipe lands. Make it table-driven via
  `Recipe.touchpoints.embedding.supports_multimodal` +
  `multimodal_models`. ~10 lines + a contract test.

## v0.31.2 follow-ups

### Investigate: `gbrain query <common-keyword>` infinite loop
**Priority:** P1
**Filed:** 2026-05-08 from v0.31.2 bug report (separate from the sync hang).

**Evidence:** Two `bun /Users/garrytan/.bun/bin/gbrain query the` processes
(PIDs 39429, 46624) on the user's Mac were pegged at 99% CPU for 7
straight days before being killed manually. Each used 6+ GB resident
memory. Originated from the `algiers-v3` worktree. Not walker-related
(query path doesn't traverse files), so the v0.31.2 fix doesn't address
it.

**Likely candidates:**
- Query-expansion regex catastrophic backtracking on common single words
  (`src/core/search/expansion.ts` calls Haiku then post-processes with
  regex; a one-token query plus an unhelpful expansion could feed a
  pathological input back into the search pipeline)
- Hybrid-search RRF reciprocal-rank-fusion loop iterating over a result
  set that never shrinks (`src/core/search/hybrid.ts`)
- `postgres.js` cursor that never closes when the result set is large
  (the 6GB RES on `query` smells like accumulated rows in JS memory, not
  WASM allocation)

**To reproduce:** create a brain with at least a few thousand pages, run
`gbrain query the` and watch CPU + RSS. If it pegs and grows, capture
`process.report.getReport()` and a stack trace via `kill -SIGUSR2 <pid>`
before killing.

**Out of scope for v0.31.2** because the user's primary symptom (sync
hang) was the higher-evidence bug. Pick this up as v0.31.3 once the
sync fix is verified working in production.

### v0.31.3: PGLite + Postgres E2E for amarillo-shape regression
**Priority:** P2
**Filed:** 2026-05-08 from v0.31.2 plan (deferred).

**What:** Plan called for two regression tests pinning the user's exact
repro topology: `test/sync-walker-amarillo-shape.test.ts` (PGLite,
fast-loop) and `test/e2e/sync-amarillo-shape.test.ts` (real-Postgres,
skip-on-no-DB). Unit-level walker + chunker tests landed in v0.31.2
(`test/sync-walker-symlink.test.ts` + `test/chunker-timeout.test.ts`),
but the engine-integrated regression for the user's exact 1500-file
self-symlink topology is still pending. Add when the next sync-related
PR is in flight.

## Thin-client mode follow-ups (v0.31.1, Issue #734)

- [ ] **v0.31.x: routed-call timing telemetry.** `GBRAIN_TIMING=1` prints
  `token_mint=Xms http=Yms server=Zms total=Wms` per routed MCP call.
  Audit log at `~/.gbrain/audit/routed-calls-YYYY-Www.jsonl`. Cherry-pick
  C from #734 plan; deferred from v0.31.1 to keep scope tight.

- [ ] **v0.31.2: job-submission routing for `gbrain dream` etc.** Route
  long-running ops (`dream`, `embed --stale`, `extract`) via `submit_job`
  + poll, mirroring the existing `gbrain remote ping` autopilot-cycle
  pattern. Cherry-pick D from #734 plan. Adds a thin-client async-job
  render layer (progress events + spinner).

- [ ] **Per-subcommand thin-client routing for `takes` and `sources`.**
  CDX-2 audit identified the READ subcommands (`takes_list`, `takes_search`,
  `sources_list`, `sources_status`) as routable; mutate subcommands edit
  local files. v0.31.1 refuses both at the top level with hints. Split
  is a v0.31.x release.

- [ ] **Privacy decision: lift `localOnly: true` on `get_recent_transcripts`?**
  Raw chat exports leaving the host is a real tradeoff. Needs explicit
  per-token scope (`scope: 'transcripts'`) and consent UX. Out of v0.31.1.

- [ ] **Trust-boundary policy review for remote-caller gates.** Server
  intentionally disables `think.--save`/`--take` for remote callers
  (operations.ts:1103-1135) and skips `put_page` auto-link/auto-timeline
  for remote callers without `trustedWorkspace` (operations.ts:434-451).
  Subagent-isolation reasons; blocks full thin-client parity. Policy
  decision, not a routing fix.

- [ ] **v0.32.0: flip `gbrain auth register-client` default scope from
  `read` to `read,write,admin`.** Breaking for existing read-only scrapers;
  ship deprecation warning in v0.31.x. The v0.31.1 `oauth_client_scopes_probe`
  doctor check surfaces the gap with pinpoint remediation in the meantime.

- [ ] **v0.31.x: cross-process OAuth token cache at
  `~/.gbrain/oauth-token-cache.json`.** Cuts ~200ms cold-start cost for
  shell-loop usage on thin-client installs. Today the in-memory cache is
  per-process; every `gbrain` invocation pays a fresh token mint.

- [ ] **v0.31.x: parity test (`test/thin-client-parity.test.ts`).** Plan
  called for ~400 LOC byte-equal stdout assertions for 12+ ops via an
  in-process MCP server pointed at the same PGLite as the local-engine
  path. Harder than expected because it needs MCP server setup that the
  current test infrastructure doesn't expose. v0.31.1 ships without it;
  ENG-2's JSON-shape normalization + per-command test coverage is the
  interim guard.

## LongMemEval benchmark follow-ups (v0.28.12)

### Closed: full 500-question 4-adapter run published

The full 500-question, 4-adapter LongMemEval `_s` benchmark landed in
[gbrain-evals#main:ced01f0](https://github.com/garrytan/gbrain-evals/blob/main/docs/benchmarks/2026-05-07-longmemeval-s.md).
gbrain-hybrid: 97.60% R@5, beating MemPal raw 96.6% by 1.0pt on the same
dataset, K, and n with no LLM in the retrieval loop. Honest null result on
query expansion (97.60% with vs without). Closing this entry; remaining
follow-ups below.

### Timeline-aware retrieval signal for temporal-reasoning questions
**Priority:** P2

**What:** gbrain's `links` table + `gbrain extract timeline` already build a
graph of dated events. Feed that signal into `searchKeyword` / `searchVector`
ranking so questions like "what was the FIRST issue I had after my new
car's first service?" get a temporal boost on session ordering.

**Why:** LongMemEval temporal-reasoning is the only question type where MemPal-raw
beats gbrain-hybrid (96.2% vs 94.7%, -1.5pt). Embeddings carry topic
similarity; "first" / "before" / "last week" need ordering signal that
vector cosine doesn't surface. We have the data infrastructure to fix this
(the timeline extraction code), just don't pipe it into search ranking.

**Pros:** Closes the only categorical loss to MemPal on the public benchmark.
Generalizes beyond LongMemEval — every personal-knowledge agent gets
temporal questions and most fail them. This is a structural advantage.

**Cons:** Requires a new SQL ranking factor in `src/core/search/sql-ranking.ts`
and signal-extraction work in the query-time path (parsing temporal hints
from the question). Maybe ~200 lines + a benchmark line on the gbrain-evals
report once it ships.

**Context:** Per-type breakdown in
`gbrain-evals/docs/benchmarks/2026-05-07-longmemeval-s.md` shows we tie
or beat MemPal-raw on 5 of 6 types and lose temporal by 1.5pt. Also:
`src/core/link-extraction.ts` already extracts dated timeline entries via
`parseTimelineEntries`. They land in `timeline_entries` table but aren't
used during retrieval ranking.

**Depends on:** Nothing blocking.

### Per-question batch consolidation (latency optimization)
**Priority:** P3

**What:** `importFromContent` calls `embedBatch` once per page. Each LongMemEval
question imports ~50 sessions = 50 separate API calls. Pre-chunk all sessions
for a question, embed in one OpenAI call, then bulk-write.

**Why:** Drops per-question latency from ~14s to ~3s on a cold cache.
Currently the runner ships a 700MB SQLite warm-cache to avoid this; a faster
cold path would let CI run the benchmark daily without a fixture.

**Pros:** Daily benchmark CI gate becomes practical. Cuts cold-cache cost by
~10x. Faster iteration when tuning ranking parameters.

**Cons:** ~80 lines of batch-consolidation code that lives in the runner, not
gbrain core. Touches `eval/runner/longmemeval.ts:run()` per-question loop.
Less generalizable than the timeline-aware ranker work.

**Context:** Right now the warm-cache mitigates this in practice (subsequent
runs are sub-1-min). The optimization matters only when re-running with a
different gbrain version that re-keys the cache.

**Depends on:** Nothing blocking.

### LongMemEval `_m` split (200 distractor sessions per haystack)
**Priority:** P3

**What:** Run the existing 4-adapter benchmark against the harder `_m` split
where each haystack has ~200 distractor sessions instead of ~50.

**Why:** Pushes retrieval into the regime where gbrain's pipeline either
holds up or doesn't. MemPal hasn't published `_m` numbers; we'd have a
clean head-to-head once we run it. Also stresses the noise-rejection
(source-boost / hard-exclude) layer of gbrain harder than `_s` does.

**Pros:** Differentiated benchmark line. Forces signal-vs-noise behavior we
can't measure on `_s`. Free with our existing runner.

**Cons:** ~$10-20 in OpenAI embeddings (4x more chunks per question). Cache
file grows to ~3GB. ~6-8 hours wall time for the embedding-heavy runs even
parallel-3.

**Depends on:** Nothing blocking. Could ship same shape as `_s` report.

### Cheaper embedding-model recipe for benchmarks
**Priority:** P4

**What:** Pin `text-embedding-3-small` (or Voyage-3-lite via the v0.27
pluggable provider stack) as a benchmark-only embedding model so the
cold-cache cost drops 10x. Compare recall against `text-embedding-3-large`
and publish the recall-cost tradeoff curve.

**Why:** "What's the cheapest embedding model that still wins this
benchmark?" is a real builder question. We'd publish the answer.

**Pros:** Useful tradeoff line for users picking gbrain in a cost-sensitive
deployment. Validates the v0.27 pluggable-provider work end-to-end.

**Cons:** Multiple full-benchmark runs ($30+ in API spend) to chart the
curve.

**Depends on:** v0.27 pluggable embedding provider work (already shipped,
verify Voyage adapter integration in `src/core/ai/recipes/voyage.ts`).
## multimodal embedding follow-ups (v0.28.11 / PR #719)

### `gbrain doctor`: warn on misconfigured multimodal model
**Priority:** P2

**What:** Add two checks in `src/commands/doctor.ts`. (1) When `embedding_multimodal_model` is set, verify the recipe's required API key is present in the env. (2) When `embedding_multimodal: true` is set but no `embedding_multimodal_model` AND the primary `embedding_model` recipe doesn't declare `supports_multimodal`, surface that gap.

**Why:** Today these misconfigurations surface only on first image ingest, after the user has already pushed image content into the brain. Doctor catching them at install/upgrade time saves a round of confusion.

**Pros:** Both checks are read-only and cheap (one env probe + one recipe lookup). Same pattern as existing doctor checks. Surfaces problems before they ship.
**Cons:** Doctor's check list grows; needs a `--fast` opt-out path if added to the default scan. ~40 lines.
**Context:** PR #719 added the multimodal_model routing key. The recipe-level + model-level validation in `embedMultimodal()` already throws clear errors at runtime, but only when image content hits the gateway. v0.28.x candidate.
**Depends on:** None.

### Reclassify Voyage HTTP 4xx as `AIConfigError` (Codex F2 from PR #719 review)
**Priority:** P2

**What:** `src/core/ai/gateway.ts:626` currently throws `AITransientError` for any non-401/403 4xx response from Voyage's /multimodalembeddings endpoint. Replace with a 4xx-non-429 → `AIConfigError` branch matching `normalizeAIError`'s contract at `src/core/ai/errors.ts:54`.

**Why:** A config bug (malformed body, unsupported field, model the caller forgot to add to `multimodal_models`) currently presents to the caller as transient and triggers retry storms. PR #719's Change 3 closes the specific wrong-multimodal-model case locally via the `multimodal_models` allow-list, but other 4xx reasons still misclassify.

**Pros:** Aligns the embedMultimodal error classifier with `normalizeAIError`. Eliminates retry-on-permanent-bug behavior. ~10 lines + 1 test.
**Cons:** Changes runtime error class for some failures; existing callers that catch `AITransientError` for these codes now must catch `AIConfigError`. Search before merging.
**Context:** Pre-existing in v0.27.1; surfaced because PR #719's new key makes the misclass more reachable. v0.28.x candidate.
**Depends on:** None.

### `gbrain config unset <key>` subcommand (Codex F6 from PR #719 review)
**Priority:** P3

**What:** Add `unset` action alongside `show|get|set` in `src/commands/config.ts`. Calls `engine.setConfig(key, '')` (loadConfigWithEngine treats empty string as undefined) so a user who set a key by mistake can clear it. Empty-string write is the minimum-diff implementation; a real DELETE would be cleaner if the engine grows one.

**Why:** Once a user runs `gbrain config set X val`, there's no normal CLI path to clear it. Empty string is rejected by the current `set` validator (`action === 'set' && key && value` where value is truthy). PR #719 added another DB-merge key (`embedding_multimodal_model`) and surfaces this UX gap.

**Pros:** Closes a pre-existing UX hole that applies to every DB-merge key (`embedding_multimodal`, `embedding_image_ocr*`, now `embedding_multimodal_model`). Trivial implementation, ~15 lines.
**Cons:** Need to decide whether `unset` is a real DELETE (cleaner) or empty-string write (simpler).
**Context:** Pre-existing in v0.27.x. Worth doing alongside the doctor checks above so users have a working escape hatch.
**Depends on:** None.

## cross-modal-eval (v0.27.x follow-ups from PR #674 plan)

### `--budget-usd` hard cap + per-call cost telemetry (T11=B follow-up)
**Priority:** P2

**What:** `gbrain eval cross-modal` ships in v0.27.x with a partial cost guardrail: default `--cycles 1` in non-TTY plus a stderr cost-estimate printed before each run. The full `--budget-usd N` hard cap (refuse to start the next cycle if estimated spend would exceed) and per-call actual-cost telemetry written into the receipt are intentionally deferred.

**Why:** Codex pushback on the original P2=B "defer everything" decision was right — even with `>=2/3` success required for a verdict (Q3=A), 3 cycles × 3 calls = 9 frontier calls per run, repeated across N skills if anyone scripts a bulk audit. The TTY/non-TTY cycle default catches the worst case; the hard cap catches the next class of mistakes.

**Pros:** Deterministic spend ceiling. Real per-call cost in the receipt drives a feedback loop that lets us refine the price-table constant in `src/core/cross-modal-eval/runner.ts:estimateCost`. Future bulk-audit integrations get a safety net by default.
**Cons:** ~80 lines of pricing-table + parsing + threading. Pricing values drift; the file becomes a small maintenance burden between model-family bumps.
**Context:** Pricing table lives at `src/core/cross-modal-eval/runner.ts:estimateCost`. Once we have real telemetry from a few weeks of usage, we can switch the table to "last observed" instead of "list price" and get more accurate caps. v0.27.x candidate.
**Depends on:** Nothing.

### Subagent integration (recovers cross-process rate-leases — T4 deferred)
**Priority:** P2

**What:** Wire `gbrain eval cross-modal` to be invokable as a `gbrain agent run` child job. Today the CLI runs synchronously and bypasses `src/core/minions/rate-leases.ts` because the lease helper requires a `minion_jobs.id` that the CLI path doesn't have (T4=A in plans/radiant-napping-lerdorf.md).

**Why:** Cross-process concurrency cap. A user running `gbrain eval cross-modal` in one terminal alongside `gbrain agent run` in another can hit Anthropic 429s due to combined load. As a minion job, the eval gets the rate-lease behavior for free, plus stagger / quiet-hours / retry surface from the existing Minions queue.

**Pros:** No new helper API; reuses what's already there. Closes the cross-process gap that today's `Promise.allSettled` design intentionally leaves open.
**Cons:** Requires a job handler registration + receipt-path threading through job context. Probably ~150 lines plus tests. Behavior parity (verdict / receipt shape) needs to be pinned with a parametrized test.
**Context:** Pattern is the same as `src/core/minions/handlers/subagent.ts`. v0.27.x candidate.
**Depends on:** Nothing.

### Skill adoption telemetry (revisit T7=C with data)
**Priority:** P3

**What:** Track how many skills land cross-modal eval receipts. If adoption stalls at, say, <30% of skills after 30 days, consider flipping the 11th item from `required:false` (T7=C, current) to `required:true` (T7=A) in v0.28.x.

**Why:** T7=C ships the gate as informational so existing audits don't regress. The forcing function is documentation alone. We don't yet know if that's enough.

**Pros:** Data-driven decision instead of guessing. Lightweight: count receipt files in `gbrainPath('eval-receipts')` against the count of skills under `skills/*/SKILL.md`.
**Cons:** "Adoption stalled" is a judgment call without a baseline. Could become a debate.
**Context:** New check in `gbrain doctor` would surface the count. v0.28.x candidate.
**Depends on:** None.

### `docs/cross-modal-eval.md` user guide
**Priority:** P3

**What:** Add a user-facing guide. Cover the gateway-config flow, receipt forensics, the `<slug>-<sha8>.json` filename convention, default models + how to override them, the relationship to `skills/cross-modal-review/SKILL.md`, and worked examples on a real skill.

**Why:** SKILL.md teaches the workflow but lives under `skills/skillify/`. CLAUDE.md "Key files" entries are agent-facing, not human-facing. A `docs/cross-modal-eval.md` is the natural home for "I'm a user, how do I use this command?" answers.

**Pros:** Discoverable from CLAUDE.md "Key files" reference. Mirrors `docs/eval-bench.md` precedent.
**Cons:** Doc-write task; ~250 lines of prose.
**Context:** v0.27.x candidate.
**Depends on:** None.

## /health endpoint hardening (v0.28.1 follow-up)

### Cancel `engine.getStats()` when /health times out
**Priority:** P2

**What:** `probeHealth()` in `src/commands/serve-http.ts` races `engine.getStats()` against a 3s timeout. When the timeout wins, the original `getStats()` keeps running on a saturated pool. Under sustained probe traffic with a slow DB, timed-out probes pile up expensive `count(*)` queries that turn a partial slowdown into a total outage.

**Why:** Both adversarial reviewers (Claude + Codex) flagged this independently during the v0.28.1 ship. Deferred because cancellation requires `AbortController` plumbing through `BrainEngine.getStats()` which doesn't exist yet — wider blast radius than v0.28.1's zombie-reaping scope justified.

**Pros:** Closes the self-DoS path. /health returning 503 stops contributing to pool saturation.
**Cons:** Touches the BrainEngine interface (PostgresEngine + PGLiteEngine implementations). Needs postgres.js or PgBouncer-level query cancellation. Wider blast radius.
**Context:** Drop-in replacement for `Promise.race([getStats(), timeout])` is `getStats({ signal })` consumed via AbortController. Reviewer findings: see PR #637 (v0.28.1) adversarial review section.
**Depends on:** AbortController plumbing in BrainEngine interface.

### Replace `/health` with a lighter liveness probe
**Priority:** P3

**What:** `engine.getStats()` does `count(*) FROM pages, content_chunks, links, tags, timeline_entries` plus `GROUP BY type`. On a large but otherwise healthy brain, this can normally exceed 3s and cause false-positive 503s + orchestrator restart loops.

**Why:** Codex flagged that the new 3s timeout is aggressive for the cost of the probe. Pre-existing behavior (the /health endpoint was already doing full stats in v0.27 with no timeout). Worth splitting probe purpose: `/health` for liveness (`SELECT 1`), `/stats` for the full counts.

**Pros:** Liveness probe stays under 100ms even on saturated pools. Operators get a separate `/stats` for the count breakdown when they actually want it.
**Cons:** Behavior change for orchestrator setups that scrape /health as both liveness AND count source.
**Context:** PR #637 (v0.28.1) adversarial review. Pair with the AbortController follow-up above.
## Remote-source MCP follow-ups (v0.28.2)

### Token rotation: `gbrain auth rotate <name>` + `rotate_token` MCP op
**Priority:** P2

**What:** Atomic rotate for legacy + OAuth tokens. Issue a new token in the same TX as the revocation of the old, no overlap window. Refresh-token rotation already exists for OAuth; this is the unified user-facing surface (CLI + MCP).

**Why:** Today rotation is `revoke + create`, with a window where neither token works. For long-lived bearer keys handed to agents, that's a reload outage every time the key gets rotated.

**Pros:** Single command does the right thing. Atomic cutover. Operators stop scripting around the gap.
**Cons:** Needs careful testing of the legacy `access_tokens` UPDATE path (returns single-use new token before the row mutates) plus an MCP op that grants a new token bound to the original client_id without requiring a new authorize round trip.
**Context:** Item 4 from the gstack /setup-gbrain v1.28.1.0 enhancement request. v0.28.x candidate.
**Depends on:** Nothing.

### Migration introspection in `get_health`
**Priority:** P3

**What:** Extend `BrainEngine.getHealth()` return shape with `migrations: { pending: [...], wedged: [...] }`. `gbrain doctor` already shows this; expose it via the MCP op so remote agents can detect partial-migration state without invoking `doctor` separately.

**Why:** Closes a remote-diagnostic gap. gstack /setup-gbrain Path 4 hit a wedged-migration brain mid-session; the only readback was SSH + `gbrain doctor`. With this, the same diagnostic flows through MCP.

**Pros:** Pure additive change to the `get_health` op shape. No new op surface. Consumers ignore the new field if they don't care.
**Cons:** Wedged detection logic lives in `gbrain doctor`'s code today; need to extract or duplicate. Care needed not to leak migration internals to non-admin scopes (current op is admin-only — fine).
**Context:** Item 5 from the gstack /setup-gbrain v1.28.1.0 enhancement request.
**Depends on:** Nothing.

### Accept-header friendliness on `/mcp`
**Priority:** P3

**What:** MCP SDK rejects requests missing `text/event-stream` in the Accept header with a generic 406 Not Acceptable. Pre-check the header at the express middleware layer and return a 400 with a descriptive hint pointing at the spec.

**Why:** Other MCP clients (curl scripts, custom integrations) hit the SDK's 406 and get no diagnostic. gstack's verify-helper sets both headers correctly so the headline path works.

**Pros:** Operator UX improvement. Faster debugging when clients fail discovery.
**Cons:** Tight coupling to the SDK behavior — if it later loosens, the pre-check becomes redundant.
**Context:** Item 6 from the gstack /setup-gbrain v1.28.1.0 enhancement request.
**Depends on:** Nothing.

### `gbrain sources rebase-clone <id>`
**Priority:** P3

**What:** Recover from `url-drift` (config.remote_url updated but the on-disk clone still points at the old origin). Currently `sync` refuses with a structured error pointing at this command — but the command itself doesn't exist yet. Implement: prompt for confirmation (rm-rf the clone is destructive), then re-clone via the same temp-dir + rename atomicity contract as `sources add --url`.

**Why:** Closes the loop on the URL-drift code path the v0.28.2 sync added. Without it, operators have to `sources remove --confirm-destructive` + `sources add --url` (loses page count, history).

**Pros:** Cleaner UX for URL changes. Preserves the source row + history.
**Cons:** Destructive on-disk; needs `--confirm-destructive` gate. Edge case: what if sync is mid-run when rebase fires? The existing sync-lock guards this, but worth pinning in tests.
**Context:** v0.28.2 plan filed this explicitly as a follow-up.
**Depends on:** Nothing.

### `--filter=blob:none` partial-clone option for federated sources
**Priority:** P3

**What:** v0.28.2 defaults `gbrain sources add --url` to `--depth=1` (no history). For users who want commit-aware features later (page-state-at-commit-X, blame, who-edited-what), expose `--filter=blob:none` as an opt-in: keeps full graph metadata, lazy-fetches blobs.

**Why:** `--depth=1` is a one-way door — once cloned, you can't reconstruct history without re-cloning the whole repo. Partial clones preserve history while staying small.

**Pros:** Forward-compat for commit-aware brain features. Negligible cost on first clone for typical brain repos. Better than the alternative (full clones for everyone).
**Cons:** First-clone latency is higher on long-history repos. Adds one more flag to the `add` surface.
**Context:** Eng review A5 — the boring choice for v0.28.2 was `--depth=1`. This is the unboring follow-up.
**Depends on:** Nothing.

### DNS rebinding defense for `parseRemoteUrl`
**Priority:** P3

**What:** `isInternalUrl` (`src/core/url-safety.ts`) does lexical/string-based classification only — no DNS resolution. An attacker who controls a public hostname's A/AAAA records can resolve to internal IPs (`127.0.0.1`, `169.254.169.254`, RFC 1918) and bypass the SSRF gate. The gate catches direct IP literals + metadata hostnames; it doesn't catch `https://attacker-controlled.example/repo.git` where DNS points internal.

**Why:** Defense in depth. The current gate is sufficient for naive abuse (typing `192.168.1.1` directly), but a deliberate attacker with DNS control can bypass it. Adding async DNS resolution + revalidation closes the hole.

**Pros:** Closes the cleanest remaining SSRF bypass. Mirrors the redirect-revalidation pattern at `integrations.ts:289`. Pinned by a future test using a mock resolver.
**Cons:** Async DNS makes `parseRemoteUrl` `async`. Every caller (CLI, MCP op, test) needs to update. ~50-line change.
**Context:** Codex finding from v0.28.2 ship adversarial review. The IPv6 ULA + link-local portion of the same finding shipped in v0.28.2; DNS rebinding deferred.
**Depends on:** Nothing.

### `sources.chunker_version` PGLite-schema parity
**Priority:** P3

**What:** `src/schema.sql:33` declares `sources.chunker_version` and `src/commands/sync.ts:253` reads/writes it, but `src/core/pglite-schema.ts:28` omits the column. PGLite users hit a schema-mismatch error on the sync write path.

**Why:** Pre-existing bug surfaced during the v0.28.2 codex review. Not introduced by remote-source work, but adjacent to source-sync code. Worth fixing as a small parity PR before more source-local state lands.

**Pros:** Closes a quiet schema drift between the two engine implementations. ~10 lines.
**Cons:** Needs a migration entry to add the column to existing PGLite brains. Migration version bump.
**Context:** Codex D5 from v0.28.2 plan review.
**Depends on:** Nothing.

## OAuth/MCP hardening (v0.26.7 follow-up)

### F11 — `auth register-client --redirect-uri` flag
**Priority:** P3

**What:** `gbrain auth register-client` always passes `[]` for redirect URIs; there is no CLI flag to set them. Operators who want to register an `authorization_code` client without DCR have to hand-edit the database.

**Why:** Operator UX gap, not a trust-boundary issue. Codex C11 correctly flagged it as scope creep on the v0.26.7 hardening pass — kept out of that PR but worth doing.

**Pros:** Closes the operator-experience gap. Validates `https://` or loopback per RFC 6749 §3.1.2.1 at registration time. Repeatable flag.
**Cons:** ~30 lines of argv parsing + URL validation. Adds one more flag to the `auth register-client` surface. Low value relative to the OAuth provider hardening that already shipped.
**Context:** Eva-brain has the implementation under `src/commands/auth.ts:registerClient`. Lift verbatim — the `localhost`/`127.0.0.1`/`::1` exact-match validation is correct; codex spot-check confirmed it does NOT match `localhost.evil.com`. v0.27 candidate.
**Depends on:** Nothing.

### F13 — `gbrain serve --http` argv positive-int validator
**Priority:** P3

**What:** `parseInt(args[idx + 1])` on `--port` and `--token-ttl` accepts the next flag as the value if the argument is missing (e.g., `--port --token-ttl 100` parses port as NaN → fallback 3131). Negative integers like `--port -1` parse to -1, server fails to bind with a confusing error.

**Why:** Hygiene, not security. Codex C11 flagged as scope creep. Cheap to do later.

**Pros:** Replaces `parseInt(...)  || fallback` with a `parsePositiveIntOption(args, flag, fallback, {max?})` helper that validates the next arg isn't a flag, matches `^[1-9]\d*$`, and clamps to a max. Exits 2 with a clear error.
**Cons:** ~20 lines of helper + threading through `serve.ts`. Behavior change: previously-silent bad input now exits loud. Probably fine; no consumer relies on the silent fallback.
**Context:** Eva-brain has the helper at `src/commands/serve.ts`. v0.27 candidate.
**Depends on:** Nothing.

## destructive-guard (v0.26.5 follow-up)

### Adjacent 2 — Storage objects orphan on hard purge
**Priority:** P2

**What:** When `purgeExpiredSources` (sources cascade) or `purgeDeletedPages` (page-level) deletes rows, the underlying object-storage payloads referenced by `files.storage_uri` (S3 / Supabase Storage) are NOT torn down. The cascade FK on `files.source_id` removes the DB row that points at the object; the object itself stays.

**Why:** Bound today by most brains carrying `Files: 0` (operator preview boxes confirm this in the wild). The leak compounds the moment attachments / images / audio start landing — every soft-delete + 72h TTL purge silently abandons object-storage bytes.

**Pros:** Closes a real data-leak path. Operators stop paying for orphaned bytes. Aligns sources/pages purge with the file lifecycle.
**Cons:** Storage backend code is non-trivial (S3 vs Supabase vs local-fs paths each have different cleanup APIs). Single-flight delete + retries on 5xx; needs an audit log.
**Context:** Plan calls this out explicitly in v0.26.5 CEO review (`~/.claude/plans/take-a-look-and-gentle-pine.md` Adjacent 2). Targets: `src/core/storage.ts` for the object-storage interface, `src/core/destructive-guard.ts` `purgeExpiredSources` for the call site, plus a new sweep in the cycle's purge phase. v0.26.6 candidate.
**Depends on:** Schema is fine (already has `files.storage_uri`). Just needs the storage delete plumbing.

### Adjacent 3 — sources remove + sources purge race against gbrain sync
**Priority:** P3

**What:** `gbrain sources remove <id>` and the new `gbrain sources purge <id>` paths don't acquire `SYNC_LOCK_ID` (the `gbrain-sync` writer lock from PR #490). If `gbrain sync` is mid-import for the same source, the parent row can DELETE while sync is INSERTing children, surfacing as a loud FK violation.

**Why:** Failure mode is loud (FK violation, not data corruption), and the race window is narrow. Worth closing while the destructive surface is touched, not before.

**Pros:** Single line at the top of `runRemove` and `runPurge`. Reuses `tryAcquireDbLock(engine, SYNC_LOCK_ID, 5)`. No design surface.
**Cons:** Adds an extra "couldn't acquire lock" exit path the operator has to recognize and retry.
**Context:** Plan calls this out in CEO review Adjacent 3. Targets: `src/commands/sources.ts` `runRemove` and `runPurge`. v0.26.6 candidate. Pattern: `try { await fn() } finally { await release() }` mirrors the cycle.ts use of the same primitive.
**Depends on:** Nothing.

### Auth revoke-client gets the destructive-guard pattern
**Priority:** P3

**What:** `gbrain auth revoke-client <client_id>` (v0.26.2) lands without an impact preview or `--confirm-destructive` gate. CASCADE-purges every active token + auth code in one transaction; one stray client_id wipes a production integration.

**Why:** Lower urgency than sources/pages because operators run this explicitly with a known client_id, not reflexively. But if the v0.26.5 posture is "every destructive surface gets the same gate," this surface should adopt it.

**Pros:** Posture consistency — every destructive verb in the gbrain CLI follows one pattern. Operators get the impact preview before nuking a production OAuth client.
**Cons:** Marginal — single-row delete with cascade. The CASCADE is the blast radius, not the verb itself.
**Context:** Plan flags this in CEO review. Targets: `src/commands/auth.ts` `runRevokeClient` (current shape: atomic DELETE...RETURNING with CASCADE on `oauth_tokens` + `oauth_codes`). Add an impact preview that counts `oauth_tokens` and `oauth_codes` for the client, then gate behind `--confirm-destructive`.
**Depends on:** Nothing.

## test infra (v0.26.4 follow-up — intra-file parallelism)

### Sweep cross-file shared-state contention; enable `bun test --concurrent` for another 2-3x speedup
**Priority:** P0
**Status:** v0.26.7 shipped foundation slice (helpers + lint + mock.module quarantine). v0.26.8 (env sweep) and v0.26.9 (PGLite sweep + codemod + measurement) carry the rest.

**What:** v0.26.4 shipped file-level parallel fan-out (8 shards) and got `bun run test` from 18 minutes to ~85s — a 12x speedup. The next layer is **intra-file** parallelism via Bun's `--concurrent` flag (or per-test `test.concurrent()` markers). This requires every test file to be safe under concurrent execution within the same `bun test` process.

The constraint: when multiple test files load into the same bun process (which is what `bun test foo.test.ts bar.test.ts ...` does inside a shard), they share module-level state. Three contention surfaces today:

- **~58 PGLiteEngine instantiations** across `test/` (per codex's grep). Many use module-level `let engine: PGLiteEngine` patterns. Race when multiple test files load and each invokes `new PGLiteEngine().connect({})`. **(carrying to v0.26.9)**
- **~40 process.env mutations** without restore. `process.env.X = '...'` not paired with `afterEach` cleanup leaks across files in the same process. **(carrying to v0.26.8 — `withEnv` helper shipped in v0.26.7)**
- ~~**2 top-level `mock.module(...)` calls** in `test/core/cycle.test.ts:26` and `test/embed.test.ts`. Top-level mocks affect every other test file in the same process.~~ **(quarantined as `*.serial.test.ts` in v0.26.7)**

The repo already has the right helper: `test/helpers/reset-pglite.ts` exports `resetPgliteState(engine)` which is "two orders of magnitude faster" than fresh-engine-per-test (per the helper's own comment). Sweep all PGLite sites to use one shared engine + this reset in `beforeEach`. Do NOT introduce a `freshPglite()` allocator — codex correctly flagged that the repo already rejected that direction.

Two flakes already known and quarantined as `*.serial.test.ts` (run after parallel pass at `--max-concurrency=1`):
- `test/brain-registry.serial.test.ts` (was `brain-registry.test.ts`)
- `test/reconcile-links.serial.test.ts` (was `reconcile-links.test.ts`)

After the sweep, both should be fixable and renameable back to plain `*.test.ts`.

**Why:**
- 2-3x additional speedup on top of v0.26.4's 12x. Target: `bun run test` < 30s on a Mac dev box.
- Forces the test architecture to be principled (no shared mutable state across files in the same process).
- The empirical proof point: when `bun run test` was first measured at v0.26.4, two flakes surfaced under cross-file pressure that pass cleanly in isolation. That same pattern WILL surface more flakes if the suite grows. Better to sweep proactively than to keep growing the `*.serial.test.ts` quarantine.

**Pros:**
- Real architectural win, not just speed: tests become composable.
- Existing helper (`test/helpers/reset-pglite.ts`) already validates the pattern.
- Quarantined flakes auto-resolve: rename back to `*.test.ts` after the sweep.

**Cons:**
- 1-2 weeks of careful refactoring across ~100 test files.
- Some tests genuinely need shared file-wide state (top-level mocks for module-replacement tests). Those stay quarantined as `*.serial.test.ts` permanently — but the count should shrink to a known small set, not grow.

**Context:** v0.26.4 plan considered doing this in scope (Codex Tension #2 = C). After empirical measurement showed `--max-concurrency=4` does nothing on tests not marked `test.concurrent()`, the user chose to ship v0.26.4 as file-level-only and file this as the v0.27+ project. Plan file: `~/.claude/plans/system-instruction-you-are-working-tranquil-ladybug.md`. Codex critical findings #2, #3, #6 are all relevant.

**Acceptance criteria:**
1. All ~58 PGLiteEngine sites use shared-engine + `resetPgliteState()` in `beforeEach`. **(v0.26.9)**
2. All ~40 `process.env` mutations use a `withEnv(...)` helper that saves + restores. **(v0.26.8 — helper shipped v0.26.7)**
3. ~~The 2 top-level `mock.module()` calls scoped to `beforeEach`/`afterEach`, OR the file moves to `*.serial.test.ts`.~~ **DONE in v0.26.7 (quarantined)**
4. Wrapper passes `--concurrent` (or every test marked `.concurrent()`). **(v0.26.9 — codemod with `find` recursive per Codex F3)**
5. `bun run test` runs 5 times consecutively without flakes. **(v0.26.9)**
6. Quarantine count `≤10` after the sweep (raised from 5 per D15; v0.26.7 added 2, currently 4: brain-registry, reconcile-links, cycle, embed).
7. Wallclock target: `bun run test` ≤60s informational (per D9, dropped from <30s after Codex F1: marking only ~92 cheap files concurrent doesn't unblock the heavy 56 PGLite + 49 env files). Pinned config: SHARDS=8, MAX_CONCURRENCY=4, document Mac model. **(v0.26.9)**

**Decisions ledger (v0.26.7 plan):** D1 reversed→D16 sliced, D5 quarantine, D6 no helper wrapper, D7 grep+quarantine, D9 ≤60s informational, D10 ESM-cache claim dropped, D11 codemod uses `find` recursive, D12 lint wired into `verify` not `test`, D13 unquarantine attempt dropped, D14 extended grep patterns, D15 cap raised to 10.

**Estimated effort:** 1-2 weeks of one engineer's focused work. Could parallelize by sub-area (env-mutation sweep is independent of PGLite sweep).

### Speed up E2E via Postgres template databases
**Priority:** P1

**What:** E2E tests (`bun run test:e2e`) currently run sequentially in one shared Postgres container, each test file calling `initSchema()` from scratch (~5-20s each on cold init). Speed-up: build the schema ONCE into a template DB (`gbrain_template`), then have each test file `CREATE DATABASE foo TEMPLATE gbrain_template` (~50ms per clone). With per-shard `DATABASE_URL` overrides, E2E can fan out to N parallel shards too.

**Why:** Current E2E wallclock is ~5-10 min in CI. Template DB clones could bring that to ~1-2 min. Critical for the inner loop on E2E-bearing PRs (currently a real friction point per `/ship` workflow).

**Sketch:**
1. Build template DB once via `initSchema()` against `gbrain_template`.
2. Per-test-file: `CREATE DATABASE gbrain_test_clone_<n> TEMPLATE gbrain_template` (50ms vs 5-20s).
3. Per-shard isolation via `DATABASE_URL` env override.
4. Schema-version stamp on the template so it invalidates when `migrate.ts` changes.
5. Cleanup via `DROP DATABASE` in afterAll.

**Estimated effort:** 1-2 days. Filed during v0.26.4 plan as a deferred follow-up (D4 = B).

## test infra (v0.26.2 follow-up — pre-existing failures triage)

### Fix 22 pre-existing test failures unrelated to OAuth
**Priority:** P0

**What:** A `bun test` run on top of master at v0.26.2 surfaces 22 pre-existing failures across these suites — none touch v0.26.2's diff (oauth-provider.ts, auth.ts, oauth tests). They reproduce on a clean checkout against master:

- 12 cases in `test/e2e/sync.test.ts` (Git-to-DB Sync Pipeline) — `result.status === 'first_sync'` vs actual `'synced'` state-machine drift; same root cause across all 12.
- 3 cases in `test/e2e/multi-source.test.ts` (cascade delete + 2 sync routing) — performSync sourceId/local_path resolution.
- `test/e2e/sync-parallel.test.ts` (60-file Postgres concurrency=4) — connection-leak probe regression.
- `test/e2e/sync.test.ts` `--skip-failed` structured summary loop (v0.22.12 #500).
- `test/e2e/dream.test.ts` (no --dry-run syncs pages) — runCycle DB write path.
- `test/e2e/cycle.test.ts` (live cycle + chunks + lock cleanup).
- `test/e2e/doctor.test.ts` (gbrain doctor exits 0 on healthy DB) — possibly related to v0.26.2 schema changes since CHANGELOG mentions extension of doctor checks.
- `test/brain-registry.test.ts` (empty/null/undefined id routes to host) — unrelated to OAuth surface.
- `test/e2e/claw-test.test.ts` (fresh-install scripted scenario) — needs investigation; took 3.9s and reported "produces zero error/blocker friction" failure.

**Why:** These failures pre-date v0.26.2 (CHANGELOG already documents "18 pre-existing master timeouts" from v0.26.0 merge). v0.26.2 brings the count to 22, suggesting a 4-test drift on master between v0.26.0 ship and now. Fixing inside v0.26.2 would balloon scope from a 6-file OAuth fix-wave to a 30+ file test-infra repair. The fix-wave deserves its own PR with focused triage.

**Likely root causes worth investigating:**
- **bun execSync env inheritance** (already discovered + fixed in test/e2e/serve-http-oauth.test.ts during v0.26.2): bun's `execSync` does NOT inherit env mutations done via `process.env.X = ...`, only OS-level env from before bun started. helpers.ts loads `.env.testing` and sets `DATABASE_URL` via `process.env` mutation, which is invisible to subprocesses unless `env: { ...process.env }` is passed explicitly. Several of the failing E2E tests (sync, cycle, dream, claw-test) spawn subprocesses via execSync — likely the same bug.
- **Test ordering / DB state pollution**: full-suite runs in bun test happen in a deterministic order; isolated runs of these test files may pass while suite runs fail. Could indicate beforeAll/afterAll cleanup gaps.
- **Schema drift**: doctor/multi-source tests may rely on specific schema state that v0.26 OAuth tables changed.

**Pros:**
- Separating from v0.26.2 keeps the OAuth ship focused and auditable; the 22 failures aren't blocking real-world OAuth functionality.
- The execSync env-inheritance pattern is now documented in test/e2e/serve-http-oauth.test.ts as a reference fix for the next maintainer.
- Unblocks v0.26.2 ship while preserving the failure inventory for the follow-up.

**Cons:**
- 22 failing tests on master is real test-infra debt.
- Some may be load-bearing (sync pipeline failures could mask real regressions in `performSync`).
- `bun run ci:local` (full E2E gate) won't pass cleanly until these are addressed.

**Context:** Discovered during v0.26.2 ship audit. Reproduce with `bun test 2>&1 | grep "^(fail)"` after copying `.env.testing` from a sibling worktree (port 5435 test DB running). The 17/17 OAuth E2E suite passes in isolation AND in full-suite after the env-inheritance fix landed.

**Effort:** L (human ~4-8h; CC ~30-60min once env-inheritance fix is applied across all tests).

**Depends on / blocked by:** None — independent of v0.26.2.

## ci-local-mirror

### CI-skip artifact + signature for stages 1+2 follow-up
**Priority:** P0

**What:** After a successful local CI run via `bun run ci:local`, write `.ci-cache/passed-<commit-sha>.json` containing `{commit, test_set_hash, bun_version, schema_hash, signature}`. Push to a `ci-cache` orphan branch (or GH Releases). CI's first step fetches the artifact for the current SHA and skips the test job if (a) signature matches Garry's GPG/SSH key, and (b) `test_set_hash` matches what CI would have run.

**Why:** Stages 1+2 (shipped in this branch) give a strong local CI gate, but PR CI still re-runs every test on every push. Stage 3 closes the loop and trades ~10 min of CI wall-time for sub-second artifact verification on Garry's own pushes. External PRs are unaffected because the signature won't match — they hit the normal CI path.

**Pros:**
- ~10 min/PR saved on Garry's own pushes; the local gate becomes the source of truth.
- External contributor PRs untouched (no security regression).
- Forces a clear test-set-hash contract: any drift in what local-vs-CI run is caught at verification time.

**Cons:**
- Trust model needs careful design: signature scheme, key rotation, what happens when signature verification fails.
- Cache invalidation is real — if env or service version drifts between local run and CI, a stale local pass could ship to master.
- Adds a `ci-cache` branch / artifact storage surface to maintain.

**Context:**
- Discussed during the eng-review of the local CI mirror plan at `~/.claude/plans/lets-do-1-2-dockerfile-ci-zany-charm.md`.
- Don't start until stages 1+2 have been used for ~2 weeks AND the `scripts/e2e-test-map.ts` has stabilized (so test_set_hash is a meaningful identity).
- Initial trust-but-verify: run both local and CI in parallel for ~1 week before flipping the skip; alert on any disagreement.

**Effort:** M (human ~2-3 days + ~1 week trust-but-verify period running both local + CI in parallel; CC ~1 day for the mechanics).

**Depends on / blocked by:** Stages 1+2 (this PR) landing first.

### test/e2e/multi-source.test.ts cascade test isn't isolated
**Priority:** P1

**What:** The "sources remove cascades to pages + chunks + timeline + links + files" test in `test/e2e/multi-source.test.ts:281` fails when the file runs after other E2E files in the sequential `bash scripts/run-e2e.sh` order, but passes 20/20 on a fresh Postgres volume. The failing assertion is `SELECT COUNT(*) FROM links WHERE from_page_id = aliceId` expecting 0, getting 1 — so a prior file's setup left a `links` row that references a page id the cascade test happens to reuse. The test's own `setupDB()` truncates but doesn't sweep all referencing rows back when ids collide.

**Why:** Surfaced when `bun run ci:local` (this PR's local CI gate) ran the full sequential E2E. CI never catches it because `.github/workflows/e2e.yml:40` only runs `mechanical.test.ts + mcp.test.ts` on PRs and nightly Tier 1. So 27 of 29 E2E files including this one aren't actually exercised by CI today. The local gate is stronger and surfaces real cross-file isolation gaps.

**Pros:**
- Fixing isolation makes `bun run ci:local` (full E2E) reliably green.
- Same fix likely to harden other E2E files that share id namespaces.
- Lets us turn `bun run ci:local` into a real ship gate.

**Cons:**
- Could require a per-file "namespace your test ids" pattern, ~30 min per affected file across the suite.

**Context:**
- Repro: `bash scripts/run-e2e.sh test/e2e/multi-source.test.ts` against a stale DB after other E2E files have run → fails. Same against a fresh `docker compose down -v && up -d postgres` → passes 20/20.
- The test inserts a hardcoded `cascadetest` source id and `aliceId` page id; collisions across runs are predictable.
- Likely fix: use `mkdtemp`-style randomized source/page ids per test, OR have the test do a deeper reset (DELETE FROM all five tables in beforeEach) instead of relying on `setupDB`'s TRUNCATE behavior.

**Effort:** S (CC ~30 min for the multi-source.test.ts fix; M if we audit all 29 E2E files for similar id-collision risk).

**Depends on / blocked by:** Nothing.

### scripts/run-e2e.sh:71 echo overflows on large-output failing tests
**Priority:** P2

**What:** When an E2E test fails AND prints lots of output (e.g., `multi-source.test.ts` floods postgres NOTICE objects), `scripts/run-e2e.sh:71` does `echo "$output"` against a multi-megabyte shell variable. The host pipe to docker-compose-run hits `EAGAIN` and fails with `echo: write error: Resource temporarily unavailable`. With `set -e`, the script aborts at that point, skipping the remaining E2E files and the final SUMMARY block.

**Why:** When the local CI gate finds a real failure (per the multi-source.test.ts entry above), the user wants to see it AND see how the rest of the suite did. Currently the failure shadows the rest.

**Pros:**
- See all E2E failures from a single run instead of needing to bisect.
- Quick win, ~5 lines.

**Cons:**
- None worth listing.

**Context:**
- Reproduced live during plan verification on 2026-04-29. Previous `multi-source.test.ts` failure killed the script before postgres-bootstrap, postgres-jsonb, etc. could run.
- Likely fix: replace `echo "$output"` with `printf '%s\n' "$output"`, or write `$output` to a tmpfile and `cat` it (handles large blobs better than echo over pipes), or pipe through `stdbuf -o0`.
- Don't suppress the postgres NOTICE flood at the test layer — that's separate; here we just want the script to not die when bun's stderr is verbose.

**Effort:** S (human or CC: ~10 min).

**Depends on / blocked by:** Nothing.

## claw-test E2E (v0.22.16 follow-ups)

### Hermes runner — `src/core/claw-test/runners/hermes.ts`
**Priority:** P2

**What:** Add a Hermes implementation of the `AgentRunner` interface. v1 ships only OpenClaw; v1.1 lands hermes once we have real friction reports from openclaw to validate the contract against.

**Why:** Cross-agent diff (`gbrain friction diff --base openclaw --compare hermes`) is the highest-leverage next signal. Friction unique to one agent vs common-to-both separates "agent contract bug" from "gbrain bug" automatically.

**Effort:** S (CC ~30m). Depends on: v1 openclaw runner producing real friction reports first.

---

### Friction analytics suite — `diff` / `trend` / `migration-stub`
**Priority:** P2

**What:** Three new `gbrain friction` subcommands deferred from v1:
- `gbrain friction diff --base <run-or-agent> --compare <run-or-agent>` (cross-agent comparison; ~80 LOC)
- `gbrain friction trend [--since <version-or-date>] [--phase <name>]` (time-series across runs; ~60 LOC)
- `gbrain friction migration-stub [--threshold N]` (clusters friction by phase + tokens, emits `skills/migrations/v[N+1].md` stub; ~150 LOC)

**Why:** Turns point-in-time reports into a slope. Pairs with the v1.1 public scoreboard.

**Effort:** M (CC ~2h total).

---

### Scenario expansion — `supabase-migration` and `supervisor-restart`
**Priority:** P2

**What:** Two more scenarios under `test/fixtures/claw-test-scenarios/`:
- `supabase-migration` — `gbrain init --pglite` then `gbrain migrate --to supabase`; verifies the cross-engine migration path
- `supervisor-restart` — kill worker mid-job; verify supervisor recovers without data loss

**Why:** These are the other highest-historical-pain regression points (per CLAUDE.md fix-wave history). v1 ships only `fresh-install` + `upgrade-from-v0.18` because Codex flagged that mixing them dilutes the fresh-install signal; v1.1 lands them as separate scenarios.

**Effort:** M (CC ~1h each).

---

### Real v0.18 SQL dump for upgrade scenario
**Priority:** P2

**What:** The `upgrade-from-v0.18` scenario ships scaffolded — `seed/dump.sql` is missing. The harness gracefully no-ops the seed phase when absent, so the scenario currently behaves like fresh-install. v1.1: generate a real v0.18-shape PGLite dump per the procedure documented in `test/fixtures/claw-test-scenarios/upgrade-from-v0.18/seed/README.md`.

**Why:** Without a real seed, the scenario doesn't actually exercise the migration chain forward-walk. That's the whole point of the upgrade scenario — proves issue #239/#243/#266/#357 class regressions stay fixed.

**Effort:** S (CC ~30m once a v0.18 checkout is handy). Depends on: ability to run a v0.18 gbrain build.

---

### Public scoreboard — `gbrain-evals.io/friction`
**Priority:** P3

**What:** Sibling-repo PR in `garrytan/gbrain-evals` that renders friction JSONL into a public dashboard. Friction count per version per agent, line charts over time. v1's JSONL already includes `gbrain_version` + `agent` tags so the scoreboard is a thin layer on top.

**Why:** Marketing surface. Proves install quality is improving release-over-release. The friction loop becomes visible to the world, not just maintainers.

**Effort:** M. Depends on: a working live mode and ≥10 real friction reports.

---

### PTY-mode transcript capture
**Priority:** P3

**What:** `transcript-capture.ts` currently uses plain `child_process.spawn` pipes. Some agents only emit ANSI colors / progress UI on a TTY. v1.1 adds a PTY mode (likely via `node-pty`) so live-mode transcripts capture the full agent UX.

**Why:** Faithful transcripts make the friction → reasoning link more useful. v1 accepts that some agent UI is lost.

**Effort:** S (CC ~30m). Mostly a ~30 LOC swap inside `spawnWithCapture`.

---

### Read-side host-isolation (`$GBRAIN_HOST_HOME`)
**Priority:** P3

**What:** v0.22.16 confined every `~/.gbrain` write site to honor `$GBRAIN_HOME`. But `src/commands/init.ts:299-313` still reads real `~/.claude` / `~/.openclaw` / `~/.codex` / `~/.factory` / `~/.kiro` for module fingerprinting (host detection). Even with write-isolation, a claw-test running on a developer's box discovers their real installed mods. v1.1: add a separate `$GBRAIN_HOST_HOME` override for the read-side detection so the claw-test can run truly hermetic.

**Why:** v1's hermeticity contract is "writes are isolated, reads are not." v1.1 closes the read-side gap.

**Effort:** S (CC ~30m).

---

### Routing-callout sweep — annotate skills the claw-test exercises
**Priority:** P3

**What:** `skills/_friction-protocol.md` is a cross-cutting convention. v1.1: sweep the 4–6 skills the claw-test actually exercises (setup, brain-ops, query, ingest, smoke-test, the migrations the test covers) and add a `> **Convention:** see [skills/_friction-protocol.md](_friction-protocol.md).` callout via the existing `src/core/dry-fix.ts` shape so DRY auto-fix doesn't fight it.

**Why:** Right now agents only call `gbrain friction log` if they find the protocol skill on their own. The callouts route them there proactively from any harness-exercised skill.

**Effort:** S (CC ~15m).

---

## minions / worker (v0.22.14 follow-ups)

### v0.22.15 — Embed cooperative-abort (HIGHEST PRIORITY — daily pain)
**Priority:** P0

**What:** Plumb `signal: AbortSignal` through `runPhaseEmbed` →
`src/commands/embed.ts` → `embedBatch` in `src/core/embedding.ts`. Check
`signal?.aborted` between OpenAI batch calls (every ~100 texts, ~2s
real-time) and between slugs in the per-slug loop.

**Why:** Embed phase ignores `signal.aborted` between batches today. Job
wall-clock timeout fires → handler keeps running → cycle's finally block
unreachable → `gbrain_cycle_locks` row stays held indefinitely. Every
subsequent autopilot cron cycle sees `cycle_already_running` → skips. Lock
TTL is 30 min; new cycles give up before that. Doctor reports UNHEALTHY.

**The chain in production:** ~5min cron submits cycle → 22K stale pages →
embed phase takes 10–15 min → 600s timeout fires → job dead-lettered → embed
keeps running → lock held → all subsequent cycles skip. Garry hits this
DAILY on his production brain.

**Pros:** Closes the daily wedge. Makes timeouts actually effective. Lets
operators bump worker timeouts confidently knowing abort actually stops
work.

**Cons:** Touching the embed hot path; small risk of botching the abort
checks. Mitigation: between-batch granularity (~2s), not per-text (too fine)
or per-slug (too coarse for 500+ chunk slugs).

**Context:** PR #503 (v0.22.14) catches the SYMPTOM (worker stalled, queue
piling up) via self-health-monitoring. This PR catches the CAUSE for one
specific failure class. Both fixes are needed; they're complementary, not
duplicative.

**Files to touch:**
- `src/core/cycle.ts:579` — `runPhaseEmbed(engine, dryRun)` → add
  `signal?: AbortSignal` arg
- `src/core/cycle.ts:803` — pass `opts.signal` through
- `src/commands/embed.ts:~363` — accept signal, check between slugs
- `src/core/embedding.ts:51-56` — `embedBatch(texts, onProgress?, signal?)`,
  check between for-loop iterations of `BATCH_SIZE` slices

**Tests required:**
1. embedBatch checks signal between OpenAI calls; aborts within one batch (~2s)
2. Per-slug loop in `embed.ts` checks signal between slugs
3. End-to-end: cycle handler with embed phase + signal aborted mid-flight →
   finally runs → `gbrain_cycle_locks` row deleted
4. Regression: 1K+ chunks scenario — embed does NOT block lock release when
   timeout fires

**Effort:** M (human: ~3 hr / CC: ~30 min).

**Depends on / blocked by:** Nothing. v0.22.14 ships first.

### v0.23+ — Bare-worker engine reconnect parity with supervisor
**Priority:** P2

**What:** Extract the supervisor's reconnect-then-fail pattern into
`MinionWorker` so bare workers can retry transient DB blips before exiting.
Today the supervisor calls `engine.reconnect()` after 3 consecutive DB health
failures (#406); the bare worker just emits `'unhealthy'` and the CLI calls
`process.exit(1)`.

**Why:** Bare-worker behavior is more disruptive than supervised behavior on
transient PgBouncer blips. A bare worker restarts the entire process; a
supervised worker just reconnects the pool. Operationally the supervisor
approach is gentler (no in-flight job loss, no PM restart latency).

**Pros:** Unifies bare and supervised behavior. Reduces process churn on
transient network blips.

**Cons:** More code in MinionWorker; risk of reconnect masking a real
problem. Mitigation: cap retry attempts, fall through to `'unhealthy'`
emission after the cap.

**Context:** Filed during v0.22.14 plan-eng-review. The asymmetry is
documented in v0.22.14 CHANGELOG as deliberate; this TODO captures the
"unify someday" intent.

**Effort:** S (human: ~2 hr / CC: ~20 min).

**Depends on / blocked by:** Nothing.

### v0.23+ — `minion_workers` heartbeat table for queue_health doctor (B7)
**Priority:** P3

**What:** Add a `minion_workers` table (`worker_id` PK, `hostname`,
`last_heartbeat`, `queue`, `concurrency`, `started_at`) so the existing
`queue_health` doctor check (Postgres path) can detect dead workers via
heartbeat staleness instead of relying on the indirect `lock_until` proxy.

**Why:** v0.19.1 added `queue_health` checks for stalled-active jobs and
waiting-depth threshold. The worker-heartbeat subcheck was deferred (B7)
because the `lock_until`-on-active-jobs proxy can't distinguish "worker
exited cleanly" from "worker idle" — a check that cries wolf erodes trust
in every doctor check. With a real heartbeat row, doctor can say "no worker
seen in N intervals" with confidence.

**Pros:** Doctor's `queue_health` becomes ground-truth. Detects "worker
container died but cron didn't restart it" scenario.

**Cons:** New table, schema migration, every health-tick UPSERTs. Costs
a write per worker per minute (default).

**Context:** Filed during v0.22.14 plan-eng-review. PR #503's self-health
monitoring is the worker-side liveness; this would be the queue-side
ground-truth.

**Effort:** M (human: ~1 day / CC: ~1 hr).

**Depends on / blocked by:** Schema migration system; nothing else.

## sync (v0.22.13 follow-up — PR #490 review)

### D-PR490-1 — Plumb resolved `database_url` through `SyncOpts`
**Priority:** P3

**What:** Add `database_url?: string` (or a richer `resolvedConnection` shape) to
`SyncOpts` and have the caller (`runSync`, the cycle handler, the jobs handler)
populate it from the active engine instead of having `performSync` /
`performFullSync` / `import.ts` each call `loadConfig()` separately. Today every
sync run hits the config file three times.

**Why:** v0.18 multi-source brains can in principle run different sources against
different `database_url` endpoints (or different per-source overrides via
`sources.config_jsonb`). Right now `loadConfig()` returns the global config, and
that always matches the engine in practice — but the convention papers over a
real divergence the moment someone wants per-source connection settings. Folding
the resolution into `SyncOpts` makes the worker-engine creation in `sync.ts` and
`import.ts` deterministic from `SyncOpts` alone.

**Pros:**
- Removes 3 redundant `loadConfig()` calls per sync.
- Makes `performSync` / `performFullSync` side-effect-free with respect to the
  on-disk config file.
- Sets up for per-source `database_url` overrides without further refactor.
- Makes the v0.22.13 belt-and-suspenders fallback (PR #490 Q3) cleaner — no
  more `!config?.database_url` short-circuit inside the parallel branch.

**Cons:**
- API-shape change to `SyncOpts` (mild; not externally exported).
- Touching three callers (`runSync`, jobs handler, `cycle.ts` `runPhaseSync`).
- Only worth doing when paired with a per-source override story; otherwise
  it's just plumbing.

**Context:** Surfaced during the PR #490 plan-eng-review (parallel sync).
Deferred because it isn't on the v0.22.13 critical path. The same pattern would
benefit the cycle handler and the autopilot daemon. See the plan-eng-review
decisions log: A4 = "Defer; file as TODO."

**Depends on / blocked by:** Nothing structural. Best paired with the v0.18
per-source `config_jsonb` work if/when that lands.

## sync error-code classification (PR #501 follow-ups)

### Plumb structured `ParseValidationCode` through `ImportResult`
**Priority:** P2

**What:** Replace the regex-on-error-message path in `src/core/sync.ts:classifyErrorCode`
with a structured `code` field threaded through `ImportResult` from the parse layer.

Three changes:
1. `src/core/import-file.ts:362` — call `parseMarkdown(content, relativePath, { validate: true, expectedSlug })`
   so `parsed.errors[0].code` is populated.
2. `src/core/import-file.ts` — add `code?: string` to `ImportResult`. Promote the
   structured code (or `'SLUG_MISMATCH'` when the existing expectedSlug check trips)
   into the result envelope alongside `error`.
3. `src/commands/sync.ts:488` — extend `failedFiles` shape with `code?: string`.
   `recordSyncFailures` already accepts the field; the only thing missing is the
   capture site populating it.
4. `src/core/sync.ts:classifyErrorCode` — keep as a fallback for un-coded errors
   (DB exceptions, generic catches). Primary path reads the structured code.

**Why:** The repo already has `ParseValidationCode` + `ParseValidationError` in
`src/core/markdown.ts:5-18`, and three other consumers (`src/commands/lint.ts:72`,
`src/commands/frontmatter.ts:148`, `src/core/brain-writer.ts:314`) read structured
errors directly. Sync is the outlier — it calls `parseMarkdown` without validation
and reverse-engineers codes via regex. PR #501 shipped that regex out of pragmatism;
this TODO removes ~50% of `classifyErrorCode` and eliminates a class of false-positives.

**Pros:**
- One source of truth for parse codes (the enum in `markdown.ts`).
- Eliminates regex fragility — adding a new validation code in `markdown.ts`
  automatically flows to sync without a new regex.
- Closes the case where canonical messages (`File is empty...`, `No closing ---...`)
  don't match aspirational regex patterns.

**Cons:** Touches `ImportResult` interface, which ripples through `src/commands/import.ts:105`,
`src/commands/sync.ts:498-510`, `src/core/cycle.ts`, brain-writer reconciler.

**Context:** PR #501 documented this as P3 in the eng review at
`~/.claude/plans/then-codex-synchronous-toucan.md`. Codex's outside-voice review
agreed independently. The fix is small — ~50 lines including tests + downstream
call sites — and it's the correct architectural endpoint.

**Effort:** M (human: ~2 hr / CC: ~20 min).

**Depends on / blocked by:** Nothing.

### CHANGELOG migration note for `acknowledgeSyncFailures()` shape change
**Priority:** P0 — required at /ship time

**What:** When PR #501 ships, the release CHANGELOG entry MUST include this
`### For contributors` block:

```markdown
### For contributors

`acknowledgeSyncFailures()` now returns `{count, summary}` instead of `number`.
If you import this directly from `gbrain/sync`, replace `n` with `result.count`
and use `result.summary` for the new code-grouped breakdown.
```

**Why:** The function is exported from `src/core/sync.ts:433` and reachable via
the package exports map. External TS consumers (gbrain-evals, host agent forks)
that imported it got `number` and now get an object — silent type break.

**Effort:** XS (human: ~1 min). Just don't forget.

**Depends on / blocked by:** PR #501 ship.

### Concurrent-safe ack of `~/.gbrain/sync-failures.jsonl`
**Priority:** P3

**What:** Two concurrent `gbrain sync` runs hitting `acknowledgeSyncFailures()`
can clobber each other. The function does a whole-file `writeFileSync` rewrite
(`src/core/sync.ts:433-455`); `recordSyncFailures()` does independent
`appendFileSync` (`src/core/sync.ts:395-416`). Concurrent ack + append can lose rows.

**Why:** Pre-existing — predates PR #501. Real risk only on autopilot setups where
multiple sync invocations might overlap (rare today, more likely as multi-source
sync matures).

**Fix sketch:** Atomic rename pattern (write to `sync-failures.jsonl.tmp`, then
`renameSync`) plus a file lock for the read-modify-write cycle. Or move the
acknowledged-set to the DB.

**Effort:** S (human: ~1 hr / CC: ~10 min).

**Depends on / blocked by:** Nothing.

## test-infra

### Parallel-load timeout flake on v0.21 PGLite-heavy tests
**Priority:** P0

**What:** 22 tests added in v0.21.0 (Code Cathedral II) consistently fail in the full `bun test` run with timeout-pattern elapsed times of 7-10s, but pass in isolation. Every failing test calls `engine.initSchema()` in `beforeAll` without a timeout extension. Under parallel load (168 test files now run concurrently after v0.21 added ~24 new files), `initSchema` exceeds bun's default 5s `beforeAll` timeout.

Affected files include (non-exhaustive): `test/sync-strategy.test.ts`, `test/cathedral-ii-brainbench.test.ts`, `test/code-edges.test.ts`, `test/reindex-code.test.ts`, `test/reconcile-links.test.ts`, `test/two-pass.test.ts`, `test/parent-symbol-path.test.ts`, `test/pglite-v0_19.test.ts`.

**Why:** Currently triaged as "skip pre-existing, ship anyway" but that's not a real fix. Blocks /ship for anyone whose CHANGELOG-time test run sees them.

**Pros:** Fixing it lets /ship run cleanly without manual triage every release.

**Cons:** ~22 file edits adding `beforeAll(async () => {...}, 30000)` is mechanical but dull.

**Context:** Same pattern fixed in v0.20.5 wave for `test/e2e/minions-shell-pglite.test.ts`. Single-file repro: each fails in `bun test`, passes in `bun test <file>`. Reproduces with my changes stashed, so it's on master.

**Effort:** S (human: ~30 min / CC: ~5 min). Mechanical: grep for `beforeAll(async () => {` in affected files, add `, 30000)` argument.

**Depends on / blocked by:** Nothing.

## resolver / check-resolvable (v0.22.4 follow-ups)

### D10 — Extend `check-resolvable` to parse RESOLVER.md disambiguation rules
**Priority:** P2

**What:** Extend `src/core/check-resolvable.ts:357-390` to parse a structured
disambiguation block in `RESOLVER.md` (e.g. a `## Disambiguation rules`
numbered list with parseable `<trigger>` → `<winning-skill>` shape) and treat
resolved overlaps as non-issues. Then the action message at
`src/core/check-resolvable.ts:388` ("Add disambiguation rule in RESOLVER.md OR
narrow triggers") stops lying about the OR — currently only the second branch
silences the warning.

**Why:** The current MECE-overlap fix path forces authors to delete user-facing
triggers from skill frontmatter. That's wrong for cases where two skills
legitimately respond to the same phrase under different contexts (e.g.
"citation audit" → focused fix vs broader brain health). A real
disambiguation parser would let `RESOLVER.md` carry the resolution while
keeping both skills' triggers intact for chaining.

**Pros:**
- The action message stops misleading users.
- v0.22.4 D2 used the "narrow triggers" path because the disambiguation
  parser doesn't exist yet; landing this would let v0.23+ keep dual triggers
  for genuinely-overlapping skills.
- Aligns RESOLVER.md's stated role (the dispatcher) with what the checker
  actually reads.

**Cons:**
- Introduces a new `RESOLVER.md` syntactic contract that other tooling now
  has to respect (parser, lint, downstream forks reading the same file).
- Risk of false-positive resolution if the parser is loose.
- ~80 lines of parser + tests; not blocking anything in v0.22.4.

**Context:**
- The "OR" in the action message is misleading today. Confirmed at
  `src/core/check-resolvable.ts:388`.
- The MECE detector loop is at `src/core/check-resolvable.ts:357-390`.
- The disambiguation rules already exist as prose in
  `skills/RESOLVER.md` (the citation-audit row added in v0.22.4 is the
  pattern). They're agent-facing routing hints today, not parsed structure.

**Effort:** S (human: ~4-6 hours / CC: ~30 min for parser + 12-16 test cases).

**Depends on / blocked by:** Nothing.

## code-indexing (v0.21.0 Cathedral II follow-ups)

### B2 — Magika auto-detect for extension-less files (Layer 9 deferred)
**Priority:** P2

**What:** Embed Google's Magika ML classifier (~1MB ONNX) as a bundled asset. Wire into `detectCodeLanguage` as the fallback for files with no recognized extension (Dockerfile, Makefile, `.envrc`, shell scripts with shebangs but no `.sh`). The chunker already has `setLanguageFallback(fn)` as a module-level hook.

**Why:** v0.20.0 widens the file classifier from 9 to 35 extensions (Layer 2), covering most real-world cases. Extension-less files still slip through to recursive chunks. Magika would close the last common case.

**Pros:** Completes the file-classification story. Unblocks chunker on real-world configs + build scripts.

**Cons:** ~1MB asset bundled with `bun --compile`. Integration risk: Magika's ONNX runtime needs WASM compat with bun. The plan explicitly allowed deferring B2 because bundling surprises late in implementation are costly.

**Context:**
- `src/core/chunkers/code.ts` exports `setLanguageFallback(fn: LanguageFallback | null)` — call at process start with a Magika-powered classifier.
- `detectCodeLanguage(filePath, content?)` already accepts optional content for fallback paths.
- The NPM `magika` package is the first thing to try; needs bun-compile compatibility verification.

**Effort:** M (human: ~2-3 days / CC: ~2 hours for the integration + CI guard).

**Depends on / blocked by:** Nothing. Hook is in place as of v0.20.0.

### A4 — full doc_comment extraction at chunk time
**Priority:** P2

**What:** When the chunker emits a method/class/function, look at the comment node(s) immediately preceding the declaration and persist them as `content_chunks.doc_comment`. The FTS trigger from Layer 1b already weights `doc_comment` 'A' above `chunk_text` 'B' — the ranking is ready, the column is populated NULL today.

**Why:** "how does X handle N+1" should rank the docstring that explains N+1 above the function body or any prose paragraph. Layer 1b paved the ranking half; extraction is the remaining half.

**Pros:** Material MRR lift on natural-language queries. Zero schema work (column + trigger already in place).

**Cons:** Per-language convention detection — JSDoc blocks, Python docstrings (first string expression in a function body), C-style doc comments, etc. Not hard but each language has edge cases.

**Context:**
- `src/core/chunkers/code.ts` emits chunks in `chunkCodeTextFull`. Walk each declaration's preceding sibling(s) for comment nodes.
- ChunkInput already has `doc_comment?: string`. Populate at chunk time and it flows through `upsertChunks` (Layer 6 wired those columns).
- Per-language config: leading-comment type names per language (`comment`, `line_comment`, `block_comment`, `documentation_comment`).
- Test hook: `test/cathedral-ii-brainbench.test.ts` has a `doc_comment_matching` placeholder — flesh it out end-to-end.

**Effort:** M (human: ~2 days / CC: ~90 min for the 8 Layer-5 langs).

**Depends on / blocked by:** Nothing. Layer 1b + Layer 6 both in place.

### C6 — gbrain code-signature "(A, B) => C"
**Priority:** P3 (stretch)

**What:** Type-signature retrieval via tree-sitter type captures per language. "Find every function whose signature returns a Promise<User>" or "(string, number) => boolean".

**Why:** Each language's type system is its own mini-cathedral. Ship per-language rather than as one item.

**Effort:** L per language (typescript-first).

**Depends on / blocked by:** Nothing — additive on the Layer 5 edge schema.

### Cross-file edge resolution (Layer 5 precision upgrade)
**Priority:** P3

**What:** Today every call edge lands unresolved in `code_edges_symbol` with to_symbol_qualified = bare callee name. Second-pass resolution: after all code files import, walk every `code_edges_symbol` row and try to resolve `to_symbol_qualified` via `symbol_name_qualified` join; if found within the same source, write a resolved row to `code_edges_chunk`.

**Why:** `getCallersOf("searchKeyword")` currently returns the Layer 6 ambiguity — every `searchKeyword` call site in any class. Receiver-type analysis lifts this.

**Effort:** L. Needs receiver-type inference; can ship per-language.

**Depends on / blocked by:** Nothing — UNION-on-read path keeps unresolved edges surfaced even without this.

## P3 — Dev experience: test suite parallelism on fast multi-core machines

**Context:** `bun test` on M-series Macs spawns ~1 worker per core. `test/dream.test.ts` (5 describe blocks, 11 tests) and `test/orphans.test.ts` create a fresh PGLite engine in `beforeEach` that runs ~20 schema migrations per test. Under parallel load, WASM-instance contention causes ~18 `beforeEach` timeouts at 5–9s.

**Evidence:** CI (ubuntu-latest, fewer cores) is green on every PR. Running the suspect files in isolation (`bun test test/dream.test.ts test/orphans.test.ts`) is also green. Reproduces only on fast multi-core local machines running the full 136-file parallel suite.

**Fix:** move engine creation from `beforeEach` to `beforeAll` per describe block; add a data-reset helper (delete-all-rows-in-relevant-tables) between tests. ~80 LOC change across two test files.

**Priority:** P3 because production CI is unaffected. Hits local dev iteration speed on fast Macs.

**Found:** 2026-04-24 during v0.19.0 production-readiness review.

## Completed

### ~~Checks 5 + 6 for check-resolvable~~
**Completed:** v0.19.0 (2026-04-22)

Both checks shipped as real implementations, not just filed issues:
- **Check 5 (trigger routing eval):** `src/core/routing-eval.ts` + `gbrain routing-eval` CLI. Structural layer runs in `check-resolvable` by default; `--llm` opts into LLM tie-break. Fixtures live at `skills/<name>/routing-eval.jsonl`.
- **Check 6 (brain filing):** `src/core/filing-audit.ts` + `skills/_brain-filing-rules.json`. New `writes_pages:` + `writes_to:` frontmatter. Warning-only in v0.19, error in v0.20.

`DEFERRED[]` in `src/commands/check-resolvable.ts` is now empty — v0.19 shipped both deferred checks as working code paths, not as issue URLs. The export stays in place for future deferred checks.

### ~~BrainBench Cats 5/6/8/9/11 — shipped to sibling repo~~
**Completed:** v0.20.0 (2026-04-23)

All five previously-deferred BrainBench categories shipped as working runners
in the sibling repo [github.com/garrytan/gbrain-evals](https://github.com/garrytan/gbrain-evals):

- **Cat 5 Provenance** — `eval/runner/cat5-provenance.ts` with dedicated `classify_claim` tool (3-way label: `supported | unsupported | over-generalized`)
- **Cat 6 Prose-scale auto-link precision** — `eval/runner/cat6-prose-scale.ts` (baseline-only) + `eval/runner/adversarial-injections.ts` (6 injection kinds)
- **Cat 8 Skill Compliance** — `eval/runner/cat8-skill-compliance.ts` (brain-first / back-link / citation-format / tier-escalation, deterministic from tool-bridge trace)
- **Cat 9 End-to-End Workflows** — `eval/runner/cat9-workflows.ts` (rubric-graded)
- **Cat 11 Multi-modal Ingestion** — `eval/runner/cat11-multimodal.ts` (PDF/audio/HTML)

Plus supporting infrastructure: agent adapter (Sonnet + 12 read + 3 dry_run tools),
structured-evidence Haiku judge contract, PublicPage/PublicQuery sealed qrels,
6-artifact flight-recorder, 6 portable JSON schemas for v1→v2 driver swap.

Scope pivot: originally planned for in-tree v1.1 delta; mid-PR pivoted to extract
the entire eval harness so gbrain users don't download the ~5MB corpus at install
time. BrainBench is now a public sibling benchmark; gbrain ships clean.

### ~~v0.10.5: inferLinkType residuals (works_at, advises)~~
**Completed:** v0.20.0 (2026-04-23)

`src/core/link-extraction.ts` — WORKS_AT_RE and ADVISES_RE expanded with
rank-prefixed engineer patterns ("senior/staff/principal/lead engineer at"),
discipline-prefixed ("backend/frontend/ML/security engineer at"), broader role
verbs ("manages engineering at", "running product at", "heads up X at"),
possessive time ("his/her/their time at"), role-noun forms ("tenure as",
"stint as", "role at"), advisory capacity phrasings, "as an advisor" forms,
and qualifier-specific advisors. New EMPLOYEE_ROLE_RE prior fires for
self-identified employees at the page level, biasing outbound company refs
toward works_at when per-edge verbs are absent. Precedence: investor > advisor
> employee. Existing tests in `test/link-extraction.test.ts` cover the new
patterns.

## P1 (BrainBench v1.1 — remaining categories)

Cats 5/6/8/9/11 shipped to the sibling repo in v0.20.0 — see the Completed
section above. One remaining scope item:

### BrainBench Cat 1+2 at full scale
**What:** Existing benchmark-search-quality.ts (29 pages, 20 queries) and benchmark-graph-quality.ts (80 pages, 5 queries) currently pass at small scale. v1.1 extends both to 2-3K rich-prose pages generated via Opus to surface scale-dependent failures (tied keyword clusters, hub-node fan-out, prose-noise extraction precision).

**Why deferred from PR #188:** Needs ~$200-300 of Opus tokens for the rich corpus. The 80-page version already proves algorithmic correctness; scale-up proves it survives real-world load.

**Threshold:** maintain v1 metrics at 30x scale.

### ~~v0.10.4: inferLinkType prose precision fix~~
**Shipped in PR #188.** BrainBench Cat 2 rich-corpus type accuracy went from
70.7% → 88.5%. Fix: widened verb regexes (added "led the seed/Series A",
"early investor", "invests in", "portfolio company", etc.), tightened
ADVISES_RE to require explicit advisor rooting (generic "board member"
matches investors too), widened context window 80→240 chars, added
person-page role prior (partner-bio language → invested_in for outbound
company refs only). Per-type after fix: invested_in 91.7% (was 0%),
mentions 100%, attended 100%. works_at 58% and advises 41% are next
iteration's residuals.

### v0.10.4: gbrain alias resolution feature (driven by Cat 3)
**What:** Add an alias table to gbrain so "Sarah Chen" / "S. Chen" / "@schen" / "sarah.chen@example.com" resolve to one canonical entity. Schema: `aliases (id, slug, alias_text)` with a unique index. Search blends alias matches into hybrid scoring.

**Why:** BrainBench Cat 3 measured 31% recall on undocumented aliases — that's the v0.10.x baseline. With alias table, should jump to 80%+.

**Depends on:** Cat 3 baseline (shipped in PR #188).

## P1

### Minions shell jobs — Phase 2 scheduling (deferred from v0.13.0)

**What:** `minion_schedules` table + autopilot-cycle scanner that submits due shell jobs.

**Why:** v0.13.0 moves shell scripts to Minions but still leaves scheduling in the host crontab. Your OpenClaw's `scripts/service-manager.sh` + crontab is the only piece left on the host side. A DB-driven scheduler would mean a single `gbrain autopilot --install` replaces the host crontab entirely, scheduling is visible via `gbrain jobs list --scheduled`, and downtime-on-one-machine tolerance improves (schedule is shared DB state, not per-host crontab).

**Pros:** Canonical host-agnostic deployment. No more host-specific crontab.

**Cons:** Cross-engine migration complexity (new table on both PGLite + Postgres). Autopilot-cycle scanner needs to handle missed-schedule semantics (fire-once-on-startup or skip-if-past-now), and this is where every other cron-like system has historically accrued bugs.

**Depends on:** v0.13.0 shell jobs shipped. ✅

### `gbrain crontab-to-minions <file>` migration helper (deferred from v0.13.0)

**What:** Parse an existing crontab file, emit a proposed rewrite using `gbrain jobs submit shell ...` for each deterministic entry, keep LLM-requiring entries as-is.

**Why:** Hand-rewriting ~14 OpenClaw cron entries is error-prone and one-shot. A helper would make the migration reversible and auditable (diff the before/after crontab, dry-run the first N, commit).

**Pros:** Removes the "rewrite 14 lines by hand" tax every agent operator pays on adoption.

**Cons:** Crontab parsing is historically fiddly (5-field vs 6-field, `@hourly` aliases, Vixie extensions, env vars in crontab). Could misrewrite entries with shell substitution.

**Depends on:** v0.13.0 shell jobs shipped. ✅

### Batch the DB-source extract read path (deferred from v0.12.1)
**What:** `extractLinksFromDB` and `extractTimelineFromDB` at `src/commands/extract.ts:447, 504` issue one `engine.getPage(slug)` per slug after `engine.getAllSlugs()`. On a 47K-page brain that's still 47K serial reads over the Supabase pooler.

**Why:** v0.12.1 fixed the write-side N+1 with batched INSERTs (~100x fewer round-trips). The read side still does serial `getPage()` calls — each fetches `compiled_truth + timeline + frontmatter` (tens of KB per page). On a 47K-page Supabase brain that's ~10-20 minutes of read latency before any work happens. The v0.12.0 orchestrator's backfill uses `--source db`, so this stays slow until fixed.

**Pros:** Mirrors the write-side fix on the read path. Combined with batched writes, full re-extract on a 47K-page brain should drop from "minutes" to "seconds" end-to-end. Eliminates the implicit `listPages-pagination-mutation` learning risk by giving you a snapshot read.

**Cons:** New engine method (`getPagesBatch(slugs: string[]) → Promise<Page[]>` or a streaming cursor) needs to land on both PGLite and Postgres. Memory budget — a 47K-page brain with ~30KB/page is ~1.4GB if loaded all at once; needs chunked iteration (e.g., 500 slugs/query, stream-process).

**Context:** Codex's plan-time review and the testing/performance specialists at ship time both flagged this. Filed during v0.12.1 to ship the bug fix without scope creep. Approach: add `getPagesBatch(slugs)` returning chunked results, then update the 4 DB-source extract paths to consume it.

**Depends on:** v0.12.1 ships first.

### Batch embedding queue across files
**What:** Shared embedding queue that collects chunks from all parallel import workers and flushes to OpenAI in batches of 100, instead of each worker batching independently.

**Why:** With 4 workers importing files that average 5 chunks each, you get 4 concurrent OpenAI API calls with small batches (5-10 chunks). A shared queue would batch 100 chunks across workers into one API call, cutting embedding cost and latency roughly in half.

**Pros:** Fewer API calls (500 chunks = 5 calls instead of ~100), lower cost, faster embedding.

**Cons:** Adds coordination complexity: backpressure when queue is full, error attribution back to source file, worker pausing. Medium implementation effort.

**Context:** Deferred during eng review because per-worker embedding is simpler and the parallel workers themselves are the bigger speed win (network round-trips). Revisit after profiling real import workloads to confirm embedding is actually the bottleneck. If most imports use `--no-embed`, this matters less.

**Implementation sketch:** `src/core/embedding-queue.ts` with a Promise-based semaphore. Workers `await queue.submit(chunks)` which resolves when the queue has room. Queue flushes to OpenAI in batches of 100 with max 2-3 concurrent API calls. Track source file per chunk for error propagation.

**Depends on:** Part 5 (parallel import with per-worker engines) -- already shipped.

## P0

### PGLite test-runner concurrency flake (~27 false failures in full `bun test`)
**What:** Fix the concurrent-PGLite-init flake that surfaces ~27 `error: PGLite not connected. Call connect() first.` failures when `bun test` runs all 174 unit-test files together. Each failing file passes in isolation; failures only appear under full-suite parallelism.

**Why:** The failures are masking real signal. /ship and any solo dev running `bun test` has to manually triage 27 results every time. Today they're all in `test/cathedral-ii-pglite.test.ts`, `test/cathedral-ii-brainbench.test.ts` (Layer 5/6/7/8 + parent_scope_coverage + call_graph_recall), `test/sync.test.ts` (4 dry-run cases), `test/reindex-code.test.ts` (Layer 13 E2). All exist on master and date back to v0.12.3-v0.21.0 — pre-existing, not caused by any one branch.

**Context:** Confirmed pre-existing on master via `git diff origin/master...HEAD --stat -- <failing files>` returning empty. Tests pass cleanly in 1-3-file batches. Wall clock for the full suite is 596s. Likely root causes: (a) PGLite has a singleton or shared OPFS-like state that races under parallel `PGlite.create()` calls, (b) `test/cathedral-ii-pglite.test.ts` "fresh-install schema" tests assume exclusive PGLite access, (c) bun test concurrency exceeds what PGLite's WASM init can handle.

**Pros:** Green suite signal. Faster shipping. Stops eroding trust in `bun test`.

**Cons:** Likely needs PGLite engine-per-test isolation (each test gets its own dedicated engine instance via tmpdir) or a `bun test --concurrency=N` cap. Both touch test infra used by 50+ files.

**Effort:** M (human: 1 day to root-cause + implement / CC: ~2-3 hours via /investigate).

**Discovered:** v0.25.0 ship, 2026-04-25.

### Fix `bun build --compile` WASM embedding for PGLite
**What:** Submit PR to oven-sh/bun fixing WASM file embedding in `bun build --compile` (issue oven-sh/bun#15032).

**Why:** PGLite's WASM files (~3MB) can't be embedded in the compiled binary. Users who install via `bun install -g gbrain` are fine (WASM resolves from node_modules), but the compiled binary can't use PGLite. Jarred Sumner (Bun founder, YC W22) would likely be receptive.

**Pros:** Single-binary distribution includes PGLite. No sidecar files needed.

**Cons:** Requires understanding Bun's bundler internals. May be a large PR.

**Context:** Issue has been open since Nov 2024. The root cause is that `bun build --compile` generates virtual filesystem paths (`/$bunfs/root/...`) that PGLite can't resolve. Multiple users have reported this. A fix would benefit any WASM-dependent package, not just PGLite.

**Depends on:** PGLite engine shipping (to have a real use case for the PR).

### Runtime MCP access control
**What:** Add sender identity checking to MCP operations. Brain ops return filtered data based on access tier (Full/Work/Family/None).

**Why:** ACCESS_POLICY.md is prompt-layer enforcement (agent reads policy before responding). A direct MCP caller can bypass it. Runtime enforcement in the MCP server is the real security boundary for multi-user and remote deployments.

**Pros:** Real security boundary. ACCESS_POLICY.md becomes enforceable, not advisory.

**Cons:** Requires adding `sender_id` or `access_tier` to `OperationContext`. Each mutating operation needs a permission check. Medium implementation effort.

**Context:** From CEO review + Codex outside voice (2026-04-13). Prompt-layer access control works in practice (same model as Garry's OpenClaw) but is not sufficient for remote MCP where direct tool calls bypass the agent's prompt.

**Depends on:** v0.10.0 GStackBrain skill layer (shipped).

## P1 (new from v0.25.0 — eval-capture adversarial review)

### v0.25.0 eval-capture follow-ups (6 surgical hardenings)
**Priority:** P1

**What:** Six targeted hardenings on the v0.25.0 eval-capture surface, all surfaced by the /ship adversarial review and triaged out of the v0.25.0 PR to keep scope tight:

1. `gbrain eval prune --dry-run`: replace the `listEvalCandidates(limit:100k) + filter` count with a real `engine.countEvalCandidatesBefore(date)` method. Today the warning at `eval-prune.ts:107-109` honestly tells the user the count may be undercounted, but a brain with > 100k rows + old data could still confuse a careful operator. New `BrainEngine` method on both engines, ~30 LOC, lifts the floor count to a true count.
2. PII scrubber CC false-positive rate: 16-digit Luhn-valid order IDs / invoice numbers get redacted as `[REDACTED]`. Either require a contextual prefix (`card`, `cc`, `credit`) within N chars, or document the tradeoff explicitly in `docs/eval-capture.md`. The two approaches differ in coverage so list them as alternatives.
3. `eval_capture_failures.reason` enum: `'scrubber_exception'` is dead telemetry — no realistic path emits it (the scrubber is regex-only and never throws). Either remove the value from the schema CHECK + enum, OR wrap `scrubPii` in a try-catch inside `buildEvalCandidateInput` so the value is actually reachable.
4. `id DESC` tiebreaker docs: CLAUDE.md says "stable id-desc tiebreaker so `--since` windows never dupe/miss rows". This is true within a single call but doesn't prevent dupe/miss across overlapping windows when LIMIT < total. Either add a real `id`-cursor (`WHERE id < $cursor`) for export, or scope the doc claim to "within a single export call".
5. Public-exports canaries: 6 of 17 subpaths (`gbrain` root, `/minions`, `/engine-factory`, `/transcription`, `/backoff`, `/extract`) have `canary: []` — the test only checks the import resolves, so a barrel module accidentally losing its named exports would still pass. Pin one stable canary symbol per subpath.
6. `EXPECTED_COUNT` duplication: `scripts/check-exports-count.sh` and `test/public-exports.test.ts` both hardcode `17`. Drift risk. Make one read the other (or both compute from `package.json`).

**Why:** All 6 are real (some informational, some footgun-class) but each is small and surgical. Bundling into one v0.25.1 follow-up PR keeps the v0.25.0 ship clean and lets the fixes land with their own dedicated tests + CHANGELOG entry.

**Effort:** S total (human: ~half day / CC: ~1.5 hours).

**Discovered:** v0.25.0 ship adversarial review, 2026-04-25.

## P1 (new from v0.7.0)

### ~~Constrained health_check DSL for third-party recipes~~
**Completed:** v0.9.3 (2026-04-12). Typed DSL with 4 check types (`http`, `env_exists`, `command`, `any_of`). All 7 first-party recipes migrated. String health checks accepted with deprecation warning + metachar validation for non-embedded recipes.

## P1 (new from v0.18.0 — test flakiness)

### beforeAll hook timeouts under parallel test runner
**What:** 17 tests across 9 files (dream, orphans, brain-allowlist, extract-db, multi-source-integration, core/cycle, migrations-v0_12_2, migrations-v0_13_1, oauth) fail with `beforeEach/afterEach hook timed out for this test` at the 7-10 second threshold when run via `bun run test` (parallel). Every test passes in isolation (`bun test path/to/file.test.ts` → 0 fail). Root cause is PGLite schema init racing under concurrent test files.

**Why:** `bun run test` is the pre-ship gate and reports these as failures, forcing manual triage on every /ship. The tests themselves are correct — the runner is stressing PGLite boot. Bumping the hook timeout or running E2E-like tests with `--bail` or serial execution would clear the 18 false positives.

**Fix options:**
1. Bump per-test hook timeout to 30s in `bunfig.toml` (quick fix, low risk)
2. Move PGLite-init-heavy tests to `test/e2e/` so they run serially via `scripts/run-e2e.sh` (follows existing pattern)
3. Share a module-scoped PGLite instance across describe blocks within a file (biggest win — most fixture setup is identical)

**Effort:** 30 min for option 1, ~2 hours for option 3.

**Context:** Noticed during /ship merge wave on `garrytan/mcp-key-mgmt` (2026-04-16 branch merge of v0.18.0). Failure set stayed exactly 17-18 tests across multiple /ship runs, confirming deterministic flakes rather than real regressions. Blocking workaround: run the specific test file to verify after any suite change.

## P1 (new from v0.11.0 — Minions)

### Per-queue rate limiting for Minions
**What:** Token-bucket rate limiting per queue via a new `minion_rate_limits` table (queue, capacity, refill_rate, tokens, updated_at), with acquire/release in `claim()`.

**Why:** The #1 daily OpenClaw pain is spawn storms hitting OpenAI/Anthropic rate limits. `max_children` caps fan-out per parent, but a queue with 50 ready jobs will still slam the API. Every Minions consumer currently reinvents token-bucket in user code.

**Pros:** First-class rate limiting means no consumer has to roll their own. Composes with `max_children` (which is per-parent) to give two orthogonal throttles.

**Cons:** Adds a write hotspot on the rate-limit row. Mitigate by keeping it a simple `UPDATE ... WHERE tokens > 0 RETURNING` that fails fast and puts the claim back in the pool.

**Effort:** ~2 hours. Deferred from v0.11.0 to keep the parity PR at a reviewable size.

**Depends on:** Minions (shipped in v0.11.0).

### Minions repeat/cron scheduler
**What:** BullMQ-style repeatable jobs. `queue.add(name, data, { repeat: { cron: '0 * * * *' } })`.

**Why:** Idempotency keys (shipped in v0.11.0) are the foundation. Consumers currently use launchd/cron to fire `gbrain jobs submit`, but a native scheduler inside the worker would be cleaner and portable across deployments.

**Pros:** One mental model for both immediate and scheduled work. Idempotency prevents double-fire.

**Cons:** Every cron library has edge cases (DST, missed intervals on worker restart). Use a battle-tested parser.

**Effort:** ~1 day.

**Depends on:** Idempotency keys (shipped in v0.11.0).

### Minions worker event emitter
**What:** `worker.on('job:completed', handler)` / `worker.on('job:failed', ...)` instead of polling.

**Why:** Consumers currently poll `getJob(id)` to watch state changes. An event API is the ergonomic BullMQ has and Minions doesn't.

**Effort:** ~4 hours.

### `waitForChildren(parent_id, n)` / `collectResults(parent_id)` helpers
**What:** Convenience wrappers over `readChildCompletions` for common fan-in patterns.

**Why:** The `child_done` inbox primitive shipped in v0.11.0. Now add the ergonomic API on top so orchestrators don't have to write the polling loop.

**Effort:** ~2 hours.

**Depends on:** `child_done` inbox primitive (shipped in v0.11.0).

## P2

### Orchestrator + runner double-write to migrations ledger (deferred from v0.18.2 codex review)

**What:** `src/commands/migrations/v0_18_0.ts:200-208` appends an entry to `~/.gbrain/migrations/completed.jsonl` while `src/commands/apply-migrations.ts:374-386` also appends one for the same orchestrator run. The dedupe guard in `src/core/preferences.ts:120-131` only suppresses duplicate `complete` entries, not `partial` entries. Result: distorted wedge counting (3-consecutive-partials-triggers-wedge logic sees 6 partials when it should see 3).

**Why:** Codex plan-review caught this during PR #356 while verifying the two-migration-systems resume boundary. Not blocking v0.18.2 shipping because it only affects the wedge detection threshold, not correctness of the migration itself.

**Fix:** Pick one writer (prefer `apply-migrations.ts` runner as the single source of truth, remove the orchestrator-side append). Fold into `feat/agent-migration-devex` follow-up PR, which already touches both files for the migrate-command consolidation work.

**Depends on:** v0.18.2 shipped. ✅

### 22K-page resync is 30+ minutes on large brains (deferred from v0.18.2 codex review)

**What:** When a schema migration requires data backfill (e.g., computing `page_id` from `page_slug` across all `files` rows), `src/commands/sync.ts:248-251, 311-337` iterates per-file. None of v0.18.2's hardening work shrinks this path. On a 22K-page brain the resync takes 30+ minutes; at 500K pages it would be several hours.

**Why:** Codex explicitly called out that none of PR #356 or the two follow-up PRs addresses the resync execution model. This is a separate performance-design problem.

**Options to explore:**
- (a) Parallel page import via worker pool (Minions-based).
- (b) Bulk COPY-based import replacing the per-file INSERT.
- (c) Incremental resync that only rewrites changed rows (needs content hash or updated_at gating).

**Priority:** P2 now, upgrade to P1 if another heavy migration ships that needs backfill at this scale.

**Depends on:** v0.18.2 shipped. ✅

### Minions: `gbrain jobs stats --orphaned` (deferred from v0.13.0)

**What:** New CLI flag / output column surfacing jobs that are waiting with no registered handler on any live worker.

**Why:** v0.13.0 adds shell jobs that require `GBRAIN_ALLOW_SHELL_JOBS=1` on the worker. If an operator submits a shell job but no worker with the flag is running, the row sits in `waiting` silently. The CLI's starvation warning + docs help at submit time; this TODO surfaces the problem at operational-check time.

**Pros:** Closes the "did my cron actually run" ambiguity for multi-machine deployments.

**Cons:** Knowing "no worker has this handler registered" requires worker heartbeat tracking, which Minions doesn't have yet (it's stateless at DB level beyond `lock_token`). Could be approximated by "no jobs of this name have completed in last N minutes AND count of waiting is > 0."

**Depends on:** v0.13.0 shell jobs shipped. ✅

### Minions: AbortReason plumbing on MinionJobContext (deferred from v0.13.0)

**What:** Handlers today can't distinguish whether `ctx.signal.aborted` fired due to timeout, cancel, or lock-loss. v0.13.0 derives this at worker-catch-time from `abort.signal.reason`, but the handler can't see it directly. Expose `ctx.abortReason?: 'timeout' | 'cancel' | 'lock-lost' | 'shutdown'` on the context.

**Why:** Shell handler's kill-sequence today can't decide "retry this" (lock-lost) vs "don't retry, user cancelled" (cancel) — they look the same. A typed AbortReason lets handlers make that decision for themselves.

**Pros:** Handlers get richer signals.

**Cons:** Small surface-area addition to the handler API. Not strictly required since the worker already makes the retry/dead decision for them.

**Depends on:** v0.13.0 shell jobs shipped. ✅

### Minions: blocking-mode audit log for true forensic integrity (deferred from v0.13.0)

**What:** Opt-in mode for `shell-audit` where `appendFileSync` failures DO block submission instead of logging-and-continuing.

**Why:** v0.13.0 ships the audit log in best-effort mode, which means a disk-full attacker can silently disable the forensic trail. Acceptable for v0.13.0 because the primary use is operational ("what did this cron do last Tuesday"), not security forensics. Operators who want fail-closed semantics should have a flag.

**Pros:** Enables true forensic integrity for deployments that need it.

**Cons:** Fail-closed means a transient disk issue blocks shell submissions, which can be worse than a missing log line for most operators. Opt-in is the right shape but adds surface area.

**Depends on:** v0.13.0 shell jobs shipped. ✅

### Minions: configurable per-job output buffer sizes (deferred from v0.13.0)

**What:** Add `max_stdout_bytes` / `max_stderr_bytes` to ShellJobParams; override the 64KB/16KB defaults.

**Why:** 64KB/16KB covers typical OpenClaw scripts today but a verbose benchmark or a debug-dump script could need more.

**Depends on:** First shell-job author who actually needs it. Don't pre-build the flag.

### Security hardening follow-ups (deferred from security-wave-3)
**What:** Close remaining security gaps identified during the v0.9.4 Codex outside-voice review that didn't make the wave's in-scope cut.

**Why:** Wave 3 closed 5 blockers + 4 mediums. These are the known residuals. Each is an independent hardening item that becomes trivial as Runtime MCP access control (P0 above) lands.

**Items (each a separate small task):**
- **DNS rebinding protection for HTTP health_checks.** Current `isInternalUrl` validates the hostname string; DNS resolution happens later inside `fetch`. A malicious DNS server can return a public IP on first lookup and an internal IP on the actual request. Fix: resolve hostname via `dns.lookup` before fetch, pin the IP with a custom `http.Agent` `lookup` override, re-validate post-resolution. Alternative: use `ssrf-req-filter` library.
- **Extended IPv6 private-range coverage.** Block `fc00::/7` (Unique Local Addresses), `fe80::/10` (link-local), `2002::/16` (6to4), `2001::/32` (Teredo), `::/128`. Current code covers `::1`, `::`, and IPv4-mapped (`::ffff:*`) via hex hextet parsing.
- **IPv4 shorthand parsing.** `127.1` (legacy 2-octet form = 127.0.0.1), `127.0.1` (3-octet), mixed-radix with trailing dots. Current code handles hex/octal/decimal integer-form IPs but not these shorthand variants.
- **Broader operation-layer limit caps.** `traverse_graph` `depth` param, plus `get_chunks`, `get_links`, `get_backlinks`, `get_timeline`, `get_versions`, `get_raw_data`, `resolve_slugs` — all currently accept unbounded `limit`/`depth`. Wave 3 only clamped `list_pages` and `get_ingest_log`.
- **`sync_brain` repo path validation.** The `repo` parameter accepts an arbitrary filesystem path. Same threat model as `file_upload` before wave 3. Add `validateUploadPath` (strict) for remote callers.
- **`file_upload` size limit.** `readFileSync` loads the entire file into memory. Trivial memory-DoS from MCP. Add ~100MB cap (matches CLI's TUS routing threshold) and stream for larger files.
- **`file_upload` regular-file check.** Reject directories, devices, FIFOs, Unix sockets via `stat.isFile()` before `readFileSync`.
- **Explicit confinement root (H2).** `file_upload` strict mode currently uses `process.cwd()`. Move to `ctx.config.upload_root` (or derive from where the brain's schema lives) so MCP server cwd can't be the wrong anchor.

**Effort:** M total (human: ~1 day / CC: ~1-2 hrs).

**Priority:** P2 — deferred consciously. Wave 3 closed the easily-exploitable paths. These are the defense-in-depth follow-ups.

**Depends on:** Security wave 3 shipped. None are blockers for Runtime MCP access control, but all three security workstreams (this, that P0, and the health-check DSL) converge on the same zero-trust MCP goal.

### Community recipe submission (`gbrain integrations submit`)
**What:** Package a user's custom integration recipe as a PR to the GBrain repo. Validates frontmatter, checks constrained DSL health_checks, creates PR with template.

**Why:** Turns GBrain from a single-author integration set into a community ecosystem. The recipe format IS the contribution format.

**Pros:** Community-driven integration library. Users build Slack-to-brain, RSS-to-brain, Discord-to-brain.

**Cons:** Support burden. Need constrained DSL (P1) before accepting third-party recipes. Need review process for recipe quality.

**Context:** From CEO review (2026-04-11). User explicitly deferred due to bandwidth constraints. Target v0.9.0.

**Depends on:** Constrained health_check DSL (P1) — **SHIPPED in v0.9.3.**

### Always-on deployment recipes (Fly.io, Railway)
**What:** Alternative deployment recipes for voice-to-brain and future integrations that run on cloud servers instead of local + ngrok.

**Why:** ngrok free URLs are ephemeral (change on restart). Always-on deployment eliminates the watchdog complexity and gives a stable webhook URL.

**Pros:** Stable URLs, no ngrok dependency, production-grade uptime.

**Cons:** Costs $5-10/mo per integration. Requires cloud account.

**Context:** From DX review (2026-04-11). v0.7.0 ships local+ngrok as v1 deployment path.

**Depends on:** v0.7.0 recipe format (shipped).

### `gbrain serve --http` + Fly.io/Railway deployment
**What:** Add `gbrain serve --http` as a thin HTTP wrapper around the stdio MCP server. Include a Dockerfile/fly.toml for cloud deployment.

**Why:** The Edge Function deployment was removed in v0.8.0. Remote MCP now requires a custom HTTP wrapper around `gbrain serve`. A built-in `--http` flag would make this zero-effort. Bun runs natively, no bundling seam, no 60s timeout, no cold start.

**Pros:** Simpler remote MCP setup. Users run `gbrain serve --http` behind ngrok instead of building a custom server. Supports all 30 operations remotely (including sync_brain and file_upload).

**Cons:** Users need ngrok ($8/mo) or a cloud host (Fly.io $5/mo, Railway $5/mo). Not zero-infra.

**Context:** Production deployments use a custom Hono server wrapping `gbrain serve`. This TODO would formalize that pattern into the CLI. ChatGPT OAuth 2.1 support depends on this.

**Depends on:** v0.8.0 (Edge Function removal shipped).

## P2 (knowledge graph follow-ups)

### Auto-link skipped writes generate redundant SQL
**What:** When `gbrain put` is called with identical content (status=skipped), runAutoLink still does a full getLinks + per-candidate addLink loop. On N identical writes of a 50-entity page that's 50N round trips.

**Why:** Defensive reconciliation catches drift between page text and links table, but on truly idempotent writes it's wasted work.

**Pros:** Lower DB load on cron-style re-syncs. Keeps put_page latency tight under bulk MCP usage.

**Cons:** Need to track whether links could have drifted independent of content (e.g., a target page was deleted). Conservative approach: only skip auto-link reconciliation if status=skipped AND existing links match desired set (which still requires the getLinks call).

**Context:** Caught in /ship adversarial review (2026-04-18). Acceptable for v0.10.3 because auto-link runs in a transaction with row locks, so amplification cost is bounded.

**Effort estimate:** S (CC: ~10min)
**Priority:** P2
**Depends on:** Nothing.

### Audit `extract --source db` against auto_link config flag
**What:** `gbrain extract links --source db` writes to the same `links` table that `auto_link=false` is supposed to opt out of. The two are conceptually distinct (extract is intentional batch op, auto_link is implicit on write), but a user who turned off auto_link expecting "no automatic link writes" might be surprised.

**Why:** Either the behavior should match (extract checks auto_link too) or the docs should explicitly state extract is a superset.

**Pros:** Less surprise for users who treat auto_link as a master switch.

**Cons:** Some users want extract to work even when auto_link is off (e.g. one-time backfill).

**Context:** Caught in /ship adversarial review (2026-04-18). Documenting for now.

**Effort estimate:** S (CC: ~10min for docs OR ~20min for code change).
**Priority:** P2
**Depends on:** Nothing.

### Doctor --fix polish from v0.14.1 adversarial review
**What:** Six deferred findings from v0.14.1 ship-time adversarial review on `src/core/dry-fix.ts`:
1. **TOCTOU between read and write.** `attemptFix` reads once, writes later. Concurrent editor saves silently overwritten. Fix: re-read immediately before write and compare snapshot, or `O_EXCL` tempfile + rename.
2. **Fence detection misses 4-backtick and `~~~` fences.** `isInsideCodeFence` only catches `^```$`. CommonMark-legal alternates slip through.
3. **`expandBullet` walk-up is dead code.** Loop breaks immediately because `baseIndent` matches the current line. Remove or make it actually walk up.
4. **Multi-match guard too strict.** Skills with the pattern in a table-of-contents AND body get `ambiguous_multiple_matches` forever. Consider: fix first, re-scan, repeat until fixed-point.
5. **Subprocess spam.** `getWorkingTreeStatus` spawns `git status` N×M times per `doctor --fix`. Cache per-skill per-invocation.
6. **`doctor --fix --json` swallows the auto-fix report.** `printAutoFixReport` returns early on `jsonOutput`; agents don't see fix outcomes. Emit `auto_fix` as a top-level key.

**Why:** None are ship-blockers; all surfaced during v0.14.1 Codex adversarial review. Bundle into one follow-up PR.

**Pros:** Closes the adversarial findings loop. Better correctness under concurrent edits and JSON-consumer agents.

**Cons:** Concurrent-edit test is finicky.

**Context:** v0.14.1 shipped with the 4 critical fixes (shell-injection via execFileSync, no-git-backup detection, EOF newline preservation, proximity-window consistency). These six are the deferred remainder.

**Effort estimate:** M (CC: ~45min for all six + tests).
**Priority:** P2
**Depends on:** Nothing.

## Completed

### ChatGPT MCP support (OAuth 2.1)
**Completed:** v0.26.0 (2026-04-25) — `gbrain serve --http` ships full OAuth 2.1 via MCP SDK's `mcpAuthRouter` + `OAuthServerProvider`. Authorization code flow with PKCE unblocks ChatGPT. Client credentials flow unblocks Perplexity/Claude. Dynamic Client Registration available behind `--enable-dcr` flag (off by default). See `docs/mcp/CHATGPT.md` for connector setup. Closed the P0 that had been blocking the "every AI client" promise since v0.6.

### Implement AWS Signature V4 for S3 storage backend
**Completed:** v0.6.0 (2026-04-10) — replaced with @aws-sdk/client-s3 for proper SigV4 signing.

### Caller-opt-in retry for `executeRaw` (D3 follow-up from v0.22.1)
**What:** Add `PostgresEngine.executeRawIdempotent(sql, params)` (or a `{retry: true}` parameter flag on `executeRaw`) so callers explicitly opt into auto-retry for statements they know are idempotent. Audit existing call sites and migrate the read-only ones (search, page fetches, etc.) to the new method.

**Why:** Closes the gap left by D3's drop-the-wrapper decision in v0.22.1. The original #406 wrapped `executeRaw` in a regex-gated retry that was unsound for writable CTEs and side-effecting SELECTs. Recovery moved up to the supervisor watchdog, but per-call recovery for reads (the bulk of `executeRaw` traffic from MCP, search, page fetches) is gone. A caller-opt-in flag puts the idempotency decision where it belongs (at the call site, with full statement context).

**Pros:** Restores per-call auto-recovery for reads without the phantom-write risk on mutations. Explicit > clever: each call site declares its own idempotency posture. Future caller-added mutations get safe-by-default behavior.

**Cons:** Touches every existing `executeRaw` call site (~25). Requires careful audit — accidentally tagging a mutation as idempotent re-introduces the phantom-write bug.

**Context:** Codex F3 demonstrated that `READ_ONLY_PREFIX = /^(\s|--.*\n)*(SELECT|WITH)\b/i` is unsound — `WITH x AS (UPDATE … RETURNING …) SELECT …` matches the prefix but updates a row; `SELECT pg_advisory_xact_lock(...)` is a SELECT with side effects. The plan-eng-review wrap-up in `~/.claude/plans/system-instruction-you-are-working-tender-horizon.md` has the full discussion.

**Effort estimate:** M (human: ~1 day / CC: ~30 min including call-site audit).
**Priority:** P2 — current behavior (no retry, supervisor recovers within ~3 min) is acceptable but per-call recovery is a real ergonomic win.
**Depends on:** Nothing.

### Replace `walkMarkdownFiles` with `engine.getAllSlugs()` in `extractForSlugs` (F1 follow-up from v0.22.1)
**What:** The cycle path's `extractForSlugs()` at `src/commands/extract.ts:455` still does a `walkMarkdownFiles(brainDir)` to build the `allSlugs` set for link resolution. On a 54K-page brain that's a single `readdir` traversal (~hundreds of ms — acceptable, dominated by the file-content-read elimination from #417). But `engine.getAllSlugs()` exists at `extract.ts:728` and produces the same set via a single SQL query (~tens of ms).

**Why:** Eliminates the residual directory walk on every cycle. Codex F1 noted that the v0.22.1 plan's "cycle never re-walks the whole tree again" claim was overstated — it stops READING file contents but still walks the directory. This TODO closes that gap honestly.

**Pros:** Cycle becomes O(slugs sync touched), not O(total brain size). No more readdir on a growing brain. ~5 LOC change.

**Cons:** Crosses an FS-vs-DB consistency boundary in the FS-source extract path. Edge case: a file deleted from disk but still in DB. Currently `extractForSlugs` skips with `if (!existsSync(fullPath)) continue` — unchanged. But if a markdown file references a slug whose page exists in DB but file was deleted, the link would resolve via DB but the original extractor caught it. Needs a careful test for this case.

**Context:** Codex plan-review during v0.22.1 wrap, verified at `extract.ts:455-456`. The plan-eng-review session captured the rationale.

**Effort estimate:** S (human: ~2 hr / CC: ~10 min including the consistency-edge-case test).
**Priority:** P3 — pure perf, no correctness gap.
**Depends on:** Nothing.

### `err.code`-based connection-error matching in `postgres-engine.ts` (B1 follow-up from v0.22.1)
**What:** The CONNECTION_ERROR_PATTERNS array (~12 strings: `ECONNREFUSED`, `connection terminated`, `password authentication failed`, etc.) matched against `err.message` and `err.code`. Replace with structured matching against `err.code` only, using postgres.js's typed error classes (`PostgresError` with structured codes).

**Why:** String matching against error messages breaks on library upgrades (postgres.js could change its error message phrasing without bumping major). Code matching is durable. The Layer 1 cleanup follows: gbrain itself doesn't define connection-error codes; it should defer to postgres.js's classification.

**Pros:** More durable across library updates. Less code (drop the 12-string array). Follows the typed-errors pattern v0.21.0 introduced (`src/core/errors.ts`).

**Cons:** Requires verifying which `err.code` values postgres.js actually exposes for each connection-failure mode. May need fallback to message-substring matching for codes that postgres.js doesn't surface.

**Context:** Section 2/B1 from the v0.22.1 plan-eng-review. After D3 dropped the per-call retry, `isConnectionError` is no longer in the hot path — only the supervisor watchdog cares about classifying connection errors, and it currently catches *anything*. This TODO is a cleanup pass when someone next touches that surface.

**Effort estimate:** S (human: ~2 hr / CC: ~10 min).
**Priority:** P3.
**Depends on:** The above caller-opt-in retry (#1) is the natural co-lander since both touch the same error-classification surface.

## remote MCP / HTTP transport (v0.22.7 follow-ups)

### Audit-log write amplification on rejected `/mcp` traffic
**What:** `src/mcp/http-transport.ts` writes a row to `mcp_request_log` for every
incoming `/mcp` request, including rate-limited (429), oversized (413), and
auth-failed (401) traffic. Under sustained attack the IP rate limit caps audit
writes per IP at 30/min, but at scale (10K distinct IPs) that's still 300K
inserts/min. Two follow-ups: (1) instrument the audit-write rate so we can see
the actual production volume; (2) consider a separate "rejected" table or
sampling for failed-auth rows so the success-path audit table doesn't get
swamped.

**Why:** Codex flagged this during the v0.22.7 ship adversarial review. We kept
the full audit on purpose — forensic data of an attack is valuable — but want
to revisit once we have real volume numbers.

**Pros:** Bounds DB write volume under attack. Keeps the success-path audit
table small enough for fast queries.

**Cons:** Adds a second table or a sampling rule. Not free complexity. Probably
not worth it until production hits a real attack pattern.

**Context:** `src/mcp/http-transport.ts:222,235,245` (the three audit-on-reject
call sites) + `src/schema.sql:342` (the unbounded table).

**Effort estimate:** M (human: ~half day / CC: ~30 min once we have volume data).
**Priority:** P3 — wait for evidence.
**Depends on:** Production telemetry on `mcp_request_log` insert rate.

### `validateParams` doesn't check enum values or array item types
**What:** `src/mcp/dispatch.ts:27` (extracted from `src/mcp/server.ts` in
v0.22.7) only checks top-level JS types. Operations declare `enum` constraints
(e.g. `direction: 'in' | 'out' | 'both'`) and array `items: { type: ... }`
schemas in `src/core/operations.ts`, but `validateParams` ignores both. Bad
inputs still reach handlers — concretely, an invalid `direction` falls through
the engine's else branch at `src/core/postgres-engine.ts:954`, widening
traversal unexpectedly; malformed `pages_updated` arrays could be written as
garbage JSONB.

**Why:** Codex flagged this during the v0.22.7 ship adversarial review. The
validator was lifted verbatim from the pre-existing stdio path during the
dispatch.ts extraction — same gap exists on the stdio MCP server today, so
this isn't a v0.22.7 regression. Still worth tightening, since "shared
validation" is now the architectural guarantee both transports rely on.

**Pros:** Better defense-in-depth at the MCP boundary. Catches malformed agent
inputs before the engine layer has to.

**Cons:** Need to walk every operation's param schema and decide which enum
violations are user-facing errors vs internal bugs. May need a typed Zod-style
schema layer to do this cleanly.

**Context:** `src/mcp/dispatch.ts:27` + `src/core/operations.ts` (param defs).
Same gap pre-existed on stdio MCP path.

**Effort estimate:** M (human: ~half day / CC: ~30 min if we use the existing
ParamDef shape; XL if a Zod migration is the chosen direction).
**Priority:** P2.
**Depends on:** Whether we want to keep the lightweight ParamDef shape or
migrate to typed schemas.

### Streaming MCP tool support (re-add SSE based on Accept header)
**What:** v0.22.7 dropped SSE entirely from `gbrain serve --http` because no
current MCP tool streams. When the first streaming tool ships (long-running
agent delegation as an MCP tool, `resources/subscribe`, `sampling/createMessage`),
re-add SSE in `/mcp` based on the `Accept` header per the Streamable HTTP
transport spec. ~30 lines + spec compliance test.

**Why:** Removing SSE simplified the v0.22.7 transport (one response path,
fewer test cases). Adding it back when actually needed is cheap and keeps the
code lean in the meantime.

**Effort estimate:** S (human: ~2 hr / CC: ~15 min).
**Priority:** P3 — wait for the first streaming tool.
**Depends on:** A streaming MCP tool actually existing.

### `access_tokens.scopes` enforcement
**What:** The `access_tokens` schema has had a `scopes TEXT[]` column since
migration v4 (`src/core/migrate.ts:84`), but nothing enforces it. v0.22.7's
`gbrain auth create` doesn't accept a `--scopes` flag, and `dispatchToolCall`
doesn't gate on scopes. Adding per-tool scope enforcement would let
"claude-desktop-readonly" and "ingest-only" tokens exist.

**Effort estimate:** M (human: ~1 day / CC: ~30 min for the schema-aware gate).
**Priority:** P3.
**Depends on:** Nothing.

---

### `@garrytan/gbrain` scoped-name npm publishing
**What:** Publish gbrain to npm under the scoped name `@garrytan/gbrain`
instead of the bare `gbrain` name. Provides structural defense against the
unrelated `gbrain@1.x` squatter package on npm.

**Why:** `classifyBunInstall()` at `src/commands/upgrade.ts:395` does a
best-effort fingerprint check on `repository.url` + `src/cli.ts` marker, with
the comment explicitly accepting that signals are spoofable by a determined
squatter. Scoped publishing is the structural answer that closes the loop:
`bun add -g @garrytan/gbrain` cannot collide with any non-`@garrytan` package.

**Pros:** closes the squatter vector; consistent with how high-trust npm
packages are published; allows removing `classifyBunInstall`'s spoofable
signals later.

**Cons:** multi-week effort; needs reverse-compatible upgrade path for users
on the bare-name install (`bun add -g gbrain` → recovery message pointing
at the new scoped name); npm publishing flow changes; CI publish step needs
scope-aware tagging.

**Context:** tracked at `src/commands/upgrade.ts:392-394` since v0.29; reaffirmed
during v0.31.8 codex outside-voice review. Issue #658 has the surface-level
history.

**Effort estimate:** L (human: ~1 week / CC: ~half a day for the publishing
flow + recovery messaging).
**Priority:** P2.
**Depends on:** decision on whether to deprecate the bare name or dual-publish
during a transition window.


## v0.32.6 follow-ups from PR #880 (gbrain-context post-Codex recalibration)

These items were demoted from the PR #880 scope because they depend on
infrastructure (clock-injection seam, public-API design) that's not in this PR.
Filed for a future fix wave.

### Clock-injection seam in `src/core/context-engine.ts`

**Status:** Prerequisite for re-promoting perf-budget + snapshot tests.

**What:** Inject a `now: () => Date` into the engine factory so all `new Date()`
call sites (lines 207, 371, and Date.now() at 354) read through one source.
~10 lines.

**Why:** The plan proposed two test infrastructure items (perf budget at p99 <
50ms, full-block snapshot for format-drift) that both depend on a stable clock.
Without injection, snapshot tests flake on the time field and perf tests
double-call `Date` non-deterministically.

**Effort:** S (CC: ~30 min).

### Perf-budget assertion (T-NEW2)

**Depends on:** clock-injection seam above.

**What:** New test asserting `assemble()` p99 stays under 50ms over 50 warm
runs. The headline claim of the engine is "<5ms per turn"; right now nothing
ratchets that in.

**Codex F2 note for the implementation:** Use `Math.floor(50 × 0.95)` (index
47) for p95 or the actual sorted-percentile method, NOT `Math.floor(50 ×
0.99)` which returns index 49 = the MAX sample and fails on one scheduler
pause.

### Full-block snapshot test (T-NEW3)

**Depends on:** clock-injection seam above.

**What:** `expect(result.systemPromptAddition).toMatchSnapshot()` with a
deterministic clock + fixture workspace. Pins the wire format so a reorder of
fields or rename of `**Location:**` to `**Where:**` is caught.

### `exports` map entry for `./context-engine` (C-NEW2)

**Codex F8 note:** Adding `"./context-engine": "./src/core/context-engine.ts"`
creates premature public-API obligations around types, lazy SDK loading, `.ts`
imports, and engine-version semantics. Plugin loading via
`openclaw.extensions` doesn't need it. Revisit when external consumers
(gbrain-evals harness, etc) actually need direct engine import.

### `.ts`-extension import resolution coupling (A3)

**What:** `src/openclaw-context-engine.ts:25` imports
`./core/context-engine.ts` with explicit `.ts` extension. Bun handles natively;
standard `tsc` emit + Node ESM require `.js`. If OpenClaw ever transpiles
before loading, this breaks.

**Defer until:** OpenClaw integration fails on this path.

### Typed `openclaw/plugin-sdk` ambient module shim (A5)

**What:** Replace `@ts-ignore` at the lazy SDK import in
`src/core/context-engine.ts` with `types/openclaw-shim.d.ts` declaring
ambient module signatures. ~30 lines. Lets typecheck catch typos and
signature changes in the SDK that `@ts-ignore` silences.

### `loadJsonFile` parse-error warning (C-prior C5)

**What:** Add `console.warn` on JSON parse failure so the heartbeat cron's
mistakes surface in stderr instead of silently degrading to defaults.

### Fractional-hour timezone offset (C-prior C3)

**What:** `getTimeInTz` rounds offsets at lines 217-224 (integer
`localH - utcH` math). India (UTC+5:30), Nepal (UTC+5:45), Newfoundland
(UTC-3:30), Chatham Islands (UTC+12:45) all round to the wrong whole hour
in the emitted ISO. `dayOfWeek` and `hour` are correct via `Intl`; only the
embedded offset string is wrong. Fix: use `Intl.DateTimeFormat` with
`timeZoneName: 'longOffset'`.

### DST-boundary test (deferred)

**What:** Lock in `getTimeInTz` behavior across spring-forward / fall-back
transitions. Edge case but real if Garry travels during a transition window.

### Multibyte sanitizer test (deferred)

**What:** `sanitizeForPrompt(s, 100)` clamps at 100 chars via `.slice(0, 100)`
which operates on UTF-16 code units. A surrogate pair could be split mid-pair.
Very low likelihood (real attendees are <50 chars) but the test surface is
empty.

### Dynamic airport-tz lookup (Codex parenthetical)

**What:** `AIRPORT_TZ` as a 30-entry static map is the wrong long-term
primitive. Either pull from a small tz library (e.g., `@vvo/tzdb`) keyed on
IATA code, or require the heartbeat producer to supply
`flights.destinationTimezone` in the JSON shape directly.

### Workspace contract documentation (DOC1)

**What:** New `docs/openclaw-context-engine.md` explaining which workspace
files the engine reads, their schemas, who's expected to write them, and the
atomic-rename concurrency contract. The interface is implicit in the test
fixtures today.

### CLAUDE.md "Key files" annotations (DOC2)

**What:** Add one-line entries under CLAUDE.md's "Key files" section for
`src/core/context-engine.ts` and `src/openclaw-context-engine.ts`. Per
project convention for new architectural files.

### Repo-wide privacy scrub

**Status:** Out of scope for PR #880 (which scrubbed `test/context-engine.test.ts`
and added the new CI guard). The guard surfaced 4 additional pre-existing
references in other test files plus ~24 references in non-test files
(CHANGELOG entries, docs, skill READMEs). Each entry needs case-by-case
judgment.

**What:** Dedicated pass across:
- Non-allowlisted pre-existing test-file matches (extract.test.ts,
  serve-stdio-lifecycle.test.ts — currently allowlisted as pre-existing
  but warrant a real scrub).
- 24 doc/skill/CHANGELOG matches (most are historical and may not be
  retroactively rewriteable, but should be triaged).

**Depends on:** human judgment on which historical CHANGELOG entries to
leave intact vs scrub.
