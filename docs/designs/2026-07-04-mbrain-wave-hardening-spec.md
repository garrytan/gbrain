# MBrain Wave-Hardening & Release-Recovery Spec — 2026-07-04

| | |
|---|---|
| **Date** | 2026-07-04 |
| **Status** | Implementation-ready decision spec |
| **Baseline** | `master@7f3d2a56` (VERSION says 0.14.3; ~13k lines unreleased) |
| **Reviews merged in** | Six parallel code-grounded audits: governance loop, retrieval wave, eval instrument, newest-code bug hunt, operational/deployment, architecture. All `file:line` evidence below was re-verified in-tree on 2026-07-04; line numbers drift, symbol names are authoritative. |
| **Relationship to prior specs** | This is the **post-implementation review** of the `2026-07-03-mbrain-improvement-spec.md` wave (PRs #293–#298). That spec defined GV/KR/RQ/RS/RW/KM/EV/UX/AR/FT items; this spec audits what actually shipped, fixes what didn't close, and hardens the new default-on surfaces. Direction bets D-1..D-5 (`2026-07-03-mbrain-direction-bets.md`) keep their ownership there. |

## How to read this spec

- **§1** — what mbrain is for, and the one-paragraph verdict on the wave.
- **§2** — the diagnosis: three things are simultaneously true about the shipped wave.
- **§3** — the roadmap table (single source of truth for order).
- **§4 (P0)** carries the full six fields **Problem · Evidence · Fix · Files · Effort · Acceptance**. **§5–§8** detail high-value items and compress the rest into one-liners with inline evidence anchors.
- **§9** decisions needed from the owner. **§10** non-goals. **§11** verification plan.

Tags: **[GATE]** must not flip a default until §7's real instrument shows no regression. **[FLAG]** ships behind a config flag, default-off, deterministic fallback (offline-parity rule).

---

## 1. Goal and verdict

mbrain is a **local-first personal memory runtime** for one person and their AI agents. Markdown is the human-editable source of truth; Postgres (or SQLite offline) is the index; CLI and MCP are generated from one contract (`src/core/operations.ts`). The product goal is **compounding context — learn once, never rediscover.** The measured moment of truth: *when an agent needs a fact, does mbrain return the right evidence?*

**Verdict on the 2026-07 wave.** The wave was largely real work — 24 of 30 audited retrieval items trace end-to-end, the governance schema changes have genuine three-engine parity (v62/v63/v64 on Postgres/PGLite/SQLite), and the acceptance-critical tests exist. **But three things are simultaneously true, and together they mean the moment of truth is failing on the owner's own machine right now:**

1. **The running install is broken.** `retrieve_context` and `get_health` currently throw raw SQL errors (`column "completed_at" does not exist`, `column p.timeline_changed_at does not exist`) against the owner's live database — verified live this session. The new code ships columns the live schema never got.
2. **Several "closed-loop" items don't close.** GV-3's daily report — the declared "primary review surface" — fails to write every night under launchd; KM-1's compile-debt arithmetic inverts its own ranking; KM-3's recompile "patch" would corrupt the two-zone model if applied; GV-1's stranding window is narrowed, not closed, with no repair path.
3. **The default-on changes shipped without a real instrument.** RQ-7 (governed hybrid probe) and auto-route were flipped **on by default** for every install, gated by an EV-1 "non-regression artifact" that is a single post-hoc run with no baseline, on SQLite with **embeddings disabled** — i.e. it never exercised the vector lane the flip enables. Meanwhile the default-on probe fans out ~12 embedding calls + ~12 `getHealth()` aggregates per single `retrieve_context` (the RQ-3 batching that was named its prerequisite was skipped).

The wave built the *mechanisms*. This spec makes them **land, close, and stay honest** — and fixes two HIGH security bugs introduced by the new `mbrain review` surface.

---

## 2. Diagnosis

### 2.1 The operational failure is the emergency (P0)

The audits confirmed the structural root cause of the live incident, and it is not a one-off:

- **stdio `mbrain serve` — the default registered surface — never runs migrations.** `PostgresEngine.connect()` opens the pool and runs `SELECT 1`; migrations run only in `initSchema()`, which the stdio serve path never calls (only `--http --oauth`, `init`, `autopilot run-once`, and the engine-migration command do). The owner's `mbrain` is a 74-byte wrapper (`exec bun …/src/cli.ts`) that runs repo source directly, so every `git pull` instantly serves code newer than the schema.
- **The only automatic healer is the 03:00 autopilot**, and it isn't healing — the live DB sits at migration **v58**, behind even released 0.14.3 (v60) and far behind master (v64). So autopilot has been failing or unregistered for weeks, silently.
- **No honest failure.** There is no schema-version handshake at serve/request time. Drift leaks raw Postgres error strings to the agent (`server.ts:969-970`) instead of "schema v58 < required v64 — run `mbrain init`." `mbrain doctor` *can* detect it (`doctor-service.ts:656-670`) but is opt-in and never runs automatically.
- **The remote surface has the identical latent bug.** The Supabase Edge Function connects without `initSchema` and `deploy-remote.sh` has no migration step — deploying new edge code reproduces this incident on the hosted surface.

This is the highest-leverage class of bug in the whole system: **the product's core promise (return the right evidence) is defeated by an operational gap that no test covers**, because tests always run `init`-migrated databases.

### 2.2 The governance loop still leaks — quieter, but leaking

The prior wave's thesis was "mbrain is excellent at *not writing wrongly* and blind to *not having written*." The wave narrowed the leaks but left several open, and added new fail-open defaults:

- **GV-3 delivery is broken on the scheduled path.** The report saves to a cwd-relative `reports/…` (`report_dir ?? '.'` → `saveBrainReport(brainDir='.')`); the installed launchd plist has no `WorkingDirectory` and the run script never `cd`s, so under launchd (cwd=`/`) `mkdirSync('/reports/…')` throws EPERM nightly. The `notify` delivery and the "N≥2 dead nights" alarm floor were never built. **The primary review surface still never materializes.**
- **GV-1 stranding narrowed, not closed.** A throw after `advanceToStaged` (e.g. the *second* internal preflight deferring on a freshly-detected duplicate) leaves a candidate `staged_for_review` — permanently invisible, since the selector scans only `captured|candidate`. No transaction wrap, no repair sweep.
- **GV-2 debt metric is fail-open.** `computeCandidateDebtMetrics` treats every handoff as completed when the caller omits the completed-ids set; only the report passes it, so every other caller reports zero incomplete-handoff debt — the exact "invisible debt" GV-2 exists to kill, reintroduced as a default.
- **GV-4 inflates evidence authority.** An expired *source-extracted* canonical session falls back through `null → 'manual' → direct_user_statement`, entering the canonical-eligible lane with the highest provenance class — the opposite of "preserve evidence_kind."
- **GV-7 shipped one-third.** The error footer landed; the `COUNT(*)` true totals and "showing N of M" markers did not. Every debt metric is still computed over the 100 most-recently-*touched* rows (`DEFAULT_LIMIT=100`, `updated_at DESC`), so GV-9's age-escalation and the health queue go **blind exactly when the backlog exceeds 100** — the oldest, most-escalation-worthy candidates fall outside the window.

### 2.3 Knowledge still does not compound

The compile → distill loop was the prior wave's highest-leverage bet (KM-1/3/5). It shipped as scaffolding with a broken core:

- **KM-1 debt arithmetic misranks.** `compileDebtForPage` counts *all* dated timeline lines and ages from the *oldest* line, not "lines newer than `compiled_truth_changed_at`." A mature 80-entry page with one new line scores ≈ 80×(1+years) and permanently dominates the debt list; a genuinely neglected 3-entry page never surfaces. This poisons every consumer: `list_compile_debt`, KM-3 proposals, KM-5 health ranking.
- **KM-3 is an op-only deterministic template, not a loop.** No dream phase produces proposals nightly; no runner integration exists (the spec's runner-gated rewrite and `skipped/runner_unavailable` acceptance are unimplementable as built). Worse, the generated "patch" appends the **entire timeline** into `compiled_truth` under a "Pending Compile-Debt Review" heading — if a reviewer applies it verbatim (which `finalize_memory_candidate`'s patch lane will), the compiled zone permanently embeds all evidence, **violating the two-zone model the item exists to strengthen** and immediately re-flagging the page as duplicate content.

The brain still gets bigger, not wiser — and the one mechanism meant to fix that is currently a footgun.

### 2.4 The new default-on retrieval carries unmeasured risk

- **The instrument is ceremonial.** EV-1 exists, runs live, and persists — but the gold set is **3 synthetic single-gold cases** over a 3-page corpus purpose-seeded to match the queries; `precision_at_k` is a constant 0.1 (k=10, 1 gold); per-route labels come from the fixture and are never cross-checked against the actual route taken; and the CI check merely re-reads the static JSON artifact, so it can never go red. EV-2's `J` is structurally ≤ 0 (groundedness never supplied). **This instrument cannot catch a real ranking regression** — yet Wave 3 flipped defaults "gated" on it.
- **The default-on probe is expensive and cross-engine-divergent.** Per `retrieve_context`: one hybrid search *per query variant* (up to ~12; the variant cap isn't enforced for `known_subjects`), each running a full 6-subquery `getHealth()` aggregate serially before embedding, its own embedding round-trip, and up to 3 vector scans — the RQ-3 batching named as RQ-7's prerequisite was not built. And Korean multi-term queries now return **different results on Postgres (OR) vs SQLite (AND)** — Invariant 8 parity breaks precisely for the Korean queries the wave set out to fix. Separately, the new PG vector legs `ORDER BY (1 - dist) DESC`, a form pgvector's HNSW index cannot satisfy — every vector leg is a sequential scan.

### 2.5 Release hygiene collapsed

VERSION is **0.14.3**, `CHANGELOG.md [Unreleased]` is **empty**, and ~13k lines / four schema migrations (v61–v64) sit unreleased and undocumented. `skills/migrations/` stops at v0.14.1 ("no schema migration required"). The project's own post-ship rule (`document-release`, migration files for schema changes) was not followed for the wave — which is *why* existing installs (including the owner's) silently miss the new migrations and the five new default-off flags. Also: **the unit suite is red by default on macOS** (7–9 failures that flap run-to-run — all PGLite parity-suite timeouts, see OP-4); a green suite is a release precondition and cannot currently be met.

---

## 3. Roadmap

Waves are dependency-ordered. Effort: **S** ≤ half day · **M** ≤ 2–3 days · **L** larger.

### P0 — Stop the bleeding *(the install is broken today; ship first, in order)*

| ID | Item | Effort |
|----|------|:--:|
| OP-1 | Migrate-or-fail-honestly on **every** serve entry point (stdio, HTTP, edge lazy-connect) | M |
| OP-2 | Schema-version handshake: `get_health`/`doctor`/serve report `schema v_x < required v_y → run mbrain init`, no raw SQL leak | S |
| OP-3 | Release the wave: VERSION bump, CHANGELOG `[Unreleased]`→version, `skills/migrations/v0.15.0.md` (must-migrate + autopilot re-register + new flags) | S–M |
| OP-4 | Fix the red-by-default unit suite (PGLite parity timeouts); add a red-suite release gate | S–M |
| SEC-1 | `mbrain review` server: require a bearer/loopback-secret + Origin/Host allowlist before verify/refute; warn on non-loopback bind | M |
| SEC-2 | Fix `/mcp` on `review_local` (request body read twice → always 500) | S |

### P1 — Close the loop that was left open *(correctness; ungated)*

| ID | Item | Effort |
|----|------|:--:|
| GV-3b | Nightly report writes into the **brain dir** (absolute); build `notify` + the dead-night alarm floor | M |
| GV-1b | Transaction-wrap advance+promote; repair sweep for stranded `staged_for_review` unverified rows | M |
| GV-2b | Make incomplete-handoff debt **fail-closed**; add a distinct report section with per-row next actions | S |
| GV-4b | Fallback preserves `evidence_kind` (no `null→manual→direct_user_statement` promotion) | S |
| GV-7b | True `COUNT(*)` totals + "showing N of M" markers; page debt/escalation/health over the full backlog, not the last 100 | M |
| KM-1b | Compile-debt = timeline lines **newer than `compiled_truth_changed_at`**, aged from the newest-uncompiled; fix all consumers | S–M |
| KM-3b | Recompile patch rewrites the **compiled zone only** (never appends timeline); make it a runner-gated dream phase with honest `runner_unavailable` | M |
| GV-5b | Timeout follow-through: handle the abandoned phase promise (nightly-run crash risk); `maintenance.phase_timeout_ms` config; timeout streaks in the report | S |
| GV-6b | Delete (or make reachable) the provably-dead `excludedByOpenContradiction` guard | S |
| WQ-1 | Watched questions: same-night changes reach the same night's report; probe failures stop being swallowed | S–M |
| KR-5 | Postgres/SQLite CJK query **AND/OR parity** (Invariant 8 for Korean) | M |

### P2 — Make the instrument real *(unblocks safe ranking work)* **[GATE for P3]**

| ID | Item | Effort |
|----|------|:--:|
| EV-1b | Real gold set (30–100 cases mined from live `retrieval_traces` + recurring gaps; multi-gold; all routes incl. Korean); seeded corpus; CI runs live eval, not a JSON re-read | L |
| EV-1c | Baseline-delta mode: `eval retrieval --compare`, per-route deltas (not dropped); baseline artifact per config (old/new default × sqlite/PG × ±embeddings) | M |
| EV-2b | Wire EV-1 recall@k as EV-2's groundedness proxy so `J` can exceed 0 and actually measures quality | S |

### P3 — Harden the default-on retrieval **[GATE: EV-1b non-regression artifact]**

| ID | Item | Effort |
|----|------|:--:|
| RQ-3b | Batch variant embeddings across the whole probe; one cached coverage check per probe (not per variant) | M |
| RQ-6b | Thread `retrieval.source_rank_rules` into the `retrieve_context` candidate ranker (today applied only to `search`/`query`) | S |
| RQ-3c | Enforce `MAX_CANDIDATE_QUERY_VARIANTS` for `known_subjects` | S |
| RS-8b | Rewrite PG vector legs to `ORDER BY embedding <=> $1 ASC` so the HNSW index is usable | M |
| RQ-9b | Collapse cross-variant RRF at the probe level (max, not sum) — the amplification RQ-9 removed one level down | S |
| RS-4b | Add temporal params + a real recency tiebreak to `retrieve_context` (params exist only on `search`/`query`) | S |

### P4 — Structural debt & durable improvements

| ID | Item | Effort |
|----|------|:--:|
| AR-5b | Finish the migration squash (baseline declared v48, unused): seed fresh installs at `LATEST_VERSION`; cut 63→~16 replays | M |
| AR-7b | Split `retrieve-context-service.ts` (2,759 lines, +31% this wave) before the next retrieval item lands | M |
| AR-3b | Explicit `tier` field per op; delete `ADMIN_NAME_FRAGMENTS` substring heuristic; fix bare-`serve` default vs help text | S–M |
| AR-6b | Ratchet test on `as any` in `operations*.ts` (rose 78→85); retrofit the two largest siblings | S |
| DOC-1 | Per-op doc contract: every non-admin op documented or explicitly annotated (74/188 currently orphaned) | S |
| KM-4b | `lint`/`check-backlinks` validate `superseded_by` targets (a typo silently demotes forever) | S |
| NEW-1 | **Self-healing serve** as a product principle (see §8.1) | — |
| NEW-2 | **Trustworthy-by-construction eval** flywheel from live traces (see §8.2) | — |

---

## 4. P0 — Stop the bleeding

### OP-1 · Migrate-or-fail-honestly on every serve entry point
- **Problem.** The default registered surface (stdio `mbrain serve`) serves requests against whatever schema the DB happens to be at; new code + old schema leaks raw SQL errors and breaks the core retrieval path. The edge function and non-OAuth HTTP path have the same gap.
- **Evidence.** `PostgresEngine.connect()` (`postgres-engine.ts:63-110`) runs only `SELECT 1`; migrations live in `initSchema()` (`:121-137`), reached only by `init` (`init.ts:207,242,320`), `autopilot run-once` (`autopilot.ts:138-141`), and `--http --oauth` (`serve.ts:104-105`). Stdio branch (`serve.ts:64-65`) and CLI `connectEngine()` (`cli.ts:780-787`) never call it. Edge: `supabase/functions/mbrain-mcp/index.ts:169-170` connect-only; `deploy-remote.sh` has no migrate step. Live proof: DB at v58, code at v64; `get_health`/`retrieve_context` throw this session.
- **Fix.** Two-part, so we neither silently auto-migrate a remote DB nor leave stdio broken:
  1. **Local surfaces (stdio serve, CLI):** run migrations at connect for owner-local engines (SQLite always; Postgres when `database_url` is local/explicitly owner-managed). Guard with the existing advisory lock. This is the owner's own machine — auto-migrate is correct and matches `init`/autopilot behavior.
  2. **Shared/remote surfaces (edge, `--http` without owner ownership):** do **not** auto-migrate; instead perform a cheap version check at startup and per-request-fail-closed: if `getConfig('version') < LATEST_VERSION`, every op returns a structured `OperationError('schema_out_of_date', 'run mbrain init/migrate')` instead of leaking SQL. Add a migrate step to `deploy-remote.sh`.
- **Files.** `src/core/postgres-engine.ts`, `src/core/sqlite-engine.ts`, `src/commands/serve.ts`, `src/core/engine-factory.ts`, `supabase/functions/mbrain-mcp/index.ts`, `scripts/deploy-remote.sh`, `src/mcp/server.ts` (error mapping).
- **Effort.** M.
- **Acceptance.** Unit: a stdio serve against a DB seeded at v58 comes up migrated (local) or returns `schema_out_of_date` on every op (remote), never a raw SQL string. E2E: fresh `init` → downgrade `config.version` → `retrieve_context` behaves per surface. `deploy-remote.sh` dry-run shows a migrate step.

### OP-2 · Schema-version handshake, honest errors
- **Problem.** No surface reports schema drift; `get_health` doesn't include the version; raw 42703 errors reach the agent.
- **Evidence.** Honest check exists only in `doctor-service.ts:656-670` (opt-in). `server.ts:969-970` returns `Error: ${msg}` for any non-`OperationError`.
- **Fix.** Add `schema_version` + `schema_up_to_date` to `get_health`. In the MCP error mapper, translate Postgres 42703/42P01 (undefined column/table) into an `OperationError` naming the version gap and remediation. `doctor` gains a first-class "schema drift" line independent of dead-job counts.
- **Files.** `src/core/pg-engine-base.ts` (getHealth), `src/mcp/server.ts`, `src/core/services/doctor-service.ts`.
- **Effort.** S.
- **Acceptance.** `get_health` on a v58 DB reports `schema_up_to_date:false, schema_version:58, required:64`; a drift-triggered op returns a remediation string, not raw SQL.

### OP-3 · Release the wave (version, changelog, migration file)
- **Problem.** 13k lines + four migrations are unversioned and undocumented, so existing installs (including the owner's) never learn they must migrate or that five new flags exist.
- **Evidence.** `VERSION=0.14.3`, tag `v0.14.3` (max migration v60); master has v61–v64; `CHANGELOG.md [Unreleased]` empty; `skills/migrations/` stops at `v0.14.1.md`.
- **Fix.** Bump to `0.15.0` (schema-affecting, new default-on behavior). Write `CHANGELOG.md` entries in the repo's benefit-led voice (governance completion, Korean search, review UI, watched questions, compile-debt tooling). Author `skills/migrations/v0.15.0.md` as agent instructions: **apply pending schema migrations via `mbrain init`** (this install's live DB needs v59–v64; a released-0.14.3 install needs v61–v64), re-register autopilot (OP-1/GV-3b), and the enable/verify checklist for the new flags (§9). Run `/document-release` across README/CLAUDE.md/docs.
- **Files.** `VERSION`, `package.json`, `CHANGELOG.md`, `skills/migrations/v0.15.0.md`, docs.
- **Effort.** S–M.
- **Acceptance.** `check-update.test.ts`/`doctor` version parity green; migration file present and covers migrate + autopilot + flags; changelog covers every wave commit.

### OP-4 · Fix the red-by-default suite (PGLite parity timeouts) + add a red-suite gate
- **Problem.** `bun test` is red on macOS out of the box, so CLAUDE.md's "green suite is a release precondition" cannot currently be met on the owner's platform. The failures are **not product logic bugs** — they are the new AR-8 cross-engine parity tests timing out on PGLite's slow WASM cold-start.
- **Evidence.** Two clean local runs 2026-07-04 (no `DATABASE_URL`): `3546/9 fail` then `3548/7 fail` — the count itself flaps, the signature of a timing flake. **All failures are in `test/parity.test.ts` → "SQLite/PGLite behavioral parity seeds"** (e.g. `agree on filtered page lists…`, `derived jobs and derived index state round-trip…` at 30,269 ms). Each reports `this test timed out after 5000ms`; the tests pass no explicit timeout argument (`parity.test.ts:117,173,212,380,437,497`) and the file does not honor `TEST_TIMEOUT_MS`. This matches the known PGLite-macOS timeout flake contract. So AR-8 shipped tests that fail by default on the target dev platform.
- **Fix.** Give the PGLite parity tests an adequate per-test timeout (honor `TEST_TIMEOUT_MS` with a generous macOS default, or set a per-test/`describe`-level timeout sized to PGLite cold-start; consider a one-time PGLite warm-up before the suite). Do **not** loosen the assertions. Then wire `/ship`'s pre-landing gate to block on any non-skip failure. Re-triage whether any residual failure is a real cross-engine divergence (KR-5's Korean AND/OR gap is one candidate the matrix should eventually catch).
- **Files.** `test/parity.test.ts`, test harness timeout config, `/ship` gate.
- **Effort.** S–M.
- **Acceptance.** `bun test` green on macOS with no `DATABASE_URL` across three consecutive runs; a deliberately-broken assertion makes the ship gate fail.

