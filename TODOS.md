# TODOS

## v0.41.38.0 dream-postgres / source-pin follow-ups (v0.42+)

Deferred from the v0.41.38.0 wave (code-callers/callees pin + dream-on-postgres).
Documented tradeoffs, not blockers — the shipped bug fixes are complete and tested.

- [ ] **P1 — Per-source autopilot fan-out passes the global repoPath.**
  `src/commands/autopilot-fanout.ts:~206` submits every per-source `autopilot-cycle`
  job with `repoPath: opts.repoPath` (the global checkout), not `src.local_path`.
  With v0.41.38.0's `cycleSourceId = opts.sourceId ?? resolveSourceForDir(...)`,
  a per-source job now reconciles DB phases for `src.id` while the filesystem
  phases (sync/lint/extract) run against the default brain's checkout, then stamps
  `src.id` fresh — mixed scope. Pre-existing fan-out limitation (cycle.ts PHASE_SCOPE
  comment already notes genuine per-source fan-out needs deferred work); the common
  single-source autopilot path (legacy no-source dispatch) is unaffected. Fix:
  resolve brainDir from the source's `local_path` inside the `autopilot-cycle`
  handler when `source_id` is set (mirror dream.ts's T1), so FS and DB phases agree.
  Needs its own review (touches the deferred autopilot path).
- [ ] **P2 — `.gbrain-source` with invalid SYNTAX still falls through silently.**
  `readDotfileWalk` (source-resolver.ts:39) intentionally skips a dotfile whose
  content fails `isValidSourceId` (e.g. `repo_a` with an underscore) per the v0.31.8
  P1-F silent-fallback design, so `resolveScopedSourceOrThrow` resolves it to a
  later tier rather than surfacing `invalid_source_pin`. A valid-syntax-but-missing
  pin DOES surface (assertSourceExists throws). Decide whether a typo'd dotfile
  should warn loudly; changing it alters resolver semantics shared by other callers.
- [ ] **P3 — Sibling source-scoped commands don't honor the pin.** `blast`/`flow`/
  `clusters`/`wiki` still call `resolveDefaultSource` directly. Route them through
  `resolveScopedSourceOrThrow` for consistency with code-callers/code-callees.
- [ ] **P3 — `gbrain autopilot` CLI daemon pre-guard.** `autopilot.ts:~152`
  `if (!repoPath) exit 1` still blocks the daemon on a checkout-less postgres brain.
  Relax to the same null-brainDir contract so the daemon can run DB phases.

## v0.41.37.0 critical-fix-wave follow-ups (v0.42+)

Filed from the v0.41.37.0 wave (#1621 tag-wipe, #1581 grandfather hang,
#1605 Windows migration spawn, #1569 sync ReDoS hardening). Each item was
deliberately scoped out of the wave (see plan + GSTACK REVIEW REPORT at
`~/.claude/plans/system-instruction-you-are-working-greedy-quiche.md`).

- [ ] **#1621-followup: tag_source provenance column for frontmatter-tag REMOVAL.** The wave shipped ADD-ONLY tag reconciliation (`src/core/import-file.ts`) — re-import never deletes tags, so DB-side enrichment tags survive. Trade-off: removing a tag from a page's frontmatter no longer removes it from the DB. To restore removal-on-edit without wiping enrichment tags, add a `tags.tag_source` column (migration, both engines), stamp `'frontmatter'` on import-path tags, and reconcile by deleting only `tag_source='frontmatter'` tags absent from the new frontmatter (enrichment/backfilled tags default NULL = preserved, so no enrichment-write-site enumeration needed). Priority: P3 (additive-metadata staleness is low-harm).

- [ ] **#1605-followup: convert migration backfill-phase spawns to in-process.** v0.41.37.0 made the 9 schema phases (`gbrain init --migrate-only`) run in-process via `runMigrateOnlyCore`, which unblocks `schema_version` advancement on Windows+bun+Supabase. The remaining non-schema spawns (`extract links/timeline`, `repair-jsonb`) still shell out via `runGbrainSubprocess` — they now surface child stderr (so a Windows failure is diagnosable) but still fail on Windows. Convert them to in-process calls (the extract/repair command functions are callable with an engine) so Windows brains complete data backfill, not just schema. Sites: `src/commands/migrations/v0_12_0.ts` (extract), `v0_12_2.ts` (repair), `v0_13_0.ts` (extract). Priority: P2.

- [ ] **#1569-followup: root-cause the 56K-file sync wedge with the reporter's repro.** v0.41.37.0 shipped ReDoS hardening (input-length cap + star-height lint + `--no-schema-pack` escape) + diagnostics (`GBRAIN_SYNC_TRACE=1` begin-heartbeat + PGLite serve/sync concurrency doc), but did NOT root-cause the deterministic wedge at ~3100 files — the reporter's redos-guard hypothesis didn't hold (it's not on the sync path). Get the reporter's sample files (`/tmp/gbrain-hang-sample.txt`, `/tmp/gbrain-prewedge-sample.txt`), reproduce, and pin the resume-mode deep-recursion pre-import phase (prime suspect: the walk/diff/checkpoint path). Priority: P1 once a repro exists; tracked on the #1569 thread.
## MCP skillpack distribution — PR2 (v0.41.37+)

Filed from the v0.41.36.0 skill-catalog wave (`list_skills` / `get_skill`).
PR1 shipped the read-only catalog; PR2 is the download-and-install surface,
deferred per the plan's D1 + D8 because it stands up new HTTP/binary/token
infra and reaches into third-party packs that live outside the host skills dir.

- [ ] **v0.41.37+: `build_skillpack` op + `GET /skillpack/download/:token` endpoint.** Build a deterministic `.tgz` on demand (named skillpack, ad-hoc skill subset, or whole repo) and deliver it both base64-inline (universal/stdio) and via an authenticated short-lived download URL when running under `gbrain serve --http`. **What:** new admin-or-write-scoped op + a token-store + cache-dir GC; reuse `packTarball` from `src/core/skillpack/tarball.ts` (already deterministic + symlink-rejecting + size-capped) and the magic-link nonce pattern in `serve-http.ts`. The tarball ships source CODE, so it needs its own trust decision separate from PR1's prose-only catalog. **Why:** lets a thin client install a skillpack into its own setup, not just follow one live. **Depends on:** PR1 (landed in v0.41.36.0). Priority: P2.
- [ ] **v0.41.37+: `include_skillpacks` merge in `list_skills`.** Fold pinned third-party packs (from `~/.gbrain/skillpack-state.json`) into the catalog. Deferred from PR1 (D8) because packs live OUTSIDE the host skills dir and need (a) a per-pack trusted-root realpath confinement and (b) `{name, skillpack_name?}` disambiguation when a pack skill and a host skill share a name. Lands naturally with PR2's pack machinery. Priority: P2.
- [ ] **v0.41.37+: TTL+mtime cache for the skill-catalog walk.** PR1 reads fresh every call (cold path, ~ms). If telemetry shows repeated `list_skills` calls, add a TTL+mtime-keyed cache shared by `list_skills` + `get_skill`. Priority: P3 (do-nothing was the deliberate PR1 call).
- [ ] **v0.41.37+: routing-eval for the `list_skills` instructional envelope + per-skill `tools:` version-skew validation.** The envelope is load-bearing prose with no eval gate yet; and a skill's declared `tools:` aren't validated against the serving gbrain's actual op set for version drift. Priority: P3.
- [ ] **v0.41.37+: fix malformed `~/.agents/skills/gbrain/.../install/SKILL.md` (missing frontmatter).** Surfaced by codex's own startup error during the v0.41.36.0 plan review — an unrelated stray skill in the agents tree has no `---` frontmatter fence. Not gbrain-repo code; flag/clean separately. Priority: P3.
## v0.41.34.0 retrieval-cathedral follow-ups (v0.42+)

Deferred from the v0.41.34.0 wave (codex adversarial P1/P2 — documented tradeoffs,
not blockers; the P0 source-isolation issues were fixed in-wave).

- [ ] **P1 — Calibrate the `evidence` classifier.** `high_vector_match` is assigned
  from `base_score >= 0.85`, but `base_score` is the pre-boost RRF/keyword/title/alias
  pipeline score, not a pure cosine. A generic high-scoring page can read as
  `create_safety='exists'`. Add a true vector-cosine signal (or a `keyword_exact`
  exact-token check) so the evidence labels are grounded, not inferred from the blend.
  File: `src/core/search/evidence.ts`. **Why:** the evidence contract is what stops
  the duplicate-page class; mislabeled evidence weakens it.

- [ ] **P1 — Page-bounded vector pagination.** `searchVector` innerLimit is
  `offset + max(limit*5, 100)` counted BEFORE `DISTINCT ON`, so on a dense page one
  page can consume the candidate budget and a deep `OFFSET` can underfill even when
  more pages exist. Restructure to a two-stage pull (top-N chunks → pool → re-expand)
  or raise innerLimit adaptively for deep offsets. Files: both engines' `searchVector`.
  **Why:** deep search pagination on big brains can return short pages.

- [ ] **P2 — Telemetry rolling-deploy gap.** Pre-v111 (mid rolling deploy), rank-1
  telemetry INSERTs reference missing columns and the write is swallowed, so a window
  of telemetry is silently lost and `search stats` reads empty on old tables. Either
  feature-detect the columns before writing the extended INSERT, or accept the gap
  (documented). File: `src/core/search/telemetry.ts`. **Why:** brief observability
  blind spot during upgrades.

## v0.41.33.0 adaptive return-sizing follow-ups (v0.42+)

Filed from the v0.41.33.0 wave (intent-aware adaptive return-sizing, born from
the PrecisionMemBench integration in gbrain-evals). The feature shipped
default-off; these are the gates and extensions before any default flip.

- [ ] **v0.42+: cross-surface ablation before flipping `search.adaptive_return` default.** The gate ships default-off. Before turning it on in any `MODE_BUNDLES` tier, run the recall ablation (adaptive off vs on, recall-preserving caps) across `gbrain eval longmemeval`, `gbrain eval whoknows`, `gbrain eval suspected-contradictions`, and the BrainBench-Real replay (sibling gbrain-evals repo). Confirm recall@k / answer quality does not regress; pick the safe caps; probably flip `tokenmax` first (broadest searchLimit, most noise). On-surface evidence (the PrecisionMemBench precision/recall frontier: off 0.076/0.99, e1/o2 0.40/0.91, e1/o1 0.58/0.82) is recorded in `gbrain-evals/docs/benchmarks/2026-05-29-precisionmembench.md`. Priority: P2.
- [ ] **v0.42+: fold adaptive-return params into KNOBS_HASH so adaptive-on calls can cache.** v0.41.33.0 skips `hybridSearchCached` entirely when the gate is on (cache-safe but cache-cold). Fold `adaptive_return` enabled + caps + `minKeep` into `knobsHash()` (append-only, bump `KNOBS_HASH_VERSION`) so a gate-on write segregates from a gate-off row and adaptive calls cache correctly. Required before any default flip (else default-on means cache-cold everywhere). See `src/core/search/mode.ts` KNOBS_HASH parts + `return-policy.ts`. Priority: P2 (paired with the default-flip ablation above).
- [ ] **v0.42+: gentle adaptive gate on `think`'s gather stage (A3).** The plan's A3 decision was a gentler return-gate on `runThink`'s gather candidates (cleaner context, fewer tokens per reasoning call). Deferred because the benefit is unvalidated without a longmemeval answer-quality run, and trimming the answer path (even default-off) carries regression risk. gather fuses 4 streams (page / takes-keyword / takes-vector / graph); the gate must operate on the fused output with a higher min-keep than search, validated on `gbrain eval longmemeval` answer quality (not retrieval precision). Also: `RunThinkOpts` has no `sourceId` today, so think's gather runs unscoped (codex finding) — scope-isolated think needs that plumbing first. Priority: P2.
- [ ] **v0.42+: `--explain` human header for adaptive_return.** The decision is in `HybridSearchMeta.adaptive_return` and surfaces in `--json` today. The per-result `explain-formatter.ts` is result-scoped and can't render a per-query meta line; the human `gbrain search --explain` header needs the meta threaded through `cli.ts:formatResult` (it currently only receives `results`). Add a one-line gate-decision header (intent / cap / kept of total). Priority: P3.
- [ ] **v0.42+: structured-alias / facts-mode fidelity for the PrecisionMemBench eval.** The gbrain-evals benchmark seeds beliefs as pages with aliases in the body (real FTS). A second fidelity that exercises gbrain's structured alias/entity-resolution layer (facts with `valid_until` + entity resolution) would measure gbrain's structured-belief path on the 23 alias cases. Lives in gbrain-evals (`eval/precisionmembench/seed.ts` throws on `fidelity:'structured'` today). Priority: P3.

## v0.41.32.0 content-relative staleness follow-ups (v0.42+)

Filed from the v0.41.32.0 wave (supersedes #1623 — commit-relative sync
staleness). The wave fixes the LOCAL doctor/sources false-SEVERE and the
REMOTE surfaces via a durable `sources.newest_content_at` column. Two gaps
were deliberately scoped out (CM2 + the remote post-sync-divergence residual).

- [ ] **v0.42+: lightweight local content-probe phase to keep `newest_content_at` fresh between syncs.**
  - **What:** an autopilot/cron phase that, for each git-backed source, runs the
    cheap `git log -1 --format=%ct` (HEAD committer time) and refreshes
    `sources.newest_content_at` even when there's nothing to sync.
  - **Why:** the REMOTE staleness path (`doctorReportRemote`'s `checkSyncFreshness`,
    `federation_health`, the `get_status_snapshot` MCP op) reads the column and
    cannot shell out to git (v0.41.27.0 trust boundary). The column is written at
    sync time, so a commit landed AFTER the last sync is invisible to the remote
    path until the next sync rewrites it — a narrow false-negative window. The
    authoritative LOCAL cron doctor catches those (it probes live git), so this is
    a remote-only freshness improvement, not a correctness hole.
  - **Pros:** shrinks the remote false-negative window to the probe cadence;
    keeps the trust boundary intact (probe runs on the trusted host, not from a
    remote caller).
  - **Cons:** a new background phase + its own tests + a cadence knob; only
    matters for operators who rely on `gbrain remote doctor` instead of the local
    cron doctor.
  - **Context:** the helper already exists — `newestCommitMs(localPath)` in
    `src/core/source-health.ts`. The phase just calls it per source and UPDATEs
    the column. See the v0.41.32.0 plan at
    `~/.claude/plans/system-instruction-you-are-working-vivid-gizmo.md`.
  - **Also note:** `checkCycleFreshness` was deliberately left on wall-clock in
    v0.41.32.0 (CM2 — it compares `last_full_cycle_at` via `listAllSources`, a
    different axis from sync staleness). Content-relativizing it (a source whose
    newest commit predates its last full cycle doesn't need re-cycling) is a
    natural companion to this probe phase. Priority: P3.

## brainstorm/lsd --save source-awareness (v0.42+)

Filed from the `--save` dual-sink hardening wave (route through the canonical
ingestion path: `importFromContent({noEmbed:true})` + the shared
`writePageThrough` helper extracted from `put_page`).

- [ ] **v0.42+: make `gbrain brainstorm/lsd --save` source-aware.** Today the save path always writes to `source='default'` — `persistSavedIdea` (`src/commands/brainstorm.ts`) hardcodes `sourceId ?? 'default'`, and there is no `--save`-side `--source` flag. Both sinks stay consistent at default (no live bug), but on a multi-source brain a generated idea can't be filed to a non-default source. **What:** add a `--source <id>` option to brainstorm/lsd, resolve it via `resolveSourceWithTier`, and thread `sourceId` into `persistSavedIdea` → `importFromContent({sourceId})` + `writePageThrough({sourceId})`. **Why:** complete the multi-source story for generated ideas; the disk layout already handles it. **Context:** `writePageThrough` and `resolvePageFilePath` already take `sourceId` and emit `.sources/<id>/<slug>.md` for non-default sources, and `importFromContent` already accepts `sourceId` — so the only missing piece is the CLI flag + threading. `runBrainstorm` (orchestrator) already accepts `sourceId` for the close/far READ side. **Depends on:** nothing; purely additive. Priority: P3 (default-source is the common case).

## v0.41.29.0 orphan source-scoping follow-ups (v0.42+)

Filed from the v0.41.29.0 wave (bold-name-no-time pattern + orphan_ratio
source scoping). The Codex outside-voice review (F8) flagged two surfaces
the wave deliberately scoped out.

- [ ] **v0.42+: thin-client `gbrain doctor --source` orphan_ratio scoping.** v0.41.29.0 scopes `orphan_ratio` to `--source` on the LOCAL doctor path (`buildChecks` in `src/commands/doctor.ts`) and closes the `find_orphans` MCP read leak via `sourceScopeOpts(ctx)`. The thin-client / remote doctor path (`src/core/doctor-remote.ts` `runRemoteDoctor`) is a separate code path that does not thread `--source`, so `gbrain doctor --source x` against a remote `gbrain serve --http` brain still reports brain-wide orphan_ratio. Thread the explicit `--source` into the remote doctor request + have the server-side check honor it. Priority: P3 (most users run doctor locally).

- [ ] **v0.42+: widen `check-test-real-names.sh` BANNED_NAMES to catch real-name reintroduction in tests + src.** v0.41.29.0 scrubbed pre-existing real names (`Garry Tan`, `Alex Graveley`) from `bold-paren-time`'s `test_positive` (and the new `bold-name-no-time` samples), but no automated guard caught them: `check-test-real-names.sh` only scans `test/**` and its BANNED_NAMES list doesn't include `garry tan`; `check-fixture-privacy.sh` only scans `test/fixtures/conversation-formats/`. Add `garry tan` / `garrytan` (and consider extending the scan to `src/core/conversation-parser/builtins.ts` test samples) so future reintroductions fail CI. Priority: P3 (hardening).

## v0.41.28.0 #1570 instrument-then-fix follow-ups (v0.41.28+ / v0.42+)

Filed from the v0.41.28.0 plan-eng-review after the codex outside-voice
review caught that the original architectural-refactor plan was designed
for a root cause we hadn't identified. v0.41.28.0 ships the tactical
symptom fix (retry reconnect) + facts queue drain + diagnostic
instrumentation. These follow-ups depend on the production data the
instrumentation collects.

- [ ] **v0.41.28+: Investigate disconnect-call audit data from production; fix the offending ownership boundary.** v0.41.28.0 ships `src/core/audit/db-disconnect-audit.ts` which records every `db.disconnect()` and `PostgresEngine.disconnect()` call with engine kind, connection style, caller stack, command, and pid. Doctor's `batch_retry_health` check surfaces the 24h count + most-recent caller. After the next user-reported `gbrain dream` cycle with reconnect events, read `~/.gbrain/audit/db-disconnect-YYYY-Www.jsonl` (or the doctor JSON output) and identify the specific code path firing the mid-process disconnect. The fix is then a targeted patch to that ownership boundary (per codex outside-voice finding 4 — "audit/log current callers in dream/facts paths, then change only the offending ownership boundary"). Priority: P1 once data exists; tracked by user feedback on #1570 thread.

- [ ] **v0.42+: Re-evaluate module-singleton removal IF the targeted v0.41.26 fix doesn't close the bug class.** The original v0.41.25 plan proposed removing nullability of `let sql: ReturnType<typeof postgres> | null = null` in `src/core/db.ts:7` and renaming `disconnect → shutdown`. Codex outside-voice review found 15 substantive problems (logical contradiction, wrong cleanup primitive, ~120-site scale estimate fantasy, BrainEngine contract asymmetry, etc.). If the targeted v0.41.26 fix closes #1570 cleanly, this refactor is genuinely unnecessary and can be closed. If new disconnect-class bugs surface in v0.41.28+, this is the design-conversation TODO that re-opens. Architecture conversation point: node-postgres explicitly deprecated the singleton pattern gbrain has — pull this in only when there's evidence we keep paying for it. Priority: P3 (speculative). Plan + findings preserved at `~/.claude/plans/system-instruction-you-are-working-cuddly-panda.md`.

## v0.41.26.1 lock-renewal cathedral follow-ups (v0.42+)

- **TODO-LR-1 (P2): PR #1567 surrogate-pair fix for synthesize.ts.**
  PR #1567 bundled a `safeSliceEnd` UTF-16 surrogate-pair handler
  alongside the lock-renewal try/catch. The lock-renewal change shipped
  in v0.41.26.1; the surrogate fix was deferred because it's a
  different bug class with its own test surface.
  - **What:** lift `safeSliceEnd` into a shared
    `src/core/string-safe-slice.ts`, apply to `judgeSignificance` AND
    `findBoundary` in `src/core/cycle/synthesize.ts`, add round-trip
    tests with surrogate-bearing transcripts. Pre-existing TODO at
    TODOS.md (search `Multibyte sanitizer test`) covers part of this
    — extend that entry.
  - **Why:** transcripts containing emoji + 4-byte CJK chars get
    cut mid-pair under the current `.slice(0, N)`, breaking JSON
    parse downstream and dropping rows.
  - **Source:** community PR #1567, contributor `@garrytan-agents`.

- **TODO-LR-2 (P2): doctor check `lock_renewal_health`.**
  v0.41.26.1 ships the audit JSONL primitive without a doctor read
  surface. For now, `tail -F ~/.gbrain/audit/lock-renewal-*.jsonl` is
  the operator UX.
  - **What:** add `checkLockRenewalHealth` in `src/commands/doctor.ts`
    mirroring `checkBatchRetryHealth` shape. Reads
    `readRecentLockRenewalEvents(24)`. Warns at >=5 `gave_up` events
    or >=20 `failure` events in the last 24h. Wired into both
    `runDoctor` (local) and `doctorReportRemote` (thin-client).
  - **Why:** operators on production Supabase want a single `gbrain
    doctor` line to know whether their pool is flapping.
  - **Pros:** structurally matches the v0.41.18 batch-retry health
    check. ~50 LOC.

- **TODO-LR-3 (P3): wire `pruneOldLockRenewalAuditFiles(30)` into
  `gbrain dream --phase purge`.**
  - **What:** one-line addition at the existing purge handler where
    `pruneOldBatchRetryAuditFiles` is called today.
  - **Why:** consistency with the batch-retry audit (which prunes).
    Without pruning, lock-renewal audit files accumulate one per
    ISO-week — negligible at first but worth doing the right way.

- **TODO-LR-4 (P2, codex C13): stall-detector re-entrancy guard at
  worker.ts:269.**
  The stall-detector `setInterval(async ...)` block has try/catch on
  every await so it doesn't crash. But it lacks a re-entrancy guard,
  so during a PgBouncer outage, 3 concurrent stall-detector loops can
  pile 9 pending connection acquisitions per tick on an
  already-saturated pool — amplifying the very stall they're trying
  to detect.
  - **What:** apply the same `tickInFlight` boolean guard pattern
    the lock-renewal fix uses. Convert `setInterval(async () => {...})`
    → `setInterval(() => { if (tickInFlight) return; tickInFlight =
    true; void (async () => {...})().finally(() => { tickInFlight =
    false; }); })`.
  - **Why:** same bug class as the v0.41.22.1 lock-renewal crash, but
    a different symptom. Doesn't crash, does amplify load.
  - **Source:** codex outside-voice review of v0.41.26.1 plan.

- **TODO-LR-5 (P3): bare-quoted hostname + username redactor patterns.**
  The v0.41.26.1 `redactConnectionInfo` catches bare `host=`,
  `user=`, `password=`, `pg_url`, `ipv4` patterns but NOT
  bare-quoted hostnames (`connection to server at "db.example.com"`)
  or bare-quoted usernames (`for user "postgres.abcdef123456"`). The
  IP in those PG error shapes is the highest-value leak (publicly
  resolvable), and that one IS caught.
  - **What:** extend the pattern set with optional quoted-string
    matchers, OR add a context-aware matcher that looks for `at
    "...".? (?:port|.)` shapes.
  - **Cons:** quoted-string false positives are common (DB names,
    role names); needs careful pattern design.

## v0.41.20.x dream-source-ingest-titles follow-ups (v0.42+)

- **TODO-V13-A (P2): `gbrain dream --max-pages <n>` plumbing.**
  PR #1559 included a `--max-pages` flag for cost-bounded cycles on
  large brains. v0.41.20 dropped it because `CycleOpts` has no `maxPages`
  field and no cycle phase consults page-count limits — shipping the flag
  would have been a lying flag.
  - **What:** extend `CycleOpts` with `maxPages: number | undefined` and
    thread it through extract phases (extract.ts, extract-facts.ts,
    recompute-emotional-weight.ts) so per-source cost-bounded cycles
    become real.
  - **Why:** straylight-brain-class corpora (100K+ pages) benefit from
    capping each cycle's work. Today operators have to wait full
    extract sweeps regardless of cost.
  - **Pros:** closes the lying-flag class; real cost brake.
  - **Cons:** real refactor — extract phases iterate all pages today,
    not page-count-bounded.
  - **Context:** PR #1559 commit 67f98ca had the flag; the v0.41.20
    plan dropped it under "Out of scope" with this TODO as the
    forwarding pointer.
  - **Depends on:** CycleOpts type extension + extract page-iteration
    refactor + decision on per-phase vs per-cycle cap semantics.

- **TODO-V13-B (P3): `--source` / `--source-id` flag-name unification.**
  Current drift: `dream`, `recall`, `sync` accept `--source`;
  `import`, `extract`, `graph-query`, `sources` accept `--source-id`.
  v0.41.20 added `--source-id` as an alias for dream's `--source` so
  both work, but the codebase still ships two surface names.
  - **What:** pick one canonical flag name across all CLI commands;
    deprecate the other with a stderr warning; update doctor.ts
    hint to match.
  - **Why:** ergonomic consistency. Users who learned `--source-id`
    via import shouldn't trip on `--source` in dream.
  - **Pros:** ends a real user-facing confusion.
  - **Cons:** low-priority polish; both names work today via alias.
  - **Context:** doctor.ts historically pinned `--source`; v0.37.7.0
    #1167 standardized `--source-id` across new commands. Recommend
    picking `--source-id` for v0.37.7.0+ consistency and deprecating
    `--source` over one minor.
  - **Depends on:** nothing technical.

- **TODO-V13-C (P2): `gbrain pages audit-junk-titles` legacy cleanup.**
  v0.41.20 widened the `error_page_title` matcher to catch Cloudflare /
  WAF challenge titles ("Forbidden", "Access Denied", "Service
  Unavailable", "Robot Check", "Just a moment...") at ingest. But the
  200+ scraper pages already in production DBs (202+ from
  straylight-brain) are NOT cleaned up by the matcher widening.
  Dropped from v0.41.20 per codex outside-voice tension (T1) for
  ship-and-validate-matchers-first discipline.
  - **What:** new operator command for soft-deleting pre-existing
    scraper-junk pages whose titles match the expanded
    `BUILT_IN_JUNK_PATTERNS`. Full spec preserved:
    - Signature: `gbrain pages audit-junk-titles [--source <id>]
      [--dry-run|--apply] [--confirm-destructive] [--json]`
    - Default `--dry-run`. Prints `{pattern_name: count, sample_slugs}`.
    - `--apply` requires `--confirm-destructive` when match count
      exceeds `DESTRUCTIVE_THRESHOLD` (reuse v0.26.5 constant).
    - `--source <id>` scopes; without it, audits all non-archived
      sources (filter via `listAllSources().filter(s => !s.archived)`).
    - Soft-delete via existing `engine.softDeletePage(slug, sourceId)`.
    - Audit JSONL via `logContentSanityEvent` with event kind
      `junk_title_soft_deleted`.
    - Idempotent.
    - **Hybrid SQL+JS scanner**: pure
      `buildJunkTitleSqlClause(patterns)` +
      `scanForJunkTitles(rows, patterns)`. SQL pre-filter avoids
      streaming all rows over the wire (perf rationale: even seq-scan
      ILIKE beats JS regex per-row via the postgres driver).
    - **`cleanup_safe: boolean` flag** per JunkPattern (codex C-13):
      only patterns flagged `cleanup_safe: true` are eligible for
      destructive cleanup. Stops future matcher widening from
      automatically expanding destructive scope. Initial allowlist:
      `cloudflare_attention_required`, `cloudflare_just_a_moment`,
      `cloudflare_ray_id`, `access_denied`, `captcha_required`,
      `error_page_title` (only the literal-numeric parts; the new
      word-titles get `cleanup_safe: false` until the matcher proves
      itself further), `cloudflare_challenge_title`.
    - New doctor check `scraper_junk_pages_legacy` (separate from
      `content_sanity_audit_recent` per codex C-5 — audit-log reader
      vs live DB scan are different concerns).
    - Tests: `test/pages-audit-junk-titles.test.ts` (hermetic PGLite),
      `test/doctor.test.ts` extension.
  - **Why:** ingest gate alone leaves 200+ existing junk pages
    inflating page counts; this command closes the data-debt gap.
  - **Pros:** finishes the cleanup story.
  - **Cons:** destructive surface (soft-delete + audit JSONL).
  - **Depends on:** ~1 week of production observation against
    v0.41.20's new ingest matchers. If real-world reports surface
    false-positive blocks, refine the matcher AND the `cleanup_safe`
    allowlist before shipping the destructive command.

## v0.41.22.1 brainstorm judge fix-wave follow-ups (v0.42+)

Filed from the v0.41.22.1 plan-eng-review per cross-model-tension D13c.
Step 0 of that plan explicitly deferred a "full pricing-system DRY"
cleanup (Option C) to keep the brainstorm fix blast radius small.
These three items are what was deferred. None are user-reported bugs;
all are latent-debt cleanup.

- [ ] **Config-write normalization.** Whenever a user writes `gbrain config set models.tier.deep anthropic/claude-opus-4-7` we silently store the slash form. v0.41.22.1 centralized the read-side via `splitProviderModelId`, but config writes still preserve whatever shape the user typed. Canonical form should be colon (`anthropic:claude-opus-4-7`). Fix: rewrite at config-write time in `src/core/config.ts`. Breaks existing config files that explicitly hold the slash form — defer to a v0.42+ config-migration wave that also handles the rewrite + once-per-process deprecation warn. Files: `src/core/config.ts`, `src/core/model-config.ts:saveConfig` path. Priority: P3 (latent, not user-visible).

- [ ] **Non-Anthropic pricing tables.** `src/core/anthropic-pricing.ts` is the only pricing surface gbrain ships. Brainstorm + LSD users routing through OpenAI / Gemini / OpenRouter get `BUDGET_TRACKER_NO_PRICING` warn-once + bypass-gate (without `--max-cost`) OR `no_pricing` hard-fail (with `--max-cost`). The right shape: rename to `provider-pricing.ts`, add OpenAI / Gemini / OpenRouter tables, route `lookupPricing` through provider-routed table selection. OpenRouter is a special case (period-vs-dash key mismatch: their `claude-sonnet-4.6` won't match our `claude-sonnet-4-6` either way). Files: `src/core/anthropic-pricing.ts` (rename + extend), `src/core/budget/budget-tracker.ts`, `src/core/eval-contradictions/cost-tracker.ts`. Priority: P2 (real user pain when running brainstorm against non-Anthropic).

- [ ] **Eval-contradictions duplicate ANTHROPIC_PRICING consolidation.** `src/core/eval-contradictions/cost-tracker.ts:28-38` ships its OWN copy of the Anthropic pricing table with different keys (both bare and `anthropic:`-prefixed forms) and a silent-Haiku fallback on unknown. v0.41.22.1 routed both tables' lookups through `splitProviderModelId` but left the duplication. Right fix: delete the local table, import from `src/core/anthropic-pricing.ts`. Either (a) preserve the silent-Haiku-fallback semantic with an explicit `?? canonicalPricing['claude-haiku-4-5']` at the call site, or (b) tighten to warn-once on unknown (which changes the eval-contradictions soft-ceiling `--budget-usd` contract — coordinate with that subsystem). Files: `src/core/eval-contradictions/cost-tracker.ts`, `src/core/anthropic-pricing.ts`, `test/eval-contradictions/cost-tracker-slash.test.ts` (the legacy-Haiku-fallback pin would need updating). Priority: P3 (DRY cleanup, no user-visible impact).

## v0.41.21.0 ops-fix-wave follow-ups (v0.41.22+)

- **TODO-OPS-1 (P2)**: `gbrain sync print-cron` subcommand. Print the canonical
  cron line based on the active source set: `gbrain sync --all --parallel N
  --workers N --skip-failed` where N defaults to `min(sourceCount, 4)`. Reads
  `sources` table for active (non-archived, `local_path IS NOT NULL`) entries.
  Ergonomic upgrade over the v0.41.19.0 `sync_consolidation` doctor message —
  operator pipes directly into `crontab -e` instead of copy-paste-massage.
  ~80 LOC. Mirrors `gbrain sync --break-lock` argv shape.

- **TODO-OPS-2 (P2)**: Lock-loss detection — extend `DbLockHandle.refresh()`
  to throw `LockLostError` on 0 rows affected. Codex caught during the
  v0.41.19.0 plan review: `refresh()` runs `UPDATE ... WHERE holder_pid = pid`
  with no rows-affected check (`db-lock.ts:108-114`, `:151-156`). If the
  TTL expired and another worker took over, the original keeps writing
  silently. v0.41.19.0 ships TTL=5min + active in-phase refresh via
  `buildYieldDuringPhase` which makes the race window much narrower, but
  an `await chat()` call that exceeds the 5min wallclock window can still
  hit it. Fix: `RETURNING id` on the UPDATE + check `rows.length === 0` →
  throw tagged `LockLostError`. Phases catch + abort cleanly (write partial
  progress, return `status: 'fail'` with reason `'lock_lost'`). Behavioral
  contract change with phase-abort fallout; needs its own design pass.

## v0.41.20.0 status + doctor-categories wave follow-ups (v0.42+)

- **TODO-V19-A (P3)**: Persistent `cycle_runs` table. v0.41.19.0 infers
  "last full cycle" by querying `minion_jobs WHERE name = 'autopilot-cycle'`
  for the most recent completed row. This works but conflates "cycle ran
  via the autopilot scheduler" with "cycle ran." A dedicated `cycle_runs`
  table written from `runCycle` directly would let `gbrain status`
  surface manual `gbrain dream` invocations + per-source partial cycles
  separately. Defer until the inference's accuracy limits actually bite
  someone.

- **TODO-V19-B (P2)**: Surface `extract_atoms` + `synthesize_concepts`
  counts in `CycleReport.totals` top-level. Today the counts live inside
  each phase's `details` field; the v0.41.19.0 `gbrain status` cycle
  section can't surface them without per-phase parsing. Bump the
  `CycleReport.totals` shape additively (the existing field is
  documented as additive) and add `atoms_inserted` +
  `concepts_inserted` next to `facts_consolidated`.

- **TODO-V19-C (P3)**: Check-registry refactor for `gbrain doctor`. The
  v0.41.19.0 `--scope=brain` uses explicit early-skip gates inline at
  each call site (~40 LOC across resolver + skill_conformance +
  skill_brain_first + whoknows). If we want to add more scope
  dimensions later (e.g. `--scope=ops`, `--exclude-skill`), the right
  next step is a check registry: each check declares
  `{name, category, run}`, `buildChecks` becomes "run all entries
  whose category is in scope." ~300 LOC, touches every check site.
  Considered + rejected for v0.41.19.0 as too large for a single fix
  wave (D9-B option in the plan).

- **TODO-V19-D (P3)**: Read installed launchd/cron/systemd schedule
  to compute a real "next autopilot tick" timestamp. v0.41.19.0
  status surfaces "Autopilot: running (PID N)" instead. Cross-OS
  scheduler probing is a separate, larger problem; macOS launchd
  plist parsing alone is ~80 LOC.

- **TODO-V19-E (P2)**: Apply category-aware exit codes to
  `gbrain doctor`. Today doctor exits 0 on all-ok, 1 on any fail.
  After categorization, a CI gate could opt into "fail only on
  brain-category failures" via `--scope=brain` (already shipping) or
  a `--fail-on=brain` flag. Filing this as a discoverability
  follow-up — the `--scope=brain` flag already covers most of the
  use case.

## v0.41.18.0 onboard wave follow-ups (v0.42.1+)

- **TODO-A (P2)**: Pack-aware `linkable: boolean` per-type field on schema-pack
  manifests. Both `gbrain extract links --by-mention` and `--ner` would consult
  it to gate which entity types participate in gazetteer construction. Currently
  uses a hardcoded `['person', 'company', 'organization', 'entity']` list.

- **TODO-B (P3)**: LLM-based entity disambiguation for `--ner`. v0.42.0 ships
  regex+gazetteer only; misses cases like "Anthropic's founders" → `Anthropic`
  link. A small Haiku post-pass would catch these.

- **TODO-C (P3)**: `gbrain onboard --explain <recommendation_id>` drill-down.
  Shows the underlying check, its measurement, and why the recommendation
  fired. Useful when an operator wants to understand what `onboard --auto` is
  about to do.

- **TODO-D (P2)**: Live-brain impact measurement against a representative brain
  (165K-page production class). v0.42.0 ships the `migration_impact_log`
  infrastructure; we need real-world numbers to update the design doc claims
  with measured deltas.

- **TODO-E (P1)**: 100+-case eval suite for takes-bootstrap classifier. v0.42.0
  ships the classifier + the 20-case eval scaffold per A24. Autopilot tier for
  takes-bootstrap STAYS `manual_only` until this lands. Required before any
  autopilot run of takes extraction.

- **TODO-F (P3)**: Web UI surface for `gbrain onboard` recommendations in the
  admin SPA. Linear-style dashboard with one-click apply.

- **TODO-G (P2)**: Full DATABASE_URL-gated E2E for onboard. v0.42.0 ships
  hermetic PGLite contracts coverage in `test/e2e/onboard-full-flow.test.ts`;
  the real-Postgres version needs the Minion worker test harness to land its
  per-handler stub seam so individual extraction handlers can be replaced for
  testing.

- **TODO-H (P2)**: `minion_jobs.client_id` schema column. v0.42.0 stores the
  originating OAuth client_id on `job.data.client_id` (JSONB passthrough).
  A real schema column + index would let the spend query path (per-client
  daily cap enforcement) avoid the JSONB projection cost.

- **TODO-I (P3)**: Thin-client (doctor-remote.ts) parity for the 4 new onboard
  checks (embed_staleness, entity_link_coverage, timeline_coverage,
  takes_count). Today the MCP run_onboard op runs these server-side via
  runAllOnboardChecks; doctor-remote.ts would surface them on the thin-client
  dashboard for operators who only hit the brain via MCP.

## v0.41.17.0 `--workers N` cathedral follow-ups (v0.41.18+)

These were filed during the ship of `garrytan/dar-es-salaam-v1`
(PR #1473 productionization). The wave landed seven `--workers N`
surfaces + the shared worker-pool helper + facts dim doctor parity.
The follow-ups below are scope deliberately deferred from v0.41.17.0
per /plan-eng-review D-decisions.

- [ ] **v0.41.18+: dream execution-concurrency knob via queue-layer
  recoupling** (D21). Today the only knob that controls how many dream
  subagents run concurrently is `gbrain jobs work --concurrency N` —
  a process-wide setting, not per-invocation. A user running
  `gbrain dream` who wants 5 concurrent synthesize subagents has no
  way to express that without changing the queue daemon's global cap.
  v0.41.17.0 dropped `dream --workers` from scope (D14) because the
  obvious naming would only bound submit rate, not actual execution.
  The proper fix is a queue-side primitive ("temporarily clamp
  concurrency to N for jobs tagged with X") and a new
  `gbrain dream --execution-concurrency N` flag that uses it.
  Multi-wave design; touches `MinionQueue.claim` semantics. File when
  someone asks.
- [ ] **v0.41.18+: auto-tune `--workers` from observed rate-limit
  headers** (D19). Instead of operator picking `--workers N` manually,
  the worker pool observes 429s / Retry-After in gateway responses and
  AIMD-style auto-tunes to stay just under the provider's actual cap.
  Removes operator-tuning burden; matches industry standard adaptive
  concurrency control. Needs new instrumentation in
  `src/core/ai/gateway.ts` to surface rate-limit-header signal, plus
  a shared 'observed concurrency cap' state across worker-pool callers.
  The RFC (PR #1473) explicitly punted this with "start manual,
  observe before auto-pick" — file when we have multiple weeks of
  real-world `--workers` usage data to inform the auto-tune curve.
- [ ] **v0.41.18+: per-tracker mutex on `BudgetTracker.reserve()`** (D20).
  v0.41.17.0 D3 chose to document the worst-case overshoot
  (`N_workers × avg_per_call_cost` over the cap) rather than mutex
  `reserve()` because the overshoot is single-digit dollars at any
  realistic `--max-cost-usd`. The structural fix is a per-instance
  async-mutex around `reserve()` so the check-and-reserve becomes
  atomic across concurrent callers. Cost: ~1ms per claim on a primitive
  used by 5+ call sites including the hot embed path. File when
  someone reports overshoot or wants exact-ceiling compliance for
  paid-API tracking.
- [ ] **v0.41.18+: `extractLinksForSlugs` + `extractTimelineForSlugs`
  sync-integration hooks get `--workers N` parity.** T7 wired
  `--workers` into the CLI-facing `extract` paths (extractForSlugs,
  extractLinksFromDir, extractTimelineFromDir) but left the two
  sync-integration hooks in extract.ts:883/914 serial. Those are
  called from sync.ts post-sync and would benefit from the same
  fan-out shape. Mechanical change; mirror the runSlidingPool
  conversion from T7.
- [ ] **v0.41.18+: extract DB-source loops (`extractLinksFromDB`,
  `extractTimelineFromDB`, `extractMentionsFromDb`) get `--workers N`.**
  T7 explicitly scoped the workers wiring to fs-walk inner loops; the
  DB-source paths use the engine's own pagination and stay serial.
  Wire when an operator hits perf issues running `gbrain extract
  --source db` on a large brain.
- [ ] **v0.41.18+: deeper `resolveSymbolEdgesIncremental` intra-source
  parallelism.** T8 wired `--workers N` for the cross-source loop
  under `--all-sources` only. The inner per-batch loop inside
  `resolveSymbolEdgesIncremental` (200 chunks per batch, sequential)
  is the larger throughput lever and stays serial in v0.41.17.0.
  Touches the symbol-resolver core; defer until the next chunker
  refactor wave.
- [ ] **v0.41.18+: re-compose progressive-batch + workers on the 3 reindex
  sites.** v0.41.17.0 merged master's v0.41.16.0 progressive-batch retrofit
  for `reindex.ts`, `reindex-multimodal.ts`, `reindex-code.ts` AGAINST this
  wave's `--workers N` retrofit on the same files. The merge took ours
  (workers) because `--workers` is the load-bearing user-facing feature in
  this wave; master's progressive-batch primitive at
  `src/core/progressive-batch/` still ships unchanged. The two layers are
  orthogonal at the semantic level: each ramp stage could call
  `runSlidingPool` to fan its items across N workers. v0.41.18+ wave: wrap
  the workers fan-out inside the progressive-batch outer ramp on each of
  the 3 reindex sites. Test parity: ramp + workers together produces the
  same final state as either alone on a fresh corpus. Reference: master's
  PR #1510 commit on the same files for the progressive-batch primitive
  call site; this wave's PR #1519 for the workers call site.
- [ ] **v0.41.18+: `reindex-frontmatter` worker pool actually parallelizes
  the underlying `backfillEffectiveDate` library.** T12 added the
  `--workers N` flag for API consistency but the underlying library
  doesn't honor it (work is pure CPU date-precedence resolution, no
  I/O per row). Speedup would be marginal anyway. File only if a real
  operator complaint surfaces; otherwise leave as informational.
- [ ] **v0.42+: reactive auto-ALTER on facts dim drift** (D18 — was
  explicitly skipped). v0.41.17.0 ships doctor warn + extraction
  preflight (D15) with a paste-ready DROP INDEX + ALTER USING +
  CREATE INDEX recipe. The structural fix is auto-running the recipe
  on connect when drift is detected. ALTER on a 100M+ row facts table
  is hours-long and locks the table; doing it silently would horror-
  show production brains. v0.42+ design needs a confirmation prompt +
  maintenance-window UX. Don't file as P0 — doctor + preflight is
  enough for most users.

## v0.41.16.0 conversation parser + progressive-batch follow-ups (v0.41.14.0+)

The v0.41.16.0 cathedral shipped the parser primitive + progressive-batch
primitive + ONE proven consumer (extract-conversation-facts). Per D2 (codex
outside voice acknowledged + user accepted the trade), the wider 9-site
retrofit + 5 architectural follow-ups land as structured waves to keep each
PR bisectable.

- [ ] **v0.41.14.0: 9-site progressive-batch retrofit (one commit per site
  for bisect).** The primitive at `src/core/progressive-batch/` shipped
  with ONE consumer (extract-conversation-facts). Twelve other batch
  sites still reinvent their own ramp+cost-prompt patterns; rule of
  three is comfortably past. Retrofit each onto the primitive in
  sequence, one commit per site for bisect, behavior parity tested
  before/after migration:
  - `src/commands/reindex.ts` (markdown chunker bump) — existing 10s
    Ctrl-C grace + `GBRAIN_NO_REEMBED=1` env map to
    `interactiveAbortMs` + `GBRAIN_PROGRESSIVE_BATCH_DISABLED`.
  - `src/commands/reindex-multimodal.ts` (Phase 3 unified column) —
    360min lock survives orthogonal; cost prompt becomes stage report.
  - `src/commands/reindex-code.ts` — sites without existing ramps
    keep jump-to-full default per D21; ramp is opt-in.
  - `src/core/post-upgrade-reembed.ts` — TTY auto-proceed maps directly
    to `GBRAIN_PROGRESSIVE_BATCH_AUTO`.
  - `src/commands/book-mirror.ts` — cost-estimate becomes stage 0.
  - `src/core/brainstorm/orchestrator.ts` — already wraps in
    `withBudgetTracker`; primitive accepts the active tracker.
  - `src/commands/eval-suspected-contradictions.ts` — sampling probe
    becomes stage 0; full run becomes stages 1-4.
  - `src/core/eval-contradictions/cost-prompt.ts` — DELETE entirely;
    callers route through the primitive's Policy.maxCostUsd.
  - `src/core/minions/handlers/contextual-reindex-per-chunk.ts` —
    `GBRAIN_PROGRESSIVE_BATCH_AUTO` defaults true for workers.
  Priority: P2. Rationale: future batch features inherit the discipline
  for free; the 12 existing sites stay bespoke until done.

- [ ] **v0.42+: per-source pattern overrides.** New config key
  `cycle.conversation_facts_backfill.source_overrides.<id>.patterns`
  (JSON array of `simple_pattern` specs). Pros: brain with both
  Telegram AND Discord sources can declare per-source pattern priority.
  Cons: another config key to validate; per-source pattern indexing
  needs runtime per-page lookup. Context: v1 keeps patterns
  brain-global to ship faster. Priority: P3.

- [ ] **v0.42+: Worker-based regex isolate-and-kill for arbitrary user
  patterns.** Compile user-supplied regex inside a Node Worker and kill
  the Worker on timeout. Why: Node has no native `RegExp.abort`; v0.41.13
  Promise.race-based ReDoS sniff is fake (the regex engine can't be
  preempted once running). v0.41.13 ships NO arbitrary user regex
  surface to avoid the security theater; user patterns wait for this.
  Alternative: safe-regex npm (synchronous static analysis, catches
  the canonical /^(a+)+$/ class). Cons: per-pattern Worker startup
  cost; complexity. Context: today's `simple_pattern` structured spec
  (also v0.42+) compiles to known-safe regex shapes without the
  worker dance. Priority: P3.

- [ ] **v0.42+: per-pattern speaker-alias normalization.** LongMemEval-
  style per-page alias map collapsing `"Alice"` + `"Alice Smith"` +
  `"alice"` to one canonical slug. See `src/eval/longmemeval/extract.ts`
  `AliasMap` shape. Pros: cleaner downstream fact extraction. Cons:
  state per-page (currently stateless orchestrator). Context: today
  downstream `resolveEntitySlug` handles this via the entities table
  (good enough but cleaner upstream). Priority: P3.

- [ ] **v0.42+: cross-modal scoring of LLM-fallback output.** Feed
  fallback-parsed messages to a judge model and score correctness.
  Why: catches hallucinated parses (LLM "inventing" speakers/timestamps
  on adversarial input). Pros: closes a quality gap. Cons: cost;
  needs budget policy + judge model selection. Context: v0.41.16.0
  catches hallucination only via the adversarial fixture set in the
  nightly probe (5 fixtures). Real adversarial drift = more
  fixtures + judge scoring. Priority: P2.

- [ ] **v0.42+: mega-regex compilation fallback.** Combine 12+ built-ins
  into one alternation regex if D11 quick_reject benchmarks disappoint.
  Pros: faster on dense conversations (single pass per line). Cons:
  debugging which alternative matched is nightmarish; one bad anchor
  corrupts all. Context: D11 quick_reject is expected to deliver ~10×
  speedup; revisit only if real corpus measurements show >5ms parse
  time per page. Priority: P3.

- [ ] **v0.42+: real-corpus-redacted fixture set.** Add
  `test/fixtures/conversation-formats/real-corpus-redacted/` derived
  from 5-10 real production Telegram pages with: real names →
  placeholder names (alice-example, charlie-example, fund-a) via a
  one-shot scrubber script, real timestamps preserved, real message
  bodies preserved STRUCTURALLY (length + line-break shape) but
  content replaced with lorem-ipsum-style synthetic prose. Privacy
  guard extended. Why: synthetic 8-12 message fixtures prove regex
  syntax, not production recovery of 134 real Telegram-shaped pages.
  Real edge cases (long pastes, code blocks, replies, day-separators)
  only surface in real corpora. Adds ~30min scrub step + privacy
  guard maintenance. Priority: P2.

## v0.41.15.0 sync-reliability follow-ups (v0.42+)

- [ ] **v0.42+: subprocess fan-out for `sync --all` (`--independent` mode
  revisit).** v0.41.15.0 deliberately rejected `--independent` (Minion
  job-queue fan-out) in plan review and shipped the shell-level
  `timeout(1)` per-source loop instead — that gives real OS process
  isolation with zero new gbrain code. Revisit if shell `timeout` proves
  insufficient for any operator workflow (e.g. someone wants structured
  per-source JSON output that `jq | xargs` can't easily produce). If we
  revisit, pivot to subprocess-per-source (gbrain CLI spawning gbrain
  CLI) rather than reuse the Minion handler, because codex's pass-2
  review caught that Minion is in-process worker pool — not OS-process-
  per-source — and `waitForCompletion` throws on timeout but doesn't
  cancel the underlying job (leaving a hot lock for the next cron).
  Priority: P3 (operator-comfort improvement; no correctness gap).

- [ ] **v0.42+: full-sync `--timeout` coverage via AbortSignal in
  `runImport`.** v0.41.15.0's `--timeout` covers the incremental sync
  path (pull + delete + rename + import). It does NOT cover full-sync
  triggers: first sync, `--full` flag, missing-anchor recovery,
  chunker-version rewalk. `performFullSync` delegates to `runImport` as
  one large operation that doesn't accept an AbortSignal today.
  Operators hitting full-sync today already need extended wall-clocks
  (the CHANGELOG documents the workaround); a v0.42+ wave would thread
  `AbortSignal` through `runImport` so every sync path has the timeout
  safety net. Touches 4-5 more files (`src/commands/import.ts`,
  `src/core/import-file.ts`, batch loops). Priority: P3 unless a user
  reports cron-killing full-sync triggers in production.

- [ ] **v0.42+: `runFactsBackstop(mode:'queue')` in-process microtask
  queue can keep the CLI alive briefly after sync returns.** Documented
  as a known caveat in the v0.41.15.0 CHANGELOG. The queue uses an
  in-process microtask drain (not Minions) to fire-and-forget LLM
  enrichment for synced pages. After `gbrain sync` returns, the CLI
  process may stay alive for a few seconds while queued work drains.
  Bounded by per-call timeouts inside the LLM client but operator-
  visible. A v0.42+ fix could either (a) route through Minions (more
  durable; needs job-queue dependency for plain sync), or (b) drop the
  in-process queue on sync exit. Priority: P3.
## v0.41.14.0 #1451 drift-fix follow-ups (v0.42+)

- [ ] **v0.42+: refactor `runRoutingEval` to take `ResolverEntry[]` directly** instead of `resolverContent: string`. Cleaner shape than synthesizing markdown then re-parsing it. Cascades through 9+ test files that depend on the string-content API. Defer until the next big refactor of the routing-eval module so the test-file churn lands with that wave.
- [ ] **v0.42+: replace regex-based `parseSkillFrontmatter` with a real YAML parser** (js-yaml is already a transitive dep via gray-matter). Codex finding #4 from /plan-eng-review: the regex in `src/core/skill-frontmatter.ts` assumes YAML semantics it can't enforce (e.g. multi-line scalars, escaped quotes). For our current uniform-shape skills (all use `- "quoted"` block form), it works. Swap when a skill ships a YAML construct the regex misparses, or proactively for defense-in-depth.
- [ ] **v0.42+: unify `parseSkillFrontmatter` (skill-frontmatter.ts) and MECE's `extractTriggers` (check-resolvable.ts:216)** into a single parser. Codex finding #5: two parsers, drift surface. Both extract `triggers:` arrays the same way today, so the drift is bounded — but every future change to one needs to be mirrored in the other. Consolidate when either needs to diverge.
- [ ] **v0.42+: `bun run ci:local` should run `bun run verify`** (codex finding #10 from /plan-eng-review). Today ci:local runs guards + typecheck + unit + E2E but NOT verify, so the new `check:resolver` gate (and others added to verify) don't fire in local pre-push. Bigger conversation about local vs CI scope — defer as a separate UX decision after measuring how often verify-only failures land in CI.
- [ ] **v0.42+: remove the deprecated `install/` skill directory entirely.** It has no SKILL.md (just a deprecation note pointing at setup/) and is correctly skipped by `loadSkillTriggerIndex`. Removing the directory cleans up the bundled skill tree. Orthogonal to #1451; small follow-up.
- [ ] **v0.42+: extend `entriesToResolverContent` to escape backticks in trigger strings.** Today only pipes are escaped, because no real bundled trigger contains a backtick. If a future skill ships a trigger like ``` `code` ``` the markdown-table row would mangle. Add a single regex replace if a real case appears.

## v0.41.10.1 fix-wave follow-ups (v0.42+)

- [ ] **v0.42+: per-atom idempotency via deterministic atom slug.** The
  v0.41.10.1 fix wave closed the duplicate-atoms bug class via source-hash
  existence check at the SOURCE level (skip the whole transcript/page if
  any atom row exists for `frontmatter.source_hash`). Known limitation
  surfaced by codex review (D9 #2): if the first Haiku call writes atom
  1 of 3 then atom 2 throws, the source_hash filter sees atom 1 exists
  and skips on next discovery — atoms 2 + 3 stay missing until
  `content_hash` changes. The cleaner solution is per-atom idempotency:
  switch atom slugs from date-stamped (`atoms/2026-05-25/<title-slug>`)
  to content-hash-stamped (`atoms/<source_hash16>/<sha8-of-title-body>`)
  so `engine.putPage` upserts naturally on retry. Bounded scope; needs
  a migration to consolidate existing duplicate atoms (filed separately
  below as the v0.42+ consolidation TODO). Priority: P2. References:
  `src/core/cycle/extract-atoms.ts:atomsExistForHash`, the documented
  known-limitation comment in the file header.

- [ ] **v0.42+: atom-slug consolidation migration.** The v0.41.10.1 fix
  wave stops NEW duplicates from being written but doesn't migrate
  existing duplicate atoms from prior v0.41.2.0 runs. Brains that ran
  the cycle across multiple days carry duplicate atoms forever (or until
  manual cleanup): `atoms/2026-05-15/title-X` AND `atoms/2026-05-25/title-X`
  for the same content_hash. Migration writes a one-shot CLI flow:
  `gbrain atoms consolidate [--dry-run] [--yes]` that groups atoms by
  `frontmatter.source_hash`, keeps the oldest atom row, soft-deletes
  newer copies (uses the existing `softDeletePage` path so 72h restore
  window applies). Operator opt-in via the same `--confirm-destructive`
  gate from the destructive-guard. Priority: P3. Filed via /plan-eng-review
  D6. References: `src/core/cycle/extract-atoms.ts`, the v0.26.5
  soft-delete + restore infrastructure.
## v0.41.10.0 follow-ups (orphan-reduction + surrogate fix wave)

- [ ] **TODO-1 (P2) — Pack-aware `--by-mention` gazetteer.** Add `linkable: boolean` per-type field to the schema-pack manifest (`src/core/schema-pack/manifest-v1.ts`, currently has `extractable` + `expert_routing`). New accessor `linkableTypesFromPack(pack: ResolvedPack)` in a new `schema-pack/linkable-types.ts` module mirroring `expert-types.ts`. `src/core/by-mention.ts:buildGazetteer` consults the pack-aware filter first via `loadActivePackBestEffort(ctx)`, falls back to the hardcoded `LINKABLE_ENTITY_TYPES` const for non-pack brains. Respects the D4 fail-empty contract (pack-load failure → empty filter, NOT hardcoded defaults). User-defined types like `researcher` get auto-linked. Requires: pack-schema bump, rubric/registry updates, regression test that pack-aware + non-pack brains produce expected gazetteer shapes.

- [ ] **TODO-2 (P2) — Cycle integration for `--by-mention`.** v0.41.10.0 ships CLI-only. Wire the mention pass into the dream-cycle extract phase so brains running autopilot get incremental auto-link without manual cron. Two paths: (a) refactor `runExtractCore` (currently FS-only at `extract.ts:320`) to support DB-source, then cycle calls it as before; (b) add a dedicated `extractMentionsFromDbForCycle()` callable directly from `runPhaseExtract` at `core/cycle.ts:810` so `runExtractCore` stays focused. Add `auto_link_mentions` config gate (default OFF for safety — opt-in). Also resolve the `sourceScopeOpts(ctx)` issue: cycle context doesn't have an `OperationContext`; need a new helper that produces equivalent scoping for the trusted-workspace cycle write context.

- [ ] **TODO-3 (P3) — MCP op `extract_links_by_mention` for remote brain-server callers.** v0.41.10.0 CLI-only because the API shape was new. Once the CLI is proven (post-ship measurement window), expose as MCP op with `scope: write`, NOT `localOnly` (remote OpenClaw agents should be able to trigger). Trust gate via `op-trust-gate.ts`. Params: optional `source_id`, optional `since`, `dry_run`. Returns `{created, pages}`. Add to `src/core/operations.ts` operation list; wire MCP definitions.

- [ ] **TODO-4 (P1) — Measure actual orphan-ratio reduction on representative brain post-merge.** v0.41.10.0 CHANGELOG softens the design-doc claim from "88% → <30%" to "material reduction, exact figure TBD" per codex CK13 (strict-exact + min-length≥4 + no-aliases + no-fuzzy will under-deliver on 3-char real entities like "YC", first-name mentions like "Bob", and abbreviations). After v0.41.10.0 lands, run `gbrain extract links --by-mention` against the production OpenClaw deployment (~165K pages) and capture before/after orphan_ratio from `gbrain doctor --json`. Update `docs/designs/GBRAIN_ONBOARD.md` (in PR #1409 if still open, or as follow-up edit if merged) with the measured number. Update CHANGELOG retroactively only if the measurement is material to user expectations.

## v0.41.6.0 follow-ups (v0.41.7+)

- [ ] **v0.41.7+: investigate v0.40+ schema-probe deadlock ROOT cause.**
  v0.41.6.0 D4 ships the symptom fix (retry+poll silently when the race
  resolves itself; warn with revised wording when truly stuck). Codex
  outside-voice F12 caught the load-bearing finding: `initSchema()`
  already takes `pg_advisory_lock(42)` so the SQLSTATE 40P01 race must
  involve OTHER locks. Hypothesis: DDL locks acquired by initSchema's
  ALTER / CREATE statements deadlock against application queries
  (long-running SELECTs on `pages`, PgBouncer pool artifacts). Reproduce
  on real PgBouncer setup with concurrent reads + simulated migration.
  Expected outcome: either connection-pool isolation fix or DDL-lock
  NOWAIT pattern. Effort: human ~4-6h / CC ~1h once repro is in hand.
  Depends on: nothing; v0.41.6.0 D4 already quiets the alarming warning
  for the common case, so this investigation is unblocked.

- [ ] **v0.41.7+: wire inline auto-embed errors at sync.ts:1173-1186
  through `recordSyncFailures`.** v0.41.6.0 D1 closes the headline
  missing-creds case (preflight short-circuits before any embed call).
  D2's classifier patterns cover rate-limit / quota / oversize errors
  for per-file embeds inside `runImport` (which already records
  failures correctly). But the inline post-import auto-embed catch at
  `src/commands/sync.ts:1173-1186` swallows errors to stderr only and
  never reaches `recordSyncFailures`. Wire it through with deduplication
  guard (some errors may also be recorded by per-file `runImport` —
  avoid double-recording). Effort: human ~1d / CC ~30min including
  dedup test surface.

- [ ] **v0.41.7+: true end-to-end cancellation in search via AbortSignal.**
  v0.41.6.0 D3 `withTimeout` bounds USER wait via Promise.race + process
  exit. The underlying DB / API socket keeps running until the kernel
  reaps the process or the server times out the abandoned query. For
  long-running subagent loops or rerank pipelines, threading AbortSignal
  end-to-end would save server-side resources. Touches `hybridSearch` +
  engine + `cosineReScore` + `reranker` signatures. Effort: human ~1d /
  CC ~3h. Tradeoff: large surface fan-out for marginal benefit on the
  CLI exit-on-timeout path. Only ship when a non-CLI consumer
  (HTTP MCP, future autopilot health checks) wants true cancellation.
## community-pr-wave follow-ups (filed during ship)

- [ ] **`FREE_LOCAL_*_PROVIDERS` zero-pricing bypassable via redirected
  BASE_URL env vars.** An operator who sets `LLAMA_SERVER_BASE_URL=https://paid-api.com/v1`
  routes `llama-server:foo` requests to a paid proxy, but the budget
  tracker still zero-prices them because the provider-prefix match in
  `FREE_LOCAL_EMBED_PROVIDERS` / `FREE_LOCAL_RERANK_PROVIDERS` doesn't
  see the resolved URL. The bypass is real but requires operator
  misconfiguration (paid-API behind a "local" recipe alias) — same
  trust posture as the rest of the BASE_URL env vars.

  Fix shape (couples with the unification TODO already filed for v0.41+):
  move the freeness decision from provider-prefix lookup to the gateway's
  embed/rerank call sites where the resolved URL is known, or detect
  non-loopback `provider_base_urls` and refuse zero-pricing in that case.

  Surfaced by codex Pass-9 adversarial review; pre-existing for the rerank
  case in v0.40.7.1, broadened to embed by v0.40.8.0. Tracked here so the
  unification PR closes both at once.

- [ ] **`probeEmbeddingReachability` should honor recipe `default_timeout_ms`
  for embed touchpoint.** The reranker probe was just fixed in PR #1326 to
  read `recipe.touchpoints.reranker.default_timeout_ms` so Qwen3-Reranker-4B
  has CPU cold-start headroom. The embedding probe hardcodes 5000ms
  (`src/commands/models.ts:467`) and the JSDoc admits "the 5s timeout may
  trip on the very first probe — re-run if so." A local llama-server embed
  endpoint hits the identical CPU cold-start curve.

  Fix: add optional `default_timeout_ms?: number` to `EmbeddingTouchpoint`
  in `src/core/ai/types.ts` (sibling to the rerank field), thread through
  `probeEmbeddingReachability` using the same `recipe.touchpoints.embedding.default_timeout_ms ?? 5000`
  pattern that the reranker probe uses. Add a regression test in
  `test/models-doctor-embed.test.ts` pinning the precedence chain.

  Surfaced by the community-PR-wave pre-landing review (informational, no
  blocker on the wave itself — workaround is "re-run the probe").
## v0.41.3 security/MCP fix wave follow-ups (filed during ship of `garrytan/security-mcp-fix-wave`)

Source: codex outside-voice review on the v0.41.3 wave (D7) identified
three real wins in PR #1316 (`chipoto69` — "Phase 4 multi-agent hardening")
that did NOT land in v0.41.3. PR #1316 was bundled with RLS posture
changes that conflict with v0.26.7's auto-RLS event trigger; the v0.41.3
plan unbundled #1316 deliberately so its RLS posture rewrite gets its own
architectural review. These three are the deferred standalone wins —
each can ship as its own wave without touching RLS.

- [ ] **T13a (P1) — Extract deny-by-default fine-grained scope wiring
  from #1316.** Today the OAuth scope string (e.g. `read write`) is
  validated at registration via `ALLOWED_SCOPES_LIST` but does NOT
  constrain which MCP operations a token can call at dispatch time.
  Every op currently runs if the bearer is valid. #1316 adds per-op
  `requiredScope` metadata and a dispatch-time gate that returns 403
  when the bearer's scope set doesn't satisfy the op's requirement.
  Real security win: a `read`-scoped token can't call `put_page` or
  `submit_job`. Requires per-op annotation review (which ops need
  `write` vs `admin`) + scope-grammar decision (is `read` a strict
  subset of `write`, or are they orthogonal categories?). NOT in
  v0.41.3 because the per-op review is its own design exercise.
  Cherry-pick starter: PR #1316 diff against `src/core/operations.ts`
  and `src/mcp/dispatch.ts`. Effort: human ~2 days / CC ~3 hours.

- [ ] **T13b (P2) — Extract real operation names in mcp_request_log
  from #1316.** Pre-fix audit log records generic `tools/call` for
  every MCP request. #1316 carries the real op name (`get_page`,
  `put_page`, `submit_job`, etc.) into the `operation` column.
  Standalone win — no architectural risk, no schema change (column
  already exists), just dispatch-time wiring. Candidate for next
  minor (v0.41.4 or v0.42.x). Cherry-pick starter: #1316 diff
  against `src/mcp/dispatch.ts` audit-log insertion site.
  Effort: human ~1h / CC ~10min.

- [ ] **T13c (P2) — Extract `access_tokens.last_used_at` LRU debounce
  from #1316.** Today `last_used_at` is updated on every bearer
  request via the legacy transport's SQL-level WHERE-clause throttle
  (60s minimum gap). On high-traffic deployments the hot-row writes
  still hit Postgres for every request. #1316 adds an in-process LRU
  cache so the SQL UPDATE only fires once per token per cooldown
  window. Useful on multi-agent fleets sharing tokens at high rate;
  no value for personal-laptop installs. NOT a blocker. Cherry-pick
  starter: #1316's `src/core/token-last-used.ts` + the wiring in
  `src/mcp/http-transport.ts:validateToken`. Effort: human ~2h /
  CC ~20min.

**NOT filed:** the RLS posture rewrite from #1316. That changes the
v0.26.7 auto-RLS event trigger that `gbrain doctor`'s
`rls_event_trigger` check treats as load-bearing; it deserves its own
plan-eng-review + doctor-check rewrite + breaking-change CHANGELOG
note. Filing it as a TODO would imply it's ready to pull; it isn't.

## v0.41.0.0 follow-ups (v0.41.1+)

- [ ] **v0.41+: per-key rate-lease caps (`openai:responses`, `google:gemini`, etc.).**
  v0.41 ships a single `anthropic:messages` rate-lease cap. When users run
  subagents against multiple providers via the gateway path, each provider
  should have its OWN rate-lease bucket so they don't share capacity. The
  right time for this is right after `agent.use_gateway_loop=true` becomes
  the default — before that, you're solving for a configuration no one uses.
  Priority: P2. Filed via CEO D13. References: `src/core/minions/rate-leases.ts`
  + `src/core/minions/handlers/subagent.ts:GBRAIN_ANTHROPIC_MAX_INFLIGHT`.

- [ ] **v0.41+: `minion_lease_pressure_log` + budget/self-fix audit retention sweep.**
  v0.41 migration v94 promoted `ON DELETE SET NULL` on audit FKs so rows
  survive `gbrain jobs prune`. Codex pass-3 #5 caught the corollary: without
  retention, audit tables grow unbounded. On a steady-pressure install
  (heavy daily batches), `minion_lease_pressure_log` is millions of rows by
  year 2. Add a sweep phase to the autopilot cycle's `purge` phase (the
  v0.26.5 pattern, sibling to `engine.purgeDeletedPages(72)`):
  `engine.purgeOldAuditRows({ lease_pressure_max_age_days: 90, budget_log_max_age_days: 365, self_fix_log_max_age_days: 180 })`.
  Defaults match operator use cases (90 days lease pressure for capacity
  tuning, 365 days budget for accounting, 180 days self-fix for
  classifier-tuning); all overridable via config. Priority: P3. Filed via
  CEO D16. Closes the unbounded-growth concern that codex flagged as
  load-bearing pass-3 #5.

- [ ] **v0.41.1: full E5 A/B dispatcher (currently scaffolded as dry-run only).**
  `scripts/e5-lease-cap-ab.ts` ships the spec + harness + receipt fixture
  shape but the real-run dispatcher (queue submit + worker spin-up + 15-min
  429 injector + tick loop + cost-tracking) is deferred. v0.41.1 follow-up
  writes the dispatcher and commits the first real-API receipt as the
  baseline before flipping `minions.auto_lease_cap` to default ON.

- [ ] **v0.41.1: `tryWithDbElection` retrofit for existing `pg_advisory_xact_lock` call sites.**
  Codex pass-2 #7 caught that `src/core/minions/rate-leases.ts:80`
  (`acquireLease`) and `src/core/minions/queue.ts:152` (maxWaiting coalesce)
  call `pg_advisory_xact_lock` unconditionally. PGLite has no advisory locks
  (`src/core/pglite-schema.ts:6`); current code passes by accident because
  PGLite is single-connection. New `tryWithDbElection` primitive in
  `src/core/db-lock.ts` is engine-dispatched. Retrofit the two existing
  call sites to use it so PGLite correctness is explicit, not accidental.
  Two call shapes needed (codex pass-3 #10): one starts a new tx (E5 use
  case, already shipped); one accepts an existing tx (rate-leases +
  maxWaiting use cases). Filed via Eng D9.

- [ ] **v0.42: semantic-aware `prompt_too_long` reduction in E6 self-fix.**
  v0.41 ships truncate-with-leaf-preservation (first 1000 + last 2000 chars).
  Codex pass-1 #11 specified the right strategy: walk the conversation, drop
  tool_result blocks first (largest non-task content), summarize older
  user/asst pairs via Haiku, never delete the leaf user task. Implementation
  lives in `src/core/minions/self-fix.ts:buildSelfFixPrompt`. Worst-case
  current behavior (truncate-then-fail) is safe — no infinite loops,
  depth-cap prevents chains — but full semantic reduction unlocks higher
  self-fix success rates on legitimately-long prompts.
## v0.41.7.0 resolver-parser follow-ups (filed during ship of `garrytan/pr1370-production-ready`)

Source: Codex outside-voice review on the PR #1370 production-rebuild plan.
The wave shipped with the primary parser fix + 11 unit tests + 2 integration
fixtures + scaling-skills tutorial. Two findings deferred:

- [ ] **F8 P3 — Path-traversal hardening for the existing table-format
  parser.** Both the existing table parser and the new list parser accept
  inputs like `skills/../x/SKILL.md`; downstream `join(skillsDir, relPath)`
  can escape `skillsDir`. The v0.41.7.0 list branch is structurally closed
  (the kebab-lowercase `[a-z][a-z0-9-]+` name regex rejects `.` in names so
  `..` is blocked at the name layer). The table branch surface is
  pre-existing and out of scope for v0.41.7.0. Move: at the file-existence
  check in `src/core/check-resolvable.ts` (around line 352), add a
  `relPath.split('/').includes('..')` guard that surfaces as an
  `unreachable` issue with a "path traversal not allowed" message. Low
  severity: requires malicious/buggy RESOLVER.md content to fire.

- [ ] **F9 P3 — Document the fan-out/dedup interaction in the resolver
  guide.** `checkResolvable` dedupes by `skillPath`, so the v0.41.7.0
  list-format multi-trigger fan-out (`- **foo**: t1 | t2 | t3` produces 3
  entries) doesn't change the integration reachability count. This is
  desired behavior (one skill counted once) but surprising for readers who
  count parser entries. Move: add a one-paragraph "how fan-out interacts
  with reachability" note to `docs/guides/scaling-skills.md` after we have
  reader feedback indicating the confusion is real. Codex noted that unit
  tests prove parser output, integration tests prove reachability, and the
  current docs don't bridge the two cleanly. Doc-only follow-up.

- [ ] **P1 flake — audit-writer.test.ts week-boundary failure.** Caught
  during ship of v0.41.7.0. Test at `test/audit/audit-writer.test.ts:229`
  ("returns events from current week, filtered by ts cutoff") fails when
  real UTC date is in a different ISO week than the test's hardcoded
  `now=2026-05-22`. `writer.log()` uses real `new Date()` to pick the
  week-file; `readRecent(now)` uses the fake `now`. When the two land in
  different ISO weeks (specifically: any time the real UTC clock is in
  the week AFTER 2026-W21), `log()` writes to the wrong file and
  readRecent finds 0 events. Fires deterministically once a week, at the
  UTC Monday rollover. Move: refactor `createAuditWriter.log()` to accept
  an optional injected `now` (or read it from the entry's own `ts` field).
  Affected surface: `src/core/audit/audit-writer.ts`. Pre-existing on
  master; not caused by this branch's parser changes. Reproducible by
  setting system clock to any Monday after the test's `2026-05-22` date.

## v0.41 content-sanity follow-ups (filed during ship of `garrytan/lint-page-size-gate`)

Source: CEO + Eng review on the content-sanity defense plan. Both reviews
ran Codex (round 1 + round 2 — 30 total findings) and the wave shipped
with the strategic items addressed. These are the deliberately-deferred
follow-ups, captured here so v0.42 starts informed.

- [ ] **v0.42 P1 — Chunk-level embed-quarantine.** The v0.41 wave landed
  page-level soft-block (`frontmatter.embed_skip`); Codex r1 #3 caught
  that staleness is chunk-based (`content_chunks.embedding IS NULL`).
  Right granularity for the embed-pipeline-overflow case is per-chunk,
  not per-page. Move: add `content_chunks.embed_quarantined_at TIMESTAMPTZ`
  + partial index, catch `TokenLimitError` from gateway, mark the offending
  chunk only (keep good siblings), surface in doctor's
  `embedding_coverage`. Requires repro of the original 890K embed failure
  on current code FIRST to confirm whether it's batch-overflow vs
  single-oversized-chunk vs token-estimate-miss. Effort: human ~2 days /
  CC ~3 hours.

- [ ] **v0.42 P1 — Source-repo remediation surface.** Codex r1 #7
  caught: cleanup CLI that deletes DB rows doesn't fix source of truth
  — junk file in source repo reappears on next sync. Move: add
  `gbrain sources prune-junk <id>` that walks `local_path`, finds files
  matching the junk-pattern set, soft-deletes DB rows AND `git rm`s the
  files in the source repo (commit message: `auto: prune junk pages
  flagged by gbrain content-sanity`). Operator pushes the commit.
  Pairs with the v0.42 chunk-quarantine for a complete cleanup story.
  Effort: human ~1 day / CC ~2 hours.

- [ ] **v0.41 + 30 days — Threshold default validation post-deploy.**
  Codex r1 #15 caught: we invented 50K warn / 500K block thresholds
  before measuring real corpus distribution. Move: run `gbrain sources
  audit <id>` on real source repos (start with Garry's own brain),
  collect distribution stats from the JSON envelope, tune defaults
  if the measured p99 disagrees with the 50K assumption. Either
  publish updated defaults in a v0.41.x patch or document the env
  override path in CHANGELOG. Effort: human ~30min / CC ~10min.

- [ ] **v0.42 P2 — Pages soft-delete CLI (`gbrain pages soft-delete
  --where`).** Cherry-pick 3 from the original CEO review; dropped
  during eng review because Codex r1 #7 weakened it (doesn't fix
  source-of-truth). Resurface in v0.42 as a PAIRED tool alongside
  the v0.42 source-repo remediation. Filter expressions:
  `matches_junk_pattern`, `bytes > N`. Required UX gates: `--dry-run`
  preview, `--confirm-destructive` flag when affected > 0, 1000-page
  per-invocation cap. Routes through existing `engine.softDeletePage()`
  (v0.26.5 72h-TTL safe-delete; reversible).

- [ ] **v0.42 P3 — Brain-score `no_junk_pages_score` component.**
  Add a 6th component to the v0.36.4.0 5-component brain-score
  formula (currently embed_coverage 35 + link_density 25 +
  timeline_coverage 15 + no_orphans 15 + no_dead_links 10). Reweight
  to make room (probably take 5 from no_dead_links: 35/25/15/15/5/5).
  File AFTER v0.41's audit JSONL has 30+ days of signal so we know
  the realistic distribution of junk-page rates across brains before
  pinning a score weight.

- [ ] **post-v0.45 — Operator-supplied regex extensibility.** Dropped
  in v0.41 per Codex r1 #10 (JavaScript RegExp lacks atomic groups /
  possessive quantifiers, making a reliable ReDoS shape detector
  hard). The v0.41 ship has literal-substring extensibility instead
  which covers ~95% of real operator use cases. If real operators
  ask for regex, add it with a real story: either re2 (Google's
  linear-time engine; native dep, build complications) or worker-
  thread per-pattern timeout (50ms cap, runtime overhead).

- [ ] **post-v0.45 — HTML-density rule.** Dropped in v0.41 per Codex
  r1 #16. Was: flag pages where `<div>`/`<span>`/etc tag density is
  too high (raw HTML dump indicator). Requires careful handling of
  fenced code blocks, JSX/XML in technical notes, escaped HTML.
  Without that rigor, false-positives on legitimate code-heavy
  technical writing. The scraper-junk pattern set catches the real
  junk class without needing density math; revisit only if a junk
  pattern leaks through that ONLY density would catch.

- [ ] **v0.41+ — Bytes parity assertion across lint + doctor.** D2
  acceptance test included in `test/content-sanity.test.ts` as a
  unit-level parity check. Promote to an E2E that seeds a real
  fixture page with frontmatter + body, runs `gbrain lint` AND
  `gbrain doctor --content-audit`, asserts both surfaces report
  the same byte count. Catches drift between
  `Buffer.byteLength` (assessor) and `octet_length` (doctor SQL)
  if either surface changes the measurement axis.

- [ ] **v0.41+ — `gbrain sources audit` E2E pin test.** The CLI
  shipped with unit tests pinning `assessContentSanity` shape;
  the integration test (walk a fixture source dir, run the CLI
  end-to-end, assert JSON envelope shape) is deferred. Trivial to
  add (~30 LOC) once a stable test fixture set lands under
  `test/fixtures/content-sanity/`.

- [ ] **v0.41+ — Doctor checks integration tests.** The 3 new doctor
  checks (`oversized_pages`, `scraper_junk_pages`,
  `content_sanity_audit_recent`) ship verified by typecheck +
  runtime-shape via the unit suite. Integration tests (seed fixture
  pages into PGLite, run doctor, assert check status + message
  format) are deferred. Same pattern as existing
  `test/doctor.test.ts` extensions.

- [ ] **v0.41+ — 5-path narrow-waist E2E pin tests (cherry-pick 5).**
  Sync + import + put_page MCP + capture + /ingest webhook all
  route through `importFromContent` so the new gate applies
  uniformly. Unit tests pin the gate behavior; E2E pin tests
  prove each ingestion path actually goes through it. Tests for
  sync + import + put_page MCP + capture are PGLite-hermetic;
  the /ingest webhook test needs real-Postgres E2E (DATABASE_URL).
  Filed during eng review as P2; not blocking ship since the
  narrow-waist contract is structurally enforced by every wrapper
  routing through `importFromContent` already.

## v0.41+ wave commitments (decided 2026-05-23)

Source: `/plan-ceo-review` + `/plan-eng-review` triage of TODOS as roadmap
signal. Plan file: `~/.claude/plans/system-instruction-you-are-working-dazzling-pnueli.md`.
Three strategic decisions landed and the 7 verified-absent items the
analysis surfaced were approved for filing.

### D1 — v0.41 Eval-loop wave (LANDED v0.41.0.0, scope reshaped)

**Status:** Shipped in v0.41.0.0 (2026-05-24). CEO+Eng review reshaped the
original 3-item slice: items 1 + 3 (autopilot wiring + `gbrain eval gate`)
shipped as planned + EXPANDED with a correctness gate (qrels-based recall@K
+ first-relevant-hit-rate) and a `gbrain bench publish` verb that closes the
LOOP by giving captured data a destination. Item 2 (capture-default flip)
deferred to v0.42 because the flip is a one-way door and shouldn't ship
before the destination exists.

The original 3 items as filed (kept for traceability):

- [ ] **P0 — `gbrain eval gate <baseline.ndjson>` for CI.** The single most
  load-bearing missing item across all 12 clusters. Fails the build on
  regression vs the last published BrainBench-Real baseline. Without it,
  every other eval surface is informational, not gating. Shape: reads
  the captured/replay NDJSON shape from v0.25.0+, compares mean_jaccard +
  top-1 stability against thresholds embedded in the baseline file, exits
  non-zero on regression. Filed in the v0.40.1.0 Track D follow-up
  ("v0.41+: contributor-mode CI capture for BrainBench-Real replay gate")
  but that item describes the data pipeline; this item is the gate verb
  itself. Effort: human ~1 day / CC ~2 hours once a stable baseline exists.

- [ ] **P0 — Contributor-mode eval capture ON by default with airtight
  privacy.** Today `eval.capture` defaults OFF; only contributors who
  set `GBRAIN_CONTRIBUTOR_MODE=1` produce `eval_candidates` rows. Without
  capture flowing, replay-against-baseline gates have nothing to replay
  AGAINST in production. Move: harden the PII scrubber (verify Luhn
  card-number false-positive rate, audit JWT-shape regex, document
  every scrub class), then flip the default. Add a one-line opt-out
  banner on first `gbrain init` post-upgrade. Cross-reference the
  `eval_capture_failures.reason` enum cleanup from the v0.25.0 P1 surgical
  hardenings list. Effort: human ~3 days / CC ~3 hours.

- [ ] **P0 — Wire nightly quality probe into autopilot scheduler.** The
  phase ships callable (`src/core/cycle/nightly-quality-probe.ts`) with
  full DI surface; doctor surfaces outcomes; the audit JSONL rotates
  cleanly. What's NOT wired: `src/commands/autopilot.ts` doesn't invoke
  `runNightlyQualityProbe(deps)` on its 24h cadence. Add the phase
  trigger; honor `autopilot.nightly_quality_probe.enabled` config gate.
  Already filed in v0.40.1.0 Track D follow-ups — re-filing here as P0
  with explicit D1-wave dependency. Effort: human ~3 hours / CC ~30 min.

### D2 — Code-indexing promoted to P1 (peer of Cursor/Sourcegraph)

Decision: gbrain commits to being a code-brain peer of dedicated tools,
not "knowledge brain that also indexes code." The five code-indexing
TODOs below promoted from P2/P3 to P1. Plan reference: v0.21 Code
Cathedral II was the last big push; this wave revives the trajectory.

- [ ] **P1 — `.sql` file indexing (#1173).** Vendor `tree-sitter-sql.wasm`
  into `src/assets/wasm/grammars/`, extend sync walker's extension filter
  to include `.sql`, route through `importCodeFile()` with
  `page_kind='code'`. Verify-first slug round-trip before merging (codex
  CF11 from v0.37.7.0). Pre-existing entry under v0.37.7.0 follow-ups
  — keep that one, this is just the priority bump.
- [ ] **P1 — Magika auto-detect for extension-less files (B2 from v0.21).**
  Bundle Google's Magika ONNX (~1MB) as an asset; wire into
  `detectCodeLanguage` as fallback for Dockerfile / Makefile / .envrc
  / shell scripts. Hook already exists (`setLanguageFallback` in
  `src/core/chunkers/code.ts`). Closes the last common extension-less case.
- [ ] **P1 — Full `doc_comment` extraction at chunk time (A4 from v0.21).**
  Per-language detection of comment-blocks-preceding-declarations
  (JSDoc, Python docstrings, C-style doc comments). Populates
  `content_chunks.doc_comment`. FTS trigger from Layer 1b already
  weights doc_comment 'A' above chunk_text 'B' — ranking is ready, only
  extraction is missing. Material MRR lift on natural-language code
  queries.
- [ ] **P1 — Cross-file edge resolution (Layer 5 precision upgrade).**
  Second-pass resolution after all code files import: walk every
  `code_edges_symbol` row, try to resolve `to_symbol_qualified` via
  `symbol_name_qualified` join within the same source. Today
  `getCallersOf("searchKeyword")` returns Layer 6 ambiguity — every
  call site in any class. Receiver-type inference lifts this. Per-language;
  TypeScript-first.
- [ ] **P1 — gbrain code-signature retrieval (C6 from v0.21).** "Find every
  function whose signature returns `Promise<User>`" or "(string, number)
  => boolean". Type-signature retrieval via tree-sitter type captures.
  Per-language stretch; TypeScript-first.

### D3 — v0.42 Non-Latin script wave (global by design)

Decision: gbrain commits to first-class non-Latin support. The five
existing "defer until first user complains" entries get consolidated
into one committed wave with a target version.

- [ ] **v0.42 — Postgres CJK FTS via pgroonga / zhparser / ngram trigrams.**
  Multi-tenant Postgres deployments hit empty results for CJK queries
  because `to_tsvector('english', ...)` can't segment Chinese / Japanese
  / Korean. Plan: doctor advisory pointing at extension docs;
  searchKeyword falls through to PGLite-style ILIKE when extension
  isn't installed. v0.32.7 closed PGLite-side; this closes Postgres-side.
- [ ] **v0.42 — Widen CJK ranges to Unicode property escapes.** Today
  `src/core/cjk.ts` uses BMP-only ranges. Misses Han Extensions A/B/C,
  halfwidth katakana, compatibility ideographs, iteration marks `々` `〇`.
  Switch to `\p{Script=Han}` / `\p{Script=Hiragana}` / `\p{Script=Katakana}`
  / `\p{Script=Hangul}`. Astral-plane support also requires
  `Array.from(str)` codepoint iteration in chunker's char-slice fallback.
- [ ] **v0.42 — CJK-aware overlap context in chunker.** `extractTrailingContext`
  is whitespace-token-based today; CJK chunks under maxChars cap have no
  useful overlap with previous chunk. Switch to char-count when
  `countCJKAwareWords` would have triggered the CJK branch.
- [ ] **v0.42 — Thai / Arabic / Cyrillic / Devanagari script support.**
  Same five-layer fix pattern as CJK: slugify ranges, chunker density
  threshold, PGLite keyword fallback with script-aware tokenization.
- [ ] **v0.42 — `git diff --name-status -z` + NUL framing.** v0.32.7
  added `core.quotepath=false` which handles non-ASCII paths but doesn't
  cover tabs, newlines, or quotes in filenames. NUL-byte path framing
  is the robust fix for the whole encoding class. Affects
  `src/commands/sync.ts:buildDetachedWorkingTreeManifest` +
  `buildSyncManifest`.

### Verified-missing items — filed into TODOS (P2 unless noted)

Each grep-verified absent before being claimed missing. Priority per the
cluster the item sits in. Filed here together for traceability; future
cleanup can move each into the relevant area section.

- [ ] **P2 — `gbrain sources promote <id> <target-source>`** — write-side
  counterpart to mounting. Today federation is read-side only; promotion
  is the unfiled symmetric verb. (Federation cluster.)
- [ ] **P2 — `--explain` auto-on during `gbrain eval replay`** — so
  regression reports show WHY a page dropped from top-3, not just THAT
  it did. (Search-quality cluster.)
- [ ] **P2 — Extend `gbrain remote doctor` to stream brain's audit JSONL
  summaries.** Closes the local/remote observability split-brain
  (T-todo-3 from v0.40.4 covers the DB-table side; this is the read-side
  surface). (Observability cluster.)
- [ ] **P2 — `gbrain costs`** — surfaces per-command, per-source, per-week
  spend. Data is in audit JSONL already; nothing reads it together.
  Pairs naturally with the P5 budgets config block from the v0.37 lsd
  cost-explosion follow-up. (Observability cluster.)
- [ ] **P2 — `gbrain jobs explain <id>`** — full job-graph trace (parent
  → children → tools called → tokens spent → outcome). Today
  `gbrain agent logs <id>` covers subagents but not the broader job
  graph. (Worker cluster.)
- [ ] **P2 — `docs/security/threat-model.md`** — catalog every untrusted
  boundary in gbrain (MCP, OAuth, capture, sync remote URLs, file_upload,
  webhook ingest, subagent tool dispatch) and link each to its defense.
  Defenses exist (v0.26.5 destructive-guard, v0.26.7 OAuth hardening,
  v0.34.1 source-isolation P0 seal, v0.36 SSRF); the catalog does not.
  Verified absent: `docs/security/` directory doesn't exist.
  (Safety cluster.)
- [ ] **P3 — `gbrain doctor --thin-client` parity probe** — compares
  the same query against local PGLite vs remote HTTP MCP and surfaces
  behavior drift. Static parity test (filed in v0.31.x follow-ups)
  catches API drift; this catches behavior drift. (Agent ergonomics cluster.)
- [ ] **P3 — `gbrain models migrate --from openai:text-embedding-3-large
  --to voyage:voyage-3-large`** — estimates cost, schedules re-embed
  via Minion job, swaps active column atomically. Column-registry
  primitive exists (`embedding_columns` from v0.36.3); migration verb
  doesn't. (Embedding cluster.)

---
## v0.41.8.0 PGLite hang follow-ups (v0.41+)

These were filed when v0.41.8.0 shipped the search/query/get hang fix
(#1247/#1269/#1290) + WASM init classifier (#1340) + sync breadcrumbs.
Three items deferred:

- [ ] **Investigate #1342 — `gbrain sync` hangs after schema v89→v92
  migration (PGLite, single reporter).** Repro shape: ~99% CPU in pure-JS
  JIT loop per `sample <pid>`, zero stderr output, reproduces with
  `--dry-run --no-pull`. Triggered after migrations 89→92 landed (v89
  facts_event_type_column, v90 contextual_retrieval_columns, v91
  pages_generation_trigger_and_bookmark, v92 sources_github_repo_index).
  Stale lock recovery from a `brain.pglite.broken-20260523-120636`
  rename suggests half-applied schema state.

  **Ruled out** (per v0.41.8.0 plan-eng-review): NOT the
  `withRefreshingLock` heartbeat (user takes the legacy global-lock
  path — no setInterval); NOT the v91 trigger function (only fires on
  writes, user repros with `--dry-run`); NOT the two `while (true)`
  loops in `src/commands/sync.ts` (parallel worker pool + watch mode,
  neither in the user's invocation path).

  **Next diagnostic steps**:
  1. Seed a fresh PGLite brain at schema v88 (snapshot the embedded
     schema blob at that version into a test fixture), apply migrations
     v89→v92, then run `performSync` with the user's exact flags and
     an 8s timeout. Repeat with a partial-v91 state (column landed,
     index didn't) to match the `brain.pglite.broken-...` clue.
  2. Run the reproducer under `bun --inspect-brk` and grab the V8
     stack at the spin point.
  3. Scan for `contextual_retrieval_mode IS NULL` paths in sync /
     `src/core/import-file.ts` — the v90 column may have an unbounded
     iteration somewhere when the per-source backfill kicks in.

  **Reporter's config**: PGLite, `~/.gbrain/brain.pglite`,
  `ollama:nomic-embed-text` @ 768d, macOS 15.5, single 'default'
  source.

  **Mitigation in v0.41.8.0**: phase breadcrumbs added to
  `performSyncInner` so the next #1342-shaped report names WHICH phase
  spun (resolve_repo / load_active_pack / validate_repo_state /
  detect_head). Doesn't fix; makes reports actionable.

- [ ] **Concurrent disconnect-during-connect race on `PGLiteEngine`
  (adversarial-review C6, v0.41.8.0).** The v0.41.8.0 snapshot+early-null
  pattern in `disconnect()` improves the partial-state race for the
  common case (single instance, sequential lifecycle), but a concurrent
  `connect()` and `disconnect()` on the same engine instance can still
  strand: `disconnect()` snapshots+nulls the lock and releases it while
  `connect()` is still in-flight (lock already acquired, awaiting
  `PGlite.create()`). When `connect()` resolves, `this._db` is assigned
  to a fresh handle but `this._lock` is null — engine is "connected"
  but holds no file lock; another process can acquire it concurrently.
  Unusual caller pattern in production (one instance per process,
  sequential lifecycle), but tests sometimes do this and the contract
  is undefined. Fix: serialize connect/disconnect with an instance-level
  mutex, or document the constraint and assert single-flight at the
  call site.

- [ ] **Retrofit `awaitPendingSearchCacheWrites` with the same bounded
  timeout v0.41.8.0 added to `awaitPendingLastRetrievedWrites`.** The
  v0.36.1.x #1090 fix at `src/core/search/hybrid.ts:36-45` shipped the
  drain pattern without a timeout; v0.41.8.0 added the timeout + warn
  pattern to the new `awaitPendingLastRetrievedWrites` helper. For
  symmetry (and to close the same future-failure mode in the cache
  drain), apply the same `Promise.race` + stderr warn pattern. ~15 LOC
  + 2 unit cases. Pair this with the drain-helper extraction below.

- [ ] **Extract a shared `createDrainHelper<T>()` factory when a third
  fire-and-forget surface appears.** Per D4 in the v0.41.8.0 eng
  review: two surfaces is the threshold for noticing, three for
  extracting. `src/core/search/hybrid.ts:awaitPendingSearchCacheWrites`
  + `src/core/last-retrieved.ts:awaitPendingLastRetrievedWrites` are
  the two surfaces today. When a third surface is added (or when the
  timeout-symmetry retrofit above lands and the duplication becomes
  load-bearing), extract a `src/core/drain-helper.ts` factory consumed
  by both call sites. Pair with the symmetry retrofit so they fire
  together as one focused refactor.

---
## v0.41 Eval-loop wave follow-ups (v0.42+)

Filed during v0.41 CEO + Eng review (D11-D13). All three landed via codex
outside-voice triage on the reshaped plan.

- [ ] **v0.42 P1: capture-default flip + scrubber hardening.** Flip
  `eval.capture` default from OFF to ON. Harden `src/core/eval-capture-scrub.ts`
  with AWS access key (`AKIA[0-9A-Z]{16}`), GitHub PAT (`ghp_[A-Za-z0-9]{36}`),
  and generic API-key-suffix patterns. Add first-run stderr banner with
  `gbrain eval capture off` opt-out hint and persistent
  `eval.capture_acknowledged` config flag (banner fires once per acked-false).
  Two new CLI verbs: `gbrain eval capture on|off|status` + `acknowledge`.
  Dependency: v0.41 LOOP (this wave) has shipped + been used for at least
  a month so the destination story is real. Filed during v0.41 CEO review
  per D11 after the original wave plan was reshaped by codex outside-voice
  to defer this item.

- [ ] **v0.42-v0.43 P2: `gbrain bench publish --suggest-thresholds`.**
  Reads the last 30 days of `eval gate` JSON outputs (from gbrain-evals
  CI artifacts or `~/.gbrain/audit/bench-publish-*.jsonl`), computes p10
  of each metric across passes, suggests those as thresholds. Starting-
  guess thresholds in v0.41 (regression: jaccard 0.85 / top1 0.80 /
  latency_multiplier 2.0; correctness: recall@10 0.70 /
  first_relevant_hit_rate 0.60 / expected_top1 0.50) are either too tight
  or too loose; data informs the heuristic. Dependency: 30+ days of gate
  runs accumulating. Filed during v0.41 CEO review per D12.

- [ ] **v0.42+ P3: `gbrain bench diff` + `gbrain bench list`.**
  `bench diff <a.baseline.ndjson> <b.baseline.ndjson>` — visual diff of
  two baselines showing which queries changed top-1 retrieval, which
  lost relevant_slugs, which gained. `bench list [--dir <path>]` — lists
  baselines with metadata (label, published_at, row_count, source_hash);
  defaults to `~/.gbrain/baselines/` + `gbrain-evals/baselines/` if both
  exist. Trivial; ship when there's >1 baseline to look at. Filed during
  v0.41 CEO review per D13.

- [ ] **v0.42+: ship the coordinated `gbrain-evals/baselines/v0.41-launch.baseline.ndjson`
  + `gbrain-evals/qrels/v0.41-launch.qrels.json` (hermetic-synthetic per D9).**
  Generate locally via `gbrain bench publish --from <hermetic-test-corpus>` then
  commit to the sibling gbrain-evals repo. Gives `gbrain eval gate` a canonical
  baseline target so users don't have to bootstrap their own immediately.

## v0.40.7.0 Schema Cathedral v3 follow-ups (v0.40.7+)

These were filed when v0.40.7.0 closed PR #1321's design as a production
rebuild. The wave shipped the 9 MCP ops + 14 CLI verbs + atomic mutation
primitives + skill on-ramp; three wiring sites were larger than expected
at plan time and got carved out:

- [ ] **v0.40.7+: enrichment-service.ts union widening (`'person' | 'company'` → `string`).**
  `src/core/enrichment-service.ts` hard-codes the `entityType` union in 6
  sites (`:25`, `:48`, `:60`, `:238`, `:246`, + caller mappings). Widening
  to `string` and threading the active pack's path_prefixes through
  `slugifyEntity` closes the T1.5 silent-no-op bug for the enrichment
  pipeline. Estimated 2 hours CC. Third T1.5 wiring site (whoknows +
  find_experts MCP already wired in v0.40.7.0).

- [ ] **v0.40.7+: facts/eligibility.ts pack-aware ELIGIBLE_TYPES wiring.**
  `src/core/facts/eligibility.ts:49` defines a hardcoded `ELIGIBLE_TYPES`
  array. Should consult `extractableTypesFromPack(pack)`. Behavioral
  change: every brain's extraction surface changes once wired, so needs
  careful verification.

- [ ] **v0.40.7+: three doctor checks for schema pack health.**
  `schema_pack_coverage` (warn >10%, fail >30% untyped on non-default
  pack), `schema_pack_writability` (reads schema-mutations audit JSONL
  for PACK_READONLY failures), `schema_pack_mutation_audit` (anomalous
  patterns like >20 mutations/week). All warn-only; reuse
  `summarizeMutations()` for cross-surface parity. Audit log shipped
  with the right shape so these drop in cleanly.

- [ ] **v0.40.7+: T16 — hermetic schema-authoring eval gate.**
  Extend `src/commands/eval-schema-authoring.ts` into a PGLite harness
  driving detect → suggest → add-type → sync end-to-end on 3 fixtures.
  Filing-accuracy delta metric (not top-3 hit rate per codex C18). DI
  seam via `suggestFn`. 3 hours CC + placeholder-name fixtures.

- [ ] **v0.40.7+: T16.1 — separate "suggest top-3 hit rate" eval.**
  Different question from T16. ~2 hours CC.

- [ ] **v0.41+: T19 — per-source federated read closure across mounts.**
  Trust gate today rejects divergent-pack federated reads
  (`op-trust-gate.ts:111-116`). Real fix needs per-source SQL closure
  via `buildPerSourceBindings`. Document workaround: register
  source-scoped OAuth clients.

- [ ] **v0.41+: T20 — extends-chain merging in registry.ts.**
  `registry.ts:167` documents the gap. Implementing full child-wins
  merge cascades through every consumer of `manifest.page_types`. ~1
  day CC.

- [ ] **v0.41+: T21 — comment-preserving YAML emitter.**
  v0.40.7.0 emitter does NOT preserve comments. Authors who care
  pin pack.json. Replacing with a comment-aware library is the proper
  fix.

- [ ] **v0.41+: T22 — admin SPA tab for schema verbs.**
  CLI + MCP only this wave.

- [ ] **v0.41+: T23 — finer-grained `schema:write` OAuth scope.**
  Today the write ops gate on `admin`. Splitting `admin → admin +
  schema:write` is a cross-cutting refactor.

- [ ] **v0.41+: T24 — multi-tenant pack federation in a single brain.**
  One active pack per source remains.

## v0.40.3.0 follow-ups (v0.41+)

- [ ] **v0.41+: source-scope the `sync-failures.jsonl` log so `--skip-failed` works under `--parallel > 1`.**
  v0.40.3.0 shipped `gbrain sync --all --parallel N` as a continuous worker pool
  with per-source DB locks. The remaining unsafe path: `recordSyncFailures()` /
  `acknowledgeSyncFailures()` in `src/core/sync.ts` write to a brain-global JSONL
  file at `~/.gbrain/sync-failures.jsonl` with no per-source scope. Under parallel
  sync, source A's `--skip-failed` ack can swallow source B's failures recorded
  while B was still running. v0.40.3.0's safe interim: refuse to combine
  `--skip-failed` / `--retry-failed` with `--parallel > 1` (loud error, paste-ready
  hint pointing at `--parallel 1`). The proper fix: (1) extend the JSONL row
  schema with a `source_id` field; (2) `recordSyncFailures(failures, sourceId)`
  stamps the field; (3) `acknowledgeSyncFailures({sourceId})` filters acks to
  one source's rows; (4) `unacknowledgedSyncFailures({sourceId})` reads the
  subset. Drop the v0.40.3.0 restriction once source-scoped acks are
  deterministic. Estimate: ~1-2 days. Filed during v0.40.3.0 plan review by
  Codex outside-voice (decision D15 → B in the eng-review plan at
  `~/.claude/plans/system-instruction-you-are-working-fluttering-grove.md`).

- [ ] **v0.41+ (optional): extend `checkSyncFreshness` to include `embedding_coverage_pct`
  per source.** v0.40.3.0 plan originally proposed adding a NEW doctor check
  `sync_freshness_per_source` consuming `buildSyncStatusReport`. Codex caught
  that `checkSyncFreshness` (`src/commands/doctor.ts:~1609`) is ALREADY per-source —
  iterates `WHERE local_path IS NOT NULL`, emits per-source messages with
  paste-ready `gbrain sync --source <id>` hints, warns at 24h, fails at 72h.
  The plan dropped the duplicate (D9 → A). The real follow-up is to extend
  `checkSyncFreshness`'s message to include `embedding_coverage_pct` per source
  alongside the staleness number so doctor surfaces the coverage gap inline.
  Implementation: reuse `buildSyncStatusReport` from `src/commands/sync.ts`,

## v0.40.6.1 llama-server-reranker follow-ups (v0.40.7+)

Filed from the /ship Claude adversarial subagent review against this PR. None are
exploitable today; they harden the new local-reranker surface against future
contributor traps.

- [ ] **P1: SSRF scheme validation sweep for all 6 openai-compat `_BASE_URL` env vars.**
  `src/cli.ts:1483-1487` accepts `LLAMA_SERVER_BASE_URL`, `LLAMA_SERVER_RERANKER_BASE_URL`,
  `OLLAMA_BASE_URL`, `LMSTUDIO_BASE_URL`, `LITELLM_BASE_URL`, `OPENROUTER_BASE_URL` with
  zero scheme validation. A `file://` or `gopher://` value silently becomes the
  recipe's base URL. Pre-existing pattern; this wave adds one more env var to the gap
  without expanding the class. Fix: add a `validateOpenAICompatBaseURL(url)` helper
  (assert `http(s):` scheme + reuse `src/core/ssrf-validate.ts` private-IP checks
  for the non-localhost case), apply to all 6 envs at the `buildGatewayConfig` site.
  ~20 LOC + 6 test cases. Should be its own focused PR.

- [ ] **P2: Document `FREE_LOCAL_RERANK_PROVIDERS` invariant.** `src/core/budget/budget-tracker.ts:lookupPricing`
  returns `{input:0, output:0}` for any model id under the `llama-server-reranker:`
  provider on the rerank kind. The contract relies on all callers going through
  `gateway.rerank()`'s `assertTouchpoint`-with-extended-models check (which validates
  the model exists before pricing fires). Theoretical bypass: a future caller that
  reserves directly against BudgetTracker with `kind: 'rerank'` and an arbitrary
  `llama-server-reranker:<anything>` model id gets free pricing. Fix: code comment
  documenting the invariant, OR move the freeness check to gateway.rerank() where
  the validation already runs.

- [ ] **P2: Recipe path-concat sanity check at gateway-init.** `src/core/ai/gateway.ts:rerank()`
  concatenates `${compat.baseURL.replace(/\/$/, '')}${tp.path ?? '/models/rerank'}`.
  A future recipe with `path: 'rerank'` (no leading slash) produces `…/v1rerank`;
  a future recipe with `path: '/v1/rerank'` when `base_url_default` already ends
  in `/v1` reintroduces the codex-caught doubling bug. Fix: at `configureGateway`
  time, assert `tp.path` (when set) starts with `/` and warn-log when the recipe
  pattern looks doubling-prone. Surface at init, not first-rerank.

- [ ] **P3: Debug-log on malformed `search.reranker.model`.** `src/core/search/mode.ts:lookupRerankerRecipeDefaultTimeout`
  silently returns undefined when `getRecipe(providerId)` misses (typos, malformed
  strings). Fail-open is correct for timeouts (5000ms is a safe bundle default),
  but the user-facing UX is "config was set, nothing changed" with no signal.
  Fix: stderr-log once when `modelStr` is non-empty but the provider id doesn't
  resolve, gated by `GBRAIN_DEBUG=1`.

- [ ] **P3: Narrow `resolveLiveRerankerModel` catch.** `src/commands/models.ts:resolveLiveRerankerModel`
  has a blanket `try/catch` around `loadSearchModeConfig` + `resolveSearchMode`
  that falls back to `getRerankerModel()`. Real errors (schema-version mismatch,
  malformed config JSON, engine connectivity blip) get hidden behind a misleading
  "not configured" doctor verdict. Fix: narrow the catch to specific shapes OR
  emit `GBRAIN_DEBUG=1` stderr warning before falling back.

- [ ] **P3: Validate `modelStr` shape before allocating probe timeout.**
  `src/commands/models.ts:probeRerankerReachability` resolves the recipe + sets
  `probeTimeoutMs = 30000` before checking that `modelStr` has a non-empty model
  half. Result: `llama-server-reranker:` (trailing colon, empty model) waits 30s
  before failing at `assertTouchpoint`. Fix: regex-validate `modelStr` shape
  (`^[a-z][a-z0-9-]*:[a-zA-Z0-9_.-]+$`) before timeout allocation.

## v0.40.1.0 Track D follow-ups (v0.41+)

- [ ] **v0.41+: contributor-mode CI capture for BrainBench-Real replay gate.**
  v0.40.1.0 Track D shipped the hermetic qrels gate (`test/eval-replay-gate.test.ts`)
  as the structurally-correct replacement for the original "replay against captured
  `eval_candidates` baseline" design. Codex outside-voice audit caught three fatal
  flaws with the replay-against-captured-baseline approach: (a) `scripts/select-e2e.ts`
  is local-only — `.github/workflows/test.yml` + `e2e.yml` hit fixed file lists,
  so a diff-aware selector entry would gate nothing on GitHub PRs;
  (b) `gbrain eval export` reads `eval_candidates` rows which only populate when
  ops fire through the operation layer with `GBRAIN_CONTRIBUTOR_MODE=1` capture —
  PGLite tests seeded via direct `engine.put*()` produce zero captured rows;
  (c) `gbrain eval replay` re-embeds query text via `gateway.embedQuery()` which
  needs an API key CI doesn't have. Real-query dogfooding is still valuable —
  synthetic qrels test the structural ranking, real captures test what users
  actually search for. To restore the replay-based gate properly: (1) provision
  a CI secret for an embedding key (OpenAI text-embedding-3-small is the
  cheapest); (2) build a nightly capture pipeline that runs
  `GBRAIN_CONTRIBUTOR_MODE=1 gbrain eval export --tool query` against a seeded
  brain corpus; (3) commit-automate the resulting NDJSON into
  `test/fixtures/eval-baselines/` with a "Why:" justification line; (4) write
  a new gate test that calls `gbrain eval replay --against <fixture>` and asserts
  on `mean_jaccard`, `top1_stability_rate`, drops the latency assert (CI runners
  vary too much). Estimate: ~2 weeks. Filed during v0.40.1.0 Track D
  /plan-eng-review (see `~/.claude/plans/system-instruction-you-are-working-whimsical-acorn.md`).

- [ ] **v0.41+: Wire the nightly quality probe into autopilot scheduling.**
  v0.40.1.0 Track D shipped the phase (`src/core/cycle/nightly-quality-probe.ts`),
  the audit JSONL (`src/core/audit-quality-probe.ts`), the doctor check
  (`nightly_quality_probe_health` in doctor.ts), and the 10-question
  placeholder fixture. What's NOT yet wired: `src/commands/autopilot.ts`
  doesn't yet invoke `runNightlyQualityProbe(deps)` on its 24h cadence —
  the phase is callable in isolation (good for testing) but no scheduled
  loop calls it. To finish: add a phase trigger to the autopilot cycle loop
  that calls the probe with concrete deps wiring (`isEnabled`,
  `hasEmbeddingProvider`, `resolveMaxUsd`, `resolveRepoRoot`, real
  `runLongMemEval` / `runCrossModalBatch` invocations via subprocess or
  direct function call). Honor `autopilot.nightly_quality_probe.enabled`
  config gate (already in doctor's read-side; needs autopilot read-side).
  Doctor surface is already in place to show outcomes; just need the
  scheduling lane. Estimate: ~3 hours.

## v0.41+ e2e-test-wave follow-ups (filed during v0.40.8.0 ship)

- [ ] **NEW-1 (P2) — Per-check leaf unit tests for the 20+ exported doctor check functions.** `src/commands/doctor.ts:169-1492` exports whoknowsHealthCheck, takesWeightGridCheck, childTableOrphansCheck, checkRerankerHealth, checkBrainstormHealth, checkSearchMode, checkEvalDrift, checkSyncFreshness, checkAbandonedThreads, checkCalibrationFreshness, checkGradeConfidenceDrift, checkVoiceGateHealth, checkZeEmbeddingHealth, checkEmbeddingWidthConsistency, checkSourceRoutingHealth, checkOauthConfidentialHealth, checkAutopilotLockScope, skillBrainFirstCheck. v0.40.8.0 covers them via the orchestrator only. Parameterize a single `test/doctor-leaves.test.ts` over the exported functions; each case seeds the minimum DB state and asserts the returned `Check.status`. Catches per-check render bugs the orchestrator snapshot can't see (codex CMT-2 deep fix). Estimated ~4h CC.
- [ ] **NEW-2 (P2) — Cycle-phase wrappers beyond lint + backlinks.** 7 more phases need result-mapping coverage: sync, extract, embed, orphans, extract_facts, resolve_symbol_edges, recompute_emotional_weight. Each adds a describe block to `test/cycle-legacy-phases.test.ts` following the established pattern. ~30min/phase with CC. Mechanical follow-through.
- [ ] **NEW-3 (P2) — HTTP-level trust-boundary test that proves serve-http.ts honors the filter at runtime.** v0.40.8.0 ships the source-grep guard at `scripts/check-operations-filter-bypass.sh` plus structural assertions in `test/operations-trust-boundary.test.ts`. The codex CMT-3 strongest defense — runtime proof that a register-OAuth-client → attempt-call-every-localOnly-op flow rejects every one — would extend `test/e2e/serve-http-oauth.test.ts`. Real Postgres dep, ~30s wallclock per case. Closes the bypass class with runtime proof in addition to the existing structural defense.
- [ ] **NEW-4 (P3) — Render function extraction from runDoctor.** v0.40.8.0 uses a subprocess smoke at `test/doctor-cli-smoke.serial.test.ts` to cover the wrapper's render + exit paths. Pulling the human + JSON render code out into pure formatters would let that smoke move back into the parallel fast loop with no subprocess overhead. ~2h CC. Lower priority — the subprocess smoke does its job; this is a wallclock win, not a coverage win.

## v0.41+ master flake follow-ups (filed during v0.40.8.0 ship)

- [ ] **(P3) — Audit other gateway-mutating tests for missing afterAll cleanup.** v0.40.8.0 added `afterAll(() => resetGateway())` to `test/ai/gateway.test.ts` and quarantined `test/ai/header-transport.test.ts` as `.serial.test.ts`. Two other files mutate gateway state without an explicit cleanup hook: `test/ai/rerank.test.ts`, `test/gateway-embed-model-override.test.ts`. They haven't surfaced flakes yet (different test sequences), but they're the same risk class. Add `afterAll(() => resetGateway())` to both for defense-in-depth, or quarantine if they prove racy under future parallelism changes.
## v0.40.4 adversarial review LOW findings — captured for v0.41+

- [ ] **Codex L1**: `gbrain search stats --days N` underreports for N > 7. audit-writer.ts reads only current + previous ISO week (~14 days). `--days 30` silently shows ~2 weeks of failure events. Fix shape: extend readRecent to walk N/7 weeks dynamically OR cap user input with a clear message.
- [ ] **Claude F2**: Score compounding on repeat applyGraphSignals invocation. The boost stages aren't idempotent on `r.score`; only `base_score` has explicit pre-stamp idempotency. If a future caller invokes runPostFusionStages twice on the same SearchResult array (retry loop, cache-augmentation path), scores compound `score * ADJACENCY_BOOST * ADJACENCY_BOOST`. Same hole in applyBacklinkBoost/Salience/Recency. Document the "call once" contract OR add an `already_applied` guard.
- [ ] **Claude F3**: NaN handling asymmetry. applyBacklinkBoost explicitly guards `if (!Number.isFinite(r.score)) continue` (hybrid.ts:82). applyGraphSignals does NOT — only the floor-threshold guard. With floor_ratio undefined (default), NaN scores get `NaN * 1.05 = NaN`. ECMAScript sort with NaN comparator is undefined behavior. Add the same `Number.isFinite(r.score)` guard.
- [ ] **Claude F5**: Doctor's `linkedRows` coverage query overcounts via soft-deleted source pages. The JOIN filters TO page on deleted_at but not FROM page. Coverage metric overstates link density relative to what graph-signals actually fires on. Fix: add `WHERE l.from_page_id IN (SELECT id FROM pages WHERE deleted_at IS NULL)` or equivalent.
- [ ] **Claude F6**: ANSI / control-char injection via slug or path into stderr + --explain output. audit-slug-fallback writes user-derived `sourcePath`/`slug` unfiltered. explain-formatter renders `graph_session_prefix` (slug-derived) unfiltered. Slug validation in import-file may strip these but defense-in-depth at log/render sites is missing.
- [ ] **Claude F7**: JSONL concurrent-append byte interleaving on large events. `appendFileSync` is atomic only when write size ≤ PIPE_BUF (~4096 bytes Linux). Supervisor audit rows can exceed this. Corrupt rows silently dropped via JSON.parse-in-catch. Fix shape: write to staging file + rename, or use fcntl advisory lock around append.
- [ ] **Claude F8**: Audit files never pruned. 6 audit types × 52 weeks/year = 312+ files. Long-running installs accumulate disk/inode pressure. Add `cleanupOldFiles(retentionDays)` to audit-writer and wire into doctor's purge phase OR autopilot weekly maintenance.
- [ ] **Claude F11**: Source-scope contract on getAdjacencyBoosts is JSDoc-only, no runtime check. Defensive `deleted_at IS NULL` was codified post-review; same defense pattern should apply to source-scope (the v0.34.1 source-isolation seal class). Add optional `sourceId` param that asserts at runtime, OR add a test-only contract checker.
- [ ] **Claude F12**: `require('./core/search/explain-formatter.ts')` in cli.ts:576 is CommonJS. Repo is ESM. Switch to `await import(...)` for consistency with the file's other lazy-imports.
- [ ] **Claude F14**: Telemetry undercounts on cache hit. onScoreDistribution and onGraphMeta fire ONLY in runPostFusionStages which runs ONLY in bare hybridSearch (not cache hit). Doctor's graph_signals_coverage decisions based on absent fire data on high-cache-hit installs.
- [ ] **Claude F16**: src/core/skillpack/audit.ts carries duplicate ISO-week filename math. Refactor onto createAuditWriter for parity with the 5 audits unified in v0.40.4 T2.

## Pre-existing flake on master (noticed during v0.40.4 ship)

- [ ] **`test/search/embedding-column.test.ts:466,489,522` — `isCacheSafe` returns false when run after gateway-state-mutating siblings in shard 2.** Confirmed pre-existing on master (`git stash` + `SHARD=2/8 bash scripts/run-unit-shard.sh` reproduces 3 fails on a clean working tree). Symptom: `isCacheSafe(default-named-column, empty-cfg)` expects `gwDims=1536` but reads `1280` (the post-v0.37.11.0 ZeroEntropy default). Some test in the shard before embedding-column.test.ts initializes the gateway with the PGLite-default ZeroEntropy/1280 config and leaves it that way. Either: (a) embedding-column.test.ts grows a `beforeEach` that calls `__setEmbedTransportForTests`-style reset, (b) the offending sibling adds an `afterAll(reset)`, or (c) embedding-column.test.ts becomes `*.serial.test.ts` to quarantine. Three test files in shard 2 touch gateway state via PGLite engine connects: `restart-sweep.test.ts`, `init-mode-picker.test.ts`, `doctor.test.ts`. Tests pass in isolation (50/50); only fail under shard-2 ordering. v0.40.4 ships through this flake — not introduced by the wave.

## v0.40.4 graph signals — deferred follow-ups (v0.41+)

- [ ] **T-todo-1: profile graph-signal SQL latency at scale + merge backlink + adjacency if hot.** Today `getBacklinkCounts` and `getAdjacencyBoosts` both hit the `links` table inside `runPostFusionStages` — two round-trips that share an index. If profiling on Garry's actual brain shows the two-round-trip cost dominates graph-signal stage latency (>5ms p99), merge into `getLinkAggregates(slugs, pageIds)` returning both backlink counts AND adjacency aggregates in one SQL. D8=C deferred this until real production data justifies it. Trigger: `gbrain search stats` shows graph-signal stage p99 > 5ms over a 7-day window.

- [ ] **T-todo-2: magnitude calibration wave from 30 days of score-distribution probe data.** v0.40.4 ships conservative magnitudes (ADJACENCY_BOOST=1.05, CROSS_SOURCE_BOOST=1.10, SESSION_DEMOTE=0.95) under the floor-gate. The `onScoreDistribution` probe emits min/p25/p50/p75/p95/max + reorder_band_width on every query. After 30 days, read the cumulative distribution from search-stats telemetry, compute the actual reorder bands the boosts have to clear, and tune the three constants against real data. Today's values are vibes-driven (D14=B); the probe instrumentation is the cathedral, the calibration wave is the payoff.

- [ ] **T-todo-3: move fail-open audit events to a DB table for cross-deploy observability.** Codex outside-voice #15 caught the split-brain observability: graph-signals failures land in `~/.gbrain/audit/graph-signals-failures-*.jsonl`, but `gbrain serve --http` deploys can't read the host JSONL. `gbrain search stats` shows error counts on local but not on remote-server brains. Right shape: add a small `event_log` table (or extend an existing one) that the shared `createAuditWriter` writes to alongside the JSONL when an engine is available. Doctor + search-stats read from DB on remote, fall back to JSONL on local. Affects all 6 audit modules (rerank, shell, supervisor, slug-fallback, phantom, graph-signals), so this is a v0.41 audit-infra wave, not a one-off.

- [ ] **T-todo-4: sync-topology-aware cross-source signal.** Codex outside-voice #11 + #15 caught: `cross_source_hits` today counts ANY page in another source as cross-team corroboration, but mirrored imports from another source look identical to genuine cross-team links. Distinguishing them likely needs a `link_source_type` enum extension (e.g. `'mirror'` flag on links created during a `gbrain sources sync`) so the SQL can filter `cross_source_hits` to genuine team-authored edges only.

- [ ] **T-todo-5: replace doctor's 30% global density threshold with actual fire-rate measurement.** `checkGraphSignalsCoverage` in doctor uses % pages with ≥1 inbound link as a proxy for "graph signals fire often enough to matter." Codex outside-voice #14 caught: this is global density, not top-K subgraph density. After 30 days of `gbrain search stats` data accumulates per-query fire rates (T-todo-2 wires this), swap the doctor check to read actual fire-rate-over-window. The 30% threshold becomes "fired in ≥10% of queries in last 7 days" or similar — measured, not inferred.
## v0.39.3.0 smoke-test wave — deferred follow-ups (v0.39.4 / v0.40)

- [ ] **v0.40: SQL-shape rewrite of `listPrefixSampledPages` for PgBouncer transaction-mode compatibility.** WARN-10 root cause from the v0.38.0.0 smoke test: brainstorm + lsd consistently exceed Postgres `statement_timeout` (often PgBouncer-imposed) on the prefix-stratified domain bank query when the brain has >10K pages spread across many prefixes. v0.39.3.0 ships diagnostic surfacing only (the orchestrator wrap classifies SQLSTATE 57014 into a `StructuredAgentError` with a friendly hint). Real fix: per-prefix limit pushdown, embeddings prefetch, or breaking the single big query into a series of small ones across an explicit cursor. Plan: `~/.claude/plans/system-instruction-you-are-working-async-popcorn.md` (Phase 5, WARN-10 row). Owner: open.

- [ ] **v0.40: magic-byte allowlist for `gbrain capture` binary file detection.** v0.39.3.0 (Phase 3c, CV10) ships a first-8KB NUL-byte scan that catches typical binaries (executables, archives, most image formats). Known gap per CV10-B: a PNG with no NUL byte in its first 8KB slips through. Production-grade detection needs a magic-byte allowlist (PNG/JPEG/GIF/PDF/ZIP signatures). Implement in `src/commands/capture.ts:detectBinaryNullByte` (rename to `detectBinaryInput`) with a small `BINARY_MAGIC_BYTES` table. Reuse the same `assertSourceExists`-style friendly error pattern; reject before UTF-8 decode mangles the bytes. Tests in `test/capture-binary-guard.test.ts` should add cases for the PNG-without-NUL boundary.

- [ ] **v0.40: facts:absorb root-cause investigation.** v0.39.3.0 (Phase 4c, CV13) suppresses the per-capture `[facts:absorb] failed to log gateway_error for inbox/...: No database connection` noise AND prints a first-occurrence stack trace so the v0.40 fix knows where to look. The actual fix is one of: (a) thread the connected engine through the facts pipeline so it doesn't open its own handle; (b) no-op the absorb-log when called from a CLI context where the doctor health check isn't the consumer; (c) make the facts subsystem connection-aware and queue retries. The stack trace from `src/core/facts/absorb-log.ts:writeFactsAbsorbLog`'s first-occurrence info-log is the input. **v0.41.25.0 update:** the related #1570 wave shipped a partial fix at the queue level — CLI op-dispatch now awaits `FactsQueue.drainPending({timeout: 1000})` before `engine.disconnect()`, which closes the visible-stderr-line symptom for `gbrain capture`. The deeper "thread engine through pipeline" architectural question (option a above) stays open for v0.40+; the drain fix is a queue-lifetime patch, not a pipeline-rearchitecture.

- [ ] **v0.40: `--source-kind` override flag for `gbrain capture`.** v0.39.3.0 (Phase 3c, CV3) locked source_kind to `'capture-cli'` for capture invocations (the deferred CV3-B alternative). Real use case for the override: Apple Shortcuts / Zapier-style automations that shell out to `gbrain capture` and want their pages labeled `apple-shortcut` or `zapier` in the audit trail. Implementation: add a small flag with an allowlist (similar to migration v81's closed taxonomy: `capture-cli | apple-shortcut | zapier | <skillpack-kind>`); validate at parse time; CV6 remote-spoofing guard still applies (server stamps `mcp:put_page` regardless when `ctx.remote !== false`).

- [ ] **v0.40: route `gbrain capture` through `ingest_capture` Minion handler instead of put_page direct.** v0.39.3.0 (Phase 3a, A1) extended put_page with provenance params as the smallest diff. The cleaner architecture is the ingest_capture Minion handler shape that migration v81's comment already describes ("populated by the ingest_capture Minion handler"). This is a v0.40 architectural shift: capture submits an `ingest_capture` job → handler computes provenance + writes via put_page → result returns to capture. Adds queue latency (Minion job submit + poll) to the sync capture path; needs careful UX consideration (synchronous receipt vs async job_id). The current put_page extension stays back-compat after the migration.

- [ ] **v0.40: provenance-history table for full ingestion event log.** v0.39.3.0's CV12 `COALESCE-preserve UPDATE` keeps the FIRST ingestion source as the audit trail (first-write-wins). For deeper audit cases ("show me every time this page was re-ingested + by which channel"), a separate `pages_provenance_events` table keyed on `(page_id, ingested_at)` would preserve every event. Out of scope for v0.39.x; v0.40+ if/when the audit case grows beyond "first ingestion source."

- [ ] **v0.40+: ingest webhook provenance pass-through.** v0.39.3.0 CV6 closed the spoofing surface by IGNORING client-supplied provenance params for remote callers (ctx.remote !== false). The webhook path stamps server-side `webhook` provenance anyway, so today's behavior is unchanged. When trusted webhook integrations (a service running in the same trust domain as the server) need to declare their own source_kind (`linear`, `notion`, etc.), build a separate trusted-call surface for them — NOT by reopening put_page's wire schema. Possibilities: signed JWT with `provenance_authority: true` claim, or a different Minion job type `ingest_authoritative` that bypasses the CV6 guard.


## v0.39.1+ schema-cathedral follow-ups (filed during v0.39.0.0 ship)

- [ ] **T18 follow-through — DELETE `skills/_brain-filing-rules.{md,json}`.** v0.39.0.0 shipped step (a) of the 4-step deprecation sequence: `gbrain schema show --as-filing-rules` emits the JSON shape the legacy file held. v0.39.1 ships steps (b) + (c) + (d): migrate `filing-audit.ts:79`, `synthesize.ts:619`, `patterns.ts:305`, `check-resolvable.ts:196+:226` to consume `gbrain schema show --as-filing-rules` output; update 5 test files (filing-audit.test.ts, check-resolvable.test.ts, dry-fix.test.ts, resolver.test.ts, cycle-patterns.test.ts); then DELETE the two files. Codex finding #3 from /plan-eng-review made this load-bearing — premature deletion makes protected synthesize/patterns phases fail with NO_ALLOWLIST. Sequencing matters.
- [ ] **T19 follow-through — per-source pack federation across mounts.** v0.39.0.0 ships the correct REJECTION posture (`SchemaPackTrustGateError` when sources resolve to divergent packs). v0.40 ships the true per-source closure via `buildPerSourceBindings` + `buildSourceClosureCte` (engine already provides; the read-path callers need to thread the per-source pack identity through the SQL generation step). Reference: codex finding #2 from /plan-eng-review.
- [ ] **T16 follow-through — hermetic eval-schema-authoring CLI harness.** v0.39.0.0 ships the aggregator (`aggregateVerdict`) + scaffold; v0.39.1 wires the in-process PGLite engine + fixture brain replay (3 fixtures: 1 hand-curated `notion-refugee` + 2 synthetic via faker per D6(eng)). Pattern: mirror `src/eval/longmemeval/harness.ts`.
- [ ] **T1.5 follow-through — wire `whoknows` / `find_experts` / `enrichment-service` / `facts/eligibility` to consume pack-aware type sets.** v0.39.0.0 added the seam (`activePack` parameter threaded through parseMarkdown/import/sync). The runtime sites that compute their type filter still use the v0.38 hardcoded constants. v0.39.1 migrates each call site to read from `loadActivePackForOp(ctx)` + use `expertTypesFromPack` / `extractableTypesFromPack` (helpers already exist in `src/core/schema-pack/`). Per the T19 closure fix, this is now safe to wire (federated_read with divergent packs throws permission_denied at the load step).
- [ ] **D14 thesis retro — authoring vs derivation framing.** v0.39.0.0 ships the cathedral with 6 verbs marked experimental-tier + T15 schema-events audit + T23 `gbrain schema usage` for measurement. v0.40+ retro reads 60-90 days of usage telemetry and decides which experimental verbs to deprecate per codex's derivation-thesis structural argument. Pass condition: each verb gets >=5% of the cathedral's invocations. Below 5% = deprecation candidate.


## v0.37.x brainstorm cost-cathedral follow-ups (filed during T12)

- [ ] **Explicit `--max-cost` flag on `gbrain extract`, `gbrain enrich`, `gbrain integrity auto`.** v0.37.x ships gateway-layer enforcement via `withBudgetTracker` — wrapping any of those commands at their entrypoint with `withBudgetTracker(tracker, fn)` immediately gives them the same cap semantics that brainstorm + doctor --remediate have. The CLI flag wiring (parse `--max-cost`, construct `BudgetTracker` with `maxCostUsd`, wrap the entrypoint) is the only missing piece. ~30 lines each plus smoke tests. Deferred per the plan's "NOT in scope" — gateway-layer composition was the structural goal; the per-command flag wiring is the next ergonomic win.

- [ ] **`P5` config-schema `budgets:` block in `~/.gbrain/config.json`.** The lsd cost-explosion incident's P5 proposed declarative per-command budgets in config. v0.37.x ships the imperative `--max-cost N` surface, which covers the canonical case. Config-driven defaults (so users don't have to remember to pass `--max-cost` every time) are a v0.38+ ergonomic win. Shape:
  ```yaml
  budgets:
    default:
      max_cost_usd: 5.00
      max_runtime_seconds: 300
    brainstorm: { max_cost_usd: 2.00 }
    lsd: { max_cost_usd: 5.00 }
    dream: { max_cost_usd: 10.00 }
  ```
  Resolution: CLI flag > config block > built-in default.

- [ ] **Multi-day brainstorm resume (>7d).** A5's 7-day mtime window covers >99% of crash-and-resume cases (an operator forgets for a week is rare). `--force-resume` is the escape hatch. The full multi-day story (longer retention, possibly a daily GC instead of cycle-purge-only, dashboard for in-flight runs) is a v0.38+ concern.

- [ ] **Async-batched audit writes.** Sync `appendFileSync` is fine at typical volumes (~5ms × 100 crosses = ~500ms — not noticeable inside a $1 brainstorm run). Profiling trigger criterion: when 100+ crosses on a large brain shows audit-write time dominating wall-clock cost, switch to an async write queue. Fixing prematurely costs complexity for no measurable benefit.

- [ ] **`BudgetLedger` unification with `BudgetTracker`.** `src/core/enrichment/budget.ts` defines a separate `BudgetLedger` primitive for per-day, per-scope/resolverId enrichment caps. Different shape from `BudgetTracker` (daily reset windows + multi-tier scope keys). Unification is possible but requires careful schema design to preserve enrichment's existing report semantics. Deferred because: (a) BudgetTracker covers the per-command case cleanly today, (b) the existing BudgetLedger isn't a customer-facing surface — it backs `gbrain enrich`'s internal accounting, (c) merging them would require a schema migration on the enrichment budget audit JSONL. Revisit when the enrichment surface gets its next major touch.

- [ ] **judges.ts internal chunking → payload-fitter delegation.** v0.37.x ships `src/core/diarize/payload-fitter.ts` with the batch strategy ready to consume from `src/core/brainstorm/judges.ts`'s `runJudge` chunking path. Today judges.ts keeps its own copy of the chunking loop (~30 lines) — straightforward refactor: replace the inline split with `fit({strategy:'batch', items: ideas, maxTokensPerCall, estimateTokens})` and concatenate results. The cost-guardrails test suite already pins the public contract; the refactor is mechanical. Touch one function; trivial.

## v0.37 PGLite fresh-install fix wave — deferred follow-ups (v0.37.x+ / v0.38.x)

- [ ] **`gbrain embed --try-fallback` for provider quota/auth failures.** The v0.37 wave deliberately rejected auto-fallback because silently switching providers writes mixed-space vectors into one `content_chunks.embedding` column, corrupting retrieval. The right design: explicit `--try-fallback` flag that (a) detects the primary failure type (429 / 401 / 5xx), (b) confirms the fallback provider's `embedding_dimensions` matches the schema, (c) prompts the user via TTY before switching mid-corpus, (d) writes a marker chunk attribute so doctor can flag mixed-provider corpora later. Doctor currently surfaces "Detected 1 alternative embedding provider ready to use" but the embed command never acts. Owner: open. Sources: user bug report item #5; v0.37 wave plan deferred list.

- [ ] **Full plane unification for non-schema-sizing fields.** v0.37 (Lane C.2) refuses `gbrain config set` for `embedding_model` / `embedding_dimensions` because those size the schema and must stay file-plane only. But `chat_model`, `expansion_model`, `reranker_model`, `chat_fallback_chain`, `provider_base_urls` don't size the schema — they could be live-mutable via the DB plane through `loadConfigWithEngine()`. Audit each: which are read by the gateway at boot only vs at every call? Live-mutable ones should accept `gbrain config set` without the v0.37 rejection. Filed during v0.37 codex round 2 (CDX-7 audit produced this as a follow-up).

- [ ] **Per-page worker-pool abort in `embedAll()` for mid-run dim drift.** v0.37 Lane D.2 added a pre-flight dim-mismatch check at the top of `runEmbedCore` (catches the headline fresh-install class). The plan's stricter D.2 (CDX2-9) called for a shared `AbortController` in `embedAll()` so a mid-run mismatch on one worker propagates to the rest of the pool. The pre-flight catches >99% of cases (mismatches surface at the column-level, not per-row, so all workers would hit the same error). Deferred as defense-in-depth: implement when a real mid-run dim-drift case is reported. File `src/commands/embed.ts:335` (worker pool entry point).

- [ ] **Hardcoded `text-embedding-3-large` defaults remaining in `src/core/embedding.ts`.** Two legacy back-compat constants (`EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`) and a fallback in `getEmbeddingModelName()`. Dead-ish at this point — only some tests import them. v0.38 cleanup: remove the back-compat exports, port the few test consumers to gateway accessors, delete the strip-provider-prefix helper. Mechanical; deferred from v0.37 to keep the wave scoped.

## v0.37.8.0 pre-existing master test regression (noticed during ship)

- [x] **P0: `test/doctor-report-remote.test.ts:65` — `full report on healthy brain` fails with `health_score: 50` (expects `>=70`).** **Completed:** v0.37.10.0 (2026-05-21). Resolved structurally by the empty-brain-100/100 fix in `src/core/pglite-engine.ts` + `src/core/postgres-engine.ts` (commit 9aa571f3): pages-empty brains now get vacuous-truth full marks on every breakdown component (35/25/15/15/10), so the freshly-initialized test brain's composite stays >=70 even when `skill_brain_first` returns non-ok. Test file renamed to `test/doctor-report-remote.serial.test.ts` and made hermetic (isolates `GBRAIN_HOME` to a tempdir via beforeAll/afterAll per `scripts/check-test-isolation.sh` R1 — env mutation requires serial quarantine).

## v0.37.7.0 federated-brains + autopilot safety follow-ups (v0.37.x+)

- [ ] **.sql file indexing (#1173) — dropped from v0.37.7.0 because tree-sitter-sql.wasm is not in `src/assets/wasm/grammars/`.** The grammars directory ships 35 languages but SQL is not among them. Plan deliberately verify-first-gated this (codex CF11). Re-file as a dedicated wave that: (a) ships tree-sitter-sql.wasm (vendor from upstream), (b) extends the sync walker's `.md|.markdown|.txt` extension filter to include `.sql`, (c) routes `.sql` through `importCodeFile()` with `page_kind='code'`, (d) addresses the slug-shape collision codex flagged with #1172's punted "flatten extensions" work — `slugifyCodePath('docs/auth.sql')` produces a slug shape that may collide with `docs/auth.md` if #1172 ever ships. Verify-first the slug round-trip before merging.

- [ ] **#1204 deeper investigation — `gbrain extract all` reports 0 links on federated brains with cross-source duplicate slugs.** v0.37.7.0 added `--source-id <id>` to scope extraction explicitly, which gives users a workaround. But the underlying "silent 0 links" bug on unscoped federated extracts has additional facets: the resolver path in `extractLinksFromDB` builds `slugToSources` from `listAllPageRefs`, then iterates `allRefs` and resolves wikilinks. For a slug that exists in 2+ sources, the resolver may pick the wrong target. Run `/investigate` against a fixture with 2 sources × overlapping slugs × cross-source wikilinks, characterize the failure mode, file a precise fix.

- [ ] **Tier 5N doctor check — `subagent_terminal_dead_letters`.** v0.37.7.0 shipped T9 (the subagent dead-letter fix) but deferred the doctor sweep that surfaces historical dead-lettered jobs whose final message is a text-only assistant turn (the #1151 fingerprint). The fix prevents new occurrences; the doctor check would help users discover existing dead-letters from before the upgrade so they can `gbrain jobs prune --status dead --queue default` cleanly. Add the check in v0.37.8+ once a clean conflict-resolved doctor.ts is available.

## v0.37.6.0 OpenRouter recipe follow-ups (v0.37.x+ / v0.38.x)

- [ ] **v0.37.x: Verify `tool_use_id` stability through OpenRouter with a live test, then decide whether to relax `isAnthropicProvider()`'s subagent-only gate.** v0.37.6.0 ships `supports_subagent_loop: false` on the OR recipe as informational only — the real gate is `isAnthropicProvider()` in `src/core/model-config.ts`, which hard-rejects every non-Anthropic provider at subagent submit time. OR proxies Anthropic-direct models that DO support stable `tool_use_id` by contract, but OR's response normalization may strip or re-encode them. A short live test: spin up a real OR account, run a subagent loop via `openrouter:anthropic/claude-haiku-4.5`, deliberately abort mid-loop, retry. Assert tool_use_id blocks are byte-identical across attempts. If they are, the `isAnthropicProvider()` check could relax to allow Anthropic models proxied through OR, giving users OR's price/availability story for subagent work. This is a deeper structural change than a recipe-flag flip; needs its own /plan-eng-review pass. Filed during v0.37.6.0 codex review.

- [ ] **v0.37.x: Quarterly OR catalog refresh.** v0.37.6.0 ships 8 curated chat slugs (gpt-5.2, gpt-5.2-chat, gpt-5.5, claude-haiku-4.5, claude-sonnet-4.6, claude-opus-4.7, gemini-3-flash-preview, deepseek-chat) with `price_last_verified: '2026-05-20'`. OR's catalog churns weekly; specific slugs get deprecated, renamed, or merged. Refresh cadence: every 90 days, walk https://openrouter.ai/models, prune deprecated slugs, add new frontier IDs that match the recipe's curation logic (frontier-tier + cheap-routing entry points). Bump `price_last_verified`. The shape-test regression in `test/ai/recipe-openrouter.test.ts` (`MODEL_SHAPE` regex) means typos surface immediately; the catalog refresh is about discovery, not validation.

- [ ] **v0.37.x: Adopt `resolveDefaultHeaders` for Together / Groq / other attribution-bearing recipes.** v0.37.6.0's `default_headers` / `resolveDefaultHeaders` seam is generic — any recipe whose provider benefits from app-attribution headers can opt in. Together and Groq both have rankings/analytics tied to per-app headers. Add their respective attribution headers to each recipe, similar to OR's `HTTP-Referer` + `X-OpenRouter-Title`. No type-system or gateway changes needed; just `default_headers` blocks on the existing recipes plus `<PROVIDER>_REFERER` / `<PROVIDER>_TITLE` env vars in their `auth_env.optional`. Filed during v0.37.6.0 eng review as a D4 generalization opportunity.

- [ ] **v0.37.x: Guard cli.ts `main()` so importing `buildGatewayConfig` doesn't print help.** v0.37.6.0 exported `buildGatewayConfig` from `src/cli.ts` for test access. Importing it triggers the file's top-level `main()` which prints help to stdout during tests — functionally harmless (tests pass) but noisy. Fix: wrap `main()` in `if (import.meta.main)` so it only runs when cli.ts is the entry point, not when imported. Touches one line; trivial. Filed during v0.37.6.0 implementation.


## v0.37.4.0 pgGraph CI scaffolding follow-ups (v0.37.x+)

- [ ] **T8 truncation signal — defer until dedupe-then-cap SQL + Postgres parity E2E.** v0.37.4.0 ships `frontierCap` as the actually-useful protection but strips the `onTruncation` callback after /review adversarial pass (Claude + Codex both flagged). Two bugs in the v1 algorithm: (a) FALSE POSITIVE — `count == cap` at a depth fires the callback even when the graph organically has exactly cap unique nodes at that depth with no truncation; (b) FALSE NEGATIVE — recursive `LIMIT N` runs BEFORE outer `SELECT DISTINCT`, so diamond graphs (one parent fans out to N+5 candidates with duplicates) can have the LIMIT eat its slots on dupes, then DISTINCT collapses to <cap unique nodes, missing real truncation. Fix shape: rewrite both engine impls to dedupe candidates (by `(slug, id)` or page id, source-scoped) BEFORE applying the LIMIT — i.e., `(SELECT DISTINCT ON ... ORDER BY slug, id LIMIT N)` inside the recursive term instead of post-CTE DISTINCT. Then write the missing `test/e2e/engine-parity-frontier-cap.test.ts` (Postgres against PGLite, identical chosen slugs when cap fires + stable ordering). Restore `TruncationInfo` + `opts.onTruncation` to `TraverseGraphOpts` with the cap-after-dedupe shape. Callers that need truncation visibility in the interim can compare `result.length` against expected fanout bounds. /review found it; not a blocker for v0.37.4.0 because the cap itself works correctly and is back-compat (default unset = no behavior change).

- [ ] **pg_upgrade_matrix.sh: add layer-isolation mode.** The current script tests whole-system walk-forward (the bug class CHANGELOG advertises). Adversarial /review caught that multi-layer healing (bootstrap → SCHEMA_SQL → migrations → verifySchema) means stubbing out `applyForwardReferenceBootstrap` entirely still produces clean walk-forwards on both fixtures. So the matrix doesn't actually gate on bootstrap correctness — only on whole-system wedges. Add an `ISOLATE_BOOTSTRAP=1` mode that monkey-patches the downstream layers (or runs a smaller engine surface that only invokes bootstrap) so single-probe regressions can be isolated. Complements the existing `test/schema-bootstrap-coverage.test.ts` static guard.

- [ ] **scripts/check-fuzz-purity.sh: derive TARGET_FILES from `test/fuzz/pure-validators.test.ts` imports.** Today the targets are hand-maintained in two places (`TARGET_FILES` array + the test file's imports). Adding a new pure fuzz target requires updating both; forgetting the script means the new target ships ungated. Parse the test file's imports at script start (regex over `import { ... } from '../../src/.../*.ts'`) instead.
## skill_brain_first wave follow-ups (v0.36.4+)

- [ ] **v0.37+: Runtime brain-first gate at MCP dispatch.** The v0.36.x
  `skill_brain_first` doctor check is purely static — it scans SKILL.md
  authorship for canonical Convention callouts, `brain_first: exempt`
  frontmatter, or position-relative brain references. The motivating
  incident (2026-05-19 tweet-shield) was a RUNTIME failure: an agent
  called Perplexity / cross-modal eval to assess Garry's Palantir tweet
  without ever checking the brain, which already had "designed the
  entire Finance product UI" and "150+ PSDs from April-December 2006."
  A runtime gate would hook MCP tool dispatch: when a subagent invokes
  `web_search` / `perplexity` / `exa` / etc., require that a `search`,
  `query`, or `get_page` call landed earlier in the same agent turn.
  Subagent-isolation aware (the gate scope is per-turn, per-agent).
  Touches: `src/mcp/dispatch.ts` (tool-call entry seam, would gate before
  routing to external-tool handlers), `src/core/minions/handlers/subagent.ts`
  (per-turn tracking), `src/core/operations.ts` (cross-reference the
  brain-tool ops). Full wave on its own (~3-5 days human / ~1-2h CC).
  Out of scope for the static-check wave because the surface area is
  fundamentally different. Closes the tweet-shield root cause at the
  enforcement layer instead of just the authorship layer.

- [ ] **v0.36.x: Audit trend doctor check `skill_brain_first_trend`.** The
  v0.36.x snapshot+diff audit JSONL at
  `~/.gbrain/audit/skill-brain-first-YYYY-Www.jsonl` records detected /
  resolved / fixed events as transitions. The data is reachable via
  `readRecentBrainFirstEvents(7)` in `src/core/audit-skill-brain-first.ts`
  but no doctor surface consumes it yet. Add a `skill_brain_first_trend`
  check (~30 LOC) that reads recent events, aggregates added vs resolved
  counts per week, warns when violations are rising (e.g. >3 added, 0
  resolved over 4 weeks). Cheap to land once audit logs accumulate
  multiple weeks of data (no point shipping it with zero baseline data).
  Mirrors the doctor check pattern in `src/commands/doctor.ts`. Filed
  during /plan-eng-review as TODO-2.

- [ ] **v0.36.x: Tighten the external-lookup regex to reduce false-positive
  rate from name mentions.** v0.36.x ships with word-boundary regex on
  `perplexity`, `exa`, `web_search`, etc. This matches "perplexity"
  inside `perplexity-research` (a sub-skill name in dispatcher prose, not
  an API call). Two skills in this repo's own `skills/` (functional-area-
  resolver, strategic-reading) hit this false-positive and ship with
  `brain_first: exempt`. Possible mitigation: tighten the pattern to
  require an API-call shape like `perplexity\.|perplexity[\s._-]?(?:api|search|query)`.
  Whack-a-mole risk — the negation-prose false-positive class can't be
  reliably caught with regex either. Tracking as a follow-up; the
  declarative `brain_first: exempt` opt-out is the canonical answer for
  the false-positive cases. Decide based on real-world hit rate after
  the v0.36.x wave is in production for a few weeks.


## v0.35.6.0 floor-ratio gate follow-ups (v0.36.x+)

- [ ] **v0.36.x: Run gbrain-side floor-ratio ablation before flipping any mode-bundle default.** v0.35.6.0 ships the gate default-off (`MODE_BUNDLES[*].floor_ratio = undefined`) because the SkyTwin labeled-retrieval ablation that surfaced the regression isn't reproducible on gbrain's own eval surfaces from outside. Before any mode-bundle default flip, run the gate at `floor_ratio: undefined`, 0.85, 0.90, 0.95 across `gbrain eval longmemeval`, `gbrain eval whoknows`, `gbrain eval suspected-contradictions`, and the BrainBench-Real replay (sibling gbrain-evals repo). Quantify per-mode P@k / R@k / nDCG@k / top-1 stability deltas. Look for: regression on queries that genuinely need the long-tail boost (specific entity lookups, low-frequency topics) vs improvement on queries where weak-overlap pages were leapfrogging. The corpus-level finding determines whether tokenmax (most exposure to the failure mode) should flip first, or whether the gate stays a per-call opt-in indefinitely. Filed during v0.35.6.0 codex outside-voice review.

- [ ] **v0.36.x: `MODE_BUNDLES.floor_ratio` integration shape — populate after ablation evidence.** v0.35.6.0 leaves `floor_ratio: undefined` in all three bundles deliberately. After the ablation TODO above, set per-mode defaults: probably `tokenmax: 0.85` first (high-context tier, broad searchLimit=50, expansion=on — most exposure to leapfrog), `balanced` second if signal holds, `conservative` only if the ablation shows the gate doesn't hurt on small candidate pools. Update the canonical-bundle tests in `test/search-mode.test.ts` (3 fixtures) when flipping. The KNOBS_HASH_VERSION does NOT need to bump for a default change — the per-bundle default is part of the hash input already.

- [ ] **v0.36.x: Per-source floor-ratio (federated read).** v0.35.6.0 uses a single global threshold across all sources. Federated-read users (v0.34.1.0+) sharing a query across multiple sources get one floor across the merged result set, which means a high-scoring source can suppress metadata boosts for pages in another source. Codex outside-voice flagged this during v0.35.6.0 review; user explicitly chose the simpler primitive (D9=A). If a federated-read user later reports legitimate per-source winners being suppressed, the fix is a per-source threshold map computed at `runPostFusionStages` entry (one threshold per unique `source_id` in the result set). Plan reference: D9 in `~/.claude/plans/swift-sniffing-nygaard.md`.

- [ ] **v0.36.x: Reranker top-N expansion when floor-ratio narrows the candidate pool.** Floor-ratio can suppress a legitimate candidate that would have made it to the reranker's top-N. Sanity check after the v0.36 ablation: if tokenmax with `floor_ratio: 0.85` and `reranker_top_n_in: 30` shows the reranker seeing a meaningfully different set than without the gate, consider expanding `reranker_top_n_in` when floor is set (e.g. 30 → 40) so the reranker still has 30 floor-eligible candidates to reorder. Cheap mitigation if the data supports it. Not a blocker.


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

- [x] ~~**v0.32.x: interactive provider chooser in `gbrain init`.**~~
  **SUPERSEDED by v0.37 — closed by the env-detection + hybrid picker wave.**
  `src/commands/init-provider-picker.ts` mirrors this design: filters to
  env-ready recipes, prompts via readline through `readLineSafe`, surfaces
  the subagent-Anthropic caveat on non-Anthropic chat picks. Env detection
  in `resolveAIOptions` auto-picks when env is unambiguous (one provider's
  keys set), fires the picker when multiple providers are ready, and exits 1
  with a paste-ready setup hint in non-TTY zero-key contexts (D3). See
  `~/.claude/plans/system-instruction-you-are-working-enumerated-mccarthy.md`
  for the full decision trail.

## Embedding-provider follow-ups (v0.37+)

- [ ] **v0.37+: dedicated migration script for v0.36 broken installs.** v0.37
  ships D5 + step 11 of the env-detection wave, which surfaces v0.36 silent-
  default brains in `gbrain doctor` with a paste-ready repair command. What's
  not yet built: a one-shot orchestrator under `src/commands/migrations/v0_37_x.ts`
  that detects the broken state (vector(1536) schema + empty
  `config.embedding_model` + 0 embedded chunks) on `gbrain upgrade` and runs
  the repair automatically. Same shape as `src/commands/migrations/v0_12_2.ts`.
  Telemetry-gated: only worth writing if issues show widespread breakage.

- [ ] **v0.37+: namespaced extension fields for `gbrain config set`.** v0.37
  D6 ships strict unknown-key rejection with a `--force` escape hatch +
  Levenshtein "did you mean" suggestion. Codex finding #8 from the eng review
  argued for a `gbrain.ext.<key>` namespace pattern instead of `--force`
  accepting arbitrary top-level keys; deferred for follow-up. Revisit if
  `--force` shows misuse in practice (e.g. tooling writing dozens of unknown
  keys, polluting `gbrain config show`).

- [ ] **v0.37+: runtime config-key inventory audit.** Codex finding #12 from
  the eng review: the `KNOWN_CONFIG_KEYS` allow-list in `src/core/config.ts`
  is hand-maintained. A future runtime audit could walk every `cfg.X` access
  site at startup and cross-check against the allow-list, catching drift
  when new code paths read a key the maintainer forgot to declare. Pre-merge
  manual grep (`grep -rE "config\.\w+" src/`) is sufficient today.

- [ ] **v0.38+: env-key typo detection at `gbrain config set` time too.**
  v0.37 D13 ships Levenshtein typo detection at init for env vars
  (`OPENAPI_API_KEY` → `OPENAI_API_KEY`). The same logic isn't applied at
  `gbrain config set` for value-level provider strings (e.g.
  `gbrain config set embedding_model openai:text-embedign-3-large` —
  notice the typo'd model name). Cheap to add: parse the value as
  `provider:model`, suggest the nearest from the recipe's `models[]` list.

- [ ] **v0.38+: extend init env-detection to multimodal explicitly via picker.**
  v0.37 T11 hooks `resolveSchemaMultimodalDim` preflight into
  `gbrain reindex --multimodal`. The picker doesn't yet have a 'multimodal'
  touchpoint mode — multimodal model selection happens via
  `gbrain config set embedding_multimodal_model` or env detection of
  multimodal-capable providers. Future polish: extend the picker with a
  fourth touchpoint case so first-time users discover the option at init.

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
- Likely fix: replace `echo "$output"` with `printf '%s
' "$output"`, or write `$output` to a tmpfile and `cat` it (handles large blobs better than echo over pipes), or pipe through `stdbuf -o0`.
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

**Context:** Codex F3 demonstrated that `READ_ONLY_PREFIX = /^(\s|--.*
)*(SELECT|WITH)/i` is unsound — `WITH x AS (UPDATE … RETURNING …) SELECT …` matches the prefix but updates a row; `SELECT pg_advisory_xact_lock(...)` is a SELECT with side effects. The plan-eng-review wrap-up in `~/.claude/plans/system-instruction-you-are-working-tender-horizon.md` has the full discussion.

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
