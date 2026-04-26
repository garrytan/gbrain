# TODOS

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

### Fix `bun build --compile` WASM embedding for PGLite
**What:** Submit PR to oven-sh/bun fixing WASM file embedding in `bun build --compile` (issue oven-sh/bun#15032).

**Why:** PGLite's WASM files (~3MB) can't be embedded in the compiled binary. Users who install via `bun install -g gbrain` are fine (WASM resolves from node_modules), but the compiled binary can't use PGLite. Jarred Sumner (Bun founder, YC W22) would likely be receptive.

**Pros:** Single-binary distribution includes PGLite. No sidecar files needed.

**Cons:** Requires understanding Bun's bundler internals. May be a large PR.

**Context:** Issue has been open since Nov 2024. The root cause is that `bun build --compile` generates virtual filesystem paths (`/$bunfs/root/...`) that PGLite can't resolve. Multiple users have reported this. A fix would benefit any WASM-dependent package, not just PGLite.

**Depends on:** PGLite engine shipping (to have a real use case for the PR).

### ChatGPT MCP support (OAuth 2.1)
**What:** Add OAuth 2.1 with Dynamic Client Registration to the self-hosted MCP server so ChatGPT can connect.

**Why:** ChatGPT requires OAuth 2.1 for MCP connectors. Bearer token auth is NOT supported. This is the only major AI client that can't use GBrain remotely.

**Pros:** Completes the "every AI client" promise. ChatGPT has the largest user base.

**Cons:** OAuth 2.1 is a significant implementation: authorization endpoint, token endpoint, PKCE flow, dynamic client registration. Estimated CC: ~3-4 hours.

**Context:** Discovered during DX review (2026-04-10). All other clients (Claude Desktop/Code/Cowork, Perplexity) work with bearer tokens. The Edge Function deployment was removed in v0.8.0. OAuth needs to be added to the self-hosted HTTP MCP server (or `gbrain serve --http` when implemented).

**Depends on:** `gbrain serve --http` (not yet implemented).

### Runtime MCP access control
**What:** Add sender identity checking to MCP operations. Brain ops return filtered data based on access tier (Full/Work/Family/None).

**Why:** ACCESS_POLICY.md is prompt-layer enforcement (agent reads policy before responding). A direct MCP caller can bypass it. Runtime enforcement in the MCP server is the real security boundary for multi-user and remote deployments.

**Pros:** Real security boundary. ACCESS_POLICY.md becomes enforceable, not advisory.

**Cons:** Requires adding `sender_id` or `access_tier` to `OperationContext`. Each mutating operation needs a permission check. Medium implementation effort.

**Context:** From CEO review + Codex outside voice (2026-04-13). Prompt-layer access control works in practice (same model as Garry's OpenClaw) but is not sufficient for remote MCP where direct tool calls bypass the agent's prompt.

**Depends on:** v0.10.0 GStackBrain skill layer (shipped).

## P1 (new from v0.7.0)

### ~~Constrained health_check DSL for third-party recipes~~
**Completed:** v0.9.3 (2026-04-12). Typed DSL with 4 check types (`http`, `env_exists`, `command`, `any_of`). All 7 first-party recipes migrated. String health checks accepted with deprecation warning + metachar validation for non-embedded recipes.

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

### Implement AWS Signature V4 for S3 storage backend
**Completed:** v0.6.0 (2026-04-10) — replaced with @aws-sdk/client-s3 for proper SigV4 signing.