### SEC-1 · Authenticate the `mbrain review` server
- **Problem.** The new local triage server exposes `GET /api/candidates` (full candidate content) and `POST /candidates/:id/{verify,refute}` with **no auth, no CSRF token, no Origin/Host check**. `verify` stamps `verification_status:'verified', method:'user_confirmation'`, which (with `auto_promote.eligibility.require_verification` on) promotes the candidate into the canonical-eligible lane. Any web page open in the owner's browser can POST a cross-site form to `http://127.0.0.1:8791/candidates/<id>/verify` (a CORS-exempt "simple request") — a one-click **memory-poisoning escalation**. DNS-rebinding gains read of private candidate content. `--host 0.0.0.0` exposes all of it to the LAN with no warning.
- **Evidence.** Routes dispatched before `authenticate()` and the rate limiter (`http-server.ts:134-147` vs `:159,167`). `review.ts` `handleReviewRoute` reads no token/Origin/Host; verify path sets `verified`/`user_confirmation` (`review.ts:70-95`). Standalone `runReview` binds `--host` unchecked (`review.ts:38`), default 127.0.0.1.
- **Fix.** Require a per-session secret (printed once at `mbrain review` start, sent as a bearer header or a signed cookie) on every mutating route; validate `Origin`/`Host` against the bind address (defeats CSRF + rebinding); refuse a non-loopback `--host` unless `--i-know` is passed, with a printed warning. GET of candidate content also gated. Put review routes behind the same auth/rate-limit ordering as `/mcp`.
- **Files.** `src/commands/review.ts`, `src/mcp/http-server.ts`.
- **Effort.** M.
- **Acceptance.** Cross-site form POST without the secret → 403; `Origin` mismatch → 403; non-loopback bind without opt-in refuses to start; the happy-path UI (same-origin, with secret) still verifies.

### SEC-2 · Fix `/mcp` on the `review_local` profile (double body read → always 500)
- **Problem.** With `mbrain review`'s `review_local` HTTP profile, every JSON-RPC POST to `/mcp` returns 500 — the surface is dead. The request body is consumed by `boundHttpRequestBody(request)` in the review branch (locking the stream), then re-read on the *original* `request` in the `/mcp` fall-through, throwing a TypeError on the disturbed stream.
- **Evidence.** `http-server.ts:135` bounds `request`; review handler returns `null` for non-review paths (`review.ts:96`); `:153` calls `boundHttpRequestBody(request)` again on the original locked stream. New tests never POST `/mcp` under `review_local`, so it's unfenced.
- **Fix.** One line: after the review branch, fall through using `boundedRequest.request` instead of re-bounding `request` (reuse the already-read body). Add a `review_local` `/mcp` `tools/call` test.
- **Files.** `src/mcp/http-server.ts`, `test/mcp-http-transport.test.ts`.
- **Effort.** S.
- **Acceptance.** An `initialize`/`tools/call` POST to `/mcp` under `review_local` returns a valid JSON-RPC response, not 500.

---

## 5. P1 — Close the loop

### GV-3b · Nightly report actually lands, plus delivery
- **Problem.** The declared primary review surface fails to write under the installed scheduler and has no delivery/alarm.
- **Evidence.** `autopilot.ts:125` passes `report_dir: input.report_dir ?? '.'`; `memory-report.ts:139-140` → `saveBrainReport({brainDir: input.report_dir})`; `report.ts:74` `mkdirSync(join(brainDir,'reports',type))`. `submitCycle`'s dreamInput carries no `report_dir` (`autopilot-service.ts:151-159`); the launchd plist has no `WorkingDirectory` and the run script never `cd`s (`setup-agent-autopilot.ts:114,130-152`). Under launchd cwd=`/` → `mkdirSync('/reports/…')` EPERM every night. `notify` and the dead-night alarm floor have zero occurrences in `src/`.
- **Fix.** Resolve the report dir from the **configured brain directory** (absolute), never cwd; thread it through `submitCycle`. Build `report.notify = {mode:'auto'|'command'|'off'}` (osascript/notify-send with a one-line count summary + path; command pipes JSON; silent no-op when unavailable). Add the alarm floor: beacon + warn when N≥2 consecutive nightly jobs die (streak logic in the health beacon, read by doctor). Fix the dry-run mutation (§7 finding — `runDailyReportPhase` saves unconditionally).
- **Files.** `src/commands/autopilot.ts`, `src/core/services/autopilot-service.ts`, `src/commands/memory-report.ts`, `src/core/config.ts`, `src/core/health-beacon.ts`, `src/core/services/dream-cycle-runner-service.ts`.
- **Effort.** M.
- **Acceptance.** A simulated launchd run (cwd=`/`) writes the report under the brain dir; notify-resolver unit test covers platform + command + off; doctor flags a 2-night dead streak; `--dry-run` writes nothing.

### GV-1b · Close the stranding window + repair sweep
- **Problem.** A throw between `advanceToStaged` and a successful promote strands the candidate at `staged_for_review`, invisible forever.
- **Evidence.** `promote-gate.ts:133` advances outside a transaction; internal re-preflight in `memory-inbox-promotion-service.ts:65-72` can defer/throw; caught at `promote-gate.ts:149` with no rollback; selector scans `captured|candidate` only (`candidate-selector.ts:24`).
- **Fix.** Wrap advance+promote in the existing transaction seam; roll back status on any throw. Add a one-shot repair sweep (dream maintenance) that demotes `staged_for_review` + unverified rows back to `candidate` (or lists them in the report).
- **Files.** `src/core/auto-promote/promote-gate.ts`, `src/core/services/memory-inbox-service.ts`, dream maintenance.
- **Effort.** M.
- **Acceptance.** A promote that throws post-advance leaves status `candidate`; a pre-stranded row is repaired/listed by the sweep.

### GV-2b · Incomplete-handoff debt fail-closed + its own report section · S
- **Evidence.** `inbox-lead-service.ts:45` treats missing `completed_canonical_handoff_candidate_ids` as "all completed"; only `memory-report.ts:281-282` passes it. Report folds incompletes into a count-only line (`memory-review-report-service.ts:549`).
- **Fix.** Default to fail-closed (missing set ⇒ query the completion column, don't assume complete). Add a `promoted_handoff_incomplete` section with per-row `apply_memory_patch_candidate <id>` / `put_page <slug>` actions.

### GV-4b · Fallback preserves evidence_kind · S
- **Evidence.** `expired-write-session-fallback-service.ts:75,125-128` (`null → 'manual'`); `candidate-selector.ts:90-95` (`'manual' → direct_user_statement`). `normalized_signal.evidence_kind` is stored and unused.
- **Fix.** Carry the stored `evidence_kind` (or map `source_extracted` sessions to `extracted`, not `manual`); never let a null extraction default to the highest authority class.

### GV-7b · True counts over the full backlog · M
- **Evidence.** `memory-report.ts:53` `DEFAULT_LIMIT=100`; ordering `updated_at DESC` (`sqlite-engine.ts:2943`, `pg-engine-base.ts:378`); summary counts = lengths of truncated arrays (`memory-review-report-service.ts:536-560`); zero `COUNT(*)`.
- **Fix.** Add `COUNT(*)` totals and "showing N of M" markers; compute debt/escalation (GV-9)/health (KM-5) over the full candidate/page set (or an age-ordered window, so the *oldest* surface, not the newest). Disclose every scan cap (page-health `max(limit,100)`, sweeps 1000).

### KM-1b · Correct compile-debt arithmetic · S–M
- **Problem/Evidence.** `compileDebtForPage` (`operations.ts:4381-4403`) and `buildCompileDebtPatchProposal` (`operations-memory-inbox.ts:3180-3212`) count *all* `timelineEntryDates(page.timeline)` and age from the oldest, so mature pages dominate and neglected small pages vanish.
- **Fix.** Count only timeline lines dated after `compiled_truth_changed_at`; age from the newest-uncompiled line (or the count×median-age). Fix both the metric op and the patch proposal; re-validate KM-5's compile-debt penalty ordering.
- **Acceptance.** An 80-old-entry page with one new line scores ~1×(small age); a 3-entry all-new page outranks it.

### KM-3b · Recompile rewrites the compiled zone, as a real phase · M · **[FLAG]**
- **Problem/Evidence.** The template appends the whole timeline into `compiled_truth` (`operations-memory-inbox.ts:3196-3216`) — corrupts the two-zone model if applied; and it's op-only, not a dream phase, with no runner (`DREAM_CYCLE_PHASE_FAMILIES` has no recompile entry).
- **Fix.** Patch body must be a **rewritten compiled zone** (distilled best-understanding preserving `[Source:]` citations), never the raw timeline. Add a runner-gated `recompile` dream phase (default off) that picks top-N KM-1b debt pages and prompts the local runner via the `cli-executor` seam to produce the rewrite as a **patch candidate** (never a direct write, per DG-6). Deterministic floor with no runner: emit the KM-1b debt list only, and honestly return `skipped/runner_unavailable`.
- **Acceptance.** Fake-runner test yields a patch candidate whose `compiled_truth` is a rewrite (no verbatim timeline block); flag-off/runner-absent → `skipped/runner_unavailable`; nothing written to the page.

### GV-5b · Timeout follow-through · S
- **Evidence.** `withPhaseTimeout` (`dream-cycle-runner-service.ts:342-373`) resolves the timeout result and abandons the losing promise with no rejection handler — the aborted work typically rejects moments later, surfacing as a process-level unhandled rejection that can kill the nightly `run-once` mid-cycle (leaving the job row `active` until swept dead). Also: no `maintenance.phase_timeout_ms` config key exists (CLI flag + hard default only), and `timed_out` is recorded per run but never aggregated anywhere.
- **Fix.** Attach a no-op catch to the abandoned promise once the timer wins; add the config key; surface "phase X timed out N nights running" in the daily report (the data path the prior spec's GV-5 acceptance assumed).
- **Acceptance.** A phase that rejects after losing the timeout race does not crash the run; the report lists repeat-timeout phases.

### GV-6b · Remove the dead contradiction guard · S
- **Evidence.** `excludedByOpenContradiction` (`auto-promote/service.ts:276-290`) is unreachable — contradictions require both parties `staged_for_review|promoted` (`memory-inbox-contradiction-service.ts:70-75`) while auto-promote scans `captured|candidate`. Preflight now covers the real path (GV-6 shipped).
- **Fix.** Delete the dead guard (the preflight check is the live one), or make it reachable if a design reason exists; do not leave provably-dead governance code.

### WQ-1 · Watched questions: same-night reporting + honest probe failures · S–M
- **Evidence.** Nightly probes record runs with `created_at = now` while the report windows `[now−7d, now)` with strict `<` on both engines (`dream-cycle-runner-service.ts:717-724`; `memory-report.ts:588-599`) — same-night changes are excluded, so every watched-question change surfaces a day late. And `watched-question-service.ts:79-81` swallows all probe errors into `skipped++`: a provider outage reads as "no changes", and a run that records but fails the snapshot update re-alerts the same change every subsequent night.
- **Fix.** Make the report window inclusive of the run timestamp; record per-question failure reasons and surface a failure count in the report; advance the snapshot in the same transaction as the run row.
- **Acceptance.** A change probed at T appears in the report generated at T; a failing probe yields a visible failure count with reasons; a snapshot-update failure does not re-alert forever.

### KR-5 · Korean CJK query AND/OR parity · M
- **Problem/Evidence.** PG ORs CJK tokens (`pg-engine-base.ts:5056,5230`, any-token match); SQLite ANDs them (`sqlite-engine.ts:9935`, all-token match). `레벨리온 아키텍처` over a corpus with only `레벨리온은` → PG returns it, SQLite doesn't. Invariant 8 breaks for the Korean queries the wave targeted. (Also: the PG CJK leg builds `to_tsvector('simple', …)` per row with no index — a seq scan on every Korean query; index it once measured.)
- **Fix.** Pick one semantics (recommend AND-of-tokens with per-token prefix, matching SQLite and the English leg) and apply on both engines; add the Korean cases to EV-1b fixtures on both engines. Add a `simple`-config GIN index when the seq-scan cost is confirmed.
- **Acceptance.** Identical Korean multi-term result ordering on PG and SQLite in an EV-1b cross-engine fixture. (Note: this is the kind of divergence the AR-8 parity matrix should catch — add a Korean family to it.)

---

## 6. P2 — Make the instrument real *(GATE for P3)*

The prior wave's own thesis was "none of the retrieval work can be tuned safely without measurement." That instrument shipped, but it is not trustworthy (§2.4). P3 must not flip or tune anything until this is fixed.

### EV-1b · A gold set that can actually catch a regression · L
- **Problem.** 3 synthetic single-gold cases over a 3-page purpose-built corpus; `precision@10` is a constant 0.1; per-route labels unverified against the route actually taken; CI re-reads a static JSON so it can never fail.
- **Fix.** (1) Mine 30–100 cases from live `retrieval_traces` (now default-on per TR-1) + RS-5 recurring-gap clusters + real past questions; include **multi-gold** cases, hard negatives, and all routes (`precision_lookup`, `broad_synthesis`, `mixed_scope_bridge`, `personal_profile/episode_lookup`) and Korean cases on both engines. (2) Ship a `--seed` corpus mode so `eval:retrieval` runs against a known fixture DB, not the operator's coincidental live pages. (3) CI runs the **live** eval against the seeded corpus (recall@k/precision@k/MRR per route), not a JSON re-read. (4) Cross-check the fixture route against the trace's actual `selected_intent`; flag mismatches.
- **Files.** `test/fixtures/retrieval-eval/*`, `src/core/evaluation/retrieval-eval.ts`, `src/commands/eval.ts`, a CI workflow job.
- **Effort.** L.
- **Acceptance.** `eval:retrieval` on the seeded corpus reports per-route recall@10/precision@k/MRR over ≥30 cases; a deliberately-broken ranking makes it drop; per-route labels are verified, not asserted.

### EV-1c · Baseline-delta regression mode · M
- **Evidence.** `--compare` exists only under `eval context` and drops `per_route` (object values skipped, `eval.ts:421-433`). No stored retrieval baseline.
- **Fix.** `eval retrieval --compare <base> <head>` with per-route deltas; commit a baseline artifact **per config** (old vs new default × sqlite/PG × ±embeddings) so "non-regression" is a demonstrated delta, not a filename. This is what P3's gate consumes.

### EV-2b · Make `J` measure quality · S
- **Evidence.** `J ≤ 0` always — groundedness never supplied (`memory-report.ts:676-679`); the recall@10 G-proxy was never wired.
- **Fix.** Default G to EV-1b's recall@10/top1 proxy so `J` reflects retrieval quality, not just redundancy+cost. (Also fix the dead re-escalation detection: traces' `route` never contains retry steps, and the `\bfallback\b` regex can't match snake_case — `retrieval-trajectory-score.ts:143-145`.)

---

## 7. P3 — Harden the default-on retrieval **[GATE: EV-1b artifact]**

Nothing here flips or tunes a default without an EV-1b non-regression delta on the enabled-flags config.

- **RQ-3b · Batch the probe · M.** `searchCandidatePool` fires one `hybridProbeSearch` per variant (`retrieve-context-service.ts:956-958`), each running `getEmbeddingCoverageWarning`→full `getHealth()` (`hybrid.ts:89`; `pg-engine-base.ts:972-990`) serially, its own embed round-trip, and 3 vector scans. Concrete: default config + local embedder + 3 known_subjects → ~12 `getHealth` aggregates + ~12 embed calls + ~30 vector scans per one `retrieve_context`. Batch all variant embeddings in one `embedBatch`; cache one coverage check per probe; drop the double limit-inflation (`hybrid.ts:62-63`). This was RQ-7's stated prerequisite and was skipped before the flip.
- **RQ-6b · Config rank rules reach the probe · S.** `rankSearchResults` (`retrieve-context-service.ts:388`) and `sourceRankFactor` (`:1298`) ignore `ctx.config.retrieval_source_rank_rules`, so the owner's `office//personal/` prefixes are honored in `search`/`query` but not in the `retrieve_context` candidate ranking agents actually follow.
- **RQ-3c · Cap known_subjects variants · S.** The subjects loop (`:1059-1061`) appends past `MAX_CANDIDATE_QUERY_VARIANTS`; each extra variant is a full hybrid search.
- **RS-8b · Usable pgvector index · M.** All three PG vector legs `ORDER BY (1 - (embedding <=> $1)) DESC` (`pg-engine-base.ts:5154+`) — pgvector's HNSW only satisfies `<=> ASC LIMIT n`, so every leg seq-scans. Rewrite to ASC distance. §10.1's "HNSW present" is true of the schema, false of the plans; RS-8 tripled these scans.
- **RQ-9b · Collapse cross-variant RRF · S.** `fuseCandidateSearchResults` sums `1/(61+rank)` across heavily-overlapping variant lists (`:1140`) — the amplification RQ-9 fixed inside `hybrid.ts` persists one level up. Take max across variant lists.
- **RS-4b · Temporal params on `retrieve_context` · S.** `updated_before/after` exist on `search`/`query` but not `retrieve_context`; add them + a real 5%-window recency tiebreak using `compiled_truth_changed_at` (currently unused in ranking).

Also verify, as part of the gate, the ranking behavior RQ-8's normalization introduced: base relevance now compresses to ≤10 points while flat bonuses run +8..+56, so a pool-rank-#30 page with one title-token hit can outrank the #1 search result (`retrieve-context-service.ts:2440-2443,1297`). This is exactly what EV-1b exists to measure.

---

## 8. New directions (durable, beyond gap-closure)

### 8.1 · NEW-1 — Self-healing serve as a product principle
The live incident is not a bug, it's a **missing invariant**: *a running mbrain surface must never serve requests against a schema it wasn't built for.* OP-1/OP-2 fix the instance; the principle is broader and worth encoding as an architecture decision:
- Every engine carries a `builtForSchemaVersion` constant; `connect()` compares it to `getConfig('version')` and either migrates (owner-local) or fails closed with remediation (shared).
- `mbrain upgrade` restarts or signals running stdio servers (today it only refreshes rules; the MCP client keeps a stale process until it re-spawns).
- Autopilot's wrapper stops baking an absolute binary path (`setup-agent-autopilot.ts:60-72`) that a `bun update -g` silently breaks — resolve `mbrain` on `PATH` at run time, so the one automatic healer can't be orphaned.
This turns "the brain broke silently after a pull" into a class of failure the runtime refuses to enter. It is the single highest-leverage durable improvement, because it protects the product's core promise from the most common real-world event (an upgrade).

### 8.2 · NEW-2 — Trustworthy-by-construction eval flywheel
The instrument's weakness is that its gold set is hand-built and tiny. TR-1 now persists a trace per probe by default. Close the loop: a dream phase periodically samples real answered/unanswered traces, and (runner-gated) proposes new gold cases (query + the slugs that were actually read + whether the agent's downstream action succeeded) into a reviewable eval-candidate queue. The eval set then grows from the owner's real usage, the routes that actually get exercised, and the real Korean queries — exactly the distribution P3's gate needs. This is the retrieval analogue of the governed memory ladder: never auto-trust, always review, but let the system *propose* what to measure. It makes EV-1b self-sustaining instead of a one-time L-effort artifact that rots.

### 8.3 · Smaller durable wins (P4 one-liners)
- **AR-5b migration squash** — declared baseline v48 unused; fresh installs replay 63 handler-bearing migrations. Seed fresh installs at `LATEST_VERSION` on all engines (PGLite already does at v12); keep `freshSchemaMigrationSql` equivalence as proof. Highest mechanical ROI: 63→~16 replays, `migrate.ts` shrinks by thousands of lines.
- **AR-7b split `retrieve-context-service.ts`** (2,759 lines, +31% this wave) before the next retrieval item — seams already exist (`candidate-signal-service`, budget services, split-contract test).
- **AR-3b explicit `tier` per op** — kill the `ADMIN_NAME_FRAGMENTS` substring heuristic (a rename can silently promote an admin op into the default catalog); fix bare-`serve` default (125 tools) vs help text ("default: core"). One field per op.
- **AR-6b `as any` ratchet** — rose 78→85; add a decreasing-only fence test; retrofit the two largest siblings.
- **DOC-1** — 74/188 ops appear in no doc; extend `operation-docs-contract.test.ts` to require a doc or an explicit `undocumented: reason` per non-admin op.
- **KM-4b** — `lint`/`check-backlinks` validate `superseded_by` targets (a typo silently ×0.5-demotes a page forever with a dangling pointer).
- **AR-4b decode-helper honesty** — `decodeJsonColumn` (`storage/json-column.ts:16-35`) silently converts corrupt JSON to `{}`/`[]` (provenance can vanish without a trace) and its "parse again if string" repair double-decodes legitimate JSON-string values (a stored `"123"` round-trips as the number `123`) — the same double-encoding regression class this repo has fenced before, now guessed at read time. Flag corruption instead of guessing; note `encodeJsonColumn` is exported but unused in `src/`, and adopting it as-is would mangle string values on write.
- **KM-2b `put_page` advisory check truly non-blocking** — the duplicate warning is awaited unguarded (`operations.ts:3642`); a transient error inside `reviewDuplicateMemory` fails the whole canonical write even though the check is advisory, and every new-slug `put_page` pays a `getPage` + 5-match review. Guard it; consider skipping inside write sessions.
- Lower-severity retrieval/eval items to fold in opportunistically: RS-6 direct-candidate injection (currently variants only), RS-3 capped-multiplier usage ranking (currently flat +16, can outweigh relevance when on), the alias-scan 500-manifest cap truncating silently (`retrieve-context-service.ts:1077-1081`), eval judge-lane robustness (a malformed judge reply crashes the whole run; a judge *runner* failure returns `passed:null`, which counts as a pass), and retrieve-traces persisting `retrieved_token_count: 0` unconditionally (undercounts report token totals).

---

## 9. Decisions needed from the owner

| Gate | Question | Recommendation |
|------|----------|----------------|
| **D-A** | OP-1 local auto-migrate: migrate owner-local engines automatically at connect, or require an explicit `mbrain migrate`? | **Auto-migrate local; fail-closed remote.** Matches `init`/autopilot; the owner's stdio server breaking on pull is the worse outcome. |
| **D-B** | Should RQ-7 (governed hybrid probe) and auto-route **stay default-on**, given they flipped without a real instrument and carry the probe fan-out cost (RQ-3b) plus the Korean cross-engine divergence (KR-5)? | **Keep on for this install, but treat P3 as validation, not optional** — build EV-1b, run the real baseline delta, and be prepared to revert the global default if it regresses. Do not flip the *global* default until EV-1b passes. |
| **D-C** | Version bump: `0.15.0` or `0.14.4`? | **0.15.0** — schema-affecting (v59–v64) + new default-on behavior + new surfaces; a patch bump understates the migration requirement. |
| **D-D** | `mbrain review` non-loopback bind (`--host 0.0.0.0`): forbid, or allow behind an explicit opt-in? | **Allow behind `--i-know` + printed warning**, never by default; SEC-1's auth is required regardless. |
| **D-E** | KM-3b recompile: keep runner-gated patch-candidate only, or ever allow direct compiled-zone writes? | **Patch-candidate only** (upholds DG-6); the current append-timeline template is a bug, not a design. |
| **D-F** | EV-2 `J` on the report while G is unwired — keep showing a ≤0 number, or hide until EV-2b? | **Hide/label as "cost+redundancy only" until EV-2b** — a permanently-negative "quality" score misleads. |

---

## 10. Non-goals

- **Re-porting Memora's index lanes (AL-1/AL-2/RF-1) or a reranker (RS-7)** — DG-8 stands: build only if EV-1b shows a residual gap after the deterministic changes. Not now.
- **SQLite/Postgres engine-code unification** — dialect divergence is real; KR-5 picks a shared *semantics*, AR-8 parity tests are the guardrail, not shared SQL.
- **Autonomous compiled-truth rewriting** — KM-3b stays patch-candidate + review.
- **Multi-user auth/RLS, cloud-OAuth capture connectors** — deferred; SEC-1 is single-user hardening, not a multi-tenant model.
- **Re-speccing direction bets D-1..D-5** — they keep their ownership in `2026-07-03-mbrain-direction-bets.md`; NEW-1/NEW-2 here are runtime-resilience and instrument-integrity, not those product bets.
- **Resurrecting the retired assertion apply path** — ADR 2026-06-22 stands.

---

## 11. Verification plan

- **P0 exit — against the LIVE brain:** after OP-1/OP-3, `mbrain init` brings the DB to v64; `get_health`, `retrieve_context`, and a pure-Korean `mbrain search` all succeed; `doctor` reports `schema_up_to_date:true`; `bun test` is green (OP-4).
- **Per item:** the acceptance criteria above; every schema change ships with three-engine migration coverage (`migrate.test.ts` column-parity guard); every ranking-adjacent change adds an EV-1b fixture.
- **Security:** SEC-1 covered by CSRF/Origin/rebinding unit tests + a non-loopback-refusal test; SEC-2 by a `review_local` `/mcp` `tools/call` test. §10.1 of the prior spec (verified-good security fundamentals) must not regress.
- **P2 gate:** EV-1b produces a per-route baseline on ≥30 real-derived cases with a seeded corpus in CI; EV-1c reports a per-config delta; EV-2b's `J` moves with recall.
- **P3 entry gate:** no default flip or ranking tune lands without an EV-1b non-regression delta vs the P2 baseline.
- **Docs:** every ship runs `/document-release`; OP-3's migration file + changelog land with the version bump.

### 11.1 Known blind spots
- The failing unit tests were enumerated (2026-07-04): all 7–9 (count flaps run-to-run) are `test/parity.test.ts` PGLite parity cases timing out at the default 5000 ms — a timeout/flake, not a logic bug (OP-4). No non-parity test failed.
- Governance/retrieval findings were verified against code, not against the live instance's actual debt counts (the live instance can't currently answer — it's the OP-1 patient); the P0 exit check closes this.
- `reference/Memora` remains a local untracked checkout; the durable pointer is arXiv 2602.03315.

### 11.2 Finding provenance
Findings trace to six parallel audits (governance, retrieval, eval, newest-code bug hunt, operational, architecture), each cross-checked against source on 2026-07-04. The load-bearing items (live drift, migration-at-startup gap, SEC-1/SEC-2, GV-3b path, KM-1b/KM-3b, the RQ-3b probe fan-out, EV-1 gate ceremony, GV-4b authority, the KR-5 AND/OR divergence, the RS-8b `ORDER BY … DESC` index-unusable form, and the v0.14.3=v60 migration ceiling) were independently re-verified in-tree by the spec author before inclusion.
